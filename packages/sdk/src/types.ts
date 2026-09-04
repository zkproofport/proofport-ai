// ─── Circuit name mappings ──────────────────────────────────────────────

import { CIRCUIT_IDS, PROVABLE_CIRCUIT_IDS } from './circuits.js';

/** Client-friendly circuit aliases. */
export type CircuitName = 'coinbase_kyc' | 'coinbase_country' | 'oidc_domain';

/**
 * Canonical circuit IDs this server can prove.
 *
 * Derived from `PROVABLE_CIRCUIT_IDS` in `./circuits.js`, which is itself built
 * from the canonical identifiers owned by `@zkproofport-app/sdk/circuits`. The
 * union is unchanged — the three names are no longer typed out here, so a
 * rename in the customer SDK becomes a compile error instead of a silent
 * divergence.
 */
export type CircuitId = (typeof PROVABLE_CIRCUIT_IDS)[number];

/** Map client-friendly names to canonical circuit IDs. */
export const CIRCUIT_NAME_MAP: Record<CircuitName, CircuitId> = {
  coinbase_kyc: CIRCUIT_IDS.COINBASE_ATTESTATION,
  coinbase_country: CIRCUIT_IDS.COINBASE_COUNTRY_ATTESTATION,
  oidc_domain: CIRCUIT_IDS.OIDC_DOMAIN_ATTESTATION,
};

/** Map canonical circuit IDs back to client-friendly names. */
export const CIRCUIT_ID_MAP: Record<CircuitId, CircuitName> = {
  [CIRCUIT_IDS.COINBASE_ATTESTATION]: 'coinbase_kyc',
  [CIRCUIT_IDS.COINBASE_COUNTRY_ATTESTATION]: 'coinbase_country',
  [CIRCUIT_IDS.OIDC_DOMAIN_ATTESTATION]: 'oidc_domain',
};

// ─── Configuration ──────────────────────────────────────────────────────

export interface ClientConfig {
  /** proofport-ai server URL (e.g. https://stg-ai.zkproofport.app) */
  baseUrl: string;
}

// ─── Challenge (response from POST /prove) ──────────────────────────────

export interface ChallengeResponse {
  error: string;
  message: string;
  nonce: string;
  teePublicKey?: {
    publicKey: string;
    keyId: string;
    attestationDocument: string | null;
  } | null;
}

// ─── Prove (POST /prove) ────────────────────────────────────────────────

export interface ProveInputs {
  signal_hash: string;
  nullifier: string;
  scope_bytes: string;
  merkle_root: string;
  user_address: string;
  signature: string;
  user_pubkey_x: string;
  user_pubkey_y: string;
  raw_transaction: string;
  tx_length: number;
  coinbase_attester_pubkey_x: string;
  coinbase_attester_pubkey_y: string;
  merkle_proof: string[];
  leaf_index: number;
  depth: number;
  country_list?: string[];
  is_included?: boolean;
}

export interface ProveRequest {
  circuit: CircuitName;
  inputs?: ProveInputs | Record<string, unknown>;
  encrypted_payload?: EncryptedProveRequest['encrypted_payload'];
}

// ─── E2E Encryption types ────────────────────────────────────────────────

export interface EncryptedProveRequest {
  encrypted_payload: {
    ephemeralPublicKey: string;
    iv: string;
    ciphertext: string;
    authTag: string;
    keyId: string;
  };
}

export interface ProveResponse {
  circuit: string;
  proofType: string;
  proof: string;
  publicInputs: string;
  proofWithInputs: string;
  attestation: {
    document: string;
    proof_hash: string;
    verification: {
      rootCaValid: boolean;
      chainValid: boolean;
      signatureValid: boolean;
      pcrs: Record<number, string>;
    };
  } | null;
  timing: {
    totalMs: number;
    inputBuildMs?: number;
    proveMs?: number;
  };
  verification: {
    chainId: number;
    verifierAddress: string;
    rpcUrl: string;
  } | null;
}

export interface VerifyResult {
  valid: boolean;
  transactionHash?: string;
  error?: string;
}

// ─── EAS attestation data ───────────────────────────────────────────────

export interface EASAttestation {
  id: string;
  txid: string;
  recipient: string;
  attester: string;
  time: number;
  expirationTime: number;
  schemaId: string;
}

export interface AttestationData {
  attestation: EASAttestation;
  rawTransaction: string;
}

// ─── Proof generation params ────────────────────────────────────────────

export interface ProofParams {
  circuit: CircuitName;
  /** Scope string for the proof (defaults to "proofport") */
  scope?: string;
  /** Country codes for the country circuit (e.g. ["US", "KR"]) */
  countryList?: string[];
  /** Whether the country list is an inclusion or exclusion list */
  isIncluded?: boolean;
  /** JWT token for OIDC circuit (oidc_domain) */
  jwt?: string;
  /** OIDC provider: 'google' (default) or 'microsoft' for Microsoft 365 */
  provider?: 'google' | 'microsoft';
}

export interface ProofResult {
  circuit: string;
  proofType: string;
  proof: string;
  publicInputs: string;
  proofWithInputs: string;
  attestation: ProveResponse['attestation'];
  timing: ProveResponse['timing'];
  verification: ProveResponse['verification'];
}

// ─── Step results for step-by-step execution ────────────────────────────

export interface StepResult<T = unknown> {
  step: number;
  name: string;
  data: T;
  durationMs: number;
}
