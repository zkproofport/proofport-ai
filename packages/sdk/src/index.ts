// Types
export type {
  ClientConfig,
  CircuitName,
  CircuitId,
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

// Canonical circuit identifiers.
// Mirrors @zkproofport-app/sdk/circuits — see ./circuits.ts for why a mirror.
export {
  CIRCUIT_IDS,
  CIRCUIT_SUPPORT_STATUS,
  ALL_CIRCUIT_IDS,
  SUPPORTED_CIRCUIT_IDS,
  PLANNED_CIRCUIT_IDS,
  PROVABLE_CIRCUIT_IDS,
  isCanonicalCircuitId,
  isProvableCircuitId,
  getCircuitSupportStatus,
} from './circuits.js';
export type { CanonicalCircuitId, CircuitSupportStatus } from './circuits.js';

// Constants
export {
  CIRCUITS,
  COINBASE_ATTESTER_CONTRACT,
  AUTHORIZED_SIGNERS,
} from './constants.js';

// Configuration
export { createConfig } from './config.js';

// Flow (main entry point)
export { generateProof } from './flow.js';
export type { FlowCallbacks } from './flow.js';

// Individual steps (for step-by-step usage)
export { requestChallenge, createSession } from './session.js';
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

// Paying for a proof. The wallet and the chain are chosen separately: any of
// the three wallets can pay on any chain the service offers.
export { walletFromPrivateKey, walletFromCdp, walletFromCircle, walletFromEnv, walletFor } from './wallets.js';
export { signPayment, paymentOffers } from './payment.js';
export type { PaymentWallet, PaymentOffer, PaidRequest } from './types.js';
export { CdpWalletSigner } from './cdp.js';
export type { ExternalWallet } from './cdp.js';
export { EthersWalletSigner, fromEthersWallet, fromPrivateKey } from './signer.js';

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

// Checking the EIP-712 action an arc_eligibility proof binds to. Mirrored from
// the customer SDK; see the note in typedAction.ts for why, and
// tests/typedAction.test.ts for the guard that keeps them equal.
export { validateTypedAction } from './typedAction.js';

// Arc nanopayments: deposit into Circle Gateway once, then pay per request for
// almost no gas. See ./nanopayment.ts for why this is separate from the
// ordinary x402 path.
export {
  ARC_GATEWAY_CHAIN,
  gatewayBalance,
  ensureGatewayBalance,
  payWithNanopayments,
  type NanopaymentWallet,
  type GatewayBalances,
} from './nanopayment.js';

// Delegating a credential from the KYC wallet to a second wallet, so the
// second one can act while the first stays hidden. See ./delegation.ts.
export {
  buildDelegationAction,
  delegationActionHash,
  delegationDomainSeparator,
  delegationMatchesProof,
  delegateOf,
  DELEGATION_PRIMARY_TYPE,
  DELEGATION_TYPES,
  type Delegation,
} from './delegation.js';

// Paying from an Arc agent wallet — Circle holds it and its CLI signs.
export {
  walletFromArcAgent,
  listArcAgentWallets,
  createArcAgentWallet,
  ARC_CLI_CHAINS,
  type ArcCliChain,
} from './arcWallet.js';
