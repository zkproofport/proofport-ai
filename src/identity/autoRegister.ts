/**
 * Auto-registration on ERC-8004 Identity contract at server startup
 */

import { AgentRegistration, createMetadataUri, parseMetadataUri } from './register.js';
import type { Config } from '../config/index.js';
import type { AgentMetadata } from './types.js';
import type { TeeProvider } from '../tee/types.js';
import { ensureAgentValidated } from '../tee/validationSubmitter.js';

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
export async function ensureAgentRegistered(config: Config, teeProvider?: TeeProvider): Promise<bigint | null> {
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

        // Check if metadata needs updating (e.g., agentUrl changed from localhost to production)
        if (info.metadataUri) {
          try {
            const currentMetadata = parseMetadataUri(info.metadataUri);
            const needsUpdate = currentMetadata && (
              currentMetadata.agentUrl !== config.a2aBaseUrl ||
              currentMetadata.x402Support !== (config.paymentMode !== 'disabled') ||
              !currentMetadata.services ||
              currentMetadata.services.length === 0 ||
              !currentMetadata.type ||
              !currentMetadata.supportedTrusts ||
              currentMetadata.supportedTrusts.length === 0
            );
            if (needsUpdate) {
              console.log('Agent metadata needs updating on-chain...');
              if (currentMetadata.agentUrl !== config.a2aBaseUrl) {
                console.log(`  URL mismatch: on-chain="${currentMetadata.agentUrl}", current="${config.a2aBaseUrl}"`);
              }
              if (currentMetadata.x402Support !== (config.paymentMode !== 'disabled')) {
                console.log(`  x402Support mismatch: on-chain=${currentMetadata.x402Support}, current=${config.paymentMode !== 'disabled'}`);
              }
              if (!currentMetadata.services || currentMetadata.services.length === 0) {
                console.log('  services array missing or empty');
              }
              if (!currentMetadata.type) {
                console.log('  type field missing');
              }
              if (!currentMetadata.supportedTrusts || currentMetadata.supportedTrusts.length === 0) {
                console.log('  supportedTrusts field missing');
              }

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
                ...(config.teeMode !== 'disabled' && { tee: config.teeMode }),
                x402Support: config.paymentMode !== 'disabled',
                type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
                image: `${config.a2aBaseUrl}/icon.png`,
                services: [
                  { name: 'web', endpoint: config.websiteUrl },
                  { name: 'MCP', endpoint: `${config.a2aBaseUrl}/mcp`, version: '2025-11-25' },
                  { name: 'A2A', endpoint: `${config.a2aBaseUrl}/.well-known/agent-card.json`, version: '0.3.0' },
                ],
                registrations: [
                  {
                    chainId: 'eip155:84532',
                    tokenId: info.tokenId.toString(),
                    txHash: '',
                    contract: config.erc8004IdentityAddress,
                  },
                ],
                supportedTrusts: ['tee-attestation'],
              };

              const txHash = await registration.updateMetadata(info.tokenId, metadata);
              console.log(`Metadata updated successfully (tx: ${txHash})`);
            }
          } catch (error) {
            if (error instanceof Error) {
              console.error(`Failed to update metadata: ${error.message}`);
            }
          }
        }

        // Submit TEE validation if configured
        if (teeProvider && teeProvider.mode !== 'disabled') {
          await ensureAgentValidated(config, info.tokenId, teeProvider);
        }

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
      ...(config.teeMode !== 'disabled' && { tee: config.teeMode }),
      x402Support: config.paymentMode !== 'disabled',
      type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
      image: `${config.a2aBaseUrl}/icon.png`,
      services: [
        { name: 'web', endpoint: config.websiteUrl },
        { name: 'MCP', endpoint: `${config.a2aBaseUrl}/mcp`, version: '2025-11-25' },
        { name: 'A2A', endpoint: `${config.a2aBaseUrl}/.well-known/agent-card.json`, version: '0.3.0' },
      ],
      registrations: [],
      supportedTrusts: ['tee-attestation'],
    };

    // Register on-chain
    console.log('Registering agent on ERC-8004 Identity contract...');
    const result = await registration.register(metadata);

    console.log(`Agent registered successfully`);
    console.log(`  Token ID: ${result.tokenId}`);
    console.log(`  Agent Address: ${result.agentAddress}`);
    console.log(`  Transaction Hash: ${result.transactionHash}`);

    // Submit TEE validation if configured
    if (teeProvider && teeProvider.mode !== 'disabled') {
      await ensureAgentValidated(config, result.tokenId, teeProvider);
    }

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
