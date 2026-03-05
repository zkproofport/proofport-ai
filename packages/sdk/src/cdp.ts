import type { ProofportSigner } from './signer.js';

/**
 * Adapter interface for CDP wallet-like objects (or any external wallet).
 *
 * Pass any object that satisfies these method signatures — CDP MPC wallets,
 * viem wallets, Privy embedded wallets, etc. — and wrap it with
 * `CdpWalletSigner` or `fromExternalWallet()` to get a `ProofportSigner`.
 *
 * @example
 * ```typescript
 * // With @coinbase/cdp-sdk
 * import { CdpClient } from '@coinbase/cdp-sdk';
 * import { CdpWalletSigner } from '@zkproofport-ai/sdk';
 *
 * const cdp = new CdpClient();
 * const wallet = await cdp.evm.getOrCreateWallet({ networkId: 'base' });
 * const account = await wallet.getDefaultAddress();
 *
 * const signer = new CdpWalletSigner({
 *   getAddress: () => account.getId(),
 *   signMessage: (msg) => account.signPayload({ payload: Buffer.from(msg).toString('hex') }).then(r => r.signature),
 *   signTypedData: (domain, types, message) => account.signTypedData({ domain, types, message }),
 *   sendTransaction: async (tx) => {
 *     const result = await account.sendTransaction(tx);
 *     return { hash: result.transactionHash, wait: async () => ({ status: 1 }) };
 *   },
 * });
 * ```
 */
export interface ExternalWallet {
  /**
   * Returns the wallet's Ethereum address.
   * May be synchronous or asynchronous depending on the provider.
   */
  getAddress(): string | Promise<string>;

  /**
   * Signs a raw message (personal_sign style).
   * Accepts either a Uint8Array of raw bytes or a pre-encoded string.
   */
  signMessage(message: Uint8Array | string): Promise<string>;

  /**
   * Signs EIP-712 typed data.
   * Compatible with ethers v6 `signTypedData` and viem `signTypedData` call shapes.
   */
  signTypedData(
    domain: Record<string, unknown>,
    types: Record<string, Array<{ name: string; type: string }>>,
    message: Record<string, unknown>,
  ): Promise<string>;

  /**
   * Sends a transaction and returns the hash plus a `wait()` helper.
   * Optional — omit if the wallet is used only for signing (e.g., attestation signer).
   * If omitted and `sendTransaction` is called on the signer, an error is thrown at runtime.
   */
  sendTransaction?(tx: {
    to: string;
    data: string;
    value?: bigint;
  }): Promise<{ hash: string; wait(): Promise<{ status: number | null }> }>;
}

/**
 * Adapter that bridges any `ExternalWallet`-compatible object to the
 * `ProofportSigner` interface. No additional npm dependencies required —
 * the caller brings their own wallet implementation.
 *
 * @example
 * ```typescript
 * import { CdpWalletSigner } from '@zkproofport-ai/sdk';
 *
 * // Wrap any CDP / external wallet
 * const signer = new CdpWalletSigner(myExternalWallet);
 *
 * // Use as attestation signer
 * const client = new ProofportClient({ ... }, { attestation: signer });
 * ```
 */
export class CdpWalletSigner implements ProofportSigner {
  private readonly wallet: ExternalWallet;

  constructor(wallet: ExternalWallet) {
    this.wallet = wallet;
  }

  /** Returns the wallet address, resolving async providers transparently. */
  getAddress(): string | Promise<string> {
    return this.wallet.getAddress();
  }

  /**
   * Signs a raw byte message.
   * Passes the Uint8Array directly to the underlying wallet; the wallet is
   * responsible for any encoding (e.g., personal_sign prefix).
   */
  async signMessage(message: Uint8Array): Promise<string> {
    return this.wallet.signMessage(message);
  }

  /**
   * Signs EIP-712 typed data.
   * The strict `ProofportSigner` domain shape is widened to
   * `Record<string, unknown>` when forwarded so any external wallet
   * implementation can accept it without type conflicts.
   */
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
    return this.wallet.signTypedData(domain as Record<string, unknown>, types, message);
  }

  /**
   * Sends a transaction via the underlying wallet.
   * Throws a descriptive error if the wrapped wallet did not provide
   * a `sendTransaction` method (e.g., signing-only attestation wallets).
   */
  async sendTransaction(tx: {
    to: string;
    data: string;
    value?: bigint;
  }): Promise<{ hash: string; wait(): Promise<{ status: number | null }> }> {
    if (typeof this.wallet.sendTransaction !== 'function') {
      throw new Error(
        'CdpWalletSigner: the wrapped wallet does not implement sendTransaction. ' +
          'Provide a sendTransaction method on the ExternalWallet object, or use a ' +
          'different signer for payment transactions.',
      );
    }
    return this.wallet.sendTransaction(tx);
  }
}

/**
 * Convenience factory — equivalent to `new CdpWalletSigner(wallet)`.
 *
 * Useful for returning a `ProofportSigner` without exposing the concrete
 * `CdpWalletSigner` class to callers.
 *
 * @example
 * ```typescript
 * import { fromExternalWallet } from '@zkproofport-ai/sdk';
 *
 * const signer = fromExternalWallet({
 *   getAddress: () => '0xYourAddress',
 *   signMessage: (msg) => myWallet.sign(msg),
 *   signTypedData: (domain, types, message) =>
 *     myWallet.signTypedData({ domain, types, message }),
 * });
 * ```
 */
export function fromExternalWallet(wallet: ExternalWallet): ProofportSigner {
  return new CdpWalletSigner(wallet);
}
