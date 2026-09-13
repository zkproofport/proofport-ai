// ─── Circuit name mappings ──────────────────────────────────────────────

import { CIRCUIT_IDS, PROVABLE_CIRCUIT_IDS } from './circuits.js';

/** Client-friendly circuit aliases. */
export type CircuitName =
  | 'coinbase_kyc'
  | 'coinbase_country'
  | 'oidc_domain'
  /** Coinbase KYC, with the signature bound to one EIP-712 action. */
  | 'arc_eligibility';

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
  arc_eligibility: CIRCUIT_IDS.ARC_ELIGIBILITY,
};

/** Map canonical circuit IDs back to client-friendly names. */
export const CIRCUIT_ID_MAP: Record<CircuitId, CircuitName> = {
  [CIRCUIT_IDS.COINBASE_ATTESTATION]: 'coinbase_kyc',
  [CIRCUIT_IDS.COINBASE_COUNTRY_ATTESTATION]: 'coinbase_country',
  [CIRCUIT_IDS.OIDC_DOMAIN_ATTESTATION]: 'oidc_domain',
  [CIRCUIT_IDS.ARC_ELIGIBILITY]: 'arc_eligibility',
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
export interface TypedAction {
  domain: {
    name: string;
    version: string;
    chainId: number;
    /** The contract that will verify this signature. Binds it to one address. */
    verifyingContract: string;
  };
  types: Record<string, Array<{ name: string; type: string }>>;
  primaryType: string;
  message: Record<string, unknown>;
}

/** Terms explicitly accepted by a user; nonce is intentionally not pinned. */
export interface ApprovedPayment {
  network:string;scheme:string;amount:string;asset:string;payTo:string;
  extra:{name:string;version:string;verifyingContract:string};
}

export interface ProofParams {
  circuit: CircuitName;
  /**
   * Which chain to pay on, when the service charges. Either the CAIP-2 id
   * (`eip155:5042002`) or the plain name (`arc-testnet`).
   *
   * Omitting it takes the first chain the service offers. Naming a chain it
   * does not offer is an error listing what it does -- never a quiet fall
   * back to the first, which would spend money somewhere the caller did not
   * choose and report success.
   */
  payOn?: string;
  approvedPayment?: ApprovedPayment;
  maxPayment?: string;
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

  /**
   * Bind this proof to one action.
   *
   * WITHOUT it the wallet signs `signal_hash` through personal_sign, exactly
   * as every existing caller does today: the signature asserts "this wallet is
   * KYC'd for this scope" and commits to no contract, amount, caller or
   * deadline, and the wallet can only show the person 32 opaque bytes.
   *
   * WITH it the wallet signs the typed structure instead, so the person reads
   * named fields before approving, and the verifying contract recomputes the
   * same two hashes from the call it is about to run. A proof produced for one
   * contract no longer verifies at another.
   *
   * Omitting it keeps the old behaviour, so existing callers need no change.
   */
  action?: TypedAction;
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


/**
 * A wallet that can pay for a proof: an address and the ability to sign one
 * EIP-712 message. Deliberately nothing more -- see `wallets.ts` for why
 * paying needs no transaction, no gas and no chain of its own.
 *
 * Structurally `ClientEvmSigner` from `@x402/evm`, so a viem account or
 * Coinbase's `fromCdpEvmAccount` result satisfies it as-is.
 */
export interface PaymentWallet {
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
  /** CAIP-2, e.g. `eip155:5042002`. */
  network: string;
  /** The plain name, e.g. `arc-testnet`. */
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
