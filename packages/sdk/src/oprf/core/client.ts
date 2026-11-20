// MIRROR of proofport-app-sdk/packages/core/src/oprf/client.ts (scripts/sync-oprf-mirror.mjs). Do not edit here.
/**
 * The OPRF nullifier, client side: everything a prover (the mobile app, the
 * AI server's SDK) computes around one OPRF request, with no dependencies.
 *
 *   domain    = keccak256(utf8(domainName)) mod p     scope likewise
 *   query     = Poseidon2_t4(DS_QUERY, address, domain, scope)[1]
 *   A         = beta * encode_to_curve(query)          sent to the nodes
 *   B         = k * A, with a Chaum-Pedersen proof     the nodes' answer
 *   P         = B / beta                               unblinded here
 *   nullifier = Poseidon2_t4(DS_OUT, query, P.x, P.y)[1]
 *   key hash  = Poseidon2_t3(DS_KEY, D.x, D.y)[1],  D = k * G
 *
 * The request the wallet signs is EIP-712 typed data of readable strings,
 * `OprfRequest(string statement,string domainName,string scopeName,uint256 deadline)`
 * under domain ("TACEO:OPRF", "1"), statement "TACEO:OPRF Request", deadline
 * at most 600 s ahead; the node checks the names with the rules of
 * proofport-oprf `src/auth.rs` `check_name`, reduces them itself, and refuses
 * a client that reduced them any other way.
 *
 * Sources: circuits/oprf-nullifier-libs/README.md (construction),
 * proofport-oprf/REQUEST-VERIFIER.md and src/auth.rs (request and name rules),
 * TaceoLabs/oprf-nr v2.0.0 (encode_to_curve, Chaum-Pedersen). Held byte for
 * byte to those implementations by src/__tests__/fixtures/oprf-vectors.json
 * (scripts/generate-oprf-vectors.mjs).
 *
 * Not here: talking to the nodes (WebSocket, CBOR, two rounds, Shamir
 * combination of the nodes' proof shares). That is specified in
 * `.claude/agents/sdk-dev.md` in the parent repository, "OPRF client in core".
 */
import { GENERATOR, add, encodeToCurve, isIdentity, isInSubgroup, negate, scalarMul, type Point } from './babyjubjub.js';
import { P, R, asciiField, bytesToBigInt, invMod, mod, parseField, parseScalar, toHex32, bigIntToBytes32 } from './field.js';
import { bytesToHex, concatBytes, keccak256, utf8Bytes } from './keccak.js';
import { poseidon2T16, poseidon2T3, poseidon2T4 } from './poseidon2.js';

/** b"TACEO_OPRF_zkProofport_query" */
export const OPRF_DS_QUERY = asciiField('TACEO_OPRF_zkProofport_query');
/** b"TACEO_OPRF_zkProofport_out" */
export const OPRF_DS_OUT = asciiField('TACEO_OPRF_zkProofport_out');
/** b"TACEO_OPRF_bjj_key" */
export const OPRF_DS_KEY = asciiField('TACEO_OPRF_bjj_key');
/** b"DLOG Equality Proof" -- taceo-oprf-core's DLOG_DS. */
export const OPRF_DS_DLOG = asciiField('DLOG Equality Proof');

/** BN254 scalar field modulus: domain, scope, query, nullifier and key hash are below it. */
export const OPRF_FIELD_MODULUS = P;
/** BabyJubJub subgroup order: beta and s are below it. */
export const OPRF_SCALAR_ORDER = R;

/** Longest domainName / scopeName the node accepts, in UTF-8 bytes (auth.rs MAX_NAME_BYTES). */
export const OPRF_MAX_NAME_BYTES = 256;
/** Furthest ahead a request's deadline may lie (auth.rs MAX_VALIDITY_SECS). */
export const OPRF_MAX_VALIDITY_SECONDS = 600;

export const OPRF_EIP712_DOMAIN = Object.freeze({ name: 'TACEO:OPRF', version: '1' });
export const OPRF_REQUEST_STATEMENT = 'TACEO:OPRF Request';
export const OPRF_REQUEST_TYPES = Object.freeze({
  OprfRequest: Object.freeze([
    Object.freeze({ name: 'statement', type: 'string' }),
    Object.freeze({ name: 'domainName', type: 'string' }),
    Object.freeze({ name: 'scopeName', type: 'string' }),
    Object.freeze({ name: 'deadline', type: 'uint256' }),
  ]),
});

/**
 * Unicode general category Cf as inclusive code point ranges -- the table
 * proofport-oprf `src/auth.rs` FORMAT_CHARACTERS decides with (Unicode 16).
 * Kept as a table rather than `/\p{Cf}/u` so the verdict does not depend on
 * the JavaScript engine's Unicode version (Hermes, older Node); a test
 * compares it with this runtime's `\p{Cf}`.
 */
export const OPRF_FORMAT_CHARACTERS: readonly (readonly [number, number])[] = Object.freeze([
  [0x00ad, 0x00ad], [0x0600, 0x0605], [0x061c, 0x061c], [0x06dd, 0x06dd], [0x070f, 0x070f],
  [0x0890, 0x0891], [0x08e2, 0x08e2], [0x180e, 0x180e], [0x200b, 0x200f], [0x202a, 0x202e],
  [0x2060, 0x2064], [0x2066, 0x206f], [0xfeff, 0xfeff], [0xfff9, 0xfffb], [0x110bd, 0x110bd],
  [0x110cd, 0x110cd], [0x13430, 0x1343f], [0x1bca0, 0x1bca3], [0x1d173, 0x1d17a], [0xe0001, 0xe0001],
  [0xe0020, 0xe007f],
] as const);

export type OprfNameError = 'not-a-string' | 'not-utf8' | 'empty' | 'too-long' | 'control-character' | 'format-character';

/** Rust char::is_control: general category Cc. */
const isControl = (c: number): boolean => c <= 0x1f || (c >= 0x7f && c <= 0x9f);
const isFormat = (c: number): boolean => OPRF_FORMAT_CHARACTERS.some(([lo, hi]) => c >= lo && c <= hi);

/**
 * Why the OPRF node refuses this domainName / scopeName, or null when it
 * accepts it. The rules of `auth::check_name`, checked in its order: a
 * string, well-formed UTF-16 (a lone surrogate has no UTF-8 form), not empty,
 * at most 256 UTF-8 bytes, no Cc, no Cf. No trimming, no normalization: " "
 * is a name, and "é" and "é" are two names.
 */
export function oprfNameError(name: unknown): OprfNameError | null {
  if (typeof name !== 'string') return 'not-a-string';
  let bytes: Uint8Array;
  try {
    bytes = utf8Bytes(name);
  } catch {
    return 'not-utf8';
  }
  if (bytes.length === 0) return 'empty';
  if (bytes.length > OPRF_MAX_NAME_BYTES) return 'too-long';
  const codePoints = Array.from(name, ch => ch.codePointAt(0) as number);
  if (codePoints.some(isControl)) return 'control-character';
  if (codePoints.some(isFormat)) return 'format-character';
  return null;
}

function mustBeName(name: unknown, what: string): string {
  const why = oprfNameError(name);
  if (why !== null) throw new Error(`${what} is refused by the OPRF node's name rules: ${why}.`);
  return name as string;
}

/** keccak256(utf8(name)) mod p, as 0x + 64 hex. Throws for a name the node refuses. */
export function reduceOprfName(name: string): string {
  return toHex32(reduceName(mustBeName(name, 'name')));
}

function reduceName(name: string): bigint {
  return mod(bytesToBigInt(keccak256(utf8Bytes(name))));
}

/** Why the node refuses this deadline at `nowSeconds`, or null. */
export function oprfDeadlineError(deadline: unknown, nowSeconds: number): string | null {
  if (typeof deadline !== 'number' || !Number.isSafeInteger(deadline) || deadline < 0) {
    return `deadline must be a non-negative integer of unix seconds, got ${String(deadline)}.`;
  }
  if (!Number.isSafeInteger(nowSeconds) || nowSeconds < 0) return `now must be unix seconds, got ${nowSeconds}.`;
  if (deadline < nowSeconds) return `deadline ${deadline} has passed (now ${nowSeconds}).`;
  if (deadline > nowSeconds + OPRF_MAX_VALIDITY_SECONDS) {
    return `deadline ${deadline} is more than ${OPRF_MAX_VALIDITY_SECONDS} s ahead (now ${nowSeconds}).`;
  }
  return null;
}

export interface OprfRequestTypedData {
  domain: { name: string; version: string };
  types: typeof OPRF_REQUEST_TYPES;
  primaryType: 'OprfRequest';
  message: { statement: string; domainName: string; scopeName: string; deadline: number };
}

/**
 * The typed data the wallet signs for one OPRF request (ethers'
 * `signTypedData(domain, types, message)` shape; for `eth_signTypedData_v4`
 * see {@link oprfRequestEip712Json}). Checks the names and the deadline
 * against `nowSeconds` first, so a request the node would refuse is never
 * shown to the wallet.
 */
export function oprfRequestTypedData(args: {
  domainName: string;
  scopeName: string;
  deadline: number;
  nowSeconds: number;
}): OprfRequestTypedData {
  const domainName = mustBeName(args.domainName, 'domainName');
  const scopeName = mustBeName(args.scopeName, 'scopeName');
  const late = oprfDeadlineError(args.deadline, args.nowSeconds);
  if (late !== null) throw new Error(late);
  return {
    domain: { ...OPRF_EIP712_DOMAIN },
    types: OPRF_REQUEST_TYPES,
    primaryType: 'OprfRequest',
    message: { statement: OPRF_REQUEST_STATEMENT, domainName, scopeName, deadline: args.deadline },
  };
}

/** The same request as the JSON `eth_signTypedData_v4` takes (EIP712Domain included). */
export function oprfRequestEip712Json(typed: OprfRequestTypedData): string {
  return JSON.stringify({
    types: {
      EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }],
      OprfRequest: typed.types.OprfRequest,
    },
    primaryType: typed.primaryType,
    domain: typed.domain,
    message: typed.message,
  });
}

const kText = (s: string): Uint8Array => keccak256(utf8Bytes(s));

/**
 * keccak256(0x1901 || domainSeparator || hashStruct(OprfRequest)): what the
 * wallet signs and the request proof's first 32 public inputs. The deadline is
 * not checked against a clock here (the node does that); the names are.
 */
export function oprfRequestDigest(domainName: string, scopeName: string, deadline: number): string {
  mustBeName(domainName, 'domainName');
  mustBeName(scopeName, 'scopeName');
  if (!Number.isSafeInteger(deadline) || deadline < 0) throw new Error(`deadline must be a non-negative integer, got ${deadline}.`);
  const domainSeparator = keccak256(concatBytes(
    kText('EIP712Domain(string name,string version)'),
    kText(OPRF_EIP712_DOMAIN.name),
    kText(OPRF_EIP712_DOMAIN.version),
  ));
  const structHash = keccak256(concatBytes(
    kText('OprfRequest(string statement,string domainName,string scopeName,uint256 deadline)'),
    kText(OPRF_REQUEST_STATEMENT),
    kText(domainName),
    kText(scopeName),
    bigIntToBytes32(BigInt(deadline)),
  ));
  return bytesToHex(keccak256(concatBytes(Uint8Array.of(0x19, 0x01), domainSeparator, structHash)));
}

/** A wallet address (0x + 40 hex) as the query takes it: the 20 bytes big-endian. */
export function oprfAddressField(address: string): bigint {
  if (typeof address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
    throw new Error(`address must be 0x followed by 40 hex digits, got ${JSON.stringify(address)}.`);
  }
  const body = address.slice(2);
  if (body !== body.toLowerCase() && body !== body.toUpperCase()) {
    // Mixed case is an EIP-55 checksum; a wrong one is a mistyped address.
    const hash = bytesToHex(keccak256(utf8Bytes(body.toLowerCase()))).slice(2);
    for (let i = 0; i < 40; i++) {
      const upper = parseInt(hash[i], 16) >= 8;
      const ch = body[i];
      if (/[a-f]/.test(ch) && upper) throw new Error(`address ${address} fails its EIP-55 checksum.`);
      if (/[A-F]/.test(ch) && !upper) throw new Error(`address ${address} fails its EIP-55 checksum.`);
    }
  }
  return BigInt(address);
}

type FieldLike = bigint | number | string;
export interface PointLike {
  x: FieldLike;
  y: FieldLike;
}
export interface HexPoint {
  x: string;
  y: string;
}

const hexPoint = (p: Point): HexPoint => ({ x: toHex32(p.x), y: toHex32(p.y) });

function parsePoint(p: unknown, what: string): Point {
  if (!p || typeof p !== 'object') throw new Error(`${what} must be a point { x, y }.`);
  const q = p as { x?: unknown; y?: unknown };
  return { x: parseField(q.x, `${what}.x`), y: parseField(q.y, `${what}.y`) };
}

/** A point on the curve, in the prime-order subgroup, not the identity -- or an error naming which. */
function subgroupPoint(p: unknown, what: string): Point {
  const q = parsePoint(p, what);
  if (!isInSubgroup(q)) throw new Error(`${what} is not a point of BabyJubJub's prime-order subgroup.`);
  if (isIdentity(q)) throw new Error(`${what} is the identity.`);
  return q;
}

function query(address: bigint, domain: bigint, scope: bigint): bigint {
  return poseidon2T4([OPRF_DS_QUERY, address, domain, scope])[1];
}

/**
 * The OPRF query for a wallet in (domain, scope). `domain` / `scope` are the
 * FIELD values (keccak mod p, see {@link reduceOprfName}); below p, never
 * reduced here.
 */
export function oprfQuery(args: { address: string; domain: FieldLike; scope: FieldLike }): string {
  return toHex32(query(oprfAddressField(args.address), parseField(args.domain, 'domain'), parseField(args.scope, 'scope')));
}

/** A uniformly random non-zero blinding factor below r, from Web Crypto. No crypto -> throws, never a weaker source. */
export function randomOprfBeta(): string {
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  if (!c || typeof c.getRandomValues !== 'function') {
    throw new Error('No crypto.getRandomValues in this runtime; an OPRF blinding factor needs a secure random source.');
  }
  // 64 bytes reduced mod (r - 1): bias below 2^-250.
  const bytes = new Uint8Array(64);
  c.getRandomValues(bytes);
  return toHex32(mod(bytesToBigInt(bytes), R - 1n) + 1n);
}

function parseBeta(beta: unknown): bigint {
  const b = parseScalar(beta, 'beta');
  if (b === 0n) throw new Error('beta must not be zero.');
  return b;
}

/** A = beta * encode_to_curve(query): the point sent to the nodes. */
export function blindOprfQuery(queryValue: FieldLike, beta: FieldLike): HexPoint {
  return hexPoint(scalarMul(encodeToCurve(parseField(queryValue, 'query')), parseBeta(beta)));
}

/**
 * The nodes' Chaum-Pedersen proof that log_G(D) = log_A(B), checked exactly
 * as oprf-nr's verify_dlog_equality (and so as the circuit will): s below r,
 * none of D, A, B the identity, r1 = s*G - e*D and r2 = s*A - e*B not the
 * identity, e = Poseidon2_t16(DS_DLOG, D, A, B, G, r1, r2, 0, 0, 0)[1].
 * Returns false for a proof that does not verify; throws for malformed input.
 */
export function verifyOprfDlogEquality(args: {
  publicKey: PointLike;
  blindedQuery: PointLike;
  blindedResponse: PointLike;
  e: FieldLike;
  s: FieldLike;
}): boolean {
  const d = subgroupPoint(args.publicKey, 'publicKey');
  const a = subgroupPoint(args.blindedQuery, 'blindedQuery');
  const b = subgroupPoint(args.blindedResponse, 'blindedResponse');
  const e = parseField(args.e, 'e');
  const s = parseScalar(args.s, 's');
  const eScalar = e % R;
  const r1 = add(scalarMul(GENERATOR, s), negate(scalarMul(d, eScalar)));
  const r2 = add(scalarMul(a, s), negate(scalarMul(b, eScalar)));
  if (isIdentity(r1) || isIdentity(r2)) return false;
  const challenge = poseidon2T16([
    OPRF_DS_DLOG, d.x, d.y, a.x, a.y, b.x, b.y, GENERATOR.x, GENERATOR.y, r1.x, r1.y, r2.x, r2.y, 0n, 0n, 0n,
  ])[1];
  return challenge === e;
}

/** P = B / beta. B must be a subgroup point other than the identity. */
export function unblindOprfResponse(blindedResponse: PointLike, beta: FieldLike): HexPoint {
  const b = subgroupPoint(blindedResponse, 'blindedResponse');
  return hexPoint(scalarMul(b, invMod(parseBeta(beta), R)));
}

/** Poseidon2_t3(DS_KEY, D.x, D.y)[1]: what a circuit publishes as oprf_key_hash. */
export function oprfKeyHash(publicKey: PointLike): string {
  const d = subgroupPoint(publicKey, 'publicKey');
  return toHex32(poseidon2T3([OPRF_DS_KEY, d.x, d.y])[1]);
}

/** Poseidon2_t4(DS_OUT, query, P.x, P.y)[1] for the unblinded answer P. */
export function oprfNullifier(queryValue: FieldLike, response: PointLike): string {
  const p = subgroupPoint(response, 'response');
  return toHex32(poseidon2T4([OPRF_DS_OUT, parseField(queryValue, 'query'), p.x, p.y])[1]);
}

/** What a circuit takes from one OPRF evaluation, named as in its Prover.toml. */
export interface OprfCircuitInputs {
  /** Public, in this order where the circuit had scope and nullifier. */
  oprf_key_hash: string;
  domain: string;
  scope: string;
  nullifier: string;
  /** Private. */
  oprf_public_key_x: string;
  oprf_public_key_y: string;
  oprf_beta: string;
  oprf_dlog_e: string;
  oprf_dlog_s: string;
  oprf_response_x: string;
  oprf_response_y: string;
}

/**
 * Check the nodes' answer and turn it into the circuit's inputs.
 *
 * `expectedKeyHash` is the key hash the verifier will pin for this proof type
 * (core's `getPinnedOprfKeyHash`). Given, an answer under any other key is
 * refused here, before a proof the verifier would refuse is generated.
 * Throws, naming the problem, for anything the circuit would refuse.
 */
export function finalizeOprf(args: {
  address: string;
  domain: FieldLike;
  scope: FieldLike;
  beta: FieldLike;
  publicKey: PointLike;
  blindedResponse: PointLike;
  dlogE: FieldLike;
  dlogS: FieldLike;
  expectedKeyHash?: string;
}): OprfCircuitInputs {
  const domain = parseField(args.domain, 'domain');
  const scope = parseField(args.scope, 'scope');
  const beta = parseBeta(args.beta);
  const q = query(oprfAddressField(args.address), domain, scope);
  const keyHash = oprfKeyHash(args.publicKey);
  if (args.expectedKeyHash !== undefined && toHex32(parseField(args.expectedKeyHash, 'expectedKeyHash')) !== keyHash) {
    throw new Error(`The OPRF answer is under key hash ${keyHash}, not the pinned ${args.expectedKeyHash}.`);
  }
  const blindedQuery = scalarMul(encodeToCurve(q), beta);
  if (!verifyOprfDlogEquality({ publicKey: args.publicKey, blindedQuery, blindedResponse: args.blindedResponse, e: args.dlogE, s: args.dlogS })) {
    throw new Error('The OPRF nodes\' Chaum-Pedersen proof does not verify for this query and key.');
  }
  const pk = parsePoint(args.publicKey, 'publicKey');
  const response = unblindOprfResponse(args.blindedResponse, beta);
  return {
    oprf_key_hash: keyHash,
    domain: toHex32(domain),
    scope: toHex32(scope),
    nullifier: oprfNullifier(q, response),
    oprf_public_key_x: toHex32(pk.x),
    oprf_public_key_y: toHex32(pk.y),
    oprf_beta: toHex32(beta),
    oprf_dlog_e: toHex32(parseField(args.dlogE, 'dlogE')),
    oprf_dlog_s: toHex32(parseScalar(args.dlogS, 'dlogS')),
    oprf_response_x: response.x,
    oprf_response_y: response.y,
  };
}
