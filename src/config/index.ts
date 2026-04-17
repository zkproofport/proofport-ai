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

function validateTeeMode(value: string): 'auto' | 'disabled' | 'local' | 'nitro' {
  const valid = ['auto', 'disabled', 'local', 'nitro'] as const;
  if (!valid.includes(value as any)) {
    throw new Error(`TEE_MODE must be one of: ${valid.join(', ')} (got: ${value})`);
  }
  return value as 'auto' | 'disabled' | 'local' | 'nitro';
}

export function loadConfig() {
  const paymentMode = validatePaymentMode(getRequiredEnv('PAYMENT_MODE'));

  return {
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
    agentVersion: process.env.AGENT_VERSION || '1.0.0',

    // Payment (required when paymentMode !== 'disabled')
    paymentPayTo: process.env.PAYMENT_PAY_TO || '',
    paymentProofPrice: process.env.PAYMENT_PROOF_PRICE || '$0.10',
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
}

export type Config = ReturnType<typeof loadConfig>;

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
export function getChainIdentities(config: Config): ChainIdentity[] {
  const identityAddress = config.erc8004IdentityAddress;

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
  ];
}
