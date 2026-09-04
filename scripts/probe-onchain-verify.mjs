/**
 * Ask a deployed proofport-ai why its on-chain verification says false.
 *
 * The E2E suite asserts `verifyResult.valid === true` and throws away the
 * reason, so a failure reads only as "expected false to be true". This script
 * reproduces the same call and prints everything the assertion discards: the
 * verification block the server sent back, the SDK's own error string, and the
 * raw result of calling the verifier contract directly.
 *
 * It is a probe. It generates one real proof and makes read-only chain calls;
 * it writes nothing and deploys nothing.
 *
 * Usage:
 *   node scripts/probe-onchain-verify.mjs [baseUrl] [circuit]
 *
 *   baseUrl  defaults to $E2E_BASE_URL, then http://localhost:4002
 *   circuit  defaults to coinbase_kyc
 *
 * Credentials come from .env.test (ATTESTATION_KEY, E2E_PAYER_WALLET_KEY), the
 * same file the E2E suite reads.
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ethers } from 'ethers';
import { createConfig, generateProof, fromPrivateKey, verifyProof } from '@zkproofport-ai/sdk';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

for (const line of readFileSync(resolve(root, '.env.test'), 'utf-8').split('\n')) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) continue;
  const eq = trimmed.indexOf('=');
  if (eq === -1) continue;
  const key = trimmed.slice(0, eq).trim();
  if (!(key in process.env)) process.env[key] = trimmed.slice(eq + 1).trim();
}

const baseUrl = process.argv[2] || process.env.E2E_BASE_URL || 'http://localhost:4002';
const circuit = process.argv[3] || 'coinbase_kyc';

const attestationKey = process.env.ATTESTATION_KEY;
const payerKey = process.env.E2E_PAYER_WALLET_KEY;
if (!attestationKey) throw new Error('ATTESTATION_KEY is required in .env.test');
if (!payerKey) throw new Error('E2E_PAYER_WALLET_KEY is required in .env.test');

console.log(`service   ${baseUrl}`);
console.log(`circuit   ${circuit}`);

const result = await generateProof(
  createConfig({ baseUrl }),
  { attestation: fromPrivateKey(attestationKey), payment: fromPrivateKey(payerKey) },
  { circuit, scope: 'probe:onchain-verify' },
);

console.log('\n── what the server sent back ──');
console.log(`  circuit            ${result.circuit}`);
console.log(`  proofType          ${result.proofType}`);
console.log(`  proof length       ${result.proof?.length ?? 0} hex chars`);
console.log(`  publicInputs       ${result.publicInputs?.length ?? 0} hex chars`);
console.log(`  verification       ${JSON.stringify(result.verification)}`);

if (!result.verification) {
  console.log('\nThe server returned no verification block, so there is nothing to call.');
  process.exit(1);
}

console.log('\n── what the SDK says ──');
const verdict = await verifyProof(result);
console.log(`  ${JSON.stringify(verdict)}`);

// The SDK collapses every failure into valid:false. Call the contract directly
// so a revert reason, a decode failure and a plain `false` are told apart.
const { chainId, verifierAddress, rpcUrl } = result.verification;
console.log('\n── calling the verifier contract directly ──');
console.log(`  chainId declared   ${chainId}`);
console.log(`  verifier           ${verifierAddress}`);
console.log(`  rpcUrl             ${rpcUrl}`);

const provider = new ethers.JsonRpcProvider(rpcUrl);
const network = await provider.getNetwork();
console.log(`  rpc actually is    chainId ${network.chainId}`);
if (String(network.chainId) !== String(chainId)) {
  console.log('  MISMATCH: the declared chainId is not the chain this rpcUrl serves.');
}

const code = await provider.getCode(verifierAddress);
console.log(`  code at verifier   ${code === '0x' ? 'NONE — nothing deployed here' : `${code.length} hex chars`}`);

const hex = result.publicInputs.startsWith('0x') ? result.publicInputs.slice(2) : result.publicInputs;
const inputs = [];
for (let i = 0; i < hex.length; i += 64) inputs.push('0x' + hex.slice(i, i + 64));
console.log(`  public inputs      ${inputs.length} words`);

const VERIFIER_ABI = [
  'function verify(bytes calldata _proof, bytes32[] calldata _publicInputs) external view returns (bool)',
];

async function attempt(label, address, rpc) {
  const p = new ethers.JsonRpcProvider(rpc);
  let chain;
  try {
    chain = String((await p.getNetwork()).chainId);
  } catch (err) {
    console.log(`  ${label}: rpc unreachable — ${err?.shortMessage || err?.message}`);
    return;
  }
  const c = new ethers.Contract(address, VERIFIER_ABI, p);
  try {
    const raw = await c.verify(result.proof, inputs);
    console.log(`  ${label}: verify() returned ${raw}   (chain ${chain}, ${address})`);
  } catch (err) {
    const detail = err?.data ? `revert ${err.data}` : err?.shortMessage || err?.message;
    console.log(`  ${label}: ${detail}   (chain ${chain}, ${address})`);
  }
}

console.log('\n── which combination actually verifies ──');

// As shipped: whatever the server put in the verification block.
await attempt('as the server sent it        ', verifierAddress, rpcUrl);

// The same verifier, but reached on an RPC that really serves the chain the
// server named. If this passes, the address is right and only the RPC is wrong.
const RPC_FOR_CHAIN = {
  '1': 'https://ethereum-rpc.publicnode.com',
  '11155111': 'https://ethereum-sepolia-rpc.publicnode.com',
  '8453': 'https://mainnet.base.org',
  '84532': 'https://sepolia.base.org',
};
const rpcForDeclared = RPC_FOR_CHAIN[String(chainId)];
if (rpcForDeclared && rpcForDeclared !== rpcUrl) {
  await attempt('declared chain, matching rpc', verifierAddress, rpcForDeclared);
}

// The verifier this repo registers for the chain the rpcUrl really serves. If
// this passes, the RPC is the one that was intended and the address is wrong.
// Read the table the server itself reads, rather than repeating addresses here.
// The server also refreshes it from the circuits repo at startup, so a
// disagreement between this and the live value is itself worth seeing.
const table = readFileSync(resolve(root, 'src/config/contracts.ts'), 'utf-8');
const block = table.match(new RegExp(`'${network.chainId}':\\s*\\{[^}]*\\}`))?.[0] || '';
const constantName = result.circuit.toUpperCase(); // coinbase_attestation → COINBASE_ATTESTATION
const line = block.split('\n').find((l) => l.includes(`CIRCUIT_IDS.${constantName}]`));
const other = line?.match(/'(0x[0-9a-fA-F]{40})'/)?.[1];
if (other && other.toLowerCase() !== verifierAddress.toLowerCase()) {
  await attempt('rpc\'s own chain, its verifier', other, rpcUrl);
}

console.log('\n  A `false` means the contract ran and rejected the proof — prover and');
console.log('  verifier disagree. A revert means the call never completed: wrong');
console.log('  chain, wrong address, or an argument shape it will not decode.');
