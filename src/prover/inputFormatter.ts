/**
 * inputFormatter.ts — Convert CircuitParams and OidcCircuitInputs to noir_js input format.
 *
 * noir_js expects a JS object where field names match the circuit's main() parameter names.
 * Values are hex strings ("0x...") for byte arrays, or string numbers for scalars.
 */

import type { CircuitParams } from '../input/inputBuilder.js';
import { CIRCUIT_IDS, type CircuitId } from '../config/circuitIds.js';
import { circuitActionBinding, HUMAN_PASSPORT_MAX_DATA_BYTES, HUMAN_PASSPORT_SCORER_ID } from '@zkproofport-app/core/circuits';
import type { HumanPassportIssuance } from '../input/humanPassport.js';

/**
 * The circuits built from an on-chain attestation: everything this server can
 * prove except OIDC, which starts from a JWT and has its own formatter.
 *
 * Written as an exclusion rather than a list of three, because it WAS a list
 * of three circuits -- and giwa_attestation was added to the
 * server without being added here. The circuit takes `action_hash`, the list
 * did not know giwa existed, and every GIWA request died inside noir_js with
 * "Expected argument `action_hash`, but none was found".
 */
export type AttestationCircuitId = Exclude<
  CircuitId,
  typeof CIRCUIT_IDS.OIDC_DOMAIN_ATTESTATION | typeof CIRCUIT_IDS.HUMAN_PASSPORT_SCORE
>;

/**
 * Facts about the COMPILED circuit each id is served from (CIRCUIT_DIRS),
 * which are not the same question as "may a caller bind an action":
 *
 *   actionInputs  main() takes domain_separator / action_hash. core's
 *                 circuitActionBinding answers whether an action may be BOUND;
 *                 a circuit can carry the inputs while core says 'none', and
 *                 then the inputs are zeros. coinbase_attestation v2 and
 *                 giwa_attestation are 'optional' (core 0.4.0-beta.1).
 *   statement     main() takes the revocation statement (client_data,
 *                 signer_kind, statement_sig, attested_at and the App Attest
 *                 chain), and its client_data length -- coinbase_attestation
 *                 v2 (225 bytes) and coinbase_country_attestation v2 (227:
 *                 the country appended).
 *
 * BbProver compares the formatted inputs with the compiled circuit's ABI
 * before every proof, which holds this table to the artifact actually served.
 */
export const CIRCUIT_INPUT_FACTS: Record<AttestationCircuitId, { actionInputs: boolean; statement: false | { clientDataLength: number } }> = {
  [CIRCUIT_IDS.COINBASE_ATTESTATION]: { actionInputs: true, statement: { clientDataLength: 225 } },
  // v2 (circuits coinbase-country-attestation-v2): KYC v2's action pair and
  // statement, with the 2-byte country after the scope.
  [CIRCUIT_IDS.COINBASE_COUNTRY_ATTESTATION]: { actionInputs: true, statement: { clientDataLength: 227 } },
  [CIRCUIT_IDS.GIWA_ATTESTATION]: { actionInputs: true, statement: false },
};

/**
 * The App Attest inputs, all zero for the server kind (circuit README step 6).
 * The same names and sizes in every circuit built on circuits
 * `statement-signer` (coinbase_attestation v2, oidc_domain_attestation).
 */
export const APP_ATTEST_ZERO_INPUTS = {
  credential_tbs: 1000,
  credential_sig: 96,
  att_auth_data: 256,
  att_client_data_hash: 32,
  assertion_auth_data: 128,
} as const;
export const SIGNER_KIND_SERVER = 2;

// ─── OIDC Circuit Inputs ────────────────────────────────────────────────

export interface OidcCircuitInputs {
  // Public inputs
  pubkey_modulus_limbs: string[];   // 18 × u128 decimal strings
  domain: { storage: number[]; len: number };
  scope: number[];                  // 32 bytes
  nullifier: number[];              // 32 bytes
  provider: number;              // 0=Google, 1=Microsoft
  aud_hash: number[];               // 32 bytes, keccak256(aud)
  nonce_mode: number;               // 1 = request-bound nonce, 0 = none (device flow)
  nonce_binding: number[];          // 32 bytes, all zero in mode 0
  now: string;                      // u64 unix seconds, decimal; iat <= now < exp

  // Private inputs
  partial_data: { storage: number[]; len: number };
  partial_hash: number[];           // 8 × u32
  full_data_length: number;
  base64_decode_offset: number;
  redc_params_limbs: string[];      // 18 × u128 decimal strings
  signature_limbs: string[];        // 18 × u128 decimal strings

  // Private: who vouched that the modulus is the provider's published key
  // (circuits oidc-domain-attestation/src/provider_key.nr), in the circuit's
  // ABI order after signature_limbs. This server is always signer kind 2
  // (Cloud KMS); every App Attest input is zero.
  signer_kind: number;
  statement_sig: number[];          // 64 bytes, r || s, low s
  credential_tbs: number[];         // 1000 bytes
  credential_tbs_len: number;
  credential_sig: number[];         // 96 bytes
  att_auth_data: number[];          // 256 bytes
  att_auth_data_len: number;
  att_client_data_hash: number[];   // 32 bytes
  assertion_auth_data: number[];    // 128 bytes
  assertion_auth_data_len: number;
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
   * wrong -- it named a single circuit and required an action there, months
   * after the action became optional, while giwa_attestation had the same two
   * parameters and no way to fill them.
   */
  const binding = circuitActionBinding(circuitId);
  const facts = CIRCUIT_INPUT_FACTS[circuitId];
  if (!facts) {
    throw new Error(`No input facts for circuit '${circuitId}'. Known: ${Object.keys(CIRCUIT_INPUT_FACTS).join(', ')}.`);
  }
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
  if (facts.actionInputs) {
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
    if (params.countryList.length < 1 || params.countryList.length > 10 || params.countryListLength !== params.countryList.length) {
      throw new Error(`country_list must hold 1 to 10 codes and country_list_length its length; got ${params.countryList.length} codes, length ${params.countryListLength}`);
    }
    const badCode = params.countryList.find(c => typeof c !== 'string' || !/^[A-Z]{2}$/.test(c));
    if (badCode !== undefined) throw new Error(`country_list entry ${JSON.stringify(badCode)} is not two letters A-Z`);
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

  if (facts.statement) {
    const st = params.statement;
    if (!st) {
      throw new Error(`${circuitId} needs the server-signed revocation statement (client_data, statement_sig, attested_at).`);
    }
    const want = facts.statement.clientDataLength;
    if (st.clientData.length !== want) throw new Error(`client_data is ${st.clientData.length} bytes, expected ${want}`);
    if (st.signature.length !== 64) throw new Error(`statement_sig is ${st.signature.length} bytes, expected 64`);
    if (!Number.isSafeInteger(st.attestedAt) || st.attestedAt <= 0) throw new Error(`Invalid attested_at ${st.attestedAt}`);
    inputs.attested_at = st.attestedAt.toString();
    inputs.client_data = toHexArray(st.clientData);
    inputs.signer_kind = SIGNER_KIND_SERVER.toString();
    inputs.statement_sig = toHexArray(st.signature);
    for (const [name, len] of Object.entries(APP_ATTEST_ZERO_INPUTS)) {
      inputs[name] = toHexArray(new Uint8Array(len));
    }
    inputs.credential_tbs_len = '0';
    inputs.att_auth_data_len = '0';
    inputs.assertion_auth_data_len = '0';
  } else if (params.statement) {
    throw new Error(`${circuitId} takes no revocation statement; one was given.`);
  }

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
  result.aud_hash = toHexArray(inputs.aud_hash);
  result.nonce_mode = inputs.nonce_mode.toString();
  result.nonce_binding = toHexArray(inputs.nonce_binding);
  result.now = inputs.now;

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

  // Provider-key statement signer. Only the server kind is built here: this
  // server holds no App Attest chain, and a kind it did not sign for would be
  // a witness the circuit refuses after payment.
  if (inputs.signer_kind !== SIGNER_KIND_SERVER) {
    throw new Error(`OIDC signer_kind must be ${SIGNER_KIND_SERVER} (server) on this prover, got ${inputs.signer_kind}.`);
  }
  if (inputs.statement_sig.length !== 64) throw new Error(`statement_sig is ${inputs.statement_sig.length} bytes, expected 64`);
  const zeroFields = [
    ['credential_tbs', inputs.credential_tbs, inputs.credential_tbs_len],
    ['credential_sig', inputs.credential_sig, 0],
    ['att_auth_data', inputs.att_auth_data, inputs.att_auth_data_len],
    ['att_client_data_hash', inputs.att_client_data_hash, 0],
    ['assertion_auth_data', inputs.assertion_auth_data, inputs.assertion_auth_data_len],
  ] as const;
  for (const [name, bytes, len] of zeroFields) {
    const size = APP_ATTEST_ZERO_INPUTS[name];
    if (bytes.length !== size || len !== 0 || bytes.some(b => b !== 0)) {
      throw new Error(`${name} must be ${size} zero bytes with length 0 for the server signer.`);
    }
  }
  result.signer_kind = inputs.signer_kind.toString();
  result.statement_sig = toHexArray(inputs.statement_sig);
  result.credential_tbs = toHexArray(inputs.credential_tbs);
  result.credential_tbs_len = inputs.credential_tbs_len.toString();
  result.credential_sig = toHexArray(inputs.credential_sig);
  result.att_auth_data = toHexArray(inputs.att_auth_data);
  result.att_auth_data_len = inputs.att_auth_data_len.toString();
  result.att_client_data_hash = toHexArray(inputs.att_client_data_hash);
  result.assertion_auth_data = toHexArray(inputs.assertion_auth_data);
  result.assertion_auth_data_len = inputs.assertion_auth_data_len.toString();

  return result;
}

// ─── Human Passport score ───────────────────────────────────────────────

/**
 * What human_passport_score proves from: the wallet's request (as for the
 * other wallet circuits) and the issuance src/input/humanPassport.ts found and
 * checked before payment.
 */
export interface HumanPassportParams {
  signalHash: Uint8Array;
  domainSeparator?: string;
  actionHash?: string;
  scopeBytes: Uint8Array;
  nullifierBytes: Uint8Array;
  userAddress: string;
  userSignature: string;
  userPubkeyX: string;
  userPubkeyY: string;
  /** Threshold in score units (score x 10^4). */
  minScoreUnits: number;
  /** Unix seconds the attestation must be unexpired at. */
  now: number;
  issuance: HumanPassportIssuance;
}

function word32(v: bigint | string): string[] {
  const n = typeof v === 'bigint' ? v : BigInt(v);
  if (n < 0n || n >= 1n << 256n) throw new Error(`value ${n} does not fit 32 bytes`);
  return toHexArray(hexStringToBytes(n.toString(16).padStart(64, '0')));
}

/**
 * Convert HumanPassportParams to noir_js inputs for human_passport_score
 * (circuits human-passport-score/src/main.nr). Field names are main()'s.
 */
export function formatHumanPassportInputs(p: HumanPassportParams): Record<string, unknown> {
  const bound = Boolean(p.domainSeparator) && Boolean(p.actionHash);
  if (Boolean(p.domainSeparator) !== Boolean(p.actionHash)) {
    throw new Error('Half an action: send both domain_separator and action_hash, or neither.');
  }
  if (!Number.isSafeInteger(p.minScoreUnits) || p.minScoreUnits < 1 || p.minScoreUnits > 0xffffffff) {
    throw new Error(`min_score ${p.minScoreUnits} is not a u32 above 0`);
  }
  if (!Number.isSafeInteger(p.now) || p.now <= 0) throw new Error(`Invalid now ${p.now}`);
  const i = p.issuance;
  if (BigInt(p.now) >= i.request.expirationTime) throw new Error(`now ${p.now} is not before the issuance's expiry ${i.request.expirationTime}`);
  const data = hexStringToBytes(i.request.data);
  if (data.length > HUMAN_PASSPORT_MAX_DATA_BYTES) throw new Error(`score data is ${data.length} bytes; the circuit holds ${HUMAN_PASSPORT_MAX_DATA_BYTES}`);
  if (i.merkleProof.length !== i.merkleDepth || i.merkleDepth < 1 || i.merkleDepth > 8) {
    throw new Error(`issuer Merkle path has ${i.merkleProof.length} nodes for depth ${i.merkleDepth}`);
  }
  const sig = hexStringToBytes(i.issuerSignature);
  if (sig.length !== 64) throw new Error(`issuer_signature is ${sig.length} bytes, expected 64`);
  return {
    signal_hash: bound ? toHexArray(new Uint8Array(32)) : toHexArray(p.signalHash),
    domain_separator: bound ? toHexArray(hexStringToBytes(p.domainSeparator!)) : toHexArray(new Uint8Array(32)),
    action_hash: bound ? toHexArray(hexStringToBytes(p.actionHash!)) : toHexArray(new Uint8Array(32)),
    signer_list_merkle_root: toHexArray(hexStringToBytes(i.merkleRoot)),
    scope: toHexArray(p.scopeBytes),
    nullifier: toHexArray(p.nullifierBytes),
    min_score: p.minScoreUnits.toString(),
    scorer_id: HUMAN_PASSPORT_SCORER_ID.toString(),
    now: p.now.toString(),
    user_address: toHexArray(hexStringToBytes(p.userAddress)),
    user_signature: toHexArray(splitSignature(p.userSignature)),
    user_pubkey_x: toHexArray(hexStringToBytes(p.userPubkeyX)),
    user_pubkey_y: toHexArray(hexStringToBytes(p.userPubkeyY)),
    passport_domain_separator: toHexArray(hexStringToBytes(i.domainSeparator)),
    schema_uid: toHexArray(hexStringToBytes(i.request.schema)),
    expiration_time: i.request.expirationTime.toString(),
    revocable: i.request.revocable,
    ref_uid: toHexArray(hexStringToBytes(i.request.refUID)),
    attestation_value: word32(i.request.value),
    request_nonce: word32(i.request.nonce),
    request_fee: word32(i.request.fee),
    score_data: toHexArray(padBytes(data, HUMAN_PASSPORT_MAX_DATA_BYTES)),
    score_data_len: data.length.toString(),
    issuer_signature: toHexArray(sig),
    issuer_pubkey_x: toHexArray(hexStringToBytes(i.issuerPubkeyX)),
    issuer_pubkey_y: toHexArray(hexStringToBytes(i.issuerPubkeyY)),
    issuer_merkle_proof: formatMerkleProofArray(i.merkleProof, 8),
    issuer_leaf_index: i.leafIndex.toString(),
    issuer_merkle_depth: i.merkleDepth.toString(),
  };
}
