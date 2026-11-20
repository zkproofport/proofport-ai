/**
 * The OPRF nullifier, client side, for proofs this SDK sends to the proving
 * service.
 *
 * Where each step runs, and why (ai-dev.md "Proof Generation Flow": the SDK
 * prepares structured inputs, the server relays them, the prover proves):
 *
 *   name rules, name -> field, deadline       here (pure)
 *   blinding factor beta                      here, Web Crypto only
 *   query, blinding, both rounds with nodes   here: the wallet address and
 *     the (domain, scope) never leave this process except blinded
 *   DLog check, pinned key hash, unblinding,  here, before anything is paid:
 *     nullifier                               an answer under another key or
 *                                             with a bad proof is refused now
 *   the 11 circuit inputs                     sent with the other structured
 *                                             inputs (encrypted to the TEE in
 *                                             nitro mode). beta is a private
 *                                             input of the credential circuit,
 *                                             so the prover receives it like
 *                                             every other witness value.
 *   the wallet's EIP-712 OprfRequest           here, with the caller's signer
 *     signature (request-proof networks)      (signOprfRequest); the key never
 *                                             leaves the wallet
 *   the request-auth proof                    NOT AVAILABLE: the SDK never
 *                                             proves, and no proving service
 *                                             or network accepts it yet
 */
import type { ClientConfig } from '../types.js';
import type { ProofportSigner } from '../signer.js';
import {
  blindOprfQuery,
  finalizeOprf,
  oprfNameError,
  oprfQuery,
  oprfRequestDigest,
  oprfRequestTypedData,
  randomOprfBeta,
  reduceOprfName,
  type OprfCircuitInputs,
} from '@zkproofport-app/core/oprf';
import { getPinnedOprfKeyHash, isOprfEnvironment, OPRF_ENVIRONMENTS, type OprfEnvironment } from './keyHashes.js';
import { getOprfNetwork } from './networks.js';
import { runOprfExchange, type WebSocketFactory } from './transport.js';
import { toHex32, parseScalar } from './core/field.js';
import { scalarMul, isInSubgroup } from './core/babyjubjub.js';

function rescale(p: { x: bigint; y: bigint }, beta: string): { x: string; y: string } {
  if (!isInSubgroup(p)) throw new Error('OPRF input oprf_response is not a point of the prime-order subgroup.');
  const b = scalarMul(p, parseScalar(beta, 'oprf_beta'));
  return { x: toHex32(b.x), y: toHex32(b.y) };
}

export type { OprfCircuitInputs } from '@zkproofport-app/core/oprf';
export {
  oprfNameError,
  reduceOprfName,
  oprfRequestTypedData,
  oprfRequestDigest,
  oprfQuery,
  blindOprfQuery,
  verifyOprfDlogEquality,
  unblindOprfResponse,
  oprfKeyHash,
  oprfNullifier,
  finalizeOprf,
  randomOprfBeta,
  OPRF_MAX_NAME_BYTES,
  OPRF_MAX_VALIDITY_SECONDS,
} from '@zkproofport-app/core/oprf';
export {
  OPRF_ENVIRONMENTS,
  OPRF_CIRCUIT_IDS,
  OPRF_KEY_HASHES,
  getPinnedOprfKeyHash,
  isOprfEnvironment,
  isOprfCircuitId,
  type OprfEnvironment,
  type OprfCircuitId,
} from './keyHashes.js';
export { OPRF_NETWORKS, getOprfNetwork, type OprfNetwork, type OprfNetworkAuth } from './networks.js';
export { OprfEvaluationError, OprfNodeError, type WebSocketFactory, type WebSocketLike } from './transport.js';

/** The 11 values a wallet credential proof request carries (keys as the server and the circuit name them). */
export const OPRF_INPUT_KEYS = Object.freeze([
  'oprf_key_hash', 'domain', 'scope', 'nullifier',
  'oprf_public_key_x', 'oprf_public_key_y', 'oprf_beta', 'oprf_dlog_e', 'oprf_dlog_s', 'oprf_response_x', 'oprf_response_y',
] as const satisfies readonly (keyof OprfCircuitInputs)[]);

/**
 * Throws naming why the OPRF network would refuse this domain or scope name
 * (1..256 UTF-8 bytes, no control or format characters, no trimming).
 */
export function assertOprfName(name: unknown, what: 'domain' | 'scope'): string {
  const why = oprfNameError(name);
  if (why !== null) {
    const shown = typeof name === 'string' ? JSON.stringify(name) : name === null ? 'null' : typeof name;
    throw new Error(`${what} ${shown} cannot name an OPRF nullifier: ${why}. ` +
      `A ${what} is 1 to 256 UTF-8 bytes with no control or format characters.`);
  }
  return name as string;
}

/** IPv4 dotted quad, or anything with a ':' (IPv6, possibly bracketed). */
const IP_HOST = /^(\d{1,3}\.){3}\d{1,3}$|:|^\[/;

/**
 * The page's hostname, lowercased, when this code runs in a browser on a
 * real http(s) page; otherwise null. Never an IP address (a page served from
 * an IP names no service), never a file:, data: or extension origin, and
 * nothing at all on a server or in Node: there is no `window`/`document` there,
 * or `location` is not an http(s) page.
 */
export function browserOprfDomain(g: unknown = globalThis): string | null {
  const scope = g as { window?: unknown; document?: unknown; location?: { protocol?: unknown; hostname?: unknown } };
  if (!scope || scope.window !== g || typeof scope.document !== 'object' || scope.document === null) return null;
  const loc = scope.location;
  if (!loc || (loc.protocol !== 'http:' && loc.protocol !== 'https:')) return null;
  if (typeof loc.hostname !== 'string' || loc.hostname === '') return null;
  const host = loc.hostname.toLowerCase();
  if (IP_HOST.test(host)) return null;
  return host;
}

/**
 * The OPRF domain to use, like ZKPassport: the caller's, checked; when the
 * caller gave none AND this runs in a browser on an http(s) page, that page's
 * hostname (lowercased). Omitted anywhere else (a server, Node, the MCP) is an
 * error naming `oprfDomain` -- nothing is filled in.
 */
export function resolveOprfDomain(oprfDomain: unknown, g: unknown = globalThis): string {
  if (oprfDomain !== undefined) return assertOprfName(oprfDomain, 'domain');
  const host = browserOprfDomain(g);
  if (host === null) {
    throw new Error(
      'oprfDomain is required: name the service the proof is for (usually its host). ' +
        'It is filled in only in a browser, from the page\'s hostname; outside a browser nothing is filled in.',
    );
  }
  return assertOprfName(host, 'domain');
}

/**
 * The scope a wallet proof's nullifier is under: the caller's, required, with
 * the OPRF name rules. Never a default.
 */
export function requireOprfScope(scope: unknown): string {
  if (scope === undefined) {
    throw new Error('scope is required: name what the proof is for within the service (1 to 256 UTF-8 bytes). Nothing is filled in.');
  }
  return assertOprfName(scope, 'scope');
}

/**
 * The OPRF environment of the proving service at `config.baseUrl`
 * (GET /api/v1/oprf). Never a default: a service that does not say is an error.
 */
export async function fetchOprfEnvironment(config: ClientConfig): Promise<OprfEnvironment> {
  const url = `${config.baseUrl}/api/v1/oprf`;
  let res: Response;
  try {
    res = await fetch(url, { method: 'GET', headers: { accept: 'application/json' } });
  } catch (err) {
    throw new Error(`Could not reach ${url} to learn the service's OPRF environment: ${(err as Error).message}`);
  }
  const body = (await res.json().catch(() => null)) as { environment?: unknown; message?: unknown } | null;
  if (!res.ok) {
    const msg = body && typeof body.message === 'string' ? body.message : `HTTP ${res.status}`;
    throw new Error(`${url} did not name an OPRF environment: ${msg}`);
  }
  const env = body?.environment;
  if (!isOprfEnvironment(env)) {
    throw new Error(`${url} named OPRF environment ${JSON.stringify(env)}. Known: ${OPRF_ENVIRONMENTS.join(', ')}.`);
  }
  return env;
}

/**
 * Refuses, before anything is signed or paid, a request no OPRF network can
 * answer: an unknown environment, one with no network or no key (production
 * today), a circuit without an OPRF nullifier.
 */
export function assertOprfAvailable(environment: unknown, circuitId: unknown): void {
  getOprfNetwork(environment);
  getPinnedOprfKeyHash(environment, circuitId);
}

/**
 * Evaluate the OPRF for `address` in (domainName, scopeName) and return the
 * circuit's 11 inputs, checked: the nodes' combined DLog proof verifies for
 * this query, and the key is the one pinned for (environment, circuit).
 * A fresh beta and request id every call, from the platform's secure random
 * source.
 */
export async function evaluateOprf(args: {
  environment: OprfEnvironment;
  circuitId: string;
  address: string;
  domainName: string;
  scopeName: string;
  webSocket?: WebSocketFactory;
  timeoutMs?: number;
}): Promise<OprfCircuitInputs> {
  const network = getOprfNetwork(args.environment);
  const expectedKeyHash = getPinnedOprfKeyHash(args.environment, args.circuitId);
  if (network.auth.kind === 'request-proof') {
    throw new Error(
      `The '${args.environment}' OPRF network requires a request-auth proof, which this SDK cannot produce: ` +
        'the SDK never proves, and the proving service has no request-auth endpoint yet.',
    );
  }
  const domain = reduceOprfName(assertOprfName(args.domainName, 'domain'));
  const scope = reduceOprfName(assertOprfName(args.scopeName, 'scope'));
  const query = oprfQuery({ address: args.address, domain, scope });
  const beta = randomOprfBeta();
  const blinded = blindOprfQuery(query, beta);
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (!c?.randomUUID) throw new Error('No secure random source (crypto.randomUUID) for the OPRF request id.');
  const exchange = await runOprfExchange({
    network,
    blindedQuery: { x: BigInt(blinded.x), y: BigInt(blinded.y) },
    requestId: c.randomUUID().toLowerCase(),
    webSocket: args.webSocket,
    timeoutMs: args.timeoutMs,
  });
  return finalizeOprf({
    address: args.address,
    domain,
    scope,
    beta,
    publicKey: exchange.publicKey,
    blindedResponse: exchange.blindedResponse,
    dlogE: toHex32(exchange.dlogE),
    dlogS: toHex32(exchange.dlogS),
    expectedKeyHash,
  });
}

/**
 * The wallet's signature over the EIP-712 OprfRequest a request-proof network
 * checks (domain ("TACEO:OPRF", "1"), statement "TACEO:OPRF Request",
 * deadline at most 600 s ahead). Names and deadline are checked before the
 * wallet is asked; the signature must recover to `address`.
 *
 * Not used by evaluateOprf yet: no network row authorizes by request proof.
 */
export async function signOprfRequest(
  signer: ProofportSigner,
  args: { address: string; domainName: string; scopeName: string; deadline: number; nowSeconds: number },
  recover: (digest: string, signature: string) => string,
): Promise<{ signature: string; digest: string }> {
  const typed = oprfRequestTypedData({
    domainName: assertOprfName(args.domainName, 'domain'),
    scopeName: assertOprfName(args.scopeName, 'scope'),
    deadline: args.deadline,
    nowSeconds: args.nowSeconds,
  });
  const signature = await signer.signTypedData(
    typed.domain,
    { OprfRequest: typed.types.OprfRequest.map(f => ({ ...f })) },
    { ...typed.message },
  );
  const digest = oprfRequestDigest(args.domainName, args.scopeName, args.deadline);
  const signedBy = recover(digest, signature);
  if (signedBy.toLowerCase() !== args.address.toLowerCase()) {
    throw new Error(`The OPRF request was signed by ${signedBy}, not ${args.address}.`);
  }
  return { signature, digest };
}

/** One evaluation, with what it was for, as prepareInputs takes it. */
export interface PreparedOprf {
  environment: OprfEnvironment;
  circuitId: string;
  address: string;
  oprfDomain: string;
  scope: string;
  inputs: OprfCircuitInputs;
}

/**
 * Learn the service's OPRF environment, refuse what cannot be answered
 * (production today), and evaluate the OPRF for this wallet and names.
 */
export async function prepareOprf(
  config: ClientConfig,
  args: { circuitId: string; address: string; oprfDomain: unknown; scope: unknown; webSocket?: WebSocketFactory; timeoutMs?: number },
): Promise<PreparedOprf> {
  const oprfDomain = resolveOprfDomain(args.oprfDomain);
  const scope = requireOprfScope(args.scope);
  const environment = await fetchOprfEnvironment(config);
  assertOprfAvailable(environment, args.circuitId);
  const inputs = await evaluateOprf({
    environment,
    circuitId: args.circuitId,
    address: args.address,
    domainName: oprfDomain,
    scopeName: scope,
    webSocket: args.webSocket,
    timeoutMs: args.timeoutMs,
  });
  return { environment, circuitId: args.circuitId, address: args.address, oprfDomain, scope, inputs };
}

const HEX32 = /^0x[0-9a-f]{64}$/;

/**
 * The 11 circuit inputs of `prepared`, after checking they belong to this
 * circuit, wallet and scope and still verify: the answer is re-blinded with
 * its beta and run through finalizeOprf again (DLog proof, pinned key hash,
 * nullifier), and every value must come out identical.
 * @throws naming the first mismatch.
 */
export function checkPreparedOprf(prepared: unknown, expect: { circuitId: string; address: string; scope: string }): OprfCircuitInputs {
  if (!prepared || typeof prepared !== 'object') {
    throw new Error(`The OPRF values for ${expect.circuitId} are missing: call prepareOprf first.`);
  }
  const p = prepared as Partial<PreparedOprf>;
  if (p.circuitId !== expect.circuitId) throw new Error(`The OPRF values were made for ${String(p.circuitId)}, not ${expect.circuitId}.`);
  if (typeof p.address !== 'string' || p.address.toLowerCase() !== expect.address.toLowerCase()) {
    throw new Error(`The OPRF values were made for wallet ${String(p.address)}, not ${expect.address}.`);
  }
  if (p.scope !== expect.scope) throw new Error(`The OPRF values were made for scope ${JSON.stringify(p.scope)}, not ${JSON.stringify(expect.scope)}.`);
  const inputs = p.inputs as Record<string, unknown> | undefined;
  if (!inputs || typeof inputs !== 'object') throw new Error('The OPRF values carry no inputs.');
  for (const k of OPRF_INPUT_KEYS) {
    if (typeof inputs[k] !== 'string' || !HEX32.test(inputs[k] as string)) {
      throw new Error(`OPRF input ${k} must be 0x followed by 64 lowercase hex digits.`);
    }
  }
  const i = inputs as unknown as OprfCircuitInputs;
  const response = { x: BigInt(i.oprf_response_x), y: BigInt(i.oprf_response_y) };
  const reblinded = rescale(response, i.oprf_beta);
  const again = finalizeOprf({
    address: p.address,
    domain: reduceOprfName(assertOprfName(p.oprfDomain, 'domain')),
    scope: reduceOprfName(assertOprfName(p.scope, 'scope')),
    beta: i.oprf_beta,
    publicKey: { x: i.oprf_public_key_x, y: i.oprf_public_key_y },
    blindedResponse: reblinded,
    dlogE: i.oprf_dlog_e,
    dlogS: i.oprf_dlog_s,
    expectedKeyHash: getPinnedOprfKeyHash(p.environment, expect.circuitId),
  });
  for (const k of OPRF_INPUT_KEYS) {
    if (again[k] !== i[k]) throw new Error(`OPRF input ${k} does not match what the evaluation gives.`);
  }
  return again;
}
