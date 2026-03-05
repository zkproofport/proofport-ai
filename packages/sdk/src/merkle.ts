import { ethers } from 'ethers';
import { AUTHORIZED_SIGNERS } from './constants.js';

/**
 * Simple binary Merkle tree for signer verification.
 *
 * Leaf: keccak256(address_bytes)
 * Odd number of leaves: duplicate last leaf
 * Internal node: keccak256(left || right)
 */
export class SimpleMerkleTree {
  private leaves: string[];
  private layers: string[][];

  constructor(addresses: string[]) {
    if (addresses.length === 0) {
      throw new Error('SimpleMerkleTree requires at least one address');
    }

    // Create leaf hashes: keccak256(address_bytes)
    this.leaves = addresses.map(addr => {
      const addrBytes = ethers.getBytes(ethers.getAddress(addr));
      return ethers.keccak256(addrBytes);
    });

    // Build layers bottom-up
    this.layers = [this.leaves];
    let currentLayer = this.leaves;

    while (currentLayer.length > 1) {
      const nextLayer: string[] = [];
      for (let i = 0; i < currentLayer.length; i += 2) {
        const left = currentLayer[i];
        const right = currentLayer[i + 1] || left; // duplicate if odd
        const combined = ethers.concat([
          ethers.getBytes(left),
          ethers.getBytes(right),
        ]);
        nextLayer.push(ethers.keccak256(combined));
      }
      this.layers.push(nextLayer);
      currentLayer = nextLayer;
    }
  }

  getRoot(): string {
    return this.layers[this.layers.length - 1][0];
  }

  getProof(index: number): { proof: string[]; leafIndex: number; depth: number } {
    if (index < 0 || index >= this.leaves.length) {
      throw new Error(`Leaf index ${index} out of bounds (0..${this.leaves.length - 1})`);
    }

    const proof: string[] = [];
    let idx = index;

    for (let i = 0; i < this.layers.length - 1; i++) {
      const layer = this.layers[i];
      const isRight = idx % 2 === 1;
      const siblingIdx = isRight ? idx - 1 : idx + 1;

      if (siblingIdx < layer.length) {
        proof.push(layer[siblingIdx]);
      } else {
        // No sibling -- use self (duplicate)
        proof.push(layer[idx]);
      }

      idx = Math.floor(idx / 2);
    }

    return {
      proof,
      leafIndex: index,
      depth: proof.length,
    };
  }

  getLeafHash(index: number): string {
    if (index < 0 || index >= this.leaves.length) {
      throw new Error(`Leaf index ${index} out of bounds (0..${this.leaves.length - 1})`);
    }
    return this.leaves[index];
  }
}

/**
 * Find the index of a signer address in the authorized signers list.
 * Case-insensitive comparison.
 */
export function findSignerIndex(signerAddress: string): number {
  const index = AUTHORIZED_SIGNERS.findIndex(
    addr => addr.toLowerCase() === signerAddress.toLowerCase(),
  );
  if (index === -1) {
    throw new Error(
      `Signer ${signerAddress} is not in the authorized signers list`,
    );
  }
  return index;
}

/**
 * Build a Merkle tree from authorized signers and get proof for the given signer index.
 */
export function buildSignerMerkleTree(signerIndex: number): {
  root: string;
  proof: string[];
  leafIndex: number;
  depth: number;
} {
  const tree = new SimpleMerkleTree(AUTHORIZED_SIGNERS);
  const root = tree.getRoot();
  const { proof, leafIndex, depth } = tree.getProof(signerIndex);

  return { root, proof, leafIndex, depth };
}
