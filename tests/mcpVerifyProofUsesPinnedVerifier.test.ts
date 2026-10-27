import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { clearOidcKeyCache, PINNED_VERIFIERS } from '@zkproofport-app/core';
import { registerTools } from '../packages/mcp/src/tools.js';

/**
 * The MCP verify_proof tool, through the built @zkproofport-ai/sdk and the
 * real core: a result naming a verifier other than the pinned one is refused.
 */
const handlers = new Map<string, (params: any) => Promise<any>>();
const signer = { getAddress: vi.fn(), signMessage: vi.fn(), signTypedData: vi.fn() };

beforeEach(() => {
  clearOidcKeyCache();
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network is not allowed in this test'); }));
  registerTools({
    tool: (name: string, _d: string, _s: unknown, handler: any) => handlers.set(name, handler),
    resource: vi.fn(),
  } as any, { baseUrl: 'http://localhost:4002' } as any, signer as any);
});
afterEach(() => vi.unstubAllGlobals());

const verify = (verification: Record<string, unknown>) => handlers.get('verify_proof')!({
  result: {
    circuit: 'coinbase_attestation', proofType: 'kyc', proof: '0xaabb',
    publicInputs: '0x' + '00'.repeat(32 * 128), verification,
  },
});

describe('MCP verify_proof', () => {
  it('refuses a result naming a verifier that is not the pinned one', async () => {
    const out = await verify({ chainId: 84532, verifierAddress: '0x000000000000000000000000000000000000dEaD', rpcUrl: 'https://rpc.attacker.example' });
    const body = JSON.parse(out.content[0].text);
    expect(body.valid).toBe(false);
    expect(body.error).toContain('Refusing rather than trusting the response');
  });

  it('accepts a result without rpcUrl and still checks it (signer root refuses an all-zero proof)', async () => {
    const out = await verify({ chainId: 84532, verifierAddress: PINNED_VERIFIERS.coinbase_attestation[84532].address });
    const body = JSON.parse(out.content[0].text);
    expect(body.valid).toBe(false);
    expect(body.error).toMatch(/root/i);
  });
});
