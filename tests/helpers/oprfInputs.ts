/**
 * Valid OPRF wire inputs for server tests: the one real answer from the
 * public test network recorded in tests/fixtures/oprf-vectors.json (`network`),
 * whose key hash is the staging/local pin. Its nullifier is for that answer's
 * address, not for any wallet a route test uses -- the server does not (and
 * cannot) recompute it; the circuit does.
 */
import { createRequire } from 'node:module';
import type { OprfCircuitInputs } from '../../src/input/oprfInputs.js';

const vectors = createRequire(import.meta.url)('../fixtures/oprf-vectors.json') as {
  network: {
    domain: string;
    scope: string;
    nullifier: string;
    keyHash: string;
    beta: string;
    dlogE: string;
    dlogS: string;
    publicKey: { x: string; y: string };
    response: { x: string; y: string };
  };
};

export const NETWORK = vectors.network;

export function oprfWireInputs(overrides: Partial<Record<keyof OprfCircuitInputs, unknown>> = {}): Record<string, unknown> {
  const n = NETWORK;
  return {
    oprf_key_hash: n.keyHash,
    domain: n.domain,
    scope: n.scope,
    nullifier: n.nullifier,
    oprf_public_key_x: n.publicKey.x,
    oprf_public_key_y: n.publicKey.y,
    oprf_beta: n.beta,
    oprf_dlog_e: n.dlogE,
    oprf_dlog_s: n.dlogS,
    oprf_response_x: n.response.x,
    oprf_response_y: n.response.y,
    ...overrides,
  };
}

/** The same values typed as the prover's `oprf` param. */
export function oprfParams(): OprfCircuitInputs {
  return oprfWireInputs() as unknown as OprfCircuitInputs;
}
