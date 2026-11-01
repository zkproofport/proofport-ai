/**
 * human_passport_score: find the wallet's Human Passport scoreV2 issuance on
 * the chain the person recorded it on, and check it the way the circuit will,
 * BEFORE any payment.
 *
 * The circuit (circuits human-passport-score/src/main.nr) proves that a
 * scoreV2 attestation request signed (EIP-712) by Human Passport's issuer
 * names the signing wallet, scores it at least `min_score` by scorer
 * `scorer_id`, and has not expired at `now`. A person records their score on
 * the chain THEY choose (core HUMAN_PASSPORT_CHAINS), and the request names
 * it (`chain`). The signed request and the issuer's signature exist only in
 * the calldata of the transaction that submitted it to that chain's
 * GitcoinVerifier.verifyAndAttest, so:
 *
 *   1. that chain's attestation index names the wallet's newest unrevoked,
 *      unexpired scoreV2 attestation and the transaction that created it
 *      (EAS GraphQL; Shape, which has none, through its Blockscout logs);
 *   2. that chain's EAS contract confirms the record (Passport's attester,
 *      the chain's schema, recipient, unrevoked, unexpired, data);
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
  HUMAN_PASSPORT_CHAINS,
  HUMAN_PASSPORT_ISSUER,
  HUMAN_PASSPORT_ISSUER_LEAVES,
  HUMAN_PASSPORT_ISSUER_ROOT,
  HUMAN_PASSPORT_MAX_DATA_BYTES,
  HUMAN_PASSPORT_SCORE_DECIMALS,
  humanPassportScoreUnits,
  type HumanPassportChain,
} from '@zkproofport-app/core/circuits';
import { StatementRefusal } from './statementSigner.js';
import { computeWalletNullifier } from './inputBuilder.js';
import { createLogger } from '../logger.js';

const log = createLogger('HumanPassport');

export const HUMAN_PASSPORT_CIRCUIT_ID = 'human_passport_score';

/**
 * Where each chain's scores are read: its EAS contract, Passport's EAS
 * attester there, its attestation index and a public RPC (Base's comes from
 * BASE_RPC_URL). Keyed by chain id and exhaustive over core's
 * HUMAN_PASSPORT_CHAINS (tests/humanPassport.test.ts); an unknown id throws.
 * EAS and attester addresses: passportxyz/passport deployments/onchainInfo.json
 * (read 2026-10-31). Shape has no EAS indexer, so its Blockscout logs stand in.
 */
export interface HumanPassportSource {
  eas: string;
  attester: string;
  index: { kind: 'easscan'; url: string } | { kind: 'blockscout'; url: string };
  /** A public RPC, or 'BASE_RPC_URL' for the configured Base RPC. */
  rpc: string;
}

export const HUMAN_PASSPORT_SOURCES: Readonly<Record<number, HumanPassportSource>> = Object.freeze({
  8453: { eas: '0x4200000000000000000000000000000000000021', attester: '0xCc90105D4A2aa067ee768120AdA19886021dF422', index: { kind: 'easscan', url: 'https://base.easscan.org/graphql' }, rpc: 'BASE_RPC_URL' },
  10: { eas: '0x4200000000000000000000000000000000000021', attester: '0x843829986e895facd330486a61Ebee9E1f1adB1a', index: { kind: 'easscan', url: 'https://optimism.easscan.org/graphql' }, rpc: 'https://mainnet.optimism.io' },
  42161: { eas: '0xbD75f629A22Dc1ceD33dDA0b68c546A1c035c458', attester: '0x7848a3578Ff2E1F134659a23f64A404a4D710475', index: { kind: 'easscan', url: 'https://arbitrum.easscan.org/graphql' }, rpc: 'https://arb1.arbitrum.io/rpc' },
  59144: { eas: '0xaEF4103A04090071165F78D45D83A0C0782c2B2a', attester: '0xBC778313E52b1184A15D163b5d3a72AEF8d510A2', index: { kind: 'easscan', url: 'https://linea.easscan.org/graphql' }, rpc: 'https://rpc.linea.build' },
  534352: { eas: '0xC47300428b6AD2c7D03BB76D05A176058b47E6B0', attester: '0xCc90105D4A2aa067ee768120AdA19886021dF422', index: { kind: 'easscan', url: 'https://scroll.easscan.org/graphql' }, rpc: 'https://rpc.scroll.io' },
  360: { eas: '0x4200000000000000000000000000000000000021', attester: '0xCc90105D4A2aa067ee768120AdA19886021dF422', index: { kind: 'blockscout', url: 'https://shapescan.xyz/api' }, rpc: 'https://mainnet.shape.network' },
  324: { eas: '0x21d8d4eE83b80bc0Cc0f2B7df3117Cf212d02901', attester: '0x2B5D97CBE50eA9bf809CbE18A2003E4Cb4D283cC', index: { kind: 'easscan', url: 'https://zksync.easscan.org/graphql' }, rpc: 'https://mainnet.era.zksync.io' },
});

/** The source row for a chain, or an error naming the chains that exist. */
export function humanPassportSource(chainId: number): HumanPassportSource {
  const row = Object.prototype.hasOwnProperty.call(HUMAN_PASSPORT_SOURCES, chainId) ? HUMAN_PASSPORT_SOURCES[chainId] : undefined;
  if (!row) throw new Error(`No Human Passport score source for chain ${chainId}. Known: ${Object.keys(HUMAN_PASSPORT_SOURCES).join(', ')}.`);
  return row;
}
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
  /** The chain the score was recorded on. */
  chainId: number;
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
 * Production is core's (Human Passport's issuer under every chain's
 * GitcoinVerifiers); tests pass their own to build issuances a test key signs.
 */
export interface HumanPassportAnchors {
  issuer: string;
  leaves: readonly { chainId: number; verifier: string; domainSeparator: string; leaf: string }[];
  root: string;
  chains: Readonly<Record<number, HumanPassportChain>>;
}

export const HUMAN_PASSPORT_ANCHORS: HumanPassportAnchors = Object.freeze({
  issuer: HUMAN_PASSPORT_ISSUER,
  leaves: HUMAN_PASSPORT_ISSUER_LEAVES,
  root: HUMAN_PASSPORT_ISSUER_ROOT,
  chains: HUMAN_PASSPORT_CHAINS,
});

/** The chain row in `anchors`, or an INVALID_REQUEST naming the chains that exist. Never a default. */
export function anchorChain(anchors: HumanPassportAnchors, chainId: unknown): HumanPassportChain {
  const known = Object.keys(anchors.chains).join(', ');
  if (typeof chainId !== 'number' || !Number.isSafeInteger(chainId)) {
    throw new StatementRefusal('INVALID_REQUEST', `chain must be the chain id the score is recorded on; got ${JSON.stringify(chainId)}. Known: ${known}.`);
  }
  const row = Object.prototype.hasOwnProperty.call(anchors.chains, chainId) ? anchors.chains[chainId] : undefined;
  if (!row) throw new StatementRefusal('INVALID_REQUEST', `Human Passport records no scores on chain ${chainId}. Known: ${known}.`);
  return row;
}

/** Positional tree: leaves padded with bytes32(0) to a power of two, parent = keccak(left ++ right). */
export function issuerMerklePath(leaves: readonly string[], index: number): { root: string; proof: string[]; depth: number } {
  let level = leaves.slice();
  let size = 1;
  while (size < level.length) size *= 2;
  while (level.length < size) level.push(ethers.ZeroHash);
  const proof: string[] = [];
  let i = index;
  while (level.length > 1) {
    proof.push(level[i ^ 1]);
    const next: string[] = [];
    for (let k = 0; k < level.length; k += 2) next.push(ethers.keccak256(ethers.concat([level[k], level[k + 1]])));
    level = next;
    i >>= 1;
  }
  if (proof.length > 8) throw new Error(`issuer list too deep for the circuit: ${proof.length} > 8`);
  return { root: level[0], proof, depth: proof.length };
}

/**
 * The size and head checks the circuit makes on scoreV2 `data`, as refusals.
 * Returns the head.
 */
export function checkScoreData(data: string, attestationUid: string, chain: HumanPassportChain): ReturnType<typeof readScoreHead> {
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
  if (head.scorerId !== BigInt(chain.scorerId)) {
    throw new StatementRefusal('NO_HUMAN_PASSPORT_SCORE', `Attestation ${attestationUid} is from scorer ${head.scorerId}, not Human Passport's scorer ${chain.scorerId} on ${chain.name}.`);
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
  chainId: number;
}, anchors: HumanPassportAnchors = HUMAN_PASSPORT_ANCHORS): HumanPassportIssuance {
  const chain = anchorChain(anchors, input.chainId);
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
    if (request.schema.toLowerCase() !== chain.schema.toLowerCase()) {
      reasons.push(`call at byte ${call.offset}: schema ${request.schema} is not ${chain.name}'s scoreV2`);
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
      // Only this chain's verifiers: the domain names the chain, so a
      // signature for another chain does not recover to the issuer here.
      if (leaf.chainId !== chain.chainId) continue;
      const digest = passportDigest(leaf.domainSeparator, request);
      let pub: string;
      try {
        pub = ethers.SigningKey.recoverPublicKey(digest, sig);
      } catch {
        continue;
      }
      if (ethers.computeAddress(pub) !== ethers.getAddress(anchors.issuer)) continue;
      const head = checkScoreData(input.attestationData, input.attestationUid, chain);
      const path = issuerMerklePath(anchors.leaves.map(l => l.leaf), leafIndex);
      if (path.root !== anchors.root) throw new Error(`Issuer leaves give root ${path.root}, the anchors name ${anchors.root}`);
      const raw = ethers.getBytes(pub);
      return {
        chainId: chain.chainId,
        txHash: input.txHash,
        attestationUid: input.attestationUid,
        verifier: leaf.verifier,
        domainSeparator: leaf.domainSeparator,
        request,
        issuerSignature: ethers.concat([sig.r, sig.s]),
        issuerPubkeyX: ethers.hexlify(raw.slice(1, 33)),
        issuerPubkeyY: ethers.hexlify(raw.slice(33, 65)),
        merkleRoot: path.root,
        merkleProof: path.proof,
        leafIndex,
        merkleDepth: path.depth,
        score: Number(head.score),
        scorerId: Number(head.scorerId),
      };
    }
    reasons.push(`call at byte ${call.offset}: not signed by Human Passport's issuer under a ${chain.name} GitcoinVerifier`);
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
  /**
   * The wallet's newest scoreV2 attestation on `chain` that is unrevoked and
   * unexpired at `nowSeconds`, or null when there is none.
   */
  latest(chain: HumanPassportChain, wallet: string, nowSeconds: number): Promise<IndexedPassportAttestation | null>;
  onChain(chain: HumanPassportChain, uid: string): Promise<OnChainPassportAttestation>;
  /** The transaction's calldata on `chain`. */
  calldata(chain: HumanPassportChain, txHash: string): Promise<string>;
}

const EAS_ABI = ['function getAttestation(bytes32 uid) view returns ((bytes32 uid, bytes32 schema, uint64 time, uint64 expirationTime, uint64 revocationTime, bytes32 refUID, address recipient, address attester, bool revocable, bytes data))'];

/** keccak256("Attested(address,address,bytes32,bytes32)"): recipient, attester and schema indexed; uid in data. */
export const EAS_ATTESTED_TOPIC = '0x8bf46bf4cfd674fa735a3d63ec1c9ad4153f033c290341f3a588b75685141b35';

const LATEST_QUERY = `query HumanPassportScore($recipient: String!, $schemaId: String!, $now: Int!) {
  attestations(
    where: { recipient: { equals: $recipient }, schemaId: { equals: $schemaId }, revoked: { equals: false }, expirationTime: { gt: $now } }
    orderBy: { time: desc }
    take: 1
  ) { id txid }
}`;

/** How many of a wallet's newest Shape issuances are read on chain looking for a live one. */
const BLOCKSCOUT_CANDIDATES = 5;

/**
 * The reader the server uses: each chain's index and RPC from
 * HUMAN_PASSPORT_SOURCES, Base's RPC from BASE_RPC_URL.
 */
export function chainHumanPassportReader(baseRpcUrl: string, timeoutMs = 10_000): HumanPassportReader {
  if (!baseRpcUrl) throw new Error('BASE_RPC_URL is required to read a Human Passport score on Base');
  const providers = new Map<number, ethers.JsonRpcProvider>();
  const provider = (chainId: number) => {
    let p = providers.get(chainId);
    if (!p) {
      const source = humanPassportSource(chainId);
      p = new ethers.JsonRpcProvider(source.rpc === 'BASE_RPC_URL' ? baseRpcUrl : source.rpc, chainId, { staticNetwork: true });
      providers.set(chainId, p);
    }
    return p;
  };
  const onChain = async (chain: HumanPassportChain, uid: string): Promise<OnChainPassportAttestation> => {
    const eas = new ethers.Contract(humanPassportSource(chain.chainId).eas, EAS_ABI, provider(chain.chainId));
    const a = await eas.getAttestation(uid);
    return {
      uid: a.uid, schema: a.schema, recipient: a.recipient, attester: a.attester,
      revocationTime: BigInt(a.revocationTime), expirationTime: BigInt(a.expirationTime), data: a.data,
    };
  };
  return {
    async latest(chain, wallet, nowSeconds) {
      const index = humanPassportSource(chain.chainId).index;
      if (index.kind === 'easscan') {
        const response = await fetch(index.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            query: LATEST_QUERY,
            // Checked 2026-10-30: easscan matches a recipient in either case.
            variables: { recipient: ethers.getAddress(wallet), schemaId: chain.schema, now: nowSeconds },
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok) throw new Error(`EAS GraphQL (${chain.name}) request failed: HTTP ${response.status}`);
        const body = await response.json() as { data?: { attestations?: { id: string; txid: string }[] }; errors?: { message: string }[] };
        if (body.errors?.length) throw new Error(`EAS GraphQL (${chain.name}) error: ${body.errors[0].message}`);
        const a = body.data?.attestations;
        if (!Array.isArray(a)) throw new Error(`EAS GraphQL (${chain.name}) answered without an attestations list`);
        return a.length ? { uid: a[0].id, txid: a[0].txid } : null;
      }
      // Blockscout: the Attested logs naming this wallet and schema, newest
      // first; the first one the EAS contract holds unrevoked and unexpired.
      const source = humanPassportSource(chain.chainId);
      const url = new URL(index.url);
      const params: Record<string, string> = {
        module: 'logs', action: 'getLogs', fromBlock: '0', toBlock: 'latest', address: source.eas,
        topic0: EAS_ATTESTED_TOPIC, topic1: ethers.zeroPadValue(ethers.getAddress(wallet), 32).toLowerCase(), topic3: chain.schema.toLowerCase(),
        topic0_1_opr: 'and', topic0_3_opr: 'and', topic1_3_opr: 'and',
      };
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
      const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) throw new Error(`Blockscout (${chain.name}) request failed: HTTP ${response.status}`);
      const body = await response.json() as { status?: string; message?: string; result?: unknown };
      if (!Array.isArray(body.result)) {
        // Blockscout answers status "0" / "No logs found" with an empty or non-array result.
        if (body.status === '0' && /no (records|logs) found/i.test(String(body.message))) return null;
        throw new Error(`Blockscout (${chain.name}) answered without a log list: ${String(body.message)}`);
      }
      const logs = (body.result as { transactionHash: string; data: string; blockNumber: string; logIndex: string }[])
        .slice()
        .sort((a, b) => Number(BigInt(b.blockNumber) - BigInt(a.blockNumber)) || Number(BigInt(b.logIndex || '0') - BigInt(a.logIndex || '0')));
      for (const log of logs.slice(0, BLOCKSCOUT_CANDIDATES)) {
        const uid = ethers.dataSlice(log.data, 0, 32);
        const a = await onChain(chain, uid);
        if (a.revocationTime === 0n && a.expirationTime > BigInt(nowSeconds)) return { uid, txid: log.transactionHash };
      }
      return null;
    },
    onChain,
    async calldata(chain, txHash) {
      const tx = await provider(chain.chainId).getTransaction(txHash);
      if (!tx) throw new Error(`${chain.name} has no transaction ${txHash}`);
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
    /** The chain id the score is recorded on; required, never defaulted. */
    chain?: unknown;
    domain_separator?: unknown;
    action_hash?: unknown;
  },
  deps: { reader: HumanPassportReader; now?: () => number; anchors?: HumanPassportAnchors },
): Promise<HumanPassportPrepared> {
  const bad = (m: string) => new StatementRefusal('INVALID_REQUEST', m);
  const anchors = deps.anchors ?? HUMAN_PASSPORT_ANCHORS;
  // Which chain to read is the request's to say: a score lives only on the
  // chain its owner recorded it on, and guessing one reads as "no score".
  const chain = anchorChain(anchors, inputs.chain);
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
    indexed = await deps.reader.latest(chain, wallet, now);
  } catch (e) {
    throw new StatementRefusal('HUMAN_PASSPORT_LOOKUP_FAILED', `Could not look up a Human Passport score for ${wallet}: ${(e as Error).message}`);
  }
  if (!indexed) {
    throw new StatementRefusal(
      'NO_HUMAN_PASSPORT_SCORE',
      `${wallet} has no unexpired Human Passport score recorded on ${chain.name}. Record one there in Human Passport, or name the chain it is recorded on, then try again.`,
    );
  }
  if (!HASH32.test(indexed.uid) || !HASH32.test(indexed.txid)) throw new Error(`EAS index returned a malformed uid/txid (${indexed.uid}, ${indexed.txid})`);
  let a: OnChainPassportAttestation;
  let calldata: string;
  try {
    a = await deps.reader.onChain(chain, indexed.uid);
    calldata = await deps.reader.calldata(chain, indexed.txid);
  } catch (e) {
    throw new StatementRefusal('HUMAN_PASSPORT_LOOKUP_FAILED', `Could not read Human Passport score ${indexed.uid} on ${chain.name}: ${(e as Error).message}`);
  }
  const same = (x: string, y: string) => x.toLowerCase() === y.toLowerCase();
  if (!same(a.uid, indexed.uid) || !same(a.schema, chain.schema) || !same(a.recipient, wallet) || !same(a.attester, humanPassportSource(chain.chainId).attester)) {
    throw new StatementRefusal('NO_HUMAN_PASSPORT_SCORE', `EAS on ${chain.name} does not hold ${indexed.uid} as a Human Passport score for ${wallet}.`);
  }
  if (a.revocationTime !== 0n) throw new StatementRefusal('NO_HUMAN_PASSPORT_SCORE', `Human Passport score ${indexed.uid} was revoked at ${a.revocationTime}.`);
  if (a.expirationTime <= BigInt(now)) {
    throw new StatementRefusal('HUMAN_PASSPORT_SCORE_EXPIRED', `Human Passport score ${indexed.uid} expired at ${a.expirationTime}. Refresh it in Human Passport, then try again.`);
  }
  const issuance = issuanceFromCalldata({ calldata, txHash: indexed.txid, attestationUid: indexed.uid, wallet, attestationData: a.data, chainId: chain.chainId }, anchors);
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
