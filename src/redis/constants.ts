/**
 * Central TTL constants for all Redis keys.
 * Change values here — all consumers reference these.
 */

/** Proof result (verification/download page). */
export const PROOF_RESULT_TTL = 86400; // 24 hours

/** Proof cache (same inputs → skip TEE/bb regeneration). */
export const PROOF_CACHE_TTL = 3600; // 1 hour
