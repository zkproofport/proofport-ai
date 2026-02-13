/**
 * TEE module entry point
 * Provides factory functions for creating TEE providers and reading configuration
 */

import type { TeeConfig, TeeProvider, TeeMode, VsockResponse, AttestationDocument } from './types.js';
import { EnclaveClient } from './enclaveClient.js';

/**
 * Get TEE configuration from environment variables
 * @returns TEE configuration
 */
export function getTeeConfig(): TeeConfig {
  const mode = (process.env.TEE_MODE || 'disabled') as TeeMode;

  // Validate mode
  const validModes: TeeMode[] = ['auto', 'disabled', 'local', 'nitro'];
  const teeMode = validModes.includes(mode) ? mode : 'disabled';

  const enclaveCid = process.env.ENCLAVE_CID ? parseInt(process.env.ENCLAVE_CID, 10) : undefined;
  const enclavePort = process.env.ENCLAVE_PORT ? parseInt(process.env.ENCLAVE_PORT, 10) : 5000;
  const attestationEnabled = process.env.TEE_ATTESTATION === 'true';

  return {
    mode: teeMode,
    enclaveCid: isNaN(enclaveCid as number) ? undefined : enclaveCid,
    enclavePort: isNaN(enclavePort) ? 5000 : enclavePort,
    attestationEnabled,
  };
}

/**
 * Disabled TEE provider (no-op)
 */
class DisabledProvider implements TeeProvider {
  readonly mode: TeeMode = 'disabled';

  async prove(): Promise<VsockResponse> {
    return {
      type: 'error',
      requestId: '',
      error: 'TEE is disabled - proof generation not available',
    };
  }

  async healthCheck(): Promise<boolean> {
    return false;
  }

  async getAttestation(): Promise<AttestationDocument | null> {
    return null;
  }

  async generateAttestation(): Promise<import('./types.js').AttestationResult | null> {
    return null;
  }
}

/**
 * Create TEE provider based on configuration
 * @param config TEE configuration
 * @returns TEE provider instance
 */
export function createTeeProvider(config: TeeConfig): TeeProvider {
  if (config.mode === 'disabled') {
    return new DisabledProvider();
  }

  return new EnclaveClient(config);
}

// Re-export types
export type { TeeConfig, TeeProvider, TeeMode, ResolvedTeeMode, AttestationResult, AttestationDocument } from './types.js';
export { detectTeeEnvironment, resolveTeeMode } from './detect.js';
export { EnclaveClient } from './enclaveClient.js';
export { parseAttestationDocument, verifyAttestationDocument } from './attestation.js';
export type {
  AttestationVerificationOptions,
  AttestationVerificationResult,
} from './attestation.js';
export {
  generateEncryptionKey,
  encryptProofData,
  decryptProofData,
} from './encryption.js';
export type { EncryptedProofData, DecryptedProofData } from './encryption.js';
export {
  validateEnclaveImageConfig,
  generateBuildCommands,
  generateDockerfileContent,
} from './enclaveBuilder.js';
export { ensureAgentValidated } from './validationSubmitter.js';
