import type { ClientConfig, CircuitName, ChallengeResponse, ProveInputs } from './types.js';

/**
 * Request a challenge from the server.
 * POST /api/v1/prove without proof headers → server returns nonce + TEE key info.
 */
export async function requestChallenge(
  config: ClientConfig,
  circuit: CircuitName,
  inputs?: ProveInputs,
): Promise<ChallengeResponse> {
  const url = `${config.baseUrl}/api/v1/prove`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ circuit, ...(inputs && { inputs }) }),
  });

  if (response.status !== 402) {
    const error = await response.json().catch(() => ({ message: `HTTP ${response.status}` }));
    throw new Error(`Expected 402 challenge, got ${response.status}: ${(error as any).message || response.status}`);
  }

  return response.json() as Promise<ChallengeResponse>;
}

// Backward-compatible alias (deprecated — use requestChallenge instead)
export { requestChallenge as createSession };
