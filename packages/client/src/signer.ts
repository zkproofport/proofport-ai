import { ethers } from 'ethers';

/**
 * Abstract signer interface for ProofPort proof generation.
 * Enables different wallet providers (ethers.Wallet, CDP MPC, viem, etc.)
 */
export interface ProofportSigner {
  getAddress(): string | Promise<string>;
  signMessage(message: Uint8Array): Promise<string>;
  signTypedData(
    domain: {
      name: string;
      version: string;
      chainId: number;
      verifyingContract: string;
    },
    types: Record<string, Array<{ name: string; type: string }>>,
    message: Record<string, unknown>,
  ): Promise<string>;
  sendTransaction(tx: {
    to: string;
    data: string;
    value?: bigint;
  }): Promise<{ hash: string; wait(): Promise<{ status: number | null }> }>;
}

/**
 * Adapter wrapping ethers.Wallet to implement ProofportSigner.
 */
export class EthersWalletSigner implements ProofportSigner {
  private wallet: ethers.Wallet;

  constructor(wallet: ethers.Wallet) {
    this.wallet = wallet;
  }

  getAddress(): string {
    return this.wallet.address;
  }

  async signMessage(message: Uint8Array): Promise<string> {
    return this.wallet.signMessage(message);
  }

  async signTypedData(
    domain: {
      name: string;
      version: string;
      chainId: number;
      verifyingContract: string;
    },
    types: Record<string, Array<{ name: string; type: string }>>,
    message: Record<string, unknown>,
  ): Promise<string> {
    return this.wallet.signTypedData(domain, types, message);
  }

  async sendTransaction(tx: {
    to: string;
    data: string;
    value?: bigint;
  }): Promise<{ hash: string; wait(): Promise<{ status: number | null }> }> {
    const response = await this.wallet.sendTransaction(tx);
    return {
      hash: response.hash,
      wait: async () => {
        const receipt = await response.wait();
        return { status: receipt?.status ?? null };
      },
    };
  }

  /** Get the underlying ethers.Wallet (for cases needing direct access) */
  getWallet(): ethers.Wallet {
    return this.wallet;
  }
}

/**
 * Create a ProofportSigner from an ethers.Wallet.
 * Convenience factory for the most common case.
 */
export function fromEthersWallet(wallet: ethers.Wallet): ProofportSigner {
  return new EthersWalletSigner(wallet);
}

/**
 * Create a ProofportSigner from a private key string.
 * Optionally connects to a provider for transaction sending.
 */
export function fromPrivateKey(privateKey: string, provider?: ethers.Provider): ProofportSigner {
  const wallet = provider
    ? new ethers.Wallet(privateKey, provider)
    : new ethers.Wallet(privateKey);
  return new EthersWalletSigner(wallet);
}
