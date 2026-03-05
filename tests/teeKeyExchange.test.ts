import { describe, it, expect } from 'vitest';
import { generateKeyPairSync } from 'crypto';
import {
  encryptForTee,
  decryptFromTee,
  computeKeyId,
  serializeEnvelope,
  deserializeEnvelope,
} from '../src/tee/teeKeyExchange';

// Helper: generate X25519 keypair and extract raw public key hex
function generateTestKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  const pubDer = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  const pubRaw = pubDer.subarray(12);
  return { publicKeyHex: pubRaw.toString('hex'), privateKey, publicKey };
}

describe('teeKeyExchange', () => {
  describe('encrypt/decrypt roundtrip', () => {
    it('should encrypt and decrypt successfully', () => {
      const { publicKeyHex, privateKey } = generateTestKeyPair();
      const plaintext = JSON.stringify({ circuitId: 'coinbase_attestation', proverToml: 'signal_hash = [0xab]' });

      const envelope = encryptForTee(plaintext, publicKeyHex);
      const decrypted = decryptFromTee(envelope, privateKey);

      expect(decrypted).toBe(plaintext);
    });

    it('should work with large payloads', () => {
      const { publicKeyHex, privateKey } = generateTestKeyPair();
      const largePlaintext = 'x'.repeat(100_000);

      const envelope = encryptForTee(largePlaintext, publicKeyHex);
      const decrypted = decryptFromTee(envelope, privateKey);

      expect(decrypted).toBe(largePlaintext);
    });

    it('should produce different ciphertext for same plaintext (ephemeral keys)', () => {
      const { publicKeyHex } = generateTestKeyPair();
      const plaintext = 'same data';

      const envelope1 = encryptForTee(plaintext, publicKeyHex);
      const envelope2 = encryptForTee(plaintext, publicKeyHex);

      expect(envelope1.ciphertext).not.toBe(envelope2.ciphertext);
      expect(envelope1.ephemeralPublicKey).not.toBe(envelope2.ephemeralPublicKey);
      expect(envelope1.iv).not.toBe(envelope2.iv);
    });
  });

  describe('decryption with wrong key', () => {
    it('should fail to decrypt with a different private key', () => {
      const keyPair1 = generateTestKeyPair();
      const keyPair2 = generateTestKeyPair();

      const envelope = encryptForTee('secret data', keyPair1.publicKeyHex);

      expect(() => decryptFromTee(envelope, keyPair2.privateKey)).toThrow();
    });

    it('should fail with tampered ciphertext', () => {
      const { publicKeyHex, privateKey } = generateTestKeyPair();
      const envelope = encryptForTee('secret data', publicKeyHex);

      // Tamper with ciphertext
      const tampered = { ...envelope, ciphertext: 'ff'.repeat(envelope.ciphertext.length / 2) };
      expect(() => decryptFromTee(tampered, privateKey)).toThrow();
    });

    it('should fail with tampered authTag', () => {
      const { publicKeyHex, privateKey } = generateTestKeyPair();
      const envelope = encryptForTee('secret data', publicKeyHex);

      const tampered = { ...envelope, authTag: '00'.repeat(16) };
      expect(() => decryptFromTee(tampered, privateKey)).toThrow();
    });
  });

  describe('computeKeyId', () => {
    it('should return first 16 hex chars of SHA-256', () => {
      const { publicKeyHex } = generateTestKeyPair();
      const keyId = computeKeyId(publicKeyHex);

      expect(keyId).toHaveLength(16);
      expect(keyId).toMatch(/^[0-9a-f]{16}$/);
    });

    it('should be deterministic', () => {
      const { publicKeyHex } = generateTestKeyPair();
      expect(computeKeyId(publicKeyHex)).toBe(computeKeyId(publicKeyHex));
    });

    it('should match keyId in encrypted envelope', () => {
      const { publicKeyHex } = generateTestKeyPair();
      const envelope = encryptForTee('data', publicKeyHex);
      expect(envelope.keyId).toBe(computeKeyId(publicKeyHex));
    });

    it('should differ for different keys', () => {
      const key1 = generateTestKeyPair();
      const key2 = generateTestKeyPair();
      expect(computeKeyId(key1.publicKeyHex)).not.toBe(computeKeyId(key2.publicKeyHex));
    });
  });

  describe('envelope serialization', () => {
    it('should serialize and deserialize roundtrip', () => {
      const { publicKeyHex } = generateTestKeyPair();
      const envelope = encryptForTee('test payload', publicKeyHex);

      const serialized = serializeEnvelope(envelope);
      expect(typeof serialized).toBe('string');

      const deserialized = deserializeEnvelope(serialized);
      expect(deserialized).toEqual(envelope);
    });

    it('should produce valid base64', () => {
      const { publicKeyHex } = generateTestKeyPair();
      const envelope = encryptForTee('test', publicKeyHex);

      const serialized = serializeEnvelope(envelope);
      expect(() => Buffer.from(serialized, 'base64')).not.toThrow();
      expect(Buffer.from(serialized, 'base64').toString('base64')).toBe(serialized);
    });
  });

  describe('envelope fields', () => {
    it('should have correct field formats', () => {
      const { publicKeyHex } = generateTestKeyPair();
      const envelope = encryptForTee('data', publicKeyHex);

      // ephemeralPublicKey: 32 bytes = 64 hex chars
      expect(envelope.ephemeralPublicKey).toMatch(/^[0-9a-f]{64}$/);

      // iv: 12 bytes = 24 hex chars
      expect(envelope.iv).toMatch(/^[0-9a-f]{24}$/);

      // authTag: 16 bytes = 32 hex chars
      expect(envelope.authTag).toMatch(/^[0-9a-f]{32}$/);

      // keyId: 16 hex chars
      expect(envelope.keyId).toMatch(/^[0-9a-f]{16}$/);

      // ciphertext: non-empty hex
      expect(envelope.ciphertext).toMatch(/^[0-9a-f]+$/);
      expect(envelope.ciphertext.length).toBeGreaterThan(0);
    });
  });
});
