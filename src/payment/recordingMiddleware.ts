import type { Request, Response, NextFunction } from 'express';
import type { PaymentFacilitator } from './facilitator.js';
import { getPaymentModeConfig } from './freeTier.js';
import { createLogger } from '../logger.js';

const log = createLogger('Payment');

export interface PaymentRecordingConfig {
  paymentMode: 'disabled' | 'testnet' | 'mainnet';
  facilitator: PaymentFacilitator;
}

/**
 * Middleware to extract and record payment information after x402 validation.
 *
 * IMPORTANT: This must run AFTER x402 paymentMiddleware but BEFORE route handlers.
 *
 * x402 validates payment but doesn't expose payment metadata. We need to:
 * 1. Extract payer address from X-PAYMENT header
 * 2. Record payment with facilitator (linked to taskId later)
 * 3. Attach payment record to req for handler access
 */
export function createPaymentRecordingMiddleware(config: PaymentRecordingConfig) {
  const modeConfig = getPaymentModeConfig(config.paymentMode);

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    // Skip if payment not required
    if (!modeConfig.requiresPayment) {
      return next();
    }

    // Skip if no payment header (x402 middleware already rejected this)
    const paymentHeader = req.headers['x-payment'] as string | undefined;
    if (!paymentHeader) {
      return next();
    }

    try {
      // Parse X-PAYMENT header to extract payer address
      // x402 format: base64(cbor({ scheme, network, proof, ... }))
      const paymentData = parsePaymentHeader(paymentHeader);

      // Store payment info on request for handler to link with taskId
      (req as any).x402Payment = {
        payerAddress: paymentData.payerAddress,
        amount: paymentData.amount || '$0.10', // Default from route config
        network: modeConfig.network,
      };

      next();
    } catch (error) {
      // Log error but don't block request — x402 already validated it
      log.error({ err: error }, 'Failed to parse payment header');
      next();
    }
  };
}

interface ParsedPaymentData {
  payerAddress: string;
  amount?: string;
}

/**
 * Parse X-PAYMENT header to extract payer address.
 *
 * x402 payment header format (base64-encoded CBOR):
 * {
 *   scheme: "exact",
 *   network: "eip155:84532",
 *   proof: {
 *     from: "0x...",  // Payer address
 *     ...
 *   }
 * }
 */
function parsePaymentHeader(header: string): ParsedPaymentData {
  try {
    // Decode base64
    const decoded = Buffer.from(header, 'base64');

    // Parse CBOR (x402 uses CBOR encoding)
    const { decode } = require('cbor-x');
    const payment = decode(decoded);

    if (!payment || typeof payment !== 'object') {
      throw new Error('Invalid payment format');
    }

    // Extract payer address from proof
    const payerAddress = payment.proof?.from || payment.from;
    if (!payerAddress) {
      throw new Error('No payer address in payment');
    }

    return {
      payerAddress,
      amount: payment.amount,
    };
  } catch (error) {
    throw new Error(`Failed to parse payment header: ${error instanceof Error ? error.message : String(error)}`);
  }
}
