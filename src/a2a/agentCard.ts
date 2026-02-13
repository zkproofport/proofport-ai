import type { Config } from '../config/index.js';
import type { Request, Response } from 'express';
import { ERC8004_ADDRESSES } from '../config/contracts.js';

export type AgentCard = {
  name: string;
  description: string;
  url: string;
  version: string;
  protocolVersion: string;
  capabilities: {
    streaming: boolean;
    pushNotifications: boolean;
  };
  skills: Array<{
    id: string;
    name: string;
    description: string;
    inputModes: string[];
    outputModes: string[];
  }>;
  authentication: {
    schemes: Array<{ scheme: string; description: string }>;
  };
  defaultInputModes: string[];
  defaultOutputModes: string[];
  identity: {
    erc8004: {
      contractAddress: string;
      chainId: number;
      tokenId: string | null;
    };
  };
  tee?: {
    mode: string;
    attestationEnabled: boolean;
    attestationFormat: string;
  };
};

export type RequestHandler = (req: Request, res: Response) => void | Promise<void>;

/**
 * Build Agent Card JSON structure from config
 *
 * Pure function that constructs the A2A Agent Card based on environment configuration.
 *
 * @param config - Application configuration
 * @param tokenId - Optional ERC-8004 tokenId (set after registration)
 * @returns Agent Card JSON object
 */
export function buildAgentCard(config: Config, tokenId?: bigint | null): AgentCard {
  // Determine ERC-8004 identity based on environment
  const isProduction = config.nodeEnv === 'production';
  const erc8004Identity = isProduction
    ? ERC8004_ADDRESSES.mainnet.identity
    : ERC8004_ADDRESSES.sepolia.identity;
  const chainId = isProduction ? 8453 : 84532; // Base Mainnet : Base Sepolia

  return {
    name: 'ZKProofport Prover Agent',
    description: 'Zero-knowledge proof generation and verification for Coinbase attestations',
    url: config.a2aBaseUrl,
    version: config.agentVersion,
    protocolVersion: '0.3.0',
    capabilities: {
      streaming: true,
      pushNotifications: false,
    },
    skills: [
      {
        id: 'generate_proof',
        name: 'Generate ZK Proof',
        description: 'Generate a zero-knowledge proof for Coinbase KYC or country attestation',
        inputModes: ['application/json'],
        outputModes: ['application/json'],
      },
      {
        id: 'verify_proof',
        name: 'Verify ZK Proof',
        description: 'Verify a zero-knowledge proof against on-chain verifier contract',
        inputModes: ['application/json'],
        outputModes: ['application/json'],
      },
      {
        id: 'get_supported_circuits',
        name: 'Get Supported Circuits',
        description: 'List all supported ZK circuits with metadata',
        inputModes: ['application/json'],
        outputModes: ['application/json'],
      },
    ],
    authentication: {
      schemes: [{ scheme: 'x402', description: 'x402 micropayments' }],
    },
    defaultInputModes: ['application/json'],
    defaultOutputModes: ['application/json'],
    identity: {
      erc8004: {
        contractAddress: erc8004Identity,
        chainId,
        tokenId: tokenId !== null && tokenId !== undefined ? tokenId.toString() : null,
      },
    },
    ...(config.teeMode !== 'disabled' && {
      tee: {
        mode: config.teeMode,
        attestationEnabled: config.teeAttestationEnabled,
        attestationFormat: config.teeMode === 'nitro' ? 'aws-nitro-nsm' : 'simulated',
      },
    }),
  };
}

/**
 * Build MCP Discovery JSON structure
 *
 * @param config - Application configuration
 * @returns MCP discovery JSON object
 */
export function buildMcpDiscovery(config: Config) {
  return {
    protocolVersion: '2024-11-05',
    serverInfo: {
      name: 'zkproofport-prover',
      version: config.agentVersion,
      description: 'ZKProofport Prover Agent — Zero-knowledge proof generation and verification for Coinbase attestations',
    },
    capabilities: {
      tools: {},
    },
    tools: [
      {
        name: 'generate_proof',
        description: 'Generate a zero-knowledge proof for Coinbase KYC or country attestation',
        inputSchema: {
          type: 'object',
          properties: {
            scope: { type: 'string', description: 'Privacy scope string for nullifier computation' },
            circuitId: {
              type: 'string',
              description: 'Circuit identifier: coinbase_attestation or coinbase_country_attestation',
            },
            address: {
              type: 'string',
              description: 'KYC wallet address (0x-prefixed). Optional for web signing flow.',
            },
            signature: {
              type: 'string',
              description: 'User signature (0x-prefixed, 65 bytes). Optional — omit for web signing.',
            },
            requestId: { type: 'string', description: 'Signing request ID from Step 1 web signing flow.' },
            countryList: {
              type: 'array',
              items: { type: 'string' },
              description: 'Country codes for country attestation',
            },
            isIncluded: { type: 'boolean', description: 'Prove inclusion or exclusion from country list' },
          },
          required: ['scope', 'circuitId'],
        },
      },
      {
        name: 'verify_proof',
        description: 'Verify a zero-knowledge proof on-chain via deployed verifier contract',
        inputSchema: {
          type: 'object',
          properties: {
            proof: { type: 'string', description: 'Proof bytes (0x-prefixed hex)' },
            publicInputs: {
              type: 'array',
              items: { type: 'string' },
              description: 'Public inputs as bytes32 hex strings',
            },
            circuitId: { type: 'string', description: 'Circuit identifier' },
            chainId: { type: 'string', description: 'Chain ID (default: 84532)' },
          },
          required: ['proof', 'publicInputs', 'circuitId'],
        },
      },
      {
        name: 'get_supported_circuits',
        description: 'List all supported ZK circuits with metadata',
        inputSchema: {
          type: 'object',
          properties: {},
          required: [],
        },
      },
    ],
    'x-x402': {
      paymentRequired: config.paymentMode !== 'disabled',
      baseUrl: config.a2aBaseUrl,
      documentation: 'https://docs.zkproofport.app',
    },
  };
}

/**
 * Build OASF Agent JSON structure
 *
 * @param config - Application configuration
 * @param tokenId - Optional ERC-8004 tokenId (set after registration)
 * @returns OASF agent JSON object
 */
export function buildOasfAgent(config: Config, tokenId?: bigint | null) {
  const isProduction = config.nodeEnv === 'production';
  const erc8004Identity = isProduction
    ? ERC8004_ADDRESSES.mainnet.identity
    : ERC8004_ADDRESSES.sepolia.identity;

  return {
    type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
    name: 'ZKProofport',
    description:
      'Zero-knowledge proof generation and verification for Coinbase attestations. Supports x402 micropayments and ERC-8004 on-chain identity.',
    agentType: 'service',
    tags: ['ZK', 'Privacy', 'Proof', 'Coinbase', 'KYC', 'Attestation', 'x402'],
    services: [
      {
        name: 'web',
        endpoint: config.a2aBaseUrl,
        version: config.agentVersion,
      },
      {
        name: 'OASF',
        endpoint: `${config.a2aBaseUrl}/.well-known/agent.json`,
        version: 'v0.8.0',
        skills: ['Proof Generation', 'Proof Verification', 'Circuit Management'],
        domains: ['Privacy', 'Identity'],
      },
      {
        name: 'A2A',
        endpoint: `${config.a2aBaseUrl}/.well-known/agent-card.json`,
        version: '0.3.0',
        a2aSkills: ['generate_proof', 'verify_proof', 'get_supported_circuits'],
      },
      {
        name: 'MCP',
        endpoint: `${config.a2aBaseUrl}/.well-known/mcp.json`,
        version: '2024-11-05',
        mcpTools: ['generate_proof', 'verify_proof', 'get_supported_circuits'],
      },
    ],
    x402Support: config.paymentMode !== 'disabled',
    active: true,
    registrations: [
      ...(tokenId !== null && tokenId !== undefined
        ? [
            {
              agentId: Number(tokenId),
              agentRegistry: `eip155:${isProduction ? '8453' : '84532'}:${erc8004Identity}`,
            },
          ]
        : []),
    ],
    supportedTrust: config.teeMode !== 'disabled'
      ? ['reputation', 'tee-attestation']
      : ['reputation'],
  };
}

/**
 * Express handler for GET /.well-known/agent-card.json
 *
 * Returns the Agent Card JSON with proper Content-Type header.
 *
 * @param config - Application configuration
 * @param tokenId - Optional ERC-8004 tokenId (set after registration)
 * @returns Express request handler
 */
export function getAgentCardHandler(config: Config, tokenId?: bigint | null): RequestHandler {
  const agentCard = buildAgentCard(config, tokenId);

  return (_req: Request, res: Response) => {
    res.setHeader('Content-Type', 'application/json');
    res.json(agentCard);
  };
}

/**
 * Express handler for GET /.well-known/mcp.json
 *
 * Returns the MCP discovery JSON with proper Content-Type header.
 *
 * @param config - Application configuration
 * @returns Express request handler
 */
export function getMcpDiscoveryHandler(config: Config): RequestHandler {
  const mcpDiscovery = buildMcpDiscovery(config);

  return (_req: Request, res: Response) => {
    res.setHeader('Content-Type', 'application/json');
    res.json(mcpDiscovery);
  };
}

/**
 * Express handler for GET /.well-known/agent.json
 *
 * Returns the OASF agent JSON with proper Content-Type header.
 *
 * @param config - Application configuration
 * @param tokenId - Optional ERC-8004 tokenId (set after registration)
 * @returns Express request handler
 */
export function getOasfAgentHandler(config: Config, tokenId?: bigint | null): RequestHandler {
  const oasfAgent = buildOasfAgent(config, tokenId);

  return (_req: Request, res: Response) => {
    res.setHeader('Content-Type', 'application/json');
    res.json(oasfAgent);
  };
}
