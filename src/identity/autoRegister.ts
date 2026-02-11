/**
 * Auto-registration on ERC-8004 Identity contract at server startup
 */

import { AgentRegistration, createMetadataUri } from './register.js';
import type { Config } from '../config/index.js';
import type { AgentMetadata } from './types.js';

/**
 * Ensure agent is registered on ERC-8004 Identity contract
 *
 * This function is called during server startup after circuit artifacts are ready.
 * It performs the following:
 * 1. Checks if ERC-8004 is configured (both addresses present)
 * 2. Checks if agent is already registered
 * 3. If not registered, registers the agent with metadata
 * 4. Returns tokenId if registered (null if feature disabled or registration failed)
 *
 * IMPORTANT: Does NOT crash the server if registration fails — logs error and returns null
 */
export async function ensureAgentRegistered(config: Config): Promise<bigint | null> {
  // Check if ERC-8004 is configured (both addresses required)
  if (!config.erc8004IdentityAddress || !config.erc8004ReputationAddress) {
    console.log('ERC-8004 not configured — identity registration disabled');
    return null;
  }

  try {
    const registration = new AgentRegistration({
      identityContractAddress: config.erc8004IdentityAddress,
      reputationContractAddress: config.erc8004ReputationAddress,
      chainRpcUrl: config.chainRpcUrl,
      privateKey: config.proverPrivateKey,
    });

    // Check if already registered
    const isRegistered = await registration.isRegistered();

    if (isRegistered) {
      const info = await registration.getRegistration();
      if (info) {
        console.log(`Agent already registered on ERC-8004 Identity contract (tokenId: ${info.tokenId})`);
        return info.tokenId;
      }
    }

    // Build metadata
    const metadata: AgentMetadata = {
      name: 'ZKProofport Prover Agent',
      description: 'Zero-knowledge proof generation and verification for Coinbase attestations',
      agentUrl: config.a2aBaseUrl,
      capabilities: [
        'proof_generation',
        'proof_verification',
        'coinbase_kyc',
        'coinbase_country',
        'streaming',
        'x402_payment',
      ],
      protocols: ['mcp', 'a2a', 'x402'],
      circuits: ['coinbase_attestation', 'coinbase_country_attestation'],
    };

    // Register on-chain
    console.log('Registering agent on ERC-8004 Identity contract...');
    const result = await registration.register(metadata);

    console.log(`Agent registered successfully`);
    console.log(`  Token ID: ${result.tokenId}`);
    console.log(`  Agent Address: ${result.agentAddress}`);
    console.log(`  Transaction Hash: ${result.transactionHash}`);

    return result.tokenId;
  } catch (error) {
    if (error instanceof Error) {
      console.error(`Failed to register agent on ERC-8004: ${error.message}`);
    } else {
      console.error('Failed to register agent on ERC-8004: unknown error');
    }
    return null;
  }
}
