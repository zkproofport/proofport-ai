import type { ClientConfig, CircuitName, ProveInputs, ProveResponse } from './types.js';
import type { EncryptedEnvelope } from './tee.js';

/**
 * Submit proof generation request.
 * POST /api/v1/prove
 *
 * The `inputs` field accepts either:
 * - `ProveInputs` (EAS coinbase path)
 * - `OidcCircuitInputs` (OIDC path — structured inputs, server builds Prover.toml)
 */
export async function submitProof(
  config: ClientConfig,
  request: {
    circuit: CircuitName;
    inputs?: ProveInputs | Record<string, unknown>;
    nonce?: string;
  },
): Promise<ProveResponse> {
  const url = `${config.baseUrl}/api/v1/prove`;
  const body: Record<string, unknown> = {
    circuit: request.circuit,
    inputs: request.inputs,
  };
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (request.nonce) {
    headers['X-Payment-Nonce'] = request.nonce;
  }
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: `HTTP ${response.status}` }));
    throw new Error(`Proof generation failed: ${JSON.stringify(error)}`);
  }

  return response.json() as Promise<ProveResponse>;
}

/**
 * Submit an E2E encrypted proof request.
 * The server acts as a blind relay -- it cannot read the inputs.
 */
export async function submitEncryptedProof(
  config: ClientConfig,
  request: {
    circuit: CircuitName;
    encryptedPayload: EncryptedEnvelope;
    nonce?: string;
  },
): Promise<ProveResponse> {
  const url = `${config.baseUrl}/api/v1/prove`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (request.nonce) {
    headers['X-Payment-Nonce'] = request.nonce;
  }
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      circuit: request.circuit,
      encrypted_payload: request.encryptedPayload,
    }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: `HTTP ${response.status}` }));

    if (response.status === 409) {
      throw new Error('TEE key rotated. Retry with a new challenge to get the updated key.');
    }

    throw new Error(`Proof generation failed: ${JSON.stringify(error)}`);
  }

  return response.json() as Promise<ProveResponse>;
}
