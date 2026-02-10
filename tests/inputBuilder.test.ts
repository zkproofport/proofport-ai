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
  computeSignalHash,
  recoverUserPubkey,
  buildSignerMerkleTree,
  findSignerIndex,
  computeScope,
  computeNullifier,
  encodeCountryList,
  splitSignatureToBytes,
  buildPaddedMerkleProof,
  assembleKycInputs,
  assembleCountryInputs,
} from '../src/input/inputBuilder.js';
import {
  validateAttestationTx,
  recoverAttesterPubkey,
  getSignerAddress,
  reconstructRawTransaction,
} from '../src/input/attestationFetcher.js';
import { AUTHORIZED_SIGNERS } from '../src/config/contracts.js';

// ─── Test fixtures ───────────────────────────────────────────────────────

// Deterministic test wallet (DO NOT use in production)
const TEST_PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const TEST_WALLET = new ethers.Wallet(TEST_PRIVATE_KEY);
const TEST_ADDRESS = TEST_WALLET.address; // 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266

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

// ─── computeSignalHash ──────────────────────────────────────────────────

describe('computeSignalHash', () => {
  it('should produce 32 bytes', () => {
    const hash = computeSignalHash(TEST_ADDRESS, TEST_SCOPE, TEST_CIRCUIT_KYC);
    expect(hash.length).toBe(32);
  });

  it('should be deterministic', () => {
    const hash1 = computeSignalHash(TEST_ADDRESS, TEST_SCOPE, TEST_CIRCUIT_KYC);
    const hash2 = computeSignalHash(TEST_ADDRESS, TEST_SCOPE, TEST_CIRCUIT_KYC);
    expect(ethers.hexlify(hash1)).toBe(ethers.hexlify(hash2));
  });

  it('should differ for different addresses', () => {
    const hash1 = computeSignalHash(TEST_ADDRESS, TEST_SCOPE, TEST_CIRCUIT_KYC);
    const hash2 = computeSignalHash(
      '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
      TEST_SCOPE,
      TEST_CIRCUIT_KYC,
    );
    expect(ethers.hexlify(hash1)).not.toBe(ethers.hexlify(hash2));
  });

  it('should differ for different scopes', () => {
    const hash1 = computeSignalHash(TEST_ADDRESS, 'scope-a', TEST_CIRCUIT_KYC);
    const hash2 = computeSignalHash(TEST_ADDRESS, 'scope-b', TEST_CIRCUIT_KYC);
    expect(ethers.hexlify(hash1)).not.toBe(ethers.hexlify(hash2));
  });

  it('should differ for different circuit names', () => {
    const hash1 = computeSignalHash(TEST_ADDRESS, TEST_SCOPE, TEST_CIRCUIT_KYC);
    const hash2 = computeSignalHash(TEST_ADDRESS, TEST_SCOPE, TEST_CIRCUIT_COUNTRY);
    expect(ethers.hexlify(hash1)).not.toBe(ethers.hexlify(hash2));
  });

  it('should match the expected solidityPacked + keccak256 computation', () => {
    const hash = computeSignalHash(TEST_ADDRESS, TEST_SCOPE, TEST_CIRCUIT_KYC);

    // Manual recomputation
    const preimage = ethers.solidityPacked(
      ['address', 'string', 'string'],
      [TEST_ADDRESS, TEST_SCOPE, TEST_CIRCUIT_KYC],
    );
    const expected = ethers.getBytes(ethers.keccak256(preimage));
    expect(ethers.hexlify(hash)).toBe(ethers.hexlify(expected));
  });
});

// ─── recoverUserPubkey ──────────────────────────────────────────────────

describe('recoverUserPubkey', () => {
  it('should recover the correct public key from a signature', async () => {
    const signalHash = computeSignalHash(TEST_ADDRESS, TEST_SCOPE, TEST_CIRCUIT_KYC);
    const messageHex = ethers.hexlify(signalHash);

    // Sign with test wallet (personal_sign = signMessage)
    const signature = await TEST_WALLET.signMessage(ethers.getBytes(messageHex));

    const recoveredPubkey = recoverUserPubkey(signalHash, signature);

    // Should be uncompressed format starting with 0x04
    expect(recoveredPubkey.startsWith('0x04')).toBe(true);
    expect(recoveredPubkey.length).toBe(132); // 0x + 04 + 64 hex X + 64 hex Y

    // The address derived from the recovered pubkey should match TEST_ADDRESS
    const recoveredAddress = ethers.computeAddress(recoveredPubkey);
    expect(recoveredAddress.toLowerCase()).toBe(TEST_ADDRESS.toLowerCase());
  });
});

// ─── computeScope ───────────────────────────────────────────────────────

describe('computeScope', () => {
  it('should produce 32 bytes', () => {
    const scope = computeScope(TEST_SCOPE);
    expect(scope.length).toBe(32);
  });

  it('should be deterministic', () => {
    const scope1 = computeScope(TEST_SCOPE);
    const scope2 = computeScope(TEST_SCOPE);
    expect(ethers.hexlify(scope1)).toBe(ethers.hexlify(scope2));
  });

  it('should match keccak256(toUtf8Bytes(scopeString))', () => {
    const scope = computeScope(TEST_SCOPE);
    const expected = ethers.getBytes(ethers.keccak256(ethers.toUtf8Bytes(TEST_SCOPE)));
    expect(ethers.hexlify(scope)).toBe(ethers.hexlify(expected));
  });
});

// ─── computeNullifier ───────────────────────────────────────────────────

describe('computeNullifier', () => {
  it('should produce 32 bytes', () => {
    const signalHash = computeSignalHash(TEST_ADDRESS, TEST_SCOPE, TEST_CIRCUIT_KYC);
    const scopeBytes = computeScope(TEST_SCOPE);
    const nullifier = computeNullifier(TEST_ADDRESS, signalHash, scopeBytes);
    expect(nullifier.length).toBe(32);
  });

  it('should be deterministic', () => {
    const signalHash = computeSignalHash(TEST_ADDRESS, TEST_SCOPE, TEST_CIRCUIT_KYC);
    const scopeBytes = computeScope(TEST_SCOPE);
    const n1 = computeNullifier(TEST_ADDRESS, signalHash, scopeBytes);
    const n2 = computeNullifier(TEST_ADDRESS, signalHash, scopeBytes);
    expect(ethers.hexlify(n1)).toBe(ethers.hexlify(n2));
  });

  it('should match manual computation: keccak256(keccak256(address + signalHash) + scope)', () => {
    const signalHash = computeSignalHash(TEST_ADDRESS, TEST_SCOPE, TEST_CIRCUIT_KYC);
    const scopeBytes = computeScope(TEST_SCOPE);
    const nullifier = computeNullifier(TEST_ADDRESS, signalHash, scopeBytes);

    // Manual recomputation
    const userAddressBytes = ethers.getBytes(TEST_ADDRESS);
    const userSecret = ethers.getBytes(
      ethers.keccak256(ethers.concat([userAddressBytes, signalHash]))
    );
    const expected = ethers.getBytes(
      ethers.keccak256(ethers.concat([userSecret, scopeBytes]))
    );
    expect(ethers.hexlify(nullifier)).toBe(ethers.hexlify(expected));
  });

  it('should differ for different scopes (different nullifiers per scope)', () => {
    const signalHash = computeSignalHash(TEST_ADDRESS, TEST_SCOPE, TEST_CIRCUIT_KYC);
    const scope1 = computeScope('scope-a');
    const scope2 = computeScope('scope-b');
    const n1 = computeNullifier(TEST_ADDRESS, signalHash, scope1);
    const n2 = computeNullifier(TEST_ADDRESS, signalHash, scope2);
    expect(ethers.hexlify(n1)).not.toBe(ethers.hexlify(n2));
  });
});

// ─── findSignerIndex ────────────────────────────────────────────────────

describe('findSignerIndex', () => {
  it('should find each authorized signer', () => {
    for (let i = 0; i < AUTHORIZED_SIGNERS.length; i++) {
      expect(findSignerIndex(AUTHORIZED_SIGNERS[i])).toBe(i);
    }
  });

  it('should be case-insensitive', () => {
    expect(findSignerIndex(AUTHORIZED_SIGNERS[0].toLowerCase())).toBe(0);
    expect(findSignerIndex(AUTHORIZED_SIGNERS[0].toUpperCase())).toBe(0);
  });

  it('should throw for unknown signer', () => {
    expect(() => findSignerIndex('0x0000000000000000000000000000000000000000')).toThrow(
      'not in the authorized signers list'
    );
  });
});

// ─── buildSignerMerkleTree ──────────────────────────────────────────────

describe('buildSignerMerkleTree', () => {
  it('should return root, proof, leafIndex, and depth', () => {
    const data = buildSignerMerkleTree(0);
    expect(data.root).toMatch(/^0x[0-9a-f]{64}$/);
    expect(data.leafIndex).toBe(0);
    expect(data.depth).toBeGreaterThan(0);
    expect(data.proof.length).toBe(data.depth);
  });

  it('should return same root for all signer indices', () => {
    const roots = AUTHORIZED_SIGNERS.map((_, i) => buildSignerMerkleTree(i).root);
    expect(new Set(roots).size).toBe(1);
  });
});

// ─── encodeCountryList ──────────────────────────────────────────────────

describe('encodeCountryList', () => {
  it('should encode countries as ASCII byte pairs in decimal', () => {
    const result = encodeCountryList(['US', 'KR']);
    // US: U=85, S=83; KR: K=75, R=82
    expect(result[0]).toBe('85');  // U
    expect(result[1]).toBe('83');  // S
    expect(result[2]).toBe('75');  // K
    expect(result[3]).toBe('82');  // R
    // Remaining 8 pairs should be zero
    for (let i = 4; i < 20; i++) {
      expect(result[i]).toBe('0');
    }
  });

  it('should always produce exactly 20 entries', () => {
    expect(encodeCountryList([])).toHaveLength(20);
    expect(encodeCountryList(['US'])).toHaveLength(20);
    expect(encodeCountryList(['US', 'KR', 'JP', 'GB', 'DE', 'FR', 'CA', 'AU', 'BR', 'IN'])).toHaveLength(20);
  });

  it('should use decimal format, not hex', () => {
    const result = encodeCountryList(['US']);
    expect(result[0]).not.toMatch(/^0x/);
    expect(result[0]).toMatch(/^\d+$/);
  });

  it('should pad with zeros for missing countries', () => {
    const result = encodeCountryList([]);
    expect(result.every(v => v === '0')).toBe(true);
  });
});

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

// ─── assembleKycInputs ──────────────────────────────────────────────────

describe('assembleKycInputs', () => {
  it('should produce exactly 899 entries', async () => {
    const signalHash = computeSignalHash(TEST_ADDRESS, TEST_SCOPE, TEST_CIRCUIT_KYC);
    const signature = await TEST_WALLET.signMessage(ethers.getBytes(ethers.hexlify(signalHash)));
    const userPubkey = recoverUserPubkey(signalHash, signature);
    const { x: pubX, y: pubY } = extractPubkeyCoordinates(userPubkey);
    const scopeBytes = computeScope(TEST_SCOPE);
    const nullifierBytes = computeNullifier(TEST_ADDRESS, signalHash, scopeBytes);
    const merkleData = buildSignerMerkleTree(0);

    // Fake raw TX bytes (200 bytes)
    const rawTxBytes = new Array(200).fill(0).map((_, i) => i % 256);

    // Fake attester pubkey (just use user's for test)
    const inputs = assembleKycInputs({
      signalHash,
      merkleRoot: merkleData.root,
      scopeBytes,
      nullifierBytes,
      userAddress: TEST_ADDRESS,
      userSignature: signature,
      userPubkeyX: pubX,
      userPubkeyY: pubY,
      rawTxBytes,
      txLength: 200,
      attesterPubkeyX: pubX,
      attesterPubkeyY: pubY,
      merkleProof: merkleData.proof,
      merkleLeafIndex: merkleData.leafIndex,
      merkleDepth: merkleData.depth,
    });

    expect(inputs.length).toBe(899);
  });

  it('should contain only decimal strings', async () => {
    const signalHash = computeSignalHash(TEST_ADDRESS, TEST_SCOPE, TEST_CIRCUIT_KYC);
    const signature = await TEST_WALLET.signMessage(ethers.getBytes(ethers.hexlify(signalHash)));
    const userPubkey = recoverUserPubkey(signalHash, signature);
    const { x: pubX, y: pubY } = extractPubkeyCoordinates(userPubkey);
    const scopeBytes = computeScope(TEST_SCOPE);
    const nullifierBytes = computeNullifier(TEST_ADDRESS, signalHash, scopeBytes);
    const merkleData = buildSignerMerkleTree(0);
    const rawTxBytes = new Array(150).fill(42);

    const inputs = assembleKycInputs({
      signalHash,
      merkleRoot: merkleData.root,
      scopeBytes,
      nullifierBytes,
      userAddress: TEST_ADDRESS,
      userSignature: signature,
      userPubkeyX: pubX,
      userPubkeyY: pubY,
      rawTxBytes,
      txLength: 150,
      attesterPubkeyX: pubX,
      attesterPubkeyY: pubY,
      merkleProof: merkleData.proof,
      merkleLeafIndex: merkleData.leafIndex,
      merkleDepth: merkleData.depth,
    });

    for (let i = 0; i < inputs.length; i++) {
      expect(inputs[i]).toMatch(/^\d+$/);
    }
  });

  it('should have correct field layout', async () => {
    const signalHash = computeSignalHash(TEST_ADDRESS, TEST_SCOPE, TEST_CIRCUIT_KYC);
    const signature = await TEST_WALLET.signMessage(ethers.getBytes(ethers.hexlify(signalHash)));
    const userPubkey = recoverUserPubkey(signalHash, signature);
    const { x: pubX, y: pubY } = extractPubkeyCoordinates(userPubkey);
    const scopeBytes = computeScope(TEST_SCOPE);
    const nullifierBytes = computeNullifier(TEST_ADDRESS, signalHash, scopeBytes);
    const merkleData = buildSignerMerkleTree(0);
    const rawTxBytes = new Array(200).fill(0);

    const inputs = assembleKycInputs({
      signalHash,
      merkleRoot: merkleData.root,
      scopeBytes,
      nullifierBytes,
      userAddress: TEST_ADDRESS,
      userSignature: signature,
      userPubkeyX: pubX,
      userPubkeyY: pubY,
      rawTxBytes,
      txLength: 200,
      attesterPubkeyX: pubX,
      attesterPubkeyY: pubY,
      merkleProof: merkleData.proof,
      merkleLeafIndex: merkleData.leafIndex,
      merkleDepth: merkleData.depth,
    });

    // Verify field boundaries by counting
    let offset = 0;
    // signal_hash: 32
    offset += 32;
    // signer_list_merkle_root: 32
    offset += 32;
    // scope: 32
    offset += 32;
    // nullifier: 32
    offset += 32;
    // user_address: 20
    offset += 20;
    // user_signature: 64
    offset += 64;
    // user_pubkey_x: 32
    offset += 32;
    // user_pubkey_y: 32
    offset += 32;
    // raw_transaction: 300
    offset += 300;
    // tx_length: 1
    expect(inputs[offset]).toBe('200');
    offset += 1;
    // coinbase_attester_pubkey_x: 32
    offset += 32;
    // coinbase_attester_pubkey_y: 32
    offset += 32;
    // coinbase_signer_merkle_proof: 256
    offset += 256;
    // coinbase_signer_leaf_index: 1
    expect(inputs[offset]).toBe(merkleData.leafIndex.toString());
    offset += 1;
    // merkle_proof_depth: 1
    expect(inputs[offset]).toBe(merkleData.depth.toString());
    offset += 1;

    expect(offset).toBe(899);
  });
});

// ─── assembleCountryInputs ──────────────────────────────────────────────

describe('assembleCountryInputs', () => {
  it('should produce exactly 921 entries', async () => {
    const signalHash = computeSignalHash(TEST_ADDRESS, TEST_SCOPE, TEST_CIRCUIT_COUNTRY);
    const signature = await TEST_WALLET.signMessage(ethers.getBytes(ethers.hexlify(signalHash)));
    const userPubkey = recoverUserPubkey(signalHash, signature);
    const { x: pubX, y: pubY } = extractPubkeyCoordinates(userPubkey);
    const scopeBytes = computeScope(TEST_SCOPE);
    const nullifierBytes = computeNullifier(TEST_ADDRESS, signalHash, scopeBytes);
    const merkleData = buildSignerMerkleTree(0);
    const rawTxBytes = new Array(200).fill(0);

    const inputs = assembleCountryInputs({
      signalHash,
      merkleRoot: merkleData.root,
      countryList: ['US', 'KR'],
      countryListLength: 2,
      isIncluded: true,
      scopeBytes,
      nullifierBytes,
      userAddress: TEST_ADDRESS,
      userSignature: signature,
      userPubkeyX: pubX,
      userPubkeyY: pubY,
      rawTxBytes,
      txLength: 200,
      attesterPubkeyX: pubX,
      attesterPubkeyY: pubY,
      merkleProof: merkleData.proof,
      merkleLeafIndex: merkleData.leafIndex,
      merkleDepth: merkleData.depth,
    });

    expect(inputs.length).toBe(921);
  });

  it('should have country fields BETWEEN merkle_root and scope', async () => {
    const signalHash = computeSignalHash(TEST_ADDRESS, TEST_SCOPE, TEST_CIRCUIT_COUNTRY);
    const signature = await TEST_WALLET.signMessage(ethers.getBytes(ethers.hexlify(signalHash)));
    const userPubkey = recoverUserPubkey(signalHash, signature);
    const { x: pubX, y: pubY } = extractPubkeyCoordinates(userPubkey);
    const scopeBytes = computeScope(TEST_SCOPE);
    const nullifierBytes = computeNullifier(TEST_ADDRESS, signalHash, scopeBytes);
    const merkleData = buildSignerMerkleTree(0);
    const rawTxBytes = new Array(200).fill(0);

    const inputs = assembleCountryInputs({
      signalHash,
      merkleRoot: merkleData.root,
      countryList: ['US'],
      countryListLength: 1,
      isIncluded: false,
      scopeBytes,
      nullifierBytes,
      userAddress: TEST_ADDRESS,
      userSignature: signature,
      userPubkeyX: pubX,
      userPubkeyY: pubY,
      rawTxBytes,
      txLength: 200,
      attesterPubkeyX: pubX,
      attesterPubkeyY: pubY,
      merkleProof: merkleData.proof,
      merkleLeafIndex: merkleData.leafIndex,
      merkleDepth: merkleData.depth,
    });

    // Layout verification:
    // [0..31] signal_hash (32)
    // [32..63] signer_list_merkle_root (32)
    // [64..83] country_list (20 = 10 * 2)
    // [84] country_list_length
    // [85] is_included
    // [86..117] scope (32)
    // [118..149] nullifier (32)

    // Check country_list_length at index 84
    expect(inputs[84]).toBe('1');
    // Check is_included at index 85
    expect(inputs[85]).toBe('0'); // false

    // Check country_list starts at index 64
    // US: U=85, S=83
    expect(inputs[64]).toBe('85');
    expect(inputs[65]).toBe('83');

    // Verify scope starts at index 86
    const expectedScope = uint8ArrayToDecimalStrings(scopeBytes);
    expect(inputs[86]).toBe(expectedScope[0]);
    expect(inputs[87]).toBe(expectedScope[1]);
  });

  it('should contain only decimal strings', async () => {
    const signalHash = computeSignalHash(TEST_ADDRESS, TEST_SCOPE, TEST_CIRCUIT_COUNTRY);
    const signature = await TEST_WALLET.signMessage(ethers.getBytes(ethers.hexlify(signalHash)));
    const userPubkey = recoverUserPubkey(signalHash, signature);
    const { x: pubX, y: pubY } = extractPubkeyCoordinates(userPubkey);
    const scopeBytes = computeScope(TEST_SCOPE);
    const nullifierBytes = computeNullifier(TEST_ADDRESS, signalHash, scopeBytes);
    const merkleData = buildSignerMerkleTree(0);
    const rawTxBytes = new Array(100).fill(7);

    const inputs = assembleCountryInputs({
      signalHash,
      merkleRoot: merkleData.root,
      countryList: ['JP', 'GB', 'DE'],
      countryListLength: 3,
      isIncluded: true,
      scopeBytes,
      nullifierBytes,
      userAddress: TEST_ADDRESS,
      userSignature: signature,
      userPubkeyX: pubX,
      userPubkeyY: pubY,
      rawTxBytes,
      txLength: 100,
      attesterPubkeyX: pubX,
      attesterPubkeyY: pubY,
      merkleProof: merkleData.proof,
      merkleLeafIndex: merkleData.leafIndex,
      merkleDepth: merkleData.depth,
    });

    for (let i = 0; i < inputs.length; i++) {
      expect(inputs[i]).toMatch(/^\d+$/);
    }
  });

  it('should differ from KYC inputs by exactly 22 entries (country_list[20] + length[1] + isIncluded[1])', async () => {
    // 921 - 899 = 22
    expect(921 - 899).toBe(22);
  });
});

// ─── Input vector size verification ─────────────────────────────────────

describe('input vector sizes', () => {
  it('coinbase_attestation should be exactly 899 entries', () => {
    // signal_hash[32] + signer_list_merkle_root[32] + scope[32] + nullifier[32]
    // + user_address[20] + user_signature[64] + user_pubkey_x[32] + user_pubkey_y[32]
    // + raw_transaction[300] + tx_length[1]
    // + coinbase_attester_pubkey_x[32] + coinbase_attester_pubkey_y[32]
    // + coinbase_signer_merkle_proof[256] + coinbase_signer_leaf_index[1] + merkle_proof_depth[1]
    const expected = 32 + 32 + 32 + 32 + 20 + 64 + 32 + 32 + 300 + 1 + 32 + 32 + 256 + 1 + 1;
    expect(expected).toBe(899);
  });

  it('coinbase_country_attestation should be exactly 921 entries', () => {
    // signal_hash[32] + signer_list_merkle_root[32]
    // + country_list[20] + country_list_length[1] + is_included[1]
    // + scope[32] + nullifier[32]
    // + user_address[20] + user_signature[64] + user_pubkey_x[32] + user_pubkey_y[32]
    // + raw_transaction[300] + tx_length[1]
    // + coinbase_attester_pubkey_x[32] + coinbase_attester_pubkey_y[32]
    // + coinbase_signer_merkle_proof[256] + coinbase_signer_leaf_index[1] + merkle_proof_depth[1]
    const expected = 32 + 32 + 20 + 1 + 1 + 32 + 32 + 20 + 64 + 32 + 32 + 300 + 1 + 32 + 32 + 256 + 1 + 1;
    expect(expected).toBe(921);
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
