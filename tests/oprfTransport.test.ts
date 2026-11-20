/**
 * The OPRF client against nodes.
 *
 * 1. Replay: tests/fixtures/oprf-exchange.json is one real evaluation on the
 *    public test network (scripts/record-oprf-exchange.ts). Replaying its
 *    request id and blinded query, the client must send byte-identical frames
 *    and, from the network's real answers, produce the recorded proof -- which
 *    verifies under the pinned key hash. This is what proves the CBOR shapes,
 *    point compression, Lagrange combination, BLAKE3 nonce combiner and
 *    challenge hash match the network.
 * 2. A simulated threshold network (tests/helpers/oprfSimulatedNetwork.ts)
 *    for every failure: nodes down, silent, refusing, lying.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { runOprfExchange, OprfEvaluationError, type WebSocketLike } from '../packages/sdk/src/oprf/transport.js';
import { finalizeOprf, oprfQuery, blindOprfQuery, reduceOprfName, oprfKeyHash } from '@zkproofport-app/core/oprf';
import { toHex32 } from '../packages/sdk/src/oprf/core/field.js';
import { getPinnedOprfKeyHash, getOprfNetwork } from '../packages/sdk/src/oprf/index.js';
import { simulatedNetwork, type NodeBehaviour } from './helpers/oprfSimulatedNetwork.js';

const REC = createRequire(import.meta.url)('./fixtures/oprf-exchange.json');
const unhex = (h: string) => Uint8Array.from(Buffer.from(h, 'hex'));
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

function replayFactory() {
  const sent: Record<string, string[]> = {};
  const factory = (url: string): WebSocketLike => {
    const node = Object.keys(REC.frames).find(n => url.startsWith(n.replace(/^https:/, 'wss:') + '/'))!;
    const rec = REC.frames[node];
    sent[node] = [];
    const ws: WebSocketLike = {
      binaryType: 'blob', readyState: 0,
      onopen: null, onmessage: null, onerror: null, onclose: null,
      send(data: Uint8Array) {
        const i = sent[node].push(hex(data)) - 1;
        const answer = rec.received[i];
        if (answer !== undefined) setTimeout(() => ws.onmessage?.({ data: unhex(answer).buffer }), 0);
      },
      close() { /* nothing */ },
    };
    // A node the recording never reached does not open.
    if (rec.received.length) setTimeout(() => ws.onopen?.({}), 0);
    return ws;
  };
  return { factory, sent };
}

describe('replay of a real test-network evaluation', () => {
  it('sends byte-identical frames and reproduces the recorded, verifying answer', async () => {
    const network = getOprfNetwork(REC.environment);
    const { factory, sent } = replayFactory();
    const ex = await runOprfExchange({
      network,
      requestId: REC.requestId,
      blindedQuery: { x: BigInt(REC.blindedQuery.x), y: BigInt(REC.blindedQuery.y) },
      webSocket: factory,
    });
    for (const node of REC.nodesUsed) expect(sent[node]).toEqual(REC.frames[node].sent);
    expect(ex.nodesUsed).toEqual(REC.nodesUsed);
    const domain = reduceOprfName(REC.domainName);
    const scope = reduceOprfName(REC.scopeName);
    expect(blindOprfQuery(oprfQuery({ address: REC.address, domain, scope }), REC.beta)).toEqual(REC.blindedQuery);
    const out = finalizeOprf({
      address: REC.address, domain, scope, beta: REC.beta,
      publicKey: ex.publicKey, blindedResponse: ex.blindedResponse,
      dlogE: toHex32(ex.dlogE), dlogS: toHex32(ex.dlogS),
      expectedKeyHash: getPinnedOprfKeyHash('staging', REC.circuitId),
    });
    expect(out).toEqual(REC.result);
  });

  it('a one-bit change in the network\'s round-2 share makes the DLog proof fail', async () => {
    const network = getOprfNetwork(REC.environment);
    const node = REC.nodesUsed[0];
    const original = REC.frames[node].received[1];
    const bytes = unhex(original);
    bytes[bytes.length - 32] ^= 1; // low byte of the 32-byte share
    REC.frames[node].received[1] = hex(bytes);
    try {
      const { factory } = replayFactory();
      const ex = await runOprfExchange({
        network, requestId: REC.requestId,
        blindedQuery: { x: BigInt(REC.blindedQuery.x), y: BigInt(REC.blindedQuery.y) }, webSocket: factory,
      });
      const domain = reduceOprfName(REC.domainName);
      const scope = reduceOprfName(REC.scopeName);
      expect(() => finalizeOprf({
        address: REC.address, domain, scope, beta: REC.beta, publicKey: ex.publicKey, blindedResponse: ex.blindedResponse,
        dlogE: toHex32(ex.dlogE), dlogS: toHex32(ex.dlogS),
      })).toThrow(/Chaum-Pedersen proof does not verify/);
    } finally {
      REC.frames[node].received[1] = original;
    }
  });
});

const SECRET = 0x1234567890abcdefn;
const ADDRESS = '0x00000000000000000000000000000000000000aa';
const DOMAIN = reduceOprfName('sim.example');
const SCOPE = reduceOprfName('sim scope');
const BETA = '0x' + (98765n).toString(16).padStart(64, '0');

async function evaluate(behaviours: NodeBehaviour[], extra: Partial<Parameters<typeof simulatedNetwork>[0]> = {}, timeoutMs = 200) {
  const sim = simulatedNetwork({ secret: SECRET, behaviours, ...extra });
  const query = oprfQuery({ address: ADDRESS, domain: DOMAIN, scope: SCOPE });
  const a = blindOprfQuery(query, BETA);
  const ex = await runOprfExchange({
    network: sim.network,
    requestId: '0f0e0d0c-0b0a-4908-8706-050403020100',
    blindedQuery: { x: BigInt(a.x), y: BigInt(a.y) },
    webSocket: sim.factory,
    timeoutMs,
  });
  const out = finalizeOprf({
    address: ADDRESS, domain: DOMAIN, scope: SCOPE, beta: BETA,
    publicKey: ex.publicKey, blindedResponse: ex.blindedResponse,
    dlogE: toHex32(ex.dlogE), dlogS: toHex32(ex.dlogS),
    expectedKeyHash: oprfKeyHash(sim.publicKey),
  });
  return { sim, ex, out };
}

describe('simulated threshold network', () => {
  it('all three up: uses two, verifies, and closes every socket', async () => {
    const { sim, ex, out } = await evaluate(['ok', 'ok', 'ok']);
    expect(ex.nodesUsed).toHaveLength(2);
    expect(out.oprf_key_hash).toBe(oprfKeyHash(sim.publicKey));
    expect(new Set(sim.log.closedByClient)).toEqual(new Set(sim.nodes.map(n => n.url)));
    // The request carried the API key and the blinded point, nothing else.
    expect(Object.keys(sim.log.requests[0]).sort()).toEqual(['auth', 'blinded_query', 'request_id']);
    expect(sim.log.requests[0].auth).toEqual({ api_key: 'sim-key' });
  });

  it('the nullifier does not depend on which two nodes answered', async () => {
    const a = await evaluate(['ok', 'ok', 'down']);
    const b = await evaluate(['down', 'ok', 'ok']);
    const c = await evaluate(['ok', 'down', 'ok']);
    expect(a.out.nullifier).toBe(b.out.nullifier);
    expect(b.out.nullifier).toBe(c.out.nullifier);
  });

  it.each<[string, NodeBehaviour[]]>([
    ['one node down', ['down', 'ok', 'ok']],
    ['one node silent (times out)', ['silent', 'ok', 'ok']],
    ['one node refuses', ['ok', 'refuse', 'ok']],
    ['one node sends garbage', ['garbage', 'ok', 'ok']],
    ['one node sends a text frame', ['ok', 'ok', 'text']],
    ['one node sends an off-curve commitment', ['off-curve', 'ok', 'ok']],
  ])('%s: the other two still answer', async (_l, behaviours) => {
    const { ex } = await evaluate(behaviours);
    expect(ex.nodesUsed).toHaveLength(2);
  });

  it.each<[string, NodeBehaviour[], RegExp]>([
    ['two down', ['down', 'down', 'ok'], /node0\.sim\.test: connection failed.*node1\.sim\.test: connection failed/],
    ['all down', ['down', 'down', 'down'], /Fewer than 2 of 3/],
    ['two time out', ['silent', 'ok', 'silent'], /did not answer within 200 ms/],
    ['two refuse with an auth code', ['refuse', 'refuse', 'ok'], /refused the request \(code 4500: malformed request\)/],
    ['two close normally before answering', ['close-normal', 'close-normal', 'ok'], /closed the connection before answering/],
    ['two send unreadable messages', ['garbage', 'text', 'ok'], /cannot be read/],
  ])('%s: refused, naming each node', async (_l, behaviours, re) => {
    const err = await evaluate(behaviours).catch(e => e);
    expect(err).toBeInstanceOf(OprfEvaluationError);
    expect(err.message).toMatch(re);
  });

  it('a node failing in round 2 fails the evaluation, naming it', async () => {
    const err = await evaluate(['die-round-2', 'ok', 'down']).catch(e => e);
    expect(err).toBeInstanceOf(OprfEvaluationError);
    expect(err.message).toMatch(/node0\.sim\.test: refused the request \(code 1011/);
  });

  it('a wrong proof share: the combined DLog proof does not verify', async () => {
    await expect(evaluate(['bad-share', 'ok', 'down'])).rejects.toThrow(/Chaum-Pedersen proof does not verify/);
  });

  it('nodes reporting different public keys are refused', async () => {
    const other = simulatedNetwork({ secret: 777n }).publicKey;
    await expect(evaluate(['ok', 'ok', 'down'], { publicKeys: [undefined, other] })).rejects.toThrow(/different public keys/);
  });

  it('a whole network under another key: the pinned key hash refuses it', async () => {
    const sim = simulatedNetwork({ secret: 4242n });
    const query = oprfQuery({ address: ADDRESS, domain: DOMAIN, scope: SCOPE });
    const a = blindOprfQuery(query, BETA);
    const ex = await runOprfExchange({
      network: sim.network, requestId: '0f0e0d0c-0b0a-4908-8706-050403020100',
      blindedQuery: { x: BigInt(a.x), y: BigInt(a.y) }, webSocket: sim.factory, timeoutMs: 200,
    });
    expect(() => finalizeOprf({
      address: ADDRESS, domain: DOMAIN, scope: SCOPE, beta: BETA, publicKey: ex.publicKey, blindedResponse: ex.blindedResponse,
      dlogE: toHex32(ex.dlogE), dlogS: toHex32(ex.dlogS),
      expectedKeyHash: getPinnedOprfKeyHash('staging', 'coinbase_attestation'),
    })).toThrow(/not the pinned/);
  });

  it('two nodes with the same party id: the second is not combined', async () => {
    const err = await evaluate(['ok', 'ok', 'down'], { partyIds: [0, 0, 2] }).catch(e => e);
    expect(err).toBeInstanceOf(OprfEvaluationError);
    expect(err.message).toMatch(/party id 0, which another node already used/);
  });

  it('epochs differ: the two nodes that agree are used', async () => {
    const { ex } = await evaluate(['ok', 'ok', 'ok'], { epochs: [1, 2, 2] });
    expect(ex.epoch).toBe(2);
    expect(ex.nodesUsed).toEqual(['wss://node1.sim.test', 'wss://node2.sim.test']);
  });

  it('no two nodes agree on an epoch: refused', async () => {
    await expect(evaluate(['ok', 'ok', 'ok'], { epochs: [1, 2, 3] })).rejects.toThrow(OprfEvaluationError);
  });

  it.each([
    ['threshold 0', { threshold: 0 }, /threshold 0 does not fit/],
    ['threshold above node count', { threshold: 4 }, /threshold 4 does not fit/],
  ])('%s is refused before connecting', async (_l, patch, re) => {
    const sim = simulatedNetwork({ secret: SECRET });
    await expect(runOprfExchange({
      network: { ...sim.network, ...patch }, requestId: '0f0e0d0c-0b0a-4908-8706-050403020100',
      blindedQuery: { x: 0n, y: 1n }, webSocket: sim.factory,
    })).rejects.toThrow(re);
    expect(sim.log.opened).toEqual([]);
  });

  it('duplicate nodes, a request-proof network, a bad request id and a plain-http node are refused before connecting', async () => {
    const sim = simulatedNetwork({ secret: SECRET });
    const q = { x: 0n, y: 1n };
    const base = { requestId: '0f0e0d0c-0b0a-4908-8706-050403020100', blindedQuery: q, webSocket: sim.factory };
    await expect(runOprfExchange({ ...base, network: { ...sim.network, nodes: [sim.network.nodes[0], sim.network.nodes[0]] } })).rejects.toThrow(/unique/);
    await expect(runOprfExchange({ ...base, network: { ...sim.network, auth: { kind: 'request-proof', version: 'request-auth-v1' } } })).rejects.toThrow(/not supported/);
    await expect(runOprfExchange({ ...base, network: sim.network, requestId: 'NOT-A-UUID' })).rejects.toThrow(/lowercase UUID/);
    await expect(runOprfExchange({ ...base, network: { ...sim.network, nodes: ['http://a.test', 'http://b.test'] } })).rejects.toThrow(/https:\/\/ or wss:\/\//);
    expect(sim.log.opened).toEqual([]);
  });
});
