import type { Request, Response, NextFunction } from 'express';
import { paymentMiddleware, x402ResourceServer } from '@x402/express';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import { HTTPFacilitatorClient } from '@x402/core/server';

export const PAYMENT_NETWORKS = {
  testnet: 'eip155:84532', // Base Sepolia
  mainnet: 'eip155:8453',  // Base Mainnet
} as const;

interface PaymentConfig {
  paymentMode: 'disabled' | 'testnet' | 'mainnet';
  paymentPayTo: string;
  paymentFacilitatorUrl: string;
  paymentProofPrice: string;
}

export type { PaymentConfig };

const USDC_ADDRESSES: Record<string, string> = {
  'eip155:84532': '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  'eip155:8453': '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
};

/**
 * Build the base64-encoded PAYMENT-REQUIRED header value.
 * Returns null if payment mode is disabled.
 */
export function buildPaymentRequiredHeaderValue(
  config: PaymentConfig,
  resourceUrl: string,
  description: string,
): string | null {
  if (config.paymentMode === 'disabled') return null;

  const network = PAYMENT_NETWORKS[config.paymentMode];
  const usdcAddress = USDC_ADDRESSES[network] || '';
  const priceStr = (config.paymentProofPrice || '$0.10').replace('$', '');
  const amount = String(Math.round(parseFloat(priceStr) * 1_000_000));

  const payload = {
    x402Version: 2,
    error: 'Payment required',
    resource: { url: resourceUrl, description, mimeType: '' },
    accepts: [{
      scheme: 'exact',
      network,
      amount,
      asset: usdcAddress,
      payTo: config.paymentPayTo,
      maxTimeoutSeconds: 300,
      extra: { name: 'USDC', version: '2' },
    }],
  };

  return Buffer.from(JSON.stringify(payload)).toString('base64');
}

export function createPaymentMiddleware(config: PaymentConfig): (req: Request, res: Response, next: NextFunction) => void {
  // When disabled, return no-op middleware
  if (config.paymentMode === 'disabled') {
    return (_req: Request, _res: Response, next: NextFunction) => {
      next();
    };
  }

  // Validate paymentPayTo is set for testnet/mainnet
  if (!config.paymentPayTo) {
    throw new Error('PAYMENT_PAY_TO environment variable is required when paymentMode is not disabled');
  }

  // Get network based on mode
  const network = PAYMENT_NETWORKS[config.paymentMode];

  // Initialize x402 components
  const facilitatorClient = new HTTPFacilitatorClient({
    url: config.paymentFacilitatorUrl,
  });

  const server = new x402ResourceServer(facilitatorClient)
    .register(network, new ExactEvmScheme());

  // Payment config shared by all routes
  const paymentAccepts = [{
    scheme: 'exact',
    price: config.paymentProofPrice,
    network,
    payTo: config.paymentPayTo,
  }];

  // Create routes config — all payment-gated routes
  const routesConfig = {
    'POST /a2a': {
      accepts: paymentAccepts,
      description: 'Generate ZK proof via A2A protocol',
    },
    'POST /mcp': {
      accepts: paymentAccepts,
      description: 'Generate ZK proof via MCP protocol',
    },
    'POST /api/v1/proofs': {
      accepts: paymentAccepts,
      description: 'Generate ZK proof via REST API',
    },
    'POST /proofs': {
      accepts: paymentAccepts,
      description: 'Generate ZK proof via REST API (mounted)',
    },
    'POST /chat': {
      accepts: paymentAccepts,
      description: 'ZK proof via chat interface (mounted)',
    },
    'POST /api/v1/chat': {
      accepts: paymentAccepts,
      description: 'ZK proof via chat interface',
    },
    'POST /chat/completions': {
      accepts: paymentAccepts,
      description: 'ZK proof via OpenAI-compatible chat (mounted)',
    },
    'POST /v1/chat/completions': {
      accepts: paymentAccepts,
      description: 'ZK proof via OpenAI-compatible chat',
    },
  };

  // Return x402 payment middleware
  return paymentMiddleware(routesConfig, server);
}
