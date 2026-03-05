import type { ClientConfig, CircuitName, ProveInputs, ProveResponse } from './types.js';

/**
 * Submit proof generation with x402 payment headers.
 * POST /api/v1/prove with X-Payment-TX and X-Payment-Nonce headers.
 */
export async function submitProof(
  config: ClientConfig,
  request: {
    circuit: CircuitName;
    inputs: ProveInputs;
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
      inputs: request.inputs,
    }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: `HTTP ${response.status}` }));
    throw new Error(`Proof generation failed: ${JSON.stringify(error)}`);
  }

  return response.json() as Promise<ProveResponse>;
}
