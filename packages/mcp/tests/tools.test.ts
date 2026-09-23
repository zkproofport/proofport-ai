import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ethers } from 'ethers';
import { z } from 'zod';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const approval = { approvalId: 'approval_0123456789', approvalUrl: 'https://test.example.com/approve/id#browser', requesterToken: 'private-requester-token', expiresAt: new Date(Date.now() + 600_000).toISOString() };
class PendingApprovalError extends Error {
  approval = approval;
  constructor() { super('Human action approval required'); }
}
const mockResolveApproval = vi.fn();
const mockApprovalStatus = vi.fn();
let approvalDirectory: string;

// ─── Mock @zkproofport-ai/sdk ──────────────────────────────────────────────────
// Mirrors the SDK's real public surface. Payment (makePayment / PaymentInfo /
// USDC_ADDRESSES) was deleted from the SDK and the MCP in ee1c09d — it is
// deliberately absent here so a re-introduction shows up as a failing import
// rather than a silently-satisfied mock.
const mockGenerateProof = vi.fn();
const mockRequestChallenge = vi.fn();
const mockPrepareInputs = vi.fn();
const mockPrepareOidcPayload = vi.fn();
const mockSubmitProof = vi.fn();
const mockVerifyProof = vi.fn();
const mockComputeSignalHash = vi.fn().mockReturnValue('0xsignalhash');

vi.mock('@zkproofport-ai/sdk', async () => ({
  ActionApprovalRequiredError: PendingApprovalError,
  resolveActionApproval: mockResolveApproval,
  getActionApprovalStatus: mockApprovalStatus,
  hashTypedAction: (await import('../../sdk/src/index.js')).hashTypedAction,
  CIRCUIT_IDS: (await import('../../sdk/src/circuits.js')).CIRCUIT_IDS,
  generateProof: mockGenerateProof,
  requestChallenge: mockRequestChallenge,
  prepareInputs: mockPrepareInputs,
  prepareOidcPayload: mockPrepareOidcPayload,
  submitProof: mockSubmitProof,
  verifyProof: mockVerifyProof,
  computeSignalHash: mockComputeSignalHash,
  CIRCUITS: {
    coinbase_attestation: { displayName: 'Coinbase KYC', easSchemaId: '0xschema1', functionSelector: '0xfunc1' },
    coinbase_country_attestation: { displayName: 'Coinbase Country', easSchemaId: '0xschema2', functionSelector: '0xfunc2' },
    oidc_domain_attestation: { displayName: 'OIDC Domain', inputType: 'oidc' },
    arc_eligibility: { displayName: 'Arc Eligibility', inputType: 'eas' },
    giwa_attestation: { displayName: 'GIWA Attestation', inputType: 'eas' },
  },
  AUTHORIZED_SIGNERS: ['0x952f32128AF084422539C4Ff96df5C525322E564'],
  CIRCUIT_NAME_MAP: {
    arc_eligibility: 'arc_eligibility',
    giwa_attestation: 'giwa_attestation',
    coinbase_kyc: 'coinbase_attestation',
    coinbase_country: 'coinbase_country_attestation',
    oidc_domain: 'oidc_domain_attestation',
  },
}));

// ─── Tool handler capture ────────────────────────────────────────────────────
type ToolEntry = { schema: unknown; handler: Function };
type ResourceEntry = { uri: string; handler: Function };

let toolHandlers: Record<string, ToolEntry>;
let resourceHandlers: Record<string, ResourceEntry>;
let mockServer: {
  tool: ReturnType<typeof vi.fn>;
  resource: ReturnType<typeof vi.fn>;
};

const testConfig = {
  baseUrl: 'https://test.example.com',
};

const mockSigner = {
  getAddress: vi.fn().mockReturnValue('0xMockAttestationAddress'),
  signMessage: vi.fn().mockResolvedValue('0xmocksignature'),
  signTypedData: vi.fn().mockResolvedValue('0xmocktypeddata'),
  sendTransaction: vi.fn().mockResolvedValue({ hash: '0xtxhash', wait: async () => ({ status: 1 }) }),
};

async function callTool(name: string, params: Record<string, unknown> = {}) {
  const entry = toolHandlers[name];
  if (!entry) throw new Error(`Tool '${name}' not registered`);
  return entry.handler(params);
}

async function callResource(name: string) {
  const entry = resourceHandlers[name];
  if (!entry) throw new Error(`Resource '${name}' not registered`);
  return entry.handler();
}

function parseToolResult(result: { content: Array<{ type: string; text: string }>; isError?: boolean }) {
  return JSON.parse(result.content[0].text);
}

beforeEach(async () => {
  vi.clearAllMocks();
  mockGenerateProof.mockReset();
  mockResolveApproval.mockReset().mockRejectedValue(new PendingApprovalError());
  mockApprovalStatus.mockReset().mockResolvedValue({ status: 'pending', expiresAt: approval.expiresAt });
  approvalDirectory = await mkdtemp(join(tmpdir(), 'proofport-mcp-approval-'));
  vi.stubEnv('ZKPROOFPORT_APPROVAL_DIR', approvalDirectory);

  // Re-apply default mock return values after clearAllMocks
  mockSigner.getAddress.mockReturnValue('0xMockAttestationAddress');
  mockSigner.signMessage.mockResolvedValue('0xmocksignature');
  mockSigner.signTypedData.mockResolvedValue('0xmocktypeddata');
  mockSigner.sendTransaction.mockResolvedValue({ hash: '0xtxhash', wait: async () => ({ status: 1 }) });

  mockComputeSignalHash.mockReturnValue('0xsignalhash');

  toolHandlers = {};
  resourceHandlers = {};

  mockServer = {
    tool: vi.fn((...args: unknown[]) => {
      const name = args[0] as string;
      if (args.length === 4) {
        // (name, description, schema, handler)
        toolHandlers[name] = { schema: args[2], handler: args[3] as Function };
      } else if (args.length === 3) {
        // (name, description, handler) — no schema
        toolHandlers[name] = { schema: null, handler: args[2] as Function };
      }
    }),
    resource: vi.fn((...args: unknown[]) => {
      const name = args[0] as string;
      const uri = args[1] as string;
      const handler = args[2] as Function;
      resourceHandlers[name] = { uri, handler };
    }),
  };

  const { registerTools } = await import('../src/tools.js');
  registerTools(mockServer as any, testConfig as any, mockSigner as any);
});

afterEach(async () => {
  await rm(approvalDirectory, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe('human action approval orchestration', () => {
  it('returns actionable pending status without exposing the requester secret', async () => {
    mockGenerateProof.mockRejectedValue(new PendingApprovalError());
    const result = await callTool('generate_proof', { circuit: 'giwa_attestation', action: CUSTOM_ACTION });
    expect(result.isError).toBeUndefined();
    expect(parseToolResult(result)).toMatchObject({ status: 'awaiting_approval', approval_id: approval.approvalId, approval_url: approval.approvalUrl });
    expect(JSON.stringify(result)).not.toContain(approval.requesterToken);
    const status = await callTool('get_action_approval', { approval_id: approval.approvalId });
    expect(parseToolResult(status)).toMatchObject({ status: 'pending' });
  });

  it('resumes the saved request but refuses changed payment or action parameters', async () => {
    const params = { circuit: 'giwa_attestation', scope: 'scope', action: CUSTOM_ACTION, max_payment: '0.10' };
    mockGenerateProof.mockRejectedValueOnce(new PendingApprovalError());
    await callTool('generate_proof', params);
    mockGenerateProof.mockResolvedValue({ proof: '0xproof' });
    const changed = await callTool('generate_proof', { ...params, max_payment: '1.00', approval_id: approval.approvalId });
    expect(changed.isError).toBe(true);
    expect(parseToolResult(changed).error).toMatch(/match/);
    const result = await callTool('generate_proof', { ...params, approval_id: approval.approvalId });
    expect(parseToolResult(result)).toEqual({ proof: '0xproof' });
    expect(mockGenerateProof.mock.lastCall?.[2].actionApproval).toEqual(approval);
  });

  it('freezes circuit and payment terms while the saved approval is loaded', async () => {
    const params = { circuit: 'giwa_attestation', scope: 'scope', action: structuredClone(CUSTOM_ACTION), max_payment: '0.10' };
    mockGenerateProof.mockRejectedValueOnce(new PendingApprovalError());
    await callTool('generate_proof', params);
    mockGenerateProof.mockResolvedValue({ proof: '0xproof' });
    const resume = { ...params, approval_id: approval.approvalId };
    const pending = callTool('generate_proof', resume);
    resume.circuit = 'arc_eligibility';
    resume.max_payment = '100';
    const result = await pending;
    expect(result.isError).toBeUndefined();
    expect(mockGenerateProof.mock.lastCall?.[2]).toMatchObject({ circuit: 'giwa_attestation', maxPayment: '0.10' });
  });

  it('does not reflect private signatures from a prover error into model context', async () => {
    mockGenerateProof.mockRejectedValueOnce(new Error('server echoed private-signature-secret'));
    const generated = await callTool('generate_proof', { circuit: 'giwa_attestation', action: CUSTOM_ACTION });
    expect(JSON.stringify(generated)).not.toContain('private-signature-secret');
    expect(generated.isError).toBe(true);
    mockResolveApproval.mockResolvedValueOnce({ address: '0xHuman', signature: '0xprivate-signature-secret' });
    mockPrepareInputs.mockResolvedValueOnce({ userSignature: '0xprivate-signature-secret' });
    const prepared = parseToolResult(await callTool('prepare_inputs', { circuit: 'giwa_attestation', action: CUSTOM_ACTION }));
    mockSubmitProof.mockRejectedValueOnce(new Error('server echoed private-signature-secret'));
    const submitted = await callTool('submit_proof', { circuit: 'giwa_attestation', prepared_inputs_id: prepared.prepared_inputs_id, nonce: 'nonce' });
    expect(JSON.stringify(submitted)).not.toContain('private-signature-secret');
    expect(submitted.isError).toBe(true);
  });

  it('preserves safe approval states without reflecting provider messages', async () => {
    mockGenerateProof.mockRejectedValueOnce(Object.assign(new Error('private-signature-secret'), { code: 'ACTION_APPROVAL_EXPIRED' }));
    const result = await callTool('generate_proof', { circuit: 'giwa_attestation', action: CUSTOM_ACTION });
    expect(parseToolResult(result).error).toMatch(/expired/i);
    expect(JSON.stringify(result)).not.toContain('private-signature-secret');
  });

  it('only returns public proof fields from successful action responses', async () => {
    const response = { proof: '0xproof', debugSignature: 'private-signature-secret', timing: { totalMs: 1, privateSignature: 'private-signature-secret' }, verification: { chainId: 91342, rpcUrl: 'https://rpc.example.com', verifierAddress: '0x123', debugSignature: 'private-signature-secret' } };
    mockGenerateProof.mockResolvedValueOnce(response);
    const generated = await callTool('generate_proof', { circuit: 'giwa_attestation', action: CUSTOM_ACTION });
    expect(JSON.stringify(generated)).not.toContain('private-signature-secret');
    expect(parseToolResult(generated)).toMatchObject({ proof: '0xproof', timing: { totalMs: 1 } });
    mockResolveApproval.mockResolvedValueOnce({ address: '0xHuman', signature: '0xprivate-signature-secret' });
    mockPrepareInputs.mockResolvedValueOnce({ userSignature: '0xprivate-signature-secret' });
    const prepared = parseToolResult(await callTool('prepare_inputs', { circuit: 'giwa_attestation', action: CUSTOM_ACTION }));
    mockSubmitProof.mockResolvedValueOnce(response);
    const submitted = await callTool('submit_proof', { circuit: 'giwa_attestation', prepared_inputs_id: prepared.prepared_inputs_id, nonce: 'nonce' });
    expect(JSON.stringify(submitted)).not.toContain('private-signature-secret');
    expect(submitted.isError).toBeUndefined();
  });

  it('step-by-step action preparation also waits instead of using the private key', async () => {
    const result = await callTool('prepare_inputs', { circuit: 'arc_eligibility', action: CUSTOM_ACTION });
    expect(result.isError).toBeUndefined();
    expect(parseToolResult(result).status).toBe('awaiting_approval');
    expect(mockSigner.signTypedData).not.toHaveBeenCalled();
    expect(mockSigner.signMessage).not.toHaveBeenCalled();
    expect(mockPrepareInputs).not.toHaveBeenCalled();
  });
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('registerTools', () => {
  it('registers proof operations and both Gateway balance tools', () => {
    const expected = ['generate_proof', 'get_supported_circuits', 'request_challenge',
      'prepare_inputs', 'submit_proof', 'verify_proof', 'deposit_to_gateway', 'gateway_balance', 'get_action_approval'];
    expect(mockServer.tool).toHaveBeenCalledTimes(expected.length);
    expect(Object.keys(toolHandlers).sort()).toEqual(expected.sort());
  });

  it('registers proofport://config resource', () => {
    expect(mockServer.resource).toHaveBeenCalledTimes(1);
    expect(resourceHandlers['config']).toBeDefined();
    expect(resourceHandlers['config'].uri).toBe('proofport://config');
  });
});

describe('get_supported_circuits', () => {
  it('returns circuits and authorized signers', async () => {
    const result = await callTool('get_supported_circuits');
    const data = parseToolResult(result);

    expect(data.circuits).toBeDefined();
    expect(data.circuits.coinbase_attestation).toBeDefined();
    expect(data.circuits.coinbase_country_attestation).toBeDefined();
    expect(data.circuits.oidc_domain_attestation).toBeDefined();
    expect(data.authorized_signers).toEqual(['0x952f32128AF084422539C4Ff96df5C525322E564']);
    expect(result.isError).toBeUndefined();
  });
});

describe('generate_proof', () => {
  it('preserves user-approved payment terms through the MCP to SDK boundary',async()=>{
    mockGenerateProof.mockResolvedValue({proof:'0x'});
    const approved={network:'eip155:5042002',scheme:'exact',amount:'1000',asset:'0x3600000000000000000000000000000000000000',payTo:'0x'+'11'.repeat(20),extra:{name:'GatewayWalletBatched',version:'1',verifyingContract:'0x'+'22'.repeat(20)}};
    await callTool('generate_proof',{circuit:'arc_eligibility',pay_on:'arc-testnet-nano',max_payment:'0.001',approved_payment:approved});
    expect(mockGenerateProof.mock.calls[0][2]).toMatchObject({payOn:'arc-testnet-nano',maxPayment:'0.001',approvedPayment:approved});
  });
  it('calls generateProof with correct params', async () => {
    const mockResult = { proof: '0xabc', publicInputs: '0xdef' };
    mockGenerateProof.mockResolvedValue(mockResult);

    const result = await callTool('generate_proof', {
      circuit: 'coinbase_kyc',
      scope: 'test-scope',
    });

    expect(mockGenerateProof).toHaveBeenCalledOnce();
    const [passedConfig, passedWallets, passedParams, passedOpts] = mockGenerateProof.mock.calls[0];
    expect(passedConfig).toEqual(testConfig);
    // Without pay_with, this call passes only the credential signer.
    // Paid orchestration supplies a separately selected payment wallet.
    expect(passedWallets).toEqual({ attestation: mockSigner });
    expect(passedParams.circuit).toBe('coinbase_kyc');
    expect(passedParams.scope).toBe('test-scope');
    expect(passedOpts.onStep).toBeDefined();

    const data = parseToolResult(result);
    expect(data.proof).toBe('0xabc');
    expect(result.isError).toBeUndefined();
  });

  it('passes country_list and is_included for coinbase_country', async () => {
    mockGenerateProof.mockResolvedValue({ proof: '0x' });

    await callTool('generate_proof', {
      circuit: 'coinbase_country',
      country_list: ['US', 'KR'],
      is_included: true,
    });

    const passedParams = mockGenerateProof.mock.calls[0][2];
    expect(passedParams.countryList).toEqual(['US', 'KR']);
    expect(passedParams.isIncluded).toBe(true);
  });

  it('forwards jwt and provider only for oidc_domain', async () => {
    mockGenerateProof.mockResolvedValue({ proof: '0x' });

    await callTool('generate_proof', {
      circuit: 'oidc_domain',
      scope: 'example.com',
      jwt: 'header.payload.sig',
      provider: 'microsoft',
    });

    const oidcParams = mockGenerateProof.mock.calls[0][2];
    expect(oidcParams.jwt).toBe('header.payload.sig');
    expect(oidcParams.provider).toBe('microsoft');

    mockGenerateProof.mockClear();
    await callTool('generate_proof', {
      circuit: 'coinbase_kyc',
      jwt: 'header.payload.sig',
      provider: 'microsoft',
    });

    const coinbaseParams = mockGenerateProof.mock.calls[0][2];
    expect(coinbaseParams).not.toHaveProperty('jwt');
    expect(coinbaseParams).not.toHaveProperty('provider');
  });

  it('returns error on failure', async () => {
    mockGenerateProof.mockRejectedValue(new Error('proof generation failed'));

    const result = await callTool('generate_proof', {
      circuit: 'coinbase_kyc',
    });

    expect(result.isError).toBe(true);
    const data = parseToolResult(result);
    expect(data.error).toBe('proof generation failed');
  });
});

describe('request_challenge', () => {
  it('calls requestChallenge with parsed JSON string inputs', async () => {
    const mockChallenge = { nonce: '0xnonce', teePublicKey: null };
    mockRequestChallenge.mockResolvedValue(mockChallenge);

    const inputsObj = { attestation: '0xabc', proof: '0xdef' };
    const result = await callTool('request_challenge', {
      circuit: 'coinbase_kyc',
      inputs: JSON.stringify(inputsObj),
    });

    expect(mockRequestChallenge).toHaveBeenCalledWith(testConfig, 'coinbase_kyc', inputsObj);
    const data = parseToolResult(result);
    expect(data.nonce).toBe('0xnonce');
  });

  it('accepts object inputs directly', async () => {
    mockRequestChallenge.mockResolvedValue({ nonce: '0x1' });

    const inputsObj = { attestation: '0xabc' };
    await callTool('request_challenge', {
      circuit: 'coinbase_country',
      inputs: inputsObj,
    });

    expect(mockRequestChallenge).toHaveBeenCalledWith(testConfig, 'coinbase_country', inputsObj);
  });

  it('returns error on failure', async () => {
    mockRequestChallenge.mockRejectedValue(new Error('402 challenge failed'));

    const result = await callTool('request_challenge', {
      circuit: 'coinbase_kyc',
      inputs: '{}',
    });

    expect(result.isError).toBe(true);
    const data = parseToolResult(result);
    expect(data.error).toBe('402 challenge failed');
  });
});

describe('prepare_inputs', () => {
  it('computes signal hash with circuitId not circuit name', async () => {
    mockPrepareInputs.mockResolvedValue({ inputs: 'prepared' });

    await callTool('prepare_inputs', {
      circuit: 'coinbase_kyc',
      scope: 'my-scope',
    });

    // computeSignalHash should receive the mapped circuitId, not the friendly name
    expect(mockComputeSignalHash).toHaveBeenCalledWith(
      '0xMockAttestationAddress',
      'my-scope',
      'coinbase_attestation',
    );
  });

  it('defaults scope to proofport', async () => {
    mockPrepareInputs.mockResolvedValue({ inputs: 'prepared' });

    await callTool('prepare_inputs', {
      circuit: 'coinbase_kyc',
    });

    expect(mockComputeSignalHash).toHaveBeenCalledWith(
      '0xMockAttestationAddress',
      'proofport',
      'coinbase_attestation',
    );
  });

  it('signs the signal hash and calls prepareInputs', async () => {
    mockPrepareInputs.mockResolvedValue({ field: 'value' });

    await callTool('prepare_inputs', {
      circuit: 'coinbase_country',
      scope: 'test',
      country_list: ['US'],
      is_included: false,
    });

    // signer.getAddress was called
    expect(mockSigner.getAddress).toHaveBeenCalled();
    // signer.signMessage called with the signal hash value directly
    expect(mockSigner.signMessage).toHaveBeenCalledWith('0xsignalhash');

    // prepareInputs called with correct params
    expect(mockPrepareInputs).toHaveBeenCalledWith(testConfig, {
      circuitId: 'coinbase_country_attestation',
      userAddress: '0xMockAttestationAddress',
      userSignature: '0xmocksignature',
      scope: 'test',
      countryList: ['US'],
      isIncluded: false,
    });
  });

  it('uses the local OIDC path for oidc_domain (no EAS, no signing)', async () => {
    mockPrepareOidcPayload.mockResolvedValue({ jwt: 'x', jwks: {} });

    const result = await callTool('prepare_inputs', {
      circuit: 'oidc_domain',
      scope: 'example.com',
      jwt: 'header.payload.sig',
      provider: 'google',
    });

    expect(mockPrepareOidcPayload).toHaveBeenCalledWith({
      jwt: 'header.payload.sig',
      scope: 'example.com',
      provider: 'google',
    });
    // OIDC never touches the attestation wallet or the EAS input builder
    expect(mockSigner.signMessage).not.toHaveBeenCalled();
    expect(mockPrepareInputs).not.toHaveBeenCalled();
    expect(result.isError).toBeUndefined();
  });

  it('rejects oidc_domain without a jwt', async () => {
    const result = await callTool('prepare_inputs', {
      circuit: 'oidc_domain',
      scope: 'example.com',
    });

    expect(result.isError).toBe(true);
    expect(parseToolResult(result).error).toBe('jwt is required for oidc_domain circuit');
    expect(mockPrepareOidcPayload).not.toHaveBeenCalled();
  });

  it('returns error on failure', async () => {
    mockPrepareInputs.mockRejectedValue(new Error('EAS query failed'));

    const result = await callTool('prepare_inputs', {
      circuit: 'coinbase_kyc',
    });

    expect(result.isError).toBe(true);
    const data = parseToolResult(result);
    expect(data.error).toBe('EAS query failed');
  });
});

describe('submit_proof', () => {
  it('calls submitProof with circuit, inputs and the challenge nonce', async () => {
    const mockResult = { proof: '0xproof', publicInputs: '0xinputs' };
    mockSubmitProof.mockResolvedValue(mockResult);

    const inputs = { attestation: '0xdata' };
    const result = await callTool('submit_proof', {
      circuit: 'coinbase_kyc',
      inputs,
      nonce: '0xnonce',
    });

    // The nonce MUST be forwarded: POST /api/v1/prove treats a request with no
    // X-Payment-Nonce header as a fresh 402 challenge, so dropping it here makes
    // the step-by-step flow incapable of ever returning a proof.
    expect(mockSubmitProof).toHaveBeenCalledWith(testConfig, {
      circuit: 'coinbase_kyc',
      inputs,
      nonce: '0xnonce',
    });

    const data = parseToolResult(result);
    expect(data.proof).toBe('0xproof');
  });

  it('declares nonce in its input schema', () => {
    const schema = toolHandlers['submit_proof'].schema as Record<string, unknown>;
    expect(schema).toHaveProperty('nonce');
  });

  it('parses JSON string inputs', async () => {
    mockSubmitProof.mockResolvedValue({ proof: '0x' });

    const inputsObj = { field: 'value' };
    await callTool('submit_proof', {
      circuit: 'coinbase_country',
      inputs: JSON.stringify(inputsObj),
      nonce: '0xnonce',
    });

    const passedArgs = mockSubmitProof.mock.calls[0][1];
    expect(passedArgs.inputs).toEqual(inputsObj);
    expect(passedArgs.nonce).toBe('0xnonce');
  });

  it('returns error on failure', async () => {
    mockSubmitProof.mockRejectedValue(new Error('proof submission timeout'));

    const result = await callTool('submit_proof', {
      circuit: 'coinbase_kyc',
      inputs: '{}',
      nonce: '0xnonce',
    });

    expect(result.isError).toBe(true);
    const data = parseToolResult(result);
    expect(data.error).toBe('proof submission timeout');
  });
});

describe('verify_proof', () => {
  // verify_proof takes the whole generate_proof result object (33f7923) —
  // verifierAddress / chainId / rpcUrl are read out of result.verification
  // rather than passed as five separate arguments.
  const proofResult = {
    circuit: 'coinbase_attestation',
    proofType: 'ultra_honk',
    proof: '0xproofbytes',
    publicInputs: '0xinputs',
    verification: {
      verifierAddress: '0x0036B61dBFaB8f3CfEEF77dD5D45F7EFBFE2035c',
      chainId: 84532,
      rpcUrl: 'https://sepolia.base.org',
    },
  };

  it('calls verifyProof with verification info from the result object', async () => {
    mockVerifyProof.mockResolvedValue({ valid: true });

    await callTool('verify_proof', { result: proofResult });

    expect(mockVerifyProof).toHaveBeenCalledOnce();
    const passedArg = mockVerifyProof.mock.calls[0][0];
    expect(passedArg.circuit).toBe('coinbase_attestation');
    expect(passedArg.proofType).toBe('ultra_honk');
    expect(passedArg.verification.chainId).toBe(84532);
    expect(passedArg.verification.verifierAddress).toBe('0x0036B61dBFaB8f3CfEEF77dD5D45F7EFBFE2035c');
    expect(passedArg.verification.rpcUrl).toBe('https://sepolia.base.org');
    expect(passedArg.proof).toBe('0xproofbytes');
    expect(passedArg.publicInputs).toBe('0xinputs');
  });

  it('returns verification result', async () => {
    mockVerifyProof.mockResolvedValue({ valid: true });

    const result = await callTool('verify_proof', { result: proofResult });

    const data = parseToolResult(result);
    expect(data.valid).toBe(true);
  });

  it('returns error on failure', async () => {
    mockVerifyProof.mockRejectedValue(new Error('contract call reverted'));

    const result = await callTool('verify_proof', { result: proofResult });

    expect(result.isError).toBe(true);
    const data = parseToolResult(result);
    expect(data.error).toBe('contract call reverted');
  });
});

describe('proofport://config resource', () => {
  it('returns config with the attestation wallet address and supported circuits', async () => {
    const result = await callResource('config');

    expect(result.contents).toHaveLength(1);
    expect(result.contents[0].uri).toBe('proofport://config');
    expect(result.contents[0].mimeType).toBe('application/json');

    const data = JSON.parse(result.contents[0].text);
    expect(data.baseUrl).toBe(testConfig.baseUrl);
    expect(data.attestationWalletAddress).toBe('0xMockAttestationAddress');
    // No payment wallet exists any more — the resource must not advertise one.
    expect(data).not.toHaveProperty('paymentWalletAddress');
    expect(data.supportedCircuits).toBeDefined();
    expect(data.supportedCircuits.coinbase_attestation).toBeDefined();
  });
});

const CUSTOM_ACTION = {
  domain: { name: 'Custom Service', version: '1', chainId: 5042002, verifyingContract: '0x0000000000000000000000000000000000000001' },
  types: {
    Instruction: [{ name: 'terms', type: 'Terms' }, { name: 'tags', type: 'string[]' }],
    Terms: [{ name: 'quantity', type: 'uint256' }, { name: 'description', type: 'string' }],
  },
  primaryType: 'Instruction',
  message: { terms: { quantity: '10000000', description: 'arbitrary caller text' }, tags: ['custom'] },
};

describe('prepare_inputs action authorization', () => {
  it.each(['arc_eligibility', 'giwa_attestation'])('%s uses the human signature and keeps the action witness behind a private handle', async (circuit) => {
    mockResolveApproval.mockResolvedValue({ address: '0xHumanAddress', signature: '0xHumanSignature' });
    mockPrepareInputs.mockResolvedValue({ field: 'prepared', user_signature: '0xHumanSignature' });
    const params = { circuit, action: CUSTOM_ACTION };
    const schema = z.object(toolHandlers.prepare_inputs.schema as z.ZodRawShape);
    expect(schema.parse(params)).toEqual(params);
    const result = await callTool('prepare_inputs', schema.parse(params));
    expect(result.isError).toBeUndefined();
    expect(mockSigner.signTypedData).not.toHaveBeenCalled();
    expect(mockSigner.signMessage).not.toHaveBeenCalled();
    const domainSeparator = ethers.TypedDataEncoder.hashDomain(CUSTOM_ACTION.domain);
    const actionHash = ethers.TypedDataEncoder.hashStruct('Instruction', CUSTOM_ACTION.types, CUSTOM_ACTION.message);
    expect(mockPrepareInputs).toHaveBeenCalledWith(testConfig, expect.objectContaining({
      circuitId: circuit, userAddress: '0xHumanAddress', userSignature: '0xHumanSignature', domainSeparator, actionHash,
    }));
    expect(parseToolResult(result)).toMatchObject({ prepared_inputs_id: expect.any(String), domain_separator: domainSeparator, action_hash: actionHash });
    expect(JSON.stringify(result)).not.toContain('0xHumanSignature');
    mockSubmitProof.mockResolvedValue({ proof: '0xproof' });
    const submit = await callTool('submit_proof', { circuit, prepared_inputs_id: parseToolResult(result).prepared_inputs_id, nonce: '0xnonce' });
    expect(parseToolResult(submit)).toEqual({ proof: '0xproof' });
    expect(mockSubmitProof.mock.lastCall?.[1].inputs).toMatchObject({ field: 'prepared', user_signature: '0xHumanSignature', action_hash: actionHash });
  });

  it.each(['arc_eligibility', 'giwa_attestation'])('%s without action signs only the request signal hash', async (circuit) => {
    mockPrepareInputs.mockResolvedValue({ field: 'prepared' });
    const schema = z.object(toolHandlers.prepare_inputs.schema as z.ZodRawShape);
    const params = schema.parse({ circuit, scope: 'optional-action-scope' });
    const result = await callTool('prepare_inputs', params);
    expect(result.isError).toBeUndefined();
    expect(mockComputeSignalHash).toHaveBeenCalledWith('0xMockAttestationAddress', 'optional-action-scope', circuit);
    expect(mockSigner.signMessage).toHaveBeenCalledWith('0xsignalhash');
    expect(mockSigner.signTypedData).not.toHaveBeenCalled();
    expect(mockPrepareInputs).toHaveBeenCalledWith(testConfig, expect.objectContaining({ circuitId: circuit, userSignature: '0xmocksignature' }));
    expect(mockPrepareInputs.mock.calls[0][1]).not.toHaveProperty('actionHash');
    expect(mockPrepareInputs.mock.calls[0][1]).not.toHaveProperty('domainSeparator');
    expect(parseToolResult(result)).toEqual({ field: 'prepared' });
    expect(() => schema.parse({ circuit, action: null })).toThrow();
  });

  it.each([
    ['GIWA missing field', 'giwa_attestation', { ...CUSTOM_ACTION, message: {} }, /missing/],
    ['missing field', 'arc_eligibility', { ...CUSTOM_ACTION, message: {} }, /missing/],
    ['malformed value', 'arc_eligibility', { ...CUSTOM_ACTION, message: { ...CUSTOM_ACTION.message, terms: { quantity: 'bad', description: 'bad' } } }, /./],
    ['wrong root', 'arc_eligibility', { ...CUSTOM_ACTION, primaryType: 'Terms', message: { quantity: '1', description: 'bad' } }, /primaryType.*root|root.*primaryType/],
    ['Coinbase action', 'coinbase_kyc', CUSTOM_ACTION, /only arc_eligibility|rejected/],
    ['OIDC action', 'oidc_domain', CUSTOM_ACTION, /only arc_eligibility|rejected/],
  ])('rejects %s before any signing or input preparation', async (_name, circuit, action, error) => {
    const result = await callTool('prepare_inputs', { circuit, action });
    expect(result.isError).toBe(true);
    expect(parseToolResult(result).error).toMatch(error as RegExp);
    expect(mockSigner.getAddress).not.toHaveBeenCalled();
    expect(mockSigner.signMessage).not.toHaveBeenCalled();
    expect(mockSigner.signTypedData).not.toHaveBeenCalled();
    expect(mockPrepareInputs).not.toHaveBeenCalled();
    expect(mockPrepareOidcPayload).not.toHaveBeenCalled();
  });

  it('omits action hashes for ordinary circuits', async () => {
    mockPrepareInputs.mockResolvedValue({ field: 'prepared' });
    const result = await callTool('prepare_inputs', { circuit: 'coinbase_kyc' });
    expect(parseToolResult(result)).toEqual({ field: 'prepared' });
    expect(mockPrepareInputs.mock.calls[0][1]).not.toHaveProperty('domainSeparator');
    expect(mockPrepareInputs.mock.calls[0][1]).not.toHaveProperty('actionHash');
    expect(mockSigner.signTypedData).not.toHaveBeenCalled();
  });
});


it('snapshots the MCP action before waiting for human approval', async () => {
  const action = structuredClone(CUSTOM_ACTION);
  const approved = structuredClone(action);
  mockResolveApproval.mockImplementationOnce(async () => {
    action.message.terms.quantity = '999';
    return { address: '0xHumanAddress', signature: '0xHumanSignature' };
  });
  mockPrepareInputs.mockResolvedValue({ field: 'prepared' });
  const result = await callTool('prepare_inputs', { circuit: 'arc_eligibility', action });
  expect(result.isError).toBeUndefined();
  expect(mockResolveApproval.mock.calls[0][1].action).toEqual(approved);
  expect(mockSigner.signTypedData).not.toHaveBeenCalled();
  expect(parseToolResult(result).action_hash).toBe(ethers.TypedDataEncoder.hashStruct(approved.primaryType, approved.types, approved.message));
});


const BOOLEAN_ACTION = {
  ...CUSTOM_ACTION,
  types: {
    Instruction: [{ name: 'terms', type: 'Terms' }, { name: 'batches', type: 'Terms[][]' }],
    Terms: [{ name: 'enabled', type: 'bool' }],
  },
  message: { terms: { enabled: true }, batches: [[{ enabled: false }], [{ enabled: true }]] },
};

describe('nested action field validation in MCP', () => {
  it.each([
    ['missing bool', { ...BOOLEAN_ACTION.message, terms: {} }],
    ['string bool', { ...BOOLEAN_ACTION.message, terms: { enabled: 'false' } }],
    ['number bool', { ...BOOLEAN_ACTION.message, terms: { enabled: 0 } }],
    ['object bool', { ...BOOLEAN_ACTION.message, terms: { enabled: {} } }],
    ['missing bool in nested array', { ...BOOLEAN_ACTION.message, batches: [[{}]] }],
    ['malformed bool in nested array', { ...BOOLEAN_ACTION.message, batches: [[{ enabled: 'false' }]] }],
  ])('rejects %s before local signing', async (_name, message) => {
    const result = await callTool('prepare_inputs', { circuit: 'arc_eligibility', action: { ...BOOLEAN_ACTION, message } });
    expect(result.isError).toBe(true);
    expect(parseToolResult(result).error).toMatch(/action.message.*enabled.*required|action.message.*enabled.*boolean/);
    expect(mockSigner.getAddress).not.toHaveBeenCalled();
    expect(mockSigner.signTypedData).not.toHaveBeenCalled();
    expect(mockSigner.signMessage).not.toHaveBeenCalled();
    expect(mockPrepareInputs).not.toHaveBeenCalled();
  });

  it('preserves actual booleans in custom nested structs and arrays', async () => {
    mockResolveApproval.mockResolvedValue({ address: '0xHumanAddress', signature: '0xHumanSignature' });
    mockPrepareInputs.mockResolvedValue({ field: 'prepared' });
    const result = await callTool('prepare_inputs', { circuit: 'arc_eligibility', action: BOOLEAN_ACTION });
    expect(result.isError).toBeUndefined();
    expect(mockResolveApproval.mock.calls[0][1].action).toEqual(BOOLEAN_ACTION);
    expect(mockSigner.signTypedData).not.toHaveBeenCalled();
    expect(parseToolResult(result).action_hash).toBe(ethers.TypedDataEncoder.hashStruct('Instruction', BOOLEAN_ACTION.types, BOOLEAN_ACTION.message));
  });
});
