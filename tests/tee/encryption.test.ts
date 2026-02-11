import { describe, it, expect } from 'vitest';

describe('TEE Encryption', () => {
  let encryptProofData: any;
  let decryptProofData: any;
  let generateEncryptionKey: any;

  beforeEach(async () => {
    const module = await import('../../src/tee/encryption.js');
    encryptProofData = module.encryptProofData;
    decryptProofData = module.decryptProofData;
    generateEncryptionKey = module.generateEncryptionKey;
  });

  describe('generateEncryptionKey()', () => {
    it('should generate 32-byte key', () => {
      const key = generateEncryptionKey();
      expect(key).toBeInstanceOf(Buffer);
      expect(key.length).toBe(32);
    });

    it('should generate unique keys', () => {
      const key1 = generateEncryptionKey();
      const key2 = generateEncryptionKey();
      expect(key1.equals(key2)).toBe(false);
    });
  });

  describe('encryptProofData()', () => {
    it('should encrypt proof and public inputs', () => {
      const key = generateEncryptionKey();
      const proof = '0x1234567890abcdef';
      const publicInputs = ['0x01', '0x02', '0x03'];

      const encrypted = encryptProofData(proof, publicInputs, key);
      expect(encrypted.iv).toBeInstanceOf(Buffer);
      expect(encrypted.iv.length).toBe(16);
      expect(encrypted.encryptedData).toBeInstanceOf(Buffer);
      expect(encrypted.authTag).toBeInstanceOf(Buffer);
      expect(encrypted.authTag.length).toBe(16);
    });

    it('should produce different ciphertext for same plaintext with different keys', () => {
      const key1 = generateEncryptionKey();
      const key2 = generateEncryptionKey();
      const proof = '0xabcd';
      const publicInputs = ['0x01'];

      const encrypted1 = encryptProofData(proof, publicInputs, key1);
      const encrypted2 = encryptProofData(proof, publicInputs, key2);
      expect(encrypted1.encryptedData.equals(encrypted2.encryptedData)).toBe(false);
    });

    it('should produce different ciphertext with different IVs', () => {
      const key = generateEncryptionKey();
      const proof = '0xabcd';
      const publicInputs = ['0x01'];

      const encrypted1 = encryptProofData(proof, publicInputs, key);
      const encrypted2 = encryptProofData(proof, publicInputs, key);
      expect(encrypted1.iv.equals(encrypted2.iv)).toBe(false);
      expect(encrypted1.encryptedData.equals(encrypted2.encryptedData)).toBe(false);
    });

    it('should handle empty public inputs', () => {
      const key = generateEncryptionKey();
      const proof = '0x1234';
      const publicInputs: string[] = [];

      const encrypted = encryptProofData(proof, publicInputs, key);
      expect(encrypted.encryptedData.length).toBeGreaterThan(0);
    });

    it('should handle long proof data', () => {
      const key = generateEncryptionKey();
      const proof = '0x' + 'a'.repeat(10000);
      const publicInputs = ['0x01'];

      const encrypted = encryptProofData(proof, publicInputs, key);
      expect(encrypted.encryptedData.length).toBeGreaterThan(5000);
    });
  });

  describe('decryptProofData()', () => {
    it('should decrypt to original data', () => {
      const key = generateEncryptionKey();
      const proof = '0x1234567890abcdef';
      const publicInputs = ['0x01', '0x02', '0x03'];

      const encrypted = encryptProofData(proof, publicInputs, key);
      const decrypted = decryptProofData(encrypted, key);

      expect(decrypted.proof).toBe(proof);
      expect(decrypted.publicInputs).toEqual(publicInputs);
    });

    it('should fail with wrong key', () => {
      const key1 = generateEncryptionKey();
      const key2 = generateEncryptionKey();
      const proof = '0xabcd';
      const publicInputs = ['0x01'];

      const encrypted = encryptProofData(proof, publicInputs, key1);
      expect(() => decryptProofData(encrypted, key2)).toThrow();
    });

    it('should fail with tampered ciphertext', () => {
      const key = generateEncryptionKey();
      const proof = '0xabcd';
      const publicInputs = ['0x01'];

      const encrypted = encryptProofData(proof, publicInputs, key);

      // Tamper with encrypted data
      encrypted.encryptedData[0] ^= 0xFF;

      expect(() => decryptProofData(encrypted, key)).toThrow();
    });

    it('should fail with tampered auth tag', () => {
      const key = generateEncryptionKey();
      const proof = '0xabcd';
      const publicInputs = ['0x01'];

      const encrypted = encryptProofData(proof, publicInputs, key);

      // Tamper with auth tag
      encrypted.authTag[0] ^= 0xFF;

      expect(() => decryptProofData(encrypted, key)).toThrow();
    });

    it('should handle empty public inputs in decryption', () => {
      const key = generateEncryptionKey();
      const proof = '0x1234';
      const publicInputs: string[] = [];

      const encrypted = encryptProofData(proof, publicInputs, key);
      const decrypted = decryptProofData(encrypted, key);

      expect(decrypted.proof).toBe(proof);
      expect(decrypted.publicInputs).toEqual([]);
    });

    it('should handle long proof data in decryption', () => {
      const key = generateEncryptionKey();
      const proof = '0x' + 'a'.repeat(10000);
      const publicInputs = ['0x01'];

      const encrypted = encryptProofData(proof, publicInputs, key);
      const decrypted = decryptProofData(encrypted, key);

      expect(decrypted.proof).toBe(proof);
      expect(decrypted.publicInputs).toEqual(publicInputs);
    });
  });

  describe('Round-trip encryption', () => {
    it('should preserve data through encrypt/decrypt cycle', () => {
      const key = generateEncryptionKey();
      const testCases = [
        { proof: '0x1234', publicInputs: ['0x01'] },
        { proof: '0xabcdef', publicInputs: ['0x01', '0x02', '0x03', '0x04'] },
        { proof: '0x' + 'f'.repeat(1000), publicInputs: ['0x99', '0xaa', '0xbb'] },
      ];

      for (const testCase of testCases) {
        const encrypted = encryptProofData(testCase.proof, testCase.publicInputs, key);
        const decrypted = decryptProofData(encrypted, key);

        expect(decrypted.proof).toBe(testCase.proof);
        expect(decrypted.publicInputs).toEqual(testCase.publicInputs);
      }
    });
  });
});
