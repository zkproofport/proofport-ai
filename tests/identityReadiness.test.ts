import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp, initializeIdentity } from '../src/index.js';
import { ensureAgentRegistered } from '../src/identity/autoRegister.js';
import type { Config } from '../src/config/index.js';

vi.mock('../src/tracing.js', () => ({}));
vi.mock('../src/redis/client.js', () => ({ createRedisClient: vi.fn(() => ({})) }));
vi.mock('../src/proof/proofRoutes.js', async () => {
  const { Router } = await import('express');
  return { createProofRoutes: () => Router() };
});
vi.mock('../src/identity/autoRegister.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/identity/autoRegister.js')>()),
  ensureAgentRegistered: vi.fn(),
}));

const config = {
  paymentMode: 'disabled', paymentNetworks: 'arc-testnet-nano', paymentProofPrice: '$0.1',
  teeMode: 'local', teeAttestationEnabled: false, a2aBaseUrl: 'https://proof.example.com',
  websiteUrl: 'https://example.com', chainRpcUrl: 'https://sepolia.base.org',
  erc8004IdentityAddress: '', arcRpcUrl: 'https://rpc.example.com', arcChainId: 5042002,
  arcIdentityAddress: '0x0000000000000000000000000000000000000011', arcAgentTokenId: '',
  proverPrivateKey: '0x' + '11'.repeat(32), agentVersion: '1.0.0', redisUrl: 'redis://example.invalid',
  circuitsDir: 'circuits', bbPath: 'bb',
} as Config;

describe('identity readiness HTTP integration', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('starts pending and returns 503 before registration completes', async () => {
    const bundle = createApp(config);
    const response = await request(bundle.app).get('/identity/status');
    expect(response.status).toBe(503);
    expect(response.body).toEqual({ status: 'pending', registrations: [] });
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('publishes verified registrations with lossless bigint strings', async () => {
    const bundle = createApp(config);
    vi.mocked(ensureAgentRegistered).mockResolvedValue(new Map([[5042002, 9007199254740993n]]));
    await initializeIdentity(config, bundle.tokenIdRef, bundle.identityState);
    const response = await request(bundle.app).get('/identity/status');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ready', registrations: [{ chainId: 5042002, agentId: '9007199254740993' }] });
    expect(bundle.tokenIdRef.chains.get(5042002)).toBe(9007199254740993n);
    expect(ensureAgentRegistered).toHaveBeenCalledWith(config, undefined);
  });

  it('remains pending until the asynchronous registration actually resolves', async () => {
    const bundle = createApp(config);
    let resolve!: (value: Map<number, bigint>) => void;
    vi.mocked(ensureAgentRegistered).mockReturnValue(new Promise(done => { resolve = done; }));
    const task = initializeIdentity(config, bundle.tokenIdRef, bundle.identityState);
    expect((await request(bundle.app).get('/identity/status')).status).toBe(503);
    resolve(new Map([[5042002, 0n]]));
    await task;
    expect((await request(bundle.app).get('/identity/status')).body.registrations).toEqual([{ chainId: 5042002, agentId: '0' }]);
  });

  it('converts rejected registration into redacted failure status and clears old claims', async () => {
    const bundle = createApp(config);
    bundle.tokenIdRef.chains.set(5042002, 1n);
    vi.mocked(ensureAgentRegistered).mockRejectedValue(new Error('private-key rpc-url SECRET'));
    await initializeIdentity(config, bundle.tokenIdRef, bundle.identityState);
    const response = await request(bundle.app).get('/identity/status');
    expect(response.status).toBe(503);
    expect(response.body).toEqual({ status: 'failed', registrations: [], error: 'Identity registration failed.' });
    expect(response.text).not.toContain('SECRET');
  });

  it('marks an empty completed registration set disabled', async () => {
    const bundle = createApp(config);
    vi.mocked(ensureAgentRegistered).mockResolvedValue(new Map());
    await initializeIdentity(config, bundle.tokenIdRef, bundle.identityState);
    expect((await request(bundle.app).get('/identity/status')).body).toEqual({ status: 'disabled', registrations: [] });
  });

  it.each(['http://localhost:4002', 'http://127.0.0.1:4002', 'https://worker.localhost', 'http://[::1]:4002'])('disables registration for local service URL %s', async (a2aBaseUrl) => {
    const local = { ...config, a2aBaseUrl };
    const bundle = createApp(local);
    await initializeIdentity(local, bundle.tokenIdRef, bundle.identityState);
    const response = await request(bundle.app).get('/identity/status');
    expect(response.status).toBe(200);
    expect(response.body.status).toBe('disabled');
    expect(ensureAgentRegistered).not.toHaveBeenCalled();
  });

  it('disables registration when no identity chains are configured', async () => {
    const bundle = createApp({ ...config, arcRpcUrl: '' });
    expect((await request(bundle.app).get('/identity/status')).body.status).toBe('disabled');
  });
});
