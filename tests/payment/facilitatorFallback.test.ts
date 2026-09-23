import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { settlePayment } from '../../src/payment/settle.js';
import { getPaymentNetwork } from '../../src/payment/networks.js';

const TX = `0x${'ab'.repeat(32)}`;
const nonce = `0x${'12'.repeat(32)}`;
const from = '0x1111111111111111111111111111111111111111';
const to = '0x2222222222222222222222222222222222222222';
const requirements = {
  scheme: 'exact', network: 'eip155:84532', amount: '1000',
  asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', payTo: to,
  maxTimeoutSeconds: 300, extra: { name: 'USDC', version: '2' },
};
const payload = {
  x402Version: 2, accepted: requirements,
  payload: {
    authorization: { from, to, value: '1000', validAfter: '0', validBefore: '9999999999', nonce },
    signature: `0x${'34'.repeat(65)}`,
  },
};
type Handler = (req: IncomingMessage, res: ServerResponse) => void;
let primary: Handler;
let backup: Handler;
let used: boolean;
let chain: string;
let rpcFailure: boolean;
let calls: Array<{ path: string; body: string }>;
let origin: string;
let server: ReturnType<typeof createServer>;
const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};
const success: Handler = (_req, res) => json(res, 200, { success: true, transaction: TX, network: 'eip155:84532', payer: from });
const outage: Handler = (_req, res) => json(res, 500, { error: 'EVM settle failed: transferWithAuthorization reverted' });

beforeEach(async () => {
  primary = outage; backup = success; used = false; chain = '0x14a34'; rpcFailure = false; calls = [];
  vi.stubEnv('X402_FACILITATOR_TIMEOUT_MS', '100');
  server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    calls.push({ path: req.url!, body });
    if (req.url === '/dexter/settle') return primary(req, res);
    if (req.url === '/payai/settle') return backup(req, res);
    if (req.url === '/rpc') {
      if (rpcFailure) return json(res, 503, { error: 'RPC unavailable' });
      const request = JSON.parse(body);
      const respond = (r: { id: number; method: string }) => {
        if (r.method === 'eth_chainId') return { jsonrpc: '2.0', id: r.id, result: chain };
        if (r.method === 'eth_call') return { jsonrpc: '2.0', id: r.id, result: `0x${(used ? '1' : '0').padStart(64, '0')}` };
        return { jsonrpc: '2.0', id: r.id, error: { code: -32601, message: r.method } };
      };
      return json(res, 200, Array.isArray(request) ? request.map(respond) : respond(request));
    }
    json(res, 404, {});
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  vi.unstubAllEnvs();
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});
function run(overrides: Record<string, unknown> = {}) {
  const network = {
    ...getPaymentNetwork('base-sepolia'), facilitatorUrl: `${origin}/dexter`,
    fallbackFacilitatorUrl: `${origin}/payai`, rpcEnv: 'TEST_FACILITATOR_RPC', defaultRpc: `${origin}/rpc`,
  };
  return settlePayment({ payload, requirements, network, networks: [network], ...overrides });
}
const settlements = () => calls.filter(call => call.path.endsWith('/settle'));

describe('Dexter to PayAI settlement failover', () => {
  it('uses only the primary when it succeeds', async () => {
    primary = success;
    await expect(run()).resolves.toMatchObject({ txHash: TX, facilitatorUrl: `${origin}/dexter` });
    expect(calls.map(call => call.path)).toEqual(['/dexter/settle']);
  });

  it('settles through the backup after HTTP 500 using the identical authorization and requirements', async () => {
    await expect(run()).resolves.toMatchObject({ txHash: TX, via: 'facilitator', facilitatorUrl: `${origin}/payai` });
    expect(settlements().map(call => call.path)).toEqual(['/dexter/settle', '/payai/settle']);
    expect(settlements()[1].body).toBe(settlements()[0].body);
    expect(JSON.parse(settlements()[1].body).paymentPayload.payload.authorization.nonce).toBe(nonce);
    const rpc = calls.filter(call => call.path === '/rpc').flatMap(call => JSON.parse(call.body));
    expect(rpc.find(r => r.method === 'eth_call').params[0].to.toLowerCase()).toBe(requirements.asset.toLowerCase());
  });

  it.each([429, 502, 503, 504])('uses the backup after HTTP %s', async status => {
    primary = (_req, res) => json(res, status, { error: 'temporarily unavailable' });
    await expect(run()).resolves.toMatchObject({ facilitatorUrl: `${origin}/payai` });
  });

  it('uses the backup when the primary connection closes without an answer', async () => {
    primary = req => req.socket.destroy();
    await expect(run()).resolves.toMatchObject({ facilitatorUrl: `${origin}/payai` });
  });

  it('bounds a primary timeout and preserves the original signature in the backup request', async () => {
    primary = () => {};
    await expect(run()).resolves.toMatchObject({ facilitatorUrl: `${origin}/payai` });
    expect(JSON.parse(settlements()[1].body).paymentPayload.payload.signature).toBe(payload.payload.signature);
  });

  it('also bounds a stalled response body', async () => {
    primary = (_req, res) => { res.writeHead(200); res.write('{'); };
    await expect(run()).resolves.toMatchObject({ facilitatorUrl: `${origin}/payai` });
  });

  it.each([
    [500, { error: 'ERC20: transfer amount exceeds balance' }],
    [200, { success: false, errorReason: 'invalid_exact_evm_payload_signature' }],
    [200, { success: false, errorReason: 'invalid_exact_evm_payload_authorization_valid_before' }],
    [400, { success: false, errorReason: 'invalid_payload' }],
  ])('does not retry a payment rejection (%s, %j)', async (status, body) => {
    primary = (_req, res) => json(res, status as number, body);
    await expect(run()).rejects.toThrow();
    expect(settlements().map(call => call.path)).toEqual(['/dexter/settle']);
  });

  it.each([
    { success: false, transaction: TX },
    { success: 'false', transaction: TX },
    { success: null, transaction: TX },
    { success: true, invalidReason: 'invalid_exact_evm_payload_signature', transaction: TX },
    { success: false, txHash: '', transaction: TX },
    { success: false, txHash: 'malformed', transaction: { hash: TX } },
  ])('stops on an ambiguous response with a transaction hash: %j', async body => {
    primary = (_req, res) => json(res, 200, body);
    await expect(run()).rejects.toMatchObject({ reason: 'settlement_unknown', txHash: TX });
    expect(settlements()).toHaveLength(1);
  });

  it('does not resubmit a known pending settlement to the backup', async () => {
    primary = (_req, res) => json(res, 200, { success: false, errorReason: 'settlement_pending', transaction: TX });
    await expect(run()).rejects.toThrow(/pending/i);
    expect(settlements()).toHaveLength(1);
  });

  it('stops when the authorization was consumed despite the failed HTTP response', async () => {
    used = true;
    await expect(run()).rejects.toThrow(/already.*used|already.*consumed|pending/i);
    expect(settlements()).toHaveLength(1);
  });

  it('does not resend when the settlement chain cannot be checked', async () => {
    rpcFailure = true;
    await expect(run()).rejects.toThrow(/state|RPC|check/i);
    expect(settlements()).toHaveLength(1);
  });

  it('does not use authorization state read from another chain', async () => {
    chain = '0x2105';
    await expect(run()).rejects.toThrow(/chain/i);
    expect(settlements()).toHaveLength(1);
  });

  it('does not automatically retry payloads without EIP-3009 replay protection', async () => {
    await expect(run({ payload: { ...payload, payload: { permit2Authorization: {} } } })).rejects.toThrow(/EIP-3009|authorization/i);
    expect(settlements()).toHaveLength(1);
  });

  it('reports both provider failures after a bounded single attempt at each', async () => {
    backup = outage;
    await expect(run()).rejects.toThrow(/dexter.*payai/s);
    expect(settlements()).toHaveLength(2);
  });

  it('reports unknown outcome if the final provider loses its response too', async () => {
    backup = req => req.socket.destroy();
    await expect(run()).rejects.toMatchObject({ reason: 'settlement_unknown' });
    expect(settlements()).toHaveLength(2);
  });

  it('reports an unknown outcome if the primary landed while the backup was being submitted', async () => {
    backup = (_req, res) => json(res, 500, { error: 'FiatTokenV2: authorization is used or canceled' });
    await expect(run()).rejects.toMatchObject({ reason: 'settlement_unknown' });
    expect(settlements()).toHaveLength(2);
  });

  it('does not expose a provider-echoed signature as an error reason', async () => {
    primary = (_req, res) => json(res, 400, { errorReason: payload.payload.signature });
    let error: unknown;
    try { await run(); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain(payload.payload.signature);
  });
});
