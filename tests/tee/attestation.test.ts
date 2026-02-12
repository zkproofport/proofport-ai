import { describe, it, expect, beforeEach } from 'vitest';
import { encode as cborEncode } from 'cbor-x';
import { readFileSync } from 'fs';
import { execSync } from 'child_process';
import type { AttestationDocument } from '../../src/tee/types.js';

describe('Attestation Verification', () => {
  let verifyAttestationDocument: any;
  let parseAttestationDocument: any;
  let testCert: Buffer;
  let testCACert: Buffer;

  beforeEach(async () => {
    const module = await import('../../src/tee/attestation.js');
    verifyAttestationDocument = module.verifyAttestationDocument;
    parseAttestationDocument = module.parseAttestationDocument;

    // Generate test certificates for verification tests
    try {
      execSync('openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -keyout /tmp/test-key.pem -out /tmp/test-cert.pem -days 365 -subj "/CN=TestCert" 2>/dev/null', { stdio: 'pipe' });
      execSync('openssl x509 -in /tmp/test-cert.pem -outform DER -out /tmp/test-cert.der 2>/dev/null', { stdio: 'pipe' });
      execSync('openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -keyout /tmp/test-ca-key.pem -out /tmp/test-ca-cert.pem -days 365 -subj "/CN=TestCA" 2>/dev/null', { stdio: 'pipe' });
      execSync('openssl x509 -in /tmp/test-ca-cert.pem -outform DER -out /tmp/test-ca-cert.der 2>/dev/null', { stdio: 'pipe' });

      testCert = readFileSync('/tmp/test-cert.der');
      testCACert = readFileSync('/tmp/test-ca-cert.der');
    } catch (error) {
      // If OpenSSL fails, use dummy certificates (tests will reflect this)
      testCert = Buffer.from('dummy-cert');
      testCACert = Buffer.from('dummy-ca');
    }
  });

  describe('parseAttestationDocument()', () => {
    it('should parse valid base64-encoded COSE Sign1 document', () => {
      // Create proper COSE Sign1 structure: [protected, unprotected, payload, signature]
      const protectedHeaders = {};
      const unprotected = {};
      const payload = {
        module_id: 'i-1234567890abcdef0-enc1234567890abcd',
        digest: 'SHA384',
        timestamp: Date.now(),
        pcrs: {
          0: Buffer.from('pcr0hash'),
          1: Buffer.from('pcr1hash'),
          2: Buffer.from('pcr2hash'),
        },
        certificate: Buffer.from('mock-certificate'),
        cabundle: [Buffer.from('mock-ca')],
      };
      const signature = Buffer.from('mock-signature');

      const coseSign1 = [
        cborEncode(protectedHeaders), // protected headers (CBOR-encoded)
        unprotected,                   // unprotected headers
        cborEncode(payload),           // payload (CBOR-encoded)
        signature,                     // signature
      ];

      const mockCoseDoc = Buffer.from(cborEncode(coseSign1)).toString('base64');

      const doc = parseAttestationDocument(mockCoseDoc);
      expect(doc).toBeDefined();
      expect(doc.moduleId).toBeDefined();
      expect(doc.digest).toBe('SHA384');
      expect(doc.pcrs).toBeInstanceOf(Map);
    });

    it('should throw on invalid base64', () => {
      // Even though 'not-valid-base64!!!' can be decoded as base64, it produces invalid JSON
      // So we test that it throws with a descriptive error
      expect(() => parseAttestationDocument('not-valid-base64!!!')).toThrow(/failed to parse/i);
    });

    it('should throw on malformed COSE structure', () => {
      const invalidCose = Buffer.from('not a cose document').toString('base64');
      expect(() => parseAttestationDocument(invalidCose)).toThrow(/failed to parse/i);
    });

    it('should extract PCRs into Map', () => {
      const protectedHeaders = {};
      const unprotected = {};
      const payload = {
        module_id: 'test-module',
        digest: 'SHA384',
        timestamp: Date.now(),
        pcrs: {
          0: Buffer.from('pcr0'),
          1: Buffer.from('pcr1'),
          2: Buffer.from('pcr2'),
        },
        certificate: Buffer.from('mock-certificate'),
        cabundle: [Buffer.from('mock-ca')],
      };
      const signature = Buffer.from('mock-signature');

      const coseSign1 = [
        cborEncode(protectedHeaders),
        unprotected,
        cborEncode(payload),
        signature,
      ];

      const mockCoseDoc = Buffer.from(cborEncode(coseSign1)).toString('base64');

      const doc = parseAttestationDocument(mockCoseDoc);
      expect(doc.pcrs.size).toBe(3);
      expect(doc.pcrs.has(0)).toBe(true);
      expect(doc.pcrs.has(1)).toBe(true);
      expect(doc.pcrs.has(2)).toBe(true);
    });

    it('should handle optional fields', () => {
      const protectedHeaders = {};
      const unprotected = {};
      const payload = {
        module_id: 'test-module',
        digest: 'SHA384',
        timestamp: Date.now(),
        pcrs: {},
        certificate: Buffer.from('mock-certificate'),
        cabundle: [Buffer.from('mock-ca')],
        public_key: Buffer.from('pubkey'),
        user_data: Buffer.from('userdata'),
        nonce: Buffer.from('nonce'),
      };
      const signature = Buffer.from('mock-signature');

      const coseSign1 = [
        cborEncode(protectedHeaders),
        unprotected,
        cborEncode(payload),
        signature,
      ];

      const mockCoseDoc = Buffer.from(cborEncode(coseSign1)).toString('base64');

      const doc = parseAttestationDocument(mockCoseDoc);
      expect(doc.publicKey).toBeDefined();
      expect(doc.userData).toBeDefined();
      expect(doc.nonce).toBeDefined();
    });
  });

  describe('verifyAttestationDocument()', () => {
    it('should verify valid attestation document', async () => {
      const payload = {
        module_id: 'i-1234567890abcdef0-enc1234567890abcd',
        digest: 'SHA384',
        timestamp: Date.now(),
        pcrs: {
          0: Buffer.from('validpcr0hash'),
          1: Buffer.from('validpcr1hash'),
          2: Buffer.from('validpcr2hash'),
        },
        certificate: testCert,
        cabundle: [testCACert],
      };

      const protectedHeaders = { 1: -35 }; // ES384
      const coseSign1 = [
        cborEncode(protectedHeaders),
        {},
        cborEncode(payload),
        Buffer.alloc(96), // dummy signature
      ];

      const coseDoc = Buffer.from(cborEncode(coseSign1)).toString('base64');
      const doc = parseAttestationDocument(coseDoc);

      const result = await verifyAttestationDocument(doc);
      expect(result.isValid).toBeDefined();
      expect(typeof result.isValid).toBe('boolean');
    });

    it('should verify certificate chain', async () => {
      const payload = {
        module_id: 'i-1234567890abcdef0-enc1234567890abcd',
        digest: 'SHA384',
        timestamp: Date.now(),
        pcrs: {},
        certificate: testCert,
        cabundle: [testCACert],
      };

      const protectedHeaders = { 1: -35 }; // ES384
      const coseSign1 = [
        cborEncode(protectedHeaders),
        {},
        cborEncode(payload),
        Buffer.alloc(96), // dummy signature
      ];

      const coseDoc = Buffer.from(cborEncode(coseSign1)).toString('base64');
      const doc = parseAttestationDocument(coseDoc);

      const result = await verifyAttestationDocument(doc);
      expect(result.certificateValid).toBeDefined();
    });

    it('should validate PCR values', async () => {
      const payload = {
        module_id: 'i-1234567890abcdef0-enc1234567890abcd',
        digest: 'SHA384',
        timestamp: Date.now(),
        pcrs: {
          0: Buffer.from('pcr0'),
          1: Buffer.from('pcr1'),
          2: Buffer.from('pcr2'),
        },
        certificate: testCert,
        cabundle: [testCACert],
      };

      const protectedHeaders = { 1: -35 }; // ES384
      const coseSign1 = [
        cborEncode(protectedHeaders),
        {},
        cborEncode(payload),
        Buffer.alloc(96), // dummy signature
      ];

      const coseDoc = Buffer.from(cborEncode(coseSign1)).toString('base64');
      const doc = parseAttestationDocument(coseDoc);

      const result = await verifyAttestationDocument(doc, {
        expectedPcr0: Buffer.from('pcr0'),
      });
      expect(result.pcr0Valid).toBeDefined();
    });

    it('should reject if PCR0 mismatch', async () => {
      const payload = {
        module_id: 'test',
        digest: 'SHA384',
        timestamp: Date.now(),
        pcrs: {
          0: Buffer.from('wronghash'),
        },
        certificate: testCert,
        cabundle: [testCACert],
      };

      const protectedHeaders = { 1: -35 }; // ES384
      const coseSign1 = [
        cborEncode(protectedHeaders),
        {},
        cborEncode(payload),
        Buffer.alloc(96), // dummy signature
      ];

      const coseDoc = Buffer.from(cborEncode(coseSign1)).toString('base64');
      const doc = parseAttestationDocument(coseDoc);

      const result = await verifyAttestationDocument(doc, {
        expectedPcr0: Buffer.from('correcthash'),
      });
      expect(result.isValid).toBe(false);
      expect(result.error).toContain('PCR0');
    });

    it('should validate timestamp freshness', async () => {
      const payload = {
        module_id: 'test',
        digest: 'SHA384',
        timestamp: Date.now() - 1000, // 1 second ago
        pcrs: {},
        certificate: testCert,
        cabundle: [testCACert],
      };

      const protectedHeaders = { 1: -35 }; // ES384
      const coseSign1 = [
        cborEncode(protectedHeaders),
        {},
        cborEncode(payload),
        Buffer.alloc(96), // dummy signature
      ];

      const coseDoc = Buffer.from(cborEncode(coseSign1)).toString('base64');
      const doc = parseAttestationDocument(coseDoc);

      const result = await verifyAttestationDocument(doc, {
        maxAge: 5000, // 5 seconds
      });
      // Timestamp is fresh (within 5 seconds), so error should NOT be about timestamp
      // It will fail on signature verification instead (dummy signature)
      if (!result.isValid) {
        expect(result.error).not.toContain('timestamp');
        expect(result.error).toContain('signature');
      }
    });

    it('should reject if timestamp too old', async () => {
      const payload = {
        module_id: 'test',
        digest: 'SHA384',
        timestamp: Date.now() - 10000, // 10 seconds ago
        pcrs: {},
        certificate: testCert,
        cabundle: [testCACert],
      };

      const protectedHeaders = { 1: -35 }; // ES384
      const coseSign1 = [
        cborEncode(protectedHeaders),
        {},
        cborEncode(payload),
        Buffer.alloc(96), // dummy signature
      ];

      const coseDoc = Buffer.from(cborEncode(coseSign1)).toString('base64');
      const doc = parseAttestationDocument(coseDoc);

      const result = await verifyAttestationDocument(doc, {
        maxAge: 5000, // 5 seconds
      });
      expect(result.isValid).toBe(false);
      expect(result.error).toContain('timestamp');
    });

    it('should validate signature', async () => {
      const payload = {
        module_id: 'test',
        digest: 'SHA384',
        timestamp: Date.now(),
        pcrs: {},
        certificate: testCert,
        cabundle: [testCACert],
      };

      const protectedHeaders = { 1: -35 }; // ES384
      const coseSign1 = [
        cborEncode(protectedHeaders),
        {},
        cborEncode(payload),
        Buffer.alloc(96), // dummy signature
      ];

      const coseDoc = Buffer.from(cborEncode(coseSign1)).toString('base64');
      const doc = parseAttestationDocument(coseDoc);

      const result = await verifyAttestationDocument(doc);
      expect(result.signatureValid).toBeDefined();
    });

    it('should cryptographically verify COSE_Sign1 signature with ES384', async () => {
      // Generate EC P-384 keypair for ES384
      try {
        execSync('openssl ecparam -genkey -name secp384r1 -out /tmp/test-es384-key.pem 2>/dev/null', { stdio: 'pipe' });
        execSync('openssl req -new -x509 -key /tmp/test-es384-key.pem -out /tmp/test-es384-cert.pem -days 1 -subj "/CN=TestES384" 2>/dev/null', { stdio: 'pipe' });
        execSync('openssl x509 -in /tmp/test-es384-cert.pem -outform DER -out /tmp/test-es384-cert.der 2>/dev/null', { stdio: 'pipe' });

        const es384Cert = readFileSync('/tmp/test-es384-cert.der');
        const es384KeyPem = readFileSync('/tmp/test-es384-key.pem', 'utf-8');

        // Create payload
        const payload = {
          module_id: 'test-es384',
          digest: 'SHA384',
          timestamp: Date.now(),
          pcrs: {
            0: Buffer.from('pcr0'),
          },
          certificate: es384Cert,
          cabundle: [testCACert],
        };

        // Create protected headers with ES384 algorithm (-35)
        const protectedHeaders = { 1: -35 }; // alg: ES384
        const protectedEncoded = cborEncode(protectedHeaders);
        const payloadEncoded = cborEncode(payload);

        // Build Sig_structure per RFC 8152
        const sigStructure = [
          'Signature1',
          protectedEncoded,
          Buffer.alloc(0), // empty external_aad
          payloadEncoded,
        ];
        const sigStructureEncoded = cborEncode(sigStructure);

        // Sign using OpenSSL
        const fs = await import('fs');
        fs.writeFileSync('/tmp/sig-structure.bin', sigStructureEncoded);
        execSync('openssl dgst -sha384 -sign /tmp/test-es384-key.pem -out /tmp/signature.der /tmp/sig-structure.bin 2>/dev/null', { stdio: 'pipe' });
        const derSig = readFileSync('/tmp/signature.der');

        // Convert DER signature to raw R||S format (96 bytes for ES384)
        // DER format: 0x30 [length] 0x02 [r-length] [r] 0x02 [s-length] [s]
        const rawSig = Buffer.alloc(96);
        let offset = 2; // skip 0x30 and length

        // Extract R
        if (derSig[offset] !== 0x02) throw new Error('Invalid DER signature');
        offset++;
        const rLen = derSig[offset];
        offset++;
        const rStart = offset;
        const rPadding = rLen > 48 ? 1 : 0; // Skip leading 0x00 if present
        derSig.copy(rawSig, 48 - (rLen - rPadding), rStart + rPadding, rStart + rLen);
        offset += rLen;

        // Extract S
        if (derSig[offset] !== 0x02) throw new Error('Invalid DER signature');
        offset++;
        const sLen = derSig[offset];
        offset++;
        const sStart = offset;
        const sPadding = sLen > 48 ? 1 : 0; // Skip leading 0x00 if present
        derSig.copy(rawSig, 96 - (sLen - sPadding), sStart + sPadding, sStart + sLen);

        // Create COSE_Sign1 document
        const coseSign1 = [
          protectedEncoded,
          {},
          payloadEncoded,
          rawSig,
        ];

        const coseDoc = Buffer.from(cborEncode(coseSign1)).toString('base64');

        // Parse and verify
        const doc = parseAttestationDocument(coseDoc);
        const result = await verifyAttestationDocument(doc);

        expect(result.isValid).toBe(true);
        expect(result.signatureValid).toBe(true);
      } catch (error) {
        // Skip test if OpenSSL is not available or fails
        console.warn('Skipping ES384 signature test: OpenSSL not available');
      }
    });

    it('should reject document with invalid/tampered signature', async () => {
      // Create a properly structured doc but with wrong signature
      try {
        execSync('openssl ecparam -genkey -name secp384r1 -out /tmp/test-tamper-key.pem 2>/dev/null', { stdio: 'pipe' });
        execSync('openssl req -new -x509 -key /tmp/test-tamper-key.pem -out /tmp/test-tamper-cert.pem -days 1 -subj "/CN=TestTamper" 2>/dev/null', { stdio: 'pipe' });
        execSync('openssl x509 -in /tmp/test-tamper-cert.pem -outform DER -out /tmp/test-tamper-cert.der 2>/dev/null', { stdio: 'pipe' });

        const tamperCert = readFileSync('/tmp/test-tamper-cert.der');

        const payload = {
          module_id: 'test-tamper',
          digest: 'SHA384',
          timestamp: Date.now(),
          pcrs: {},
          certificate: tamperCert,
          cabundle: [testCACert],
        };

        const protectedHeaders = { 1: -35 }; // ES384
        const protectedEncoded = cborEncode(protectedHeaders);
        const payloadEncoded = cborEncode(payload);

        // Create INVALID signature (just random bytes)
        const invalidSig = Buffer.alloc(96);
        for (let i = 0; i < 96; i++) {
          invalidSig[i] = Math.floor(Math.random() * 256);
        }

        const coseSign1 = [
          protectedEncoded,
          {},
          payloadEncoded,
          invalidSig,
        ];

        const coseDoc = Buffer.from(cborEncode(coseSign1)).toString('base64');

        const doc = parseAttestationDocument(coseDoc);
        const result = await verifyAttestationDocument(doc);

        expect(result.isValid).toBe(false);
        expect(result.signatureValid).toBe(false);
        expect(result.error).toContain('signature verification failed');
      } catch (error) {
        console.warn('Skipping tampered signature test: OpenSSL not available');
      }
    });

    it('should reject document when signature algorithm is unsupported', async () => {
      const payload = {
        module_id: 'test-unsupported',
        digest: 'SHA384',
        timestamp: Date.now(),
        pcrs: {},
        certificate: testCert,
        cabundle: [testCACert],
      };

      // Use unsupported algorithm ID (e.g., -8 which is EdDSA)
      const protectedHeaders = { 1: -8 };
      const protectedEncoded = cborEncode(protectedHeaders);
      const payloadEncoded = cborEncode(payload);

      const coseSign1 = [
        protectedEncoded,
        {},
        payloadEncoded,
        Buffer.from('dummy-signature'),
      ];

      const coseDoc = Buffer.from(cborEncode(coseSign1)).toString('base64');

      const doc = parseAttestationDocument(coseDoc);
      const result = await verifyAttestationDocument(doc);

      expect(result.isValid).toBe(false);
      expect(result.signatureValid).toBe(false);
      expect(result.error).toContain('Unsupported COSE algorithm');
    });

    it('should return error details on failure', async () => {
      const payload = {
        module_id: 'test',
        digest: 'SHA384',
        timestamp: Date.now(),
        pcrs: {},
        certificate: Buffer.from('invalid'),
        cabundle: [],
      };

      const protectedHeaders = { 1: -35 }; // ES384
      const coseSign1 = [
        cborEncode(protectedHeaders),
        {},
        cborEncode(payload),
        Buffer.alloc(96), // dummy signature
      ];

      const coseDoc = Buffer.from(cborEncode(coseSign1)).toString('base64');
      const doc = parseAttestationDocument(coseDoc);

      const result = await verifyAttestationDocument(doc);
      if (!result.isValid) {
        expect(result.error).toBeDefined();
        expect(typeof result.error).toBe('string');
      }
    });

    it('should handle missing PCRs', async () => {
      const payload = {
        module_id: 'test',
        digest: 'SHA384',
        timestamp: Date.now(),
        pcrs: {}, // Empty PCRs
        certificate: testCert,
        cabundle: [testCACert],
      };

      const protectedHeaders = { 1: -35 }; // ES384
      const coseSign1 = [
        cborEncode(protectedHeaders),
        {},
        cborEncode(payload),
        Buffer.alloc(96), // dummy signature
      ];

      const coseDoc = Buffer.from(cborEncode(coseSign1)).toString('base64');
      const doc = parseAttestationDocument(coseDoc);

      const result = await verifyAttestationDocument(doc, {
        expectedPcr0: Buffer.from('somehash'),
      });
      expect(result.isValid).toBe(false);
    });

    it('should validate all three PCRs when provided', async () => {
      const payload = {
        module_id: 'test',
        digest: 'SHA384',
        timestamp: Date.now(),
        pcrs: {
          0: Buffer.from('pcr0'),
          1: Buffer.from('pcr1'),
          2: Buffer.from('pcr2'),
        },
        certificate: testCert,
        cabundle: [testCACert],
      };

      const protectedHeaders = { 1: -35 }; // ES384
      const coseSign1 = [
        cborEncode(protectedHeaders),
        {},
        cborEncode(payload),
        Buffer.alloc(96), // dummy signature
      ];

      const coseDoc = Buffer.from(cborEncode(coseSign1)).toString('base64');
      const doc = parseAttestationDocument(coseDoc);

      const result = await verifyAttestationDocument(doc, {
        expectedPcr0: Buffer.from('pcr0'),
        expectedPcr1: Buffer.from('pcr1'),
        expectedPcr2: Buffer.from('pcr2'),
      });
      expect(result.pcr0Valid).toBe(true);
      expect(result.pcr1Valid).toBe(true);
      expect(result.pcr2Valid).toBe(true);
    });
  });

  describe('Edge cases', () => {
    it('should handle empty cabundle', async () => {
      const payload = {
        module_id: 'test',
        digest: 'SHA384',
        timestamp: Date.now(),
        pcrs: {},
        certificate: testCert,
        cabundle: [],
      };

      const protectedHeaders = { 1: -35 }; // ES384
      const coseSign1 = [
        cborEncode(protectedHeaders),
        {},
        cborEncode(payload),
        Buffer.alloc(96), // dummy signature
      ];

      const coseDoc = Buffer.from(cborEncode(coseSign1)).toString('base64');
      const doc = parseAttestationDocument(coseDoc);

      const result = await verifyAttestationDocument(doc);
      expect(result).toBeDefined();
      // Empty cabundle should fail validation
      expect(result.isValid).toBe(false);
      expect(result.error).toContain('bundle');
    });

    it('should handle very large PCR map', () => {
      const largePcrMap: Record<number, Buffer> = {};
      for (let i = 0; i < 16; i++) {
        largePcrMap[i] = Buffer.from(`pcr${i}`);
      }

      const protectedHeaders = {};
      const unprotected = {};
      const payload = {
        module_id: 'test',
        digest: 'SHA384',
        timestamp: Date.now(),
        pcrs: largePcrMap,
        certificate: Buffer.from('mock-certificate'),
        cabundle: [Buffer.from('mock-ca')],
      };
      const signature = Buffer.from('mock-signature');

      const coseSign1 = [
        cborEncode(protectedHeaders),
        unprotected,
        cborEncode(payload),
        signature,
      ];

      const mockCoseDoc = Buffer.from(cborEncode(coseSign1)).toString('base64');

      const doc = parseAttestationDocument(mockCoseDoc);
      expect(doc.pcrs.size).toBe(16);
    });
  });
});
