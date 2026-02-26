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
  RequestSigningResult,
  CheckStatusResult,
  RequestPaymentResult,
  GenerateProofResult,
  VerifyProofResult,
  GetSupportedCircuitsResult,
} from './skillHandler.js';

export interface TaskOutcome {
  state: 'completed' | 'input-required' | 'failed';
  guidance: string;
}

export function getTaskOutcome(skill: string, result: unknown): TaskOutcome {
  switch (skill) {
    case 'request_signing': {
      const r = result as RequestSigningResult;
      return {
        state: 'input-required',
        guidance: `Signing session created. Present this URL to the user to connect their wallet and sign: ${r.signingUrl} — After the user signs, call check_status with requestId "${r.requestId}" to check progress.`,
      };
    }

    case 'check_status': {
      const r = result as CheckStatusResult;
      switch (r.phase) {
        case 'signing':
          return {
            state: 'input-required',
            guidance: `Waiting for wallet signature. The user must visit the signing URL and complete signing. Poll check_status again with requestId "${r.requestId}" to check progress.`,
          };
        case 'payment':
          return {
            state: 'input-required',
            guidance: `Signing complete. Payment is required before proof generation. Call request_payment with requestId "${r.requestId}" to get the payment URL.`,
          };
        case 'ready': {
          let readyGuidance = `All prerequisites met. Call generate_proof with requestId "${r.requestId}" to generate the zero-knowledge proof.`;
          if (r.verifierExplorerUrl) {
            readyGuidance += ` | Verifier contract: ${r.verifierExplorerUrl}`;
          }
          if (r.payment.paymentReceiptUrl) {
            readyGuidance += ` | Payment receipt: ${r.payment.paymentReceiptUrl}`;
          }
          readyGuidance += ` | Session expires: ${r.expiresAt}`;
          return { state: 'completed', guidance: readyGuidance };
        }
        case 'expired':
          return {
            state: 'failed',
            guidance: 'Session expired. Start a new session by calling request_signing with the same circuitId and scope.',
          };
        default:
          return { state: 'completed', guidance: `check_status completed. Phase: ${r.phase}.` };
      }
    }

    case 'request_payment': {
      const r = result as RequestPaymentResult;
      return {
        state: 'input-required',
        guidance: `Payment URL generated. Present this URL to the user to pay ${r.amount} ${r.currency} on ${r.network}: ${r.paymentUrl} — After payment, call check_status with requestId "${r.requestId}" until phase is "ready".`,
      };
    }

    case 'generate_proof': {
      const r = result as GenerateProofResult;
      let guidance = `Proof generated successfully. ProofId: ${r.proofId}. Verification page: ${r.verifyUrl}`;
      if (r.attestationUrl) {
        guidance += ` | TEE Attestation: ${r.attestationUrl}`;
      }
      if (r.verifierExplorerUrl) {
        guidance += ` | Verifier contract: ${r.verifierExplorerUrl}`;
      }
      if (r.paymentReceiptUrl) {
        guidance += ` | Payment receipt: ${r.paymentReceiptUrl}`;
      }
      guidance += ` — Optionally call verify_proof with proofId "${r.proofId}" to verify on-chain.`;
      return { state: 'completed', guidance };
    }

    case 'verify_proof': {
      const r = result as VerifyProofResult;
      const validText = r.valid ? 'valid' : 'invalid';
      let guidance = `Verification complete. The proof is ${validText} on chain ${r.chainId} (verifier: ${r.verifierAddress}).`;
      if (r.verifierExplorerUrl) {
        guidance += ` View contract: ${r.verifierExplorerUrl}`;
      }
      if (r.error) {
        guidance += ` Error: ${r.error}`;
      }
      return { state: 'completed', guidance };
    }

    case 'get_supported_circuits': {
      const r = result as GetSupportedCircuitsResult;
      return {
        state: 'completed',
        guidance: `Found ${r.circuits.length} supported circuit(s). To start proof generation, call request_signing with a circuitId and scope.`,
      };
    }

    default:
      return { state: 'completed', guidance: `${skill} completed.` };
  }
}
