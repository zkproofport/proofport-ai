/**
 * Does the GIWA input pipeline work, without Docker and without a server?
 *
 * The three things most likely to be wrong when giwa_attestation is wired up,
 * and none of them need a container:
 *   - the attestation lookup (a Blockscout read, not an EAS query)
 *   - the flat input vector's length
 *   - the nullifier, which must equal what the circuit recomputes
 *
 * A full E2E takes a Docker build; this takes seconds, so a mistake in the
 * lookup does not hide behind a ten-minute image build.
 *
 *   npx tsx scripts/check-giwa-inputs.ts
 *
 * Needs GIWA_ATTESTATION_KEY in .env.test -- the wallet attested on GIWA
 * Sepolia, which is NOT the Coinbase ATTESTATION_KEY.
 */
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { ethers } from 'ethers';
import { findGiwaAttestation } from '../src/input/giwaAttestation.js';
import { buildCircuitInputs, computeSignalHash } from '../src/input/inputBuilder.js';
import { CIRCUIT_IDS } from '../src/config/circuitIds.js';

const here = dirname(fileURLToPath(import.meta.url));
for (const line of readFileSync(resolve(here, '..', '.env.test'), 'utf8').split('\n')) {
  const t = line.trim();
  if (!t || t.startsWith('#')) continue;
  const i = t.indexOf('=');
  if (i > 0 && process.env[t.slice(0, i).trim()] === undefined) {
    process.env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
}

const key = process.env.GIWA_ATTESTATION_KEY;
if (!key) throw new Error('GIWA_ATTESTATION_KEY is required in .env.test');
const explorerUrl = process.env.GIWA_EXPLORER_URL;
const rpcUrl = process.env.GIWA_RPC_URL;
if (!explorerUrl || !rpcUrl) throw new Error('GIWA_EXPLORER_URL and GIWA_RPC_URL are required');

const wallet = new ethers.Wallet(key);
console.log('wallet           ', wallet.address);

const found = await findGiwaAttestation(explorerUrl, rpcUrl, wallet.address);
if (!found) throw new Error(`No GIWA attestation for ${wallet.address}`);
console.log('attestation tx   ', found.txHash);
console.log('raw tx bytes     ', (found.rawTransaction.length - 2) / 2);

const scope = process.env.GIWA_CHECK_SCOPE || 'check:giwa-inputs';
const signalHash = computeSignalHash(wallet.address, scope, CIRCUIT_IDS.GIWA_ATTESTATION);
const signature = await wallet.signMessage(signalHash);

const built = await buildCircuitInputs(
  { address: wallet.address, signature, scope, circuitId: CIRCUIT_IDS.GIWA_ATTESTATION },
  process.env.EAS_GRAPHQL_ENDPOINT ?? '',
  [process.env.BASE_RPC_URL ?? ''],
);
console.log('input vector     ', built.inputs.length, 'entries');
console.log('nullifier        ', built.nullifier);

// The circuit's own formula, recomputed here rather than trusted.
const tag = ethers.keccak256(ethers.toUtf8Bytes(CIRCUIT_IDS.GIWA_ATTESTATION));
const secret = ethers.keccak256(
  ethers.concat([ethers.getBytes(wallet.address), ethers.getBytes(tag)]),
);
const expected = ethers.keccak256(
  ethers.concat([
    ethers.getBytes(secret),
    ethers.getBytes(ethers.keccak256(ethers.toUtf8Bytes(scope))),
  ]),
);
const matches = expected.toLowerCase() === built.nullifier.toLowerCase();
console.log('circuit formula  ', expected);
console.log(matches ? 'MATCH' : 'MISMATCH -- the proof would fail with "Nullifier mismatch"');
if (!matches) process.exit(1);

// ── The action mode, and the property that made the nullifier change ──────
//
// Same wallet, same scope, an EIP-712 action instead of the signal hash. The
// nullifier must come out IDENTICAL: it no longer derives from signal_hash,
// which is zero here, and if it did this wallet would have two identities in
// one scope.
const action = {
  domain: {
    name: 'GIWA input check',
    version: '1',
    chainId: 91342,
    verifyingContract: '0x6646d970499BBeD728636823A5A7e551E811b414',
  },
  types: { Deposit: [{ name: 'amount', type: 'uint256' }] },
  primaryType: 'Deposit',
  message: { amount: 1_000_000n },
};
const domainSeparator = ethers.TypedDataEncoder.hashDomain(action.domain);
const actionHash = ethers.TypedDataEncoder.hashStruct(
  action.primaryType,
  action.types,
  action.message,
);
const typedSignature = await wallet.signTypedData(action.domain, action.types, action.message);

const bound = await buildCircuitInputs(
  {
    address: wallet.address,
    signature: typedSignature,
    scope,
    circuitId: CIRCUIT_IDS.GIWA_ATTESTATION,
    domainSeparator,
    actionHash,
  },
  process.env.EAS_GRAPHQL_ENDPOINT ?? '',
  [process.env.BASE_RPC_URL ?? ''],
);
console.log('');
console.log('with an action   ', bound.inputs.length, 'entries');
console.log('nullifier        ', bound.nullifier);

// The first 32 entries are signal_hash, which must be empty in action mode.
const signalIsEmpty = bound.inputs.slice(0, 32).every((v) => v === '0');
console.log('signal_hash zero ', signalIsEmpty);

const sameNullifier = bound.nullifier.toLowerCase() === built.nullifier.toLowerCase();
console.log(
  sameNullifier && signalIsEmpty
    ? 'BOTH MODES AGREE -- one wallet, one scope, one nullifier'
    : 'MISMATCH between the two modes',
);
if (!sameNullifier || !signalIsEmpty) process.exit(1);
