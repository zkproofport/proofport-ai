import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ethers } from 'ethers';

// ─── Import units under test ─────────────────────────────────────────────

import { SimpleMerkleTree } from '../src/input/merkleTree.js';
import {
  hexToBytes,
  padBytes,
  bytesToDecimalStrings,
  uint8ArrayToDecimalStrings,
  extractPubkeyCoordinates,
  recoverUserPubkey,
  buildSignerMerkleTree,
  findSignerIndex,
  encodeCountryList,
  splitSignatureToBytes,
  buildPaddedMerkleProof,
} from '../src/input/inputBuilder.js';
import {
  validateAttestationTx,
  recoverAttesterPubkey,
  getSignerAddress,
  reconstructRawTransaction,
} from '../src/input/attestationFetcher.js';
import { AUTHORIZED_SIGNERS } from '../src/config/contracts.js';
import { computeSignalHash as computeRequestSignalHash } from '../packages/sdk/src/signalHash.js';

// signal_hash no longer names the wallet (2026-11-17); the server does not
// compute it. These tests take it from the repository's one helper with a fixed
// request id. The address argument is kept so call sites read as before and is
// deliberately unused -- see tests/signalHash.test.ts for the rule itself.
const TEST_REQUEST_ID = '3f2b8c1e-9d4a-4f6b-8e2c-1a7d5b9c0e4f';
function computeSignalHash(_address: string, scope: string, circuitId: string): Uint8Array {
  return computeRequestSignalHash({ scope, circuitId, requestId: TEST_REQUEST_ID });
}

// ─── Test fixtures ───────────────────────────────────────────────────────

// Test wallet — loaded from .env.test (via tests/setup.ts)
const TEST_PRIVATE_KEY = process.env.PROVER_PRIVATE_KEY;
if (!TEST_PRIVATE_KEY) throw new Error('PROVER_PRIVATE_KEY is required in .env.test');
const TEST_WALLET = new ethers.Wallet(TEST_PRIVATE_KEY);
const TEST_ADDRESS = TEST_WALLET.address;

const TEST_SCOPE = 'test-scope-v1';
const TEST_CIRCUIT_KYC = 'coinbase_attestation';
const TEST_CIRCUIT_COUNTRY = 'coinbase_country_attestation';

// ─── SimpleMerkleTree ────────────────────────────────────────────────────

describe('SimpleMerkleTree', () => {
  it('should build a tree with 4 leaves and produce a valid root', () => {
    const tree = new SimpleMerkleTree(AUTHORIZED_SIGNERS);
    const root = tree.getRoot();

    // Root must be a 32-byte keccak256 hash
    expect(root).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('should produce consistent root for same addresses', () => {
    const tree1 = new SimpleMerkleTree(AUTHORIZED_SIGNERS);
    const tree2 = new SimpleMerkleTree(AUTHORIZED_SIGNERS);
    expect(tree1.getRoot()).toBe(tree2.getRoot());
  });

  it('should produce different roots for different address orders', () => {
    const tree1 = new SimpleMerkleTree(AUTHORIZED_SIGNERS);
    const reversed = [...AUTHORIZED_SIGNERS].reverse();
    const tree2 = new SimpleMerkleTree(reversed);
    expect(tree1.getRoot()).not.toBe(tree2.getRoot());
  });

  it('should return valid proof for each leaf index', () => {
    const tree = new SimpleMerkleTree(AUTHORIZED_SIGNERS);

    for (let i = 0; i < AUTHORIZED_SIGNERS.length; i++) {
      const { proof, leafIndex, depth } = tree.getProof(i);
      expect(leafIndex).toBe(i);
      expect(depth).toBeGreaterThan(0);
      expect(proof.length).toBe(depth);
      // Each proof element is a 32-byte hash
      for (const p of proof) {
        expect(p).toMatch(/^0x[0-9a-f]{64}$/);
      }
    }
  });

  it('should verify proof against root via manual recomputation', () => {
    const tree = new SimpleMerkleTree(AUTHORIZED_SIGNERS);
    const root = tree.getRoot();

    // Verify proof for index 0
    const { proof, leafIndex } = tree.getProof(0);
    let current = tree.getLeafHash(0);
    let idx = leafIndex;

    for (const sibling of proof) {
      const isRight = idx % 2 === 1;
      const left = isRight ? sibling : current;
      const right = isRight ? current : sibling;
      current = ethers.keccak256(
        ethers.concat([ethers.getBytes(left), ethers.getBytes(right)])
      );
      idx = Math.floor(idx / 2);
    }

    expect(current).toBe(root);
  });

  it('should throw for empty addresses', () => {
    expect(() => new SimpleMerkleTree([])).toThrow('at least one address');
  });

  it('should throw for out-of-bounds leaf index', () => {
    const tree = new SimpleMerkleTree(AUTHORIZED_SIGNERS);
    expect(() => tree.getProof(-1)).toThrow('out of bounds');
    expect(() => tree.getProof(100)).toThrow('out of bounds');
  });

  it('should handle a single address', () => {
    const tree = new SimpleMerkleTree([AUTHORIZED_SIGNERS[0]]);
    const root = tree.getRoot();
    const leaf = tree.getLeafHash(0);
    // With 1 leaf, root == leaf hash
    expect(root).toBe(leaf);
  });

  it('should handle odd number of addresses', () => {
    const tree = new SimpleMerkleTree(AUTHORIZED_SIGNERS.slice(0, 3));
    const root = tree.getRoot();
    expect(root).toMatch(/^0x[0-9a-f]{64}$/);
    // Proof for index 2 should still work
    const { proof, depth } = tree.getProof(2);
    expect(depth).toBeGreaterThan(0);
    expect(proof.length).toBe(depth);
  });
});

// ─── hexToBytes ──────────────────────────────────────────────────────────

describe('hexToBytes', () => {
  it('should convert hex string with 0x prefix', () => {
    expect(hexToBytes('0xff00ab')).toEqual([255, 0, 171]);
  });

  it('should convert hex string without prefix', () => {
    expect(hexToBytes('ff00ab')).toEqual([255, 0, 171]);
  });

  it('should handle empty hex', () => {
    expect(hexToBytes('0x')).toEqual([]);
    expect(hexToBytes('')).toEqual([]);
  });

  it('should convert a 20-byte address', () => {
    const bytes = hexToBytes('0x952f32128AF084422539C4Ff96df5C525322E564');
    expect(bytes.length).toBe(20);
    expect(bytes[0]).toBe(0x95);
  });
});

// ─── padBytes ────────────────────────────────────────────────────────────

describe('padBytes', () => {
  it('should pad array to target length', () => {
    const result = padBytes([1, 2, 3], 5);
    expect(result).toEqual([1, 2, 3, 0, 0]);
  });

  it('should not modify array already at target length', () => {
    const result = padBytes([1, 2, 3], 3);
    expect(result).toEqual([1, 2, 3]);
  });

  it('should not truncate array longer than target', () => {
    const result = padBytes([1, 2, 3, 4, 5], 3);
    expect(result).toEqual([1, 2, 3, 4, 5]);
  });
});

// ─── bytesToDecimalStrings ───────────────────────────────────────────────

describe('bytesToDecimalStrings', () => {
  it('should convert bytes to decimal strings', () => {
    expect(bytesToDecimalStrings([0, 1, 149, 255])).toEqual(['0', '1', '149', '255']);
  });

  it('should NOT produce hex strings', () => {
    const result = bytesToDecimalStrings([149]);
    expect(result[0]).toBe('149');
    expect(result[0]).not.toBe('0x95');
    expect(result[0]).not.toMatch(/^0x/);
  });

  it('should handle empty array', () => {
    expect(bytesToDecimalStrings([])).toEqual([]);
  });
});

// ─── uint8ArrayToDecimalStrings ──────────────────────────────────────────

describe('uint8ArrayToDecimalStrings', () => {
  it('should convert Uint8Array to decimal strings', () => {
    const arr = new Uint8Array([0, 128, 255]);
    expect(uint8ArrayToDecimalStrings(arr)).toEqual(['0', '128', '255']);
  });
});

// ─── extractPubkeyCoordinates ────────────────────────────────────────────

describe('extractPubkeyCoordinates', () => {
  it('should extract x and y from 0x04-prefixed key', () => {
    const x = 'a'.repeat(64);
    const y = 'b'.repeat(64);
    const pubkey = '0x04' + x + y;
    const result = extractPubkeyCoordinates(pubkey);
    expect(result.x).toBe('0x' + x);
    expect(result.y).toBe('0x' + y);
  });

  it('should handle 04-prefixed key without 0x', () => {
    const x = 'c'.repeat(64);
    const y = 'd'.repeat(64);
    const pubkey = '04' + x + y;
    const result = extractPubkeyCoordinates(pubkey);
    expect(result.x).toBe('0x' + x);
    expect(result.y).toBe('0x' + y);
  });
});

// computeSignalHash's own tests (old rule: address ++ scope ++ circuit) were
// replaced by tests/signalHash.test.ts when the address left the preimage.

// ─── splitSignatureToBytes ──────────────────────────────────────────────

describe('splitSignatureToBytes', () => {
  it('should produce exactly 64 bytes (r=32 + s=32)', async () => {
    const hash = computeSignalHash(TEST_ADDRESS, TEST_SCOPE, TEST_CIRCUIT_KYC);
    const signature = await TEST_WALLET.signMessage(ethers.getBytes(ethers.hexlify(hash)));
    const bytes = splitSignatureToBytes(signature);
    expect(bytes.length).toBe(64);
  });

  it('should contain only values 0-255', async () => {
    const hash = computeSignalHash(TEST_ADDRESS, TEST_SCOPE, TEST_CIRCUIT_KYC);
    const signature = await TEST_WALLET.signMessage(ethers.getBytes(ethers.hexlify(hash)));
    const bytes = splitSignatureToBytes(signature);
    for (const b of bytes) {
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThanOrEqual(255);
    }
  });
});

// ─── buildPaddedMerkleProof ─────────────────────────────────────────────

describe('buildPaddedMerkleProof', () => {
  it('should produce exactly 256 decimal strings (8 * 32 bytes)', () => {
    const tree = new SimpleMerkleTree(AUTHORIZED_SIGNERS);
    const { proof, depth } = tree.getProof(0);
    const padded = buildPaddedMerkleProof(proof, depth);
    expect(padded.length).toBe(256);
  });

  it('should pad empty proof slots with zeros', () => {
    const padded = buildPaddedMerkleProof([], 0);
    expect(padded.length).toBe(256);
    expect(padded.every(v => v === '0')).toBe(true);
  });

  it('should use decimal format', () => {
    const tree = new SimpleMerkleTree(AUTHORIZED_SIGNERS);
    const { proof, depth } = tree.getProof(0);
    const padded = buildPaddedMerkleProof(proof, depth);
    for (const v of padded) {
      expect(v).toMatch(/^\d+$/);
      expect(v).not.toMatch(/^0x/);
    }
  });
});

// ─── Attestation fetcher (unit tests with mocks) ────────────────────────

describe('validateAttestationTx', () => {
  // We need a real signed transaction to test. Let's create one with ethers v6.
  let signedTx: string;

  beforeEach(async () => {
    // Create a fake signed transaction to the Coinbase Attester Contract
    // with the KYC function selector 0x56feed5e
    const wallet = new ethers.Wallet(TEST_PRIVATE_KEY);
    const tx = ethers.Transaction.from({
      to: '0x357458739F90461b99789350868CD7CF330Dd7EE',
      nonce: 0,
      gasLimit: 100000n,
      maxFeePerGas: 1000000000n,
      maxPriorityFeePerGas: 1000000n,
      data: '0x56feed5e' + '0'.repeat(56) + TEST_ADDRESS.slice(2).toLowerCase(),
      value: 0n,
      chainId: 8453n,
      type: 2,
    });

    const unsignedHash = ethers.keccak256(tx.unsignedSerialized);
    const sig = wallet.signingKey.sign(unsignedHash);

    signedTx = ethers.Transaction.from({
      to: tx.to,
      nonce: tx.nonce,
      gasLimit: tx.gasLimit,
      maxFeePerGas: tx.maxFeePerGas,
      maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
      data: tx.data,
      value: tx.value,
      chainId: tx.chainId,
      type: 2,
      signature: sig,
    }).serialized;
  });

  it('should validate a correct attestation transaction', () => {
    const result = validateAttestationTx(signedTx, 'coinbase_attestation');
    expect(result.valid).toBe(true);
  });

  it('should reject transaction to wrong address', async () => {
    const wallet = new ethers.Wallet(TEST_PRIVATE_KEY);
    const tx = ethers.Transaction.from({
      to: '0x0000000000000000000000000000000000000001',
      nonce: 0,
      gasLimit: 100000n,
      maxFeePerGas: 1000000000n,
      maxPriorityFeePerGas: 1000000n,
      data: '0x56feed5e' + '0'.repeat(120),
      value: 0n,
      chainId: 8453n,
      type: 2,
    });

    const unsignedHash = ethers.keccak256(tx.unsignedSerialized);
    const sig = wallet.signingKey.sign(unsignedHash);

    const badTx = ethers.Transaction.from({
      ...tx.toJSON(),
      signature: sig,
    }).serialized;

    const result = validateAttestationTx(badTx, 'coinbase_attestation');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('does not match Coinbase Attester Contract');
  });

  it('should reject transaction with wrong function selector', async () => {
    const wallet = new ethers.Wallet(TEST_PRIVATE_KEY);
    const tx = ethers.Transaction.from({
      to: '0x357458739F90461b99789350868CD7CF330Dd7EE',
      nonce: 0,
      gasLimit: 100000n,
      maxFeePerGas: 1000000000n,
      maxPriorityFeePerGas: 1000000n,
      data: '0xdeadbeef' + '0'.repeat(120),
      value: 0n,
      chainId: 8453n,
      type: 2,
    });

    const unsignedHash = ethers.keccak256(tx.unsignedSerialized);
    const sig = wallet.signingKey.sign(unsignedHash);

    const badTx = ethers.Transaction.from({
      ...tx.toJSON(),
      signature: sig,
    }).serialized;

    const result = validateAttestationTx(badTx, 'coinbase_attestation');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Function selector');
  });
});

describe('recoverAttesterPubkey', () => {
  it('should recover a valid uncompressed public key from a signed transaction', () => {
    const wallet = new ethers.Wallet(TEST_PRIVATE_KEY);
    const tx = ethers.Transaction.from({
      to: '0x357458739F90461b99789350868CD7CF330Dd7EE',
      nonce: 0,
      gasLimit: 100000n,
      maxFeePerGas: 1000000000n,
      maxPriorityFeePerGas: 1000000n,
      data: '0x56feed5e' + '0'.repeat(120),
      value: 0n,
      chainId: 8453n,
      type: 2,
    });

    const unsignedHash = ethers.keccak256(tx.unsignedSerialized);
    const sig = wallet.signingKey.sign(unsignedHash);

    const signedTx = ethers.Transaction.from({
      ...tx.toJSON(),
      signature: sig,
    }).serialized;

    const pubkey = recoverAttesterPubkey(signedTx);

    // Should be uncompressed: 0x04 + 64 hex X + 64 hex Y
    expect(pubkey.startsWith('0x04')).toBe(true);
    expect(pubkey.length).toBe(132);

    // Should recover to test wallet's address
    const recovered = getSignerAddress(pubkey);
    expect(recovered.toLowerCase()).toBe(TEST_ADDRESS.toLowerCase());
  });
});

// ─── reconstructRawTransaction ──────────────────────────────────────────

describe('reconstructRawTransaction', () => {
  it('should reconstruct a valid signed transaction from RPC fields', () => {
    // First, create a real signed transaction
    const wallet = new ethers.Wallet(TEST_PRIVATE_KEY);
    const tx = ethers.Transaction.from({
      to: '0x357458739F90461b99789350868CD7CF330Dd7EE',
      nonce: 42,
      gasLimit: 100000n,
      maxFeePerGas: 1000000000n,
      maxPriorityFeePerGas: 1000000n,
      data: '0x56feed5e' + '0'.repeat(120),
      value: 0n,
      chainId: 8453n,
      type: 2,
    });

    const unsignedHash = ethers.keccak256(tx.unsignedSerialized);
    const sig = wallet.signingKey.sign(unsignedHash);

    const signedTx = ethers.Transaction.from({
      ...tx.toJSON(),
      signature: sig,
    });

    // Now simulate RPC response fields
    const rpcData = {
      to: signedTx.to!,
      nonce: '0x' + signedTx.nonce.toString(16),
      gas: '0x' + signedTx.gasLimit.toString(16),
      maxFeePerGas: '0x' + signedTx.maxFeePerGas!.toString(16),
      maxPriorityFeePerGas: '0x' + signedTx.maxPriorityFeePerGas!.toString(16),
      input: signedTx.data,
      value: '0x0',
      chainId: '0x' + signedTx.chainId.toString(16),
      type: '0x2',
      v: '0x' + sig.v.toString(16),
      r: sig.r,
      s: sig.s,
    };

    const reconstructed = reconstructRawTransaction(rpcData);

    // Parse both and compare key fields
    const original = ethers.Transaction.from(signedTx.serialized);
    const rebuilt = ethers.Transaction.from(reconstructed);

    expect(rebuilt.to?.toLowerCase()).toBe(original.to?.toLowerCase());
    expect(rebuilt.nonce).toBe(original.nonce);
    expect(rebuilt.data).toBe(original.data);
    expect(rebuilt.chainId).toBe(original.chainId);
  });
});

// ─── Decimal format enforcement ─────────────────────────────────────────

describe('decimal format enforcement', () => {
  it('all byte conversion functions should produce decimal strings, not hex', () => {
    // bytesToDecimalStrings
    const dec = bytesToDecimalStrings([0x95, 0x2f, 0x32]);
    expect(dec).toEqual(['149', '47', '50']);
    expect(dec.every(s => /^\d+$/.test(s))).toBe(true);

    // uint8ArrayToDecimalStrings
    const u8dec = uint8ArrayToDecimalStrings(new Uint8Array([0xff, 0x00, 0xab]));
    expect(u8dec).toEqual(['255', '0', '171']);
    expect(u8dec.every(s => /^\d+$/.test(s))).toBe(true);
  });

  it('encodeCountryList should produce decimal strings', () => {
    const encoded = encodeCountryList(['US']);
    expect(encoded.every(s => /^\d+$/.test(s))).toBe(true);
  });
});
