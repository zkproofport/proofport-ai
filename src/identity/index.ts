/**
 * Identity module entry point
 * Provides agent registration and reputation management via ERC-8004
 */

export { AgentRegistration, createMetadataUri } from './register.js';
export { AgentReputation } from './reputation.js';
export type {
  AgentMetadata,
  AgentRegistrationConfig,
  AgentRegistrationResult,
  AgentIdentityInfo,
  AgentReputationConfig,
  ReputationDetails,
} from './types.js';
