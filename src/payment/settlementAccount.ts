import { isAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { resolvePaymentNetworks } from './networks.js';

/** Identity signing and direct payment settlement use the same operator wallet. */
export function getSettlementAccount(proverPrivateKey: string, payTo: string) {
  if (!proverPrivateKey || !/^(0x)?[a-fA-F0-9]{64}$/.test(proverPrivateKey)) {
    throw new Error('PROVER_PRIVATE_KEY must be a valid 32-byte private key for direct payment settlement.');
  }
  const key = proverPrivateKey.startsWith('0x') ? proverPrivateKey : `0x${proverPrivateKey}`;
  let account;
  try {
    account = privateKeyToAccount(key as `0x${string}`);
  } catch {
    // Cryptographic libraries may include their input in validation errors.
    throw new Error('PROVER_PRIVATE_KEY must be a valid secp256k1 private key for direct payment settlement.');
  }
  if (!isAddress(payTo, { strict: false })) {
    throw new Error('PAYMENT_PAY_TO must be a valid EVM address for direct payment settlement.');
  }
  if (account.address.toLowerCase() !== payTo.toLowerCase()) {
    throw new Error('PROVER_PRIVATE_KEY wallet must match PAYMENT_PAY_TO for direct payment settlement; Arc permits only the payee to submit.');
  }
  return account;
}

/** Fail before serving payment offers, rather than after a buyer authorizes one. */
export function validateSettlementConfig(config: {
  paymentMode: string;
  paymentNetworks: string;
  proverPrivateKey: string;
  paymentPayTo: string;
}): void {
  if (config.paymentMode === 'disabled') return;
  const networks = resolvePaymentNetworks(config.paymentNetworks);
  if (networks.some(network => network.settlement === 'payee')) {
    getSettlementAccount(config.proverPrivateKey, config.paymentPayTo);
  }
}
