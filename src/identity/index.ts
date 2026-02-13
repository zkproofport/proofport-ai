/**
 * Identity module entry point
 * Provides agent registration and reputation management via ERC-8004
 */

export { AgentRegistration, createMetadataUri, parseMetadataUri } from './register.js';
export { AgentReputation, handleProofCompleted } from './reputation.js';
export type {
  AgentMetadata,
  AgentRegistrationConfig,
  AgentRegistrationResult,
  AgentIdentityInfo,
  AgentReputationConfig,
  ReputationScore,
} from './types.js';
