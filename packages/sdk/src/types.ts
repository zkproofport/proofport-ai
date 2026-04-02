// ─── Circuit name mappings ──────────────────────────────────────────────

/** Client-friendly circuit aliases. */
export type CircuitName = 'coinbase_kyc' | 'coinbase_country' | 'oidc_domain';

/** Canonical circuit IDs matching Nargo.toml names. */
export type CircuitId = 'coinbase_attestation' | 'coinbase_country_attestation' | 'oidc_domain_attestation';

/** Map client-friendly names to canonical circuit IDs. */
export const CIRCUIT_NAME_MAP: Record<CircuitName, CircuitId> = {
  coinbase_kyc: 'coinbase_attestation',
  coinbase_country: 'coinbase_country_attestation',
  oidc_domain: 'oidc_domain_attestation',
};

/** Map canonical circuit IDs back to client-friendly names. */
export const CIRCUIT_ID_MAP: Record<CircuitId, CircuitName> = {
  coinbase_attestation: 'coinbase_kyc',
  coinbase_country_attestation: 'coinbase_country',
  oidc_domain_attestation: 'oidc_domain',
};

// ─── Configuration ──────────────────────────────────────────────────────

export interface ClientConfig {
  /** proofport-ai server URL (e.g. https://stg-ai.zkproofport.app) */
  baseUrl: string;
  /** x402 facilitator URL for payment settlement */
  facilitatorUrl?: string;
  /** Optional headers for facilitator auth (e.g., CDP Bearer token) */
  facilitatorHeaders?: Record<string, string>;
}

// ─── Payment ────────────────────────────────────────────────────────────

export interface PaymentInfo {
  nonce: string;
  recipient: string;
  amount: number;
  asset: string;
  network: string;
  instruction: string;
}

// ─── x402 Challenge (402 response from POST /prove) ─────────────────────

export interface PaymentRequirements {
  scheme: string;
  network: string;
  maxAmountRequired: string;
  resource: string;
  description: string;
  mimeType: string;
  payTo: string;
  extra: { name: string; version: string; nonce: string };
}

export interface ChallengeResponse {
  error: string;
  message: string;
  nonce: string;
  /** false when server PAYMENT_MODE=disabled — skip payment step entirely */
  requiresPayment?: boolean;
  payment: PaymentRequirements;
  facilitatorUrl?: string;
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
    paymentVerifyMs?: number;
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
  proof: string;
  publicInputs: string;
  proofWithInputs: string;
  paymentTxHash: string;
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
