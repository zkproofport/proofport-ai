/**
 * The chains this service will take payment on.
 *
 * ## Why a table and not a ternary
 *
 * This replaced:
 *
 *     const network = isTestnet ? 'base-sepolia' : 'base';
 *
 * which is the fallback shape this project forbids everywhere else: any
 * configuration that is not recognisably testnet silently becomes Base
 * mainnet. Point the service at a chain it has never heard of and it does not
 * refuse — it quotes a price in Base mainnet USDC, publishes a Base asset
 * address, and then verifies the payment against Base. Every one of those
 * succeeds while describing a chain nobody chose.
 *
 * So each chain is named, with the values that belong to it, and a chain that
 * is not in this table is an error rather than Base.
 *
 * ## Why several at once
 *
 * x402 sends payment options as a LIST, and Circle's Discovery API reads that
 * list to say which networks a service accepts. A service pinned to one chain
 * per deployment cannot answer "I take Base or Arc, your choice" — which is
 * the whole point of the standard. `PAYMENT_NETWORKS` is therefore a
 * comma-separated set, and the 402 offers all of them.
 */

/**
 * The facilitator for chains a third party will settle.
 *
 * `X402_FACILITATOR_URL` overrides it, which is the only knob an operator
 * needs here -- pointing at a different facilitator, or at a local one during
 * a test. It is an override of this table rather than a separate answer to the
 * same question: before this, the env var was published in the 402 body as
 * "the" facilitator while the table named one per chain, so the two could
 * disagree and the body was simply wrong for every chain no facilitator
 * serves.
 *
 * Read at module load. Chains with `settlement: 'payee'` ignore it: there is
 * no facilitator to point anywhere.
 */
const DEXTER = process.env.X402_FACILITATOR_URL || 'https://x402.dexter.cash';

/** A chain this service can be paid on. */
/**
 * Every chain-and-settlement pair this service takes payment on.
 *
 * One name, read by everything that needs it. It was typed out in two files
 * until 2026-09-13, and adding Arc's batched option to one of them made the
 * other a compile error — which is the good outcome, but only because the two
 * happened to be checked together.
 */
export type PaymentNetworkId =
  | 'base-sepolia'
  | 'base'
  | 'ethereum'
  | 'ethereum-sepolia'
  | 'arc-testnet'
  | 'arc-testnet-nano';

export interface PaymentNetwork {
  /** The x402 network name, as it appears in a payment requirement. */
  id: PaymentNetworkId;
  /**
   * CAIP-2, which is what the Discovery API filters on and what the x402 v2
   * scheme registers against.
   *
   * Typed as the shape rather than `string` so `@x402/evm`'s registration
   * accepts it directly. It was `string` with an `as never` at the call site,
   * and a cast there would have kept compiling if this field ever stopped
   * being CAIP-2 -- which is the one thing about it that matters.
   */
  caip2: `${string}:${string}`;
  chainId: number;
  /** The USDC contract a Transfer event must come from. */
  usdc: string;
  /**
   * Decimals of a QUOTED amount and of an EIP-3009 authorization.
   *
   * Six on every chain here, Arc included. Arc was written down as 18 in the
   * first version of this table on the reasoning that USDC is its native gas
   * asset, so a native send carries 18-decimal value. That is true of a native
   * send and false of everything this service actually quotes: asked directly,
   * `decimals()` on Arc's USDC answers 6, and its `DOMAIN_SEPARATOR()` is
   * reproducible from {name:"USDC", version:"2", chainId:5042002} -- checked
   * byte for byte on 2026-09-09, not assumed. So the ERC-20 view is an ordinary
   * 6-decimal USDC and a signed authorization is an ordinary one.
   *
   * `nativeDecimals` below is where the 18 belongs.
   */
  decimals: number;
  /**
   * Decimals of `tx.value` when USDC is the chain's native asset.
   *
   * Only read when a payment arrives as a plain native send rather than an
   * authorization -- nobody is asked to pay that way, but it is a real thing a
   * wallet can do, and 0.01 USDC then appears as 1e16 rather than 1e4.
   */
  nativeDecimals?: number;
  /**
   * Who submits the transaction, and therefore who pays gas.
   *
   * `facilitator` -- the buyer signs an EIP-3009 authorization and an x402
   * facilitator submits it. The buyer needs no gas and no native balance at
   * all. Which chains: taken from each facilitator's own `/supported`, asked
   * on 2026-09-09, never guessed.
   *
   * `payee` -- no public facilitator settles this chain, so this service
   * submits the buyer's authorization itself. The buyer still needs no gas;
   * the payee pays it, out of the payment it is about to receive. This is the
   * only route that works on Arc today: `x402.dexter.cash` covers Base, Polygon,
   * Arbitrum, Optimism, Avalanche, BSC, World Chain, Monad, SKALE and Solana,
   * and `x402.org/facilitator` covers Base Sepolia and a few non-EVM chains --
   * neither lists Arc, and neither lists Ethereum mainnet either.
   */
  /**
   * Who puts the buyer's authorization on chain.
   *
   * `facilitator` — a public x402 facilitator does it.
   * `payee` — this service does, from the wallet `PAYMENT_PAY_TO` names.
   * `gateway` — nobody does, one payment at a time: the authorization goes to
   *   Circle Gateway's off-chain ledger and is settled later in a batch with
   *   thousands of others, so the gas per payment approaches zero. This is
   *   what Circle calls nanopayments.
   */
  settlement: 'facilitator' | 'payee' | 'gateway';
  /**
   * Present only on a `gateway` chain: what the buyer signs against.
   *
   * A batched authorization is signed for Gateway's wallet contract rather
   * than for USDC itself, and `@circle-fin/x402-batching` recognises the offer
   * by exactly these two values. They are not ours to choose.
   */
  batching?: {
    name: 'GatewayWalletBatched';
    version: '1';
    gatewayWallet: string;
    domain: number;
    /**
     * How long the authorization must stay valid, in seconds.
     *
     * Circle's own starter kit sends 345600 (four days) for Arc Testnet,
     * and Gateway advertises a 604800 minimum in `getSupported()`. The kit's
     * number is the one known to work, so it is the one used.
     */
    minValiditySeconds: number;
    /**
     * Which Circle Gateway settles this chain.
     *
     * Testnet and mainnet are different services at different hostnames, and
     * the package's default is the mainnet one. Asking the mainnet Gateway
     * about a testnet chain answers `unsupported_network` — which reads as
     * "Circle does not support Arc" and is really "you asked the wrong
     * server". Measured 2026-09-13: the testnet Gateway lists Arc Testnet
     * among its twelve chains, the mainnet one lists eleven mainnets.
     */
    gatewayUrl: string;
  };
  /**
   * The EIP-712 domain of this chain's USDC, which is what an EIP-3009
   * authorization is signed against. `name` is also what a wallet displays.
   */
  eip3009: { name: string; version: string };
  /**
   * True when USDC is the chain's native gas asset, so a payment can arrive
   * as `tx.value` with no Transfer event at all.
   */
  nativeUsdc: boolean;
  /** The facilitator that settles this chain, when `settlement` is 'facilitator'. */
  facilitatorUrl?: string;
  /** Env var holding this chain's RPC. Read at request time, never guessed. */
  rpcEnv: string;
  defaultRpc: string;
}

const NETWORKS: Record<string, PaymentNetwork> = {
  'base-sepolia': {
    id: 'base-sepolia',
    caip2: 'eip155:84532',
    chainId: 84532,
    usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    decimals: 6,
    // Both the domain name and the facilitator's support for this chain are
    // read from `${DEXTER}/supported`, which advertises
    // `extra: {name:'USDC', version:'2'}` for eip155:84532.
    eip3009: { name: 'USDC', version: '2' },
    settlement: 'facilitator',
    facilitatorUrl: DEXTER,
    nativeUsdc: false,
    rpcEnv: 'CHAIN_RPC_URL',
    defaultRpc: 'https://sepolia.base.org',
  },
  base: {
    id: 'base',
    caip2: 'eip155:8453',
    chainId: 8453,
    usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    decimals: 6,
    // Mainnet USDC calls itself 'USD Coin' where the testnet one says 'USDC'.
    // Getting this wrong produces a valid signature over the wrong domain,
    // which the facilitator rejects with a signature error and no hint.
    eip3009: { name: 'USD Coin', version: '2' },
    settlement: 'facilitator',
    facilitatorUrl: DEXTER,
    nativeUsdc: false,
    rpcEnv: 'CHAIN_RPC_URL',
    defaultRpc: 'https://mainnet.base.org',
  },
  // Ethereum. The proof verifiers have been deployed on mainnet and Sepolia
  // all along -- see FALLBACK_VERIFIERS chains '1' and '11155111' -- but
  // payment could never arrive here: the ternary this table replaced resolved
  // every configuration to one of the two Base chains, so a service verifying
  // proofs on Ethereum still had to be paid on Base.
  //
  // Neither facilitator settles Ethereum, so this service settles it.
  ethereum: {
    id: 'ethereum',
    caip2: 'eip155:1',
    chainId: 1,
    // Read off chain, not from memory: symbol=USDC, decimals=6.
    usdc: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    decimals: 6,
    eip3009: { name: 'USD Coin', version: '2' },
    settlement: 'payee',
    nativeUsdc: false,
    rpcEnv: 'ETHEREUM_RPC_URL',
    defaultRpc: 'https://ethereum-rpc.publicnode.com',
  },
  'ethereum-sepolia': {
    id: 'ethereum-sepolia',
    caip2: 'eip155:11155111',
    chainId: 11155111,
    usdc: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
    decimals: 6,
    eip3009: { name: 'USDC', version: '2' },
    settlement: 'payee',
    nativeUsdc: false,
    rpcEnv: 'ETHEREUM_RPC_URL',
    defaultRpc: 'https://ethereum-sepolia-rpc.publicnode.com',
  },
  'arc-testnet': {
    id: 'arc-testnet',
    caip2: 'eip155:5042002',
    chainId: 5042002,
    // The ERC-20 interface over Arc's native USDC balance. One balance, two
    // views: docs.arc.io/arc/references/evm-differences.
    usdc: '0x3600000000000000000000000000000000000000',
    decimals: 6,
    nativeDecimals: 18,
    // Asked the contract on 2026-09-09 rather than assuming a native-asset
    // shim would be a partial ERC-20: it answers name()="USDC", version()="2",
    // decimals()=6, and DOMAIN_SEPARATOR() equal to the hash a client computes
    // from these three values plus chainId 5042002 -- byte for byte. So Arc
    // takes an ordinary signed USDC authorization and nobody needs to hold a
    // separate gas asset to pay here.
    eip3009: { name: 'USDC', version: '2' },
    // No public facilitator lists Arc. Asked both on 2026-09-09:
    // x402.dexter.cash serves Base, Polygon, Arbitrum, Optimism, Avalanche,
    // BSC, World Chain, Monad, SKALE, Solana; x402.org/facilitator serves Base
    // Sepolia plus some non-EVM chains. Neither has Arc, which is why this
    // route exists rather than Arc being declared unsupported.
    settlement: 'payee',
    nativeUsdc: true,
    rpcEnv: 'ARC_RPC_URL',
    defaultRpc: 'https://rpc.testnet.arc.io',
  },
  /**
   * The same chain, paid for the other way: Circle Gateway's batched
   * settlement, which is what Arc calls nanopayments.
   *
   * A separate entry rather than a flag on the one above, because the two are
   * different offers a buyer chooses between -- one settles immediately and
   * costs gas, the other settles in a batch and costs almost none. Offering
   * both is what `@circle-fin/x402-batching` expects: its `supportsBatching()`
   * picks this one out of the list by its `extra`, and anything it does not
   * recognise stays on the existing on-chain path.
   *
   * Addresses read from `@circle-fin/x402-batching@3.4.0` and checked on chain
   * 2026-09-13: both contracts are deployed on Arc Testnet.
   */
  'arc-testnet-nano': {
    id: 'arc-testnet-nano',
    caip2: 'eip155:5042002',
    chainId: 5042002,
    usdc: '0x3600000000000000000000000000000000000000',
    decimals: 6,
    nativeDecimals: 18,
    eip3009: { name: 'USDC', version: '2' },
    settlement: 'gateway',
    batching: {
      name: 'GatewayWalletBatched',
      version: '1',
      gatewayWallet: '0x0077777d7EBA4688BDeF3E311b846F25870A19B9',
      domain: 26,
      minValiditySeconds: 345600,
      gatewayUrl: 'https://gateway-api-testnet.circle.com',
    },
    nativeUsdc: true,
    rpcEnv: 'ARC_RPC_URL',
    defaultRpc: 'https://rpc.testnet.arc.io',
  },
};

/**
 * The chains named in `PAYMENT_NETWORKS`, in the order given.
 *
 * An unknown name is an ERROR listing what is available, not a silent drop:
 * a typo would otherwise remove a chain from the offer with nothing said, and
 * the service would look like it simply does not take payment there.
 */
export function resolvePaymentNetworks(spec: string): PaymentNetwork[] {
  const names = spec.split(',').map((s) => s.trim()).filter(Boolean);
  if (names.length === 0) {
    throw new Error(
      `PAYMENT_NETWORKS is empty. Name at least one of: ${Object.keys(NETWORKS).join(', ')}`,
    );
  }
  const unknown = names.filter((n) => !(n in NETWORKS));
  if (unknown.length) {
    throw new Error(
      `Unknown payment network(s): ${unknown.join(', ')}. ` +
      `Available: ${Object.keys(NETWORKS).join(', ')}`,
    );
  }
  const seen = new Set<string>();
  return names.filter((n) => !seen.has(n) && seen.add(n)).map((n) => NETWORKS[n]);
}

/** One chain by its x402 name, or undefined. Callers decide what absence means. */
export function getPaymentNetwork(id: string): PaymentNetwork | undefined {
  return NETWORKS[id];
}

export function allPaymentNetworkIds(): string[] {
  return Object.keys(NETWORKS);
}

/**
 * How long a buyer has to pay, in seconds.
 *
 * Deliberately equal to the challenge nonce's Redis TTL. A longer window would
 * let a buyer sign an authorization for a challenge that has already expired --
 * the payment settles, the proof request is refused for an unknown nonce, and
 * the money is gone. Change one and change the other.
 */
export const PAYMENT_WINDOW_SECONDS = 300;

/**
 * One chain's payment requirement, in x402 v2 form.
 *
 * The v2 field names differ from v1 in ways that fail quietly: the amount is
 * `amount`, not `maxAmountRequired`, and `maxTimeoutSeconds` is required. Sent
 * as v1 field names under `x402Version: 2`, the official client reads the
 * amount as `undefined` and dies with "Cannot convert undefined to a BigInt",
 * which says nothing about field names. Caught by
 * `tests/payment/signPayment.test.ts`, which signs the requirement this file
 * actually emits.
 *
 * `resource`, `description` and `mimeType` are not part of the v2 requirement.
 * They are kept because an agent reading the 402 body benefits from them and
 * the schema strips unknown keys rather than rejecting them -- both sides strip
 * identically, so the signature still matches.
 */
export interface PaymentRequirement {
  scheme: 'exact';
  /** CAIP-2. The v2 form, and the only one that can name Arc. */
  network: string;
  /** Price in the asset's own units. `amount` is the v2 name. */
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: Record<string, unknown> & { name: string; version: string };
  /** The plain chain name. Not part of v2; stripped before signing. */
  networkName: string;
  /** Human-facing, and not part of v2 either. */
  resource: string;
  description: string;
  mimeType: string;
}

/**
 * The payment requirements to offer, one per chain.
 *
 * Built here rather than inline in the route because it is needed twice and
 * the two copies must be identical: once to answer 402, and again when a
 * signed authorization comes back, since settling verifies the authorization
 * against the requirement it was signed for. A requirement rebuilt with even
 * one field different -- a re-rounded price, a regenerated nonce -- fails as
 * an invalid signature, which reads like the buyer signed wrongly.
 */
export function buildPaymentRequirements(params: {
  networks: PaymentNetwork[];
  /** Price in whole USDC, e.g. "0.01". */
  price: string;
  payTo: string;
  resource: string;
  nonce: string;
  /** When payment is off the price is zero and payTo is empty. */
  disabled?: boolean;
  /** Parses a decimal amount into a token's units. */
  parseUnits: (value: string, decimals: number) => bigint;
}): PaymentRequirement[] {
  const { networks, price, payTo, resource, nonce, disabled, parseUnits } = params;
  return networks.map((net) => ({
    scheme: 'exact' as const,
    network: net.caip2,
    amount: disabled ? '0' : parseUnits(price, net.decimals).toString(),
    asset: net.usdc,
    payTo: disabled ? '' : payTo,
    maxTimeoutSeconds: net.batching?.minValiditySeconds ?? PAYMENT_WINDOW_SECONDS,
    // A batched offer is recognised by its `extra`: `@circle-fin/x402-batching`
    // reads exactly `name`/`version` to tell a Gateway offer from an ordinary
    // one, and the buyer signs against Gateway's wallet contract rather than
    // against USDC. Everything else about the offer is the same, which is why
    // this is one line and not a second builder.
    extra: net.batching
      ? {
          // Three fields, exactly as Circle's own starter kit sends them
          // (`lib/x402.ts` in circlefin/arc-nanopayments). Gateway signs over
          // what it is given, so a field we add that the kit does not send
          // makes a different message than the one Gateway verifies — and the
          // refusal reads `unauthorized`, which says nothing about a field.
          name: net.batching.name,
          version: net.batching.version,
          verifyingContract: net.batching.gatewayWallet,
        }
      : { name: net.eip3009.name, version: net.eip3009.version, nonce, caip2: net.caip2 },
    networkName: net.id,
    resource,
    description: disabled
      ? 'Payment disabled — free proof generation'
      : net.batching
        ? `ZK proof generation fee (${price} USDC on Arc, settled in a batch — no gas)`
        : `ZK proof generation fee (${price} USDC on ${net.id})`,
    mimeType: 'application/json',
  }));
}
