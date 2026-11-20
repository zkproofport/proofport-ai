import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Wallet } from 'ethers';

vi.mock('@zkproofport-ai/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@zkproofport-ai/sdk')>();
  return {
    ...actual,
    prepareInputs: vi.fn().mockResolvedValue({ prepared: true }),
    // The OPRF step answers without sockets; the real step: tests/oprfFlow.test.ts.
    prepareOprf: vi.fn(async (_c: unknown, a: { circuitId: string; address: string; oprfDomain: unknown; scope: string }) => ({
      environment: 'staging', circuitId: a.circuitId, address: a.address, oprfDomain: actual.assertOprfName(a.oprfDomain, 'domain'), scope: a.scope, inputs: {},
    })),
  };
});
import { prepareInputs, prepareOprf, hashTypedAction } from '@zkproofport-ai/sdk';
import { registerTools } from '../packages/mcp/src/tools.js';

const action = {
  domain: { name: 'Test', version: '1', chainId: 91342, verifyingContract: '0x1111111111111111111111111111111111111111' },
  types: { Grant: [{ name: 'amount', type: 'uint256' }] },
  primaryType: 'Grant', message: { amount: '1' },
};
const signer = {
  getAddress: vi.fn().mockResolvedValue('0x2222222222222222222222222222222222222222'),
  signMessage: vi.fn().mockResolvedValue('0xpersonal'),
  signTypedData: vi.fn().mockResolvedValue('0xtyped'),
};
const handlers = new Map<string, (params: any) => Promise<any>>();
function register() { registerTools({
  tool: (name: string, _description: string, _schema: unknown, handler: any) => handlers.set(name, handler),
  resource: vi.fn(),
} as any, { baseUrl: 'http://localhost:4002' } as any, signer); }
const prepare = (params: any) => handlers.get('prepare_inputs')!({ oprf_domain: 'app.example.com', ...params });

let directory: string;
beforeEach(async () => {
  vi.clearAllMocks();
  directory = await mkdtemp(join(tmpdir(), 'mcp-action-contract-'));
  vi.stubEnv('ZKPROOFPORT_APPROVAL_DIR', directory);
  register();
});
afterEach(async () => {
  vi.unstubAllGlobals(); vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});
describe('MCP step-by-step optional actions', () => {
  it('refuses the removed arc_eligibility circuit before signing', async () => {
    const result = await prepare({ circuit: 'arc_eligibility', scope: 'test', action });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Unknown circuit 'arc_eligibility'. Known: coinbase_kyc, coinbase_country, oidc_domain, giwa_attestation, human_passport.");
    expect(signer.signMessage).not.toHaveBeenCalled();
    expect(signer.signTypedData).not.toHaveBeenCalled();
    expect(prepareInputs).not.toHaveBeenCalled();
  });
  for (const circuit of ['giwa_attestation']) {
    it(`${circuit}: no action signs the signal without hashing undefined`, async () => {
      const result = await prepare({ circuit, scope: 'test' });
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      expect(signer.signMessage).toHaveBeenCalledOnce();
      expect(signer.signTypedData).not.toHaveBeenCalled();
      expect(prepareInputs).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ circuitId: circuit, userSignature: '0xpersonal' }));
      expect(vi.mocked(prepareInputs).mock.calls[0][1]).not.toHaveProperty('actionHash');
      // The OPRF step ran for this wallet and names, and its result went into the inputs.
      expect(prepareOprf).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ circuitId: circuit, address: '0x2222222222222222222222222222222222222222', oprfDomain: 'app.example.com', scope: 'test' }));
      expect(vi.mocked(prepareInputs).mock.calls[0][1]).toHaveProperty('oprf.oprfDomain', 'app.example.com');
      expect(JSON.parse(result.content[1].text)).toMatchObject({ oprf_domain: 'app.example.com', scope: 'test' });
    });
    it(`${circuit}: no oprf_domain is refused before anything is signed`, async () => {
      const result = await handlers.get('prepare_inputs')!({ circuit, scope: 'test' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/oprf_domain is required for wallet circuits/);
      expect(signer.signMessage).not.toHaveBeenCalled();
      expect(prepareOprf).not.toHaveBeenCalled();
    });
    it(`${circuit}: waits for human approval and privately prepares the verified signature`, async () => {
      const human = Wallet.createRandom();
      const signature = await human.signTypedData(action.domain, action.types, action.message);
      const approval = { approvalId: 'ab'.repeat(16), approvalUrl: 'http://localhost:4002/approve/id#browser', requesterToken: 'cd'.repeat(32), expiresAt: new Date(Date.now()+600_000).toISOString() };
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ ...approval, status: 'pending' })))
        .mockResolvedValueOnce(new Response(JSON.stringify({ ...approval, status: 'approved', circuit, scope: 'test', action, address: human.address })))
        .mockResolvedValueOnce(new Response(JSON.stringify({ circuit, scope: 'test', action, address: human.address, signature })));
      vi.stubGlobal('fetch', fetchMock);
      const pending = await prepare({ circuit, scope: 'test', action });
      expect(pending.isError).not.toBe(true);
      expect(JSON.parse(pending.content[0].text)).toMatchObject({status:'awaiting_approval',approval_id:approval.approvalId});
      expect(prepareInputs).not.toHaveBeenCalled();
      expect(JSON.stringify(pending)).not.toContain(approval.requesterToken);
      const result = await prepare({ circuit, scope: 'test', action, approval_id: approval.approvalId });
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      expect(signer.signTypedData).not.toHaveBeenCalled();
      expect(signer.signMessage).not.toHaveBeenCalled();
      expect(prepareInputs).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ circuitId: circuit, userAddress: human.address, userSignature: signature, ...hashTypedAction(action) }));
      const data = JSON.parse(result.content[0].text);
      expect(data.action_hash).toBe(hashTypedAction(action).actionHash);
      expect(data.prepared_inputs_id).toMatch(/^inputs_/);
      expect(JSON.stringify(result)).not.toContain(signature);
    });
    it(`${circuit}: invalid action fails before signing`, async () => {
      const result = await prepare({ circuit, action: { ...action, message: {} } });
      expect(result.isError).toBe(true);
      expect(signer.signTypedData).not.toHaveBeenCalled();
      expect(prepareInputs).not.toHaveBeenCalled();
    });
  }
  it.each([['prepare_inputs'], ['generate_proof']])('%s: no scope is refused naming it, before anything is signed (no default)', async tool => {
    const result = await handlers.get(tool)!({ circuit: 'giwa_attestation', oprf_domain: 'app.example.com' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/scope is required/);
    expect(signer.signMessage).not.toHaveBeenCalled();
    expect(prepareOprf).not.toHaveBeenCalled();
  });
  it.each([['prepare_inputs'], ['generate_proof']])('%s: no oprf_domain on a wallet circuit is refused naming oprf_domain (never filled in)', async tool => {
    const result = await handlers.get(tool)!({ circuit: 'coinbase_kyc', scope: 'test' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/oprf_domain is required for wallet circuits/);
    expect(signer.signMessage).not.toHaveBeenCalled();
  });
  it('oidc_domain needs a scope too', async () => {
    const result = await handlers.get('prepare_inputs')!({ circuit: 'oidc_domain', jwt: 'x.y.z' });
    expect(result.content[0].text).toMatch(/scope is required/);
  });
  it('oidc_domain refuses an oprf_domain: it has no OPRF nullifier', async () => {
    const result = await prepare({ circuit: 'oidc_domain', scope: 'test', jwt: 'x.y.z' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/oprf_domain applies to wallet circuits/);
    expect(prepareOprf).not.toHaveBeenCalled();
  });
  it.each(['oidc_domain'])('%s rejects an action before signing', async (circuit) => {
    const result = await prepare({ circuit, scope: 'test', action });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('does not bind one. Circuits that do: coinbase_attestation, coinbase_country_attestation, giwa_attestation, human_passport_score.');
    expect(signer.signTypedData).not.toHaveBeenCalled();
    expect(prepareInputs).not.toHaveBeenCalled();
  });
});
