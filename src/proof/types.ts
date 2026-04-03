import type { CircuitId } from '../config/circuits.js';
import type { EncryptedEnvelope } from '../tee/teeKeyExchange.js';

export type ProofSessionStatus = 'PAYMENT_PENDING' | 'PROVING' | 'COMPLETED' | 'EXPIRED';

export interface ProofSession {
  session_id: string;
  status: ProofSessionStatus;
  circuit: CircuitId;
  payment_nonce: string;     // random hex for USDC data field binding
  payment_tx_hash?: string;  // filled after payment verification
  created_at: string;        // ISO timestamp
  expires_at: string;        // ISO timestamp (created_at + 10min)
}

export interface PaymentInfo {
  nonce: string;             // random nonce to embed in USDC transfer data
  recipient: string;         // "0x..." prover agent wallet (payTo)
  amount: number;            // USDC base units (e.g. 100000 for $0.10)
  asset: string;             // USDC contract address
  network: string;           // "base-sepolia" | "base"
  instruction: string;       // human-readable instruction
}

// Coinbase circuit inputs (coinbase_attestation, coinbase_country_attestation)
export interface CoinbaseProveInputs {
  signal_hash: string;         // "0x..." 32 bytes
  nullifier: string;           // "0x..." 32 bytes
  scope_bytes: string;         // "0x..." 32 bytes
  merkle_root: string;         // "0x..." 32 bytes
  user_address: string;        // "0x..." 20 bytes
  signature: string;           // "0x..." 65 bytes
  user_pubkey_x: string;       // "0x..." 32 bytes
  user_pubkey_y: string;       // "0x..." 32 bytes
  raw_transaction: string;     // "0x..." RLP-encoded EAS attestation TX
  tx_length: number;
  coinbase_attester_pubkey_x: string;
  coinbase_attester_pubkey_y: string;
  merkle_proof: string[];
  leaf_index: number;
  depth: number;
  country_list?: string[];     // for country circuit
  is_included?: boolean;       // for country circuit
}

// OIDC circuit inputs (oidc_domain_attestation)
export interface OidcProveInputs {
  pubkey_modulus_limbs: string[];
  signature: string[];
  scope: string;
  nullifier: string;
  domain: string;
  [key: string]: unknown;      // allow additional OIDC fields
}

// Server is a blind relay — accepts any structured inputs
export type ProveRequestInputs = CoinbaseProveInputs | OidcProveInputs;

export interface ProveRequest {
  circuit: string;              // Required: "coinbase_kyc", "coinbase_country", or "oidc_domain"
  inputs?: ProveRequestInputs;  // Required for plaintext flow; absent when encrypted_payload is used
  encrypted_payload?: EncryptedEnvelope;  // E2E: encrypted { circuitId, inputs } — server acts as blind relay
}

export interface ProveResponse {
  circuit: string;            // circuit ID (e.g. "coinbase_attestation", "oidc_domain_attestation")
  proofType: string;          // semantic type (e.g. "kyc", "country", "google", "google_workspace", "microsoft_365")
  proof: string;              // "0x..." raw proof
  publicInputs: string;      // "0x..." concatenated bytes32
  proofWithInputs: string;   // "0x..." for on-chain verify

  attestation: {
    document: string;         // base64 COSE Sign1
    proof_hash: string;       // sha256(proof)
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

export interface PaymentVerificationResult {
  valid: boolean;
  error?: string;
  reason?: 'tx_not_found' | 'tx_pending' | 'tx_reverted' | 'wrong_recipient' | 'insufficient_amount' | 'nonce_missing' | 'nonce_mismatch';
}
