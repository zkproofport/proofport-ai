import { describe, it, expect } from 'vitest';
import { toProverToml } from '../src/prover/tomlBuilder';
import type { CircuitParams } from '../src/prover/tomlBuilder';

describe('tomlBuilder', () => {
  const mockBaseParams: CircuitParams = {
    signalHash: new Uint8Array([0x95, 0x71, 0x18]),
    merkleRoot: '0xb60d1234',
    scopeBytes: new Uint8Array([0x89, 0xab]),
    nullifierBytes: new Uint8Array([0xc8, 0xde]),
    userAddress: '0xd6c714abcd',
    userSignature: '0x' + '64'.repeat(32) + '2c'.repeat(32) + '1c', // r(32) + s(32) + v(1)
    userPubkeyX: '0x2cab',
    userPubkeyY: '0x26ef',
    rawTxBytes: [0x02, 0xff],
    txLength: 2,
    attesterPubkeyX: '0x8b12',
    attesterPubkeyY: '0xe734',
    merkleProof: ['0x1fb8', '0xb27c'],
    merkleLeafIndex: 0,
    merkleDepth: 2,
  };

  describe('bytesToHexArray format', () => {
    it('should produce correct hex array format with 0x prefix and commas', () => {
      const result = toProverToml('coinbase_attestation', {
        ...mockBaseParams,
        signalHash: new Uint8Array([0xab, 0xcd, 0xef]),
      });

      expect(result).toContain('signal_hash = [0xab, 0xcd, 0xef]');
    });
  });

  describe('coinbase_attestation circuit', () => {
    it('should produce all expected fields in correct order', () => {
      const result = toProverToml('coinbase_attestation', mockBaseParams);

      const lines = result.split('\n');
      const fieldOrder = lines
        .filter(line => line.includes(' = ') && !line.trim().startsWith('['))
        .map(line => line.split(' = ')[0].trim());

      expect(fieldOrder).toEqual([
        'signal_hash',
        'signer_list_merkle_root',
        'scope',
        'nullifier',
        'user_address',
        'user_signature',
        'user_pubkey_x',
        'user_pubkey_y',
        'tx_length',
        'raw_transaction',
        'coinbase_attester_pubkey_x',
        'coinbase_attester_pubkey_y',
        'coinbase_signer_merkle_proof',
        'coinbase_signer_leaf_index',
        'merkle_proof_depth',
      ]);
    });

    it('should include integer fields as plain numbers', () => {
      const result = toProverToml('coinbase_attestation', {
        ...mockBaseParams,
        txLength: 149,
        merkleLeafIndex: 3,
        merkleDepth: 5,
      });

      expect(result).toContain('tx_length = 149');
      expect(result).toContain('coinbase_signer_leaf_index = 3');
      expect(result).toContain('merkle_proof_depth = 5');
    });
  });

  describe('coinbase_country_attestation circuit', () => {
    it('should include country fields in correct position', () => {
      const result = toProverToml('coinbase_country_attestation', {
        ...mockBaseParams,
        countryList: ['US', 'KR'],
        countryListLength: 2,
        isIncluded: true,
      });

      const lines = result.split('\n');
      const fieldOrder = lines
        .filter(line => line.includes(' = ') && !line.trim().startsWith('['))
        .map(line => line.split(' = ')[0].trim());

      // country_list, country_list_length, is_included should appear AFTER signer_list_merkle_root, BEFORE scope
      const rootIndex = fieldOrder.indexOf('signer_list_merkle_root');
      const scopeIndex = fieldOrder.indexOf('scope');
      const countryListIndex = fieldOrder.indexOf('country_list');
      const countryListLengthIndex = fieldOrder.indexOf('country_list_length');
      const isIncludedIndex = fieldOrder.indexOf('is_included');

      expect(countryListIndex).toBeGreaterThan(rootIndex);
      expect(countryListIndex).toBeLessThan(scopeIndex);
      expect(countryListLengthIndex).toBeGreaterThan(countryListIndex);
      expect(countryListLengthIndex).toBeLessThan(scopeIndex);
      expect(isIncludedIndex).toBeGreaterThan(countryListLengthIndex);
      expect(isIncludedIndex).toBeLessThan(scopeIndex);
    });

    it('should format boolean field as lowercase', () => {
      const resultTrue = toProverToml('coinbase_country_attestation', {
        ...mockBaseParams,
        countryList: ['US'],
        countryListLength: 1,
        isIncluded: true,
      });

      const resultFalse = toProverToml('coinbase_country_attestation', {
        ...mockBaseParams,
        countryList: ['US'],
        countryListLength: 1,
        isIncluded: false,
      });

      expect(resultTrue).toContain('is_included = true');
      expect(resultFalse).toContain('is_included = false');
    });
  });

  describe('padding and fixed sizes', () => {
    it('should pad raw_transaction to exactly 300 bytes', () => {
      const result = toProverToml('coinbase_attestation', {
        ...mockBaseParams,
        rawTxBytes: [0x02, 0xff],
      });

      const rawTxMatch = result.match(/raw_transaction = \[(.*?)\]/s);
      expect(rawTxMatch).toBeTruthy();

      const bytes = rawTxMatch![1].split(',').map(s => s.trim());
      expect(bytes).toHaveLength(300);
      expect(bytes[0]).toBe('0x02');
      expect(bytes[1]).toBe('0xff');
      expect(bytes[299]).toBe('0x00');
    });

    it('should format merkle proof with exactly 8 entries of 32 bytes each', () => {
      const result = toProverToml('coinbase_attestation', {
        ...mockBaseParams,
        merkleProof: ['0x' + '1f'.repeat(32), '0x' + 'b2'.repeat(32)],
        merkleDepth: 2,
      });

      const proofMatch = result.match(/coinbase_signer_merkle_proof = \[([\s\S]+)\]\ncoinbase_signer_leaf_index/);
      expect(proofMatch).toBeTruthy();

      const entries = proofMatch![1]
        .split(/\],?\s*\n/)
        .map(s => s.trim())
        .filter(s => s.startsWith('['));

      expect(entries).toHaveLength(8);

      // Check first two are populated
      expect(entries[0]).toContain('0x1f');
      expect(entries[1]).toContain('0xb2');

      // Check remaining are zeros
      for (let i = 2; i < 8; i++) {
        expect(entries[i]).toContain('0x00');
      }
    });

    it('should format country list with exactly 10 entries of 2 bytes each', () => {
      const result = toProverToml('coinbase_country_attestation', {
        ...mockBaseParams,
        countryList: ['US', 'KR'],
        countryListLength: 2,
        isIncluded: true,
      });

      const countryMatch = result.match(/country_list = \[([\s\S]+)\]\ncountry_list_length/);
      expect(countryMatch).toBeTruthy();

      const entries = countryMatch![1]
        .split(/\],?\s*\n/)
        .map(s => s.trim())
        .filter(s => s.startsWith('['));

      expect(entries).toHaveLength(10);

      // Check first two are US and KR
      expect(entries[0]).toContain('0x55');
      expect(entries[0]).toContain('0x53'); // ASCII for 'U', 'S'

      expect(entries[1]).toContain('0x4b');
      expect(entries[1]).toContain('0x52'); // ASCII for 'K', 'R'

      // Check remaining are zeros
      for (let i = 2; i < 10; i++) {
        expect(entries[i]).toContain('0x00');
      }
    });
  });

  describe('signature splitting', () => {
    it('should split signature into r+s (64 bytes), dropping v', () => {
      // Use a valid canonical signature (low s value)
      const sig = '0x' + '12'.repeat(32) + '34'.repeat(32) + '1c';
      const result = toProverToml('coinbase_attestation', {
        ...mockBaseParams,
        userSignature: sig,
      });

      const sigMatch = result.match(/user_signature = \[(.*?)\]/);
      expect(sigMatch).toBeTruthy();

      const bytes = sigMatch![1].split(',').map(s => s.trim());
      expect(bytes).toHaveLength(64);
      expect(bytes[0]).toBe('0x12');
      expect(bytes[31]).toBe('0x12');
      expect(bytes[32]).toBe('0x34');
      expect(bytes[63]).toBe('0x34');
    });
  });
});
