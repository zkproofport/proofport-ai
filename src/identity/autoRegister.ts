/**
 * Auto-registration on ERC-8004 Identity contract at server startup.
 * Supports dual-chain registration (Base + Ethereum mainnet).
 */

import { AgentRegistration, parseMetadataUri } from './register.js';
import type { Config, ChainIdentity } from '../config/index.js';
import { getChainIdentities } from '../config/index.js';
import type { AgentMetadata } from './types.js';
import type { TeeProvider } from '../tee/types.js';
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

/** Build agent metadata for a specific chain */
function buildAgentMetadata(
  config: Config,
  chain: ChainIdentity,
  agentAddress: string,
  tokenId?: bigint,
): AgentMetadata {
  return {
    name: chain.agentName,
    description: 'Autonomous ZK proof generation. ERC-8004 identity. x402 payments. Powered by ZKProofport',
    agentType: 'service',
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
    ...(config.teeMode !== 'disabled' && { tee: config.teeMode }),
    x402Support: true,
    type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
    image: `${config.a2aBaseUrl}/icon.png`,
    protocolVersions: ['0.3'],
    securitySchemes: {
      x402: { type: 'apiKey', in: 'header', name: 'X-402-Payment' },
    },
    security: [{ x402: [] }],
    services: [
      { name: 'web', endpoint: config.a2aBaseUrl },
      { name: 'MCP', endpoint: `${config.a2aBaseUrl}/mcp`, version: '2025-11-25', mcpTools: ['prove', 'get_supported_circuits', 'get_guide'] },
      { name: 'A2A', endpoint: `${config.a2aBaseUrl}/.well-known/agent-card.json`, version: '0.3.0', a2aSkills: ['prove', 'get_supported_circuits', 'get_guide'] },
      { name: 'OASF', endpoint: `${config.a2aBaseUrl}`, version: 'v0.8.0', skills: ['security_privacy/privacy_risk_assessment', 'security_privacy/threat_detection'], domains: ['technology/blockchain', 'technology/security', 'trust_and_safety/data_privacy'] },
      { name: 'ENS', endpoint: chain.agentName },
      { name: 'DID', endpoint: `did:web:${new URL(config.a2aBaseUrl).hostname}` },
      { name: 'agentWallet', endpoint: `eip155:${chain.chainId}:${agentAddress}` },
    ],
    categories: ['privacy', 'security', 'verification', 'identity'],
    domains: [
      { name: 'technology/blockchain', id: 109 },
      { name: 'technology/security', id: 107 },
      { name: 'trust_and_safety/data_privacy', id: 404 },
    ],
    skills: [
      { name: 'security_privacy/privacy_risk_assessment', id: 804 },
      { name: 'security_privacy/threat_detection', id: 801 },
    ],
    registrations: tokenId !== undefined ? [
      {
        agentRegistry: `eip155:${chain.chainId}:${chain.identityAddress}`,
        agentId: Number(tokenId),
      },
    ] : [],
    supportedTrust: ['tee-attestation'],
    active: true,
  };
}

/** Check if on-chain metadata needs updating */
function needsMetadataUpdate(currentMetadata: any, config: Config, chain: ChainIdentity): boolean {
  if (!currentMetadata) return true;

  return (
    currentMetadata.name !== chain.agentName ||
    currentMetadata.image !== `${config.a2aBaseUrl}/icon.png` ||
    currentMetadata.agentUrl !== config.a2aBaseUrl ||
    currentMetadata.x402Support !== true ||
    !currentMetadata.services || currentMetadata.services.length === 0 ||
    !currentMetadata.type ||
    !currentMetadata.supportedTrust || currentMetadata.supportedTrust.length === 0 ||
    !currentMetadata.tags || currentMetadata.tags.length === 0 ||
    !currentMetadata.categories || currentMetadata.categories.length === 0 ||
    !currentMetadata.domains || currentMetadata.domains.length === 0 ||
    !currentMetadata.domains?.some((d: any) => typeof d === 'object' && d.id) ||
    !currentMetadata.skills || currentMetadata.skills.length === 0 ||
    !currentMetadata.skills?.some((s: any) => typeof s === 'object' && s.id) ||
    !currentMetadata.registrations || currentMetadata.registrations.length === 0 ||
    !currentMetadata.agentType ||
    !currentMetadata.active ||
    (currentMetadata.services && currentMetadata.services.some(
      (s: { name: string; endpoint: string }) => s.name === 'A2A' && !s.endpoint.includes('.well-known/agent-card.json')
    )) ||
    (currentMetadata.registrations && currentMetadata.registrations.length > 0 &&
      typeof currentMetadata.registrations[0].agentId === 'string'
    ) ||
    (currentMetadata.services && currentMetadata.services.some(
      (s: { name: string; endpoint: string }) => s.name === 'web' && s.endpoint !== config.a2aBaseUrl
    )) ||
    (currentMetadata.services && currentMetadata.services.some(
      (s: { name: string; endpoint: string }) => s.name === 'OASF' && s.endpoint !== config.a2aBaseUrl
    )) ||
    (currentMetadata.services && !currentMetadata.services.some(
      (s: { name: string }) => s.name === 'OASF'
    )) ||
    (currentMetadata.services && currentMetadata.services.some(
      (s: { name: string; tools?: string[]; mcpTools?: string[] }) => s.name === 'MCP' && s.tools && !s.mcpTools
    )) ||
    (currentMetadata.services && currentMetadata.services.some(
      (s: { name: string; endpoint: string }) => s.name === 'MCP' && s.endpoint.includes('.well-known/mcp.json')
    )) ||
    !currentMetadata.securitySchemes ||
    !currentMetadata.protocolVersions
  );
}

/**
 * Register or update agent on a single chain's ERC-8004 Identity contract.
 * Returns tokenId if registered, null if failed.
 */
async function registerOnChain(
  config: Config,
  chain: ChainIdentity,
): Promise<bigint | null> {
  const chainLabel = `${chain.chainName} (${chain.chainId})`;

  try {
    log.info({ action: 'identity.chain.start', chain: chainLabel }, `Starting registration on ${chainLabel}`);

    const registration = new AgentRegistration({
      identityContractAddress: chain.identityAddress,
      reputationContractAddress: config.erc8004ReputationAddress,
      chainRpcUrl: chain.rpcUrl,
      privateKey: config.proverPrivateKey,
    });

    const isRegistered = await withTimeout(registration.isRegistered(), 30000, `isRegistered:${chain.chainId}`);
    log.info({ action: 'identity.chain.checked', chain: chainLabel, isRegistered }, `isRegistered on ${chainLabel}`);

    if (isRegistered) {
      let info: Awaited<ReturnType<typeof registration.getRegistration>>;
      if (chain.cachedTokenId) {
        const knownTokenId = BigInt(chain.cachedTokenId);
        log.info({ action: 'identity.chain.using_cached', chain: chainLabel, tokenId: knownTokenId.toString() }, `Using cached tokenId on ${chainLabel}`);
        const metadataUri = await withTimeout(registration.getTokenMetadata(knownTokenId), 30000, `getTokenMetadata:${chain.chainId}`);
        info = { tokenId: knownTokenId, owner: registration.agentAddress, metadataUri, isRegistered: true };
      } else {
        log.info({ action: 'identity.chain.scanning', chain: chainLabel }, `Scanning for tokenId on ${chainLabel}`);
        info = await withTimeout(registration.getRegistration(), 120000, `getRegistration:${chain.chainId}`);
      }

      if (info) {
        log.info({ action: 'identity.chain.found', chain: chainLabel, tokenId: info.tokenId.toString() }, `Found existing registration on ${chainLabel}`);

        // Check and update metadata if needed
        try {
          const currentMetadata = info.metadataUri ? parseMetadataUri(info.metadataUri) : null;
          const onchainActive = await withTimeout(registration.getOnchainMetadata(info.tokenId, 'active'), 30000, `getOnchainActive:${chain.chainId}`);
          const offchainNeedsUpdate = needsMetadataUpdate(currentMetadata, config, chain);
          const activeNeedsUpdate = onchainActive !== 'true';

          if (offchainNeedsUpdate) {
            log.info({ action: 'identity.chain.updating_metadata', chain: chainLabel }, `Updating metadata on ${chainLabel}`);
            const metadata = buildAgentMetadata(config, chain, registration.agentAddress, info.tokenId);
            const txHash = await withTimeout(registration.updateMetadata(info.tokenId, metadata), 120000, `updateMetadata:${chain.chainId}`);
            log.info({ action: 'identity.chain.metadata_updated', chain: chainLabel, txHash }, `Metadata updated on ${chainLabel}`);

            // Verify tokenURI was updated
            try {
              const verifyUri = await withTimeout(registration.getTokenMetadata(info.tokenId), 30000, `verifyTokenURI:${chain.chainId}`);
              const verifyMeta = verifyUri ? parseMetadataUri(verifyUri) : null;
              const verifyOasf = verifyMeta?.services?.find((s: any) => s.name === 'OASF')?.endpoint;
              if (verifyOasf !== config.a2aBaseUrl) {
                log.warn({ action: 'identity.chain.uri_mismatch', chain: chainLabel, oasfAfterUpdate: verifyOasf, expected: config.a2aBaseUrl }, 'setAgentURI TX succeeded but tokenURI not updated');
              }
            } catch {
              // Non-critical verification
            }
          }

          if (activeNeedsUpdate) {
            log.info({ action: 'identity.chain.setting_active', chain: chainLabel }, `Setting active flag on ${chainLabel}`);
            const activeTxHash = await withTimeout(registration.setOnchainMetadata(info.tokenId, 'active', 'true'), 60000, `setOnchainActive:${chain.chainId}`);
            log.info({ action: 'identity.chain.active_set', chain: chainLabel, txHash: activeTxHash }, `Active flag set on ${chainLabel}`);
          }
        } catch (error) {
          log.error({ action: 'identity.chain.update_failed', chain: chainLabel, err: error instanceof Error ? error : new Error(String(error)) }, `Metadata update failed on ${chainLabel}`);
        }

        return info.tokenId;
      }
    }

    // New registration
    log.info({ action: 'identity.chain.registering', chain: chainLabel }, `Registering new agent on ${chainLabel}`);
    const metadata = buildAgentMetadata(config, chain, registration.agentAddress);
    const result = await withTimeout(registration.register(metadata), 120000, `register:${chain.chainId}`);
    log.info({ action: 'identity.chain.registered', chain: chainLabel, tokenId: result.tokenId.toString(), txHash: result.transactionHash }, `Agent registered on ${chainLabel}`);

    // Set active flag
    try {
      const activeTxHash = await withTimeout(registration.setOnchainMetadata(result.tokenId, 'active', 'true'), 60000, `setOnchainActive:${chain.chainId}`);
      log.info({ action: 'identity.chain.active_set', chain: chainLabel, txHash: activeTxHash }, `Active flag set on ${chainLabel}`);
    } catch (err) {
      log.warn({ action: 'identity.chain.active_failed', chain: chainLabel, err: err instanceof Error ? err : new Error(String(err)) }, 'Failed to set active flag (non-fatal)');
    }

    return result.tokenId;
  } catch (error) {
    log.error({ action: 'identity.chain.failed', chain: chainLabel, err: error instanceof Error ? error : new Error(String(error)) }, `Registration failed on ${chainLabel}`);
    return null;
  }
}

/**
 * Ensure agent is registered on all configured ERC-8004 Identity contracts.
 *
 * Registers on Base (primary chain) and optionally on Ethereum mainnet
 * if ETHEREUM_RPC_URL is configured. Each chain gets its own agent identity
 * with chain-specific metadata.
 *
 * Returns a Map of chainId -> tokenId for all successful registrations.
 * Does NOT crash the server if any registration fails.
 */
export async function ensureAgentRegistered(config: Config, teeProvider?: TeeProvider): Promise<Map<number, bigint>> {
  const results = new Map<number, bigint>();

  if (!config.erc8004IdentityAddress || !config.erc8004ReputationAddress) {
    log.info({ action: 'identity.not_configured' }, 'ERC-8004 not configured — identity registration disabled');
    return results;
  }

  const chains = getChainIdentities(config);
  log.info({ action: 'identity.chains', count: chains.length, chains: chains.map(c => `${c.agentName}@${c.chainId}`) }, `Registering on ${chains.length} chain(s)`);

  for (const chain of chains) {
    const tokenId = await registerOnChain(config, chain);
    if (tokenId !== null) {
      results.set(chain.chainId, tokenId);
    }
  }

  log.info({ action: 'identity.complete', registered: results.size, chains: [...results.entries()].map(([c, t]) => `${c}:${t}`) }, 'Registration complete');
  return results;
}
