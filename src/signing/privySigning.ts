import type { SigningProvider, SigningRequest, SigningResult } from './types.js';

export interface PrivySigningConfig {
  appId: string;
  apiSecret: string;
  apiUrl?: string;
}

export class PrivySigningProvider implements SigningProvider {
  readonly method = 'privy' as const;
  private readonly appId: string;
  private readonly apiSecret: string;
  private readonly apiUrl: string;

  constructor(config: PrivySigningConfig) {
    if (!config.appId) {
      throw new Error('appId is required');
    }
    if (!config.apiSecret) {
      throw new Error('apiSecret is required');
    }

    this.appId = config.appId;
    this.apiSecret = config.apiSecret;
    this.apiUrl = config.apiUrl || 'https://auth.privy.io';
  }

  async sign(request: SigningRequest): Promise<SigningResult> {
    const walletId = request.address;
    const url = `${this.apiUrl}/api/v1/wallets/${walletId}/rpc`;

    const authHeader = `Basic ${Buffer.from(`${this.appId}:${this.apiSecret}`).toString('base64')}`;

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': authHeader,
          'privy-app-id': this.appId,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          method: 'personal_sign',
          params: {
            message: request.signalHash,
          },
        }),
      });

      if (!response.ok) {
        const errorBody = await response.json().catch(() => ({}));
        throw new Error(`Privy API error: ${response.status} ${response.statusText} - ${JSON.stringify(errorBody)}`);
      }

      const result = await response.json();
      const signature = result.data?.signature;
      const signerAddress = result.data?.address;

      if (!signature) {
        throw new Error('No signature returned from Privy API');
      }

      if (!signerAddress) {
        throw new Error('No address returned from Privy API');
      }

      if (signerAddress.toLowerCase() !== request.address.toLowerCase()) {
        throw new Error(`Address mismatch: expected ${request.address}, got ${signerAddress}`);
      }

      return {
        signature,
        address: signerAddress,
        method: 'privy',
      };
    } catch (error) {
      if (error instanceof Error) {
        throw error;
      }
      throw new Error(`Failed to sign with Privy: ${String(error)}`);
    }
  }

  async isAvailable(address: string): Promise<boolean> {
    const url = `${this.apiUrl}/api/v1/users?wallet_address=${address}`;
    const authHeader = `Basic ${Buffer.from(`${this.appId}:${this.apiSecret}`).toString('base64')}`;

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Authorization': authHeader,
          'privy-app-id': this.appId,
        },
      });

      if (!response.ok) {
        return false;
      }

      const result = await response.json();
      const users = result.data || [];

      if (users.length === 0) {
        return false;
      }

      const user = users[0];
      const linkedAccounts = user.linked_accounts || [];

      const hasEmbeddedWallet = linkedAccounts.some((account: any) =>
        account.type === 'wallet' &&
        account.wallet_client === 'privy' &&
        account.delegated === true
      );

      return hasEmbeddedWallet;
    } catch (error) {
      return false;
    }
  }
}
