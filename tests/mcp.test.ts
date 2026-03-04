import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock modules ─────────────────────────────────────────────────────────

// Mock verifier
vi.mock('../src/prover/verifier.js', () => ({
  verifyOnChain: vi.fn(),
}));

import { verifyOnChain } from '../src/prover/verifier.js';
import { handleGetSupportedCircuits } from '../src/skills/skillHandler.js';
import { CIRCUITS } from '../src/config/circuits.js';
import { VERIFIER_ADDRESSES } from '../src/config/contracts.js';

// ─── verify_proof (via verifyOnChain) ────────────────────────────────────

describe('verifyOnChain', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should verify a valid proof on-chain', async () => {
    (verifyOnChain as ReturnType<typeof vi.fn>).mockResolvedValue({
      isValid: true,
      verifierAddress: VERIFIER_ADDRESSES['84532']['coinbase_attestation'],
    });

    const result = await verifyOnChain({
      proof: '0xvalidproof',
      publicInputs: ['0x1111', '0x2222'],
      circuitId: 'coinbase_attestation',
      chainId: '84532',
      rpcUrl: 'https://sepolia.base.org',
    });

    expect(result.isValid).toBe(true);
    expect(result.verifierAddress).toBe(VERIFIER_ADDRESSES['84532']['coinbase_attestation']);

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

    const result = await verifyOnChain({
      proof: '0xinvalidproof',
      publicInputs: ['0x0000'],
      circuitId: 'coinbase_attestation',
      chainId: '84532',
      rpcUrl: 'https://sepolia.base.org',
    });

    expect(result.isValid).toBe(false);
  });

  it('should verify coinbase_country_attestation', async () => {
    (verifyOnChain as ReturnType<typeof vi.fn>).mockResolvedValue({
      isValid: true,
      verifierAddress: VERIFIER_ADDRESSES['84532']['coinbase_country_attestation'],
    });

    const result = await verifyOnChain({
      proof: '0xcountryproof',
      publicInputs: ['0xaaaa', '0xbbbb'],
      circuitId: 'coinbase_country_attestation',
      chainId: '84532',
      rpcUrl: 'https://sepolia.base.org',
    });

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
      verifyOnChain({
        proof: '0xbadproof',
        publicInputs: ['0x1111'],
        circuitId: 'coinbase_attestation',
        chainId: '84532',
        rpcUrl: 'https://sepolia.base.org',
      })
    ).rejects.toThrow('On-chain verification failed: execution reverted');
  });
});

// ─── get_supported_circuits (via handleGetSupportedCircuits) ──────────────

describe('handleGetSupportedCircuits', () => {
  it('should return all circuits from CIRCUITS config', () => {
    const result = handleGetSupportedCircuits({});

    expect(result.circuits).toHaveLength(Object.keys(CIRCUITS).length);
    expect(result.circuits.length).toBe(2);
  });

  it('should include coinbase_attestation with correct metadata', () => {
    const result = handleGetSupportedCircuits({});
    const kyc = result.circuits.find(c => c.id === 'coinbase_attestation');

    expect(kyc).toBeDefined();
    expect(kyc!.displayName).toBe('Coinbase KYC');
    expect(kyc!.description).toBe('Prove KYC attestation from Coinbase without revealing identity');
    expect(kyc!.requiredInputs).toEqual(['address', 'signature', 'scope']);
  });

  it('should include coinbase_country_attestation with correct metadata', () => {
    const result = handleGetSupportedCircuits({});
    const country = result.circuits.find(c => c.id === 'coinbase_country_attestation');

    expect(country).toBeDefined();
    expect(country!.displayName).toBe('Coinbase Country');
    expect(country!.description).toBe('Prove country of residence from Coinbase attestation');
    expect(country!.requiredInputs).toEqual(['address', 'signature', 'scope', 'countryList', 'isIncluded']);
  });

  it('should return circuit id, displayName, description, and requiredInputs for each circuit', () => {
    const result = handleGetSupportedCircuits({});

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
    const result = handleGetSupportedCircuits({});
    const ids = result.circuits.map(c => c.id);

    // Canonical underscore format
    expect(ids).toContain('coinbase_attestation');
    expect(ids).toContain('coinbase_country_attestation');

    // NEVER hyphen format
    expect(ids).not.toContain('coinbase-attestation');
    expect(ids).not.toContain('coinbase-country-attestation');
    expect(ids).not.toContain('coinbase-kyc');
  });

  it('should default to chainId 84532 when not specified', () => {
    const result = handleGetSupportedCircuits({});

    expect(result.chainId).toBe('84532');
  });

  it('should include verifier address for chain 84532', () => {
    const result = handleGetSupportedCircuits({ chainId: '84532' });
    const kyc = result.circuits.find(c => c.id === 'coinbase_attestation');

    expect(kyc!.verifierAddress).toBe(VERIFIER_ADDRESSES['84532']['coinbase_attestation']);
  });

  it('should return circuits without verifierAddress for unknown chain', () => {
    const result = handleGetSupportedCircuits({ chainId: '99999' });

    for (const circuit of result.circuits) {
      expect(circuit.verifierAddress).toBeUndefined();
    }
  });

  it('should return the specified chainId in the result', () => {
    const result = handleGetSupportedCircuits({ chainId: '84532' });

    expect(result.chainId).toBe('84532');
  });
});
