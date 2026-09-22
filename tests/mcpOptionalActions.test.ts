import { beforeEach, describe, expect, it, vi } from 'vitest';

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
registerTools({
  tool: (name: string, _description: string, _schema: unknown, handler: any) => handlers.set(name, handler),
  resource: vi.fn(),
} as any, { baseUrl: 'http://localhost:4002' } as any, signer);
const prepare = (params: any) => handlers.get('prepare_inputs')!(params);

beforeEach(() => { vi.clearAllMocks(); });
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
    it(`${circuit}: supplied action is signed and passed to preparation`, async () => {
      const result = await prepare({ circuit, scope: 'test', action });
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      expect(signer.signTypedData).toHaveBeenCalledWith(action.domain, action.types, action.message);
      expect(signer.signMessage).not.toHaveBeenCalled();
      expect(prepareInputs).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ circuitId: circuit, userSignature: '0xtyped', ...hashTypedAction(action) }));
      const data = JSON.parse(result.content[0].text);
      expect(data.action_hash).toBe(hashTypedAction(action).actionHash);
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
