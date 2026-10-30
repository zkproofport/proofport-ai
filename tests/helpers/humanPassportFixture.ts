/**
 * Human Passport issuances signed by an INSECURE TEST ISSUER for an INSECURE
 * TEST WALLET (keys derived from public strings, as in circuits
 * scripts/human-passport/generate-fixtures.js), over REAL scoreV2 data from
 * Base. Lets every refusal be built by changing one thing.
 */
import { ethers } from 'ethers';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  passportDigest,
  VERIFY_AND_ATTEST_SELECTOR,
  type HumanPassportAnchors,
  type PassportRequest,
} from '../../src/input/humanPassport.js';
import { computeSignalHash, computeScope, computeWalletNullifier } from '../../src/input/inputBuilder.js';
import { HUMAN_PASSPORT_SCORE_SCHEMA } from '@zkproofport-app/core/circuits';

export const REAL = JSON.parse(readFileSync(join(__dirname, '..', 'fixtures', 'humanPassportIssuances.json'), 'utf8')) as {
  issuances: { uid: string; recipient: string; txid: string; to: string; data: string; input: string }[];
};

export const TEST_ISSUER = new ethers.Wallet(ethers.keccak256(ethers.toUtf8Bytes('zkproofport human_passport_score INSECURE TEST ISSUER')));
export const OTHER_ISSUER = new ethers.Wallet(ethers.keccak256(ethers.toUtf8Bytes('zkproofport human_passport_score INSECURE ATTACKER ISSUER')));
export const TEST_WALLET = new ethers.Wallet(ethers.keccak256(ethers.toUtf8Bytes('zkproofport human_passport_score INSECURE TEST WALLET')));
export const OTHER_WALLET = new ethers.Wallet(ethers.keccak256(ethers.toUtf8Bytes('zkproofport human_passport_score INSECURE OTHER WALLET')));

const T = (s: string) => ethers.keccak256(ethers.toUtf8Bytes(s));
const enc = ethers.AbiCoder.defaultAbiCoder();
export function domainSeparator(chainId: number, verifier: string): string {
  return ethers.keccak256(enc.encode(
    ['bytes32', 'bytes32', 'bytes32', 'uint256', 'address'],
    [T('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'), T('GitcoinVerifier'), T('1'), chainId, verifier],
  ));
}

export const TEST_VERIFIERS = ['0x45fA2E93d79Fc44d44b697A94330031b8ccbF68e', '0x16db23c4b99bbC9A6Bf55dF7a787C9AEFD261185'];

/** The production tree's shape (two Base verifiers), with the test issuer. */
export function testAnchors(issuer = TEST_ISSUER.address): HumanPassportAnchors {
  const leaves = TEST_VERIFIERS.map(verifier => {
    const ds = domainSeparator(8453, verifier);
    return { verifier, domainSeparator: ds, leaf: ethers.keccak256(ethers.concat([issuer, ds, HUMAN_PASSPORT_SCORE_SCHEMA])) };
  });
  return { issuer, leaves, root: ethers.keccak256(ethers.concat([leaves[0].leaf, leaves[1].leaf])) };
}

const iface = new ethers.Interface([
  'function verifyAndAttest(((bytes32 schema,(address recipient,uint64 expirationTime,bool revocable,bytes32 refUID,bytes data,uint256 value)[] data)[] multiAttestationRequest,uint256 nonce,uint256 fee) attestationRequest,uint8 v,bytes32 r,bytes32 s) payable returns (bytes32[])',
]);
const wrapper = new ethers.Interface(['function execute(address dest, uint256 value, bytes func)']);

export interface Built {
  request: PassportRequest;
  calldata: string;
  data: string;
  anchors: HumanPassportAnchors;
}

/**
 * One verifyAndAttest call. `entries` lets a test put more than one entry (or
 * request) in; `signer` and `verifierIndex` choose who signs under which domain.
 */
export function buildIssuance(opts: {
  wallet?: string;
  data?: string;
  expirationTime?: bigint;
  schema?: string;
  signer?: ethers.Wallet;
  verifierIndex?: number;
  extraEntries?: number;
  extraRequests?: number;
  wrap?: 'none' | 'execute';
} = {}): Built {
  const data = opts.data ?? REAL.issuances[0].data;
  const request: PassportRequest = {
    schema: opts.schema ?? HUMAN_PASSPORT_SCORE_SCHEMA,
    recipient: opts.wallet ?? TEST_WALLET.address,
    expirationTime: opts.expirationTime ?? 1_900_000_000n,
    revocable: true,
    refUID: ethers.ZeroHash,
    data,
    value: 0n,
    nonce: 7n,
    fee: 0n,
  };
  const anchors = testAnchors();
  const ds = anchors.leaves[opts.verifierIndex ?? 0].domainSeparator;
  const sig = (opts.signer ?? TEST_ISSUER).signingKey.sign(passportDigest(ds, request));
  const entry = [request.recipient, request.expirationTime, request.revocable, request.refUID, request.data, request.value];
  const entries = [entry, ...Array.from({ length: opts.extraEntries ?? 0 }, () => entry)];
  const multis = [[request.schema, entries], ...Array.from({ length: opts.extraRequests ?? 0 }, () => [request.schema, [entry]])];
  let calldata = iface.encodeFunctionData('verifyAndAttest', [[multis, request.nonce, request.fee], sig.v, sig.r, sig.s]);
  if (opts.wrap === 'execute') {
    calldata = wrapper.encodeFunctionData('execute', [TEST_VERIFIERS[0], 0, calldata]);
  }
  return { request, calldata, data, anchors };
}

/** A decoy: the selector's four bytes inside other data, before the real call. */
export function withDecoy(calldata: string): string {
  return ethers.concat(['0x12345678', VERIFY_AND_ATTEST_SELECTOR, '0xdeadbeef', calldata]);
}

/** The client fields a request for TEST_WALLET carries (personal_sign over signal_hash). */
export async function requestInputs(opts: { wallet?: ethers.Wallet; scope?: string; minScore?: unknown } = {}) {
  const wallet = opts.wallet ?? TEST_WALLET;
  const scope = opts.scope ?? 'human-passport-test-scope';
  const signalHash = computeSignalHash(wallet.address, scope, 'human_passport_score');
  const signature = await wallet.signMessage(signalHash);
  const pub = ethers.getBytes(wallet.signingKey.publicKey);
  const scopeBytes = computeScope(scope);
  return {
    user_address: wallet.address,
    signature,
    signal_hash: ethers.hexlify(signalHash),
    scope_bytes: ethers.hexlify(scopeBytes),
    nullifier: ethers.hexlify(computeWalletNullifier(wallet.address, 'human_passport_score', scopeBytes)),
    user_pubkey_x: ethers.hexlify(pub.slice(1, 33)),
    user_pubkey_y: ethers.hexlify(pub.slice(33, 65)),
    min_score: 'minScore' in opts ? opts.minScore : 20,
  };
}
