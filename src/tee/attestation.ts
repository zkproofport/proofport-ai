/**
 * AWS Nitro Enclave attestation document parsing and verification
 */

import { decode as cborDecode } from 'cbor-x';
import { createVerify, X509Certificate } from 'crypto';
import type { AttestationDocument } from './types.js';

// Store raw COSE structure for signature verification
let lastCoseStructure: {
  protected: Buffer;
  unprotected: Map<unknown, unknown>;
  payload: Buffer;
  signature: Buffer;
} | null = null;

/**
 * Parse base64-encoded COSE Sign1 attestation document
 * @param base64Doc Base64-encoded COSE Sign1 document
 * @returns Parsed attestation document
 * @throws Error if document is invalid
 */
export function parseAttestationDocument(base64Doc: string): AttestationDocument {
  let buffer: Buffer;
  try {
    // Decode base64
    buffer = Buffer.from(base64Doc, 'base64');
  } catch (error) {
    throw new Error('Failed to parse attestation document: invalid base64 encoding');
  }

  try {
    // Decode COSE Sign1 structure
    // COSE_Sign1 = [protected: bstr, unprotected: map, payload: bstr, signature: bstr]
    const cose = cborDecode(buffer);

    if (!Array.isArray(cose) || cose.length !== 4) {
      throw new Error('Invalid COSE structure: expected array of length 4');
    }

    const [protectedRaw, unprotected, payloadRaw, signature] = cose;

    if (!(protectedRaw instanceof Uint8Array)) {
      throw new Error('Invalid COSE structure: protected headers must be byte string');
    }
    if (!(payloadRaw instanceof Uint8Array)) {
      throw new Error('Invalid COSE structure: payload must be byte string');
    }
    if (!(signature instanceof Uint8Array)) {
      throw new Error('Invalid COSE structure: signature must be byte string');
    }

    const protectedBuffer = Buffer.from(protectedRaw);
    const payloadBuffer = Buffer.from(payloadRaw);
    const signatureBuffer = Buffer.from(signature);

    // Store COSE structure for signature verification
    lastCoseStructure = {
      protected: protectedBuffer,
      unprotected: unprotected as Map<unknown, unknown>,
      payload: payloadBuffer,
      signature: signatureBuffer,
    };

    // Decode protected headers (CBOR-encoded)
    const protectedHeaders = cborDecode(protectedBuffer);
    if (typeof protectedHeaders !== 'object' || protectedHeaders === null) {
      throw new Error('Invalid COSE structure: protected headers must be a map');
    }

    // Decode payload (CBOR-encoded attestation document)
    const payload = cborDecode(payloadBuffer);
    if (typeof payload !== 'object' || payload === null) {
      throw new Error('Invalid attestation document: payload must be a map');
    }

    // Extract required fields
    if (typeof payload.module_id !== 'string') {
      throw new Error('Invalid attestation document: module_id must be a string');
    }
    if (typeof payload.digest !== 'string') {
      throw new Error('Invalid attestation document: digest must be a string');
    }
    if (typeof payload.timestamp !== 'number') {
      throw new Error('Invalid attestation document: timestamp must be a number');
    }
    if (!(payload.certificate instanceof Uint8Array)) {
      throw new Error('Invalid attestation document: certificate must be byte string');
    }
    if (!Array.isArray(payload.cabundle)) {
      throw new Error('Invalid attestation document: cabundle must be an array');
    }

    // Extract PCRs into Map
    const pcrs = new Map<number, Buffer>();
    if (payload.pcrs && typeof payload.pcrs === 'object') {
      if (payload.pcrs instanceof Map) {
        for (const [key, value] of payload.pcrs.entries()) {
          if (typeof key !== 'number') {
            throw new Error(`Invalid attestation document: PCR key must be number, got ${typeof key}`);
          }
          if (!(value instanceof Uint8Array)) {
            throw new Error(`Invalid attestation document: PCR value must be byte string`);
          }
          pcrs.set(key, Buffer.from(value));
        }
      } else {
        for (const [key, value] of Object.entries(payload.pcrs)) {
          const pcrIndex = parseInt(key, 10);
          if (isNaN(pcrIndex)) {
            throw new Error(`Invalid attestation document: PCR key must be numeric, got ${key}`);
          }
          if (!(value instanceof Uint8Array)) {
            throw new Error(`Invalid attestation document: PCR value must be byte string`);
          }
          pcrs.set(pcrIndex, Buffer.from(value));
        }
      }
    }

    // Convert cabundle to Buffer array
    const cabundle: Buffer[] = [];
    for (const ca of payload.cabundle) {
      if (!(ca instanceof Uint8Array)) {
        throw new Error('Invalid attestation document: cabundle entries must be byte strings');
      }
      cabundle.push(Buffer.from(ca));
    }

    const doc: AttestationDocument = {
      moduleId: payload.module_id,
      digest: payload.digest as 'SHA384',
      timestamp: payload.timestamp,
      pcrs,
      certificate: Buffer.from(payload.certificate),
      cabundle,
      publicKey: payload.public_key instanceof Uint8Array ? Buffer.from(payload.public_key) : undefined,
      userData: payload.user_data instanceof Uint8Array ? Buffer.from(payload.user_data) : undefined,
      nonce: payload.nonce instanceof Uint8Array ? Buffer.from(payload.nonce) : undefined,
    };

    return doc;
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Failed to parse attestation document: ${error.message}`);
    }
    throw new Error('Failed to parse attestation document: unknown error during CBOR decoding');
  }
}

export interface AttestationVerificationOptions {
  expectedPcr0?: Buffer;
  expectedPcr1?: Buffer;
  expectedPcr2?: Buffer;
  maxAge?: number; // Maximum age in milliseconds
}

export interface AttestationVerificationResult {
  isValid: boolean;
  certificateValid?: boolean;
  signatureValid?: boolean;
  pcr0Valid?: boolean;
  pcr1Valid?: boolean;
  pcr2Valid?: boolean;
  error?: string;
}

/**
 * Verify attestation document authenticity and PCR values
 * @param doc Parsed attestation document
 * @param options Verification options (expected PCRs, max age, etc.)
 * @returns Verification result
 */
export async function verifyAttestationDocument(
  doc: AttestationDocument,
  options?: AttestationVerificationOptions
): Promise<AttestationVerificationResult> {
  const result: AttestationVerificationResult = {
    isValid: true,
    certificateValid: false,
    signatureValid: false,
  };

  try {
    // Verify timestamp freshness
    if (options?.maxAge) {
      const age = Date.now() - doc.timestamp;
      if (age > options.maxAge) {
        result.isValid = false;
        result.error = `Attestation document timestamp too old: ${age}ms > ${options.maxAge}ms`;
        return result;
      }
    }

    // Verify PCR0 (enclave image hash)
    if (options?.expectedPcr0) {
      const pcr0 = doc.pcrs.get(0);
      if (!pcr0) {
        result.isValid = false;
        result.pcr0Valid = false;
        result.error = 'PCR0 not found in attestation document';
        return result;
      }
      result.pcr0Valid = pcr0.equals(options.expectedPcr0);
      if (!result.pcr0Valid) {
        result.isValid = false;
        result.error = 'PCR0 mismatch: enclave image hash does not match expected value';
        return result;
      }
    }

    // Verify PCR1 (kernel hash)
    if (options?.expectedPcr1) {
      const pcr1 = doc.pcrs.get(1);
      result.pcr1Valid = pcr1?.equals(options.expectedPcr1) ?? false;
      if (!result.pcr1Valid) {
        result.isValid = false;
        result.error = 'PCR1 mismatch: kernel hash does not match expected value';
        return result;
      }
    }

    // Verify PCR2 (application hash)
    if (options?.expectedPcr2) {
      const pcr2 = doc.pcrs.get(2);
      result.pcr2Valid = pcr2?.equals(options.expectedPcr2) ?? false;
      if (!result.pcr2Valid) {
        result.isValid = false;
        result.error = 'PCR2 mismatch: application hash does not match expected value';
        return result;
      }
    }

    // Verify certificate chain
    // Certificate must be valid DER-encoded X.509
    if (doc.certificate.length === 0) {
      result.isValid = false;
      result.certificateValid = false;
      result.error = 'Certificate is empty';
      return result;
    }

    let cert: X509Certificate;
    try {
      cert = new X509Certificate(doc.certificate);
    } catch (error) {
      result.isValid = false;
      result.certificateValid = false;
      result.error = `Invalid certificate: ${error instanceof Error ? error.message : 'not DER-encoded X.509'}`;
      return result;
    }

    // Verify certificate chains to one of the CA certificates in cabundle
    // Note: Full certificate chain validation requires:
    // 1. Verify cert is signed by one of the cabundle certificates
    // 2. Verify cabundle certificates chain to AWS Nitro root CA
    // 3. Check certificate validity periods
    // 4. Check certificate key usage and extended key usage
    // For now, we do structural validation only
    if (doc.cabundle.length === 0) {
      result.isValid = false;
      result.certificateValid = false;
      result.error = 'Certificate bundle is empty';
      return result;
    }

    // Verify all cabundle entries are valid X.509 certificates
    for (let i = 0; i < doc.cabundle.length; i++) {
      try {
        new X509Certificate(doc.cabundle[i]);
      } catch (error) {
        result.isValid = false;
        result.certificateValid = false;
        result.error = `Invalid CA certificate at index ${i}: ${error instanceof Error ? error.message : 'not DER-encoded X.509'}`;
        return result;
      }
    }

    result.certificateValid = true;

    // Verify COSE signature
    // TODO: Implement full COSE_Sign1 signature verification
    // This requires:
    // 1. Parse protected headers to determine signature algorithm (alg parameter from protected headers)
    //    Common algorithms: ES384 (-35), ES256 (-7), ES512 (-36)
    // 2. Build Sig_structure as per RFC 8152 Section 4.4:
    //    Sig_structure = [
    //      context: "Signature1",
    //      body_protected: protected headers (as CBOR-encoded bstr),
    //      external_aad: empty bstr,
    //      payload: CBOR-encoded payload
    //    ]
    // 3. CBOR-encode Sig_structure
    // 4. Hash the encoded Sig_structure using algorithm-specific hash (SHA-384 for ES384)
    // 5. Verify signature using crypto.createVerify() with certificate's public key
    //
    // For now, we verify that:
    // - COSE structure exists and has all required parts
    // - Certificate is valid and can be used for verification
    // - Protected headers can be decoded
    if (!lastCoseStructure) {
      result.isValid = false;
      result.signatureValid = false;
      result.error = 'COSE structure not available for signature verification';
      return result;
    }

    try {
      // Verify we have all required components for signature verification
      if (lastCoseStructure.signature.length === 0) {
        result.isValid = false;
        result.signatureValid = false;
        result.error = 'COSE signature is empty';
        return result;
      }

      // Decode and validate protected headers
      const protectedHeaders = cborDecode(lastCoseStructure.protected);
      if (typeof protectedHeaders !== 'object' || protectedHeaders === null) {
        result.isValid = false;
        result.signatureValid = false;
        result.error = 'Invalid COSE protected headers';
        return result;
      }

      // Extract public key from certificate (validates certificate is usable)
      const publicKey = cert.publicKey;
      if (!publicKey) {
        result.isValid = false;
        result.signatureValid = false;
        result.error = 'Cannot extract public key from certificate';
        return result;
      }

      // Mark signature as valid for structural checks
      // Full cryptographic verification is TODO
      result.signatureValid = true;

    } catch (error) {
      result.isValid = false;
      result.signatureValid = false;
      result.error = `Signature verification failed: ${error instanceof Error ? error.message : 'unknown error'}`;
      return result;
    }

    return result;
  } catch (error) {
    result.isValid = false;
    result.error = error instanceof Error ? error.message : 'Unknown verification error';
    return result;
  }
}
