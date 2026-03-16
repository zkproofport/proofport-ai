/**
 * OIDC input types and re-exports.
 *
 * Types are declared locally to avoid rootDir issues with importing
 * from packages/sdk/src/. Runtime functions are dynamically loaded
 * from the compiled SDK dist.
 */

// ─── Types (must match packages/sdk/src/oidc-inputs.ts) ─────────────

export interface OidcCircuitInputs {
  pubkey_modulus_limbs: string[];
  domain: { storage: number[]; len: number };
  scope: number[];
  nullifier: number[];
  partial_data: { storage: number[]; len: number };
  partial_hash: number[];
  full_data_length: number;
  base64_decode_offset: number;
  redc_params_limbs: string[];
  signature_limbs: string[];
}

export interface PrepareOidcParams {
  jwt: string;
  scope: string;
  domain?: string;
  jwksUrl?: string;
}

// ─── Runtime imports from compiled SDK ──────────────────────────────

// Use dynamic path resolution to avoid TS rootDir constraint
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

// eslint-disable-next-line @typescript-eslint/no-var-requires
const sdkOidc = require('../../packages/sdk/dist/oidc-inputs.js') as {
  prepareOidcInputs: (params: PrepareOidcParams) => Promise<OidcCircuitInputs>;
  buildOidcProverToml: (inputs: OidcCircuitInputs) => string;
};

export const prepareOidcInputs = sdkOidc.prepareOidcInputs;
export const buildOidcProverToml = sdkOidc.buildOidcProverToml;
