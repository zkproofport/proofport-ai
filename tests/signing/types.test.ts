import { describe, it, expect } from 'vitest';
import type {
  SigningMethod,
  SigningRequest,
  SigningResult,
  SigningProvider,
  SigningRequestRecord,
} from '../../src/signing/types';

describe('Signing Types', () => {
  describe('SigningRequest', () => {
    it('should accept valid privy signing request', () => {
      const request: SigningRequest = {
        address: '0x1234567890123456789012345678901234567890',
        signalHash: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
        scope: 'zkproofport:kyc:v1',
        method: 'privy',
      };
      expect(request.method).toBe('privy');
      expect(request.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    });

    it('should accept valid web signing request', () => {
      const request: SigningRequest = {
        address: '0xaabbccdd00112233445566778899aabbccddeeff',
        signalHash: '0x1111111111111111111111111111111111111111111111111111111111111111',
        scope: 'zkproofport:country:v1',
        method: 'web',
      };
      expect(request.method).toBe('web');
    });

    it('should accept valid eip7702 signing request', () => {
      const request: SigningRequest = {
        address: '0xdeadbeef00000000000000000000000000000001',
        signalHash: '0x2222222222222222222222222222222222222222222222222222222222222222',
        scope: 'zkproofport:kyc:v1',
        method: 'eip7702',
      };
      expect(request.method).toBe('eip7702');
    });
  });

  describe('SigningResult', () => {
    it('should accept valid signing result', () => {
      const result: SigningResult = {
        signature: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
        address: '0x1234567890123456789012345678901234567890',
        method: 'privy',
      };
      expect(result.method).toBe('privy');
      expect(result.address).toMatch(/^0x/);
      expect(result.signature).toMatch(/^0x/);
    });
  });

  describe('SigningProvider interface', () => {
    it('should be implementable', () => {
      const mockProvider: SigningProvider = {
        method: 'privy',
        sign: async (request: SigningRequest) => ({
          signature: '0x' + 'ab'.repeat(64),
          address: request.address,
          method: 'privy',
        }),
        isAvailable: async (_address: string) => true,
      };

      expect(mockProvider.method).toBe('privy');
      expect(typeof mockProvider.sign).toBe('function');
      expect(typeof mockProvider.isAvailable).toBe('function');
    });

    it('sign returns correct SigningResult shape', async () => {
      const mockProvider: SigningProvider = {
        method: 'web',
        sign: async (request) => ({
          signature: '0x' + 'cd'.repeat(64),
          address: request.address,
          method: 'web',
        }),
        isAvailable: async () => true,
      };

      const result = await mockProvider.sign({
        address: '0x1234567890123456789012345678901234567890',
        signalHash: '0x' + 'ff'.repeat(32),
        scope: 'test-scope',
        method: 'web',
      });

      expect(result.signature).toBeDefined();
      expect(result.address).toBe('0x1234567890123456789012345678901234567890');
      expect(result.method).toBe('web');
    });

    it('isAvailable returns boolean', async () => {
      const mockProvider: SigningProvider = {
        method: 'eip7702',
        sign: async () => ({ signature: '0x', address: '0x', method: 'eip7702' }),
        isAvailable: async (address) => address.startsWith('0x'),
      };

      expect(await mockProvider.isAvailable('0xabc')).toBe(true);
      expect(await mockProvider.isAvailable('invalid')).toBe(false);
    });
  });

  describe('SigningRequestRecord', () => {
    it('should accept valid pending record', () => {
      const record: SigningRequestRecord = {
        id: '550e8400-e29b-41d4-a716-446655440000',
        address: '0x1234567890123456789012345678901234567890',
        signalHash: '0x' + 'aa'.repeat(32),
        scope: 'zkproofport:kyc:v1',
        status: 'pending',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 300000).toISOString(),
      };
      expect(record.status).toBe('pending');
      expect(record.signature).toBeUndefined();
    });

    it('should accept valid completed record with signature', () => {
      const record: SigningRequestRecord = {
        id: '550e8400-e29b-41d4-a716-446655440001',
        address: '0x1234567890123456789012345678901234567890',
        signalHash: '0x' + 'bb'.repeat(32),
        scope: 'zkproofport:country:v1',
        status: 'completed',
        signature: '0x' + 'cc'.repeat(64),
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 300000).toISOString(),
      };
      expect(record.status).toBe('completed');
      expect(record.signature).toBeDefined();
    });

    it('should accept expired status', () => {
      const record: SigningRequestRecord = {
        id: '550e8400-e29b-41d4-a716-446655440002',
        address: '0x1234567890123456789012345678901234567890',
        signalHash: '0x' + 'dd'.repeat(32),
        scope: 'zkproofport:kyc:v1',
        status: 'expired',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      };
      expect(record.status).toBe('expired');
    });
  });

  describe('SigningMethod type', () => {
    it('accepts all valid methods', () => {
      const methods: SigningMethod[] = ['privy', 'web', 'eip7702'];
      expect(methods).toHaveLength(3);
      expect(methods).toContain('privy');
      expect(methods).toContain('web');
      expect(methods).toContain('eip7702');
    });
  });
});
