/**
 * TEE encryption utilities for protecting proof data in transit
 * Uses AES-256-GCM for authenticated encryption
 */

import { randomBytes, createCipheriv, createDecipheriv } from 'crypto';

export interface EncryptedProofData {
  iv: Buffer;
  encryptedData: Buffer;
  authTag: Buffer;
}

export interface DecryptedProofData {
  proof: string;
  publicInputs: string[];
}

/**
 * Generate a random 256-bit encryption key
 * @returns 32-byte encryption key
 */
export function generateEncryptionKey(): Buffer {
  return randomBytes(32);
}

/**
 * Encrypt proof data using AES-256-GCM
 * @param proof Proof hex string
 * @param publicInputs Public inputs array
 * @param key 32-byte encryption key
 * @returns Encrypted data with IV and auth tag
 */
export function encryptProofData(
  proof: string,
  publicInputs: string[],
  key: Buffer
): EncryptedProofData {
  // Serialize proof and public inputs as JSON
  const plaintext = JSON.stringify({ proof, publicInputs });

  // Generate random IV (12 bytes for GCM)
  const iv = randomBytes(16);

  // Create cipher
  const cipher = createCipheriv('aes-256-gcm', key, iv);

  // Encrypt data
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);

  // Get auth tag
  const authTag = cipher.getAuthTag();

  return {
    iv,
    encryptedData: encrypted,
    authTag,
  };
}

/**
 * Decrypt proof data using AES-256-GCM
 * @param encrypted Encrypted proof data
 * @param key 32-byte encryption key
 * @returns Decrypted proof and public inputs
 * @throws Error if decryption fails or authentication fails
 */
export function decryptProofData(encrypted: EncryptedProofData, key: Buffer): DecryptedProofData {
  try {
    // Create decipher
    const decipher = createDecipheriv('aes-256-gcm', key, encrypted.iv);

    // Set auth tag
    decipher.setAuthTag(encrypted.authTag);

    // Decrypt data
    const decrypted = Buffer.concat([
      decipher.update(encrypted.encryptedData),
      decipher.final(),
    ]);

    // Parse JSON
    const plaintext = decrypted.toString('utf8');
    const data = JSON.parse(plaintext);

    return {
      proof: data.proof,
      publicInputs: data.publicInputs,
    };
  } catch (error) {
    throw new Error('Decryption failed: authentication tag verification failed or invalid key');
  }
}
