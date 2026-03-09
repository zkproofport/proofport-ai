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

/** Wrap a promise with a timeout (rejects with TimeoutError after ms) */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout after ${ms}ms: ${label}`)), ms),
    ),
  ]);
}

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
    log.info({ action: 'identity.step.creating_registration' }, 'Creating AgentRegistration instance');
    const registration = new AgentRegistration({
      identityContractAddress: config.erc8004IdentityAddress,
      reputationContractAddress: config.erc8004ReputationAddress,
      chainRpcUrl: config.chainRpcUrl,
      privateKey: config.proverPrivateKey,
    });

    // Check if already registered
    log.info({ action: 'identity.step.checking_registered' }, 'Checking if agent is already registered (RPC call)');
    const isRegistered = await withTimeout(registration.isRegistered(), 30000, 'isRegistered');
    log.info({ action: 'identity.step.checked_registered', isRegistered }, 'isRegistered check complete');

    if (isRegistered) {
      // Use known tokenId from env var to skip slow RPC token scan (25K+ tokens on mainnet)
      let info: Awaited<ReturnType<typeof registration.getRegistration>>;
      if (config.agentTokenId) {
        const knownTokenId = BigInt(config.agentTokenId);
        log.info({ action: 'identity.step.using_known_token', tokenId: knownTokenId.toString() }, 'Using AGENT_TOKEN_ID from env');
        const metadataUri = await withTimeout(registration.getTokenMetadata(knownTokenId), 30000, 'getTokenMetadata');
        info = { tokenId: knownTokenId, owner: registration.agentAddress, metadataUri, isRegistered: true };
      } else {
        log.info({ action: 'identity.step.getting_registration' }, 'Getting registration info (RPC call)');
        info = await withTimeout(registration.getRegistration(), 120000, 'getRegistration');
      }
      log.info({ action: 'identity.step.got_registration', hasInfo: !!info, tokenId: info?.tokenId?.toString() }, 'getRegistration complete');

      if (info) {
        log.info({ action: 'identity.registration.already_registered', tokenId: info.tokenId.toString() }, 'Agent already registered on ERC-8004 Identity contract');

        // Check if metadata needs updating (e.g., agentUrl changed from localhost to production)
        try {
          const currentMetadata = info.metadataUri ? parseMetadataUri(info.metadataUri) : null;
          const expectedName = 'proveragent.base.eth';
          const expectedImage = `${config.a2aBaseUrl}/icon.png`;
          const onchainActive = await withTimeout(registration.getOnchainMetadata(info.tokenId, 'active'), 30000, 'getOnchainActive');
          const offchainNeedsUpdate = !currentMetadata || (
            currentMetadata.name !== expectedName ||
            currentMetadata.image !== expectedImage ||
            currentMetadata.agentUrl !== config.a2aBaseUrl ||
            currentMetadata.x402Support !== (config.paymentMode !== 'disabled') ||
            !currentMetadata.services ||
            currentMetadata.services.length === 0 ||
            !currentMetadata.type ||
            !currentMetadata.supportedTrust ||
            currentMetadata.supportedTrust.length === 0 ||
            !currentMetadata.tags ||
            currentMetadata.tags.length === 0 ||
            !currentMetadata.categories ||
            currentMetadata.categories.length === 0 ||
            !currentMetadata.registrations ||
            currentMetadata.registrations.length === 0 ||
            !currentMetadata.active
          );
          const activeNeedsUpdate = onchainActive !== 'true';
          const needsUpdate = offchainNeedsUpdate || activeNeedsUpdate;
          if (needsUpdate) {
              log.info({ action: 'identity.metadata.needs_update' }, 'Agent metadata needs updating on-chain');

              if (offchainNeedsUpdate) {
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
                if (!currentMetadata.registrations || currentMetadata.registrations.length === 0) {
                  log.info({ action: 'identity.metadata.registrations_empty' }, 'Metadata registrations array missing or empty');
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
                tags: ['ZK', 'Privacy', 'Proof', 'Coinbase', 'KYC', 'Attestation', 'x402', 'Identity', 'Country', 'Verification', 'Base', 'USDC', 'TEE', 'Noir', 'EAS', 'Zero-Knowledge'],
                categories: ['privacy', 'security', 'verification', 'identity'],
                ...(config.teeMode !== 'disabled' && { tee: config.teeMode }),
                x402Support: config.paymentMode !== 'disabled',
                type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
                image: `${config.a2aBaseUrl}/icon.png`,
                services: [
                  { name: 'web', endpoint: config.websiteUrl },
                  { name: 'MCP', endpoint: `${config.a2aBaseUrl}/mcp`, version: '2025-11-25', tools: ['prove', 'get_supported_circuits', 'get_guide'] },
                  { name: 'A2A', endpoint: `${config.a2aBaseUrl}/.well-known/agent-card.json`, version: '0.3.0', skills: ['prove', 'get_supported_circuits', 'get_guide'] },
                ],
                registrations: [
                  {
                    agentRegistry: `eip155:${config.paymentMode === 'mainnet' ? '8453' : '84532'}:${config.erc8004IdentityAddress}`,
                    agentId: info.tokenId.toString(),
                  },
                ],
                supportedTrust: ['tee-attestation'],
                active: true,
              };

              log.info({ action: 'identity.step.updating_metadata' }, 'Updating metadata on-chain (TX)');
              const txHash = await withTimeout(registration.updateMetadata(info.tokenId, metadata), 120000, 'updateMetadata');
              log.info({ action: 'identity.metadata.updated', txHash }, 'Metadata updated successfully');
              }

              if (activeNeedsUpdate) {
                log.info({ action: 'identity.metadata.active_mismatch', onchain: JSON.stringify(onchainActive) }, 'On-chain active flag is not "true" — updating');
                const activeTxHash = await withTimeout(registration.setOnchainMetadata(info.tokenId, 'active', 'true'), 60000, 'setOnchainActive');
                log.info({ action: 'identity.metadata.active_set', txHash: activeTxHash }, 'On-chain active flag set to true');
              }
            }
          } catch (error) {
            if (error instanceof Error) {
              log.error({ action: 'identity.metadata.update_failed', err: error }, 'Failed to update metadata');
            }
          }

        // Submit TEE validation if configured
        if (teeProvider && teeProvider.mode !== 'disabled') {
          log.info({ action: 'identity.step.tee_validation' }, 'Starting TEE validation');
          try {
            await withTimeout(ensureAgentValidated(config, info.tokenId, teeProvider), 60000, 'ensureAgentValidated');
            log.info({ action: 'identity.step.tee_validation_done' }, 'TEE validation complete');
          } catch (err) {
            log.error({ action: 'tee.validation.startup_failed', err: err instanceof Error ? err : new Error(String(err)) }, 'TEE validation failed (timeout or error)');
          }
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
      tags: ['ZK', 'Privacy', 'Proof', 'Coinbase', 'KYC', 'Attestation', 'x402', 'Identity', 'Country', 'Verification', 'Base', 'USDC', 'TEE', 'Noir', 'EAS', 'Zero-Knowledge'],
      categories: ['privacy', 'security', 'verification', 'identity'],
      ...(config.teeMode !== 'disabled' && { tee: config.teeMode }),
      x402Support: config.paymentMode !== 'disabled',
      type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
      image: `${config.a2aBaseUrl}/icon.png`,
      services: [
        { name: 'web', endpoint: config.websiteUrl },
        { name: 'MCP', endpoint: `${config.a2aBaseUrl}/mcp`, version: '2025-11-25', tools: ['prove', 'get_supported_circuits', 'get_guide'] },
        { name: 'A2A', endpoint: `${config.a2aBaseUrl}/.well-known/agent-card.json`, version: '0.3.0', skills: ['prove', 'get_supported_circuits', 'get_guide'] },
      ],
      registrations: [],
      supportedTrust: ['tee-attestation'],
      active: true,
    };

    // Register on-chain
    log.info({ action: 'identity.registration.started' }, 'Registering agent on ERC-8004 Identity contract');
    const result = await withTimeout(registration.register(metadata), 120000, 'register');

    log.info(
      { action: 'identity.registration.completed', tokenId: result.tokenId.toString(), agentAddress: result.agentAddress, transactionHash: result.transactionHash },
      'Agent registered successfully',
    );

    // Set on-chain active flag after fresh registration
    try {
      const activeTxHash = await withTimeout(registration.setOnchainMetadata(result.tokenId, 'active', 'true'), 60000, 'setOnchainActive');
      log.info({ action: 'identity.metadata.active_set', txHash: activeTxHash }, 'On-chain active flag set to true');
    } catch (err) {
      log.warn({ action: 'identity.metadata.active_failed', err: err instanceof Error ? err : new Error(String(err)) }, 'Failed to set on-chain active flag (non-fatal)');
    }

    // Submit TEE validation if configured
    if (teeProvider && teeProvider.mode !== 'disabled') {
      log.info({ action: 'identity.step.tee_validation' }, 'Starting TEE validation');
      try {
        await withTimeout(ensureAgentValidated(config, result.tokenId, teeProvider), 60000, 'ensureAgentValidated');
        log.info({ action: 'identity.step.tee_validation_done' }, 'TEE validation complete');
      } catch (err) {
        log.error({ action: 'tee.validation.startup_failed', err: err instanceof Error ? err : new Error(String(err)) }, 'TEE validation failed (timeout or error)');
      }
    }

    return result.tokenId;
  } catch (error) {
    log.error({ action: 'identity.registration.failed', err: error instanceof Error ? error : new Error(String(error)) }, 'Failed to register agent on ERC-8004');
    return null;
  }
}
