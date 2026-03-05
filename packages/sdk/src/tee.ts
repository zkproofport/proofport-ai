/**
 * TEE E2E Encryption -- Client-side X25519 ECDH + AES-256-GCM
 */

import {
  createHash,
  generateKeyPairSync,
  diffieHellman,
  randomBytes,
  createCipheriv,
  createPublicKey,
} from 'crypto';

// ─── Types ──────────────────────────────────────────────────────────────

export interface EncryptedEnvelope {
  ephemeralPublicKey: string;
  iv: string;
  ciphertext: string;
  authTag: string;
  keyId: string;
}

// ─── Encryption ─────────────────────────────────────────────────────────

const X25519_SPKI_HEADER = Buffer.from('302a300506032b656e032100', 'hex');

function computeKeyId(publicKeyHex: string): string {
  return createHash('sha256').update(Buffer.from(publicKeyHex, 'hex')).digest('hex').slice(0, 16);
}

/**
 * Encrypt a payload for the TEE using X25519 ECDH + AES-256-GCM.
 */
export function encryptForTee(plaintext: string, teePublicKeyHex: string): EncryptedEnvelope {
  const { publicKey: ephPublic, privateKey: ephPrivate } = generateKeyPairSync('x25519');
  const ephPublicDer = ephPublic.export({ type: 'spki', format: 'der' }) as Buffer;
  const ephPublicRaw = ephPublicDer.subarray(12);

  const teePubDer = Buffer.concat([X25519_SPKI_HEADER, Buffer.from(teePublicKeyHex, 'hex')]);
  const teePubKeyObj = createPublicKey({ key: teePubDer, format: 'der', type: 'spki' });

  const shared = diffieHellman({ publicKey: teePubKeyObj, privateKey: ephPrivate });
  const aesKey = createHash('sha256').update(shared).digest();

  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', aesKey, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    ephemeralPublicKey: ephPublicRaw.toString('hex'),
    iv: iv.toString('hex'),
    ciphertext: encrypted.toString('hex'),
    authTag: authTag.toString('hex'),
    keyId: computeKeyId(teePublicKeyHex),
  };
}
