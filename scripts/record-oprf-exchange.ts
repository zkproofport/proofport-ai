/**
 * Runs ONE real OPRF evaluation on the public test network with the SDK's own
 * client (packages/sdk/src/oprf) and records the exchange -- every CBOR frame
 * both ways, the request id and beta -- so tests/oprfTransport.test.ts can
 * replay the network's real answers offline.
 *
 *   npx tsx scripts/record-oprf-exchange.ts tests/fixtures/oprf-exchange.json
 *
 * Needs Node 22+ (global WebSocket) and network access. Sends only a random
 * address's BLINDED query; nothing about a real user leaves the machine.
 * Exits non-zero unless the recorded answer verifies (DLog proof, pinned key
 * hash) through finalizeOprf.
 */
import { writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { getOprfNetwork, getPinnedOprfKeyHash, reduceOprfName, oprfQuery, blindOprfQuery, randomOprfBeta, finalizeOprf } from '../packages/sdk/src/oprf/index.js';
import { runOprfExchange, type WebSocketLike } from '../packages/sdk/src/oprf/transport.js';
import { toHex32 } from '../packages/sdk/src/oprf/core/field.js';

const out = process.argv[2];
if (!out) {
  console.error('usage: npx tsx scripts/record-oprf-exchange.ts <out.json>');
  process.exit(1);
}
const WS = (globalThis as { WebSocket?: new (url: string) => WebSocketLike }).WebSocket;
if (!WS) {
  console.error('Node 22+ is required (global WebSocket).');
  process.exit(1);
}

const environment = 'staging' as const;
const circuitId = 'coinbase_attestation';
const network = getOprfNetwork(environment);
const address = '0x' + randomBytes(20).toString('hex');
const domainName = 'zkproofport.app';
const scopeName = 'sdk transport recording 한국어 🔐';
const domain = reduceOprfName(domainName);
const scope = reduceOprfName(scopeName);
const query = oprfQuery({ address, domain, scope });
const beta = randomOprfBeta();
const blinded = blindOprfQuery(query, beta);
const requestId = crypto.randomUUID().toLowerCase();
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

const frames: Record<string, { sent: string[]; received: string[]; closed?: { code: number; reason: string } }> = {};
const started = Date.now();
const exchange = await runOprfExchange({
  network,
  requestId,
  blindedQuery: { x: BigInt(blinded.x), y: BigInt(blinded.y) },
  webSocket: url => {
    const node = network.nodes.find(n => url.startsWith(n.replace(/^https:/, 'wss:')))!;
    const rec = (frames[node] = { sent: [], received: [] } as (typeof frames)[string]);
    const ws = new WS(url);
    const send = ws.send.bind(ws);
    ws.send = (data: Uint8Array) => { rec.sent.push(hex(data)); send(data); };
    const wrap = () => {
      const user = ws.onmessage;
      if (!user) return;
      ws.onmessage = ev => {
        if (ev.data instanceof ArrayBuffer) rec.received.push(hex(new Uint8Array(ev.data)));
        user(ev);
      };
    };
    // The client assigns onmessage synchronously after this returns.
    queueMicrotask(wrap);
    return ws;
  },
});
const elapsedMs = Date.now() - started;
const inputs = finalizeOprf({
  address, domain, scope, beta,
  publicKey: exchange.publicKey,
  blindedResponse: exchange.blindedResponse,
  dlogE: toHex32(exchange.dlogE),
  dlogS: toHex32(exchange.dlogS),
  expectedKeyHash: getPinnedOprfKeyHash(environment, circuitId),
});
writeFileSync(out, JSON.stringify({
  note: 'One real evaluation on the public OPRF test network (staging row of packages/sdk/src/oprf/networks.ts), recorded by scripts/record-oprf-exchange.ts with the SDK client. Frames are CBOR, hex. Replayed by tests/oprfTransport.test.ts.',
  recordedAt: new Date().toISOString().slice(0, 10),
  elapsedMs,
  environment, circuitId, address, domainName, scopeName, beta, requestId,
  blindedQuery: blinded,
  nodesUsed: exchange.nodesUsed,
  frames,
  result: inputs,
}, null, 2) + '\n');
console.log(`recorded ${out}: nodes ${exchange.nodesUsed.join(', ')}, ${elapsedMs} ms, nullifier ${inputs.nullifier}`);
