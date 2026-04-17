import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { loadConfig, getChainId, isProductionChain } from '../config/index.js';
import {
  handleGetSupportedCircuits,
  type SkillDeps,
} from '../skills/skillHandler.js';
import { getTaskOutcome } from '../skills/flowGuidance.js';
import { buildGuide } from '../proof/guideBuilder.js';
import { getChainVerifiers } from '../config/deployments.js';
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

function buildSkillDeps(deps: McpServerDeps, config: ReturnType<typeof loadConfig>): SkillDeps {
  return {
    redis: deps.redis!,
    paymentMode: deps.paymentMode || config.paymentMode || 'disabled',
    paymentProofPrice: deps.paymentProofPrice || config.paymentProofPrice || '$0.10',
    easGraphqlEndpoint: deps.easGraphqlEndpoint || config.easGraphqlEndpoint,
    rpcUrls: deps.rpcUrls || [config.baseRpcUrl],
    bbPath: deps.bbPath || config.bbPath,
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
  const resolvedConfig = config || loadConfig();
  const chainId = getChainId(resolvedConfig);
  const chainName = isProductionChain(resolvedConfig) ? 'Ethereum Mainnet' : 'Base Sepolia';
  const chainVerifiers = getChainVerifiers(String(chainId));
  const kycVerifier = chainVerifiers['coinbase_attestation'] ?? '(address not yet loaded)';
  const countryVerifier = chainVerifiers['coinbase_country_attestation'] ?? '(address not yet loaded)';

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

  // ─── prove ──────────────────────────────────────────────────────────
  server.tool(
    'prove',
    `Submit proof inputs to generate a ZK proof via the x402 single-step flow. Atomically verifies USDC payment on-chain and runs the Noir circuit in a TEE to produce a Groth16 SNARK proof.

IMPORTANT: MCP tool calls have timeout limitations that make this tool UNSUITABLE for the 30-90 second proof generation process. This tool returns a redirect message. Use the REST endpoint directly:
  POST https://stg-ai.zkproofport.app/api/v1/prove   (staging)
  POST https://ai.zkproofport.app/api/v1/prove        (production)

x402 SINGLE-STEP FLOW:
  1. POST /api/v1/prove with { circuit, inputs } — no payment yet
  2. Server returns 402 with nonce in body
  3. Pay USDC using nonce, get tx hash
  4. Retry POST /api/v1/prove with same body + X-Payment-TX and X-Payment-Nonce headers

REQUEST BODY SCHEMA:
  {
    "circuit": "coinbase_kyc" | "coinbase_country",
    "inputs": {
      "signal_hash": "<string>",                  // 0x, 32 bytes: keccak256(abi.encodePacked(address, scope, circuitId))
      "nullifier": "<string>",                    // 0x, 32 bytes: privacy-preserving unique identifier
      "scope_bytes": "<string>",                  // 0x, 32 bytes: keccak256 of the scope string
      "merkle_root": "<string>",                  // 0x, 32 bytes: Merkle root of authorized attesters
      "user_address": "<string>",                 // 0x, 20 bytes: the KYC wallet address
      "signature": "<string>",                    // 65-byte hex: eth_sign(signal_hash) by KYC wallet
      "user_pubkey_x": "<string>",                // 32-byte hex: secp256k1 public key X coordinate
      "user_pubkey_y": "<string>",                // 32-byte hex: secp256k1 public key Y coordinate
      "raw_transaction": "<string>",              // 0x-prefixed RLP-encoded EAS attestation TX (padded to 300 bytes by server)
      "tx_length": <number>,                      // actual byte length of raw_transaction BEFORE zero-padding
      "coinbase_attester_pubkey_x": "<string>",   // 32-byte hex: Coinbase attester secp256k1 X coordinate
      "coinbase_attester_pubkey_y": "<string>",   // 32-byte hex: Coinbase attester secp256k1 Y coordinate
      "merkle_proof": ["<string>", ...],          // array of 32-byte hex sibling hashes (one per tree level)
      "leaf_index": <number>,                     // 0-based index of attester leaf in the Merkle tree
      "depth": <number>,                          // number of levels in the Merkle tree (max 8)
      "country_list": ["<string>", ...],          // optional: only for coinbase_country circuit
      "is_included": <boolean>                    // optional: only for coinbase_country circuit
    }
  }

VERIFIER ADDRESSES (${chainName}, chain ID ${chainId}):
  coinbase_kyc (coinbase_attestation):         ${kycVerifier}
  coinbase_country (coinbase_country_attestation): ${countryVerifier}`,
    {
      circuit: z.enum(['coinbase_kyc', 'coinbase_country']).describe('Which circuit to use.'),
      inputs: z.object({
        signal_hash: z.string().describe('0x-prefixed 32-byte signal hash: keccak256(abi.encodePacked(address, scope, circuitId))'),
        nullifier: z.string().describe('0x-prefixed 32-byte nullifier: privacy-preserving unique identifier'),
        scope_bytes: z.string().describe('0x-prefixed 32-byte keccak256 of the scope string'),
        merkle_root: z.string().describe('0x-prefixed 32-byte Merkle root of authorized attesters tree'),
        user_address: z.string().describe('0x-prefixed 20-byte wallet address with Coinbase attestation'),
        signature: z.string().describe('65-byte eth_sign signature (0x-prefixed hex, 134 chars). Sign signal_hash with the KYC wallet using eth_sign.'),
        user_pubkey_x: z.string().describe('32-byte secp256k1 public key X coordinate (0x-prefixed hex). Recovered via ecrecover(signal_hash, signature).'),
        user_pubkey_y: z.string().describe('32-byte secp256k1 public key Y coordinate (0x-prefixed hex). Recovered via ecrecover(signal_hash, signature).'),
        raw_transaction: z.string().describe('0x-prefixed RLP-encoded EAS attestation transaction bytes from Base chain.'),
        tx_length: z.number().describe('Actual byte length of raw_transaction before server zero-pads to 300 bytes.'),
        coinbase_attester_pubkey_x: z.string().describe('32-byte secp256k1 X coordinate of Coinbase attester public key (0x-prefixed).'),
        coinbase_attester_pubkey_y: z.string().describe('32-byte secp256k1 Y coordinate of Coinbase attester public key (0x-prefixed).'),
        merkle_proof: z.array(z.string()).describe('Array of 32-byte sibling hashes (0x-prefixed) in the Merkle tree, from leaf level to root.'),
        leaf_index: z.number().describe('0-based index of the coinbase attester in the authorized signers array.'),
        depth: z.number().describe('Number of levels in the Merkle tree. With 4 signers, depth = 2.'),
        country_list: z.array(z.string()).optional().describe('ISO 3166-1 alpha-2 country codes. Only for coinbase_country circuit.'),
        is_included: z.boolean().optional().describe('true = prove country IS in list, false = prove it is NOT. Only for coinbase_country circuit.'),
      }).describe('All circuit inputs required to generate the ZK proof.'),
    },
    async (_args) => {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            message: 'Use the REST endpoint POST /api/v1/prove instead. MCP tool calls have timeout limitations that make them unsuitable for 30-90 second proof generation.',
            rest_endpoint: 'POST /api/v1/prove',
            staging_url: 'https://stg-ai.zkproofport.app/api/v1/prove',
            production_url: 'https://ai.zkproofport.app/api/v1/prove',
            flow: 'x402 single-step: POST with {circuit, inputs} → 402 with nonce → pay → retry with X-Payment-TX and X-Payment-Nonce headers',
          }, null, 2),
        }],
      };
    },
  );

  // ─── get_supported_circuits ─────────────────────────────────────────
  server.tool(
    'get_supported_circuits',
    `List all ZK circuits supported by ZKProofport. Call this first to discover available circuits before starting proof generation.

AVAILABLE MCP TOOLS (use EXACT names — no other tool names exist):
  1. get_supported_circuits — this tool (discovery)
  2. prove — submit proof inputs (redirects to REST endpoint for long-running proof generation)

IMPORTANT: Do NOT call "generate_proof", "proof_request", or any other tool name. The correct flow is:
  get_supported_circuits → prove (x402 single-step: POST → 402 → pay → retry)

CIRCUITS:
  1. coinbase_attestation ("coinbase_kyc")
     - Proves the user has passed Coinbase KYC identity verification
     - EAS Schema ID: 0xf8b05c79f090979bf4a80270aba232dff11a10d9ca55c4f88de95317970f0de9
     - Verifier (${chainName}, chain ${chainId}): ${kycVerifier}
     - Required inputs: address, signature, scope
     - Use circuit = "coinbase_kyc" in the prove tool

  2. coinbase_country_attestation ("coinbase_country")
     - Proves the user's country of residence from Coinbase attestation is in (or not in) a given country list
     - EAS Schema ID: 0x1801901fabd0e6189356b4fb52bb0ab855276d84f7ec140839fbd1f6801ca065
     - Verifier (${chainName}, chain ${chainId}): ${countryVerifier}
     - Required inputs: address, signature, scope, countryList, isIncluded
     - Use circuit = "coinbase_country" in the prove tool

CHAIN INFORMATION:
  - Current deployments are on ${chainName} (chain ID ${chainId})
  - EAS (Ethereum Attestation Service) on Base: https://base.easpcan.org/graphql
  - EAS on Base Sepolia: https://base-sepolia.easpcan.org/graphql

AUTHORIZED COINBASE ATTESTERS (used for Merkle proof construction):
  - 0x952f32128AF084422539C4Ff96df5C525322E564 (index 0)
  - 0x8844591D47F17bcA6F5dF8f6B64F4a739F1C0080 (index 1)
  - 0x88fe64ea2e121f49bb77abea6c0a45e93638c3c5 (index 2)
  - 0x44ace9abb148e8412ac4492e9a1ae6bd88226803 (index 3)

USDC ADDRESSES (for payment):
  - Base Sepolia (testnet): 0x036CbD53842c5426634e7929541eC2318f3dCF7e
  - Base mainnet: 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913

Response fields:
- circuits (array): List of supported circuits with id, displayName, description, requiredInputs, easSchemaId, verifierAddress
- chainId (string): Chain ID for verifier addresses`,
    async () => {
      const resolvedConfig = config || loadConfig();
      const result = handleGetSupportedCircuits({}, deps?.paymentMode);
      const circuitAliasMap: Record<string, string> = {
        coinbase_attestation: 'coinbase_kyc',
        coinbase_country_attestation: 'coinbase_country',
      };
      const resultWithGuideUrls = {
        ...result,
        circuits: result.circuits.map(circuit => ({
          ...circuit,
          guide_url: `${resolvedConfig.a2aBaseUrl}/api/v1/guide/${circuitAliasMap[circuit.id] ?? circuit.id}`,
        })),
      };
      const { guidance } = getTaskOutcome('get_supported_circuits', result);
      return { content: [
        { type: 'text' as const, text: guidance },
        { type: 'text' as const, text: JSON.stringify(resultWithGuideUrls, null, 2) },
      ] };
    },
  );

  // ─── get_guide ──────────────────────────────────────────────────────
  server.tool(
    'get_guide',
    'Get a comprehensive step-by-step guide for preparing all inputs required for a specific circuit. Read this BEFORE attempting proof generation — the guide covers how to compute signal_hash, nullifier, scope_bytes, merkle_root, how to query EAS GraphQL for the attestation, how to RLP-encode the transaction, how to recover secp256k1 public keys, and how to build the Merkle proof.',
    {
      circuit: z.enum(['coinbase_kyc', 'coinbase_country']).describe('Circuit alias to get the guide for.'),
    },
    async ({ circuit }) => {
      const resolvedConfig = config || loadConfig();
      const circuitIdMap: Record<string, string> = {
        coinbase_kyc: 'coinbase_attestation',
        coinbase_country: 'coinbase_country_attestation',
      };
      const circuitId = circuitIdMap[circuit] ?? circuit;
      const guide = buildGuide(circuitId as any, resolvedConfig);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(guide, null, 2) }],
      };
    },
  );

  // ─── proof_generation_flow prompt ──────────────────────────────────
  server.prompt(
    'proof_generation_flow',
    'Complete autonomous guide for AI agents: step-by-step ZKProofport proof generation using the x402 single-step flow',
    () => ({
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: `## ZKProofport Autonomous Proof Generation Guide

ZKProofport generates zero-knowledge proofs of Coinbase KYC and country-of-residence attestations using Noir circuits running in a Trusted Execution Environment (AWS Nitro Enclave). All proof inputs are end-to-end encrypted (X25519 ECDH + AES-256-GCM) — the server acts as a blind relay and cannot read your inputs. Proofs are verified on-chain via Groth16 SNARK verifier contracts on Base.

---

### STEP 0: Discover Circuits

Call \`get_supported_circuits\` to confirm available circuits, verifier addresses, EAS schema IDs, and guide URLs.

Each circuit entry includes a \`guide_url\` — read it to learn exactly how to prepare all inputs.

---

### STEP 1: Read the Circuit Guide

Fetch the \`guide_url\` for the circuit you want to use. The guide covers:
- How to compute signal_hash, nullifier, scope_bytes, merkle_root
- How to query EAS GraphQL for the attestation
- How to RLP-encode the attestation transaction
- How to recover secp256k1 public keys via ecrecover
- How to build the Merkle proof for the authorized attesters list
- All required input fields and their exact formats

---

### STEP 2: Prepare All Inputs (follow the guide)

Prepare ALL inputs required for the prove step:
- signal_hash (32 bytes): keccak256(abi.encodePacked(address, scope, circuitId))
- nullifier (32 bytes): privacy-preserving unique identifier
- scope_bytes (32 bytes): keccak256 of the scope string
- merkle_root (32 bytes): Merkle root of authorized attesters
- user_address (20 bytes): the KYC wallet address
- signature (65 bytes): eth_sign(signal_hash) by the KYC wallet
- user_pubkey_x / user_pubkey_y: recovered from signature via ecrecover
- raw_transaction: RLP-encoded EAS attestation TX from Base chain
- tx_length: byte length before server zero-pads to 300 bytes
- coinbase_attester_pubkey_x / _y: recovered from attestation TX via ecrecover
- merkle_proof: array of 32-byte sibling hashes
- leaf_index / depth: position of attester in the Merkle tree

---

### STEP 3: x402 Single-Step Flow with E2E Encryption (via REST — MCP has timeout limitations)

MCP timeout limitations prevent running 30-90 second proof generation via MCP tools. Use the REST API directly.

All inputs are E2E encrypted with the TEE's attested public key. The server acts as a blind relay — it cannot read your proof inputs.

**3a. First call — get payment nonce + TEE public key (no payment yet):**
\`\`\`
POST https://stg-ai.zkproofport.app/api/v1/prove
Content-Type: application/json

{
  "circuit": "coinbase_kyc"
}
\`\`\`

Server returns 402 with nonce and TEE public key:
\`\`\`json
{
  "nonce": "0x7f3a...",
  "payment": { "recipient": "0x5A3E...", "amount": 100000, ... },
  "teePublicKey": { "publicKey": "<X25519 hex>", "keyId": "...", "attestationDocument": "..." }
}
\`\`\`

**3b. Encrypt inputs** with the TEE's X25519 public key using ECDH + AES-256-GCM. Encrypt structured inputs: \`{ circuitId, inputs }\`.

**3c. Pay USDC** using the nonce. Amount = 100000 (6-decimal units = $0.10).
- Base Sepolia USDC: \`0x036CbD53842c5426634e7929541eC2318f3dCF7e\`
- Base mainnet USDC: \`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913\`

**3d. Retry with encrypted payload + payment headers:**
\`\`\`
POST https://stg-ai.zkproofport.app/api/v1/prove
Content-Type: application/json
X-Payment-TX: 0x<tx_hash>
X-Payment-Nonce: 0x7f3a...

{
  "circuit": "coinbase_kyc",
  "encrypted_payload": {
    "ephemeralPublicKey": "...",
    "iv": "...",
    "ciphertext": "...",
    "authTag": "...",
    "keyId": "..."
  }
}
\`\`\`

For coinbase_country circuit, include country_list and is_included in the plaintext BEFORE encryption.

---

### RESPONSE

\`\`\`json
{
  "proof": "0x...",
  "publicInputs": "0x...",
  "proofWithInputs": "0x...",
  "attestation": null,
  "timing": { "totalMs": 45000 }
}
\`\`\`

---

### VERIFIER CONTRACTS (${chainName}, chain ${chainId})

| Circuit | Address |
|---------|---------|
| coinbase_attestation | ${kycVerifier} |
| coinbase_country_attestation | ${countryVerifier} |

Call \`verify(proof, publicInputs)\` on the verifier contract to confirm the proof on-chain.
`,
        }
      }]
    })
  );

  return server;
}
