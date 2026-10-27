import { OIDC_DOMAIN_ATTESTATION_PUBLIC_INPUT_LAYOUT as L, oidcAudienceHash } from '@zkproofport-app/core';

/** Google's device-flow client: the audience the AI SDK/MCP sign-in gets tokens for. */
export const GOOGLE_DEVICE_CLIENT = '491923400813-pr17m6kpin2rsbbes18jpb60j1s3qmv4.apps.googleusercontent.com';

export interface OidcV2InputOverrides {
  /** Total number of fields; 214 for v2. */
  count?: number;
  provider?: number;
  aud?: string;
  nonceMode?: number;
  /** 32 bytes as 64 hex chars without 0x. */
  binding?: string;
  /** Unix seconds. Defaults to the current clock. */
  now?: number;
}

const field = (v: bigint | number) => BigInt(v).toString(16).padStart(64, '0');

/**
 * Concatenated public inputs (0x + 64 hex per field) of an OIDC v2 proof with
 * a well-formed 2048-bit modulus no provider publishes. With no overrides it
 * passes core's OIDC policy (device client aud, mode 0, zero binding, fresh
 * now), so a verifier refuses it only at the provider-key check.
 */
export function oidcV2Inputs(o: OidcV2InputOverrides = {}): string {
  const count = o.count ?? 214;
  const fields: bigint[] = Array.from({ length: count }, () => 0n);
  for (let i = L.PUBKEY_MODULUS_START; i < L.PUBKEY_MODULUS_END && i < count; i++) fields[i] = 1n;
  if (L.PUBKEY_MODULUS_END < count) fields[L.PUBKEY_MODULUS_END] = 0xffn;
  if (L.PROVIDER < count) fields[L.PROVIDER] = BigInt(o.provider ?? 0);
  if (count > L.NOW) {
    const aud = oidcAudienceHash(o.aud ?? GOOGLE_DEVICE_CLIENT);
    for (let i = 0; i < 32; i++) fields[L.AUD_HASH_START + i] = BigInt(parseInt(aud.slice(2 * i, 2 * i + 2), 16));
    fields[L.NONCE_MODE] = BigInt(o.nonceMode ?? 0);
    const binding = o.binding ?? '00'.repeat(32);
    for (let i = 0; i < 32; i++) fields[L.NONCE_BINDING_START + i] = BigInt(parseInt(binding.slice(2 * i, 2 * i + 2), 16));
    fields[L.NOW] = BigInt(o.now ?? Math.floor(Date.now() / 1000));
  }
  return '0x' + fields.map(field).join('');
}

/** The same inputs as a bytes32 array, the shape the server verifier takes. */
export function oidcV2InputArray(o: OidcV2InputOverrides = {}): string[] {
  const hex = oidcV2Inputs(o).slice(2);
  const out: string[] = [];
  for (let i = 0; i < hex.length; i += 64) out.push('0x' + hex.slice(i, i + 64));
  return out;
}
