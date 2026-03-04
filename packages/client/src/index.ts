// Types
export type {
  ClientConfig,
  WalletConfig,
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
  VERIFIER_ADDRESSES,
  USDC_ADDRESSES,
} from './constants.js';

// Flow (main entry point)
export { generateProof, verifyProof } from './flow.js';
export type { FlowCallbacks } from './flow.js';

// Individual steps (for step-by-step usage)
export { requestChallenge, createSession } from './session.js';
export { makePayment } from './payment.js';
export { submitProof } from './prove.js';
export { verifyOnChain } from './verify.js';

// Input computation
export {
  prepareInputs,
  computeSignalHash,
  computeScope,
  computeNullifier,
  recoverUserPubkey,
  hexToBytes,
  extractPubkeyCoordinates,
} from './inputs.js';

// Signer abstraction
export type { ProofportSigner } from './signer.js';
export { EthersWalletSigner, fromEthersWallet, fromPrivateKey } from './signer.js';

// Attestation
export {
  fetchAttestation,
  fetchAttestationFromEAS,
  fetchRawTransaction,
  recoverAttesterPubkey,
  getSignerAddress,
} from './attestation.js';

// Merkle
export {
  SimpleMerkleTree,
  findSignerIndex,
  buildSignerMerkleTree,
} from './merkle.js';
