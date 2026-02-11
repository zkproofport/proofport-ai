import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';

// Mock all @x402 imports
vi.mock('@x402/express', () => ({
  paymentMiddleware: vi.fn(() => vi.fn((_req: any, _res: any, next: any) => next())),
  x402ResourceServer: vi.fn().mockImplementation(() => ({
    register: vi.fn().mockReturnThis(),
  })),
}));

vi.mock('@x402/evm/exact/server', () => ({
  ExactEvmScheme: vi.fn(),
}));

vi.mock('@x402/core/server', () => ({
  HTTPFacilitatorClient: vi.fn(),
}));

import { createPaymentMiddleware, PAYMENT_NETWORKS } from '../../src/payment/x402Middleware';
import { paymentMiddleware, x402ResourceServer } from '@x402/express';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import { HTTPFacilitatorClient } from '@x402/core/server';

describe('x402Middleware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('createPaymentMiddleware', () => {
    it('returns a function', () => {
      const middleware = createPaymentMiddleware({
        paymentMode: 'disabled',
        paymentPayTo: '',
        paymentFacilitatorUrl: 'https://www.x402.org/facilitator',
        paymentProofPrice: '$0.10',
      });

      expect(typeof middleware).toBe('function');
    });

    it('when paymentMode=disabled, middleware calls next() without gating', () => {
      const middleware = createPaymentMiddleware({
        paymentMode: 'disabled',
        paymentPayTo: '',
        paymentFacilitatorUrl: 'https://www.x402.org/facilitator',
        paymentProofPrice: '$0.10',
      });

      const req = {} as Request;
      const res = {} as Response;
      const next = vi.fn();

      middleware(req, res, next);

      expect(next).toHaveBeenCalledOnce();
      expect(next).toHaveBeenCalledWith();
    });

    it('when paymentMode=disabled, no x402 imports are initialized', () => {
      createPaymentMiddleware({
        paymentMode: 'disabled',
        paymentPayTo: '',
        paymentFacilitatorUrl: 'https://www.x402.org/facilitator',
        paymentProofPrice: '$0.10',
      });

      expect(HTTPFacilitatorClient).not.toHaveBeenCalled();
      expect(x402ResourceServer).not.toHaveBeenCalled();
      expect(ExactEvmScheme).not.toHaveBeenCalled();
      expect(paymentMiddleware).not.toHaveBeenCalled();
    });

    it('when paymentMode=testnet, validates paymentPayTo is set (throws if empty)', () => {
      expect(() => {
        createPaymentMiddleware({
          paymentMode: 'testnet',
          paymentPayTo: '',
          paymentFacilitatorUrl: 'https://www.x402.org/facilitator',
          paymentProofPrice: '$0.10',
        });
      }).toThrow('PAYMENT_PAY_TO environment variable is required when paymentMode is not disabled');
    });

    it('when paymentMode=mainnet, validates paymentPayTo is set (throws if empty)', () => {
      expect(() => {
        createPaymentMiddleware({
          paymentMode: 'mainnet',
          paymentPayTo: '',
          paymentFacilitatorUrl: 'https://www.x402.org/facilitator',
          paymentProofPrice: '$0.10',
        });
      }).toThrow('PAYMENT_PAY_TO environment variable is required when paymentMode is not disabled');
    });

    it('when paymentMode=testnet, middleware is created with correct network', () => {
      createPaymentMiddleware({
        paymentMode: 'testnet',
        paymentPayTo: '0x1234567890123456789012345678901234567890',
        paymentFacilitatorUrl: 'https://www.x402.org/facilitator',
        paymentProofPrice: '$0.10',
      });

      expect(HTTPFacilitatorClient).toHaveBeenCalledWith({
        url: 'https://www.x402.org/facilitator',
      });
      expect(x402ResourceServer).toHaveBeenCalledWith(expect.any(Object));
      expect(ExactEvmScheme).toHaveBeenCalled();
      expect(paymentMiddleware).toHaveBeenCalledWith(
        expect.objectContaining({
          'POST /a2a': expect.objectContaining({
            accepts: expect.arrayContaining([
              expect.objectContaining({
                scheme: 'exact',
                price: '$0.10',
                network: 'eip155:84532',
                payTo: '0x1234567890123456789012345678901234567890',
              }),
            ]),
            description: expect.any(String),
          }),
          'POST /mcp': expect.objectContaining({
            accepts: expect.arrayContaining([
              expect.objectContaining({
                scheme: 'exact',
                price: '$0.10',
                network: 'eip155:84532',
                payTo: '0x1234567890123456789012345678901234567890',
              }),
            ]),
            description: expect.any(String),
          }),
        }),
        expect.any(Object)
      );
    });

    it('when paymentMode=mainnet, middleware is created with correct network', () => {
      createPaymentMiddleware({
        paymentMode: 'mainnet',
        paymentPayTo: '0x1234567890123456789012345678901234567890',
        paymentFacilitatorUrl: 'https://www.x402.org/facilitator',
        paymentProofPrice: '$0.10',
      });

      expect(HTTPFacilitatorClient).toHaveBeenCalledWith({
        url: 'https://www.x402.org/facilitator',
      });
      expect(x402ResourceServer).toHaveBeenCalledWith(expect.any(Object));
      expect(ExactEvmScheme).toHaveBeenCalled();
      expect(paymentMiddleware).toHaveBeenCalledWith(
        expect.objectContaining({
          'POST /a2a': expect.objectContaining({
            accepts: expect.arrayContaining([
              expect.objectContaining({
                scheme: 'exact',
                price: '$0.10',
                network: 'eip155:8453',
                payTo: '0x1234567890123456789012345678901234567890',
              }),
            ]),
            description: expect.any(String),
          }),
          'POST /mcp': expect.objectContaining({
            accepts: expect.arrayContaining([
              expect.objectContaining({
                scheme: 'exact',
                price: '$0.10',
                network: 'eip155:8453',
                payTo: '0x1234567890123456789012345678901234567890',
              }),
            ]),
            description: expect.any(String),
          }),
        }),
        expect.any(Object)
      );
    });
  });

  describe('PAYMENT_NETWORKS', () => {
    it('maps testnet to eip155:84532', () => {
      expect(PAYMENT_NETWORKS.testnet).toBe('eip155:84532');
    });

    it('maps mainnet to eip155:8453', () => {
      expect(PAYMENT_NETWORKS.mainnet).toBe('eip155:8453');
    });

    it('does not have disabled entry', () => {
      expect('disabled' in PAYMENT_NETWORKS).toBe(false);
    });
  });
});
