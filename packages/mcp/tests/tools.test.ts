import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock @zkproofport-ai/sdk ──────────────────────────────────────────────────
const mockGenerateProof = vi.fn();
const mockRequestChallenge = vi.fn();
const mockPrepareInputs = vi.fn();
const mockMakePayment = vi.fn();
const mockSubmitProof = vi.fn();
const mockVerifyOnChain = vi.fn();
const mockComputeSignalHash = vi.fn().mockReturnValue('0xsignalhash');

vi.mock('@zkproofport-ai/sdk', () => ({
  generateProof: mockGenerateProof,
  requestChallenge: mockRequestChallenge,
  prepareInputs: mockPrepareInputs,
  makePayment: mockMakePayment,
  submitProof: mockSubmitProof,
  verifyProof: mockVerifyOnChain,
  computeSignalHash: mockComputeSignalHash,
  CIRCUITS: {
    coinbase_attestation: { displayName: 'Coinbase KYC', easSchemaId: '0xschema1', functionSelector: '0xfunc1' },
    coinbase_country_attestation: { displayName: 'Coinbase Country', easSchemaId: '0xschema2', functionSelector: '0xfunc2' },
  },
  AUTHORIZED_SIGNERS: ['0x952f32128AF084422539C4Ff96df5C525322E564'],
  CIRCUIT_NAME_MAP: {
    coinbase_kyc: 'coinbase_attestation',
    coinbase_country: 'coinbase_country_attestation',
  },
  USDC_ADDRESSES: {
    'base-sepolia': '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    'base': '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
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
  easRpcUrl: 'https://mainnet.base.org',
};

const mockSigner = {
  getAddress: vi.fn().mockReturnValue('0xMockAttestationAddress'),
  signMessage: vi.fn().mockResolvedValue('0xmocksignature'),
  signTypedData: vi.fn().mockResolvedValue('0xmocktypeddata'),
  sendTransaction: vi.fn().mockResolvedValue({ hash: '0xtxhash', wait: async () => ({ status: 1 }) }),
};

const mockPaymentSigner = {
  getAddress: vi.fn().mockReturnValue('0xMockPaymentAddress'),
  signMessage: vi.fn().mockResolvedValue('0xpaysignature'),
  signTypedData: vi.fn().mockResolvedValue('0xpaytypeddata'),
  sendTransaction: vi.fn().mockResolvedValue({ hash: '0xpaytxhash', wait: async () => ({ status: 1 }) }),
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

  // Re-apply default mock return values after clearAllMocks
  mockSigner.getAddress.mockReturnValue('0xMockAttestationAddress');
  mockSigner.signMessage.mockResolvedValue('0xmocksignature');
  mockSigner.signTypedData.mockResolvedValue('0xmocktypeddata');
  mockSigner.sendTransaction.mockResolvedValue({ hash: '0xtxhash', wait: async () => ({ status: 1 }) });

  mockPaymentSigner.getAddress.mockReturnValue('0xMockPaymentAddress');
  mockPaymentSigner.signMessage.mockResolvedValue('0xpaysignature');
  mockPaymentSigner.signTypedData.mockResolvedValue('0xpaytypeddata');
  mockPaymentSigner.sendTransaction.mockResolvedValue({ hash: '0xpaytxhash', wait: async () => ({ status: 1 }) });

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
  registerTools(mockServer as any, testConfig as any, mockSigner as any, mockPaymentSigner as any);
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('registerTools', () => {
  it('registers all 7 tools', () => {
    expect(mockServer.tool).toHaveBeenCalledTimes(7);
    const registeredNames = Object.keys(toolHandlers);
    expect(registeredNames).toContain('generate_proof');
    expect(registeredNames).toContain('get_supported_circuits');
    expect(registeredNames).toContain('request_challenge');
    expect(registeredNames).toContain('prepare_inputs');
    expect(registeredNames).toContain('make_payment');
    expect(registeredNames).toContain('submit_proof');
    expect(registeredNames).toContain('verify_proof');
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
    expect(data.authorized_signers).toEqual(['0x952f32128AF084422539C4Ff96df5C525322E564']);
    expect(result.isError).toBeUndefined();
  });
});

describe('generate_proof', () => {
  it('calls generateProof with correct params', async () => {
    const mockResult = { proof: '0xabc', publicInputs: '0xdef', paymentTxHash: '0x123' };
    mockGenerateProof.mockResolvedValue(mockResult);

    const result = await callTool('generate_proof', {
      circuit: 'coinbase_kyc',
      scope: 'test-scope',
    });

    expect(mockGenerateProof).toHaveBeenCalledOnce();
    const [passedConfig, passedWallets, passedParams, passedOpts] = mockGenerateProof.mock.calls[0];
    expect(passedConfig).toEqual(testConfig);
    expect(passedWallets).toEqual({ attestation: mockSigner, payment: mockPaymentSigner });
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
    const mockChallenge = { nonce: '0xnonce', payTo: '0xrecipient', amount: 100000 };
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

describe('make_payment', () => {
  it('calls makePayment with mockPaymentSigner and correct PaymentInfo', async () => {
    mockMakePayment.mockResolvedValue('0xtxhash123');

    const result = await callTool('make_payment', {
      nonce: '0xpaymentnonce',
      recipient: '0xrecipientaddr',
      amount: 100000,
      asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      network: 'base-sepolia',
      instruction: 'Pay $0.10 for proof generation',
    });

    expect(mockMakePayment).toHaveBeenCalledOnce();
    const [signer, paymentInfo] = mockMakePayment.mock.calls[0];
    expect(signer).toBe(mockPaymentSigner);
    expect(paymentInfo).toEqual({
      nonce: '0xpaymentnonce',
      recipient: '0xrecipientaddr',
      amount: 100000,
      asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      network: 'base-sepolia',
      instruction: 'Pay $0.10 for proof generation',
    });

    const data = parseToolResult(result);
    expect(data.tx_hash).toBe('0xtxhash123');
  });

  it('uses paymentSigner when available (not attestation signer)', async () => {
    mockMakePayment.mockResolvedValue('0xtx');

    await callTool('make_payment', {
      nonce: '0x1',
      recipient: '0xaddr',
      amount: 100000,
      asset: '0xusdc',
      network: 'base-sepolia',
      instruction: 'pay',
    });

    const [signer] = mockMakePayment.mock.calls[0];
    expect(signer).toBe(mockPaymentSigner);
  });

  it('returns error on failure', async () => {
    mockMakePayment.mockRejectedValue(new Error('insufficient USDC'));

    const result = await callTool('make_payment', {
      nonce: '0x1',
      recipient: '0xaddr',
      amount: 100000,
      asset: '0xusdc',
      network: 'base-sepolia',
      instruction: 'pay',
    });

    expect(result.isError).toBe(true);
    const data = parseToolResult(result);
    expect(data.error).toBe('insufficient USDC');
  });
});

describe('submit_proof', () => {
  it('calls submitProof with correct circuit, inputs, payment info', async () => {
    const mockResult = { proof: '0xproof', publicInputs: '0xinputs' };
    mockSubmitProof.mockResolvedValue(mockResult);

    const inputs = { attestation: '0xdata' };
    const result = await callTool('submit_proof', {
      circuit: 'coinbase_kyc',
      inputs,
      payment_tx_hash: '0xtxhash',
      payment_nonce: '0xnonce',
    });

    expect(mockSubmitProof).toHaveBeenCalledWith(testConfig, {
      circuit: 'coinbase_kyc',
      inputs,
      paymentTxHash: '0xtxhash',
      paymentNonce: '0xnonce',
    });

    const data = parseToolResult(result);
    expect(data.proof).toBe('0xproof');
  });

  it('parses JSON string inputs', async () => {
    mockSubmitProof.mockResolvedValue({ proof: '0x' });

    const inputsObj = { field: 'value' };
    await callTool('submit_proof', {
      circuit: 'coinbase_country',
      inputs: JSON.stringify(inputsObj),
      payment_tx_hash: '0xtx',
      payment_nonce: '0xnonce',
    });

    const passedArgs = mockSubmitProof.mock.calls[0][1];
    expect(passedArgs.inputs).toEqual(inputsObj);
  });

  it('returns error on failure', async () => {
    mockSubmitProof.mockRejectedValue(new Error('proof submission timeout'));

    const result = await callTool('submit_proof', {
      circuit: 'coinbase_kyc',
      inputs: '{}',
      payment_tx_hash: '0x1',
      payment_nonce: '0x2',
    });

    expect(result.isError).toBe(true);
    const data = parseToolResult(result);
    expect(data.error).toBe('proof submission timeout');
  });
});

describe('verify_proof', () => {
  it('calls verifyProof with verification info', async () => {
    mockVerifyOnChain.mockResolvedValue({ valid: true });

    await callTool('verify_proof', {
      proof: '0xproofbytes',
      public_inputs: '0xinputs',
      verifier_address: '0x0036B61dBFaB8f3CfEEF77dD5D45F7EFBFE2035c',
      chain_id: 84532,
      rpc_url: 'https://sepolia.base.org',
    });

    expect(mockVerifyOnChain).toHaveBeenCalledOnce();
    const passedArg = mockVerifyOnChain.mock.calls[0][0];
    expect(passedArg.verification.chainId).toBe(84532);
    expect(passedArg.verification.verifierAddress).toBe('0x0036B61dBFaB8f3CfEEF77dD5D45F7EFBFE2035c');
    expect(passedArg.verification.rpcUrl).toBe('https://sepolia.base.org');
    expect(passedArg.proof).toBe('0xproofbytes');
    expect(passedArg.publicInputs).toBe('0xinputs');
  });

  it('returns verification result', async () => {
    mockVerifyOnChain.mockResolvedValue({ valid: true });

    const result = await callTool('verify_proof', {
      proof: '0xproof',
      public_inputs: '0xinputs',
      verifier_address: '0xaddr',
      chain_id: 84532,
      rpc_url: 'https://sepolia.base.org',
    });

    const data = parseToolResult(result);
    expect(data.valid).toBe(true);
  });

  it('returns error on failure', async () => {
    mockVerifyOnChain.mockRejectedValue(new Error('contract call reverted'));

    const result = await callTool('verify_proof', {
      proof: '0xproof',
      public_inputs: '0xinputs',
      verifier_address: '0xaddr',
      chain_id: 84532,
      rpc_url: 'https://sepolia.base.org',
    });

    expect(result.isError).toBe(true);
    const data = parseToolResult(result);
    expect(data.error).toBe('contract call reverted');
  });
});

describe('proofport://config resource', () => {
  it('returns config with wallet addresses and supported circuits', async () => {
    const result = await callResource('config');

    expect(result.contents).toHaveLength(1);
    expect(result.contents[0].uri).toBe('proofport://config');
    expect(result.contents[0].mimeType).toBe('application/json');

    const data = JSON.parse(result.contents[0].text);
    expect(data.baseUrl).toBe(testConfig.baseUrl);
    expect(data.easRpcUrl).toBe(testConfig.easRpcUrl);
    expect(data.attestationWalletAddress).toBe('0xMockAttestationAddress');
    expect(data.paymentWalletAddress).toBe('0xMockPaymentAddress');
    expect(data.supportedCircuits).toBeDefined();
    expect(data.supportedCircuits.coinbase_attestation).toBeDefined();
  });
});
