// Types
export type {
  ClientConfig,
  CircuitName,
  CircuitId,
  PaymentInfo,
  PaymentRequirements,
  ChallengeResponse,
  ProveInputs,
  ProveRequest,
  ProveResponse,
  VerifyResult,
  EASAttestation,
  AttestationData,
  ProofParams,
  ProofResult,
  StepResult,
} from './types.js';

export { CIRCUIT_NAME_MAP, CIRCUIT_ID_MAP } from './types.js';

// Constants
export {
  CIRCUITS,
  COINBASE_ATTESTER_CONTRACT,
  AUTHORIZED_SIGNERS,
  USDC_ADDRESSES,
} from './constants.js';

// Configuration
export { createConfig } from './config.js';

// Flow (main entry point)
export { generateProof } from './flow.js';
export type { FlowCallbacks } from './flow.js';

// Individual steps (for step-by-step usage)
export { requestChallenge, createSession } from './session.js';
export { makePayment } from './payment.js';
export { submitProof, submitEncryptedProof } from './prove.js';
export { verifyProof } from './verify.js';

// Input computation (customer-facing helpers)
export {
  prepareInputs,
  computeSignalHash,
  computeScope,
  computeNullifier,
} from './inputs.js';

// OIDC: SDK fetches JWKS, TEE validates JWT + builds circuit inputs
export { prepareOidcInputs, prepareOidcPayload } from './oidc-inputs.js';
export type { OidcCircuitInputs, OidcProvePayload, PrepareOidcParams } from './oidc-inputs.js';

// Signer abstraction
export type { ProofportSigner } from './signer.js';
export { EthersWalletSigner, fromEthersWallet, fromPrivateKey } from './signer.js';

// CDP (Coinbase Developer Platform) signer
export { CdpWalletSigner, fromExternalWallet } from './cdp.js';
export type { ExternalWallet } from './cdp.js';

// Extraction helpers (parse publicInputs from proof results)
export {
  extractDomainFromPublicInputs,
  extractScopeFromPublicInputs,
  extractNullifierFromPublicInputs,
} from './extract.js';

// Attestation (customer-facing helpers)
export {
  fetchAttestation,
  getSignerAddress,
} from './attestation.js';
