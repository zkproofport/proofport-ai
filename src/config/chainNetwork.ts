/**
 * Which network family this deployment serves: `testnet` or `mainnet`.
 *
 * Set explicitly by `CHAIN_NETWORK`. Until 2026-11-21 it was inferred from
 * whether `CHAIN_RPC_URL` contained the substring "sepolia", so any testnet
 * endpoint whose hostname lacked that word (a proxy, a gateway, a custom
 * node) silently ran as mainnet: mainnet chain ids, mainnet verifier records,
 * mainnet identity registry. A hostname is not a network.
 */

export const CHAIN_NETWORKS = ['testnet', 'mainnet'] as const;
export type ChainNetwork = (typeof CHAIN_NETWORKS)[number];

/** Exact match only: no trimming, no case folding, no default. */
export function parseChainNetwork(value: string | undefined): ChainNetwork {
  if (value === undefined) {
    throw new Error(`CHAIN_NETWORK environment variable is required. Allowed: ${CHAIN_NETWORKS.join(', ')}.`);
  }
  if (!(CHAIN_NETWORKS as readonly string[]).includes(value)) {
    throw new Error(`Unknown CHAIN_NETWORK ${JSON.stringify(value)}. Allowed: ${CHAIN_NETWORKS.join(', ')}.`);
  }
  return value as ChainNetwork;
}

/**
 * The network each PAYMENT_MODE requires. `null`: payment is off and either
 * network is coherent. Keyed, so a payment mode added later without a row
 * stops startup instead of being waved through.
 */
const PAYMENT_MODE_NETWORK: Record<string, ChainNetwork | null> = {
  disabled: null,
  testnet: 'testnet',
  mainnet: 'mainnet',
};

/** Refuses a deployment that would take payment on one network and verify on the other. */
export function assertPaymentModeMatchesNetwork(paymentMode: string, network: ChainNetwork): void {
  if (!Object.hasOwn(PAYMENT_MODE_NETWORK, paymentMode)) {
    throw new Error(`Unknown PAYMENT_MODE ${JSON.stringify(paymentMode)}. Known: ${Object.keys(PAYMENT_MODE_NETWORK).join(', ')}.`);
  }
  const required = PAYMENT_MODE_NETWORK[paymentMode];
  if (required !== null && required !== network) {
    throw new Error(`PAYMENT_MODE=${paymentMode} requires CHAIN_NETWORK=${required} (got: ${network}).`);
  }
}
