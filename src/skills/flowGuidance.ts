/**
 * flowGuidance.ts — Shared task outcome logic for A2A and MCP protocol adapters.
 *
 * Determines the correct A2A task state and natural-language guidance text
 * based on the skill name and its result. This enables:
 *   - LLM agents: read TextPart guidance to decide the next action
 *   - Programmatic agents: branch on task state (completed vs input-required)
 *   - Third-party agents: standard A2A behavior, no custom fields
 */

import type {
  GetSupportedCircuitsResult,
} from './skillHandler.js';

export interface TaskOutcome {
  state: 'completed' | 'input-required' | 'failed';
  guidance: string;
}

export function getTaskOutcome(skill: string, result: unknown): TaskOutcome {
  switch (skill) {
    case 'get_supported_circuits': {
      const r = result as GetSupportedCircuitsResult;
      return {
        state: 'completed',
        guidance: `Found ${r.circuits.length} supported circuit(s). NEXT STEP: Use POST /api/v1/prove with the x402 single-step flow (circuit + inputs → 402 with nonce → pay → retry with X-Payment-TX and X-Payment-Nonce headers). Available MCP tools are ONLY: get_supported_circuits, prove. Do NOT call "proof_request" or any other tool name.`,
      };
    }

    case 'prove': {
      const message = (result as any)?.message as string | undefined;
      if (message) {
        return { state: 'completed', guidance: message };
      }
      const proofHash = (result as any)?.proof_hash as string | undefined;
      const proofNote = proofHash ? ` Proof hash: ${proofHash}.` : '';
      return {
        state: 'completed',
        guidance: `Proof generated successfully.${proofNote} The zero-knowledge proof is ready.`,
      };
    }

    default:
      return { state: 'completed', guidance: `${skill} completed.` };
  }
}
