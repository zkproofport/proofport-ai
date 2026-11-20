/**
 * Does the compiled coinbase_attestation (v2) circuit accept what a client and
 * this server build for a real attested wallet? No Docker, no server, no
 * payment: the steps of a real request, called directly.
 *
 *   npx tsx scripts/check-coinbase-inputs.ts <coinbase_attestation_v2.json> \
 *     [--prove <bb>] [--save <dir>]
 *
 * 1. the attested wallet (ATTESTATION_KEY in .env.test) signs signal_hash and
 *    the customer SDK's prepareInputs builds the request (EAS lookup on Base);
 * 2. prepareServerStatement confirms the attestation on chain and signs the
 *    225-byte client_data with the Cloud KMS key, as src/proof/proofRoutes.ts
 *    does before payment;
 * 3. the inputs are assembled as the route assembles them, formatted by
 *    src/prover/inputFormatter.ts and executed with noir_js;
 * 4. one tampered copy (the server signature) must be refused, so a circuit
 *    that accepts everything does not pass.
 *
 * --prove runs `<bb> prove` / `<bb> verify` with `-k <circuit dir>/vk/vk -t
 * evm` on the solved witness, exactly as src/prover/bbProver.ts does; --save
 * keeps witness.gz, proof and public_inputs in <dir> (witness.gz is what
 * scripts/check-image-prover.sh takes through WITNESS_DIR, the proof what the
 * circuits repo's scripts/verify-onchain.sh takes).
 *
 * Needs COINBASE_STATEMENT_KMS_KEY and credentials allowed to sign with it
 * (GOOGLE_APPLICATION_CREDENTIALS or gcloud application-default), like
 * scripts/check-oidc-inputs.ts; BASE_RPC_URL and EAS_GRAPHQL_ENDPOINT come
 * from the environment or .env.development. Read-only on chain.
 */
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, copyFileSync, rmSync, statSync } from 'fs';
import { execFileSync } from 'child_process';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { Noir } from '@noir-lang/noir_js';
import { ethers } from 'ethers';
import { prepareInputs } from '../packages/sdk/src/inputs.js';
import { computeSignalHash, newRequestId } from '../packages/sdk/src/signalHash.js';
import { evaluateOprf, isOprfEnvironment, type PreparedOprf } from '../packages/sdk/src/oprf/index.js';
import { prepareServerStatement, easAttestationReader, statementSignerFromEnv } from '../src/input/coinbaseStatement.js';
import { hexToBytes, type CircuitParams } from '../src/input/inputBuilder.js';
import { formatAttestationInputs } from '../src/prover/inputFormatter.js';
import { OPRF_INPUT_KEYS, type OprfCircuitInputs } from '../src/input/oprfInputs.js';
import { CIRCUIT_IDS } from '../src/config/circuitIds.js';

const circuitPath = process.argv[2];
if (!circuitPath) {
  throw new Error('Usage: npx tsx scripts/check-coinbase-inputs.ts <coinbase_attestation_v2.json> [--prove <bb>] [--save <dir>]');
}
const flags = process.argv.slice(3);
const KNOWN = ['--prove', '--save'];
for (let i = 0; i < flags.length; i += 2) {
  if (!KNOWN.includes(flags[i])) throw new Error(`Unknown option ${flags[i]}. Known: ${KNOWN.join(', ')}`);
  if (!flags[i + 1] || flags[i + 1].startsWith('--')) throw new Error(`${flags[i]} needs a value`);
}
const flagValue = (name: string) => { const at = flags.indexOf(name); return at === -1 ? undefined : flags[at + 1]; };
const proveBb = flagValue('--prove');
const saveDir = flagValue('--save');

function readEnvFile(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq > 0) out[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }
  return out;
}
const root = resolve(dirname(new URL(import.meta.url).pathname), '..');
const testEnv = readEnvFile(join(root, '.env.test'));
const devEnv = readEnvFile(join(root, '.env.development'));
const setting = (name: string): string => {
  const value = process.env[name] || devEnv[name];
  if (!value) throw new Error(`${name} is required (environment or .env.development)`);
  return value;
};
const attestationKey = testEnv.ATTESTATION_KEY;
if (!attestationKey) throw new Error('ATTESTATION_KEY is required in .env.test: a wallet with a Coinbase KYC attestation on Base');

const circuit = JSON.parse(readFileSync(circuitPath, 'utf8'));
const abiNames: string[] = circuit.abi?.parameters?.map((p: { name: string }) => p.name) ?? [];
if (!abiNames.includes('client_data')) {
  throw new Error(`${circuitPath} has no client_data parameter; this checks the v2 circuit (coinbase-attestation-v2).`);
}

const circuitId = CIRCUIT_IDS.COINBASE_ATTESTATION;
const wallet = new ethers.Wallet(attestationKey);
const scope = 'check:coinbase-inputs';
// keccak256(scope ++ circuitId ++ requestId), no wallet; a fresh request id per run.
const requestId = newRequestId();
const signature = await wallet.signMessage(computeSignalHash({ scope, circuitId, requestId }));
// The OPRF nullifier from the network of OPRF_ENVIRONMENT (staging/local:
// the public test network; production has none and is refused by name).
const oprfEnvironment = setting('OPRF_ENVIRONMENT');
if (!isOprfEnvironment(oprfEnvironment)) throw new Error(`OPRF_ENVIRONMENT '${oprfEnvironment}' is not one of production, staging, local`);
const oprfDomain = 'check-coinbase-inputs.zkproofport.app';
const prepared: PreparedOprf = {
  environment: oprfEnvironment, circuitId, address: wallet.address, oprfDomain, scope,
  inputs: await evaluateOprf({ environment: oprfEnvironment, circuitId, address: wallet.address, domainName: oprfDomain, scopeName: scope }),
};
const cb = await prepareInputs({ baseUrl: 'http://unused.invalid' }, {
  circuitId, userAddress: wallet.address, userSignature: signature, scope, requestId, oprf: prepared,
});
// The eleven OPRF values the SDK put on the wire (src/input/oprfInputs.ts names them).
const oprf = Object.fromEntries(
  OPRF_INPUT_KEYS.map(k => [k, (cb as unknown as Record<string, string>)[k]]),
) as unknown as OprfCircuitInputs;
const statement = await prepareServerStatement(
  {
    circuitId,
    userAddress: cb.user_address,
    signalHash: ethers.getBytes(cb.signal_hash),
    scopeField: oprf.scope,
  },
  { reader: easAttestationReader(setting('EAS_GRAPHQL_ENDPOINT'), setting('BASE_RPC_URL')), signer: statementSignerFromEnv() },
);
const params: CircuitParams = {
  signalHash: ethers.getBytes(cb.signal_hash),
  merkleRoot: cb.merkle_root,
  oprf,
  userAddress: cb.user_address,
  userSignature: cb.signature,
  userPubkeyX: cb.user_pubkey_x,
  userPubkeyY: cb.user_pubkey_y,
  rawTxBytes: Array.from(hexToBytes(cb.raw_transaction)),
  txLength: cb.tx_length,
  attesterPubkeyX: cb.coinbase_attester_pubkey_x,
  attesterPubkeyY: cb.coinbase_attester_pubkey_y,
  merkleProof: cb.merkle_proof,
  merkleLeafIndex: cb.leaf_index,
  merkleDepth: cb.depth,
  statement: { clientData: statement.clientData, signature: statement.signature, attestedAt: statement.attestedAt },
};

const noir = new Noir(circuit);
let failures = 0;

const honest = formatAttestationInputs(circuitId, params);
let witness: Uint8Array | undefined;
try {
  witness = (await noir.execute(honest as never)).witness;
  console.log(`ok   ${wallet.address}, attestation ${statement.attestationUid}: witness solved`);
} catch (error) {
  failures++;
  console.log(`FAIL ${wallet.address}: witness refused (${error instanceof Error ? error.message : error})`);
}

const tamperedSig = Uint8Array.from(statement.signature);
tamperedSig[63] ^= 1;
try {
  await noir.execute(formatAttestationInputs(circuitId, { ...params, statement: { ...params.statement!, signature: tamperedSig } }) as never);
  failures++;
  console.log('FAIL tampered server signature: witness solved');
} catch (error) {
  console.log(`ok   tampered server signature: witness refused (${error instanceof Error ? error.message : error})`);
}

if (witness && proveBb) {
  const vkPath = join(dirname(circuitPath), 'vk', 'vk');
  const work = mkdtempSync(join(tmpdir(), 'check-coinbase-prove-'));
  try {
    const witnessPath = join(work, 'witness.gz');
    writeFileSync(witnessPath, witness);
    const out = join(work, 'proof');
    execFileSync(proveBb, ['prove', '-b', circuitPath, '-w', witnessPath, '-k', vkPath, '-o', out, '-t', 'evm'], { stdio: 'pipe' });
    execFileSync(proveBb, ['verify', '-p', join(out, 'proof'), '-i', join(out, 'public_inputs'), '-k', vkPath, '-t', 'evm'], { stdio: 'pipe' });
    console.log(`ok   proved and verified with ${proveBb}: ${statSync(join(out, 'proof')).size} B proof`);
    if (saveDir) {
      mkdirSync(saveDir, { recursive: true });
      for (const f of ['proof', 'public_inputs']) copyFileSync(join(out, f), join(saveDir, f));
      copyFileSync(witnessPath, join(saveDir, 'witness.gz'));
      console.log(`     saved witness.gz, proof, public_inputs in ${saveDir}`);
    }
  } catch (error) {
    failures++;
    const e = error as { stderr?: Buffer; message?: string };
    console.log(`FAIL bb: ${e.stderr?.toString() || e.message}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
} else if (witness && saveDir) {
  mkdirSync(saveDir, { recursive: true });
  writeFileSync(join(saveDir, 'witness.gz'), witness);
  console.log(`     saved witness.gz in ${saveDir}`);
}

console.log(failures === 0 ? `all as expected against ${circuitPath}` : `${failures} unexpected result(s) against ${circuitPath}`);
process.exit(failures === 0 ? 0 : 1);
