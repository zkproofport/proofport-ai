import { describe, it, expect } from 'vitest';
import type { SimplifiedProofRequest, ProofResult, ProverResponse } from '../src/types/index.js';

describe('Type Definitions', () => {
  describe('SimplifiedProofRequest', () => {
    it('should accept valid coinbase_attestation request', () => {
      const request: SimplifiedProofRequest = {
        circuit: 'coinbase_attestation',
        address: '0x1234567890123456789012345678901234567890',
        signature: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
        scope: 'test-scope',
      };

      expect(request.circuit).toBe('coinbase_attestation');
      expect(request.address).toBeDefined();
      expect(request.signature).toBeDefined();
      expect(request.scope).toBeDefined();
    });

    it('should accept valid coinbase_country_attestation request', () => {
      const request: SimplifiedProofRequest = {
        circuit: 'coinbase_country_attestation',
        address: '0x1234567890123456789012345678901234567890',
        signature: '0xabcdef',
        scope: 'test-scope',
        countryList: ['US', 'CA'],
        isIncluded: true,
      };

      expect(request.circuit).toBe('coinbase_country_attestation');
      expect(request.countryList).toEqual(['US', 'CA']);
      expect(request.isIncluded).toBe(true);
    });
  });

  describe('ProofResult', () => {
    it('should accept valid proof result', () => {
      const result: ProofResult = {
        proof: '0xabcdef',
        publicInputs: ['0x123', '0x456'],
        nullifier: '0x789abc',
        circuit: 'coinbase_attestation',
        verifierAddress: '0x0036B61dBFaB8f3CfEEF77dD5D45F7EFBFE2035c',
        chainId: 84532,
      };

      expect(result.proof).toBeDefined();
      expect(result.publicInputs).toHaveLength(2);
      expect(result.nullifier).toBeDefined();
      expect(result.circuit).toBe('coinbase_attestation');
      expect(result.verifierAddress).toBeDefined();
      expect(result.chainId).toBe(84532);
    });
  });

  describe('ProverResponse', () => {
    it('should accept valid prover response', () => {
      const response: ProverResponse = {
        proof: '0xabcdef',
        publicInputs: '0x123456',
        proofWithInputs: '0x123456abcdef',
      };

      expect(response.proof).toBeDefined();
      expect(response.publicInputs).toBeDefined();
      expect(response.proofWithInputs).toBeDefined();
    });
  });
});
