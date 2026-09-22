import { afterEach, describe, expect, it, vi } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { getSettlementAccount, validateSettlementConfig } from '../../src/payment/settlementAccount.js';
import { settlePayment } from '../../src/payment/settle.js';
import { getPaymentNetwork } from '../../src/payment/networks.js';

// Only the external transaction boundary is stubbed; account derivation is real.
vi.mock('@x402/core/facilitator', () => ({
  x402Facilitator: class {
    register() {}
    async settle() { return { success: true, transaction: `0x${'ab'.repeat(32)}` }; }
  },
}));

// Public test scalar; never an operator key.
const key = `0x${'01'.padStart(64, '0')}` as const;
const payTo = privateKeyToAccount(key).address;
const config = {
  paymentMode: 'testnet', paymentNetworks: 'base-sepolia,arc-testnet,ethereum-sepolia',
  proverPrivateKey: key, paymentPayTo: payTo,
};
afterEach(() => vi.unstubAllEnvs());

describe('one prover wallet also settles direct payments', () => {
  it.each([key, key.slice(2)])('derives the prover wallet with or without a prefix', (value) => {
    expect(getSettlementAccount(value, payTo.toLowerCase()).address).toBe(payTo);
  });

  it('accepts startup when all offered payee networks use the prover payee', () => {
    expect(() => validateSettlementConfig(config)).not.toThrow();
  });

  it('rejects a different recipient before accepting payments', () => {
    expect(() => validateSettlementConfig({ ...config, paymentPayTo: `0x${'22'.repeat(20)}` }))
      .toThrow(/PROVER_PRIVATE_KEY.*PAYMENT_PAY_TO/);
  });

  it.each(['', 'bad-secret-material', `0x${'00'.repeat(32)}`, `0x${'ff'.repeat(32)}`])(
    'rejects invalid prover keys without disclosing them', (value) => {
      let error: unknown;
      try { validateSettlementConfig({ ...config, proverPrivateKey: value }); } catch (caught) { error = caught; }
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/PROVER_PRIVATE_KEY/);
      if (value) expect((error as Error).message).not.toContain(value);
    },
  );

  it.each(['', '0x123', 'not-an-address'])('rejects malformed recipients', (value) => {
    expect(() => getSettlementAccount(key, value)).toThrow(/PAYMENT_PAY_TO/);
  });

  it.each(['base-sepolia', 'arc-testnet-nano', 'base-sepolia,arc-testnet-nano'])(
    'does not require a settlement wallet for %s', (paymentNetworks) => {
      expect(() => validateSettlementConfig({ ...config, paymentNetworks, proverPrivateKey: '', paymentPayTo: '' }))
        .not.toThrow();
    },
  );

  it('does not enforce a payee wallet when payment is disabled', () => {
    expect(() => validateSettlementConfig({ ...config, paymentMode: 'disabled', proverPrivateKey: '', paymentPayTo: '' }))
      .not.toThrow();
  });

  it('does not silently discard unknown payment networks', () => {
    expect(() => validateSettlementConfig({ ...config, paymentNetworks: 'typo-network' })).toThrow(/typo-network/);
  });


  it.each(['arc-testnet', 'ethereum-sepolia', 'ethereum'])(
    'settles %s using only the prover key', async (id) => {
      vi.stubEnv('PROVER_PRIVATE_KEY', key);
      vi.stubEnv('PAYMENT_SETTLER_PRIVATE_KEY', 'invalid-legacy-key-is-ignored');
      vi.stubEnv('PAYMENT_PAY_TO', payTo);
      const network = getPaymentNetwork(id);
      await expect(settlePayment({ payload: {}, requirements: { payTo }, network, networks: [network] }))
        .resolves.toEqual({ via: 'payee', txHash: `0x${'ab'.repeat(32)}` });
    },
  );

  it('also rejects a payee mismatch at the transaction boundary', async () => {
    vi.stubEnv('PROVER_PRIVATE_KEY', key);
    vi.stubEnv('PAYMENT_PAY_TO', `0x${'22'.repeat(20)}`);
    const network = getPaymentNetwork('arc-testnet');
    await expect(settlePayment({ payload: {}, requirements: {}, network, networks: [network] }))
      .rejects.toThrow(/PROVER_PRIVATE_KEY.*PAYMENT_PAY_TO/);
  });

  it('rejects a direct payment without the prover key even if a legacy settler key exists', async () => {
    vi.stubEnv('PROVER_PRIVATE_KEY', '');
    vi.stubEnv('PAYMENT_SETTLER_PRIVATE_KEY', key);
    vi.stubEnv('PAYMENT_PAY_TO', payTo);
    const network = getPaymentNetwork('ethereum-sepolia');
    await expect(settlePayment({ payload: {}, requirements: { payTo }, network, networks: [network] }))
      .rejects.toThrow(/PROVER_PRIVATE_KEY/);
  });
});
