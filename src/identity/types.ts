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
  privateKey: string;
}

/**
 * Agent reputation details
 */
export interface ReputationDetails {
  score: number;
  totalTasks: number;
  successfulTasks: number;
  lastUpdated: number;
}
