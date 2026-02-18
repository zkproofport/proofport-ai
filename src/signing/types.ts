export type SigningMethod = 'privy' | 'web' | 'eip7702';

export interface SigningRequest {
  address: string;       // KYC'd wallet address (0x...)
  signalHash: string;    // Hash to sign (computed by inputBuilder)
  scope: string;         // Nullifier scope
  method: SigningMethod; // Which signing method to use
}

export interface SigningResult {
  signature: string;  // 64 bytes (r + s) hex-encoded
  address: string;    // Signer address (must match KYC address)
  method: SigningMethod;
}

export interface SigningProvider {
  /** The signing method this provider implements */
  readonly method: SigningMethod;

  /**
   * Sign a signal hash using this provider's method.
   * @throws Error if signing fails or address doesn't match
   */
  sign(request: SigningRequest): Promise<SigningResult>;

  /**
   * Check if this provider can sign for the given address.
   * For Privy: checks if address has an embedded wallet with delegated actions.
   * For Web: always true (any address can use WalletConnect).
   * For EIP-7702: checks if address has pre-signed signatures in pool.
   */
  isAvailable(address: string): Promise<boolean>;
}

export interface SigningRequestRecord {
  id: string;              // UUID
  address?: string;        // Signer address (set when user connects wallet on sign-page)
  signalHash?: string;     // Hash to sign (computed after address is known)
  scope: string;           // Nullifier scope
  circuitId: string;       // Circuit identifier (needed to compute signalHash)
  status: 'pending' | 'completed' | 'expired';
  signature?: string;      // Filled when completed
  createdAt: string;       // ISO timestamp
  expiresAt: string;       // ISO timestamp (TTL)
  paymentStatus?: 'pending' | 'completed';  // x402 payment tracking
  paymentTxHash?: string;                   // On-chain tx hash when paid
}
