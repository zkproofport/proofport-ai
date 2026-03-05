/**
 * TEE Key Exchange — X25519 ECDH + AES-256-GCM
 *
 * Provides end-to-end encryption between clients and the TEE (Nitro Enclave).
 * The server (Node.js host) acts as a blind relay — it cannot decrypt the payload.
 *
 * Protocol:
 * 1. TEE generates X25519 key pair on startup, binds public key to NSM attestation
 * 2. Client fetches TEE public key + verifies attestation
 * 3. Client: ephemeral X25519 keypair → ECDH(ephemeralPrivate, teePubKey) → SHA-256 → AES-256-GCM
 * 4. Client sends { ephemeralPublicKey, iv, ciphertext, authTag, keyId }
 * 5. Server passes encrypted blob to TEE (blind relay)
 * 6. TEE: ECDH(teePrivate, ephemeralPubKey) → SHA-256 → AES-256-GCM decrypt
 */

import {
  createHash,
  generateKeyPairSync,
  diffieHellman,
  randomBytes,
  createCipheriv,
  createDecipheriv,
  createPublicKey,
  KeyObject,
} from 'crypto';

// ─── Types ──────────────────────────────────────────────────────────────

export interface EncryptedEnvelope {
  ephemeralPublicKey: string; // hex-encoded 32 bytes
  iv: string;                 // hex-encoded 12 bytes
  ciphertext: string;         // hex-encoded
  authTag: string;            // hex-encoded 16 bytes
  keyId: string;              // first 16 hex chars of SHA-256(teePublicKey)
}

export interface TeePublicKeyInfo {
  publicKey: string;             // hex-encoded 32 bytes X25519 public key
  keyId: string;                 // SHA-256(publicKey)[:16] for key rotation detection
  attestationDocument?: string;  // base64-encoded COSE Sign1 (absent in local/disabled mode)
}

// ─── Key Derivation ─────────────────────────────────────────────────────

/**
 * Derive AES-256 key from X25519 shared secret using SHA-256.
 */
function deriveAesKey(sharedSecret: Buffer): Buffer {
  return createHash('sha256').update(sharedSecret).digest();
}

/**
 * Compute keyId from a public key: first 16 hex chars of SHA-256(publicKeyBytes).
 */
export function computeKeyId(publicKeyHex: string): string {
  const pubBytes = Buffer.from(publicKeyHex, 'hex');
  return createHash('sha256').update(pubBytes).digest('hex').slice(0, 16);
}

// ─── Internal helper ────────────────────────────────────────────────────

/**
 * ASN.1 DER header for X25519 SubjectPublicKeyInfo (SPKI).
 * Fixed 12-byte prefix: SEQUENCE { SEQUENCE { OID 1.3.101.110 } BIT STRING }
 * OID 1.3.101.110 = id-X25519
 */
const X25519_SPKI_HEADER = Buffer.from('302a300506032b656e032100', 'hex');

/**
 * Import raw 32-byte X25519 public key bytes as a KeyObject.
 */
function importX25519PublicKey(rawKeyHex: string): KeyObject {
  const rawBytes = Buffer.from(rawKeyHex, 'hex');
  const der = Buffer.concat([X25519_SPKI_HEADER, rawBytes]);
  return createPublicKey({ key: der, format: 'der', type: 'spki' });
}

// ─── Encryption (Client-side) ───────────────────────────────────────────

/**
 * Encrypt a plaintext payload for the TEE.
 *
 * Generates an ephemeral X25519 key pair, performs ECDH with the TEE's public key,
 * derives an AES-256-GCM key, and encrypts the payload.
 *
 * @param plaintext - The data to encrypt (e.g., JSON string of { circuitId, proverToml })
 * @param teePublicKeyHex - TEE's X25519 public key (hex-encoded, 32 bytes)
 * @returns EncryptedEnvelope ready to send to server
 */
export function encryptForTee(plaintext: string, teePublicKeyHex: string): EncryptedEnvelope {
  // Generate ephemeral X25519 key pair
  const { publicKey: ephemeralPublic, privateKey: ephemeralPrivate } = generateKeyPairSync('x25519');

  // Extract raw 32-byte public key from SPKI DER (12-byte header + 32-byte key)
  const ephemeralPublicDer = ephemeralPublic.export({ type: 'spki', format: 'der' }) as Buffer;
  const ephemeralPublicRaw = ephemeralPublicDer.subarray(12);

  // Import TEE public key
  const teePublicKeyObj = importX25519PublicKey(teePublicKeyHex);

  // ECDH: compute shared secret
  const sharedSecret = diffieHellman({ publicKey: teePublicKeyObj, privateKey: ephemeralPrivate });

  // Derive AES-256 key via SHA-256
  const aesKey = deriveAesKey(sharedSecret);

  // AES-256-GCM encrypt (IV = 12 bytes for GCM)
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', aesKey, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    ephemeralPublicKey: ephemeralPublicRaw.toString('hex'),
    iv: iv.toString('hex'),
    ciphertext: encrypted.toString('hex'),
    authTag: authTag.toString('hex'),
    keyId: computeKeyId(teePublicKeyHex),
  };
}

// ─── Decryption (TEE-side, used for testing) ────────────────────────────

/**
 * Decrypt an encrypted envelope (for testing purposes on host side).
 * In production, decryption happens inside the TEE (Python enclave-server.py).
 *
 * @param envelope - The encrypted envelope
 * @param teePrivateKey - TEE's X25519 private key (KeyObject)
 * @returns Decrypted plaintext string
 */
export function decryptFromTee(envelope: EncryptedEnvelope, teePrivateKey: KeyObject): string {
  // Import ephemeral public key from raw hex
  const ephemeralPublicKeyObj = importX25519PublicKey(envelope.ephemeralPublicKey);

  // ECDH: compute shared secret
  const sharedSecret = diffieHellman({ publicKey: ephemeralPublicKeyObj, privateKey: teePrivateKey });

  // Derive AES-256 key via SHA-256
  const aesKey = deriveAesKey(sharedSecret);

  // AES-256-GCM decrypt
  const iv = Buffer.from(envelope.iv, 'hex');
  const ciphertext = Buffer.from(envelope.ciphertext, 'hex');
  const authTag = Buffer.from(envelope.authTag, 'hex');

  const decipher = createDecipheriv('aes-256-gcm', aesKey, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

  return decrypted.toString('utf8');
}

// ─── Serialization ──────────────────────────────────────────────────────

/**
 * Serialize an EncryptedEnvelope to a base64 string for transport.
 */
export function serializeEnvelope(envelope: EncryptedEnvelope): string {
  return Buffer.from(JSON.stringify(envelope)).toString('base64');
}

/**
 * Deserialize a base64 string back to an EncryptedEnvelope.
 */
export function deserializeEnvelope(base64: string): EncryptedEnvelope {
  return JSON.parse(Buffer.from(base64, 'base64').toString('utf8')) as EncryptedEnvelope;
}
