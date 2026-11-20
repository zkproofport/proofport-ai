import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { clearOidcKeyCache, getPinnedOprfKeyHash, oprfLayoutOf, PINNED_VERIFIERS } from '@zkproofport-app/core';
import { registerTools } from '../packages/mcp/src/tools.js';

/**
 * The MCP verify_proof tool, through the built @zkproofport-ai/sdk and the
 * real core: a result naming a verifier other than the pinned one is refused.
 */
const handlers = new Map<string, (params: any) => Promise<any>>();
const signer = { getAddress: vi.fn(), signMessage: vi.fn(), signTypedData: vi.fn() };

/** The proving service this MCP server is configured for, and what it answers at GET /api/v1/oprf. */
const BASE_URL = 'http://localhost:4002';
let serverOprf: { status: number; body: unknown };

beforeEach(() => {
  clearOidcKeyCache();
  serverOprf = { status: 200, body: { environment: 'staging' } };
  vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
    if (String(url) === `${BASE_URL}/api/v1/oprf`) {
      return new Response(JSON.stringify(serverOprf.body), { status: serverOprf.status, headers: { 'content-type': 'application/json' } });
    }
    throw new Error('network is not allowed in this test');
  }));
  registerTools({
    tool: (name: string, _d: string, _s: unknown, handler: any) => handlers.set(name, handler),
    resource: vi.fn(),
  } as any, { baseUrl: BASE_URL } as any, signer as any);
});
afterEach(() => vi.unstubAllGlobals());

/** OPRF-layout KYC inputs, zero but for the staging OPRF key hash, so the signer root is what refuses them. */
function kycInputs(): string {
  const layout = oprfLayoutOf('coinbase_attestation');
  const fields = Array.from({ length: layout.count }, () => '00'.repeat(32));
  fields[layout.keyHash] = getPinnedOprfKeyHash('staging', 'coinbase_attestation').slice(2);
  return '0x' + fields.join('');
}

const verify = (verification: Record<string, unknown>, extra: Record<string, unknown> = { oprfEnvironment: 'staging' }) => handlers.get('verify_proof')!({
  result: {
    circuit: 'coinbase_attestation', proofType: 'kyc', proof: '0xaabb',
    publicInputs: kycInputs(), verification, ...extra,
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

  it("takes the OPRF environment from its configured proving service when the result names none", async () => {
    const out = await verify({ chainId: 84532, verifierAddress: PINNED_VERIFIERS.coinbase_attestation[84532].address }, {});
    const body = JSON.parse(out.content[0].text);
    expect(body.valid).toBe(false);
    expect(body.error).toMatch(/root/i);
  });

  it.each(['local', 'production'])("refuses a result claiming 'staging' when its proving service is %s", async env => {
    serverOprf = { status: 200, body: { environment: env } };
    const out = await verify({ chainId: 84532, verifierAddress: PINNED_VERIFIERS.coinbase_attestation[84532].address });
    const body = JSON.parse(out.content[0].text);
    expect(body).toEqual({
      valid: false,
      error: `The result names the 'staging' OPRF environment, but this verifier checks against '${env}'; refusing it.`,
    });
  });

  it('refuses by name when its proving service names no environment', async () => {
    serverOprf = { status: 503, body: { message: 'OPRF_ENVIRONMENT is not set on this server' } };
    const out = await verify({ chainId: 84532, verifierAddress: PINNED_VERIFIERS.coinbase_attestation[84532].address });
    const body = JSON.parse(out.content[0].text);
    expect(body.valid).toBe(false);
    expect(body.error).toContain(`${BASE_URL}/api/v1/oprf did not name an OPRF environment`);
  });
});
