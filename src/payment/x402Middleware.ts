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

  // Create routes config
  const routesConfig = {
    'POST /a2a': {
      accepts: [{
        scheme: 'exact',
        price: config.paymentProofPrice,
        network,
        payTo: config.paymentPayTo,
      }],
      description: 'Generate ZK proof via A2A protocol',
    },
    'POST /mcp': {
      accepts: [{
        scheme: 'exact',
        price: config.paymentProofPrice,
        network,
        payTo: config.paymentPayTo,
      }],
      description: 'Generate ZK proof via MCP protocol',
    },
  };

  // Return x402 payment middleware
  return paymentMiddleware(routesConfig, server);
}
