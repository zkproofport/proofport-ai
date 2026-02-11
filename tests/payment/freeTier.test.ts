import { describe, it, expect, vi } from 'vitest';
import { getPaymentModeConfig, createPaymentGate, validatePaymentConfig } from '../../src/payment/freeTier';

describe('freeTier', () => {
  describe('getPaymentModeConfig', () => {
    it('should return correct config for disabled mode', () => {
      const config = getPaymentModeConfig('disabled');
      expect(config).toEqual({
        mode: 'disabled',
        network: null,
        requiresPayment: false,
        description: 'Payment disabled (development mode)',
      });
    });

    it('should return correct config for testnet mode', () => {
      const config = getPaymentModeConfig('testnet');
      expect(config).toEqual({
        mode: 'testnet',
        network: 'eip155:84532',
        requiresPayment: true,
        description: 'Testnet USDC on Base Sepolia',
      });
    });

    it('should return correct config for mainnet mode', () => {
      const config = getPaymentModeConfig('mainnet');
      expect(config).toEqual({
        mode: 'mainnet',
        network: 'eip155:8453',
        requiresPayment: true,
        description: 'Mainnet USDC on Base',
      });
    });

    it('should throw for invalid mode', () => {
      expect(() => getPaymentModeConfig('invalid' as any)).toThrow();
    });
  });

  describe('createPaymentGate', () => {
    function createMockRequest(headers: Record<string, string> = {}) {
      return { headers, paymentSkipped: undefined as boolean | undefined } as any;
    }

    function createMockResponse() {
      const res: any = {};
      res.status = vi.fn().mockReturnThis();
      res.json = vi.fn().mockReturnThis();
      return res;
    }

    it('should call next() when paymentMode is disabled', () => {
      const middleware = createPaymentGate({ paymentMode: 'disabled' });
      const req = createMockRequest();
      const res = createMockResponse();
      const next = vi.fn();

      middleware(req, res, next);

      expect(next).toHaveBeenCalledOnce();
    });

    it('should set req.paymentSkipped=true when paymentMode is disabled', () => {
      const middleware = createPaymentGate({ paymentMode: 'disabled' });
      const req = createMockRequest();
      const res = createMockResponse();
      const next = vi.fn();

      middleware(req, res, next);

      expect(req.paymentSkipped).toBe(true);
    });

    it('should return 402 when testnet mode and no payment header', () => {
      const middleware = createPaymentGate({ paymentMode: 'testnet' });
      const req = createMockRequest();
      const res = createMockResponse();
      const next = vi.fn();

      middleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(402);
      expect(next).not.toHaveBeenCalled();
    });

    it('should return 402 JSON with network info when testnet mode and no payment header', () => {
      const middleware = createPaymentGate({ paymentMode: 'testnet' });
      const req = createMockRequest();
      const res = createMockResponse();
      const next = vi.fn();

      middleware(req, res, next);

      expect(res.json).toHaveBeenCalledWith({
        error: 'Payment Required',
        paymentMode: 'testnet',
        network: 'eip155:84532',
      });
    });

    it('should call next() when testnet mode and payment header present', () => {
      const middleware = createPaymentGate({ paymentMode: 'testnet' });
      const req = createMockRequest({ 'x-payment': 'some-payment-proof' });
      const res = createMockResponse();
      const next = vi.fn();

      middleware(req, res, next);

      expect(next).toHaveBeenCalledOnce();
      expect(res.status).not.toHaveBeenCalled();
    });

    it('should return 402 when mainnet mode and no payment header', () => {
      const middleware = createPaymentGate({ paymentMode: 'mainnet' });
      const req = createMockRequest();
      const res = createMockResponse();
      const next = vi.fn();

      middleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(402);
      expect(next).not.toHaveBeenCalled();
    });

    it('should call next() when mainnet mode and payment header present', () => {
      const middleware = createPaymentGate({ paymentMode: 'mainnet' });
      const req = createMockRequest({ 'x-payment': 'some-payment-proof' });
      const res = createMockResponse();
      const next = vi.fn();

      middleware(req, res, next);

      expect(next).toHaveBeenCalledOnce();
      expect(res.status).not.toHaveBeenCalled();
    });
  });

  describe('validatePaymentConfig', () => {
    it('should do nothing for disabled mode', () => {
      expect(() => validatePaymentConfig({ paymentMode: 'disabled', paymentPayTo: '0x123' })).not.toThrow();
    });

    it('should do nothing for disabled mode even with empty paymentPayTo', () => {
      expect(() => validatePaymentConfig({ paymentMode: 'disabled', paymentPayTo: '' })).not.toThrow();
    });

    it('should pass for testnet with valid paymentPayTo', () => {
      expect(() => validatePaymentConfig({ paymentMode: 'testnet', paymentPayTo: '0x123' })).not.toThrow();
    });

    it('should throw for testnet with empty paymentPayTo', () => {
      expect(() => validatePaymentConfig({ paymentMode: 'testnet', paymentPayTo: '' })).toThrow(
        'PAYMENT_PAY_TO is required when paymentMode is testnet or mainnet'
      );
    });

    it('should throw for mainnet with empty paymentPayTo', () => {
      expect(() => validatePaymentConfig({ paymentMode: 'mainnet', paymentPayTo: '' })).toThrow(
        'PAYMENT_PAY_TO is required when paymentMode is testnet or mainnet'
      );
    });

    it('should throw for invalid paymentMode', () => {
      expect(() => validatePaymentConfig({ paymentMode: 'invalid', paymentPayTo: '0x123' })).toThrow(
        'paymentMode must be one of: disabled, testnet, mainnet'
      );
    });
  });
});
