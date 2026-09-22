import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { loadConfig, getChainId } from '../config/index.js';
import { handleGetSupportedCircuits } from '../skills/skillHandler.js';
import { getTaskOutcome } from '../skills/flowGuidance.js';
import { buildGuide } from '../proof/guideBuilder.js';
import { CIRCUIT_IDS, PROVABLE_CIRCUIT_IDS } from '../config/circuitIds.js';
import type { CircuitId } from '../config/circuits.js';
import type { RateLimiter } from '../redis/rateLimiter.js';
import type { ProofCache } from '../redis/proofCache.js';
import type { RedisClient } from '../redis/client.js';
import type { TeeProvider } from '../tee/types.js';

export interface McpServerDeps {
  redis?: RedisClient;
  rateLimiter?: RateLimiter;
  proofCache?: ProofCache;
  teeProvider?: TeeProvider;
  paymentMode?: 'disabled' | 'testnet' | 'mainnet';
  paymentProofPrice?: string;
  easGraphqlEndpoint?: string;
  rpcUrls?: string[];
  bbPath?: string;
  circuitsDir?: string;
  chainRpcUrl?: string;
  teeMode?: string;
}


// Canonical ids and the existing public aliases are accepted by both tools.
const circuitIds: Record<string, CircuitId> = {
  ...Object.fromEntries(PROVABLE_CIRCUIT_IDS.map(id => [id, id])),
  coinbase_kyc: CIRCUIT_IDS.COINBASE_ATTESTATION,
  coinbase_country: CIRCUIT_IDS.COINBASE_COUNTRY_ATTESTATION,
  oidc_domain: CIRCUIT_IDS.OIDC_DOMAIN_ATTESTATION,
};
const circuitParam = () => z.enum(Object.keys(circuitIds) as [string, ...string[]])
  .describe('Canonical circuit id or supported alias. Read get_guide for the circuit-specific witness and verification chain.');
function canonicalCircuit(name: string): CircuitId {
  const id = circuitIds[name];
  if (!id) throw new Error(`Unknown circuit '${name}'. Known: ${Object.keys(circuitIds).join(', ')}`);
  return id;
}

/** Hosted MCP offers discovery and guides; prove preserves the REST redirect. */
export function createMcpServer(_deps: McpServerDeps = {}, config?: ReturnType<typeof loadConfig>): McpServer {
  const resolvedConfig = config || loadConfig();
  const baseUrl = resolvedConfig.a2aBaseUrl;
  const guideUrl = (id: CircuitId) => `${baseUrl}/api/v1/guide/${id}`;
  const guideLinks = PROVABLE_CIRCUIT_IDS.map(id => `- ${id}: ${guideUrl(id)}`).join('\n');
  const actionGuidance = 'Action binding is optional for arc_eligibility and giwa_attestation: send both domain_separator and action_hash for a signed EIP-712 action, or omit both for an identity-only proof. Other circuits do not support actions.';
  const privacyGuidance = resolvedConfig.teeMode === 'nitro'
    ? 'Encrypt with the attested teePublicKey when supplied by the challenge. Verify its attestation before sending private witnesses.'
    : 'This deployment provides no hardware TEE attestation. HTTPS protects transport, but the prover receives proof inputs.';
  const flow = 'POST with {circuit} → 402 challenge with live accepts → sign the selected payment offer → retry with circuit-specific inputs and PAYMENT-SIGNATURE; include X-Payment-Nonce when supplied. Encrypt inputs only when the challenge supplies teePublicKey. Legacy X-Payment-TX requires X-Payment-Nonce.';
  const server = new McpServer({ name: 'zkproofport-prover', version: resolvedConfig.agentVersion || '0.1.0' }, {
    capabilities: { tools: {}, prompts: {} },
  });

  server.tool('prove',
    `Get the REST endpoint for long-running Noir proof generation. This hosted tool redirects; it does not generate a proof inside the MCP call.
POST ${baseUrl}/api/v1/prove
${flow}
${actionGuidance}
${privacyGuidance}
Read the canonical guide before preparing inputs:
${guideLinks}`,
    {
      circuit: circuitParam(),
      inputs: z.record(z.string(), z.unknown()).describe('Circuit-specific prepared witness. OIDC uses jwt, jwks, scope and provider; attestation circuits use their own wallet/attestation fields. Read get_guide.'),
    },
    async ({ circuit }) => ({ content: [{ type: 'text' as const, text: JSON.stringify({
      message: 'Use the REST endpoint for long-running proof generation, or the local @zkproofport-ai/mcp generate_proof tool for SDK orchestration.',
      rest_endpoint: `POST ${baseUrl}/api/v1/prove`,
      guide_url: guideUrl(canonicalCircuit(circuit)),
      // Retain these compatibility fields for existing consumers.
      staging_url: 'https://stg-ai.zkproofport.app/api/v1/prove',
      production_url: 'https://ai.zkproofport.app/api/v1/prove',
      flow,
    }, null, 2) }] }),
  );

  server.tool('get_supported_circuits',
    `List every supported circuit and canonical guide URL. Hosted tools: get_supported_circuits, get_guide, prove. Read each guide for its attestation source, input schema and verification chain; payment networks are independent of circuit verification.
${guideLinks}`,
    async () => {
      const result = handleGetSupportedCircuits({ chainId: String(getChainId(resolvedConfig)) });
      const resultWithGuideUrls = { ...result, circuits: result.circuits.map(circuit => ({
        ...circuit, guide_url: guideUrl(canonicalCircuit(circuit.id)),
      })) };
      const { guidance } = getTaskOutcome('get_supported_circuits', result);
      return { content: [
        { type: 'text' as const, text: guidance },
        { type: 'text' as const, text: JSON.stringify(resultWithGuideUrls, null, 2) },
      ] };
    },
  );

  server.tool('get_guide',
    `Read the current circuit-specific guide before proof generation. Includes witness preparation, supported signature modes, verification chain and live deployment payment configuration.
${guideLinks}`,
    { circuit: circuitParam() },
    async ({ circuit }) => ({ content: [{ type: 'text' as const,
      text: JSON.stringify(buildGuide(canonicalCircuit(circuit), resolvedConfig), null, 2),
    }] }),
  );

  server.prompt('proof_generation_flow', 'Discover the circuit, read its current guide and generate a proof via the deployment REST endpoint.', () => ({ messages: [{
    role: 'user', content: { type: 'text', text: `ZKProofport proof generation

1. Call get_supported_circuits.
2. Read each circuit's guide_url or call get_guide.
${guideLinks}
3. Prepare the selected circuit's witness locally using @zkproofport-ai/sdk or @zkproofport-ai/mcp. Never pass private keys to the server or an LLM.
${actionGuidance}
${privacyGuidance}
4. Use POST ${baseUrl}/api/v1/prove. The hosted prove tool returns the REST redirect; the local MCP generate_proof tool orchestrates the full flow.
${flow}
5. Verify using the circuit guide and returned verification metadata. Payment does not select the proof verification chain. An identity-only proof never authorizes an application action.` },
  }] }));
  return server;
}
