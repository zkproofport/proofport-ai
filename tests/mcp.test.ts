import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock modules ─────────────────────────────────────────────────────────

// Mock inputBuilder
vi.mock('../src/input/inputBuilder.js', () => ({
  computeCircuitParams: vi.fn(),
}));

// Mock bbProver
vi.mock('../src/prover/bbProver.js', () => ({
  BbProver: vi.fn().mockImplementation(() => ({
    prove: vi.fn(),
  })),
}));

// Mock verifier
vi.mock('../src/prover/verifier.js', () => ({
  verifyOnChain: vi.fn(),
}));

import { computeCircuitParams } from '../src/input/inputBuilder.js';
import { BbProver } from '../src/prover/bbProver.js';
import { verifyOnChain } from '../src/prover/verifier.js';
import { generateProof } from '../src/mcp/tools/generateProof.js';
import { verifyProof } from '../src/mcp/tools/verifyProof.js';
import { getSupportedCircuits } from '../src/mcp/tools/getCircuits.js';
import { CIRCUITS } from '../src/config/circuits.js';
import { VERIFIER_ADDRESSES } from '../src/config/contracts.js';

// ─── generate_proof ───────────────────────────────────────────────────────

describe('generateProof', () => {
  const mockProve = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    (BbProver as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      prove: mockProve,
    }));
  });

  const deps = {
    easGraphqlEndpoint: 'https://base.easscan.org/graphql',
    rpcUrls: ['https://mainnet.base.org'],
    bbPath: '/usr/local/bin/bb-wrapper',
    nargoPath: '/usr/local/bin/nargo',
    circuitsDir: '/app/circuits',
  };

  it('should generate a proof for coinbase_attestation', async () => {
    const mockParams = {
      signalHash: new Uint8Array([0x95, 0x71]),
      nullifierBytes: new Uint8Array([0xc8, 0xde]),
      merkleRoot: '0xb60d',
      scopeBytes: new Uint8Array([0x89]),
      userAddress: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
      userSignature: '0xsig123',
      userPubkeyX: '0x2cab',
      userPubkeyY: '0x26ef',
      rawTxBytes: [0x02],
      txLength: 1,
      attesterPubkeyX: '0x8b12',
      attesterPubkeyY: '0xe734',
      merkleProof: ['0x1fb8'],
      merkleLeafIndex: 0,
      merkleDepth: 1,
    };

    const mockProverResponse = {
      proof: '0xproofbytes',
      publicInputs: '0xpublicinputs',
    };

    (computeCircuitParams as ReturnType<typeof vi.fn>).mockResolvedValue(mockParams);
    mockProve.mockResolvedValue(mockProverResponse);

    const result = await generateProof(
      {
        address: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
        signature: '0xsig123',
        scope: 'test-scope',
        circuitId: 'coinbase_attestation',
      },
      deps,
    );

    expect(result.proof).toBe('0xproofbytes');
    expect(result.publicInputs).toBe('0xpublicinputs');
    expect(result.nullifier).toBe('0xc8de');
    expect(result.signalHash).toBe('0x9571');

    // Verify computeCircuitParams was called correctly
    expect(computeCircuitParams).toHaveBeenCalledWith(
      {
        address: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
        signature: '0xsig123',
        scope: 'test-scope',
        circuitId: 'coinbase_attestation',
        countryList: undefined,
        isIncluded: undefined,
      },
      'https://base.easscan.org/graphql',
      ['https://mainnet.base.org'],
    );

    // Verify BbProver was instantiated with the correct paths
    expect(BbProver).toHaveBeenCalledWith({
      bbPath: '/usr/local/bin/bb-wrapper',
      nargoPath: '/usr/local/bin/nargo',
      circuitsDir: '/app/circuits',
    });

    // Verify prove was called with circuitId and params
    expect(mockProve).toHaveBeenCalledWith('coinbase_attestation', mockParams);
  });

  it('should generate a proof for coinbase_country_attestation with country fields', async () => {
    const mockParams = {
      signalHash: new Uint8Array([0xaa, 0xbb]),
      nullifierBytes: new Uint8Array([0xcc, 0xdd]),
      merkleRoot: '0xroot123',
      scopeBytes: new Uint8Array([0x99]),
      userAddress: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
      userSignature: '0xsig456',
      userPubkeyX: '0xpubx',
      userPubkeyY: '0xpuby',
      rawTxBytes: [0x02],
      txLength: 1,
      attesterPubkeyX: '0xattpubx',
      attesterPubkeyY: '0xattpuby',
      merkleProof: ['0xproof1'],
      merkleLeafIndex: 0,
      merkleDepth: 1,
      countryListBytes: new Uint8Array([85, 83, 0, 0]),
      isIncluded: 1,
    };

    const mockProverResponse = {
      proof: '0xcountryproof',
      publicInputs: '0xcountrypublic',
    };

    (computeCircuitParams as ReturnType<typeof vi.fn>).mockResolvedValue(mockParams);
    mockProve.mockResolvedValue(mockProverResponse);

    const result = await generateProof(
      {
        address: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
        signature: '0xsig456',
        scope: 'country-scope',
        circuitId: 'coinbase_country_attestation',
        countryList: ['US', 'KR'],
        isIncluded: true,
      },
      deps,
    );

    expect(result.proof).toBe('0xcountryproof');
    expect(result.nullifier).toBe('0xccdd');

    // Verify country fields were passed through
    expect(computeCircuitParams).toHaveBeenCalledWith(
      expect.objectContaining({
        circuitId: 'coinbase_country_attestation',
        countryList: ['US', 'KR'],
        isIncluded: true,
      }),
      expect.any(String),
      expect.any(Array),
    );
  });

  it('should throw for unknown circuitId', async () => {
    await expect(
      generateProof(
        {
          address: '0xabc',
          signature: '0xsig',
          scope: 'scope',
          circuitId: 'unknown_circuit',
        },
        deps,
      )
    ).rejects.toThrow('Unknown circuit: unknown_circuit');
  });

  it('should propagate computeCircuitParams errors', async () => {
    (computeCircuitParams as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Attestation not found for address')
    );

    await expect(
      generateProof(
        {
          address: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
          signature: '0xsig',
          scope: 'scope',
          circuitId: 'coinbase_attestation',
        },
        deps,
      )
    ).rejects.toThrow('Attestation not found for address');
  });

  it('should propagate prover errors', async () => {
    const mockParams = {
      signalHash: new Uint8Array([0x11, 0x11]),
      nullifierBytes: new Uint8Array([0x00, 0x00]),
      merkleRoot: '0xroot',
      scopeBytes: new Uint8Array([0x01]),
      userAddress: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
      userSignature: '0xsig',
      userPubkeyX: '0xpubx',
      userPubkeyY: '0xpuby',
      rawTxBytes: [0x02],
      txLength: 1,
      attesterPubkeyX: '0xattpubx',
      attesterPubkeyY: '0xattpuby',
      merkleProof: ['0xproof1'],
      merkleLeafIndex: 0,
      merkleDepth: 1,
    };

    (computeCircuitParams as ReturnType<typeof vi.fn>).mockResolvedValue(mockParams);
    mockProve.mockRejectedValue(new Error('bb proof generation failed'));

    await expect(
      generateProof(
        {
          address: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
          signature: '0xsig',
          scope: 'scope',
          circuitId: 'coinbase_attestation',
        },
        deps,
      )
    ).rejects.toThrow('bb proof generation failed');
  });
});

// ─── generate_proof with Redis integration ────────────────────────────────

describe('generateProof with RateLimiter and ProofCache', () => {
  const mockProve = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    (BbProver as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      prove: mockProve,
    }));
  });

  const baseDeps = {
    easGraphqlEndpoint: 'https://base.easscan.org/graphql',
    rpcUrls: ['https://mainnet.base.org'],
    bbPath: '/usr/local/bin/bb-wrapper',
    nargoPath: '/usr/local/bin/nargo',
    circuitsDir: '/app/circuits',
  };

  const baseInput = {
    address: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
    signature: '0xsig123',
    scope: 'test-scope',
    circuitId: 'coinbase_attestation',
  };

  it('should throw when rate limit exceeded', async () => {
    const mockRateLimiter = {
      check: vi.fn().mockResolvedValue({ allowed: false, remaining: 0, limit: 10, retryAfter: 45 }),
    };

    await expect(
      generateProof(baseInput, { ...baseDeps, rateLimiter: mockRateLimiter as any }),
    ).rejects.toThrow('Rate limit exceeded. Retry after 45 seconds.');

    // Should NOT call computeCircuitParams when rate limited
    expect(computeCircuitParams).not.toHaveBeenCalled();
  });

  it('should return cached result when cache hit', async () => {
    const cachedResult = {
      proof: '0xcachedproof',
      publicInputs: '0xcachedpublic',
      nullifier: '0xcachednull',
      signalHash: '0xcachedsig',
    };

    const mockRateLimiter = {
      check: vi.fn().mockResolvedValue({ allowed: true, remaining: 9, limit: 10 }),
    };
    const mockProofCache = {
      get: vi.fn().mockResolvedValue(cachedResult),
      set: vi.fn(),
    };

    const result = await generateProof(baseInput, {
      ...baseDeps,
      rateLimiter: mockRateLimiter as any,
      proofCache: mockProofCache as any,
    });

    expect(result.proof).toBe('0xcachedproof');
    expect(result.cached).toBe(true);
    // Should NOT call computeCircuitParams on cache hit
    expect(computeCircuitParams).not.toHaveBeenCalled();
    // Should NOT call proofCache.set on cache hit
    expect(mockProofCache.set).not.toHaveBeenCalled();
  });

  it('should generate and cache proof on cache miss', async () => {
    const mockParams = {
      signalHash: new Uint8Array([0xaa, 0xbb]),
      nullifierBytes: new Uint8Array([0xcc, 0xdd]),
      merkleRoot: '0xroot',
      scopeBytes: new Uint8Array([0x01]),
      userAddress: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
      userSignature: '0xsig123',
      userPubkeyX: '0xpubx',
      userPubkeyY: '0xpuby',
      rawTxBytes: [0x02],
      txLength: 1,
      attesterPubkeyX: '0xattpubx',
      attesterPubkeyY: '0xattpuby',
      merkleProof: ['0xproof1'],
      merkleLeafIndex: 0,
      merkleDepth: 1,
    };

    (computeCircuitParams as ReturnType<typeof vi.fn>).mockResolvedValue(mockParams);
    mockProve.mockResolvedValue({ proof: '0xnewproof', publicInputs: '0xnewpublic' });

    const mockRateLimiter = {
      check: vi.fn().mockResolvedValue({ allowed: true, remaining: 8, limit: 10 }),
    };
    const mockProofCache = {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn(),
    };

    const result = await generateProof(baseInput, {
      ...baseDeps,
      rateLimiter: mockRateLimiter as any,
      proofCache: mockProofCache as any,
    });

    expect(result.proof).toBe('0xnewproof');
    expect(result.cached).toBeUndefined();
    // Should cache the result
    expect(mockProofCache.set).toHaveBeenCalledWith(
      'coinbase_attestation',
      { address: baseInput.address, scope: baseInput.scope, countryList: undefined, isIncluded: undefined },
      expect.objectContaining({ proof: '0xnewproof' }),
    );
  });

  it('should work without Redis deps (backward compatible)', async () => {
    const mockParams = {
      signalHash: new Uint8Array([0x11]),
      nullifierBytes: new Uint8Array([0x22]),
      merkleRoot: '0xroot',
      scopeBytes: new Uint8Array([0x01]),
      userAddress: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
      userSignature: '0xsig123',
      userPubkeyX: '0xpubx',
      userPubkeyY: '0xpuby',
      rawTxBytes: [0x02],
      txLength: 1,
      attesterPubkeyX: '0xattpubx',
      attesterPubkeyY: '0xattpuby',
      merkleProof: ['0xproof1'],
      merkleLeafIndex: 0,
      merkleDepth: 1,
    };

    (computeCircuitParams as ReturnType<typeof vi.fn>).mockResolvedValue(mockParams);
    mockProve.mockResolvedValue({ proof: '0xproof', publicInputs: '0xpublic' });

    // No rateLimiter or proofCache — should still work
    const result = await generateProof(baseInput, baseDeps);

    expect(result.proof).toBe('0xproof');
    expect(result.cached).toBeUndefined();
  });
});

// ─── verify_proof ─────────────────────────────────────────────────────────

describe('verifyProof', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const deps = {
    rpcUrl: 'https://sepolia.base.org',
    defaultChainId: '84532',
  };

  it('should verify a valid proof on-chain', async () => {
    (verifyOnChain as ReturnType<typeof vi.fn>).mockResolvedValue({
      isValid: true,
      verifierAddress: VERIFIER_ADDRESSES['84532']['coinbase_attestation'],
    });

    const result = await verifyProof(
      {
        proof: '0xvalidproof',
        publicInputs: ['0x1111', '0x2222'],
        circuitId: 'coinbase_attestation',
        chainId: '84532',
      },
      deps,
    );

    expect(result.isValid).toBe(true);
    expect(result.verifierAddress).toBe(VERIFIER_ADDRESSES['84532']['coinbase_attestation']);
    expect(result.chainId).toBe('84532');

    // Verify verifyOnChain was called correctly
    expect(verifyOnChain).toHaveBeenCalledWith({
      proof: '0xvalidproof',
      publicInputs: ['0x1111', '0x2222'],
      circuitId: 'coinbase_attestation',
      chainId: '84532',
      rpcUrl: 'https://sepolia.base.org',
    });
  });

  it('should return isValid: false for invalid proof', async () => {
    (verifyOnChain as ReturnType<typeof vi.fn>).mockResolvedValue({
      isValid: false,
      verifierAddress: VERIFIER_ADDRESSES['84532']['coinbase_attestation'],
    });

    const result = await verifyProof(
      {
        proof: '0xinvalidproof',
        publicInputs: ['0x0000'],
        circuitId: 'coinbase_attestation',
      },
      deps,
    );

    expect(result.isValid).toBe(false);
  });

  it('should use default chainId when not provided', async () => {
    (verifyOnChain as ReturnType<typeof vi.fn>).mockResolvedValue({
      isValid: true,
      verifierAddress: VERIFIER_ADDRESSES['84532']['coinbase_attestation'],
    });

    const result = await verifyProof(
      {
        proof: '0xproof',
        publicInputs: ['0x1111'],
        circuitId: 'coinbase_attestation',
        // no chainId
      },
      deps,
    );

    expect(result.chainId).toBe('84532');
    expect(verifyOnChain).toHaveBeenCalledWith(
      expect.objectContaining({ chainId: '84532' }),
    );
  });

  it('should throw for unknown circuitId', async () => {
    await expect(
      verifyProof(
        {
          proof: '0xproof',
          publicInputs: ['0x1111'],
          circuitId: 'nonexistent_circuit',
        },
        deps,
      )
    ).rejects.toThrow('Unknown circuit: nonexistent_circuit');
  });

  it('should throw for unknown chainId', async () => {
    await expect(
      verifyProof(
        {
          proof: '0xproof',
          publicInputs: ['0x1111'],
          circuitId: 'coinbase_attestation',
          chainId: '99999',
        },
        deps,
      )
    ).rejects.toThrow('No verifier deployed for circuit "coinbase_attestation" on chain "99999"');
  });

  it('should verify coinbase_country_attestation', async () => {
    (verifyOnChain as ReturnType<typeof vi.fn>).mockResolvedValue({
      isValid: true,
      verifierAddress: VERIFIER_ADDRESSES['84532']['coinbase_country_attestation'],
    });

    const result = await verifyProof(
      {
        proof: '0xcountryproof',
        publicInputs: ['0xaaaa', '0xbbbb'],
        circuitId: 'coinbase_country_attestation',
        chainId: '84532',
      },
      deps,
    );

    expect(result.isValid).toBe(true);
    expect(result.verifierAddress).toBe(
      VERIFIER_ADDRESSES['84532']['coinbase_country_attestation']
    );
  });

  it('should propagate on-chain verification errors', async () => {
    (verifyOnChain as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('On-chain verification failed: execution reverted')
    );

    await expect(
      verifyProof(
        {
          proof: '0xbadproof',
          publicInputs: ['0x1111'],
          circuitId: 'coinbase_attestation',
          chainId: '84532',
        },
        deps,
      )
    ).rejects.toThrow('On-chain verification failed: execution reverted');
  });
});

// ─── get_supported_circuits ───────────────────────────────────────────────

describe('getSupportedCircuits', () => {
  it('should return all circuits from CIRCUITS config', () => {
    const result = getSupportedCircuits();

    expect(result.circuits).toHaveLength(Object.keys(CIRCUITS).length);
    expect(result.circuits.length).toBe(2);
  });

  it('should include coinbase_attestation with correct metadata', () => {
    const result = getSupportedCircuits();
    const kyc = result.circuits.find(c => c.id === 'coinbase_attestation');

    expect(kyc).toBeDefined();
    expect(kyc!.displayName).toBe('Coinbase KYC');
    expect(kyc!.description).toBe('Prove KYC attestation from Coinbase without revealing identity');
    expect(kyc!.requiredInputs).toEqual(['address', 'signature', 'scope']);
  });

  it('should include coinbase_country_attestation with correct metadata', () => {
    const result = getSupportedCircuits();
    const country = result.circuits.find(c => c.id === 'coinbase_country_attestation');

    expect(country).toBeDefined();
    expect(country!.displayName).toBe('Coinbase Country');
    expect(country!.description).toBe('Prove country of residence from Coinbase attestation');
    expect(country!.requiredInputs).toEqual(['address', 'signature', 'scope', 'countryList', 'isIncluded']);
  });

  it('should return circuit id, displayName, description, and requiredInputs for each circuit', () => {
    const result = getSupportedCircuits();

    for (const circuit of result.circuits) {
      expect(circuit).toHaveProperty('id');
      expect(circuit).toHaveProperty('displayName');
      expect(circuit).toHaveProperty('description');
      expect(circuit).toHaveProperty('requiredInputs');
      expect(typeof circuit.id).toBe('string');
      expect(typeof circuit.displayName).toBe('string');
      expect(typeof circuit.description).toBe('string');
      expect(Array.isArray(circuit.requiredInputs)).toBe(true);
    }
  });

  it('should use canonical circuit names (underscore format)', () => {
    const result = getSupportedCircuits();
    const ids = result.circuits.map(c => c.id);

    // Canonical underscore format
    expect(ids).toContain('coinbase_attestation');
    expect(ids).toContain('coinbase_country_attestation');

    // NEVER hyphen format
    expect(ids).not.toContain('coinbase-attestation');
    expect(ids).not.toContain('coinbase-country-attestation');
    expect(ids).not.toContain('coinbase-kyc');
  });
});
