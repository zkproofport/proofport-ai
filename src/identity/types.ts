/**
 * Agent metadata for ERC-8004 registration
 */
export interface AgentMetadata {
  name: string;
  description: string;
  agentUrl: string;
  capabilities: string[];
  protocols: string[];
  circuits: string[];
  tee?: string;
  x402Support?: boolean;
  tags?: string[];
  categories?: string[];
  services?: Array<{ name: string; endpoint: string; version?: string; tools?: string[]; mcpTools?: string[]; skills?: string[]; a2aSkills?: string[]; domains?: string[] }>;
  type?: string;
  image?: string;
  registrations?: Array<{ agentRegistry: string; agentId: string; chainId?: string; tokenId?: string; txHash?: string; contract?: string }>;
  supportedTrust?: string[];
  active?: boolean;
}

/**
 * Configuration for agent registration
 */
export interface AgentRegistrationConfig {
  identityContractAddress: string;
  reputationContractAddress: string;
  chainRpcUrl: string;
  privateKey: string;
}

/**
 * Result of agent registration
 */
export interface AgentRegistrationResult {
  tokenId: bigint;
  transactionHash: string;
  agentAddress: string;
}

/**
 * Agent identity information
 */
export interface AgentIdentityInfo {
  tokenId: bigint;
  owner: string;
  metadataUri: string;
  isRegistered: boolean;
}

/**
 * Configuration for agent reputation
 */
export interface AgentReputationConfig {
  reputationContractAddress: string;
  chainRpcUrl: string;
  privateKey?: string; // Optional — only needed for write operations
}

/**
 * Reputation score from ERC-8004
 */
export interface ReputationScore {
  score: number;
  decimals: number;
}
