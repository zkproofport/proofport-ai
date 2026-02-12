/**
 * AWS Nitro Enclave attestation document parsing and verification
 */

import { decode as cborDecode, encode as cborEncode } from 'cbor-x';
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
 * Convert raw ECDSA signature (R||S) to DER format
 * COSE uses raw concatenation, Node.js crypto expects DER ASN.1 encoding
 * @param rawSig Raw signature bytes (R||S concatenated)
 * @param componentLength Length of R and S components in bytes
 * @returns DER-encoded signature
 */
function rawSigToDer(rawSig: Buffer, componentLength: number): Buffer {
  const r = rawSig.subarray(0, componentLength);
  const s = rawSig.subarray(componentLength, componentLength * 2);

  // Encode each component as ASN.1 INTEGER (prepend 0x00 if high bit set)
  function encodeInt(buf: Buffer): Buffer {
    // Skip leading zeros but keep at least one byte
    let start = 0;
    while (start < buf.length - 1 && buf[start] === 0) start++;
    const trimmed = buf.subarray(start);

    // Prepend 0x00 if high bit is set (to avoid negative interpretation)
    const needsPadding = trimmed[0] & 0x80;
    const padded = needsPadding ? Buffer.concat([Buffer.from([0x00]), trimmed]) : trimmed;

    // ASN.1 INTEGER: 0x02 [length] [data]
    return Buffer.concat([Buffer.from([0x02, padded.length]), padded]);
  }

  const rDer = encodeInt(r);
  const sDer = encodeInt(s);
  const seqLen = rDer.length + sDer.length;

  // ASN.1 SEQUENCE: 0x30 [length] [contents]
  return Buffer.concat([Buffer.from([0x30, seqLen]), rDer, sDer]);
}

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

    // Verify COSE_Sign1 signature
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

      // Extract algorithm from protected headers (COSE header label 1 = alg)
      const algId = protectedHeaders[1];
      if (typeof algId !== 'number') {
        result.isValid = false;
        result.signatureValid = false;
        result.error = 'COSE algorithm ID not found in protected headers';
        return result;
      }

      // COSE algorithm mapping
      const COSE_ALG_MAP: Record<number, { hash: string; componentLength: number }> = {
        [-7]: { hash: 'SHA256', componentLength: 32 },   // ES256
        [-35]: { hash: 'SHA384', componentLength: 48 },  // ES384
        [-36]: { hash: 'SHA512', componentLength: 66 },  // ES512
      };

      const algConfig = COSE_ALG_MAP[algId];
      if (!algConfig) {
        result.isValid = false;
        result.signatureValid = false;
        result.error = `Unsupported COSE algorithm: ${algId}`;
        return result;
      }

      // Build Sig_structure per RFC 8152 Section 4.4
      const sigStructure = [
        'Signature1',
        lastCoseStructure.protected,  // raw protected headers bstr
        Buffer.alloc(0),              // external_aad (empty)
        lastCoseStructure.payload,    // raw payload bstr
      ];

      // CBOR-encode the Sig_structure
      const sigStructureEncoded = cborEncode(sigStructure);

      // Convert raw R||S signature to DER format
      const rawSig = lastCoseStructure.signature;
      const expectedSigLength = algConfig.componentLength * 2;
      if (rawSig.length !== expectedSigLength) {
        result.isValid = false;
        result.signatureValid = false;
        result.error = `Invalid signature length: expected ${expectedSigLength} bytes, got ${rawSig.length}`;
        return result;
      }

      const derSig = rawSigToDer(rawSig, algConfig.componentLength);

      // Extract public key from certificate
      const publicKey = cert.publicKey;
      if (!publicKey) {
        result.isValid = false;
        result.signatureValid = false;
        result.error = 'Cannot extract public key from certificate';
        return result;
      }

      // Verify signature
      const verifier = createVerify(algConfig.hash);
      verifier.update(sigStructureEncoded);
      const isSignatureValid = verifier.verify(publicKey, derSig);

      result.signatureValid = isSignatureValid;
      if (!isSignatureValid) {
        result.isValid = false;
        result.error = 'COSE signature verification failed';
      }

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
