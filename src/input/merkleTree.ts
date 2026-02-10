import { ethers } from 'ethers';

/**
 * Simple binary Merkle tree for signer verification.
 * Ported from mobile app (ethers v5) to ethers v6.
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
        // No sibling — use self (duplicate)
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
