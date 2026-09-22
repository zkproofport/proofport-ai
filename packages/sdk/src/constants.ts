import { CIRCUIT_IDS } from './circuits.js';
import type { CircuitId } from './types.js';

/**
 * Per-circuit metadata. Keyed by the canonical identifiers from `./circuits.js`
 * and typed `Record<CircuitId, …>`, so adding a provable circuit without an
 * entry — or keeping an entry for one that no longer exists — is a compile error.
 */
export const CIRCUITS: Record<CircuitId, {
  displayName: string;
  easSchemaId?: string;
  functionSelector?: string;
  inputType?: string;
}> = {
  [CIRCUIT_IDS.COINBASE_ATTESTATION]: {
    displayName: 'Coinbase KYC',
    easSchemaId: '0xf8b05c79f090979bf4a80270aba232dff11a10d9ca55c4f88de95317970f0de9',
    functionSelector: '0x56feed5e',
  },
  [CIRCUIT_IDS.COINBASE_COUNTRY_ATTESTATION]: {
    displayName: 'Coinbase Country',
    easSchemaId: '0x1801901fabd0e6189356b4fb52bb0ab855276d84f7ec140839fbd1f6801ca065',
    functionSelector: '0x0a225248',
  },
  [CIRCUIT_IDS.OIDC_DOMAIN_ATTESTATION]: {
    displayName: 'OIDC Domain',
    inputType: 'oidc',
  },
  [CIRCUIT_IDS.ARC_ELIGIBILITY]: {
    displayName: 'Arc Eligibility',
    easSchemaId: '0xf8b05c79f090979bf4a80270aba232dff11a10d9ca55c4f88de95317970f0de9',
    functionSelector: '0x56feed5e',
  },
  [CIRCUIT_IDS.GIWA_ATTESTATION]: {
    displayName: 'GIWA Attestation',
    // No EAS schema: GIWA's attestation is not indexed by EAS on Base. It is
    // found by reading our own attester's calls on GIWA Sepolia, so a schema
    // id here would be a value nothing looks up.
    functionSelector: '0x56feed5e',
  },
};

export const COINBASE_ATTESTER_CONTRACT = '0x357458739F90461b99789350868CD7CF330Dd7EE';

export const AUTHORIZED_SIGNERS = [
  '0x952f32128AF084422539C4Ff96df5C525322E564',
  '0x8844591D47F17bcA6F5dF8f6B64F4a739F1C0080',
  '0x88fe64ea2e121f49bb77abea6c0a45e93638c3c5',
  '0x44ace9abb148e8412ac4492e9a1ae6bd88226803',
];

/** MockGiwaAttester on GIWA Sepolia -- the `to` of a GIWA attest transaction. */
export const GIWA_ATTESTER_CONTRACT = '0x6646d970499BBeD728636823A5A7e551E811b414';

/** The one address that signs GIWA attest transactions. */
export const GIWA_AUTHORIZED_SIGNERS = ['0xEE099845CDfF93e73aDcBcB36A9B93578bcCed4b'];

/**
 * GIWA Sepolia, where giwa_attestation is attested and verified.
 *
 * Constants, not configuration, for the same reason the EAS endpoints below
 * are: a customer has no reason to point this at another chain, and letting
 * them would only produce proofs against an attester nobody accepts.
 */
export const GIWA_RPC = 'https://sepolia-rpc.giwa.io/';
export const GIWA_EXPLORER = 'https://sepolia-explorer.giwa.io';
export const GIWA_CHAIN_ID = 91342;

/**
 * Where THIS circuit's attestation lives, and who is allowed to have signed it.
 *
 * One table, keyed by circuit id, `Record<CircuitId, …>` so a new circuit
 * without an entry is a compile error. It replaces three separate two-branch
 * tests -- which attester contract, which signer list, which lookup -- each of
 * which ended on Coinbase's values for anything that was not GIWA. That is the
 * shape this repo bans: a circuit nobody added would not fail, it would be
 * checked against Coinbase's attester and proved against Coinbase's signers.
 *
 * `null` is not "unknown": it is a circuit with no attestation transaction at
 * all. OIDC's signature is inside the identity token.
 */
export type AttestationSource =
  | { kind: 'eas-base'; contract: string; signers: readonly string[] }
  | { kind: 'giwa-sepolia'; contract: string; signers: readonly string[]; chainId: number; rpc: string; explorer: string };

export const ATTESTATION_SOURCES: Record<CircuitId, AttestationSource | null> = {
  [CIRCUIT_IDS.COINBASE_ATTESTATION]: {
    kind: 'eas-base',
    contract: COINBASE_ATTESTER_CONTRACT,
    signers: AUTHORIZED_SIGNERS,
  },
  [CIRCUIT_IDS.COINBASE_COUNTRY_ATTESTATION]: {
    kind: 'eas-base',
    contract: COINBASE_ATTESTER_CONTRACT,
    signers: AUTHORIZED_SIGNERS,
  },
  [CIRCUIT_IDS.ARC_ELIGIBILITY]: {
    kind: 'eas-base',
    contract: COINBASE_ATTESTER_CONTRACT,
    signers: AUTHORIZED_SIGNERS,
  },
  [CIRCUIT_IDS.GIWA_ATTESTATION]: {
    kind: 'giwa-sepolia',
    contract: GIWA_ATTESTER_CONTRACT,
    signers: GIWA_AUTHORIZED_SIGNERS,
    chainId: GIWA_CHAIN_ID,
    rpc: GIWA_RPC,
    explorer: GIWA_EXPLORER,
  },
  [CIRCUIT_IDS.OIDC_DOMAIN_ATTESTATION]: null,
};

/**
 * The attestation source for a circuit, or an error naming the circuit.
 *
 * Two different failures, said differently: a circuit this build has never
 * heard of, and a circuit that genuinely has no attestation to fetch.
 */
export function attestationSource(circuitId: CircuitId): AttestationSource {
  if (!(circuitId in ATTESTATION_SOURCES)) {
    throw new Error(
      `Unknown circuit '${circuitId}'. Known: ${Object.keys(ATTESTATION_SOURCES).join(', ')}.`,
    );
  }
  const source = ATTESTATION_SOURCES[circuitId];
  if (!source) {
    throw new Error(
      `'${circuitId}' has no on-chain attestation to fetch -- its signature is inside the identity token.`,
    );
  }
  return source;
}

export const DEFAULT_EAS_GRAPHQL = 'https://base.easscan.org/graphql';
// Use drpc.org instead of mainnet.base.org: the latter prunes transactions
// older than ~30 days, so eth_getTransactionByHash returns null for any
// attestation made earlier (mainnet.base.org returned null for txs from 2025).
// drpc.org retains full history at no cost and no API key.
export const DEFAULT_EAS_RPC = 'https://base.drpc.org';

export const RAW_TX_PADDED_LENGTH = 300;
export const MERKLE_PROOF_MAX_DEPTH = 8;
export const COUNTRY_LIST_MAX_LENGTH = 10;
