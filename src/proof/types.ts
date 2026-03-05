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

export interface ProveRequestInputs {
  // Client-computed derived values
  signal_hash: string;         // "0x..." 32 bytes, keccak256(solidityPacked([address, scope, circuitId]))
  nullifier: string;           // "0x..." 32 bytes
  scope_bytes: string;         // "0x..." 32 bytes, keccak256(toUtf8Bytes(scopeString))
  merkle_root: string;         // "0x..." 32 bytes
  user_address: string;        // "0x..." 20 bytes
  signature: string;         // "0x..." eth_sign(signal_hash), 65 bytes
  user_pubkey_x: string;     // "0x..." 32 bytes
  user_pubkey_y: string;     // "0x..." 32 bytes
  raw_transaction: string;   // "0x..." RLP-encoded EAS attestation TX
  tx_length: number;         // actual byte length before padding
  coinbase_attester_pubkey_x: string;  // "0x..." 32 bytes
  coinbase_attester_pubkey_y: string;  // "0x..." 32 bytes
  merkle_proof: string[];    // ["0x...", ...] each 32 bytes
  leaf_index: number;
  depth: number;
  country_list?: string[];   // for country circuit
  is_included?: boolean;     // for country circuit
}

export interface ProveRequest {
  circuit: string;              // Required: "coinbase_kyc" or "coinbase_country"
  inputs?: ProveRequestInputs;  // Required for plaintext flow; absent when encrypted_payload is used
  encrypted_payload?: EncryptedEnvelope;  // E2E: encrypted { circuitId, proverToml } — server acts as blind relay
}

export interface ProveResponse {
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
