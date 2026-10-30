/**
 * human_passport_score: find the wallet's Human Passport scoreV2 issuance on
 * Base and check it the way the circuit will, BEFORE any payment.
 *
 * The circuit (circuits human-passport-score/src/main.nr) proves that a
 * scoreV2 attestation request signed (EIP-712) by Human Passport's issuer
 * names the signing wallet, scores it at least `min_score` by scorer
 * `scorer_id`, and has not expired at `now`. The signed request and the
 * issuer's signature exist only in the calldata of the transaction that
 * submitted it to GitcoinVerifier.verifyAndAttest, so:
 *
 *   1. EAS (GraphQL index) names the wallet's newest unrevoked, unexpired
 *      scoreV2 attestation and the transaction that created it;
 *   2. the EAS contract on Base confirms that record (attester, schema,
 *      recipient, unrevoked, unexpired, data);
 *   3. the transaction's calldata holds a verifyAndAttest call -- directly
 *      (most issuances) or nested inside a smart-wallet / bundler call -- so
 *      every occurrence of its selector is decoded, and the one call that
 *      matches the record and recovers to the issuer is used.
 *
 * Every refusal here is one the circuit would make after payment.
 * Mirrors circuits scripts/human-passport/generate-fixtures.js (digest, tree).
 */
import { ethers } from 'ethers';
import {
  HUMAN_PASSPORT_ISSUER,
  HUMAN_PASSPORT_ISSUER_LEAVES,
  HUMAN_PASSPORT_ISSUER_ROOT,
  HUMAN_PASSPORT_MAX_DATA_BYTES,
  HUMAN_PASSPORT_SCORE_DECIMALS,
  HUMAN_PASSPORT_SCORE_SCHEMA,
  HUMAN_PASSPORT_SCORER_ID,
  humanPassportScoreUnits,
} from '@zkproofport-app/core/circuits';
import { StatementRefusal } from './statementSigner.js';
import { computeWalletNullifier } from './inputBuilder.js';
import { createLogger } from '../logger.js';

const log = createLogger('HumanPassport');

export const HUMAN_PASSPORT_CIRCUIT_ID = 'human_passport_score';

/** GitcoinAttester on Base: the EAS attester every scoreV2 attestation names. */
export const GITCOIN_ATTESTER = '0xCc90105D4A2aa067ee768120AdA19886021dF422';
const BASE_EAS_CONTRACT = '0x4200000000000000000000000000000000000021';
/** The smallest scoreV2 `data`: five static words plus the stamps offset. */
export const HUMAN_PASSPORT_MIN_DATA_BYTES = 192;

const VERIFY_AND_ATTEST_ABI =
  'function verifyAndAttest(((bytes32 schema,(address recipient,uint64 expirationTime,bool revocable,bytes32 refUID,bytes data,uint256 value)[] data)[] multiAttestationRequest,uint256 nonce,uint256 fee) attestationRequest,uint8 v,bytes32 r,bytes32 s) payable returns (bytes32[])';
/** keccak256 of the signature above, first four bytes; held to it by tests/humanPassport.test.ts. */
export const VERIFY_AND_ATTEST_SELECTOR = '0x48a15e6f';

// Built on first use, not at import: several suites replace parts of ethers
// with mocks, and an import-time `new ethers.Interface` broke every suite that
// loads the proof routes.
let cached: { iface: ethers.Interface; enc: ethers.AbiCoder; stamp: string; multi: string; passport: string } | undefined;
function abi() {
  if (!cached) {
    const T = (s: string) => ethers.keccak256(ethers.toUtf8Bytes(s));
    cached = {
      iface: new ethers.Interface([VERIFY_AND_ATTEST_ABI]),
      enc: ethers.AbiCoder.defaultAbiCoder(),
      stamp: T('AttestationRequestData(address recipient,uint64 expirationTime,bool revocable,bytes32 refUID,bytes data,uint256 value)'),
      multi: T('MultiAttestationRequest(bytes32 schema,AttestationRequestData[] data)AttestationRequestData(address recipient,uint64 expirationTime,bool revocable,bytes32 refUID,bytes data,uint256 value)'),
      passport: T('PassportAttestationRequest(MultiAttestationRequest[] multiAttestationRequest,uint256 nonce,uint256 fee)AttestationRequestData(address recipient,uint64 expirationTime,bool revocable,bytes32 refUID,bytes data,uint256 value)MultiAttestationRequest(bytes32 schema,AttestationRequestData[] data)'),
    };
  }
  return cached;
}

/** The one signed entry of a scoreV2 request, plus the request's nonce and fee. */
export interface PassportRequest {
  schema: string;
  recipient: string;
  expirationTime: bigint;
  revocable: boolean;
  refUID: string;
  data: string;
  value: bigint;
  nonce: bigint;
  fee: bigint;
}

/** Everything the circuit needs about the issuance, checked. */
export interface HumanPassportIssuance {
  txHash: string;
  attestationUid: string;
  /** The GitcoinVerifier whose EIP-712 domain the issuer signed under. */
  verifier: string;
  domainSeparator: string;
  request: PassportRequest;
  /** r || s, 64 bytes, as the issuer signed. */
  issuerSignature: string;
  issuerPubkeyX: string;
  issuerPubkeyY: string;
  merkleRoot: string;
  merkleProof: string[];
  leafIndex: number;
  merkleDepth: number;
  score: number;
  scorerId: number;
}

/**
 * Who may have signed a score, and the tree the circuit proves membership in.
 * Production is core's (Human Passport's issuer under both Base
 * GitcoinVerifiers); tests pass their own to build issuances a test key signs.
 */
export interface HumanPassportAnchors {
  issuer: string;
  leaves: readonly { verifier: string; domainSeparator: string; leaf: string }[];
  root: string;
}

export const HUMAN_PASSPORT_ANCHORS: HumanPassportAnchors = Object.freeze({
  issuer: HUMAN_PASSPORT_ISSUER,
  leaves: HUMAN_PASSPORT_ISSUER_LEAVES,
  root: HUMAN_PASSPORT_ISSUER_ROOT,
});

/**
 * The size and head checks the circuit makes on scoreV2 `data`, as refusals.
 * Returns the head.
 */
export function checkScoreData(data: string, attestationUid: string): ReturnType<typeof readScoreHead> {
  const length = ethers.getBytes(data).length;
  if (length > HUMAN_PASSPORT_MAX_DATA_BYTES) {
    throw new StatementRefusal(
      'HUMAN_PASSPORT_DATA_TOO_LARGE',
      `This Human Passport score carries ${length} bytes of stamp data; the circuit holds at most ${HUMAN_PASSPORT_MAX_DATA_BYTES}.`,
    );
  }
  let head;
  try {
    head = readScoreHead(data);
  } catch (e) {
    throw new StatementRefusal('HUMAN_PASSPORT_ISSUANCE_UNREADABLE', `Attestation ${attestationUid}: ${(e as Error).message}`);
  }
  if (head.decimals !== HUMAN_PASSPORT_SCORE_DECIMALS) {
    throw new StatementRefusal('HUMAN_PASSPORT_ISSUANCE_UNREADABLE', `Attestation ${attestationUid} has ${head.decimals} score decimals; the circuit reads ${HUMAN_PASSPORT_SCORE_DECIMALS}.`);
  }
  if (head.scorerId !== BigInt(HUMAN_PASSPORT_SCORER_ID)) {
    throw new StatementRefusal('NO_HUMAN_PASSPORT_SCORE', `Attestation ${attestationUid} is from scorer ${head.scorerId}, not Human Passport's scorer ${HUMAN_PASSPORT_SCORER_ID}.`);
  }
  return head;
}

/** hashStruct + EIP-712 digest of a one-request, one-entry PassportAttestationRequest. */
export function passportDigest(domainSeparator: string, r: PassportRequest): string {
  const { enc, stamp: STAMP_TYPEHASH, multi: MULTI_TYPEHASH, passport: PASSPORT_TYPEHASH } = abi();
  const entry = ethers.keccak256(enc.encode(
    ['bytes32', 'address', 'uint64', 'bool', 'bytes32', 'bytes32', 'uint256'],
    [STAMP_TYPEHASH, r.recipient, r.expirationTime, r.revocable, r.refUID, ethers.keccak256(r.data), r.value],
  ));
  const multi = ethers.keccak256(enc.encode(['bytes32', 'bytes32', 'bytes32'], [MULTI_TYPEHASH, r.schema, ethers.keccak256(entry)]));
  const struct = ethers.keccak256(enc.encode(['bytes32', 'bytes32', 'uint256', 'uint256'], [PASSPORT_TYPEHASH, ethers.keccak256(multi), r.nonce, r.fee]));
  return ethers.keccak256(ethers.concat(['0x1901', domainSeparator, struct]));
}

export interface DecodedVerifyAndAttest {
  /** Byte offset of the selector inside the scanned calldata. */
  offset: number;
  requests: { schema: string; entries: Omit<PassportRequest, 'schema' | 'nonce' | 'fee'>[] }[];
  nonce: bigint;
  fee: bigint;
  v: number;
  r: string;
  s: string;
}

/**
 * Every verifyAndAttest call the calldata holds, wherever it sits.
 *
 * A direct call starts with the selector. A call made through a smart wallet
 * or an ERC-4337 bundler carries it nested: the inner call's bytes are
 * contiguous inside the outer ABI encoding, so decoding from each occurrence
 * of the selector finds it. An occurrence that does not decode (the four bytes
 * appearing by chance) is skipped; callers check what a decoded call says.
 */
export function findVerifyAndAttestCalls(calldata: string): DecodedVerifyAndAttest[] {
  if (typeof calldata !== 'string' || !/^0x([0-9a-fA-F]{2})*$/.test(calldata)) {
    throw new Error('calldata must be 0x-prefixed hex bytes');
  }
  const hex = calldata.slice(2).toLowerCase();
  const sel = VERIFY_AND_ATTEST_SELECTOR.slice(2);
  const found: DecodedVerifyAndAttest[] = [];
  for (let i = hex.indexOf(sel); i !== -1; i = hex.indexOf(sel, i + 2)) {
    if (i % 2 !== 0) continue;
    try {
      const d = abi().iface.decodeFunctionData('verifyAndAttest', '0x' + hex.slice(i));
      const req = d.attestationRequest;
      found.push({
        offset: i / 2,
        requests: req.multiAttestationRequest.map((m: any) => ({
          schema: m.schema,
          entries: m.data.map((e: any) => ({
            recipient: e.recipient,
            expirationTime: BigInt(e.expirationTime),
            revocable: e.revocable,
            refUID: e.refUID,
            data: e.data,
            value: BigInt(e.value),
          })),
        })),
        nonce: BigInt(req.nonce),
        fee: BigInt(req.fee),
        v: Number(d.v),
        r: d.r,
        s: d.s,
      });
    } catch {
      // Not a call: the selector's bytes occurred inside other data.
    }
  }
  return found;
}

/** The static head of scoreV2 `data`, read as Solidity's abi.decode reads it, or an error. */
export function readScoreHead(data: string): { passing: boolean; decimals: number; scorerId: bigint; score: bigint; threshold: bigint } {
  const b = ethers.getBytes(data);
  if (b.length < HUMAN_PASSPORT_MIN_DATA_BYTES) throw new Error(`score data is ${b.length} bytes, shorter than its ${HUMAN_PASSPORT_MIN_DATA_BYTES}-byte head`);
  const word = (i: number) => b.slice(i * 32, i * 32 + 32);
  const uint = (i: number, bits: number) => {
    const w = word(i);
    const lead = 32 - bits / 8;
    if (w.slice(0, lead).some(x => x !== 0)) throw new Error(`score data word ${i} has non-zero padding`);
    return BigInt(ethers.hexlify(w));
  };
  const passing = uint(0, 8);
  if (passing > 1n) throw new Error('score data: passing_score is not a bool');
  const head = {
    passing: passing === 1n,
    decimals: Number(uint(1, 8)),
    scorerId: uint(2, 128),
    score: uint(3, 32),
    threshold: uint(4, 32),
  };
  if (uint(5, 256) !== 0xc0n) throw new Error('score data: stamps offset is not 0xc0');
  return head;
}

/**
 * Check one transaction's calldata against the EAS record and pick out the
 * issuance the circuit will prove. Pure: no network.
 */
export function issuanceFromCalldata(input: {
  calldata: string;
  txHash: string;
  attestationUid: string;
  wallet: string;
  attestationData: string;
}, anchors: HumanPassportAnchors = HUMAN_PASSPORT_ANCHORS): HumanPassportIssuance {
  const wallet = ethers.getAddress(input.wallet);
  const calls = findVerifyAndAttestCalls(input.calldata);
  if (calls.length === 0) {
    throw new StatementRefusal('HUMAN_PASSPORT_ISSUANCE_UNREADABLE', `Transaction ${input.txHash} holds no verifyAndAttest call to read the signed score from.`);
  }
  const reasons: string[] = [];
  for (const call of calls) {
    if (call.requests.length !== 1 || call.requests[0].entries.length !== 1) {
      reasons.push(`call at byte ${call.offset}: ${call.requests.length} request(s); the circuit proves exactly one request with one entry`);
      continue;
    }
    const entry = call.requests[0].entries[0];
    const request: PassportRequest = { schema: call.requests[0].schema, ...entry, nonce: call.nonce, fee: call.fee };
    if (request.schema.toLowerCase() !== HUMAN_PASSPORT_SCORE_SCHEMA.toLowerCase()) {
      reasons.push(`call at byte ${call.offset}: schema ${request.schema} is not scoreV2`);
      continue;
    }
    if (ethers.getAddress(request.recipient) !== wallet) {
      reasons.push(`call at byte ${call.offset}: recipient ${request.recipient} is another wallet`);
      continue;
    }
    if (request.data.toLowerCase() !== input.attestationData.toLowerCase()) {
      reasons.push(`call at byte ${call.offset}: its data is not the attestation's`);
      continue;
    }
    const sig = ethers.Signature.from({ r: call.r, s: call.s, v: call.v });
    for (let leafIndex = 0; leafIndex < anchors.leaves.length; leafIndex++) {
      const leaf = anchors.leaves[leafIndex];
      const digest = passportDigest(leaf.domainSeparator, request);
      let pub: string;
      try {
        pub = ethers.SigningKey.recoverPublicKey(digest, sig);
      } catch {
        continue;
      }
      if (ethers.computeAddress(pub) !== ethers.getAddress(anchors.issuer)) continue;
      const head = checkScoreData(input.attestationData, input.attestationUid);
      const sibling = anchors.leaves[leafIndex ^ 1];
      if (!sibling || anchors.leaves.length !== 2) {
        throw new Error(`The issuer list has ${anchors.leaves.length} leaves; this builder makes depth-1 paths over two.`);
      }
      const root = leafIndex === 0
        ? ethers.keccak256(ethers.concat([leaf.leaf, sibling.leaf]))
        : ethers.keccak256(ethers.concat([sibling.leaf, leaf.leaf]));
      if (root !== anchors.root) throw new Error(`Issuer leaves give root ${root}, the anchors name ${anchors.root}`);
      const raw = ethers.getBytes(pub);
      return {
        txHash: input.txHash,
        attestationUid: input.attestationUid,
        verifier: leaf.verifier,
        domainSeparator: leaf.domainSeparator,
        request,
        issuerSignature: ethers.concat([sig.r, sig.s]),
        issuerPubkeyX: ethers.hexlify(raw.slice(1, 33)),
        issuerPubkeyY: ethers.hexlify(raw.slice(33, 65)),
        merkleRoot: root,
        merkleProof: [sibling.leaf],
        leafIndex,
        merkleDepth: 1,
        score: Number(head.score),
        scorerId: Number(head.scorerId),
      };
    }
    reasons.push(`call at byte ${call.offset}: not signed by Human Passport's issuer under either Base GitcoinVerifier`);
  }
  throw new StatementRefusal(
    'HUMAN_PASSPORT_ISSUANCE_UNREADABLE',
    `Transaction ${input.txHash} holds no issuance the circuit can prove for ${wallet}: ${reasons.join('; ')}.`,
  );
}

// ─── Reading the chain ──────────────────────────────────────────────────

export interface IndexedPassportAttestation {
  uid: string;
  txid: string;
}

export interface OnChainPassportAttestation {
  uid: string; schema: string; recipient: string; attester: string;
  revocationTime: bigint; expirationTime: bigint; data: string;
}

/** Where the issuance is read from. Injected so the checks are testable without a network. */
export interface HumanPassportReader {
  /** The wallet's newest scoreV2 attestation an index reports unrevoked and unexpired at `nowSeconds`, or null. */
  latest(wallet: string, nowSeconds: number): Promise<IndexedPassportAttestation | null>;
  onChain(uid: string): Promise<OnChainPassportAttestation>;
  /** The transaction's calldata. */
  calldata(txHash: string): Promise<string>;
}

const EAS_ABI = ['function getAttestation(bytes32 uid) view returns ((bytes32 uid, bytes32 schema, uint64 time, uint64 expirationTime, uint64 revocationTime, bytes32 refUID, address recipient, address attester, bool revocable, bytes data))'];

const LATEST_QUERY = `query HumanPassportScore($recipient: String!, $schemaId: String!, $now: Int!) {
  attestations(
    where: { recipient: { equals: $recipient }, schemaId: { equals: $schemaId }, revoked: { equals: false }, expirationTime: { gt: $now } }
    orderBy: { time: desc }
    take: 1
  ) { id txid }
}`;

export function easHumanPassportReader(easGraphqlEndpoint: string, baseRpcUrl: string, timeoutMs = 10_000): HumanPassportReader {
  if (!easGraphqlEndpoint) throw new Error('EAS_GRAPHQL_ENDPOINT is required to find a Human Passport score');
  if (!baseRpcUrl) throw new Error('BASE_RPC_URL is required to read a Human Passport score on chain');
  const provider = new ethers.JsonRpcProvider(baseRpcUrl, 8453, { staticNetwork: true });
  const eas = new ethers.Contract(BASE_EAS_CONTRACT, EAS_ABI, provider);
  return {
    async latest(wallet, nowSeconds) {
      const response = await fetch(easGraphqlEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: LATEST_QUERY,
          // Checked 2026-10-30: base.easscan.org matches a recipient in either case.
          variables: { recipient: ethers.getAddress(wallet), schemaId: HUMAN_PASSPORT_SCORE_SCHEMA, now: nowSeconds },
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) throw new Error(`EAS GraphQL request failed: HTTP ${response.status}`);
      const body = await response.json() as { data?: { attestations?: { id: string; txid: string }[] }; errors?: { message: string }[] };
      if (body.errors?.length) throw new Error(`EAS GraphQL error: ${body.errors[0].message}`);
      const a = body.data?.attestations;
      if (!Array.isArray(a)) throw new Error('EAS GraphQL answered without an attestations list');
      return a.length ? { uid: a[0].id, txid: a[0].txid } : null;
    },
    async onChain(uid) {
      const a = await eas.getAttestation(uid);
      return {
        uid: a.uid, schema: a.schema, recipient: a.recipient, attester: a.attester,
        revocationTime: BigInt(a.revocationTime), expirationTime: BigInt(a.expirationTime), data: a.data,
      };
    },
    async calldata(txHash) {
      const tx = await provider.getTransaction(txHash);
      if (!tx) throw new Error(`Base has no transaction ${txHash}`);
      return tx.data;
    },
  };
}

/** What the route checked before payment, carried to the prover. */
export interface HumanPassportPrepared {
  issuance: HumanPassportIssuance;
  minScoreUnits: number;
  /** Unix seconds the circuit proves the attestation unexpired at (public input `now`). */
  now: number;
}

const HASH32 = /^0x[0-9a-fA-F]{64}$/;

/**
 * Everything checked before payment for a human_passport_score request:
 * the request's shape, the nullifier rule, that the signature recovers to the
 * wallet it names, the threshold, and the issuance (found, signed by the
 * issuer, for this wallet, unexpired, unrevoked, scorer 335, within the data
 * cap, scored at or above the threshold).
 */
export async function prepareHumanPassport(
  inputs: {
    user_address?: unknown;
    signature?: unknown;
    signal_hash?: unknown;
    scope_bytes?: unknown;
    nullifier?: unknown;
    user_pubkey_x?: unknown;
    user_pubkey_y?: unknown;
    min_score?: unknown;
    domain_separator?: unknown;
    action_hash?: unknown;
  },
  deps: { reader: HumanPassportReader; now?: () => number; anchors?: HumanPassportAnchors },
): Promise<HumanPassportPrepared> {
  const bad = (m: string) => new StatementRefusal('INVALID_REQUEST', m);
  if (typeof inputs.user_address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(inputs.user_address)) throw bad('user_address must be a 0x-prefixed 20-byte hex address.');
  for (const k of ['signal_hash', 'scope_bytes', 'nullifier', 'user_pubkey_x', 'user_pubkey_y'] as const) {
    if (typeof inputs[k] !== 'string' || !HASH32.test(inputs[k] as string)) throw bad(`${k} must be a 0x-prefixed 32-byte hex string.`);
  }
  if (typeof inputs.signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(inputs.signature)) throw bad('signature must be a 0x-prefixed 65-byte hex signature.');
  let minScoreUnits: number;
  try {
    minScoreUnits = humanPassportScoreUnits(inputs.min_score);
  } catch (e) {
    throw bad(`min_score: ${(e as Error).message}`);
  }
  const wallet = ethers.getAddress(inputs.user_address);
  const scope = ethers.getBytes(inputs.scope_bytes as string);
  const expected = ethers.hexlify(computeWalletNullifier(wallet, HUMAN_PASSPORT_CIRCUIT_ID, scope));
  if (expected !== (inputs.nullifier as string).toLowerCase()) {
    throw new StatementRefusal(
      'NULLIFIER_RULE',
      `${HUMAN_PASSPORT_CIRCUIT_ID} derives the nullifier from the wallet and the circuit tag: ` +
      `keccak256(keccak256(address ++ keccak256("${HUMAN_PASSPORT_CIRCUIT_ID}")) ++ scope). The request carries a different one.`,
    );
  }
  // The circuit checks the wallet's signature over exactly one message: the
  // EIP-712 action when one is bound, else signal_hash under personal_sign.
  const hasDomain = inputs.domain_separator !== undefined;
  if (hasDomain !== (inputs.action_hash !== undefined)) throw bad('Send both domain_separator and action_hash, or neither.');
  let digest: string;
  if (hasDomain) {
    if (![inputs.domain_separator, inputs.action_hash].every(v => typeof v === 'string' && HASH32.test(v))) {
      throw bad('domain_separator and action_hash must each be a 0x-prefixed 32-byte hash.');
    }
    digest = ethers.keccak256(ethers.concat(['0x1901', inputs.domain_separator as string, inputs.action_hash as string]));
  } else {
    digest = ethers.hashMessage(ethers.getBytes(inputs.signal_hash as string));
  }
  let recovered: string;
  try {
    recovered = ethers.SigningKey.recoverPublicKey(digest, inputs.signature as string);
  } catch {
    throw bad('signature does not recover to any key.');
  }
  if (ethers.computeAddress(recovered) !== wallet) {
    throw bad(`The signature was not made by ${wallet} over the request it names (${hasDomain ? 'the EIP-712 action' : 'signal_hash'}).`);
  }
  const rec = ethers.getBytes(recovered);
  if (ethers.hexlify(rec.slice(1, 33)) !== (inputs.user_pubkey_x as string).toLowerCase()
    || ethers.hexlify(rec.slice(33, 65)) !== (inputs.user_pubkey_y as string).toLowerCase()) {
    throw bad('user_pubkey_x / user_pubkey_y are not the key that made the signature.');
  }

  const now = Math.floor((deps.now ?? Date.now)() / 1000);
  let indexed: IndexedPassportAttestation | null;
  try {
    indexed = await deps.reader.latest(wallet, now);
  } catch (e) {
    throw new StatementRefusal('HUMAN_PASSPORT_LOOKUP_FAILED', `Could not look up a Human Passport score for ${wallet}: ${(e as Error).message}`);
  }
  if (!indexed) {
    throw new StatementRefusal(
      'NO_HUMAN_PASSPORT_SCORE',
      `${wallet} has no unexpired Human Passport score recorded on Base. Create one in Human Passport and record it on Base, then try again.`,
    );
  }
  if (!HASH32.test(indexed.uid) || !HASH32.test(indexed.txid)) throw new Error(`EAS index returned a malformed uid/txid (${indexed.uid}, ${indexed.txid})`);
  let a: OnChainPassportAttestation;
  let calldata: string;
  try {
    a = await deps.reader.onChain(indexed.uid);
    calldata = await deps.reader.calldata(indexed.txid);
  } catch (e) {
    throw new StatementRefusal('HUMAN_PASSPORT_LOOKUP_FAILED', `Could not read Human Passport score ${indexed.uid} on Base: ${(e as Error).message}`);
  }
  const same = (x: string, y: string) => x.toLowerCase() === y.toLowerCase();
  if (!same(a.uid, indexed.uid) || !same(a.schema, HUMAN_PASSPORT_SCORE_SCHEMA) || !same(a.recipient, wallet) || !same(a.attester, GITCOIN_ATTESTER)) {
    throw new StatementRefusal('NO_HUMAN_PASSPORT_SCORE', `EAS on Base does not hold ${indexed.uid} as a Human Passport score for ${wallet}.`);
  }
  if (a.revocationTime !== 0n) throw new StatementRefusal('NO_HUMAN_PASSPORT_SCORE', `Human Passport score ${indexed.uid} was revoked at ${a.revocationTime}.`);
  if (a.expirationTime <= BigInt(now)) {
    throw new StatementRefusal('HUMAN_PASSPORT_SCORE_EXPIRED', `Human Passport score ${indexed.uid} expired at ${a.expirationTime}. Refresh it in Human Passport, then try again.`);
  }
  const issuance = issuanceFromCalldata({ calldata, txHash: indexed.txid, attestationUid: indexed.uid, wallet, attestationData: a.data }, deps.anchors);
  if (issuance.request.expirationTime <= BigInt(now)) {
    throw new StatementRefusal('HUMAN_PASSPORT_SCORE_EXPIRED', `The signed request behind ${indexed.uid} expired at ${issuance.request.expirationTime}.`);
  }
  if (issuance.score < minScoreUnits) {
    throw new StatementRefusal(
      'HUMAN_PASSPORT_SCORE_BELOW_THRESHOLD',
      `The wallet's Human Passport score is below the requested ${minScoreUnits / 10 ** HUMAN_PASSPORT_SCORE_DECIMALS}.`,
    );
  }
  log.info({ action: 'human_passport.issuance.found', attestationUid: indexed.uid, verifier: issuance.verifier, dataBytes: ethers.getBytes(a.data).length }, 'Human Passport issuance checked');
  return { issuance, minScoreUnits, now };
}
