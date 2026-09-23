import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Wallet, TypedDataEncoder } from 'ethers';
import { generateProof } from '../packages/sdk/src/flow.js';
import type { ProofParams, TypedAction } from '../packages/sdk/src/types.js';
import {
  ActionApprovalRequiredError, consumeActionApproval, createActionApproval,
  getActionApprovalStatus, resolveActionApproval,
} from '../packages/sdk/src/actionApproval.js';

const boundary = vi.hoisted(() => ({ order: [] as string[] }));
vi.mock('../packages/sdk/src/inputs.js', async (original) => ({
  ...await original<typeof import('../packages/sdk/src/inputs.js')>(),
  prepareInputs: vi.fn(async () => {
    boundary.order.push('inputs');
    return { signal_hash: '0xprepared' };
  }),
}));
vi.mock('../packages/sdk/src/payment.js', () => ({
  signPayment: vi.fn(async () => {
    boundary.order.push('pay');
    return { headers: { 'X-Payment': 'payment-fixture' }, paidOn: 'base', amount: '0.10', payer: 'payer' };
  }),
}));
vi.mock('../packages/sdk/src/oidc-inputs.js', () => ({
  prepareOidcPayload: vi.fn(async () => ({ jwt: 'jwt-fixture', scope: 'scope-fixture' })),
}));

const config = { baseUrl: 'https://ai.example.test' };
const human = new Wallet('0x' + '12'.repeat(32));
const agent = new Wallet('0x' + '34'.repeat(32));
const action: TypedAction = {
  domain: { name: 'Vault', version: '1', chainId: 8453, verifyingContract: '0x1111111111111111111111111111111111111111' },
  types: {
    Instruction: [{ name: 'terms', type: 'Terms' }, { name: 'labels', type: 'string[]' }],
    Terms: [{ name: 'amount', type: 'uint256' }, { name: 'enabled', type: 'bool' }, { name: 'nonce', type: 'uint256' }],
  },
  primaryType: 'Instruction',
  message: { terms: { amount: '90071992547409930000', enabled: false, nonce: '0' }, labels: ['한글🙂', '<script>inert</script>'] },
};
const request = { circuit: 'giwa_attestation' as const, scope: 'vault-session', action };
const approval = {
  approvalId: 'approval-fixture', approvalUrl: `${config.baseUrl}/approve/approval-fixture#browser-capability`,
  requesterToken: 'requester-capability', expiresAt: '2099-01-01T00:00:00.000Z',
};

function signer() {
  return {
    getAddress: vi.fn(async () => agent.address),
    signMessage: vi.fn(agent.signMessage.bind(agent)),
    signTypedData: vi.fn(agent.signTypedData.bind(agent)),
    sendTransaction: vi.fn(),
  };
}

function transport(overrides: {
  status?: Record<string, unknown>;
  consumed?: Record<string, unknown>;
  onStatus?: () => void;
  failProof?: boolean;
  proveExtra?: Record<string, unknown>;
} = {}) {
  let consumed = false;
  const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url);
    if (path.endsWith('/action-approvals')) {
      boundary.order.push('create');
      return Response.json({ ...approval, status: 'pending' }, { status: 201 });
    }
    if (path.endsWith(`/action-approvals/${approval.approvalId}`)) {
      boundary.order.push('status');
      overrides.onStatus?.();
      return Response.json({ approvalId: approval.approvalId, expiresAt: approval.expiresAt,
        ...request, status: consumed ? 'consumed' : 'approved', address: human.address, ...overrides.status });
    }
    if (path.endsWith('/consume')) {
      boundary.order.push('consume');
      if (consumed) return Response.json({ error: 'consumed' }, { status: 409 });
      consumed = true;
      return Response.json({ ...request, address: human.address,
        signature: await human.signTypedData(action.domain, action.types, action.message), ...overrides.consumed });
    }
    if (path.endsWith('/prove')) {
      if (!new Headers(init?.headers).has('X-Payment-Nonce')) {
        boundary.order.push('challenge');
        return Response.json({ nonce: 'nonce-fixture', requiresPayment: true, accepts: [] }, { status: 402 });
      }
      boundary.order.push('prove');
      if (overrides.failProof) return Response.json({ error: 'proof unavailable' }, { status: 503 });
      return Response.json({ circuit: request.circuit, proofType: 'fixture', proof: '0xproof', publicInputs: '0xpublic',
        proofWithInputs: '0xcombined', attestation: null, timing: {}, verification: null, ...overrides.proveExtra });
    }
    throw new Error(`Unexpected fixture URL: ${path}`);
  });
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}

function prove(params: ProofParams = request, localSigner = signer(), onStep = vi.fn()) {
  return generateProof(config, { attestation: localSigner, payment: {} as never }, params, { onStep });
}

beforeEach(() => { vi.clearAllMocks(); boundary.order.length = 0; });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('human approval before action proof work', () => {
  it.each(['giwa_attestation', 'arc_eligibility'] as const)('creates pending approval for %s without key signing or payment', async (circuit) => {
    const fetcher = transport();
    const keySigner = signer();
    await expect(prove({ ...request, circuit }, keySigner)).rejects.toMatchObject({
      name: 'ActionApprovalRequiredError', approval,
    });
    expect(boundary.order).toEqual(['create']);
    expect(keySigner.getAddress).not.toHaveBeenCalled();
    expect(keySigner.signTypedData).not.toHaveBeenCalled();
    expect(keySigner.signMessage).not.toHaveBeenCalled();
    expect(JSON.parse(fetcher.mock.calls[0][1]!.body as string)).toEqual({ ...request, circuit });
  });

  it.each(['pending', 'rejected', 'expired', 'consumed'])('does not consume or pay when the session is %s', async (status) => {
    transport({ status: { status } });
    await expect(prove({ ...request, actionApproval: approval } as ProofParams)).rejects.toMatchObject({
      code: status === 'pending' ? 'ACTION_APPROVAL_REQUIRED' : `ACTION_APPROVAL_${status.toUpperCase()}`,
    });
    expect(boundary.order).toEqual(['status']);
  });

  it('uses the human address and exact signature, then prepares inputs before payment', async () => {
    const fetcher = transport();
    const keySigner = signer();
    const onStep = vi.fn();
    await expect(prove({ ...request, actionApproval: approval } as ProofParams, keySigner, onStep)).resolves.toMatchObject({ proof: '0xproof' });
    expect(boundary.order).toEqual(['status', 'consume', 'inputs', 'challenge', 'pay', 'prove']);
    const { prepareInputs } = await import('../packages/sdk/src/inputs.js');
    const signature = await human.signTypedData(action.domain, action.types, action.message);
    expect(prepareInputs).toHaveBeenCalledWith(config, expect.objectContaining({
      userAddress: human.address, userSignature: signature, scope: request.scope,
      domainSeparator: TypedDataEncoder.hashDomain(action.domain),
      actionHash: TypedDataEncoder.hashStruct(action.primaryType, action.types, action.message),
    }));
    expect(keySigner.getAddress).not.toHaveBeenCalled();
    expect(keySigner.signTypedData).not.toHaveBeenCalled();
    expect(keySigner.signMessage).not.toHaveBeenCalled();
    expect(JSON.stringify(onStep.mock.calls)).not.toContain(signature);
    expect(JSON.stringify(onStep.mock.calls)).not.toContain(approval.requesterToken);
    expect(fetcher.mock.calls.slice(0, 2).map(call => new Headers(call[1]?.headers).get('Authorization')))
      .toEqual([`Bearer ${approval.requesterToken}`, `Bearer ${approval.requesterToken}`]);
    expect(JSON.parse(fetcher.mock.calls[1][1]!.body as string)).toEqual(request);
  });

  it.each([
    ['circuit', { circuit: 'arc_eligibility' }],
    ['scope', { scope: 'different-scope' }],
    ['message', { action: { ...action, message: { ...action.message, labels: ['changed'] } } }],
    ['domain', { action: { ...action, domain: { ...action.domain, chainId: 1 } } }],
    ['primary type', { action: { ...action, primaryType: 'Terms' } }],
    ['signature', { signature: '0xbroken' }],
    ['address', { address: agent.address }],
  ])('rejects a tampered consume %s before inputs or payment', async (_name, consumed) => {
    transport({ consumed });
    await expect(prove({ ...request, actionApproval: approval } as ProofParams)).rejects.toMatchObject({ code: 'ACTION_APPROVAL_INVALID' });
    expect(boundary.order).toEqual(['status', 'consume']);
  });

  it('rejects a valid signature from another wallet', async () => {
    transport({ consumed: { signature: await agent.signTypedData(action.domain, action.types, action.message) } });
    await expect(prove({ ...request, actionApproval: approval } as ProofParams)).rejects.toMatchObject({ code: 'ACTION_APPROVAL_INVALID' });
    expect(boundary.order).toEqual(['status', 'consume']);
  });

  it.each([
    ['scope', { scope: 'other' }],
    ['id', { approvalId: 'different' }],
    ['state', { status: 'unexpected' }],
    ['expected signer', { expectedSigner: agent.address }],
    ['missing signer', { address: undefined }],
    ['extended expiry', { expiresAt: '2100-01-01T00:00:00.000Z' }],
  ])('rejects a mismatched status %s before consuming', async (_name, status) => {
    transport({ status });
    await expect(prove({ ...request, actionApproval: approval } as ProofParams)).rejects.toMatchObject({ code: 'ACTION_APPROVAL_INVALID' });
    expect(boundary.order).toEqual(['status']);
  });

  it('freezes caller-owned action before the asynchronous status request', async () => {
    const callerAction = structuredClone(action);
    transport({ onStatus: () => { (callerAction.message.terms as Record<string, unknown>).amount = '1'; } });
    await prove({ ...request, action: callerAction, actionApproval: approval } as ProofParams);
    const { prepareInputs } = await import('../packages/sdk/src/inputs.js');
    expect(prepareInputs).toHaveBeenCalledWith(config, expect.objectContaining({
      actionHash: TypedDataEncoder.hashStruct(action.primaryType, action.types, action.message),
    }));
  });

  it('keeps the requested circuit stable while waiting for approval', async () => {
    const params: ProofParams = { ...request, actionApproval: approval };
    const fetcher = transport({ onStatus: () => { params.circuit = 'arc_eligibility'; } });
    await prove(params);
    const proofCalls = fetcher.mock.calls.filter(([url]) => String(url).endsWith('/prove'));
    expect(proofCalls.map(([, init]) => JSON.parse(init!.body as string).circuit)).toEqual(['giwa_attestation', 'giwa_attestation']);
  });

  it('can resume without any agent credential signer', async () => {
    transport();
    await expect(generateProof(config, { payment: {} as never }, { ...request, actionApproval: approval }))
      .resolves.toMatchObject({ proof: '0xproof' });
  });

  it('does not treat a resume handle without its original action as a new personal-sign proof', async () => {
    const fetcher = transport();
    const local = signer();
    await expect(prove({ circuit: 'giwa_attestation', actionApproval: approval }, local)).rejects.toMatchObject({ code: 'ACTION_APPROVAL_INVALID' });
    expect(fetcher).not.toHaveBeenCalled();
    expect(local.signMessage).not.toHaveBeenCalled();
  });

  it('does not retry payment after a consumed approval has a failed proof', async () => {
    transport({ failProof: true });
    const params = { ...request, actionApproval: approval } as ProofParams;
    await expect(prove(params)).rejects.toThrow(/Proof generation failed/);
    await expect(prove(params)).rejects.toMatchObject({ code: 'ACTION_APPROVAL_CONSUMED' });
    expect(boundary.order).toEqual(['status', 'consume', 'inputs', 'challenge', 'pay', 'prove', 'status']);
  });

  it('does not echo a server-returned signature through action completion callbacks', async () => {
    const signature = await human.signTypedData(action.domain, action.types, action.message);
    transport({ proveExtra: { debugSignature: signature } });
    const onStep = vi.fn();
    await prove({ ...request, actionApproval: approval }, signer(), onStep);
    expect(onStep.mock.calls.some(([step]) => step.step === 4)).toBe(true);
    expect(JSON.stringify(onStep.mock.calls)).not.toContain(signature);
  });

  it('does not request a payment challenge when attestation preparation fails after approval', async () => {
    transport();
    const { prepareInputs } = await import('../packages/sdk/src/inputs.js');
    vi.mocked(prepareInputs).mockRejectedValueOnce(new Error('Credential attestation unavailable'));
    await expect(prove({ ...request, actionApproval: approval })).rejects.toThrow('Credential attestation unavailable');
    expect(boundary.order).toEqual(['status', 'consume']);
  });
});

describe('approval client validation and capabilities', () => {
  it('pins an explicitly requested signer without consulting an agent key', async () => {
    transport({ status: { expectedSigner: human.address } });
    await expect(resolveActionApproval(config, { ...request, expectedSigner: human.address }, approval))
      .resolves.toEqual({ address: human.address, signature: await human.signTypedData(action.domain, action.types, action.message) });
  });

  it.each([undefined, agent.address, false])('rejects omitted, changed or malformed expected signer (%s)', async expectedSigner => {
    transport({ status: { expectedSigner } });
    await expect(resolveActionApproval(config, { ...request, expectedSigner: human.address }, approval))
      .rejects.toMatchObject({ code: 'ACTION_APPROVAL_INVALID' });
    expect(boundary.order).toEqual(['status']);
  });

  it('filters signature and requester credentials from a status response', async () => {
    const rawSignature = await human.signTypedData(action.domain, action.types, action.message);
    transport({ status: { signature: rawSignature, requesterToken: 'leaked-token' } });
    const status = await getActionApprovalStatus(config, approval);
    expect(status).toMatchObject({ status: 'approved', address: human.address });
    expect(JSON.stringify(status)).not.toContain(rawSignature);
    expect(JSON.stringify(status)).not.toContain('leaked-token');
  });

  it('keeps the required handle accessible without leaking its capability in serialized errors', async () => {
    transport({ status: { status: 'pending', address: undefined } });
    const error = await resolveActionApproval(config, request, approval).catch(error => error);
    expect(error).toBeInstanceOf(ActionApprovalRequiredError);
    expect(error.approval).toEqual(approval);
    expect(JSON.stringify(error)).not.toContain(approval.requesterToken);
    expect(String(error)).not.toContain(approval.requesterToken);
  });

  it.each([null, [], {}, { ...approval, status: 'approved' }, { ...approval, status: 'pending', expiresAt: 'invalid' },
    { ...approval, status: 'pending', approvalUrl: 'javascript:alert(1)' }])('rejects malformed creation response %j', async response => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(response)));
    await expect(createActionApproval(config, request)).rejects.toMatchObject({ code: 'ACTION_APPROVAL_INVALID' });
  });

  it.each(['rejected', null, [], {}])('rejects malformed status response %j', async response => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(response)));
    await expect(resolveActionApproval(config, request, approval)).rejects.toMatchObject({ code: 'ACTION_APPROVAL_INVALID' });
  });

  it.each([0, -1])('rejects expiry at or before the local clock (%i ms)', async delta => {
    const now = Date.parse('2030-01-01T00:00:00.000Z');
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const fetcher = transport();
    await expect(resolveActionApproval(config, request, { ...approval, expiresAt: new Date(now + delta).toISOString() }))
      .rejects.toMatchObject({ code: 'ACTION_APPROVAL_EXPIRED' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects approval that expires while consume is in flight', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(approval.expiresAt) - 1);
    vi.stubGlobal('fetch', vi.fn(async () => {
      clock.mockReturnValue(Date.parse(approval.expiresAt));
      return Response.json({ ...request, address: human.address,
        signature: await human.signTypedData(action.domain, action.types, action.message) });
    }));
    await expect(consumeActionApproval(config, request, approval)).rejects.toMatchObject({ code: 'ACTION_APPROVAL_EXPIRED' });
  });

  it.each([
    { approvalId: '' }, { approvalId: '../other' }, { requesterToken: '' },
    { requesterToken: 'token\nInjected: true' }, { expiresAt: '' },
  ])('rejects a malformed capability before network access: %j', async changed => {
    const fetcher = transport();
    await expect(resolveActionApproval(config, request, { ...approval, ...changed }))
      .rejects.toMatchObject({ code: 'ACTION_APPROVAL_INVALID' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(['', ' ', null, undefined])('rejects empty or missing explicit helper scope (%j)', async scope => {
    const fetcher = transport();
    await expect(createActionApproval(config, { ...request, scope } as never)).rejects.toMatchObject({ code: 'ACTION_APPROVAL_INVALID' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(['coinbase_kyc', 'oidc_domain', 'unknown'])('rejects unsupported helper circuit %s', async circuit => {
    const fetcher = transport();
    await expect(createActionApproval(config, { ...request, circuit } as never)).rejects.toMatchObject({ code: 'ACTION_APPROVAL_INVALID' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('does not expose provider-reflected secrets in an HTTP failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: `${approval.requesterToken} raw-signature` }, { status: 401 })));
    const error = await resolveActionApproval(config, request, approval).catch(error => error);
    expect(error).toMatchObject({ code: 'ACTION_APPROVAL_UNAVAILABLE' });
    expect(String(error)).toContain('401');
    expect(String(error)).not.toContain(approval.requesterToken);
    expect(String(error)).not.toContain('raw-signature');
  });

  it('bounds transport and prevents redirects or caching of capabilities', async () => {
    const fetcher = transport();
    await getActionApprovalStatus(config, approval);
    const [url, init] = fetcher.mock.calls[0];
    expect(String(url)).not.toContain(approval.requesterToken);
    expect(init).toMatchObject({ redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer' });
    expect(init!.signal).toBeInstanceOf(AbortSignal);
  });

  it('does not retry a consume request after a lost response', async () => {
    const fetcher = vi.fn(async () => { throw new Error(`socket lost ${approval.requesterToken}`); });
    vi.stubGlobal('fetch', fetcher);
    const error = await consumeActionApproval(config, request, approval).catch(error => error);
    expect(error).toMatchObject({ code: 'ACTION_APPROVAL_UNAVAILABLE' });
    expect(String(error)).not.toContain(approval.requesterToken);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('validates a directly consumed signature against the request even when the server echoes the right fields', async () => {
    const altered = { ...action, message: { ...action.message, labels: ['different request'] } };
    transport({ consumed: { signature: await human.signTypedData(altered.domain, altered.types, altered.message) } });
    await expect(consumeActionApproval(config, request, approval)).rejects.toMatchObject({ code: 'ACTION_APPROVAL_INVALID' });
    expect(boundary.order).toEqual(['consume']);
  });

  it('preserves empty arrays in an approved action', async () => {
    const emptyAction = { ...action, message: { ...action.message, labels: [] } };
    const snapshot = { ...request, action: emptyAction };
    const signature = await human.signTypedData(emptyAction.domain, emptyAction.types, emptyAction.message);
    transport({ status: snapshot, consumed: { ...snapshot, signature } });
    await expect(resolveActionApproval(config, snapshot, approval)).resolves.toEqual({ address: human.address, signature });
  });
});

describe('existing proof paths without action', () => {
  it('gives a helpful error when the credential signer is missing on a nonaction EAS request', async () => {
    const fetcher = transport();
    await expect(generateProof(config, {}, { circuit: 'giwa_attestation' })).rejects.toThrow(/attestation signer.*without an action/);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each(['coinbase_kyc', 'coinbase_country', 'giwa_attestation', 'arc_eligibility'] as const)('keeps personal signing and payment for %s', async (circuit) => {
    transport();
    const local = signer();
    await prove({ circuit, scope: request.scope, countryList: ['KR'], isIncluded: true }, local);
    expect(local.signMessage).toHaveBeenCalledOnce();
    expect(local.signTypedData).not.toHaveBeenCalled();
    expect(boundary.order).toEqual(['inputs', 'challenge', 'pay', 'prove']);
  });

  it('keeps OIDC independent of either signature method', async () => {
    transport();
    const local = signer();
    await prove({ circuit: 'oidc_domain', jwt: 'jwt-fixture', scope: request.scope }, local);
    expect(local.getAddress).not.toHaveBeenCalled();
    expect(local.signMessage).not.toHaveBeenCalled();
    expect(local.signTypedData).not.toHaveBeenCalled();
    expect(boundary.order).toEqual(['challenge', 'pay', 'prove']);
  });
});
