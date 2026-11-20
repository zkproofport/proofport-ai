/**
 * A threshold OPRF network in-process, for the SDK client's tests: n nodes
 * holding Shamir shares of one key, speaking the nodes' WebSocket protocol
 * (CBOR, two rounds) exactly as taceo-oprf-core 0.6.3's server side computes
 * it (DLogSessionShamir::partial_commitments / ::challenge). Each node can be
 * told to misbehave, so every refusal path of the client is reachable.
 *
 * The protocol math is checked independently by tests/oprfTransport.test.ts
 * replaying a real exchange with the public test network
 * (tests/fixtures/oprf-exchange.json).
 */
import { GENERATOR, scalarMul, type Point } from '../../packages/sdk/src/oprf/core/babyjubjub.js';
import { R, mod } from '../../packages/sdk/src/oprf/core/field.js';
import { cborDecode, cborEncode, type CborValue } from '../../packages/sdk/src/oprf/cbor.js';
import {
  challengeHash,
  combineNonces,
  compressPoint,
  decompressPoint,
  lagrangeAtZero,
  toLeScalarBytes,
} from '../../packages/sdk/src/oprf/shamir.js';
import type { WebSocketFactory, WebSocketLike } from '../../packages/sdk/src/oprf/transport.js';

export type NodeBehaviour =
  | 'ok'
  | 'down' // connection fails
  | 'silent' // opens, never answers
  | 'refuse' // closes with 4500 on the request
  | 'close-normal' // closes with 1000 before answering
  | 'bad-share' // round 2 share off by one
  | 'garbage' // round 1 answer is not CBOR
  | 'text' // round 1 answer is a text frame
  | 'off-curve' // commitment c is not a point
  | 'die-round-2'; // closes 1011 instead of the round-2 answer

export interface SimNode {
  url: string;
  partyId: number;
  epoch: number;
  behaviour: NodeBehaviour;
  /** Overrides the key this node reports and uses (another network's). */
  secretShare: bigint;
  publicKey: Point;
}

/** f(x) = secret + a1*x + ... over r; share for party id i is f(i + 1). */
export function shamirShares(secret: bigint, n: number, threshold: number, coeffs?: bigint[]): bigint[] {
  const cs = coeffs ?? Array.from({ length: threshold - 1 }, (_, i) => mod(BigInt(i + 7) * 1234567891011n, R));
  return Array.from({ length: n }, (_, i) => {
    const x = BigInt(i + 1);
    let acc = secret;
    let xp = 1n;
    for (const c of cs) {
      xp = (xp * x) % R;
      acc = mod(acc + c * xp, R);
    }
    return acc;
  });
}

export function simulatedNetwork(args: {
  secret: bigint;
  n?: number;
  threshold?: number;
  behaviours?: NodeBehaviour[];
  epochs?: number[];
  partyIds?: number[];
  /** Per node: report this public key instead of the network's. */
  publicKeys?: (Point | undefined)[];
  /** Deterministic nonces per node, so a run is reproducible. */
  nonceSeed?: bigint;
}) {
  const n = args.n ?? 3;
  const threshold = args.threshold ?? 2;
  const shares = shamirShares(args.secret, n, threshold);
  const publicKey = scalarMul(GENERATOR, args.secret);
  const nodes: SimNode[] = Array.from({ length: n }, (_, i) => ({
    url: `wss://node${i}.sim.test`,
    partyId: args.partyIds?.[i] ?? i,
    epoch: args.epochs?.[i] ?? 0,
    behaviour: args.behaviours?.[i] ?? 'ok',
    secretShare: shares[i],
    publicKey: args.publicKeys?.[i] ?? publicKey,
  }));
  const log = { opened: [] as string[], requests: [] as Record<string, CborValue>[], closedByClient: [] as string[] };
  let nonce = args.nonceSeed ?? 99n;

  const factory: WebSocketFactory = url => {
    const node = nodes.find(nd => url.startsWith(nd.url + '/'));
    if (!node) throw new Error(`simulated network has no node for ${url}`);
    return new SimSocket(node, url);
  };

  class SimSocket implements WebSocketLike {
    binaryType = 'blob';
    readyState = 0;
    onopen: ((ev: unknown) => void) | null = null;
    onmessage: ((ev: { data: unknown }) => void) | null = null;
    onerror: ((ev: unknown) => void) | null = null;
    onclose: ((ev: { code: number; reason: string }) => void) | null = null;
    private round = 0;
    private session: { d: bigint; e: bigint; a: Point; requestId: Uint8Array } | null = null;

    constructor(private readonly node: SimNode, readonly url: string) {
      setTimeout(() => {
        if (node.behaviour === 'down') {
          this.readyState = 3;
          this.onerror?.({});
          this.onclose?.({ code: 1006, reason: '' });
          return;
        }
        this.readyState = 1;
        log.opened.push(node.url);
        this.onopen?.({});
      }, 0);
    }

    private deliver(data: unknown) {
      setTimeout(() => this.onmessage?.({ data }), 0);
    }

    private closeWith(code: number, reason: string) {
      setTimeout(() => {
        this.readyState = 3;
        this.onclose?.({ code, reason });
      }, 0);
    }

    send(bytes: Uint8Array): void {
      const msg = cborDecode(bytes) as Record<string, CborValue>;
      const b = this.node.behaviour;
      if (this.round === 0) {
        this.round = 1;
        log.requests.push(msg);
        if (b === 'silent') return;
        if (b === 'refuse') return this.closeWith(4500, 'malformed request');
        if (b === 'close-normal') return this.closeWith(1000, '');
        if (b === 'garbage') return this.deliver(Uint8Array.of(0xff, 0x00).buffer);
        if (b === 'text') return this.deliver('hello');
        const a = decompressPoint(msg.blinded_query, 'blinded_query');
        const d = mod((nonce += 7919n) * 1000003n, R - 1n) + 1n;
        const e = mod((nonce += 7919n) * 1000033n, R - 1n) + 1n;
        this.session = { d, e, a, requestId: msg.request_id as Uint8Array };
        const c = scalarMul(a, this.node.secretShare);
        const cBytes = b === 'off-curve' ? Uint8Array.from({ length: 32 }, (_, i) => (i === 0 ? 2 : 0)) : compressPoint(c);
        this.deliver(cborEncode({
          commitments: {
            c: cBytes,
            d1: compressPoint(scalarMul(GENERATOR, d)),
            d2: compressPoint(scalarMul(a, d)),
            e1: compressPoint(scalarMul(GENERATOR, e)),
            e2: compressPoint(scalarMul(a, e)),
          },
          party_id: this.node.partyId,
          oprf_pub_key_with_epoch: { key: compressPoint(this.node.publicKey), epoch: this.node.epoch },
        }).buffer);
        return;
      }
      if (this.round === 1 && this.session) {
        this.round = 2;
        if (b === 'die-round-2') return this.closeWith(1011, 'internal error');
        const parties = msg.contributing_parties as number[];
        const combined = {
          c: decompressPoint(msg.c, 'c'),
          d1: decompressPoint(msg.d1, 'd1'),
          d2: decompressPoint(msg.d2, 'd2'),
          e1: decompressPoint(msg.e1, 'e1'),
          e2: decompressPoint(msg.e2, 'e2'),
          contributingParties: parties,
        };
        const { r1, r2, b: bScalar } = combineNonces(this.session.requestId, this.node.publicKey, combined);
        const ch = challengeHash(this.node.publicKey, this.session.a, combined.c, r1, r2) % R;
        const lambda = lagrangeAtZero(this.node.partyId + 1, parties);
        let share = mod(this.session.d + bScalar * this.session.e + lambda * ch * this.node.secretShare, R);
        if (b === 'bad-share') share = mod(share + 1n, R);
        this.deliver(cborEncode(toLeScalarBytes(share)).buffer);
      }
    }

    close(): void {
      log.closedByClient.push(this.node.url);
      this.readyState = 3;
    }
  }

  return {
    nodes,
    publicKey,
    factory,
    log,
    network: {
      nodes: nodes.map(nd => nd.url),
      threshold,
      module: 'sim',
      auth: { kind: 'api-key' as const, apiKey: 'sim-key' },
    },
  };
}
