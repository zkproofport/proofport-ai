import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { loadConfig } from '../config/index.js';
import { generateProof } from './tools/generateProof.js';
import { verifyProof } from './tools/verifyProof.js';
import { getSupportedCircuits } from './tools/getCircuits.js';
import type { RateLimiter } from '../redis/rateLimiter.js';
import type { ProofCache } from '../redis/proofCache.js';

export interface McpServerDeps {
  rateLimiter?: RateLimiter;
  proofCache?: ProofCache;
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
      },
    },
  );

  // ─── generate_proof ─────────────────────────────────────────────────
  server.tool(
    'generate_proof',
    'Generate a zero-knowledge proof for a given circuit. Requires the user wallet address, signature over the signal hash, privacy scope, and circuit identifier.',
    {
      address: z.string().describe('KYC wallet address (0x-prefixed, 20 bytes)'),
      signature: z.string().describe('User signature over the signal hash (0x-prefixed, 65 bytes)'),
      scope: z.string().describe('Privacy scope string for nullifier computation'),
      circuitId: z.string().describe('Circuit identifier: coinbase_attestation or coinbase_country_attestation'),
      countryList: z.array(z.string()).optional().describe('Country codes for country attestation (e.g., ["US", "KR"])'),
      isIncluded: z.boolean().optional().describe('Whether to prove inclusion or exclusion from the country list'),
    },
    async (args) => {
      try {
        const config = loadConfig();
        const result = await generateProof(
          {
            address: args.address,
            signature: args.signature,
            scope: args.scope,
            circuitId: args.circuitId,
            countryList: args.countryList,
            isIncluded: args.isIncluded,
          },
          {
            easGraphqlEndpoint: config.easGraphqlEndpoint,
            rpcUrls: [config.baseRpcUrl],
            bbPath: config.bbPath,
            nargoPath: config.nargoPath,
            circuitsDir: config.circuitsDir,
            rateLimiter: deps.rateLimiter,
            proofCache: deps.proofCache,
          },
        );

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ error: message }),
            },
          ],
          isError: true,
        };
      }
    },
  );

  // ─── verify_proof ───────────────────────────────────────────────────
  server.tool(
    'verify_proof',
    'Verify a zero-knowledge proof on-chain by calling the deployed verifier contract.',
    {
      proof: z.string().describe('The proof bytes (0x-prefixed hex string)'),
      publicInputs: z.array(z.string()).describe('The public inputs as bytes32 hex strings'),
      circuitId: z.string().describe('Circuit identifier: coinbase_attestation or coinbase_country_attestation'),
      chainId: z.string().optional().describe('Chain ID (default: 84532 for Base Sepolia)'),
    },
    async (args) => {
      try {
        const config = loadConfig();
        const result = await verifyProof(
          {
            proof: args.proof,
            publicInputs: args.publicInputs,
            circuitId: args.circuitId,
            chainId: args.chainId,
          },
          {
            rpcUrl: config.chainRpcUrl,
            defaultChainId: '84532',
          },
        );

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ error: message }),
            },
          ],
          isError: true,
        };
      }
    },
  );

  // ─── get_supported_circuits ─────────────────────────────────────────
  server.tool(
    'get_supported_circuits',
    'List all supported ZK circuits with their metadata, required inputs, and descriptions.',
    async () => {
      const result = getSupportedCircuits();
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    },
  );

  return server;
}

