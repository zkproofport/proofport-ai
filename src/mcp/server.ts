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
import { getTaskOutcome } from '../skills/flowGuidance.js';
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
 *
 * @param deps - Optional runtime dependencies (Redis, rate limiter, etc.)
 * @param config - Optional pre-loaded config. When provided, skips loadConfig()
 *                 inside each tool handler (required for testing without env vars).
 */
export function createMcpServer(deps: McpServerDeps = {}, config?: ReturnType<typeof loadConfig>): McpServer {
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
    '[STEP 1/5] Start a proof generation session. Creates a signing request and returns a URL where the user opens in their browser to connect their wallet and sign. After calling this, wait for the user to complete signing, then call check_status with the returned requestId.',
    {
      circuitId: z.string().describe('Circuit identifier: coinbase_attestation or coinbase_country_attestation'),
      scope: z.string().describe('Privacy scope string for nullifier computation'),
      countryList: z.array(z.string()).optional().describe('Country codes for country attestation'),
      isIncluded: z.boolean().optional().describe('Whether to prove inclusion or exclusion from country list'),
    },
    async (args) => {
      try {
        const resolvedConfig = config || loadConfig();
        const skillDeps = buildSkillDeps(deps, resolvedConfig);
        const result = await handleRequestSigning(args, skillDeps);
        const { guidance } = getTaskOutcome('request_signing', result);
        return { content: [
          { type: 'text' as const, text: guidance },
          { type: 'text' as const, text: JSON.stringify(result, null, 2) },
        ] };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }], isError: true };
      }
    },
  );

  // ─── check_status ────────────────────────────────────────────────────
  server.tool(
    'check_status',
    '[STEP 2/5] Check the signing and payment status of a proof request. Call with the requestId from request_signing. Returns phase: "signing" (user hasn\'t signed yet), "payment" (signed, needs payment), "ready" (can generate proof), or "expired". When phase is "payment", call request_payment. When phase is "ready", call generate_proof.',
    {
      requestId: z.string().describe('Request ID from request_signing'),
    },
    async (args) => {
      try {
        const resolvedConfig = config || loadConfig();
        const skillDeps = buildSkillDeps(deps, resolvedConfig);
        const result = await handleCheckStatus(args, skillDeps);
        const { guidance } = getTaskOutcome('check_status', result);
        return { content: [
          { type: 'text' as const, text: guidance },
          { type: 'text' as const, text: JSON.stringify(result, null, 2) },
        ] };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }], isError: true };
      }
    },
  );

  // ─── request_payment ─────────────────────────────────────────────────
  server.tool(
    'request_payment',
    '[STEP 3/5] Initiate USDC payment for proof generation. Returns a payment URL the user opens in their browser. Only call when check_status returns phase "payment". After user pays, call check_status again to verify phase is "ready".',
    {
      requestId: z.string().describe('Request ID from request_signing'),
    },
    async (args) => {
      try {
        const resolvedConfig = config || loadConfig();
        const skillDeps = buildSkillDeps(deps, resolvedConfig);
        const result = await handleRequestPayment(args, skillDeps);
        const { guidance } = getTaskOutcome('request_payment', result);
        return { content: [
          { type: 'text' as const, text: guidance },
          { type: 'text' as const, text: JSON.stringify(result, null, 2) },
        ] };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }], isError: true };
      }
    },
  );

  // ─── generate_proof ─────────────────────────────────────────────────
  server.tool(
    'generate_proof',
    `[STEP 4/5] Generate a zero-knowledge proof for a given circuit. When using the standard flow, provide the requestId from request_signing after check_status confirms phase is "ready". Alternatively, provide address and signature directly to skip the signing flow. If called without requestId or signature, a web signing request is created automatically. Proof generation takes 30-90 seconds.

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
        const resolvedConfig = config || loadConfig();
        const skillDeps = buildSkillDeps(deps, resolvedConfig);
        const result = await handleGenerateProof({
          address: args.address,
          signature: args.signature,
          scope: args.scope,
          circuitId: args.circuitId,
          countryList: args.countryList,
          isIncluded: args.isIncluded,
          requestId: args.requestId,
        }, skillDeps);
        const { guidance } = getTaskOutcome('generate_proof', result);
        return { content: [
          { type: 'text' as const, text: guidance },
          { type: 'text' as const, text: JSON.stringify(result, null, 2) },
        ] };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }], isError: true };
      }
    },
  );

  // ─── verify_proof ───────────────────────────────────────────────────
  server.tool(
    'verify_proof',
    '[STEP 5/5 — OPTIONAL] Verify a previously generated zero-knowledge proof on-chain against the deployed verifier contract. Not part of the standard proof generation flow — call only when the user explicitly requests verification. Provide either proofId (from generate_proof result) or the triplet circuitId+proof+publicInputs.',
    {
      proofId: z.string().optional().describe('Proof ID from generate_proof result. When provided, proof/publicInputs/circuitId are loaded from storage automatically.'),
      proof: z.string().optional().describe('The proof bytes (0x-prefixed hex string). Not needed when proofId is provided.'),
      publicInputs: z.array(z.string()).optional().describe('The public inputs as bytes32 hex strings. Not needed when proofId is provided.'),
      circuitId: z.string().optional().describe('Circuit identifier: coinbase_attestation or coinbase_country_attestation. Not needed when proofId is provided.'),
      chainId: z.string().optional().describe('Chain ID (default: 84532 for Base Sepolia)'),
    },
    async (args) => {
      try {
        const resolvedConfig = config || loadConfig();
        const skillDeps = buildSkillDeps(deps, resolvedConfig);
        const result = await handleVerifyProof({
          proofId: args.proofId,
          circuitId: args.circuitId,
          proof: args.proof,
          publicInputs: args.publicInputs,
          chainId: args.chainId,
        }, skillDeps);
        const { guidance } = getTaskOutcome('verify_proof', result);
        return { content: [
          { type: 'text' as const, text: guidance },
          { type: 'text' as const, text: JSON.stringify(result, null, 2) },
        ] };
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
      const { guidance } = getTaskOutcome('get_supported_circuits', result);
      return { content: [
        { type: 'text' as const, text: guidance },
        { type: 'text' as const, text: JSON.stringify(result, null, 2) },
      ] };
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

**Step 5: verify_proof(proofId) — Optional**
→ Returns: { valid, verifierAddress, chainId }
Only when user explicitly asks for on-chain verification. Provide proofId from Step 4, or the triplet circuitId+proof+publicInputs.

### Notes
- The requestId links Steps 1–4 together
- Each step must complete before the next
- Signing URLs expire after 5 minutes by default`
        }
      }]
    })
  );

  return server;
}
