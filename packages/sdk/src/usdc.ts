/**
 * The USDC contracts this SDK is willing to pay in.
 *
 * ## Why the client keeps its own list
 *
 * A 402 answer names the token it wants paid in. Signing whatever it names
 * means a service can ask for any token at all -- including one it minted --
 * and a wallet paying autonomously would sign it. `@x402/core` guards against
 * exactly that: it refuses to sign for an asset outside its own default list
 * unless told otherwise, and refusing is the correct behaviour.
 *
 * Arc's USDC is not in that default list, so paying on Arc needs this list
 * rather than `spendControls: false`. The difference matters: turning the
 * control off allows every token on every chain, which is how an agent ends up
 * signing away something nobody meant to spend. This allows five specific
 * contracts and nothing else.
 *
 * So yes, this duplicates the server's table in `src/payment/networks.ts` --
 * deliberately. A shared table would mean the client trusting the server's
 * word about which token is USDC, which is the thing being guarded against.
 *
 * ## Keeping it right
 *
 * Each address was read from the chain, not from memory:
 * `decimals()` is 6 and `name()`/`symbol()` say USDC on all five. Arc's is the
 * ERC-20 view of its native balance, checked on 2026-09-09 -- name "USDC",
 * version "2", decimals 6, and a `DOMAIN_SEPARATOR()` that matches the hash a
 * client computes from those values.
 */

/** CAIP-2 chain id → the USDC contract on it. */
const USDC_BY_CHAIN: Record<string, string> = {
  'eip155:1': '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',            // Ethereum
  'eip155:11155111': '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',     // Ethereum Sepolia
  'eip155:8453': '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',         // Base
  'eip155:84532': '0x036CbD53842c5426634e7929541eC2318f3dCF7e',        // Base Sepolia
  'eip155:5042002': '0x3600000000000000000000000000000000000000',      // Arc, native USDC's ERC-20 view
};

/**
 * The most this SDK will sign for in one payment, unless the caller says
 * otherwise.
 *
 * A proof costs cents. A cap two orders of magnitude above that leaves room
 * for a price change without leaving room for a mistake -- and it is the
 * difference between a misconfigured service overcharging by a cent and
 * draining a wallet.
 */
export const DEFAULT_MAX_PAYMENT = '$1';

/**
 * The spend controls to sign under: these five USDC contracts, capped.
 *
 * Passing an asset the offer names that is NOT in the list produces a refusal
 * from `@x402/core` rather than a signature.
 */
export function usdcSpendControls(maxPayment?: string) {
  return {
    maxAmountPerPayment: maxPayment ?? DEFAULT_MAX_PAYMENT,
    allowedAssets: Object.entries(USDC_BY_CHAIN).map(([network, asset]) => ({
      network,
      asset,
    })),
  };
}

/**
 * Whether an offer names the USDC this SDK knows for that chain.
 *
 * Checked before signing so the error says which token was asked for, rather
 * than letting `@x402/core` refuse with a message about allowedAssets that
 * does not name the culprit.
 */
export function isKnownUsdc(network: string, asset: string): boolean {
  const known = USDC_BY_CHAIN[network];
  return !!known && known.toLowerCase() === asset.toLowerCase();
}

/** The USDC this SDK knows for a chain, or undefined. */
export function knownUsdc(network: string): string | undefined {
  return USDC_BY_CHAIN[network];
}
