/**
 * Whether this service charges, and against which environment.
 *
 * It deliberately does NOT name a chain. Which chains payment is taken on is
 * `PAYMENT_NETWORKS`, resolved through the table in `networks.ts`, and a
 * service can offer several at once -- so a mode that also named a chain would
 * be a second, quieter answer to the same question. An `arc-testnet` mode was
 * added here on 2026-09-09 and removed the same day for exactly that reason:
 * nothing ever read it, because the chain was already coming from the table.
 */
export type PaymentMode = 'disabled' | 'testnet' | 'mainnet';

export interface PaymentModeConfig {
  mode: PaymentMode;
  network: string | null;
  requiresPayment: boolean;
  description: string;
}

export function getPaymentModeConfig(mode: PaymentMode): PaymentModeConfig {
  const validModes = ['disabled', 'testnet', 'mainnet'] as const;
  if (!validModes.includes(mode)) {
    throw new Error(`Invalid payment mode: ${mode}`);
  }

  switch (mode) {
    case 'disabled':
      return {
        mode: 'disabled',
        network: null,
        requiresPayment: false,
        description: 'Payment disabled (development mode)',
      };
    case 'testnet':
      return {
        mode: 'testnet',
        network: 'eip155:84532',
        requiresPayment: true,
        description: 'Testnet USDC on Base Sepolia',
      };
    case 'mainnet':
      return {
        mode: 'mainnet',
        network: 'eip155:8453',
        requiresPayment: true,
        description: 'Mainnet USDC on Base',
      };
  }
}

export function validatePaymentConfig(config: {
  paymentMode: string;
  paymentPayTo: string;
}): void {
  const validModes = ['disabled', 'testnet', 'mainnet', 'arc-testnet'];
  if (!validModes.includes(config.paymentMode)) {
    throw new Error(`paymentMode must be one of: ${validModes.join(', ')}`);
  }

  if (config.paymentMode !== 'disabled' && !config.paymentPayTo) {
    throw new Error(`PAYMENT_PAY_TO is required when paymentMode is ${config.paymentMode}`);
  }
}

/**
 * Express middleware that gates requests behind x402 payment.
 * Returns 402 when payment mode requires payment and no payment header is present.
 */
/**
 * `createPaymentGate` stood here and was deleted on 2026-09-09.
 *
 * It was an Express middleware that answered 402 when no payment header was
 * present. Nothing imported it -- `src/index.ts` takes only
 * `validatePaymentConfig` and `getPaymentModeConfig` from this file -- and it
 * was kept alive solely by its own tests.
 *
 * That mattered because it answered a DIFFERENT 402 than the service does. Its
 * body named one chain, derived from the payment mode:
 *
 *     { error, paymentMode, network: modeConfig.network }
 *
 * while the real answer comes from `proofRoutes.ts` and carries `accepts` --
 * one requirement per chain in `PAYMENT_NETWORKS`, each with that chain's
 * price, asset and CAIP-2 id. A mode cannot express "Base or Arc, your
 * choice", so this shape could never have been right once payment was offered
 * on more than one chain.
 *
 * A comment added to it earlier the same day claimed Circle's Agent
 * Marketplace reads this shape. It does not; it reads the route's `accepts`.
 * Leaving a dead middleware carrying a false claim about a live integration is
 * worse than having no middleware.
 */
