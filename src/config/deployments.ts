/**
 * Runtime deployment fetcher.
 *
 * Fetches Foundry broadcast JSON from GitHub to get the latest
 * deployed verifier contract addresses. Uses in-memory cache
 * with fallback to hardcoded addresses.
 *
 * Resolution strategy:
 *   - testnet (staging): fetch from the same circuits ref the artifacts come
 *     from (CIRCUITS_REPO_URL). It was hardcoded to main, so a server proving
 *     with artifacts from another branch verified against main's verifiers --
 *     on 2026-10-22 every beta.19 proof reverted with ProofLengthWrong().
 *   - mainnet (production): fetch from latest GitHub Release tag (verified only)
 */

import { PINNED_VERIFIERS, sameAddress } from '@zkproofport-app/core';
import { createLogger } from '../logger.js';
import { FALLBACK_VERIFIERS } from './contracts.js';
import { CIRCUIT_IDS, PROVABLE_CIRCUIT_IDS } from './circuitIds.js';
import type { CircuitId } from './circuitIds.js';

const log = createLogger('Deployments');

const GITHUB_REPO = 'zkproofport/circuits';
const GITHUB_RAW = (ref: string) =>
  `https://raw.githubusercontent.com/${GITHUB_REPO}/${ref}`;

const BROADCAST_PATHS: Record<CircuitId, (chainId: number) => string> = {
  // v2 (circuits coinbase-attestation-v2). v1's DeployCoinbaseAttestation
  // records name verifiers that refuse every v2 proof on proof length.
  [CIRCUIT_IDS.COINBASE_ATTESTATION]: (chainId) =>
    `broadcast/DeployCoinbaseAttestationV2.s.sol/${chainId}/run-latest.json`,
  [CIRCUIT_IDS.COINBASE_COUNTRY_ATTESTATION]: (chainId) =>
    `broadcast/DeployCoinbaseCountryAttestation.s.sol/${chainId}/run-latest.json`,
  [CIRCUIT_IDS.OIDC_DOMAIN_ATTESTATION]: (chainId) =>
    `broadcast/DeployOidcDomainAttestation.s.sol/${chainId}/run-latest.json`,
  [CIRCUIT_IDS.GIWA_ATTESTATION]: (chainId) =>
    `broadcast/DeployGiwaAttestation.s.sol/${chainId}/run-latest.json`,
};

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

/**
 * Why published clients will refuse proofs that name `address`, or `null`
 * when they will accept it.
 *
 * The AI SDK, the MCP and every other @zkproofport-app/core consumer verify
 * against core's pinned table and refuse a response naming a different
 * verifier. A deployment synced here that is newer than the installed core
 * (a redeploy on the circuits branch staging proves from) produces responses
 * those clients refuse until core is released with it.
 */
export function unpinnedVerifierReason(circuitId: CircuitId, chainId: number, address: string): string | null {
  const pinned = PINNED_VERIFIERS[circuitId]?.[chainId];
  if (!pinned) {
    return `@zkproofport-app/core pins no ${circuitId} verifier on chain ${chainId}`;
  }
  if (!sameAddress(pinned.address, address)) {
    return `@zkproofport-app/core pins ${circuitId} on chain ${chainId} to ${pinned.address}, not ${address}`;
  }
  return null;
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
  testnetRepoUrl: string,
): Promise<string | null> {
  const pathFn = BROADCAST_PATHS[circuitId];
  if (!pathFn) return null;

  if (!isProduction) {
    return `${testnetRepoUrl}/${pathFn(chainId)}`;
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
async function syncChain(chainId: number, isProduction: boolean, testnetRepoUrl: string): Promise<boolean> {
  const chainIdStr = String(chainId);
  let updated = false;

  await Promise.all(
    PROVABLE_CIRCUIT_IDS.map(async (circuitId) => {
      const url = await resolveBroadcastUrl(circuitId, chainId, isProduction, testnetRepoUrl);
      if (!url) return;

      const address = await fetchVerifierFromBroadcast(url);
      if (!address) return;

      const current = verifierAddresses[chainIdStr]?.[circuitId];
      const unpinned = unpinnedVerifierReason(circuitId, chainId, address);
      // Production reads the circuits release marked Latest, which is held
      // back on purpose (installed apps read it), so it can name verifiers
      // older than the ones core pins -- v1.3.0 names OIDC v1 on Base and
      // Ethereum, which reverts every proof this server makes. A pinned
      // address is never replaced by an unpinned one there. Staging keeps
      // following its circuits ref, whose redeploys core has not pinned yet.
      if (unpinned && isProduction && current && !unpinnedVerifierReason(circuitId, chainId, current)) {
        log.error(
          { action: 'deployment.unpinned_ignored', circuitId, chainId, address, kept: current },
          `${unpinned}; keeping the pinned ${current}`,
        );
        return;
      }
      if (unpinned) {
        log.error(
          { action: 'deployment.unpinned', circuitId, chainId, address },
          `${unpinned}; clients verifying with the published SDK/MCP will refuse these proofs`,
        );
      }

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
 * @param testnetRepoUrl - raw base URL of the circuits ref the artifacts come
 *   from (config.circuitsRepoUrl); testnet broadcasts are read from the same ref
 * @returns true if any address was updated
 */
export async function syncDeployments(
  paymentMode: string,
  chainRpcUrl: string | undefined,
  testnetRepoUrl: string,
): Promise<boolean> {
  if (!testnetRepoUrl) throw new Error('syncDeployments needs the circuits repo URL the artifacts come from');
  const isTestnetRpc = chainRpcUrl?.includes('sepolia') ?? false;
  const isProduction = paymentMode === 'mainnet' || (paymentMode === 'disabled' && !isTestnetRpc);

  if (isProduction) {
    // Sync both Ethereum mainnet and Base mainnet
    const [ethUpdated, baseUpdated] = await Promise.all([
      syncChain(1, true, testnetRepoUrl),
      syncChain(8453, true, testnetRepoUrl),
    ]);
    return ethUpdated || baseUpdated;
  } else {
    // Testnet: Ethereum Sepolia, Base Sepolia, and GIWA Sepolia -- the only
    // chain giwa_attestation is deployed on, which was never synced and so
    // stayed on its fallback address after every redeploy.
    const results = await Promise.all([
      syncChain(11155111, false, testnetRepoUrl),
      syncChain(84532, false, testnetRepoUrl),
      syncChain(91342, false, testnetRepoUrl),
    ]);
    return results.some(Boolean);
  }
}
