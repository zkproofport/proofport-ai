// ─── Circuit name mappings ──────────────────────────────────────────────

import { CIRCUIT_IDS, PROVABLE_CIRCUIT_IDS } from './circuits.js';
import type { ActionApproval } from './actionApproval.js';
import type { TypedAction as CoreTypedAction } from '@zkproofport-app/core/typedAction';

/** Client-friendly circuit aliases. */
export type CircuitName =
  | 'coinbase_kyc'
  | 'coinbase_country'
  | 'oidc_domain'
  /** GIWA account attestation, optionally binding one EIP-712 action. */
  | 'giwa_attestation'
  /** Human Passport score at or above a threshold, optionally binding one EIP-712 action. */
  | 'human_passport';

/**
 * Canonical circuit IDs this server can prove.
 *
 * Derived from `PROVABLE_CIRCUIT_IDS` in `./circuits.js`, which is itself built
 * from the canonical identifiers owned by `@zkproofport-app/core/circuits`, so
 * a rename there becomes a compile error instead of a silent divergence.
 */
export type CircuitId = (typeof PROVABLE_CIRCUIT_IDS)[number];

/** Map client-friendly names to canonical circuit IDs. */
export const CIRCUIT_NAME_MAP: Record<CircuitName, CircuitId> = {
  coinbase_kyc: CIRCUIT_IDS.COINBASE_ATTESTATION,
  coinbase_country: CIRCUIT_IDS.COINBASE_COUNTRY_ATTESTATION,
  oidc_domain: CIRCUIT_IDS.OIDC_DOMAIN_ATTESTATION,
  giwa_attestation: CIRCUIT_IDS.GIWA_ATTESTATION,
  human_passport: CIRCUIT_IDS.HUMAN_PASSPORT_SCORE,
};

/** Map canonical circuit IDs back to client-friendly names. */
export const CIRCUIT_ID_MAP: Record<CircuitId, CircuitName> = {
  [CIRCUIT_IDS.COINBASE_ATTESTATION]: 'coinbase_kyc',
  [CIRCUIT_IDS.COINBASE_COUNTRY_ATTESTATION]: 'coinbase_country',
  [CIRCUIT_IDS.OIDC_DOMAIN_ATTESTATION]: 'oidc_domain',
  [CIRCUIT_IDS.GIWA_ATTESTATION]: 'giwa_attestation',
  [CIRCUIT_IDS.HUMAN_PASSPORT_SCORE]: 'human_passport',
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
  /**
   * False when the service is running with payment disabled. The nonce is
   * still real and still single-use in that case -- it is replay protection,
   * not a payment receipt -- so the flow is identical apart from the paying.
   */
  requiresPayment?: boolean;
  /**
   * The chains this service will take payment on, one entry each, in the
   * order it prefers. Read it to choose; pass a chain to `signPayment` to
   * pay on it.
   */
  accepts?: Array<Record<string, unknown>>;
}

// ─── Prove (POST /prove) ────────────────────────────────────────────────

export interface ProveInputs {
  signal_hash: string;
  /** EIP-712 domain hash. Present only when `action` was supplied. */
  domain_separator?: string;
  /** EIP-712 hashStruct of the action. Present only when `action` was supplied. */
  action_hash?: string;
  /**
   * The OPRF nullifier's values (oprf/index.ts evaluateOprf), each 0x + 64 hex:
   * public oprf_key_hash, domain, scope, nullifier; private the network's
   * public key, the blinding factor, the combined DLog proof and the unblinded
   * answer. The circuit checks all of them.
   */
  oprf_key_hash: string;
  domain: string;
  scope: string;
  nullifier: string;
  oprf_public_key_x: string;
  oprf_public_key_y: string;
  oprf_beta: string;
  oprf_dlog_e: string;
  oprf_dlog_s: string;
  oprf_response_x: string;
  oprf_response_y: string;
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

/**
 * What `human_passport` sends: the wallet's signed request and the threshold.
 * The server finds the wallet's Human Passport score on Base itself.
 */
export interface HumanPassportProveInputs {
  signal_hash: string;
  domain_separator?: string;
  action_hash?: string;
  /**
   * The OPRF nullifier's values (oprf/index.ts evaluateOprf), each 0x + 64 hex:
   * public oprf_key_hash, domain, scope, nullifier; private the network's
   * public key, the blinding factor, the combined DLog proof and the unblinded
   * answer. The circuit checks all of them.
   */
  oprf_key_hash: string;
  domain: string;
  scope: string;
  nullifier: string;
  oprf_public_key_x: string;
  oprf_public_key_y: string;
  oprf_beta: string;
  oprf_dlog_e: string;
  oprf_dlog_s: string;
  oprf_response_x: string;
  oprf_response_y: string;
  user_address: string;
  signature: string;
  user_pubkey_x: string;
  user_pubkey_y: string;
  /** Threshold in Passport points (20 = 20.0). */
  min_score: number;
  /** Chain id the score is recorded on (core HUMAN_PASSPORT_CHAIN_IDS). */
  chain: number;
}

export interface ProveRequest {
  circuit: CircuitName;
  inputs?: ProveInputs | HumanPassportProveInputs | Record<string, unknown>;
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
  /**
   * What the server says about the verifier. `verifyProof` treats it as a
   * claim: the chain selects ZKProofport's pinned verifier, the address must
   * equal it, and `rpcUrl` is never used to verify.
   */
  verification: {
    chainId: number;
    verifierAddress: string;
    rpcUrl?: string;
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

/**
 * An EIP-712 typed structure, exactly as `eth_signTypedData_v4` takes it.
 *
 * The caller owns every field here. This SDK keeps no registry of action
 * shapes and never invents one: it hands the structure to the wallet, which
 * renders the named fields for the person to read, and passes the two
 * resulting 32-byte hashes to the circuit.
 *
 * Do NOT include an `EIP712Domain` entry in `types` -- ethers adds it, and
 * passing it yourself produces a different hash than the wallet computes.
 *
 * A single free-form string is a valid shape:
 *
 *   types: { Agreement: [{ name: 'terms', type: 'string' }] },
 *   primaryType: 'Agreement',
 *   message: { terms: 'Deposit 10 USDC into the KYC-gated vault' }
 *
 * A contract cannot enforce prose, though -- to check an amount on-chain the
 * amount has to be its own field.
 */
export type TypedAction = CoreTypedAction;

/** Terms explicitly accepted by a user; nonce is intentionally not pinned. */
export interface ApprovedPayment {
  network:string;scheme:string;amount:string;asset:string;payTo:string;
  /** Exact EIP-3009: verifyingContract = asset. */
  extra:{name:string;version:string;verifyingContract:string};
}

export interface ProofParams {
  circuit: CircuitName;
  /**
   * Which chain to pay on, when the service charges. Either the CAIP-2 id
   * (`eip155:84532`) or the plain name (`base-sepolia`).
   *
   * Omitting it takes the first chain the service offers. Naming a chain it
   * does not offer is an error listing what it does -- never a quiet fall
   * back to the first, which would spend money somewhere the caller did not
   * choose and report success.
   */
  payOn?: string;
  approvedPayment?: ApprovedPayment;
  maxPayment?: string;
  /**
   * Required: what the proof is for within the service (e.g. "myapp:membership").
   * Wallet circuits: 1 to 256 UTF-8 bytes, no control or format characters;
   * the nullifier is one per wallet per (oprfDomain, scope). No default.
   */
  scope?: string;
  /**
   * Required for every wallet circuit (coinbase_kyc, coinbase_country,
   * giwa_attestation, human_passport): the name of the service the proof is
   * for, usually its host (e.g. "app.example.com"). The nullifier is one per
   * wallet per (oprfDomain, scope), so each service has its own namespace and
   * two services cannot link one wallet's proofs. 1 to 256 UTF-8 bytes, no
   * control or format characters, used exactly as given (no trimming).
   * Omitted: in a browser on an http(s) page, the page's hostname
   * (lowercased); anywhere else (a server, Node) the proof is refused. Give
   * it, with the scope, to whoever verifies the proof. Not used by oidc_domain.
   */
  oprfDomain?: string;
  /** Country codes for the country circuit (e.g. ["US", "KR"]) */
  countryList?: string[];
  /** Whether the country list is an inclusion or exclusion list */
  isIncluded?: boolean;
  /**
   * Required for human_passport: the score threshold in Passport points
   * (e.g. 20; above 0, at most four decimals). The proof carries it.
   */
  minScore?: number;
  /**
   * Required for human_passport: the chain id the person recorded their
   * score on (8453 Base, 10 OP Mainnet, 42161 Arbitrum One, 59144 Linea,
   * 534352 Scroll, 324 zkSync Era). No default: a score lives only
   * on the chain its owner chose.
   */
  chain?: number;
  /** JWT token for OIDC circuit (oidc_domain) */
  jwt?: string;
  /** OIDC provider: 'google' (default) or 'microsoft' for Microsoft 365 */
  provider?: 'google' | 'microsoft';

  /**
   * Optional for coinbase_attestation, coinbase_country_attestation and
   * giwa_attestation; rejected for every other circuit, including OIDC.
   * A human wallet must approve these exact EIP-712 fields. generateProof throws
   * ActionApprovalRequiredError with a resumable handle until approval is ready.
   * The supplied attestation signer is never used for actions.
   * The relying contract must compare the domain/action hashes
   * and enforce the approved actor, amount, nonce and deadline.
   * Coinbase circuits without an action use personal_sign; OIDC does not sign.
   */
  action?: TypedAction;
  /** Private handle returned by ActionApprovalRequiredError; resume the same action with it. */
  actionApproval?: ActionApproval;
  /**
   * The id of the request this proof answers, when the relying party issued
   * one (ASCII letters, digits and '-', at most 128 characters). Without an
   * action the wallet signs signal_hash = keccak256(scope ++ circuitId ++
   * requestId), so the relying party can recompute it and refuse a proof made
   * for another request. Omitted: a fresh lowercase UUID v4 is minted for this
   * proof and returned as {@link ProofResult.requestId}.
   */
  requestId?: string;
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
  /**
   * The request this proof answers and its scope. Hand both to the verifier
   * (`verifyProof(result, { request: { scope, requestId } })`): a proof
   * without an action carries keccak256(scope ++ circuitId ++ requestId).
   * Absent for OIDC, which binds no wallet signature.
   */
  requestId?: string;
  scope?: string;
  /** The OPRF domain the nullifier is under; present for wallet circuits. Hand it to the verifier with the scope. */
  oprfDomain?: string;
}

// ─── Step results for step-by-step execution ────────────────────────────

export interface StepResult<T = unknown> {
  step: number;
  name: string;
  data: T;
  durationMs: number;
}


/**
 * A wallet that can pay for a proof: an address and the ability to sign one
 * EIP-712 message. Deliberately nothing more -- see `wallets.ts` for why
 * paying needs no transaction, no gas and no chain of its own.
 *
 * Structurally `ClientEvmSigner` from `@x402/evm`, so a viem account or
 * Coinbase's `fromCdpEvmAccount` result satisfies it as-is.
 */
export interface PaymentWallet {
  /** On-chain USDC owner (an EOA or an ERC-1271 smart wallet). */
  address: `0x${string}`;
  signTypedData(message: {
    domain: Record<string, unknown>;
    types: Record<string, unknown>;
    primaryType: string;
    message: Record<string, unknown>;
  }): Promise<`0x${string}`>;
  /** A line naming this wallet for a log or a CLI, without its secrets. */
  describe(): string;
}

/** One chain a service will take payment on, from its 402 answer. */
export interface PaymentOffer {
  /** CAIP-2, e.g. `eip155:84532`. */
  network: string;
  /** The plain name, e.g. `base-sepolia`. */
  networkName: string;
  /** Price in that chain's USDC, in the token's own units. */
  amount: string;
  /** The USDC contract the payment must be in. */
  asset: string;
  payTo: string;
  /** The requirement as the service sent it, passed to the signer untouched. */
  raw: Record<string, unknown>;
}

/** A signed payment, ready to be sent back with the proof request. */
export interface PaidRequest {
  headers: Record<string, string>;
  paidOn: string;
  amount: string;
  payer: string;
}
