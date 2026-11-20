/**
 * Does the GIWA input pipeline work, without Docker and without a server?
 *
 * The three things most likely to be wrong when giwa_attestation is wired up,
 * and none of them need a container:
 *   - the attestation lookup (a Blockscout read, not an EAS query)
 *   - the user key recovered from the message actually signed, in both modes
 *     (the nullifier is the OPRF one: the SDK computes it and the circuit
 *     checks it; nothing here can recompute it without the OPRF network)
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
import { computeCircuitParams } from '../src/input/inputBuilder.js';
import { computeSignalHash, newRequestId } from '../packages/sdk/src/signalHash.js';
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
// keccak256(scope ++ circuitId ++ requestId), no wallet; a fresh request id per run.
const signalHash = computeSignalHash({ scope, circuitId: CIRCUIT_IDS.GIWA_ATTESTATION, requestId: newRequestId() });
const signature = await wallet.signMessage(signalHash);

const built = await computeCircuitParams(
  { address: wallet.address, signature, circuitId: CIRCUIT_IDS.GIWA_ATTESTATION, signalHash: ethers.hexlify(signalHash) },
  process.env.EAS_GRAPHQL_ENDPOINT ?? '',
  [process.env.BASE_RPC_URL ?? ''],
);
const keyOf = (x: string, y: string) => ethers.computeAddress('0x04' + x.slice(2) + y.slice(2));
const plainOk = keyOf(built.userPubkeyX, built.userPubkeyY) === wallet.address;
console.log('attestation tx   ', built.txLength, 'bytes; attester leaf', built.merkleLeafIndex);
console.log(plainOk ? 'KEY MATCH (signal_hash)' : 'KEY MISMATCH -- the circuit would refuse "User pubkey does not match address"');
if (!plainOk) process.exit(1);

// ── The action mode: the key must be recovered from the EIP-712 digest ─────
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
const actionHash = ethers.TypedDataEncoder.hashStruct(action.primaryType, action.types, action.message);
const typedSignature = await wallet.signTypedData(action.domain, action.types, action.message);

const bound = await computeCircuitParams(
  {
    address: wallet.address,
    signature: typedSignature,
    circuitId: CIRCUIT_IDS.GIWA_ATTESTATION,
    signalHash: ethers.ZeroHash,
    domainSeparator,
    actionHash,
  },
  process.env.EAS_GRAPHQL_ENDPOINT ?? '',
  [process.env.BASE_RPC_URL ?? ''],
);
const actionOk = keyOf(bound.userPubkeyX, bound.userPubkeyY) === wallet.address;
console.log(actionOk ? 'KEY MATCH (EIP-712 action)' : 'KEY MISMATCH in action mode');
if (!actionOk) process.exit(1);
