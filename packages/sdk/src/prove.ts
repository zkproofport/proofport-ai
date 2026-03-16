import type { ClientConfig, CircuitName, ProveInputs, ProveResponse } from './types.js';
import type { EncryptedEnvelope } from './tee.js';

/**
 * Submit proof generation with x402 payment headers.
 * POST /api/v1/prove with X-Payment-TX and X-Payment-Nonce headers.
 *
 * Supports two modes:
 * - `inputs`: client-computed ProveInputs (server builds proverToml)
 * - `proverToml`: pre-built Prover.toml string (server passes directly to prover)
 */
export async function submitProof(
  config: ClientConfig,
  request: {
    circuit: CircuitName;
    inputs?: ProveInputs;
    proverToml?: string;
    paymentTxHash: string;
    paymentNonce: string;
  },
): Promise<ProveResponse> {
  const url = `${config.baseUrl}/api/v1/prove`;
  const body: Record<string, unknown> = { circuit: request.circuit };
  if (request.proverToml) {
    body.prover_toml = request.proverToml;
  } else {
    body.inputs = request.inputs;
  }
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Payment-TX': request.paymentTxHash,
      'X-Payment-Nonce': request.paymentNonce,
    },
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
    paymentTxHash: string;
    paymentNonce: string;
  },
): Promise<ProveResponse> {
  const url = `${config.baseUrl}/api/v1/prove`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Payment-TX': request.paymentTxHash,
      'X-Payment-Nonce': request.paymentNonce,
    },
    body: JSON.stringify({
      circuit: request.circuit,
      encrypted_payload: request.encryptedPayload,
    }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: `HTTP ${response.status}` }));

    if (response.status === 409) {
      throw new Error('TEE key rotated. Retry with a new 402 challenge to get the updated key.');
    }

    throw new Error(`Proof generation failed: ${JSON.stringify(error)}`);
  }

  return response.json() as Promise<ProveResponse>;
}
