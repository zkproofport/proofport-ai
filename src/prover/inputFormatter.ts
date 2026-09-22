/**
 * inputFormatter.ts — Convert CircuitParams and OidcCircuitInputs to noir_js input format.
 *
 * noir_js expects a JS object where field names match the circuit's main() parameter names.
 * Values are hex strings ("0x...") for byte arrays, or string numbers for scalars.
 */

import type { CircuitParams } from '../input/inputBuilder.js';
import { CIRCUIT_IDS, type CircuitId } from '../config/circuitIds.js';
import { circuitActionBinding } from '@zkproofport-app/sdk/circuits';

/**
 * The circuits built from an on-chain attestation: everything this server can
 * prove except OIDC, which starts from a JWT and has its own formatter.
 *
 * Written as an exclusion rather than a list of three, because it WAS a list
 * of three -- coinbase, country, arc -- and giwa_attestation was added to the
 * server without being added here. The circuit takes `action_hash`, the list
 * did not know giwa existed, and every GIWA request died inside noir_js with
 * "Expected argument `action_hash`, but none was found".
 */
export type AttestationCircuitId = Exclude<CircuitId, typeof CIRCUIT_IDS.OIDC_DOMAIN_ATTESTATION>;

// ─── OIDC Circuit Inputs ────────────────────────────────────────────────

export interface OidcCircuitInputs {
  // Public inputs
  pubkey_modulus_limbs: string[];   // 18 × u128 decimal strings
  domain: { storage: number[]; len: number };
  scope: number[];                  // 32 bytes
  nullifier: number[];              // 32 bytes
  provider: number;              // 0=Google, 1=Microsoft

  // Private inputs
  partial_data: { storage: number[]; len: number };
  partial_hash: number[];           // 8 × u32
  full_data_length: number;
  base64_decode_offset: number;
  redc_params_limbs: string[];      // 18 × u128 decimal strings
  signature_limbs: string[];        // 18 × u128 decimal strings
}

// ─── Helpers ────────────────────────────────────────────────────────────

function hexStringToBytes(hex: string): number[] {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  const bytes: number[] = [];
  for (let i = 0; i < clean.length; i += 2) {
    bytes.push(parseInt(clean.slice(i, i + 2), 16));
  }
  return bytes;
}

function padBytes(bytes: number[], length: number): number[] {
  const padded = [...bytes];
  while (padded.length < length) {
    padded.push(0);
  }
  return padded;
}

/**
 * Convert a byte array to the format noir_js expects for [u8; N]: array of hex strings.
 */
function toHexArray(bytes: number[] | Uint8Array): string[] {
  return Array.from(bytes).map(b => '0x' + b.toString(16).padStart(2, '0'));
}

/**
 * Split an Ethereum signature (65 bytes) into r(32) + s(32) = 64 bytes, dropping v.
 */
function splitSignature(sig: string): number[] {
  const clean = sig.startsWith('0x') ? sig.slice(2) : sig;
  const rHex = clean.slice(0, 64);
  const sHex = clean.slice(64, 128);
  return [...hexStringToBytes(rHex), ...hexStringToBytes(sHex)];
}

/**
 * Build padded Merkle proof as [[u8; 32]; 8] for noir_js.
 * Each entry is an array of 32 hex strings.
 */
function formatMerkleProofArray(proof: string[], maxDepth: number): string[][] {
  const result: string[][] = [];
  for (let i = 0; i < maxDepth; i++) {
    if (i < proof.length) {
      const bytes = hexStringToBytes(proof[i]);
      result.push(toHexArray(padBytes(bytes, 32)));
    } else {
      result.push(toHexArray(new Array(32).fill(0)));
    }
  }
  return result;
}

/**
 * Encode country list as [[u8; 2]; 10] for noir_js.
 * Each country code is 2 ASCII bytes padded to 10 entries.
 */
function formatCountryListArray(countries: string[], maxEntries: number): string[][] {
  const result: string[][] = [];
  for (let i = 0; i < maxEntries; i++) {
    if (i < countries.length) {
      const code = countries[i];
      result.push([
        '0x' + code.charCodeAt(0).toString(16).padStart(2, '0'),
        '0x' + code.charCodeAt(1).toString(16).padStart(2, '0'),
      ]);
    } else {
      result.push(['0x00', '0x00']);
    }
  }
  return result;
}

// ─── Public API ─────────────────────────────────────────────────────────

/**
 * Convert CircuitParams to a noir_js-compatible input object for the circuits
 * built from an on-chain attestation.
 *
 * Field names match the circuit's main() parameter names exactly.
 *
 * It was `formatCoinbaseInputs` until 2026-09-22. The name is why GIWA was
 * never added to it: a function called "coinbase" reads as somebody else's
 * problem, and the GIWA attester is ours, on GIWA Sepolia, not Coinbase's.
 */
export function formatAttestationInputs(
  circuitId: AttestationCircuitId,
  params: CircuitParams,
): Record<string, unknown> {
  const inputs: Record<string, unknown> = {};

  /*
   * Is an action bound, and may this circuit carry one?
   *
   * The answer comes from the customer SDK's table rather than from an `if`
   * on a circuit id here: it already says, per circuit, whether an action is
   * impossible ('none') or allowed ('optional'), and every layer reads that
   * same table. A test here would be a second copy, and the copy is what was
   * wrong -- it named arc_eligibility and required an action there, months
   * after arc made it optional and while giwa_attestation had the same two
   * parameters and no way to fill them.
   */
  const binding = circuitActionBinding(circuitId);
  const bound = Boolean(params.domainSeparator) && Boolean(params.actionHash);

  if (Boolean(params.domainSeparator) !== Boolean(params.actionHash)) {
    throw new Error(
      'Half an action: send both domain_separator and action_hash, or neither. ' +
      `Got domain_separator=${Boolean(params.domainSeparator)}, action_hash=${Boolean(params.actionHash)}.`,
    );
  }
  if (bound && binding === 'none') {
    throw new Error(
      `An EIP-712 action was given but '${circuitId}' has no inputs for one. ` +
      'Its wallet signs signal_hash with personal_sign.',
    );
  }

  /*
   * In action mode the wallet signed the typed data, not the challenge, and
   * the circuit asserts signal_hash is empty -- filling both is the shape it
   * refuses. Out of action mode the pair is empty instead.
   */
  inputs.signal_hash = bound ? toHexArray(new Uint8Array(32)) : toHexArray(params.signalHash);
  if (binding !== 'none') {
    // Parameter order in the circuit is signal_hash, domain_separator,
    // action_hash, signer_list_merkle_root, scope, nullifier. noir_js takes a
    // named object so the key order here does not matter, but the public
    // inputs come out in that order and anything reading them by offset --
    // the app, the demo, the verifier contract -- depends on it.
    inputs.domain_separator = bound
      ? toHexArray(hexStringToBytes(params.domainSeparator!))
      : toHexArray(new Uint8Array(32));
    inputs.action_hash = bound
      ? toHexArray(hexStringToBytes(params.actionHash!))
      : toHexArray(new Uint8Array(32));
  }
  inputs.signer_list_merkle_root = toHexArray(hexStringToBytes(params.merkleRoot));

  if (circuitId === CIRCUIT_IDS.COINBASE_COUNTRY_ATTESTATION) {
    if (!params.countryList || params.countryListLength === undefined || params.isIncluded === undefined) {
      throw new Error('countryList, countryListLength, and isIncluded are required for coinbase_country_attestation');
    }
    inputs.country_list = formatCountryListArray(params.countryList, 10);
    inputs.country_list_length = params.countryListLength.toString();
    inputs.is_included = params.isIncluded;
  }

  inputs.scope = toHexArray(params.scopeBytes);
  inputs.nullifier = toHexArray(params.nullifierBytes);
  inputs.user_address = toHexArray(hexStringToBytes(params.userAddress));
  inputs.user_signature = toHexArray(splitSignature(params.userSignature));
  inputs.user_pubkey_x = toHexArray(hexStringToBytes(params.userPubkeyX));
  inputs.user_pubkey_y = toHexArray(hexStringToBytes(params.userPubkeyY));
  inputs.raw_transaction = toHexArray(padBytes(params.rawTxBytes, 300));
  inputs.tx_length = params.txLength.toString();
  inputs.coinbase_attester_pubkey_x = toHexArray(hexStringToBytes(params.attesterPubkeyX));
  inputs.coinbase_attester_pubkey_y = toHexArray(hexStringToBytes(params.attesterPubkeyY));
  inputs.coinbase_signer_merkle_proof = formatMerkleProofArray(params.merkleProof, 8);
  inputs.coinbase_signer_leaf_index = params.merkleLeafIndex.toString();
  inputs.merkle_proof_depth = params.merkleDepth.toString();

  return inputs;
}

/**
 * Convert OidcCircuitInputs to a noir_js-compatible input object.
 *
 * Field names match the circuit's main() parameter names exactly.
 */
export function formatOidcInputs(inputs: OidcCircuitInputs): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  // Public inputs
  result.pubkey_modulus_limbs = inputs.pubkey_modulus_limbs;
  result.domain = {
    storage: toHexArray(inputs.domain.storage),
    len: inputs.domain.len.toString(),
  };
  result.scope = toHexArray(inputs.scope);
  result.nullifier = toHexArray(inputs.nullifier);
  result.provider = inputs.provider.toString();

  // Private inputs
  result.partial_data = {
    storage: toHexArray(inputs.partial_data.storage),
    len: inputs.partial_data.len.toString(),
  };
  result.partial_hash = inputs.partial_hash.map(v => (v >>> 0).toString());
  result.full_data_length = inputs.full_data_length.toString();
  result.base64_decode_offset = inputs.base64_decode_offset.toString();
  result.redc_params_limbs = inputs.redc_params_limbs;
  result.signature_limbs = inputs.signature_limbs;

  return result;
}
