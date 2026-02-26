/**
 * Auto-registration on ERC-8004 Identity contract at server startup
 */

import { AgentRegistration, parseMetadataUri } from './register.js';
import type { Config } from '../config/index.js';
import type { AgentMetadata } from './types.js';
import type { TeeProvider } from '../tee/types.js';
import { ensureAgentValidated } from '../tee/validationSubmitter.js';
import { createLogger } from '../logger.js';

const log = createLogger('AutoRegister');

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
    log.info({ action: 'identity.not_configured' }, 'ERC-8004 not configured — identity registration disabled');
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
        log.info({ action: 'identity.registration.already_registered', tokenId: info.tokenId.toString() }, 'Agent already registered on ERC-8004 Identity contract');

        // Check if metadata needs updating (e.g., agentUrl changed from localhost to production)
        try {
          const currentMetadata = info.metadataUri ? parseMetadataUri(info.metadataUri) : null;
          const expectedName = 'proveragent.base.eth';
          const expectedImage = `${config.a2aBaseUrl}/icon.png`;
          const needsUpdate = !currentMetadata || (
            currentMetadata.name !== expectedName ||
            currentMetadata.image !== expectedImage ||
            currentMetadata.agentUrl !== config.a2aBaseUrl ||
            currentMetadata.x402Support !== (config.paymentMode !== 'disabled') ||
            !currentMetadata.services ||
            currentMetadata.services.length === 0 ||
            !currentMetadata.type ||
            !currentMetadata.supportedTrust ||
            currentMetadata.supportedTrust.length === 0
          );
          if (needsUpdate) {
              log.info({ action: 'identity.metadata.needs_update' }, 'Agent metadata needs updating on-chain');
              if (!currentMetadata) {
                log.info({ action: 'identity.metadata.not_found' }, 'No on-chain metadata found — will set full metadata');
              } else {
                if (currentMetadata.name !== expectedName) {
                  log.info({ action: 'identity.metadata.name_mismatch', onChain: currentMetadata.name, expected: expectedName }, 'Metadata name mismatch');
                }
                if (currentMetadata.image !== expectedImage) {
                  log.info({ action: 'identity.metadata.image_mismatch', onChain: currentMetadata.image || 'none', expected: expectedImage }, 'Metadata image mismatch');
                }
                if (currentMetadata.agentUrl !== config.a2aBaseUrl) {
                  log.info({ action: 'identity.metadata.url_mismatch', onChain: currentMetadata.agentUrl, current: config.a2aBaseUrl }, 'Metadata URL mismatch');
                }
                if (currentMetadata.x402Support !== (config.paymentMode !== 'disabled')) {
                  log.info({ action: 'identity.metadata.x402_mismatch', onChain: currentMetadata.x402Support, current: config.paymentMode !== 'disabled' }, 'Metadata x402Support mismatch');
                }
                if (!currentMetadata.services || currentMetadata.services.length === 0) {
                  log.info({ action: 'identity.metadata.services_missing' }, 'Metadata services array missing or empty');
                }
                if (!currentMetadata.type) {
                  log.info({ action: 'identity.metadata.type_missing' }, 'Metadata type field missing');
                }
                if (!currentMetadata.supportedTrust || currentMetadata.supportedTrust.length === 0) {
                  log.info({ action: 'identity.metadata.trust_missing' }, 'Metadata supportedTrust field missing');
                }
              }

              const metadata: AgentMetadata = {
                name: 'proveragent.base.eth',
                description: 'Autonomous ZK proof generation. ERC-8004 identity. x402 payments. Powered by ZKProofport',
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
                    agentRegistry: `eip155:84532:${config.erc8004IdentityAddress}`,
                    agentId: info.tokenId.toString(),
                  },
                ],
                supportedTrust: ['tee-attestation'],
              };

              const txHash = await registration.updateMetadata(info.tokenId, metadata);
              log.info({ action: 'identity.metadata.updated', txHash }, 'Metadata updated successfully');
            }
          } catch (error) {
            if (error instanceof Error) {
              log.error({ action: 'identity.metadata.update_failed', err: error }, 'Failed to update metadata');
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
      name: 'proveragent.base.eth',
      description: 'Autonomous ZK proof generation. ERC-8004 identity. x402 payments. Powered by ZKProofport',
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
      supportedTrust: ['tee-attestation'],
    };

    // Register on-chain
    log.info({ action: 'identity.registration.started' }, 'Registering agent on ERC-8004 Identity contract');
    const result = await registration.register(metadata);

    log.info(
      { action: 'identity.registration.completed', tokenId: result.tokenId.toString(), agentAddress: result.agentAddress, transactionHash: result.transactionHash },
      'Agent registered successfully',
    );

    // Submit TEE validation if configured
    if (teeProvider && teeProvider.mode !== 'disabled') {
      await ensureAgentValidated(config, result.tokenId, teeProvider);
    }

    return result.tokenId;
  } catch (error) {
    log.error({ action: 'identity.registration.failed', err: error instanceof Error ? error : new Error(String(error)) }, 'Failed to register agent on ERC-8004');
    return null;
  }
}
