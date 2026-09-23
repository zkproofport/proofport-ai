import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Wallet } from 'ethers';

vi.mock('@zkproofport-ai/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@zkproofport-ai/sdk')>();
  return { ...actual, prepareInputs: vi.fn().mockResolvedValue({ prepared: true }) };
});
import { prepareInputs, hashTypedAction } from '@zkproofport-ai/sdk';
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
const prepare = (params: any) => handlers.get('prepare_inputs')!(params);

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
  for (const circuit of ['arc_eligibility', 'giwa_attestation']) {
    it(`${circuit}: no action signs the signal without hashing undefined`, async () => {
      const result = await prepare({ circuit, scope: 'test' });
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      expect(signer.signMessage).toHaveBeenCalledOnce();
      expect(signer.signTypedData).not.toHaveBeenCalled();
      expect(prepareInputs).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ circuitId: circuit, userSignature: '0xpersonal' }));
      expect(vi.mocked(prepareInputs).mock.calls[0][1]).not.toHaveProperty('actionHash');
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
  it.each(['coinbase_kyc', 'coinbase_country', 'oidc_domain'])('%s rejects an action before signing', async (circuit) => {
    const result = await prepare({ circuit, action });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('only arc_eligibility and giwa_attestation');
    expect(signer.signTypedData).not.toHaveBeenCalled();
    expect(prepareInputs).not.toHaveBeenCalled();
  });
});
