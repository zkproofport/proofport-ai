/**
 * One distributed OPRF evaluation over the nodes' WebSocket API, as
 * taceo-oprf-client 0.10.8 runs it (`distributed_oprf_core`, `sessions.rs`,
 * `ws/native.rs`):
 *
 *   per node   wss://<host>/api/<module>/oprf?version=<client>&request_id=<uuid>
 *   round 1    send OprfRequest { request_id, blinded_query, auth }      (CBOR)
 *              each node answers OprfResponse { commitments, party_id, oprf_pub_key_with_epoch }
 *              the first `threshold` answers of one epoch with distinct party ids are used
 *   round 2    send the combined commitments to exactly those nodes
 *              each answers its proof share
 *
 * A node refusing closes with a code (4xxx; 4500-4999 from the auth module)
 * and a reason. The evaluation fails once fewer than `threshold` nodes can
 * still answer, naming every node's failure. Messages are ciborium CBOR:
 * structs are maps keyed by field name, points and scalars byte strings, the
 * request id 16 bytes.
 *
 * WebSocket: the platform's global WebSocket (Node 22+, browsers), or the
 * implementation the caller passes. Without either this throws rather than
 * picking a transport.
 */
import { cborDecode, cborEncode, type CborValue } from './cbor.js';
import {
  combineCommitments,
  combineProofs,
  compressPoint,
  decodeScalar,
  decompressPoint,
  type CombinedCommitments,
  type PartialCommitments,
} from './shamir.js';
import type { Point } from './core/babyjubjub.js';
import type { OprfNetwork } from './networks.js';

/** The client protocol version the nodes are asked with (taceo-oprf-client, as the reference client sends it). */
export const OPRF_CLIENT_VERSION = '0.10.8';

/** The subset of the WHATWG WebSocket this client uses. */
export interface WebSocketLike {
  binaryType: string;
  readyState: number;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  send(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

export function defaultWebSocketFactory(): WebSocketFactory {
  const WS = (globalThis as { WebSocket?: new (url: string) => WebSocketLike }).WebSocket;
  if (typeof WS !== 'function') {
    throw new Error(
      'The OPRF step needs a global WebSocket, which Node.js has from version 22 ' +
        '(@zkproofport-ai/sdk and @zkproofport-ai/mcp require Node.js >= 22.0.0). ' +
        `This runtime has none${typeof process !== 'undefined' && process.versions?.node ? ` (Node.js ${process.versions.node})` : ''}. ` +
        'Upgrade Node.js, or pass a WebSocket implementation as `webSocket`. There is no fallback transport.',
    );
  }
  return url => new WS(url);
}

export class OprfNodeError extends Error {
  constructor(
    readonly node: string,
    readonly kind: 'refused' | 'network' | 'timeout' | 'protocol',
    message: string,
    readonly code?: number,
  ) {
    super(`${node}: ${message}`);
    this.name = 'OprfNodeError';
  }
}

export class OprfEvaluationError extends Error {
  constructor(message: string, readonly nodeErrors: readonly OprfNodeError[]) {
    super(nodeErrors.length ? `${message} ${nodeErrors.map(e => e.message).join('; ')}` : message);
    this.name = 'OprfEvaluationError';
  }
}

export interface OprfExchangeResult {
  publicKey: Point;
  epoch: number;
  combined: CombinedCommitments;
  /** The combined blinded response B = combined.c. */
  blindedResponse: Point;
  dlogE: bigint;
  dlogS: bigint;
  /** Which nodes' answers were combined, by URL, ascending party id. */
  nodesUsed: string[];
}

/** One node's socket as a queue of decoded messages. */
class Session {
  private readonly ws: WebSocketLike;
  private readonly queue: CborValue[] = [];
  private waiter: { resolve: (v: CborValue) => void; reject: (e: OprfNodeError) => void } | null = null;
  private failure: OprfNodeError | null = null;
  readonly opened: Promise<void>;

  constructor(readonly node: string, url: string, factory: WebSocketFactory) {
    this.ws = factory(url);
    this.ws.binaryType = 'arraybuffer';
    this.opened = new Promise((resolve, reject) => {
      this.ws.onopen = () => resolve();
      this.ws.onerror = () => {
        const e = new OprfNodeError(node, 'network', 'connection failed.');
        this.fail(e);
        reject(e);
      };
      this.ws.onclose = ev => {
        const e = ev.code === 1000 || ev.code === 1005
          ? new OprfNodeError(node, 'protocol', 'closed the connection before answering.')
          : new OprfNodeError(node, 'refused', `refused the request (code ${ev.code}${ev.reason ? `: ${ev.reason}` : ''}).`, ev.code);
        this.fail(e);
        reject(e);
      };
    });
    this.opened.catch(() => undefined);
    this.ws.onmessage = ev => {
      let value: CborValue;
      try {
        if (!(ev.data instanceof ArrayBuffer) && !(ev.data instanceof Uint8Array)) {
          throw new Error('sent a text frame');
        }
        value = cborDecode(ev.data instanceof ArrayBuffer ? new Uint8Array(ev.data) : ev.data);
      } catch (err) {
        this.fail(new OprfNodeError(node, 'protocol', `sent a message that cannot be read (${(err as Error).message}).`));
        return;
      }
      if (this.waiter) {
        const w = this.waiter;
        this.waiter = null;
        w.resolve(value);
      } else {
        this.queue.push(value);
      }
    };
  }

  private fail(e: OprfNodeError): void {
    if (this.failure) return;
    this.failure = e;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w.reject(e);
    }
  }

  send(value: CborValue): void {
    if (this.failure) throw this.failure;
    this.ws.send(cborEncode(value));
  }

  next(timeoutMs: number): Promise<CborValue> {
    if (this.queue.length) return Promise.resolve(this.queue.shift()!);
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        const e = new OprfNodeError(this.node, 'timeout', `did not answer within ${timeoutMs} ms.`);
        this.fail(e);
        reject(e);
      }, timeoutMs);
      this.waiter = {
        resolve: v => { clearTimeout(timer); resolve(v); },
        reject: e => { clearTimeout(timer); reject(e); },
      };
    });
  }

  close(): void {
    try {
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.onmessage = null;
      this.ws.close();
    } catch {
      // Closing an already-closed socket: nothing to do.
    }
  }
}

function field(obj: CborValue, key: string, node: string): CborValue {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj) || obj instanceof Uint8Array || !(key in obj)) {
    throw new OprfNodeError(node, 'protocol', `answer has no '${key}'.`);
  }
  return (obj as Record<string, CborValue>)[key];
}

function u(value: CborValue, max: number, what: string, node: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > max) {
    throw new OprfNodeError(node, 'protocol', `${what} is not an integer from 0 to ${max}.`);
  }
  return value;
}

function point(value: CborValue, what: string, node: string): Point {
  try {
    return decompressPoint(value, what);
  } catch (err) {
    throw new OprfNodeError(node, 'protocol', (err as Error).message);
  }
}

interface Round1 {
  session: Session;
  partyId: number;
  epoch: number;
  publicKey: Point;
  commitments: PartialCommitments;
}

function parseRound1(session: Session, msg: CborValue): Round1 {
  const node = session.node;
  const comm = field(msg, 'commitments', node);
  const keyWithEpoch = field(msg, 'oprf_pub_key_with_epoch', node);
  return {
    session,
    partyId: u(field(msg, 'party_id', node), 0xfffe, 'party_id', node),
    epoch: u(field(keyWithEpoch, 'epoch', node), 0xffffffff, 'epoch', node),
    publicKey: point(field(keyWithEpoch, 'key', node), 'OPRF public key', node),
    commitments: {
      c: point(field(comm, 'c', node), 'commitment c', node),
      d1: point(field(comm, 'd1', node), 'commitment d1', node),
      d2: point(field(comm, 'd2', node), 'commitment d2', node),
      e1: point(field(comm, 'e1', node), 'commitment e1', node),
      e2: point(field(comm, 'e2', node), 'commitment e2', node),
    },
  };
}

function uuidBytes(uuid: string): Uint8Array {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(uuid)) {
    throw new Error(`request id must be a lowercase UUID, got ${JSON.stringify(uuid)}.`);
  }
  const hex = uuid.replace(/-/g, '');
  return Uint8Array.from({ length: 16 }, (_, i) => parseInt(hex.slice(2 * i, 2 * i + 2), 16));
}

function socketUrl(node: string, module: string, requestId: string): string {
  const base = node.replace(/\/+$/, '');
  if (!/^https:\/\/[^/?#]+$/.test(base) && !/^wss?:\/\/[^/?#]+$/.test(base)) {
    throw new Error(`OPRF node must be an https:// or wss:// origin, got ${JSON.stringify(node)}.`);
  }
  const ws = base.replace(/^https:/, 'wss:');
  return `${ws}/api/${encodeURIComponent(module)}/oprf?version=${OPRF_CLIENT_VERSION}&request_id=${requestId}`;
}

/**
 * Run both rounds against `network` for one blinded query. Returns the
 * combined (unverified) proof; the caller verifies it with the query and key.
 *
 * `requestId` is a fresh UUID per evaluation (it seeds the nonce combiner);
 * the caller supplies it so a recorded exchange can be replayed.
 */
export async function runOprfExchange(args: {
  network: OprfNetwork;
  blindedQuery: Point;
  requestId: string;
  webSocket?: WebSocketFactory;
  /** Per round, per node. */
  timeoutMs?: number;
}): Promise<OprfExchangeResult> {
  const { network } = args;
  const timeoutMs = args.timeoutMs ?? 15_000;
  if (!Number.isInteger(network.threshold) || network.threshold < 1 || network.threshold > network.nodes.length) {
    throw new Error(`OPRF threshold ${network.threshold} does not fit ${network.nodes.length} nodes.`);
  }
  if (new Set(network.nodes).size !== network.nodes.length) throw new Error('OPRF nodes must be unique.');
  if (network.auth.kind !== 'api-key') {
    throw new Error(`OPRF auth kind '${network.auth.kind}' is not supported by this client.`);
  }
  const factory = args.webSocket ?? defaultWebSocketFactory();
  const requestIdBytes = uuidBytes(args.requestId);
  const request: CborValue = {
    request_id: requestIdBytes,
    blinded_query: compressPoint(args.blindedQuery),
    auth: { api_key: network.auth.apiKey },
  };

  const sessions = network.nodes.map(node => new Session(node, socketUrl(node, network.module, args.requestId), factory));
  const closeAll = () => sessions.forEach(s => s.close());

  try {
    // Round 1: first `threshold` answers of one epoch.
    const chosen = await new Promise<Round1[]>((resolve, reject) => {
      const byEpoch = new Map<number, Round1[]>();
      const errors: OprfNodeError[] = [];
      let settled = false;
      let pending = sessions.length;
      const done = () => {
        if (settled) return;
        if (sessions.length - errors.length < network.threshold || pending === 0) {
          settled = true;
          reject(new OprfEvaluationError(
            `Fewer than ${network.threshold} of ${sessions.length} OPRF nodes answered.`,
            errors,
          ));
        }
      };
      for (const s of sessions) {
        (async () => {
          await s.opened;
          s.send(request);
          return parseRound1(s, await s.next(timeoutMs));
        })().then(r => {
          pending--;
          if (settled) return;
          const group = byEpoch.get(r.epoch) ?? [];
          if (group.some(g => g.partyId === r.partyId)) {
            errors.push(new OprfNodeError(s.node, 'protocol', `answered with party id ${r.partyId}, which another node already used.`));
            done();
            return;
          }
          group.push(r);
          byEpoch.set(r.epoch, group);
          if (group.length === network.threshold) {
            settled = true;
            resolve(group.sort((a, b) => a.partyId - b.partyId));
          } else {
            done();
          }
        }, (err: unknown) => {
          pending--;
          errors.push(err instanceof OprfNodeError ? err : new OprfNodeError(s.node, 'protocol', (err as Error).message));
          done();
        });
      }
    });

    for (const s of sessions) if (!chosen.some(c => c.session === s)) s.close();
    const publicKey = chosen[0].publicKey;
    if (!chosen.every(c => c.publicKey.x === publicKey.x && c.publicKey.y === publicKey.y)) {
      throw new OprfEvaluationError('The OPRF nodes answered with different public keys.', []);
    }
    const combined = combineCommitments(chosen.map(c => c.commitments), chosen.map(c => c.partyId));

    // Round 2.
    const challenge: CborValue = {
      c: compressPoint(combined.c),
      d1: compressPoint(combined.d1),
      d2: compressPoint(combined.d2),
      e1: compressPoint(combined.e1),
      e2: compressPoint(combined.e2),
      contributing_parties: combined.contributingParties,
    };
    const settledShares = await Promise.allSettled(chosen.map(async c => {
      c.session.send(challenge);
      const msg = await c.session.next(timeoutMs);
      try {
        return decodeScalar(msg, 'proof share');
      } catch (err) {
        throw new OprfNodeError(c.session.node, 'protocol', (err as Error).message);
      }
    }));
    const failed = settledShares.flatMap(r => (r.status === 'rejected' ? [r.reason as OprfNodeError] : []));
    if (failed.length) throw new OprfEvaluationError('An OPRF node failed while finishing the evaluation.', failed);
    const shares = settledShares.map(r => (r as PromiseFulfilledResult<bigint>).value);
    const { e, s } = combineProofs({ requestId: requestIdBytes, shares, combined, publicKey, blindedQuery: args.blindedQuery });
    return {
      publicKey,
      epoch: chosen[0].epoch,
      combined,
      blindedResponse: combined.c,
      dlogE: e,
      dlogS: s,
      nodesUsed: chosen.map(c => c.session.node),
    };
  } finally {
    closeAll();
  }
}
