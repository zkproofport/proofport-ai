function getRequiredEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`${key} environment variable is required`);
  }
  return value;
}

export function loadConfig() {
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
    paymentMode: getRequiredEnv('PAYMENT_MODE') as 'disabled' | 'testnet' | 'mainnet',
  };
}

export type Config = ReturnType<typeof loadConfig>;
