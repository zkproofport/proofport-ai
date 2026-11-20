/**
 * The OPRF nullifier inputs a wallet credential request carries, checked
 * before payment.
 *
 * The client SDK computes them (packages/sdk: it talks to the OPRF network,
 * verifies the network's proof and unblinds the answer); this server only
 * checks their shape and that `oprf_key_hash` is the key hash pinned for this
 * deployment's environment and the requested circuit. The circuit checks the
 * rest (the network's DLog proof, the unblinding, the nullifier). A value is
 * never reduced: one at or above its modulus is refused, naming the key.
 *
 * Wire keys, each `0x` + exactly 64 hex digits:
 *   public:  oprf_key_hash, domain, scope, nullifier                 (below p)
 *   private: oprf_public_key_x, oprf_public_key_y, oprf_dlog_e,
 *            oprf_response_x, oprf_response_y                       (below p)
 *            oprf_beta (non-zero), oprf_dlog_s                       (below r)
 */
import { OPRF_FIELD_MODULUS, OPRF_SCALAR_ORDER, type OprfCircuitInputs } from '@zkproofport-app/core/oprf';
import { getPinnedOprfKeyHash, type OprfEnvironment } from '../config/oprfKeyHashes.js';

/** BN254 scalar field modulus (every Field input is below it) and BabyJubJub's subgroup order (oprf_beta and oprf_dlog_s are below it): core's. */
export { OPRF_FIELD_MODULUS, OPRF_SCALAR_ORDER };

/** The eleven values, as the circuit names them (main() parameters): core's type. */
export type { OprfCircuitInputs };

const MODULUS_OF: Readonly<Record<keyof OprfCircuitInputs, 'p' | 'r'>> = Object.freeze({
  oprf_key_hash: 'p',
  domain: 'p',
  scope: 'p',
  nullifier: 'p',
  oprf_public_key_x: 'p',
  oprf_public_key_y: 'p',
  oprf_beta: 'r',
  oprf_dlog_e: 'p',
  oprf_dlog_s: 'r',
  oprf_response_x: 'p',
  oprf_response_y: 'p',
});

export const OPRF_INPUT_KEYS = Object.freeze(Object.keys(MODULUS_OF) as (keyof OprfCircuitInputs)[]);

const HEX32 = /^0x[0-9a-fA-F]{64}$/;

/** An OPRF input the request cannot carry: the HTTP layer answers 400 (or 503 when unconfigured). */
export class OprfInputRefusal extends Error {
  constructor(
    readonly code: 'INVALID_REQUEST' | 'OPRF_KEY_HASH_MISMATCH' | 'OPRF_NOT_CONFIGURED' | 'OPRF_UNAVAILABLE',
    message: string,
  ) {
    super(message);
    this.name = 'OprfInputRefusal';
  }
}

/**
 * Read and check the eleven OPRF values of a wallet credential request.
 *
 * @param environment the server's `OPRF_ENVIRONMENT` (undefined when unset)
 * @returns the values, lower-cased, in the circuit's names
 * @throws OprfInputRefusal naming the key or the setting
 */
export function readOprfInputs(environment: OprfEnvironment | undefined, circuitId: string, inputs: unknown): OprfCircuitInputs {
  if (environment === undefined) {
    throw new OprfInputRefusal(
      'OPRF_NOT_CONFIGURED',
      `OPRF_ENVIRONMENT is not set on this server, so it cannot accept ${circuitId} proofs: their nullifier comes from an OPRF network chosen per environment.`,
    );
  }
  // The pinned row first: a production request is refused by name whatever it carries.
  let pinned: string;
  try {
    pinned = getPinnedOprfKeyHash(environment, circuitId);
  } catch (e) {
    throw new OprfInputRefusal('OPRF_UNAVAILABLE', (e as Error).message);
  }
  const src = (inputs ?? {}) as Record<string, unknown>;
  const out = {} as OprfCircuitInputs;
  for (const key of OPRF_INPUT_KEYS) {
    const value = src[key];
    if (typeof value !== 'string' || !HEX32.test(value)) {
      throw new OprfInputRefusal('INVALID_REQUEST', `${key} must be 0x followed by exactly 64 hex digits (the SDK computes it), got ${value === undefined ? 'nothing' : JSON.stringify(value)}.`);
    }
    const v = BigInt(value);
    const which = MODULUS_OF[key];
    const modulus = which === 'p' ? OPRF_FIELD_MODULUS : OPRF_SCALAR_ORDER;
    if (v >= modulus) {
      throw new OprfInputRefusal('INVALID_REQUEST', `${key} is not below ${which === 'p' ? 'the field modulus p' : 'the subgroup order r'}; it is never reduced.`);
    }
    out[key] = value.toLowerCase();
  }
  if (BigInt(out.oprf_beta) === 0n) {
    throw new OprfInputRefusal('INVALID_REQUEST', 'oprf_beta must not be zero.');
  }
  if (out.oprf_key_hash !== pinned.toLowerCase()) {
    throw new OprfInputRefusal(
      'OPRF_KEY_HASH_MISMATCH',
      `oprf_key_hash ${out.oprf_key_hash} is not the key hash pinned for ${circuitId} in '${environment}' (${pinned}); every verifier would refuse the proof.`,
    );
  }
  return out;
}

/** HTTP status for each refusal. */
export const OPRF_REFUSAL_STATUS: Readonly<Record<OprfInputRefusal['code'], number>> = Object.freeze({
  INVALID_REQUEST: 400,
  OPRF_KEY_HASH_MISMATCH: 400,
  OPRF_NOT_CONFIGURED: 503,
  OPRF_UNAVAILABLE: 503,
});
