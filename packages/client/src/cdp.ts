import type { ProofportSigner } from './signer.js';

/**
 * CDP MPC Wallet adapter implementing ProofportSigner.
 * Uses Coinbase AgentKit's CdpEvmWalletProvider for key management.
 * Private keys never leave Coinbase's TEE.
 */
export class CdpWalletSigner implements ProofportSigner {
  // Store the wallet provider as `any` to avoid hard dependency on @coinbase/agentkit types
  private provider: any;

  private constructor(provider: any) {
    this.provider = provider;
  }

  /**
   * Create a CdpWalletSigner from environment variables.
   * Requires: CDP_API_KEY_ID, CDP_API_KEY_SECRET, CDP_WALLET_SECRET
   * Optional: CDP_WALLET_ADDRESS (to load existing wallet), CDP_NETWORK_ID (default: base-sepolia)
   */
  static async create(opts?: {
    apiKeyId?: string;
    apiKeySecret?: string;
    walletSecret?: string;
    networkId?: string;
    address?: string;
  }): Promise<CdpWalletSigner> {
    let CdpEvmWalletProvider: any;
    try {
      // @ts-ignore — optional peer dependency, may not be installed
      const mod = await import('@coinbase/agentkit');
      CdpEvmWalletProvider = mod.CdpEvmWalletProvider;
    } catch {
      throw new Error(
        'CDP wallet requires @coinbase/agentkit. Install it: npm install @coinbase/agentkit @coinbase/cdp-sdk'
      );
    }

    const config: any = {
      apiKeyId: opts?.apiKeyId || process.env.CDP_API_KEY_ID,
      apiKeySecret: opts?.apiKeySecret || process.env.CDP_API_KEY_SECRET,
      walletSecret: opts?.walletSecret || process.env.CDP_WALLET_SECRET,
      networkId: opts?.networkId || process.env.CDP_NETWORK_ID || 'base-sepolia',
    };

    const address = opts?.address || process.env.CDP_WALLET_ADDRESS;
    if (address) {
      config.address = address;
    }

    const provider = await CdpEvmWalletProvider.configureWithWallet(config);
    return new CdpWalletSigner(provider);
  }

  getAddress(): string {
    return this.provider.getAddress();
  }

  async signMessage(message: Uint8Array): Promise<string> {
    return this.provider.signMessage(message);
  }

  async signTypedData(
    domain: { name: string; version: string; chainId: number; verifyingContract: string },
    types: Record<string, Array<{ name: string; type: string }>>,
    message: Record<string, unknown>,
  ): Promise<string> {
    // Bridge ethers 3-arg style → viem single-object style
    // AgentKit's signTypedData expects { domain, types, primaryType, message }
    // Determine primaryType: it's the first key in types that isn't EIP712Domain
    const primaryType = Object.keys(types).find(k => k !== 'EIP712Domain') || Object.keys(types)[0];

    return this.provider.signTypedData({
      domain,
      types: {
        ...types,
        EIP712Domain: [
          { name: 'name', type: 'string' },
          { name: 'version', type: 'string' },
          { name: 'chainId', type: 'uint256' },
          { name: 'verifyingContract', type: 'address' },
        ],
      },
      primaryType,
      message,
    });
  }

  async sendTransaction(tx: {
    to: string;
    data: string;
    value?: bigint;
  }): Promise<{ hash: string; wait(): Promise<{ status: number | null }> }> {
    // AgentKit's sendTransaction returns just the tx hash
    const hash: string = await this.provider.sendTransaction({
      to: tx.to as `0x${string}`,
      data: tx.data as `0x${string}`,
      value: tx.value ?? 0n,
    });

    return {
      hash,
      wait: async () => {
        // Use AgentKit's waitForTransactionReceipt if available
        try {
          const receipt = await this.provider.waitForTransactionReceipt(hash);
          return { status: receipt?.status === 'success' ? 1 : 0 };
        } catch {
          // Unknown status if receipt method unavailable
          return { status: null };
        }
      },
    };
  }
}
