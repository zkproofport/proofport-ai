import { ethers } from 'ethers';
import type { PaymentInfo } from './types.js';
import type { ProofportSigner } from './signer.js';

const DEFAULT_X402_FACILITATOR = 'https://x402.dexter.cash';

const CHAIN_IDS: Record<string, number> = {
  'base-sepolia': 84532,
  'base': 8453,
};

// EIP-712 domain names per USDC contract (queried via name() on-chain)
const USDC_DOMAIN_NAMES: Record<string, string> = {
  'base-sepolia': 'USDC',
  'base': 'USD Coin',
};

/**
 * Make payment for a proof session via x402 protocol.
 *
 * Uses EIP-3009 TransferWithAuthorization signed by the client,
 * settled via x402 facilitator (facilitator pays gas).
 * Works on both Base Sepolia (testnet) and Base (mainnet).
 *
 * @param signer - ProofportSigner (ethers, CDP MPC, or any implementation)
 * @param payment - PaymentInfo from session or 402 response
 * @param facilitatorUrl - Optional x402 facilitator URL (defaults to https://x402.dexter.cash)
 * @param facilitatorHeaders - Optional headers for facilitator auth (e.g., CDP Bearer token)
 * @returns Transaction hash
 */
export async function makePayment(
  signer: ProofportSigner,
  payment: PaymentInfo,
  facilitatorUrl?: string,
  facilitatorHeaders?: Record<string, string>,
): Promise<string> {
  const facilitator = facilitatorUrl || DEFAULT_X402_FACILITATOR;
  const network = payment.network as 'base-sepolia' | 'base';
  const chainId = CHAIN_IDS[network];
  if (!chainId) {
    throw new Error(`Unsupported network: ${network}`);
  }

  // Pad nonce to bytes32 (EIP-3009 requires bytes32 nonce)
  const nonce = ethers.zeroPadValue(payment.nonce, 32);

  // Validity window
  const validAfter = 0;
  const validBefore = Math.floor(Date.now() / 1000) + 3600; // 1 hour

  // EIP-712 domain for USDC (domain name differs between testnet and mainnet)
  const domain = {
    name: USDC_DOMAIN_NAMES[network] || 'USD Coin',
    version: '2',
    chainId,
    verifyingContract: payment.asset,
  };

  const types = {
    TransferWithAuthorization: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' },
      { name: 'validBefore', type: 'uint256' },
      { name: 'nonce', type: 'bytes32' },
    ],
  };

  const from = await signer.getAddress();

  const message = {
    from,
    to: payment.recipient,
    value: payment.amount,
    validAfter,
    validBefore,
    nonce,
  };

  // Sign EIP-712 TransferWithAuthorization
  const signature = await signer.signTypedData(domain, types, message);

  // Settle via x402 facilitator (facilitator pays gas)
  const settlePayload = {
    x402Version: 1,
    scheme: 'exact',
    network,
    paymentPayload: {
      x402Version: 1,
      scheme: 'exact',
      network,
      payload: {
        signature,
        authorization: {
          from,
          to: payment.recipient,
          value: String(payment.amount),
          validAfter: String(validAfter),
          validBefore: String(validBefore),
          nonce,
        },
      },
    },
    paymentRequirements: {
      scheme: 'exact',
      network,
      maxAmountRequired: String(payment.amount),
      asset: payment.asset,
      resource: `${payment.recipient}/proof`,
      description: 'ZK proof generation payment',
      mimeType: 'application/json',
      payTo: payment.recipient,
      extra: {
        name: USDC_DOMAIN_NAMES[network] || 'USD Coin',
        version: '2',
      },
    },
  };

  const settleResponse = await fetch(`${facilitator}/settle`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...facilitatorHeaders },
    body: JSON.stringify(settlePayload),
  });

  if (!settleResponse.ok) {
    const error = await settleResponse.text();
    throw new Error(`x402 facilitator settle failed: ${error}`);
  }

  const settleResult = (await settleResponse.json()) as any;
  const txHash = settleResult.txHash || settleResult.transaction?.hash || settleResult.transaction;
  if (!txHash) {
    throw new Error(`x402 settle failed: ${settleResult.errorReason || 'no transaction hash'}`);
  }

  return txHash;
}
