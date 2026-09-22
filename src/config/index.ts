import { createRequire } from 'node:module';

const serverVersion: string = createRequire(import.meta.url)('../../package.json').version;

function getRequiredEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`${key} environment variable is required`);
  }
  return value;
}

function validatePaymentMode(value: string): 'disabled' | 'testnet' | 'mainnet' {
  const valid = ['disabled', 'testnet', 'mainnet'] as const;
  if (!valid.includes(value as any)) {
    throw new Error(`PAYMENT_MODE must be one of: ${valid.join(', ')} (got: ${value})`);
  }
  return value as 'disabled' | 'testnet' | 'mainnet';
}

function validateTeeMode(value: string): 'disabled' | 'local' | 'nitro' {
  const valid = ['disabled', 'local', 'nitro'] as const;
  if (!valid.includes(value as any)) {
    throw new Error(`TEE_MODE must be one of: ${valid.join(', ')} (got: ${value})`);
  }
  return value as 'disabled' | 'local' | 'nitro';
}

export function loadConfig() {
  const paymentMode = validatePaymentMode(getRequiredEnv('PAYMENT_MODE'));

  const config = {
    port: parseInt(process.env.PORT || '4002', 10),
    nodeEnv: process.env.NODE_ENV || 'development',
    proverUrl: process.env.PROVER_URL || '',
    bbPath: process.env.BB_PATH || 'bb',
    // nargoPath removed — witness generation now uses @noir-lang/noir_js instead of nargo CLI
    circuitsDir: process.env.CIRCUITS_DIR || '/app/circuits',
    circuitsRepoUrl: process.env.CIRCUITS_REPO_URL || 'https://raw.githubusercontent.com/zkproofport/circuits/main',
    redisUrl: getRequiredEnv('REDIS_URL'),
    baseRpcUrl: getRequiredEnv('BASE_RPC_URL'),
    easGraphqlEndpoint: getRequiredEnv('EAS_GRAPHQL_ENDPOINT'),
    chainRpcUrl: getRequiredEnv('CHAIN_RPC_URL'),
    proverPrivateKey: getRequiredEnv('PROVER_PRIVATE_KEY'),
    paymentMode,
    a2aBaseUrl: getRequiredEnv('A2A_BASE_URL'),
    websiteUrl: process.env.WEBSITE_URL || 'https://zkproofport.com',
    agentVersion: process.env.AGENT_VERSION || serverVersion,

    // Payment (required when paymentMode !== 'disabled')
    paymentPayTo: process.env.PAYMENT_PAY_TO || '',
    /**
     * Chains this deployment takes payment on, comma separated.
     *
     * A LIST because x402 sends payment options as a list and Circle's
     * Discovery API reads it to say which networks a service accepts -- one
     * chain per deployment cannot express "Base or Arc, your choice".
     *
     * Required, with no default. It briefly had `|| 'base-sepolia'` on the
     * reasoning that an existing deployment should behave identically until
     * the variable is set -- which is precisely the shape this project
     * forbids: a deployment meant to take payment on Arc, whose variable was
     * misspelled or never plumbed through, would quote prices in Base Sepolia
     * USDC and publish a Base asset address, and every one of those steps
     * would succeed while describing a chain nobody chose. Both deploy
     * workflows set it per environment, next to the other chain-dependent
     * values.
     *
     * An unknown name is likewise an error naming the available ones, never a
     * silent drop: a typo would otherwise remove a chain from the offer with
     * nothing said, and the service would look like it simply does not take
     * payment there.
     */
    paymentNetworks: getRequiredEnv('PAYMENT_NETWORKS'),
    paymentProofPrice: process.env.PAYMENT_PROOF_PRICE || '$0.10',
    /**
     * Kept on the config object for the tests that construct one, but the
     * value that decides anything now lives in `src/payment/networks.ts`,
     * where each facilitator-settled chain names its facilitator and
     * `X402_FACILITATOR_URL` overrides it. Nothing in src/ reads this field
     * any more -- the 402 body and the agent guide report settlement per
     * chain, because a single facilitator URL is wrong for every chain no
     * public facilitator serves.
     */
    x402FacilitatorUrl: process.env.X402_FACILITATOR_URL || 'https://x402.dexter.cash',

    // TEE (optional)
    teeMode: validateTeeMode(process.env.TEE_MODE || 'disabled'),
    enclaveCid: process.env.ENCLAVE_CID ? parseInt(process.env.ENCLAVE_CID, 10) : undefined,
    enclavePort: process.env.ENCLAVE_PORT ? parseInt(process.env.ENCLAVE_PORT, 10) : 5000,
    teeAttestationEnabled: process.env.TEE_ATTESTATION === 'true',

    // ERC-8004 Identity (optional - only needed for on-chain registration)
    erc8004IdentityAddress: process.env.ERC8004_IDENTITY_ADDRESS || '',
    erc8004ReputationAddress: process.env.ERC8004_REPUTATION_ADDRESS || '',
    erc8004ValidationAddress: process.env.ERC8004_VALIDATION_ADDRESS || '',
    agentTokenId: process.env.AGENT_TOKEN_ID || '',

    // Ethereum mainnet (required for production — dual-chain agent identity)
    ethereumRpcUrl: process.env.ETHEREUM_RPC_URL || '',
    agentTokenIdEthereum: process.env.AGENT_TOKEN_ID_ETHEREUM || '',

    // Arc — Circle's L1, where USDC is the gas token. Entirely opt-in: with no
    // ARC_RPC_URL nothing below runs and the service behaves exactly as before.
    // The chain id is NOT defaulted. Arc's docs publish only the testnet
    // (5042002) today; public mainnet is 2026-09-16 and third-party chain
    // lists already carry a number for it that Circle has not published. A
    // guessed chain id would sign for the wrong network, so it is required
    // input when Arc is switched on.
    // GIWA Sepolia, where giwa_attestation's attester and verifier live. Opt-in
    // like Arc: with neither set, every other circuit behaves as before and a
    // GIWA request is refused with a message naming these two rather than
    // reaching Coinbase's EAS and reporting the wallet as unattested.
    giwaRpcUrl: process.env.GIWA_RPC_URL || '',
    giwaExplorerUrl: process.env.GIWA_EXPLORER_URL || '',

    // Proof verification does not opt this service into Arc identity publication.
    // Preserve undefined: a partially configured explicit pair must not fall back.
    arcVerificationRpcUrl: process.env.ARC_VERIFICATION_RPC_URL,
    arcVerificationChainId: process.env.ARC_VERIFICATION_CHAIN_ID === undefined
      ? undefined : Number(process.env.ARC_VERIFICATION_CHAIN_ID),
    arcRpcUrl: process.env.ARC_RPC_URL || '',
    arcChainId: process.env.ARC_CHAIN_ID ? Number(process.env.ARC_CHAIN_ID) : 0,
    arcIdentityAddress: process.env.ARC_IDENTITY_ADDRESS || '',
    arcAgentTokenId: process.env.ARC_AGENT_TOKEN_ID || '',

    // Chat / LLM (optional)
    openaiApiKey: process.env.OPENAI_API_KEY || '',
    geminiApiKey: process.env.GEMINI_API_KEY || '',

    // Tracing (optional)
    phoenixCollectorEndpoint: process.env.PHOENIX_COLLECTOR_ENDPOINT || '',

    // Virtuals Protocol ACP (optional)
    virtualsEnabled: process.env.VIRTUALS_ENABLED === 'true',
    virtualsWalletPk: process.env.VIRTUALS_WALLET_PK || '',
    virtualsEntityId: process.env.VIRTUALS_ENTITY_ID ? parseInt(process.env.VIRTUALS_ENTITY_ID, 10) : 0,
    virtualsAgentWallet: process.env.VIRTUALS_AGENT_WALLET || '',
  };
  if (config.arcVerificationRpcUrl !== undefined || config.arcVerificationChainId !== undefined) {
    getArcVerificationConfig(config);
  }
  return config;
}

export type Config = ReturnType<typeof loadConfig>;

/** Resolve Arc proof verification without changing ERC-8004 identity selection. */
export function getArcVerificationConfig(config: {
  arcVerificationRpcUrl?: string; arcVerificationChainId?: number;
  arcRpcUrl?: string; arcChainId?: number;
}): { rpcUrl: string; chainId: number } {
  const explicit = config.arcVerificationRpcUrl !== undefined || config.arcVerificationChainId !== undefined;
  const rpcUrl = explicit ? config.arcVerificationRpcUrl : config.arcRpcUrl;
  const chainId = explicit ? config.arcVerificationChainId : config.arcChainId;
  if (!explicit && !rpcUrl && !chainId) return { rpcUrl: '', chainId: 0 };
  if (!Number.isSafeInteger(chainId) || (chainId ?? 0) <= 0) {
    throw new Error(explicit
      ? 'ARC_VERIFICATION_RPC_URL and ARC_VERIFICATION_CHAIN_ID require a complete valid pair'
      : 'Invalid verification chain for arc_eligibility');
  }
  try {
    const url = new URL(rpcUrl ?? '');
    if (!['https:', 'http:'].includes(url.protocol) || !url.hostname) throw new Error('Invalid RPC');
  } catch {
    throw new Error(explicit
      ? 'ARC_VERIFICATION_RPC_URL must be a valid HTTP(S) URL paired with ARC_VERIFICATION_CHAIN_ID'
      : 'ARC_RPC_URL must be a valid HTTP(S) URL paired with ARC_CHAIN_ID');
  }
  return { rpcUrl: rpcUrl!, chainId: chainId! };
}

/** Chain registration config for ERC-8004 dual identity */
export interface ChainIdentity {
  chainId: number;
  chainName: string;
  agentName: string;
  rpcUrl: string;
  identityAddress: string;
  cachedTokenId: string;
}

/** Whether the environment is testnet (Base Sepolia) */
export function isTestnet(config: Config): boolean {
  return config.chainRpcUrl.includes('sepolia');
}

/**
 * Primary chain ID for verification and agent identity.
 * Production: Ethereum mainnet (1). Testnet: Ethereum Sepolia (11155111).
 */
export function getChainId(config: Config): number {
  return isTestnet(config) ? 11155111 : 1;
}

/**
 * Payment chain ID (x402/USDC).
 * Production: Base mainnet (8453). Testnet: Base Sepolia (84532).
 */
export function getPaymentChainId(config: Config): number {
  return isTestnet(config) ? 84532 : 8453;
}

export function isProductionChain(config: Config): boolean {
  return !isTestnet(config);
}

/**
 * Build chain identity configs for ERC-8004 registration.
 * Production: Ethereum mainnet (primary) + Base mainnet (both always registered).
 * Testnet: Base Sepolia only.
 */
/**
 * The Arc entry, or null when Arc is not configured.
 *
 * Arc's IdentityRegistry is deployed at the SAME address as the one this
 * service already uses on Base Sepolia — `0x8004A818BFB912233c491871b3d84c89A494BD9e`,
 * per docs.arc.io — because ERC-8004 is deployed deterministically. So Arc
 * needs no new registration code: the existing path is already driven by
 * `chain.rpcUrl` / `chain.chainId` / `chain.identityAddress`. ARC_IDENTITY_ADDRESS
 * is still read separately rather than reusing erc8004IdentityAddress, because
 * production points that at the mainnet registry and Arc must not silently
 * inherit it.
 */
function arcIdentity(config: Config): ChainIdentity | null {
  if (!config.arcRpcUrl) return null;
  if (!Number.isSafeInteger(config.arcChainId) || config.arcChainId <= 0) {
    throw new Error('ARC_RPC_URL is set but ARC_CHAIN_ID is not — refusing to guess the chain');
  }
  if (!config.arcIdentityAddress) {
    throw new Error('ARC_RPC_URL is set but ARC_IDENTITY_ADDRESS is not');
  }
  return {
    chainId: config.arcChainId,
    chainName: `Arc (${config.arcChainId})`,
    agentName: 'proveragent.arc',
    rpcUrl: config.arcRpcUrl,
    identityAddress: config.arcIdentityAddress,
    cachedTokenId: config.arcAgentTokenId,
  };
}

export function getChainIdentities(config: Config): ChainIdentity[] {
  const identityAddress = config.erc8004IdentityAddress;
  const arc = arcIdentity(config);
  if (!identityAddress) return arc ? [arc] : [];

  if (isTestnet(config)) {
    return [
      {
        chainId: 11155111,
        chainName: 'Ethereum Sepolia',
        agentName: 'proveragent.sepolia',
        rpcUrl: config.ethereumRpcUrl,
        identityAddress,
        cachedTokenId: config.agentTokenIdEthereum,
      },
      {
        chainId: 84532,
        chainName: 'Base Sepolia',
        agentName: 'proveragent.base.sepolia',
        rpcUrl: config.chainRpcUrl,
        identityAddress,
        cachedTokenId: config.agentTokenId,
      },
      ...(arc ? [arc] : []),
    ];
  }

  // Production: both Ethereum mainnet and Base mainnet
  return [
    {
      chainId: 1,
      chainName: 'Ethereum Mainnet',
      agentName: 'proveragent.eth',
      rpcUrl: config.ethereumRpcUrl,
      identityAddress,
      cachedTokenId: config.agentTokenIdEthereum,
    },
    {
      chainId: 8453,
      chainName: 'Base Mainnet',
      agentName: 'proveragent.base.eth',
      rpcUrl: config.chainRpcUrl,
      identityAddress,
      cachedTokenId: config.agentTokenId,
    },
    ...(arc ? [arc] : []),
  ];
}
