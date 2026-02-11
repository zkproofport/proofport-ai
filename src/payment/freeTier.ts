import type { Request, Response, NextFunction } from 'express';

export interface PaymentModeConfig {
  mode: 'disabled' | 'testnet' | 'mainnet';
  network: string | null;
  requiresPayment: boolean;
  description: string;
}

export function getPaymentModeConfig(mode: 'disabled' | 'testnet' | 'mainnet'): PaymentModeConfig {
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

export function createPaymentGate(config: {
  paymentMode: 'disabled' | 'testnet' | 'mainnet';
}): (req: Request, res: Response, next: NextFunction) => void {
  const modeConfig = getPaymentModeConfig(config.paymentMode);

  return (req: Request, res: Response, next: NextFunction) => {
    if (!modeConfig.requiresPayment) {
      (req as any).paymentSkipped = true;
      return next();
    }

    const paymentHeader = req.headers['x-payment'];
    if (!paymentHeader) {
      return res.status(402).json({
        error: 'Payment Required',
        paymentMode: modeConfig.mode,
        network: modeConfig.network,
      });
    }

    next();
  };
}

export function validatePaymentConfig(config: {
  paymentMode: string;
  paymentPayTo: string;
}): void {
  const validModes = ['disabled', 'testnet', 'mainnet'];
  if (!validModes.includes(config.paymentMode)) {
    throw new Error('paymentMode must be one of: disabled, testnet, mainnet');
  }

  if (
    (config.paymentMode === 'testnet' || config.paymentMode === 'mainnet') &&
    !config.paymentPayTo
  ) {
    throw new Error('PAYMENT_PAY_TO is required when paymentMode is testnet or mainnet');
  }
}
