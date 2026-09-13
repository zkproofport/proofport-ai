/**
 * Auto-registration on ERC-8004 Identity contract at server startup.
 * Supports dual-chain registration (Base + Ethereum mainnet).
 */

import { withRegistrationLock } from './registrationLock.js';
import { ethers } from 'ethers';
import { AgentRegistration, parseMetadataUri } from './register.js';
import type { Config, ChainIdentity } from '../config/index.js';
import { getChainIdentities } from '../config/index.js';
import type { AgentMetadata } from './types.js';
import type { TeeProvider } from '../tee/types.js';
import { createLogger } from '../logger.js';
import { CIRCUIT_IDS } from '../config/circuitIds.js';

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
      'coinbase_kyc',
      'coinbase_country',
      'arc_eligibility',
      'streaming',
      'x402_payment',
    ],
    protocols: ['mcp', 'a2a', 'x402'],
    circuits: [CIRCUIT_IDS.COINBASE_ATTESTATION, CIRCUIT_IDS.COINBASE_COUNTRY_ATTESTATION, CIRCUIT_IDS.ARC_ELIGIBILITY],
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

async function registerOnChain(config: Config, chain: ChainIdentity): Promise<bigint | null> {
  const chainLabel = `${chain.chainName} (${chain.chainId})`;
  try {
    const registration = new AgentRegistration({
      identityContractAddress: chain.identityAddress,
      reputationContractAddress: config.erc8004ReputationAddress,
      chainRpcUrl: chain.rpcUrl,
      privateKey: config.proverPrivateKey,
    });
    const isRegistered = await withTimeout(registration.isRegistered(), 30000, `isRegistered:${chain.chainId}`);
    let tokenId: bigint;
    let current: AgentMetadata | null = null;
    if (isRegistered || chain.cachedTokenId) {
      if (chain.cachedTokenId && !/^(0|[1-9][0-9]*)$/.test(chain.cachedTokenId)) {
        throw new Error(`Invalid cached agent tokenId for chain ${chain.chainId}`);
      }
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
    await withTimeout(registration.assertTokenOwner(tokenId), 30000, `ownerOf:${chain.chainId}`);
    const expected = buildAgentMetadata(config, chain, registration.agentAddress, tokenId);
    if (!metadataMatches(current, expected)) {
      await withTimeout(registration.updateMetadata(tokenId, expected), txTimeout(chain.chainId), `updateMetadata:${chain.chainId}`);
    }
    const active = await withTimeout(registration.getOnchainMetadata(tokenId, 'active'), 30000, `getActive:${chain.chainId}`);
    if (active !== 'true') {
      await withTimeout(registration.setOnchainMetadata(tokenId, 'active', 'true'), txTimeout(chain.chainId), `setActive:${chain.chainId}`);
    }
    const uri = await withTimeout(registration.getTokenMetadata(tokenId), 30000, `verifyTokenURI:${chain.chainId}`);
    if (!metadataMatches(parseMetadataUri(uri), expected)) throw new Error(`Registration metadata readback mismatch on chain ${chain.chainId}`);
    if (await withTimeout(registration.getOnchainMetadata(tokenId, 'active'), 30000, `verifyActive:${chain.chainId}`) !== 'true') throw new Error(`Registration inactive on chain ${chain.chainId}`);
    log.info({ action: 'identity.chain.ready', chainId: chain.chainId, tokenId: tokenId.toString(), owner: registration.agentAddress, endpoint: config.a2aBaseUrl }, 'Owned agent registration verified');
    return tokenId;
  } catch (error) {
    log.error({ action: 'identity.chain.failed', chain: chainLabel, err: error instanceof Error ? error : new Error(String(error)) }, `Registration failed on ${chainLabel}`);
    return null;
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
 * Returns a Map of chainId -> tokenId for all successful registrations.
 * Rejects when the required Arc identity cannot be verified. The caller exposes
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

  for (const chain of chains) {
    const owner = new ethers.Wallet(config.proverPrivateKey).address.toLowerCase();
    const key = `identity:registration:${chain.chainId}:${chain.identityAddress.toLowerCase()}:${owner}`;
    const tokenId = await withRegistrationLock(config.redisUrl, key, () => registerOnChain(config, chain));
    if (tokenId !== null) {
      results.set(chain.chainId, tokenId);
    }
  }

  if (config.arcRpcUrl && !results.has(config.arcChainId)) {
    throw new Error(`Required Arc ERC-8004 registration failed on chain ${config.arcChainId}; inspect identity.chain.failed logs`);
  }
  log.info({ action: 'identity.complete', registered: results.size, chains: [...results.entries()].map(([c, t]) => `${c}:${t}`) }, 'Registration complete');
  return results;
}
