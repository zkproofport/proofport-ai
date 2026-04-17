/**
 * Runtime deployment fetcher.
 *
 * Fetches Foundry broadcast JSON from GitHub to get the latest
 * deployed verifier contract addresses. Uses in-memory cache
 * with fallback to hardcoded addresses.
 *
 * Resolution strategy:
 *   - testnet (staging): fetch from main branch (latest deployments)
 *   - mainnet (production): fetch from latest GitHub Release tag (verified only)
 */

import { createLogger } from '../logger.js';
import { FALLBACK_VERIFIERS } from './contracts.js';
import type { CircuitId } from './contracts.js';

const log = createLogger('Deployments');

const GITHUB_REPO = 'zkproofport/circuits';
const GITHUB_RAW = (ref: string) =>
  `https://raw.githubusercontent.com/${GITHUB_REPO}/${ref}`;

const BROADCAST_PATHS: Record<CircuitId, (chainId: number) => string> = {
  coinbase_attestation: (chainId) =>
    `broadcast/DeployCoinbaseAttestation.s.sol/${chainId}/run-latest.json`,
  coinbase_country_attestation: (chainId) =>
    `broadcast/DeployCoinbaseCountryAttestation.s.sol/${chainId}/run-latest.json`,
  oidc_domain_attestation: (chainId) =>
    `broadcast/DeployOidcDomainAttestation.s.sol/${chainId}/run-latest.json`,
};

const CIRCUIT_IDS: CircuitId[] = ['coinbase_attestation', 'coinbase_country_attestation', 'oidc_domain_attestation'];

// ── In-memory cache ─────────────────────────────────────────────────────
// Starts with fallback values, updated by syncDeployments() at startup.
// All consumers read from this object synchronously.
const verifierAddresses: Record<string, Record<string, string>> = JSON.parse(
  JSON.stringify(FALLBACK_VERIFIERS),
);

// Release tag cache (module-level, resets on server restart)
let cachedReleaseTag: { tag: string; fetchedAt: number } | null = null;
const RELEASE_TAG_TTL_MS = 60 * 60 * 1000; // 1 hour

// ── Sync getters (no async needed by consumers) ─────────────────────────

/**
 * Get verifier address for a circuit on a specific chain.
 * Returns undefined if not found.
 */
export function getVerifierAddress(
  circuitId: string,
  chainId: string,
): string | undefined {
  return verifierAddresses[chainId]?.[circuitId];
}

/**
 * Get all verifier addresses for a chain.
 * Returns empty object if chain not found.
 */
export function getChainVerifiers(
  chainId: string,
): Record<string, string> {
  return verifierAddresses[chainId] || {};
}

// ── Async fetch logic ───────────────────────────────────────────────────

interface BroadcastTransaction {
  contractName: string;
  contractAddress: string;
}

interface BroadcastJson {
  transactions: BroadcastTransaction[];
}

/**
 * Resolve the latest GitHub Release tag for production.
 * Caches the tag in memory for 1 hour.
 */
async function resolveReleaseTag(): Promise<string | null> {
  if (
    cachedReleaseTag &&
    Date.now() - cachedReleaseTag.fetchedAt < RELEASE_TAG_TTL_MS
  ) {
    return cachedReleaseTag.tag;
  }

  try {
    const response = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`,
      { headers: { Accept: 'application/vnd.github.v3+json' } },
    );
    if (!response.ok) {
      log.warn(
        { status: response.status },
        'Failed to fetch latest release tag',
      );
      return null;
    }

    const release = (await response.json()) as { tag_name?: string };
    const tag = release.tag_name;
    if (!tag) return null;

    cachedReleaseTag = { tag, fetchedAt: Date.now() };
    log.info({ tag }, 'Resolved latest release tag');
    return tag;
  } catch (err) {
    log.warn({ err }, 'Error resolving release tag');
    return null;
  }
}

/**
 * Build the broadcast JSON URL based on environment.
 */
async function resolveBroadcastUrl(
  circuitId: CircuitId,
  chainId: number,
  isProduction: boolean,
): Promise<string | null> {
  const pathFn = BROADCAST_PATHS[circuitId];
  if (!pathFn) return null;

  if (!isProduction) {
    // Staging/testnet: fetch from main branch
    return `${GITHUB_RAW('main')}/${pathFn(chainId)}`;
  }

  // Production: resolve latest release tag first
  const tag = await resolveReleaseTag();
  if (!tag) return null;
  return `${GITHUB_RAW(tag)}/${pathFn(chainId)}`;
}

/**
 * Fetch verifier address from a broadcast JSON URL.
 * Looks for the first transaction with contractName === 'HonkVerifier'.
 */
async function fetchVerifierFromBroadcast(
  url: string,
): Promise<string | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      log.warn({ url, status: response.status }, 'Failed to fetch broadcast JSON');
      return null;
    }

    const broadcast: BroadcastJson = await response.json();
    const tx = broadcast.transactions.find(
      (t) => t.contractName === 'HonkVerifier',
    );

    return tx?.contractAddress || null;
  } catch (err) {
    log.warn({ err, url }, 'Error fetching broadcast JSON');
    return null;
  }
}

// ── Public sync function ────────────────────────────────────────────────

/**
 * Sync verifier addresses for a single chain from GitHub broadcast JSON.
 */
async function syncChain(chainId: number, isProduction: boolean): Promise<boolean> {
  const chainIdStr = String(chainId);
  let updated = false;

  await Promise.all(
    CIRCUIT_IDS.map(async (circuitId) => {
      const url = await resolveBroadcastUrl(circuitId, chainId, isProduction);
      if (!url) return;

      const address = await fetchVerifierFromBroadcast(url);
      if (!address) return;

      const current = verifierAddresses[chainIdStr]?.[circuitId];
      if (address !== current) {
        if (!verifierAddresses[chainIdStr]) {
          verifierAddresses[chainIdStr] = {};
        }
        verifierAddresses[chainIdStr][circuitId] = address;
        updated = true;
        log.info(
          { action: 'deployment.updated', circuitId, chainId, address, previous: current || 'none' },
          `Verifier address updated for ${circuitId}`,
        );
      } else {
        log.debug(
          { circuitId, chainId, address },
          'Verifier address unchanged',
        );
      }
    }),
  );

  return updated;
}

/**
 * Fetch latest verifier addresses from GitHub broadcast JSON.
 * Updates the in-memory cache for all deployed chains. Call at server startup.
 *
 * Syncs: Ethereum mainnet (1), Base mainnet (8453), and Base Sepolia (84532) for testnet.
 *
 * @param paymentMode - 'testnet' | 'mainnet' | 'disabled'
 * @returns true if any address was updated
 */
export async function syncDeployments(paymentMode: string, chainRpcUrl?: string): Promise<boolean> {
  const isTestnetRpc = chainRpcUrl?.includes('sepolia') ?? false;
  const isProduction = paymentMode === 'mainnet' || (paymentMode === 'disabled' && !isTestnetRpc);

  if (isProduction) {
    // Sync both Ethereum mainnet and Base mainnet
    const [ethUpdated, baseUpdated] = await Promise.all([
      syncChain(1, true),
      syncChain(8453, true),
    ]);
    return ethUpdated || baseUpdated;
  } else {
    // Testnet: sync both Ethereum Sepolia and Base Sepolia
    const [ethUpdated, baseUpdated] = await Promise.all([
      syncChain(11155111, false),
      syncChain(84532, false),
    ]);
    return ethUpdated || baseUpdated;
  }
}
