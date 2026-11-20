/**
 * Runtime deployment fetcher.
 *
 * Fetches Foundry broadcast JSON from GitHub to get the deployed verifier
 * contract addresses. Uses in-memory cache with fallback to hardcoded
 * addresses.
 *
 * Every chain, staging and production, reads the broadcast records of the
 * pinned circuits commit (src/config/circuitsPin.ts) -- the same commit the
 * baked artifacts come from, so a proof and the verifier it names always
 * belong to one circuit set.
 *
 * Until 2026-11-17 staging read CIRCUITS_REPO_URL (default circuits `main`)
 * and production asked the GitHub API for `releases/latest`, so merging to
 * circuits `main` or marking a release Latest changed the verifiers a server
 * named on its next start, with no deploy. (Earlier still, staging's records
 * were hardcoded to main while its artifacts came from another branch: on
 * 2026-10-22 every beta.19 proof reverted with ProofLengthWrong().)
 */

import { PINNED_VERIFIERS, sameAddress } from '@zkproofport-app/core';
import { createLogger } from '../logger.js';
import { FALLBACK_VERIFIERS } from './contracts.js';
import { CIRCUIT_IDS, PROVABLE_CIRCUIT_IDS } from './circuitIds.js';
import { pinnedCircuitsRawBase } from './circuitsPin.js';
import type { CircuitId } from './circuitIds.js';

const log = createLogger('Deployments');

const BROADCAST_PATHS: Record<CircuitId, (chainId: number) => string> = {
  // v2 (circuits coinbase-attestation-v2). v1's DeployCoinbaseAttestation
  // records name verifiers that refuse every v2 proof on proof length.
  [CIRCUIT_IDS.COINBASE_ATTESTATION]: (chainId) =>
    `broadcast/DeployCoinbaseAttestationV2.s.sol/${chainId}/run-latest.json`,
  // v2 (circuits coinbase-country-attestation-v2); v1's records name
  // verifiers that refuse every v2 proof.
  [CIRCUIT_IDS.COINBASE_COUNTRY_ATTESTATION]: (chainId) =>
    `broadcast/DeployCoinbaseCountryAttestationV2.s.sol/${chainId}/run-latest.json`,
  [CIRCUIT_IDS.OIDC_DOMAIN_ATTESTATION]: (chainId) =>
    `broadcast/DeployOidcDomainAttestation.s.sol/${chainId}/run-latest.json`,
  [CIRCUIT_IDS.GIWA_ATTESTATION]: (chainId) =>
    `broadcast/DeployGiwaAttestation.s.sol/${chainId}/run-latest.json`,
  [CIRCUIT_IDS.HUMAN_PASSPORT_SCORE]: (chainId) =>
    `broadcast/DeployHumanPassportScore.s.sol/${chainId}/run-latest.json`,
};

// ── In-memory cache ─────────────────────────────────────────────────────
// Starts with fallback values, updated by syncDeployments() at startup.
// All consumers read from this object synchronously.
const verifierAddresses: Record<string, Record<string, string>> = JSON.parse(
  JSON.stringify(FALLBACK_VERIFIERS),
);

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

/** The pinned commit's broadcast JSON URL for one circuit on one chain. */
function broadcastUrl(circuitId: CircuitId, chainId: number): string {
  const pathFn = BROADCAST_PATHS[circuitId];
  if (!pathFn) throw new Error(`No broadcast path for circuit ${circuitId}. Known: ${Object.keys(BROADCAST_PATHS).join(', ')}`);
  return `${pinnedCircuitsRawBase()}/${pathFn(chainId)}`;
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
    PROVABLE_CIRCUIT_IDS.map(async (circuitId) => {
      const address = await fetchVerifierFromBroadcast(broadcastUrl(circuitId, chainId));
      if (!address) return;

      const current = verifierAddresses[chainIdStr]?.[circuitId];
      const unpinned = unpinnedVerifierReason(circuitId, chainId, address);
      // A pinned commit can still name a mainnet verifier core does not pin:
      // a redeploy recorded before core's release, or (core 0.4.0-beta.9) the
      // bb 4.2 verifiers core lists in AWAITING_REDEPLOY, which refuse every
      // bb 6.0.0 proof. Production never adopts an unpinned address: published
      // clients would refuse every proof naming it. It keeps the pinned
      // address, or no target at all when core pins none there (the fallback
      // row is null). Until 2026-11-17 production read `releases/latest`
      // (held at v1.3.0, whose OIDC v1 verifiers revert every proof this
      // server makes), which is how this guard began. Staging takes the
      // pinned commit's records as they are.
      if (unpinned && isProduction) {
        log.error(
          { action: 'deployment.unpinned_ignored', circuitId, chainId, address, kept: current ?? 'none' },
          current ? `${unpinned}; keeping the pinned ${current}` : `${unpinned}; leaving ${circuitId} without a verifier on chain ${chainId}`,
        );
        return;
      }
      if (unpinned) {
        log.error(
          { action: 'deployment.unpinned', circuitId, chainId, address },
          `${unpinned}; clients verifying with the published SDK/MCP will refuse these proofs`,
        );
      }

      if (!current || !sameAddress(address, current)) {
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
 * Records are read from the pinned circuits commit (src/config/circuitsPin.ts).
 *
 * @param paymentMode - 'testnet' | 'mainnet' | 'disabled'
 * @returns true if any address was updated
 */
export async function syncDeployments(
  paymentMode: string,
  chainRpcUrl: string | undefined,
): Promise<boolean> {
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
    // Testnet: Ethereum Sepolia, Base Sepolia, and GIWA Sepolia -- the only
    // chain giwa_attestation is deployed on, which was never synced and so
    // stayed on its fallback address after every redeploy.
    const results = await Promise.all([
      syncChain(11155111, false),
      syncChain(84532, false),
      syncChain(91342, false),
    ]);
    return results.some(Boolean);
  }
}
