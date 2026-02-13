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
    nargoPath: process.env.NARGO_PATH || 'nargo',
    circuitsDir: process.env.CIRCUITS_DIR || '/app/circuits',
    circuitsRepoUrl: process.env.CIRCUITS_REPO_URL || 'https://raw.githubusercontent.com/zkproofport/circuits/main',
    redisUrl: getRequiredEnv('REDIS_URL'),
    baseRpcUrl: getRequiredEnv('BASE_RPC_URL'),
    easGraphqlEndpoint: getRequiredEnv('EAS_GRAPHQL_ENDPOINT'),
    chainRpcUrl: getRequiredEnv('CHAIN_RPC_URL'),
    nullifierRegistryAddress: getRequiredEnv('NULLIFIER_REGISTRY_ADDRESS'),
    proverPrivateKey: getRequiredEnv('PROVER_PRIVATE_KEY'),
    paymentMode,
    a2aBaseUrl: getRequiredEnv('A2A_BASE_URL'),
    agentVersion: process.env.AGENT_VERSION || '1.0.0',

    // x402 Payment (required when paymentMode !== 'disabled')
    paymentPayTo: process.env.PAYMENT_PAY_TO || '',
    paymentFacilitatorUrl: process.env.PAYMENT_FACILITATOR_URL || 'https://www.x402.org/facilitator',
    paymentProofPrice: process.env.PAYMENT_PROOF_PRICE || '$0.10',

    // Signing providers (optional, enable per method)
    privyAppId: process.env.PRIVY_APP_ID || '',
    privyApiSecret: process.env.PRIVY_API_SECRET || '',
    privyApiUrl: process.env.PRIVY_API_URL || 'https://auth.privy.io',
    signPageUrl: process.env.SIGN_PAGE_URL || '',
    signingTtlSeconds: parseInt(process.env.SIGNING_TTL_SECONDS || '300', 10),

    // TEE (optional)
    teeMode: validateTeeMode(process.env.TEE_MODE || 'disabled'),
    enclaveCid: process.env.ENCLAVE_CID ? parseInt(process.env.ENCLAVE_CID, 10) : undefined,
    enclavePort: process.env.ENCLAVE_PORT ? parseInt(process.env.ENCLAVE_PORT, 10) : 5000,
    teeAttestationEnabled: process.env.TEE_ATTESTATION === 'true',

    // ERC-8004 Identity (optional - only needed for on-chain registration)
    erc8004IdentityAddress: process.env.ERC8004_IDENTITY_ADDRESS || '',
    erc8004ReputationAddress: process.env.ERC8004_REPUTATION_ADDRESS || '',
    erc8004ValidationAddress: process.env.ERC8004_VALIDATION_ADDRESS || '',

    // Settlement worker (optional - only needed when paymentMode !== 'disabled' and auto-settlement desired)
    settlementChainRpcUrl: process.env.SETTLEMENT_CHAIN_RPC_URL || '',
    settlementPrivateKey: process.env.SETTLEMENT_PRIVATE_KEY || '',
    settlementOperatorAddress: process.env.SETTLEMENT_OPERATOR_ADDRESS || '',
    settlementUsdcAddress: process.env.SETTLEMENT_USDC_ADDRESS || '',
  };
}

export type Config = ReturnType<typeof loadConfig>;
