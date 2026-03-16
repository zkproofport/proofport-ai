/**
 * TEE (Trusted Execution Environment) type definitions
 */

import type { EncryptedEnvelope, TeePublicKeyInfo } from './teeKeyExchange.js';

/**
 * TeeMode defines the proof generation environment
 * - disabled: TEE not used, proofs generated locally via bbProver
 * - local: Simulated TEE for development/testing (same prover, but with TEE interface)
 * - nitro: AWS Nitro Enclave (production)
 */
export type TeeMode = 'auto' | 'disabled' | 'local' | 'nitro';
export type ResolvedTeeMode = 'disabled' | 'local' | 'nitro';

/**
 * TEE configuration
 */
export interface TeeConfig {
  mode: TeeMode;
  enclaveCid?: number; // Nitro Enclave CID (vsock address), required for nitro mode
  enclavePort?: number; // vsock port, default 5000
  enclaveBridgePort?: number; // TCP bridge port for vsock proxy, default 15000
  attestationEnabled: boolean;
}

/**
 * Configuration for building an enclave image
 */
export interface EnclaveImageConfig {
  circuits: string[]; // circuit IDs to include
  proverBinaryPath: string;
  circuitArtifactsDir: string;
  outputPath: string; // .eif file path
}

/**
 * Request sent to enclave via vsock
 */
export interface VsockRequest {
  type: 'prove' | 'health' | 'getPublicKey';
  circuitId?: string;
  inputs?: Record<string, any>; // Structured circuit inputs (coinbase: CircuitParams-like, OIDC: OidcCircuitInputs)
  encryptedPayload?: EncryptedEnvelope; // E2E encrypted payload for TEE
  requestId: string;
}

/**
 * Response received from enclave via vsock
 */
export interface VsockResponse {
  type: 'proof' | 'health' | 'error' | 'publicKey';
  requestId: string;
  proof?: string;
  publicInputs?: string[];
  attestationDocument?: string; // base64-encoded COSE Sign1
  error?: string;
  publicKey?: string;  // hex-encoded X25519 public key
  keyId?: string;      // key rotation identifier
}

/**
 * Attestation document from Nitro Enclave
 */
/**
 * Attestation result attached to proof responses
 */
export interface AttestationResult {
  document: string;          // base64-encoded attestation document
  mode: ResolvedTeeMode;     // 'local' | 'nitro' | 'disabled'
  proofHash: string;         // keccak256 of proof bytes
  timestamp: number;         // Unix timestamp
}

export interface AttestationDocument {
  moduleId: string;
  digest: 'SHA384';
  timestamp: number;
  pcrs: Map<number, Buffer>; // PCR0=image, PCR1=kernel, PCR2=app
  certificate: Buffer;
  cabundle: Buffer[];
  publicKey?: Buffer; // TEE self-key (ephemeral)
  userData?: Buffer;
  nonce?: Buffer;
}

/**
 * TEE provider interface for proof generation
 */
export interface TeeProvider {
  readonly mode: TeeMode;
  prove(circuitId: string, inputs: Record<string, any>, requestId: string): Promise<VsockResponse>;
  proveEncrypted(encryptedPayload: EncryptedEnvelope, requestId: string): Promise<VsockResponse>;
  healthCheck(): Promise<boolean>;
  getAttestation(): Promise<AttestationDocument | null>;
  generateAttestation(proofHash: string, metadata?: Record<string, unknown>): Promise<AttestationResult | null>;
  getTeePublicKey(): Promise<TeePublicKeyInfo | null>;
}
