import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { loadConfig } from '../config/index.js';
import {
  handleRequestSigning,
  handleCheckStatus,
  handleRequestPayment,
  handleGenerateProof,
  handleVerifyProof,
  handleGetSupportedCircuits,
  type SkillDeps,
} from '../skills/skillHandler.js';
import type { RateLimiter } from '../redis/rateLimiter.js';
import type { ProofCache } from '../redis/proofCache.js';
import type { RedisClient } from '../redis/client.js';
import type { TeeProvider } from '../tee/types.js';

export interface McpServerDeps {
  redis?: RedisClient;
  rateLimiter?: RateLimiter;
  proofCache?: ProofCache;
  teeProvider?: TeeProvider;
  signPageUrl?: string;
  signingTtlSeconds?: number;
  paymentMode?: 'disabled' | 'testnet' | 'mainnet';
  paymentProofPrice?: string;
  easGraphqlEndpoint?: string;
  rpcUrls?: string[];
  bbPath?: string;
  nargoPath?: string;
  circuitsDir?: string;
  chainRpcUrl?: string;
  teeMode?: string;
}

function buildSkillDeps(deps: McpServerDeps, config: ReturnType<typeof loadConfig>): SkillDeps {
  return {
    redis: deps.redis!,
    signPageUrl: deps.signPageUrl || config.signPageUrl || '',
    signingTtlSeconds: deps.signingTtlSeconds || config.signingTtlSeconds || 300,
    paymentMode: deps.paymentMode || config.paymentMode || 'disabled',
    paymentProofPrice: deps.paymentProofPrice || config.paymentProofPrice || '$0.10',
    easGraphqlEndpoint: deps.easGraphqlEndpoint || config.easGraphqlEndpoint,
    rpcUrls: deps.rpcUrls || [config.baseRpcUrl],
    bbPath: deps.bbPath || config.bbPath,
    nargoPath: deps.nargoPath || config.nargoPath,
    circuitsDir: deps.circuitsDir || config.circuitsDir,
    chainRpcUrl: deps.chainRpcUrl || config.chainRpcUrl,
    rateLimiter: deps.rateLimiter,
    proofCache: deps.proofCache,
    teeProvider: deps.teeProvider,
    teeMode: deps.teeMode || config.teeMode || 'disabled',
  };
}

/**
 * Create and configure the MCP server with all tool registrations.
 * Separated from startServer() to allow testing without starting stdio transport.
 */
export function createMcpServer(deps: McpServerDeps = {}): McpServer {
  const server = new McpServer(
    {
      name: 'zkproofport-prover',
      version: '0.1.0',
    },
    {
      capabilities: {
        tools: {},
        prompts: {},
      },
    },
  );

  // ─── request_signing ────────────────────────────────────────────────
  server.tool(
    'request_signing',
    '[STEP 1/4] Start a proof generation session. Creates a signing request and returns a URL where the user opens in their browser to connect their wallet and sign. After calling this, wait for the user to complete signing, then call check_status with the returned requestId.',
    {
      circuitId: z.string().describe('Circuit identifier: coinbase_attestation or coinbase_country_attestation'),
      scope: z.string().describe('Privacy scope string for nullifier computation'),
      countryList: z.array(z.string()).optional().describe('Country codes for country attestation'),
      isIncluded: z.boolean().optional().describe('Whether to prove inclusion or exclusion from country list'),
    },
    async (args) => {
      try {
        const config = loadConfig();
        const skillDeps = buildSkillDeps(deps, config);
        const result = await handleRequestSigning(args, skillDeps);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }], isError: true };
      }
    },
  );

  // ─── check_status ────────────────────────────────────────────────────
  server.tool(
    'check_status',
    '[STEP 2/4] Check the signing and payment status of a proof request. Call with the requestId from request_signing. Returns phase: "signing" (user hasn\'t signed yet), "payment" (signed, needs payment), "ready" (can generate proof), or "expired". When phase is "payment", call request_payment. When phase is "ready", call generate_proof.',
    {
      requestId: z.string().describe('Request ID from request_signing'),
    },
    async (args) => {
      try {
        const config = loadConfig();
        const skillDeps = buildSkillDeps(deps, config);
        const result = await handleCheckStatus(args, skillDeps);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }], isError: true };
      }
    },
  );

  // ─── request_payment ─────────────────────────────────────────────────
  server.tool(
    'request_payment',
    '[STEP 3/4] Initiate USDC payment for proof generation. Returns a payment URL the user opens in their browser. Only call when check_status returns phase "payment". After user pays, call check_status again to verify phase is "ready".',
    {
      requestId: z.string().describe('Request ID from request_signing'),
    },
    async (args) => {
      try {
        const config = loadConfig();
        const skillDeps = buildSkillDeps(deps, config);
        const result = await handleRequestPayment(args, skillDeps);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }], isError: true };
      }
    },
  );

  // ─── generate_proof ─────────────────────────────────────────────────
  server.tool(
    'generate_proof',
    `[STEP 4/4] Generate a zero-knowledge proof for a given circuit. This is a 2-step process when no signature is provided:

Step 1: Call without signature/requestId → returns {status: "awaiting_signature", signingUrl, requestId}. Open the signingUrl in a browser and ask the user to connect their wallet and sign.

Step 2: After the user signs, call again with the same scope/circuitId and the requestId from Step 1 → returns the generated proof with publicInputs, nullifier, and signalHash.

If you already have a signature and address, provide them directly to skip the signing flow and generate the proof in a single call.

The response includes a TEE attestation when running in a trusted execution environment (local simulation or AWS Nitro Enclave).`,
    {
      address: z.string().optional().describe('KYC wallet address (0x-prefixed, 20 bytes). Required when providing signature directly. Omit for web signing flow.'),
      signature: z.string().optional().describe('User signature over the signal hash (0x-prefixed, 65 bytes). If omitted, a web signing request is created.'),
      scope: z.string().describe('Privacy scope string for nullifier computation'),
      circuitId: z.string().describe('Circuit identifier: coinbase_attestation or coinbase_country_attestation'),
      countryList: z.array(z.string()).optional().describe('Country codes for country attestation (e.g., ["US", "KR"])'),
      isIncluded: z.boolean().optional().describe('Whether to prove inclusion or exclusion from the country list'),
      requestId: z.string().optional().describe('Signing request ID from Step 1. Provide this in Step 2 to resume proof generation after the user has signed.'),
    },
    async (args) => {
      try {
        const config = loadConfig();
        const skillDeps = buildSkillDeps(deps, config);
        const result = await handleGenerateProof({
          address: args.address,
          signature: args.signature,
          scope: args.scope,
          circuitId: args.circuitId,
          countryList: args.countryList,
          isIncluded: args.isIncluded,
          requestId: args.requestId,
        }, skillDeps);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }], isError: true };
      }
    },
  );

  // ─── verify_proof ───────────────────────────────────────────────────
  server.tool(
    'verify_proof',
    '[OPTIONAL] Verify a previously generated zero-knowledge proof on-chain against the deployed verifier contract. Not part of the standard proof generation flow — call only when the user explicitly requests verification.',
    {
      proof: z.string().describe('The proof bytes (0x-prefixed hex string)'),
      publicInputs: z.array(z.string()).describe('The public inputs as bytes32 hex strings'),
      circuitId: z.string().describe('Circuit identifier: coinbase_attestation or coinbase_country_attestation'),
      chainId: z.string().optional().describe('Chain ID (default: 84532 for Base Sepolia)'),
    },
    async (args) => {
      try {
        const config = loadConfig();
        const skillDeps = buildSkillDeps(deps, config);
        const result = await handleVerifyProof({
          circuitId: args.circuitId,
          proof: args.proof,
          publicInputs: args.publicInputs,
          chainId: args.chainId,
        }, skillDeps);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }], isError: true };
      }
    },
  );

  // ─── get_supported_circuits ─────────────────────────────────────────
  server.tool(
    'get_supported_circuits',
    '[DISCOVERY] List all supported ZK circuits with their metadata, descriptions, required inputs, and verifier addresses. Call this first to discover available circuits before starting a proof generation flow.',
    async () => {
      const result = handleGetSupportedCircuits({});
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    },
  );

  // ─── proof_flow prompt ──────────────────────────────────────────────
  server.prompt(
    'proof_flow',
    'Complete ZK proof generation flow guide — step-by-step instructions',
    () => ({
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: `## ZK Proof Generation Flow Guide

### Prerequisites
Call get_supported_circuits to discover available circuits and their required inputs.

### Flow Steps

**Step 1: request_signing(circuitId, scope)**
→ Returns: { requestId, signingUrl, expiresAt }
Present the signingUrl to the user. They open it in a browser to connect their wallet and sign.

**Step 2: check_status(requestId)**
→ Returns: { phase, signing, payment, expiresAt }
Poll until phase changes from "signing":
- "payment" → proceed to Step 3
- "ready" → skip to Step 4 (payment is disabled)
- "expired" → restart from Step 1

**Step 3: request_payment(requestId)**
→ Returns: { paymentUrl, amount, currency, network }
Present the paymentUrl to the user. They pay $0.10 USDC (no gas needed — x402 protocol).
Then call check_status again until phase is "ready".

**Step 4: generate_proof(requestId)**
→ Returns: { proof, publicInputs, nullifier, signalHash, proofId, verifyUrl }
Takes 30-90 seconds. Present the verifyUrl for on-chain verification.

### Optional
**verify_proof(proof, publicInputs, circuitId)**
→ Returns: { valid, verifierAddress, chainId }
Only when user explicitly asks for on-chain verification.

### Notes
- The requestId links all steps together
- Each step must complete before the next
- Signing URLs expire after 5 minutes by default`
        }
      }]
    })
  );

  return server;
}
