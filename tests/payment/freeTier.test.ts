import { describe, it, expect, vi } from 'vitest';
import { getPaymentModeConfig, validatePaymentConfig } from '../../src/payment/freeTier';

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

  // The `createPaymentGate` block that stood here went with the function on
  // 2026-09-09. See the note in src/payment/freeTier.ts: nothing imported it,
  // and its 402 body named a single chain derived from the payment mode, which
  // is not the shape the service actually answers with.

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
        'PAYMENT_PAY_TO is required when paymentMode is testnet'
      );
    });

    it('should throw for mainnet with empty paymentPayTo', () => {
      // Names the mode it was actually given. The message used to list both
      // ("testnet or mainnet"), which reads as if either might be the cause.
      expect(() => validatePaymentConfig({ paymentMode: 'mainnet', paymentPayTo: '' })).toThrow(
        'PAYMENT_PAY_TO is required when paymentMode is mainnet'
      );
    });

    it('should throw for invalid paymentMode', () => {
      expect(() => validatePaymentConfig({ paymentMode: 'invalid', paymentPayTo: '0x123' })).toThrow(
        'paymentMode must be one of: disabled, testnet, mainnet'
      );
    });
  });
});
