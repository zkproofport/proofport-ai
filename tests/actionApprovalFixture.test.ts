import { afterEach, describe, expect, it, vi } from 'vitest';
import { Wallet, verifyTypedData } from 'ethers';
import { callToolWithSimulatedApproval, generateProofWithSimulatedApproval } from './e2e/simulatedHumanApproval.js';

const wallet = new Wallet('0x' + '67'.repeat(32));
const config = { baseUrl: 'https://fixture.example.test' };
const params = { circuit: 'giwa_attestation' as const, scope: 'fixture', action: {
  domain: { name: 'Fixture', version: '1', chainId: 91342, verifyingContract: '0x' + '11'.repeat(20) },
  types: { Action: [{ name: 'amount', type: 'uint256' }] }, primaryType: 'Action', message: { amount: '1' },
} };
const approval = { approvalId: 'fixture-id', approvalUrl: `${config.baseUrl}/approve/fixture-id#browser-capability`, requesterToken: 'requester-secret', expiresAt: '2099-01-01T00:00:00.000Z' };
const pendingError = { code: 'ACTION_APPROVAL_REQUIRED', approval };
const pendingTool = { content: [{ text: JSON.stringify({ status: 'awaiting_approval', approval_id: approval.approvalId, approval_url: approval.approvalUrl }) }] };
function transport(tampered = false) {
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer browser-capability');
    if (url.endsWith('/approve')) {
      const submitted = JSON.parse(init!.body as string);
      expect(verifyTypedData(params.action.domain, params.action.types, params.action.message, submitted.signature)).toBe(wallet.address);
      return Response.json({ status: 'approved' });
    }
    return Response.json({ ...params, scope: tampered ? 'altered' : params.scope, approvalId: approval.approvalId, status: 'pending' });
  });
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}
afterEach(() => vi.unstubAllGlobals());

describe('test-only simulated human approval fixture', () => {
  it('approves the frozen SDK action with a real fixture signature and resumes once', async () => {
    const fetcher = transport();
    const generateProof = vi.fn().mockRejectedValueOnce(pendingError).mockResolvedValueOnce({ proof: 'fixture-proof' });
    const sdk = { generateProof, ActionApprovalRequiredError: class {} } as never;
    await expect(generateProofWithSimulatedApproval(sdk, config, { attestation: wallet }, params)).resolves.toEqual({ proof: 'fixture-proof' });
    expect(generateProof).toHaveBeenCalledTimes(2);
    expect(generateProof.mock.lastCall?.[2]).toEqual({ ...params, actionApproval: approval });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('does not retry an SDK proof failure after approval consumption', async () => {
    transport();
    const generateProof = vi.fn().mockRejectedValueOnce(pendingError).mockRejectedValueOnce(new Error('consumed proof failed'));
    await expect(generateProofWithSimulatedApproval({ generateProof, ActionApprovalRequiredError: class {} } as never, config, { attestation: wallet }, params)).rejects.toThrow('consumed proof failed');
    expect(generateProof).toHaveBeenCalledTimes(2);
  });
  it('rejects a tampered approval before signing or resuming', async () => {
    const fetcher = transport(true);
    const generateProof = vi.fn().mockRejectedValueOnce(pendingError);
    await expect(generateProofWithSimulatedApproval({ generateProof, ActionApprovalRequiredError: class {} } as never, config, { attestation: wallet }, params)).rejects.toThrow('changed before simulated signing');
    expect(fetcher).toHaveBeenCalledOnce();
    expect(generateProof).toHaveBeenCalledOnce();
  });
  it('preserves the old published SDK path without invoking approval HTTP', async () => {
    const fetcher = transport();
    const generateProof = vi.fn().mockResolvedValue({ proof: 'old-published-proof' });
    await expect(generateProofWithSimulatedApproval({ generateProof } as never, config, { attestation: wallet }, params)).resolves.toEqual({ proof: 'old-published-proof' });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('requires a pause from SDKs exposing the new approval lifecycle', async () => {
    transport();
    const generateProof = vi.fn().mockResolvedValue({ proof: 'bypassed' });
    await expect(generateProofWithSimulatedApproval({ generateProof, ActionApprovalRequiredError: class {} } as never, config, { attestation: wallet }, params)).rejects.toThrow('bypassed');
    expect(generateProof).toHaveBeenCalledOnce();
  });
  it('approves an MCP pending action and restores all original payment limits on resume', async () => {
    transport();
    const callTool = vi.fn().mockResolvedValueOnce(pendingTool).mockResolvedValueOnce({ content: [{ text: '{"proof":"fixture-proof"}' }] });
    const client = { listTools: async () => ({ tools: [{ name: 'get_action_approval' }] }), callTool };
    await callToolWithSimulatedApproval(client, config, wallet, 'generate_proof', { ...params, max_payment: '0.10' });
    expect(callTool).toHaveBeenCalledTimes(2);
    expect(callTool.mock.lastCall?.[0].arguments).toEqual({ ...params, max_payment: '0.10', approval_id: approval.approvalId });
    expect(JSON.stringify(callTool.mock.calls)).not.toContain(approval.requesterToken);
  });
  it('retains direct results from older published MCP tools', async () => {
    const fetcher = transport();
    const result = { isError: true, content: [{ text: '{"error":"No attestation found"}' }] };
    const client = { listTools: async () => ({ tools: [] }), callTool: vi.fn().mockResolvedValue(result) };
    await expect(callToolWithSimulatedApproval(client, config, wallet, 'prepare_inputs', params)).resolves.toEqual(result);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
