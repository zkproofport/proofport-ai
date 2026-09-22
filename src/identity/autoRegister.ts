/**
 * Auto-registration on ERC-8004 Identity contract at server startup.
 * Verifies every configured Base, Ethereum and Arc identity.
 */

import { withRegistrationLock } from './registrationLock.js';
import { ethers } from 'ethers';
import { AgentRegistration, parseMetadataUri } from './register.js';
import type { Config, ChainIdentity } from '../config/index.js';
import { getChainIdentities } from '../config/index.js';
import type { AgentMetadata } from './types.js';
import type { TeeProvider } from '../tee/types.js';
import { createLogger } from '../logger.js';
import { PROVABLE_CIRCUIT_IDS, CIRCUIT_IDS } from '../config/circuitIds.js';
import { didWebHost } from '../a2a/agentCard.js';

const log = createLogger('AutoRegister');

/** Wrap a promise with a timeout (rejects with TimeoutError after ms) */
async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timeout after ${ms}ms: ${label}`)), ms);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

/** Bounded read-only retries for RPC replicas catching up to a mined write. */
async function withReadbackRetry<T>(chainId: number, read: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await read(); } catch (error) {
      if (attempt === 2) throw error;
      log.warn({ action: 'identity.readback.retry', chainId, attempt: attempt + 1, err: error }, 'Waiting for confirmed identity state to become readable');
      await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
    }
  }
}

/** TX timeout: Ethereum mainnet needs longer due to higher gas and slower inclusion */
function txTimeout(chainId: number): number {
  return chainId === 8453 || chainId === 84532 ? 120000 : 300000;
}

/** Build agent metadata for a specific chain */
function buildAgentMetadata(
  config: Config,
  chain: ChainIdentity,
  agentAddress: string,
  tokenId?: bigint,
): AgentMetadata {
  if (tokenId !== undefined && (tokenId < 0n || tokenId > BigInt(Number.MAX_SAFE_INTEGER))) {
    throw new Error(`Agent tokenId cannot be represented safely in registration JSON: ${tokenId}`);
  }
  return {
    name: chain.agentName,
    description: 'Autonomous ZK proof generation. ERC-8004 identity. x402 payments. Powered by ZKProofport',
    agentType: 'service',
    agentUrl: config.a2aBaseUrl,
    capabilities: [
      'proof_generation',
      'proof_verification',
      // The circuits this agent advertises, from the list it can actually
      // prove. Typed out, this said three while the server proved five --
      // an agent that under-reports is found by nobody looking for GIWA.
      ...PROVABLE_CIRCUIT_IDS,
      'streaming',
      'x402_payment',
    ],
    protocols: ['mcp', 'a2a', 'x402'],
    circuits: [...PROVABLE_CIRCUIT_IDS],
    tags: ['ZK', 'Privacy', 'Proof', 'Coinbase', 'KYC', 'Attestation', 'x402', 'Identity', 'Country', 'Verification', 'Base', 'USDC', 'Arc', ...(config.teeMode === 'nitro' ? ['TEE'] : []), 'Noir', 'EAS', 'Zero-Knowledge'],
    ...(config.teeMode === 'nitro' && { tee: 'nitro' }),
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
      { name: 'x402', endpoint: `${config.a2aBaseUrl}/api/v1/prove` },
      { name: 'DID', endpoint: `did:web:${didWebHost(config.a2aBaseUrl)}` },
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
    supportedTrust: config.teeMode === 'nitro' ? ['tee-attestation'] : [],
    active: true,
  };
}

/** Compare the metadata we publish, including removal of false TEE claims. */
function metadataMatches(current: AgentMetadata | null, expected: AgentMetadata): boolean {
  if (!current) return false;
  return [...new Set([...Object.keys(expected), 'tee'])].every(key =>
    JSON.stringify(current[key as keyof AgentMetadata]) === JSON.stringify(expected[key as keyof AgentMetadata]));
}

async function registerOnChain(config: Config, chain: ChainIdentity): Promise<bigint> {
  const chainLabel = `${chain.chainName} (${chain.chainId})`;
  try {
    const registration = new AgentRegistration({
      identityContractAddress: chain.identityAddress,
      reputationContractAddress: config.erc8004ReputationAddress,
      chainRpcUrl: chain.rpcUrl,
      privateKey: config.proverPrivateKey,
    });
    const hasCachedToken = Boolean(chain.cachedTokenId);
    if (hasCachedToken && !/^(0|[1-9][0-9]*)$/.test(chain.cachedTokenId)) {
      throw new Error(`Invalid cached agent tokenId for chain ${chain.chainId}`);
    }
    // A configured token is verified by ownerOf + tokenURI directly. Do not
    // depend on balanceOf (or historical log discovery) to verify a known id.
    const isRegistered = hasCachedToken || await withTimeout(registration.isRegistered(), 30000, `isRegistered:${chain.chainId}`);
    let tokenId: bigint;
    let current: AgentMetadata | null = null;
    if (isRegistered) {
      const cached = chain.cachedTokenId ? BigInt(chain.cachedTokenId) : undefined;
      const info = await withTimeout(registration.getRegistration(cached), 120000, `getRegistration:${chain.chainId}`);
      if (!info || !info.isRegistered) throw new Error(`Owned registration unresolved on chain ${chain.chainId}`);
      tokenId = info.tokenId;
      current = info.metadataUri ? parseMetadataUri(info.metadataUri) : null;
    } else {
      const result = await withTimeout(registration.register(buildAgentMetadata(config, chain, registration.agentAddress)), txTimeout(chain.chainId), `register:${chain.chainId}`);
      tokenId = result.tokenId;
      log.info({ action: 'identity.chain.minted', chainId: chain.chainId, tokenId: tokenId.toString(), transactionHash: result.transactionHash }, 'Agent minted; verifying discovery metadata');
    }
    await withReadbackRetry(chain.chainId, () => withTimeout(registration.assertTokenOwner(tokenId), 30000, `ownerOf:${chain.chainId}`));
    const expected = buildAgentMetadata(config, chain, registration.agentAddress, tokenId);
    if (!metadataMatches(current, expected)) {
      await withTimeout(registration.updateMetadata(tokenId, expected), txTimeout(chain.chainId), `updateMetadata:${chain.chainId}`);
    }
    const active = await withReadbackRetry(chain.chainId, () => withTimeout(registration.getOnchainMetadata(tokenId, 'active'), 30000, `getActive:${chain.chainId}`));
    if (active !== 'true') {
      await withTimeout(registration.setOnchainMetadata(tokenId, 'active', 'true'), txTimeout(chain.chainId), `setActive:${chain.chainId}`);
    }
    // Base can expose a receipt before every RPC backend has that block's
    // state. Reads are pinned to the write receipt block by AgentRegistration;
    // retry visibility checks only, never submit the update again.
    await withReadbackRetry(chain.chainId, async () => {
      const uri = await withTimeout(registration.getTokenMetadata(tokenId), 30000, `verifyTokenURI:${chain.chainId}`);
      if (!metadataMatches(parseMetadataUri(uri), expected)) throw new Error(`Registration metadata readback mismatch on chain ${chain.chainId}`);
      if (await withTimeout(registration.getOnchainMetadata(tokenId, 'active'), 30000, `verifyActive:${chain.chainId}`) !== 'true') throw new Error(`Registration inactive on chain ${chain.chainId}`);
    });
    log.info({ action: 'identity.chain.ready', chainId: chain.chainId, tokenId: tokenId.toString(), owner: registration.agentAddress, endpoint: config.a2aBaseUrl }, 'Owned agent registration verified');
    return tokenId;
  } catch (error) {
    log.error({ action: 'identity.chain.failed', chain: chainLabel, err: error instanceof Error ? error : new Error(String(error)) }, `Registration failed on ${chainLabel}`);
    throw new Error(`ERC-8004 registration failed on ${chainLabel}`, { cause: error });
  }
}

/** Whether this public deployment is configured to register an identity. */
export function isIdentityRegistrationEnabled(config: Config): boolean {
  const serviceUrl = new URL(config.a2aBaseUrl);
  if (serviceUrl.protocol !== 'https:' || ['localhost', '127.0.0.1', '[::1]'].includes(serviceUrl.hostname) || serviceUrl.hostname.endsWith('.localhost')) return false;
  return Boolean(config.erc8004IdentityAddress || config.arcRpcUrl);
}

/**
 * Ensure agent is registered on all configured ERC-8004 Identity contracts.
 *
 * Registers on Base (primary chain) and optionally on Ethereum mainnet
 * if ETHEREUM_RPC_URL is configured. Each chain gets its own agent identity
 * with chain-specific metadata.
 *
 * Returns a Map of chainId -> tokenId only when every configured identity is verified.
 * Rejects when any configured identity cannot be verified. The caller exposes
 * this failure through readiness while keeping the HTTP server available.
 */
export async function ensureAgentRegistered(config: Config, teeProvider?: TeeProvider): Promise<Map<number, bigint>> {
  const results = new Map<number, bigint>();

  if (!isIdentityRegistrationEnabled(config)) {
    log.info({ action: 'identity.disabled' }, 'No public identity registration configured');
    return results;
  }

  const chains = getChainIdentities(config);
  log.info({ action: 'identity.chains', count: chains.length, chains: chains.map(c => `${c.agentName}@${c.chainId}`) }, `Registering on ${chains.length} chain(s)`);

  const failures: { chainId: number; error: unknown }[] = [];
  for (const chain of chains) {
    const owner = new ethers.Wallet(config.proverPrivateKey).address.toLowerCase();
    const key = `identity:registration:${chain.chainId}:${chain.identityAddress.toLowerCase()}:${owner}`;
    try {
      const tokenId = await withRegistrationLock(config.redisUrl, key, () => registerOnChain(config, chain));
      results.set(chain.chainId, tokenId);
    } catch (error) {
      failures.push({ chainId: chain.chainId, error });
      // Also captures lock acquisition failures, which occur before registerOnChain.
      log.error({ action: 'identity.chain.failed', chainId: chain.chainId, err: error }, 'Configured identity could not be verified');
    }
  }

  if (failures.length) {
    throw new AggregateError(failures.map(failure => failure.error),
      `Required ERC-8004 registration failed on chain(s): ${failures.map(failure => failure.chainId).join(', ')}; inspect identity.chain.failed logs`);
  }
  log.info({ action: 'identity.complete', registered: results.size, chains: [...results.entries()].map(([c, t]) => `${c}:${t}`) }, 'Registration complete');
  return results;
}
