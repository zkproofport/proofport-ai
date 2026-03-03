import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { loadConfig } from '../config/index.js';
import {
  handleGetSupportedCircuits,
  type SkillDeps,
} from '../skills/skillHandler.js';
import { getTaskOutcome } from '../skills/flowGuidance.js';
import type { RateLimiter } from '../redis/rateLimiter.js';
import type { ProofCache } from '../redis/proofCache.js';
import type { RedisClient } from '../redis/client.js';
import type { TeeProvider } from '../tee/types.js';
import { ProofSessionManager } from '../proof/sessionManager.js';

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
  nargoPath?: string;
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

  // ─── proof_request ──────────────────────────────────────────────────
  server.tool(
    'proof_request',
    `ZKProofport is a privacy infrastructure for generating zero-knowledge proofs of Coinbase KYC and country-of-residence attestations on the Base blockchain.

THIS TOOL: Creates a new proof session. Only requires the "circuit" parameter. Returns a session_id, payment instructions (with nonce), and a guide_url. The AI agent must:
  1. Read the guide_url to learn how to prepare ALL inputs for the prove step
  2. Follow the guide to collect all required circuit inputs (EAS attestation TX, Merkle proof, public keys, signal_hash, nullifier, scope_bytes, merkle_root, user_address)
  3. Make payment via x402 protocol: sign EIP-3009 TransferWithAuthorization with the session nonce, then settle via x402 facilitator (https://www.x402.org/facilitator/settle)
  4. Call POST /api/v1/prove (REST endpoint) with session_id, payment_tx_hash (from settlement), and all prepared inputs

No address, scope, or signal_hash is needed at this stage — only circuit.

SUPPORTED CIRCUITS:
  - "coinbase_kyc": Proves the user passed Coinbase KYC verification.
  - "coinbase_country": Proves the user's country of residence is (or is not) in a given list.

RESPONSE FIELDS:
  - session_id: Use in all subsequent steps
  - guide_url: Read this URL to get the full 11-step preparation guide for all prove inputs
  - payment.nonce: MUST be used as the EIP-3009 nonce when signing TransferWithAuthorization
  - payment.recipient, payment.amount, payment.asset, payment.network: Payment details

SESSION EXPIRY:
  Sessions expire after 10 minutes. If expired, create a new session.`,
    {
      circuit: z.enum(['coinbase_kyc', 'coinbase_country']).describe('Which circuit to use. "coinbase_kyc" proves Coinbase KYC verification. "coinbase_country" proves country of residence.'),
    },
    async (args) => {
      try {
        const resolvedConfig = config || loadConfig();
        if (!deps.redis) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Redis is not available in this MCP context. Use the REST endpoint POST /api/v1/proof/session instead.' }) }], isError: true };
        }

        const circuitMap: Record<string, 'coinbase_attestation' | 'coinbase_country_attestation'> = {
          coinbase_kyc: 'coinbase_attestation',
          coinbase_country: 'coinbase_country_attestation',
        };
        const circuitId = circuitMap[args.circuit];

        const manager = new ProofSessionManager(deps.redis);
        const session = await manager.createSession({
          circuit: circuitId,
        });

        const paymentMode = deps.paymentMode || resolvedConfig.paymentMode || 'disabled';
        const paymentPayTo = resolvedConfig.paymentPayTo || '';
        const isTestnet = paymentMode === 'testnet';
        const usdcAddress = isTestnet
          ? '0x036CbD53842c5426634e7929541eC2318f3dCF7e'
          : '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
        const network = isTestnet ? 'base-sepolia' : 'base';
        const guideUrl = `${resolvedConfig.a2aBaseUrl}/api/v1/guide/${args.circuit}`;

        const response = {
          session_id: session.session_id,
          expires_at: session.expires_at,
          circuit: args.circuit,
          guide_url: guideUrl,
          payment: {
            nonce: session.payment_nonce,
            recipient: paymentPayTo,
            amount: 100000,
            asset: usdcAddress,
            network,
            instruction: `Sign EIP-3009 TransferWithAuthorization for 100000 USDC base units ($0.10) to ${paymentPayTo} on ${network} using nonce ${session.payment_nonce}. Settle via x402 facilitator (https://www.x402.org/facilitator/settle). Submit the resulting tx hash to POST /api/v1/prove.`,
          },
          next_steps: [
            `1. Read the guide at ${guideUrl} to learn how to prepare all inputs`,
            '2. Follow the 11-step guide to prepare all circuit inputs (signal_hash, nullifier, scope_bytes, merkle_root, user_address, signature, pubkeys, raw_transaction, merkle_proof)',
            `3. Sign EIP-3009 TransferWithAuthorization to ${paymentPayTo} using nonce ${session.payment_nonce}, then settle via x402 facilitator`,
            '4. Call POST /api/v1/prove with session_id, payment_tx_hash (from settlement), and all prepared inputs',
          ],
        };

        return { content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }] };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }], isError: true };
      }
    },
  );

  // ─── prove ──────────────────────────────────────────────────────────
  server.tool(
    'prove',
    `Submit all proof inputs and generate a ZK proof. This is Phase 3 of the ZKProofport flow. It atomically verifies the on-chain USDC payment and then runs the Noir circuit inside a Trusted Execution Environment (TEE) to produce a Groth16 SNARK proof.

IMPORTANT: MCP tool calls have timeout limitations that make this tool UNSUITABLE for the 30-90 second proof generation process. This tool returns a redirect message. Use the REST endpoint directly:
  POST https://stg-ai.zkproofport.app/api/v1/prove   (staging)
  POST https://ai.zkproofport.app/api/v1/prove        (production)

REQUEST BODY SCHEMA:
  {
    "session_id": "<string>",        // from proof_request response
    "payment_tx_hash": "<string>",   // 0x-prefixed hash of the USDC transfer TX on Base
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

HOW TO PREPARE EACH FIELD:

signature:
  Call eth_sign(signal_hash) on the user's KYC wallet. This is the raw Ethereum signature (NOT EIP-712 typed data, NOT personal_sign which prepends a prefix). Result is 65 bytes: r (32 bytes) + s (32 bytes) + v (1 byte). The v byte is 27 or 28.
  Example: "0xabcd...ef1b" (132 hex chars + 0x prefix = 134 chars total)

user_pubkey_x / user_pubkey_y:
  Recover the secp256k1 public key from the eth_sign signature via ecrecover(signal_hash, v, r, s). Extract the uncompressed public key (64 bytes), split into x (first 32 bytes) and y (last 32 bytes). Express each as 0x-prefixed 32-byte hex.
  Ethers.js v6 example:
    const sig = ethers.Signature.from(signature);
    const pubkey = ethers.SigningKey.recoverPublicKey(signal_hash, sig);
    // pubkey is "0x04<64 bytes>", strip the "04" prefix
    const pubkeyBytes = pubkey.slice(4); // remove "0x04"
    const user_pubkey_x = "0x" + pubkeyBytes.slice(0, 64);
    const user_pubkey_y = "0x" + pubkeyBytes.slice(64, 128);

raw_transaction:
  Fetch the EAS attestation transaction from Base chain using eth_getTransactionByHash(attestation_tx_hash). RLP-encode the transaction to get the raw bytes. The server pads this to 300 bytes internally, but you must provide tx_length = actual byte length before padding.
  RLP encoding fields (EIP-2718 legacy TX): [nonce, gasPrice, gasLimit, to, value, data, v, r, s]
  For EIP-1559 TXs (type 2): [chainId, nonce, maxPriorityFeePerGas, maxFeePerGas, gasLimit, to, value, data, accessList, v, r, s]
  Many libraries (ethers, web3) provide getTransaction() which returns structured data; use RLP.encode() to re-serialize.
  The raw_transaction is the 0x-prefixed hex of these bytes.

tx_length:
  The byte count of raw_transaction BEFORE the server zero-pads to 300. If raw_transaction is "0xaabbcc..." and has N bytes, then tx_length = N.

coinbase_attester_pubkey_x / coinbase_attester_pubkey_y:
  Recover the public key that signed the EAS attestation transaction on-chain. Use ecrecover on the attestation TX (v, r, s from the TX, combined with the TX hash = keccak256 of the RLP-encoded unsigned TX body). This is the Coinbase attester's secp256k1 public key. Split into x/y same as above.

merkle_proof, leaf_index, depth:
  Authorized signers list (these are the only valid Coinbase attesters):
    Index 0: 0x952f32128AF084422539C4Ff96df5C525322E564
    Index 1: 0x8844591D47F17bcA6F5dF8f6B64F4a739F1C0080
    Index 2: 0x88fe64ea2e121f49bb77abea6c0a45e93638c3c5
    Index 3: 0x44ace9abb148e8412ac4492e9a1ae6bd88226803

  Steps to build the Merkle tree:
    1. Compute leaf hashes: leaf_i = keccak256(abi.encodePacked(signers[i]))  (i.e. keccak256 of the 20-byte address)
    2. Build a binary Merkle tree bottom-up. Pair leaves left-to-right, hash pairs: parent = keccak256(left || right). Pad with zero hashes if odd number of nodes.
    3. Find leaf_index = index of the coinbase attester in the signers list.
    4. Collect sibling hashes at each level from bottom to top = merkle_proof array.
    5. depth = number of levels in the tree. With 4 signers, depth = 2 (leaves → level 1 → root). Max depth = 8.

EAS GRAPHQL QUERY EXAMPLE (Base Sepolia):
  endpoint: https://base-sepolia.easpcan.org/graphql
  endpoint (Base mainnet): https://base.easpcan.org/graphql

  query FindAttestation {
    attestations(where: {
      schemaId: { equals: "0xf8b05c79f090979bf4a80270aba232dff11a10d9ca55c4f88de95317970f0de9" },
      recipient: { equals: "0xYourAddress" },
      revoked: { equals: false }
    }, orderBy: { time: desc }, take: 1) {
      id
      txHash
      attester
      time
      data
    }
  }

RESPONSE SCHEMA (from REST endpoint):
  {
    "proof": "0x...",                // raw Groth16 proof bytes
    "publicInputs": "0x...",         // concatenated bytes32 public inputs
    "proofWithInputs": "0x...",      // proof + publicInputs combined for on-chain call
    "attestation": { ... } | null,   // TEE attestation when running in Nitro Enclave
    "timing": {
      "totalMs": 45000,
      "paymentVerifyMs": 200,
      "inputBuildMs": 500,
      "proveMs": 44300
    }
  }

VERIFIER ADDRESSES (Base Sepolia, chain ID 84532):
  coinbase_kyc (coinbase_attestation):         0x0036B61dBFaB8f3CfEEF77dD5D45F7EFBFE2035c
  coinbase_country (coinbase_country_attestation): 0xdEe363585926c3c28327Efd1eDd01cf4559738cf`,
    {
      session_id: z.string().describe('Session ID from proof_request response'),
      payment_tx_hash: z.string().describe('0x-prefixed transaction hash of the USDC transfer on Base chain. The server verifies this TX on-chain.'),
      inputs: z.object({
        signal_hash: z.string().describe('0x-prefixed 32-byte signal hash: keccak256(abi.encodePacked(address, scope, circuitId))'),
        nullifier: z.string().describe('0x-prefixed 32-byte nullifier: privacy-preserving unique identifier'),
        scope_bytes: z.string().describe('0x-prefixed 32-byte keccak256 of the scope string'),
        merkle_root: z.string().describe('0x-prefixed 32-byte Merkle root of authorized attesters tree'),
        user_address: z.string().describe('0x-prefixed 20-byte wallet address with Coinbase attestation'),
        signature: z.string().describe('65-byte eth_sign signature (0x-prefixed hex, 134 chars). Sign signal_hash with the KYC wallet using eth_sign.'),
        user_pubkey_x: z.string().describe('32-byte secp256k1 public key X coordinate (0x-prefixed hex). Recovered via ecrecover(signal_hash, signature).'),
        user_pubkey_y: z.string().describe('32-byte secp256k1 public key Y coordinate (0x-prefixed hex). Recovered via ecrecover(signal_hash, signature).'),
        raw_transaction: z.string().describe('0x-prefixed RLP-encoded EAS attestation transaction bytes from Base chain. Fetch via eth_getTransactionByHash(attestation_txHash) then RLP-encode.'),
        tx_length: z.number().describe('Actual byte length of raw_transaction before server zero-pads to 300 bytes.'),
        coinbase_attester_pubkey_x: z.string().describe('32-byte secp256k1 X coordinate of Coinbase attester public key (0x-prefixed). Recovered via ecrecover on the attestation TX.'),
        coinbase_attester_pubkey_y: z.string().describe('32-byte secp256k1 Y coordinate of Coinbase attester public key (0x-prefixed). Recovered via ecrecover on the attestation TX.'),
        merkle_proof: z.array(z.string()).describe('Array of 32-byte sibling hashes (0x-prefixed) in the Merkle tree, from leaf level to root. Proves the attester is in the authorized signers list.'),
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
            note: 'Send the same session_id, payment_tx_hash, and inputs fields as this tool accepts in the JSON request body.',
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
  2. proof_request — create a proof session (call this NEXT with circuit parameter)
  3. prove — submit proof inputs (redirects to REST endpoint for long-running proof generation)

IMPORTANT: Do NOT call "generate_proof" or any other tool name. The correct flow is:
  get_supported_circuits → proof_request → (follow guide) → prove

CIRCUITS:
  1. coinbase_attestation ("coinbase_kyc")
     - Proves the user has passed Coinbase KYC identity verification
     - EAS Schema ID: 0xf8b05c79f090979bf4a80270aba232dff11a10d9ca55c4f88de95317970f0de9
     - Verifier (Base Sepolia, chain 84532): 0x0036B61dBFaB8f3CfEEF77dD5D45F7EFBFE2035c
     - Required inputs: address, signature, scope
     - Use circuit = "coinbase_kyc" in proof_request

  2. coinbase_country_attestation ("coinbase_country")
     - Proves the user's country of residence from Coinbase attestation is in (or not in) a given country list
     - EAS Schema ID: 0x1801901fabd0e6189356b4fb52bb0ab855276d84f7ec140839fbd1f6801ca065
     - Verifier (Base Sepolia, chain 84532): 0xdEe363585926c3c28327Efd1eDd01cf4559738cf
     - Required inputs: address, signature, scope, countryList, isIncluded
     - Use circuit = "coinbase_country" in proof_request

CHAIN INFORMATION:
  - Current deployments are on Base Sepolia (chain ID 84532, testnet)
  - Base mainnet (chain ID 8453) deployments TBD
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
      const result = handleGetSupportedCircuits({});
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

  // ─── proof_generation_flow prompt ──────────────────────────────────
  server.prompt(
    'proof_generation_flow',
    'Complete autonomous guide for AI agents: step-by-step ZKProofport proof generation using the new circuit-only proof_request flow with guide_url',
    () => ({
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: `## ZKProofport Autonomous Proof Generation Guide

ZKProofport generates zero-knowledge proofs of Coinbase KYC and country-of-residence attestations using Noir circuits running in a Trusted Execution Environment (AWS Nitro Enclave). Proofs are verified on-chain via Groth16 SNARK verifier contracts on Base.

---

### STEP 0: Discover Circuits

Call \`get_supported_circuits\` to confirm available circuits, verifier addresses, EAS schema IDs, and guide URLs.

Each circuit entry includes a \`guide_url\` — read it in the next step to learn exactly how to prepare all inputs.

---

### STEP 1: Read the Circuit Guide

Fetch the \`guide_url\` from the circuit you want to use. The guide contains the complete 11-step preparation walkthrough covering:
- How to compute signal_hash, nullifier, scope_bytes, merkle_root
- How to query EAS GraphQL for the attestation
- How to RLP-encode the attestation transaction
- How to recover secp256k1 public keys via ecrecover
- How to build the Merkle proof for the authorized attesters list
- All required input fields and their exact formats

Read the guide BEFORE calling proof_request, so you understand all inputs needed for the prove step.

---

### STEP 2: Create Proof Session

Call \`proof_request\` with only:
- circuit: "coinbase_kyc" or "coinbase_country"

You receive:
\`\`\`json
{
  "session_id": "ses_abc123",
  "circuit": "coinbase_kyc",
  "guide_url": "https://stg-ai.zkproofport.app/api/v1/guide/coinbase_kyc",
  "payment": {
    "nonce": "0x7f3a...",
    "recipient": "0x5A3E...",
    "amount": 100000,
    "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    "network": "base-sepolia"
  },
  "expires_at": "2024-01-01T00:10:00Z"
}
\`\`\`

---

### STEP 3: Prepare All Inputs (follow the guide)

Using the guide from Step 1, prepare ALL inputs required for the prove step. This includes collecting:
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

### STEP 4: Send USDC Payment

Ask the user to send USDC to the payment.recipient with the payment.nonce in the transaction data field.

CRITICAL: The payment nonce MUST appear in the transaction input/data field. The server reads the on-chain TX and checks for this nonce to bind the payment to the session.

USDC addresses:
- Base Sepolia: \`0x036CbD53842c5426634e7929541eC2318f3dCF7e\`
- Base mainnet: \`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913\`

Amount = 100000 (USDC 6-decimal units = $0.10).

---

### STEP 5: Submit to REST Endpoint

MCP timeout limitations prevent running 30-90 second proof generation via MCP tools. Call the REST API directly:

\`\`\`
POST https://stg-ai.zkproofport.app/api/v1/prove
Content-Type: application/json

{
  "session_id": "ses_abc123",
  "payment_tx_hash": "0x...",
  "inputs": {
    "signal_hash": "0x...",
    "nullifier": "0x...",
    "scope_bytes": "0x...",
    "merkle_root": "0x...",
    "user_address": "0x...",
    "signature": "0x...",
    "user_pubkey_x": "0x...",
    "user_pubkey_y": "0x...",
    "raw_transaction": "0x...",
    "tx_length": 180,
    "coinbase_attester_pubkey_x": "0x...",
    "coinbase_attester_pubkey_y": "0x...",
    "merkle_proof": ["0x...", "0x..."],
    "leaf_index": 0,
    "depth": 2
  }
}
\`\`\`

For coinbase_country circuit, also include in inputs:
\`\`\`json
"country_list": ["US", "KR"],
"is_included": true
\`\`\`

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

The nullifier is a privacy-preserving unique identifier: same wallet + same scope = same nullifier (prevents double-use without revealing identity).

---

### VERIFIER CONTRACTS (Base Sepolia, chain 84532)

| Circuit | Address |
|---------|---------|
| coinbase_attestation | 0x0036B61dBFaB8f3CfEEF77dD5D45F7EFBFE2035c |
| coinbase_country_attestation | 0xdEe363585926c3c28327Efd1eDd01cf4559738cf |

Call \`verify(proof, publicInputs)\` on the verifier contract to confirm the proof on-chain.
`,
        }
      }]
    })
  );

  return server;
}
