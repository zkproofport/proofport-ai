import { describe, it, expect } from 'vitest';
import { getTaskOutcome } from '../../src/skills/flowGuidance.js';
import type {
  RequestSigningResult,
  CheckStatusResult,
  RequestPaymentResult,
  GenerateProofResult,
  VerifyProofResult,
  GetSupportedCircuitsResult,
} from '../../src/skills/skillHandler.js';

describe('getTaskOutcome', () => {
  describe('request_signing', () => {
    it('returns input-required with signing URL guidance', () => {
      const result: RequestSigningResult = {
        requestId: 'test-req-123',
        signingUrl: 'https://example.com/sign/test-req-123',
        expiresAt: '2025-01-01T00:00:00Z',
        circuitId: 'coinbase_attestation',
        scope: 'test-scope',
      };
      const outcome = getTaskOutcome('request_signing', result);
      expect(outcome.state).toBe('input-required');
      expect(outcome.guidance).toContain('test-req-123');
      expect(outcome.guidance).toContain('https://example.com/sign/test-req-123');
    });
  });

  describe('check_status', () => {
    it('phase=signing returns input-required mentioning wallet signature', () => {
      const result: CheckStatusResult = {
        requestId: 'req-signing',
        phase: 'signing',
        signing: { status: 'pending' },
        payment: { status: 'not_required' },
        expiresAt: '2025-01-01T00:00:00Z',
      };
      const outcome = getTaskOutcome('check_status', result);
      expect(outcome.state).toBe('input-required');
      expect(outcome.guidance).toContain('Waiting for wallet signature');
    });

    it('phase=payment returns input-required mentioning payment required', () => {
      const result: CheckStatusResult = {
        requestId: 'req-payment',
        phase: 'payment',
        signing: { status: 'completed', address: '0xabc' },
        payment: { status: 'pending' },
        expiresAt: '2025-01-01T00:00:00Z',
      };
      const outcome = getTaskOutcome('check_status', result);
      expect(outcome.state).toBe('input-required');
      expect(outcome.guidance).toContain('Payment is required');
    });

    it('phase=ready returns completed mentioning all prerequisites met', () => {
      const result: CheckStatusResult = {
        requestId: 'req-ready',
        phase: 'ready',
        signing: { status: 'completed', address: '0xabc' },
        payment: { status: 'completed' },
        expiresAt: '2025-01-01T00:00:00Z',
      };
      const outcome = getTaskOutcome('check_status', result);
      expect(outcome.state).toBe('completed');
      expect(outcome.guidance).toContain('All prerequisites met');
    });

    it('phase=expired returns failed mentioning expired', () => {
      const result: CheckStatusResult = {
        requestId: 'req-expired',
        phase: 'expired',
        signing: { status: 'pending' },
        payment: { status: 'not_required' },
        expiresAt: '2020-01-01T00:00:00Z',
      };
      const outcome = getTaskOutcome('check_status', result);
      expect(outcome.state).toBe('failed');
      expect(outcome.guidance).toContain('expired');
    });
  });

  describe('request_payment', () => {
    it('returns input-required with payment URL in guidance', () => {
      const result: RequestPaymentResult = {
        requestId: 'req-pay-456',
        paymentUrl: 'https://example.com/pay/req-pay-456',
        amount: '$0.10',
        currency: 'USDC',
        network: 'Base Sepolia',
      };
      const outcome = getTaskOutcome('request_payment', result);
      expect(outcome.state).toBe('input-required');
      expect(outcome.guidance).toContain('https://example.com/pay/req-pay-456');
    });
  });

  describe('generate_proof', () => {
    it('returns completed with proofId in guidance', () => {
      const result: GenerateProofResult = {
        proof: '0xdeadbeef',
        publicInputs: '0x1234',
        nullifier: '0xnull',
        signalHash: '0xsig',
        proofId: 'proof-abc-789',
        verifyUrl: 'https://example.com/v/proof-abc-789',
      };
      const outcome = getTaskOutcome('generate_proof', result);
      expect(outcome.state).toBe('completed');
      expect(outcome.guidance).toContain('proof-abc-789');
    });
  });

  describe('verify_proof', () => {
    it('returns completed mentioning valid when proof is valid', () => {
      const result: VerifyProofResult = {
        valid: true,
        circuitId: 'coinbase_attestation',
        verifierAddress: '0xVerifier',
        chainId: '84532',
      };
      const outcome = getTaskOutcome('verify_proof', result);
      expect(outcome.state).toBe('completed');
      expect(outcome.guidance).toContain('valid');
    });

    it('returns completed mentioning invalid when proof is invalid', () => {
      const result: VerifyProofResult = {
        valid: false,
        circuitId: 'coinbase_attestation',
        verifierAddress: '0xVerifier',
        chainId: '84532',
      };
      const outcome = getTaskOutcome('verify_proof', result);
      expect(outcome.state).toBe('completed');
      expect(outcome.guidance).toContain('invalid');
    });
  });

  describe('get_supported_circuits', () => {
    it('returns completed mentioning Found with circuit count', () => {
      const result: GetSupportedCircuitsResult = {
        circuits: [
          {
            id: 'coinbase_attestation',
            displayName: 'Coinbase KYC',
            description: 'Prove Coinbase KYC attestation',
            requiredInputs: ['address', 'signature', 'scope'],
          },
          {
            id: 'coinbase_country_attestation',
            displayName: 'Coinbase Country',
            description: 'Prove country attestation',
            requiredInputs: ['address', 'signature', 'scope', 'countryList', 'isIncluded'],
          },
        ],
        chainId: '84532',
      };
      const outcome = getTaskOutcome('get_supported_circuits', result);
      expect(outcome.state).toBe('completed');
      expect(outcome.guidance).toContain('Found');
    });
  });

  describe('unknown skill', () => {
    it('returns completed and includes the skill name in guidance', () => {
      const outcome = getTaskOutcome('some_unknown_skill', {});
      expect(outcome.state).toBe('completed');
      expect(outcome.guidance).toContain('some_unknown_skill');
    });
  });
});
