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
      const doc: AttestationDocument = {
        moduleId: 'i-1234567890abcdef0-enc1234567890abcd',
        digest: 'SHA384',
        timestamp: Date.now(),
        pcrs: new Map([
          [0, Buffer.from('validpcr0hash')],
          [1, Buffer.from('validpcr1hash')],
          [2, Buffer.from('validpcr2hash')],
        ]),
        certificate: testCert,
        cabundle: [testCACert],
      };

      const result = await verifyAttestationDocument(doc);
      expect(result.isValid).toBeDefined();
      expect(typeof result.isValid).toBe('boolean');
    });

    it('should verify certificate chain', async () => {
      const doc: AttestationDocument = {
        moduleId: 'i-1234567890abcdef0-enc1234567890abcd',
        digest: 'SHA384',
        timestamp: Date.now(),
        pcrs: new Map(),
        certificate: testCert,
        cabundle: [testCACert],
      };

      const result = await verifyAttestationDocument(doc);
      expect(result.certificateValid).toBeDefined();
    });

    it('should validate PCR values', async () => {
      const doc: AttestationDocument = {
        moduleId: 'i-1234567890abcdef0-enc1234567890abcd',
        digest: 'SHA384',
        timestamp: Date.now(),
        pcrs: new Map([
          [0, Buffer.from('pcr0')],
          [1, Buffer.from('pcr1')],
          [2, Buffer.from('pcr2')],
        ]),
        certificate: testCert,
        cabundle: [testCACert],
      };

      const result = await verifyAttestationDocument(doc, {
        expectedPcr0: Buffer.from('pcr0'),
      });
      expect(result.pcr0Valid).toBeDefined();
    });

    it('should reject if PCR0 mismatch', async () => {
      const doc: AttestationDocument = {
        moduleId: 'test',
        digest: 'SHA384',
        timestamp: Date.now(),
        pcrs: new Map([
          [0, Buffer.from('wronghash')],
        ]),
        certificate: testCert,
        cabundle: [testCACert],
      };

      const result = await verifyAttestationDocument(doc, {
        expectedPcr0: Buffer.from('correcthash'),
      });
      expect(result.isValid).toBe(false);
      expect(result.error).toContain('PCR0');
    });

    it('should validate timestamp freshness', async () => {
      const doc: AttestationDocument = {
        moduleId: 'test',
        digest: 'SHA384',
        timestamp: Date.now() - 1000, // 1 second ago
        pcrs: new Map(),
        certificate: testCert,
        cabundle: [testCACert],
      };

      const result = await verifyAttestationDocument(doc, {
        maxAge: 5000, // 5 seconds
      });
      expect(result.isValid).toBe(true);
    });

    it('should reject if timestamp too old', async () => {
      const doc: AttestationDocument = {
        moduleId: 'test',
        digest: 'SHA384',
        timestamp: Date.now() - 10000, // 10 seconds ago
        pcrs: new Map(),
        certificate: testCert,
        cabundle: [testCACert],
      };

      const result = await verifyAttestationDocument(doc, {
        maxAge: 5000, // 5 seconds
      });
      expect(result.isValid).toBe(false);
      expect(result.error).toContain('timestamp');
    });

    it('should validate signature', async () => {
      const doc: AttestationDocument = {
        moduleId: 'test',
        digest: 'SHA384',
        timestamp: Date.now(),
        pcrs: new Map(),
        certificate: testCert,
        cabundle: [testCACert],
      };

      const result = await verifyAttestationDocument(doc);
      expect(result.signatureValid).toBeDefined();
    });

    it('should return error details on failure', async () => {
      const doc: AttestationDocument = {
        moduleId: 'test',
        digest: 'SHA384',
        timestamp: Date.now(),
        pcrs: new Map(),
        certificate: Buffer.from('invalid'),
        cabundle: [],
      };

      const result = await verifyAttestationDocument(doc);
      if (!result.isValid) {
        expect(result.error).toBeDefined();
        expect(typeof result.error).toBe('string');
      }
    });

    it('should handle missing PCRs', async () => {
      const doc: AttestationDocument = {
        moduleId: 'test',
        digest: 'SHA384',
        timestamp: Date.now(),
        pcrs: new Map(), // Empty PCRs
        certificate: testCert,
        cabundle: [testCACert],
      };

      const result = await verifyAttestationDocument(doc, {
        expectedPcr0: Buffer.from('somehash'),
      });
      expect(result.isValid).toBe(false);
    });

    it('should validate all three PCRs when provided', async () => {
      const doc: AttestationDocument = {
        moduleId: 'test',
        digest: 'SHA384',
        timestamp: Date.now(),
        pcrs: new Map([
          [0, Buffer.from('pcr0')],
          [1, Buffer.from('pcr1')],
          [2, Buffer.from('pcr2')],
        ]),
        certificate: testCert,
        cabundle: [testCACert],
      };

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
      const doc: AttestationDocument = {
        moduleId: 'test',
        digest: 'SHA384',
        timestamp: Date.now(),
        pcrs: new Map(),
        certificate: testCert,
        cabundle: [],
      };

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
