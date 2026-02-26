import type { Config } from '../config/index.js';
import type { Request, Response } from 'express';
import type { AgentCard as SDKAgentCard } from '@a2a-js/sdk';
import { ERC8004_ADDRESSES } from '../config/contracts.js';

export type AgentCard = SDKAgentCard & {
  identity?: {
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
    attestationEndpoint: string;
  };
};

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
    name: 'proveragent.base.eth',
    description: 'Autonomous ZK proof generation. ERC-8004 identity. x402 payments. Powered by ZKProofport',
    url: `${config.a2aBaseUrl}/a2a`,
    version: config.agentVersion,
    protocolVersion: '0.3.0',
    preferredTransport: 'JSONRPC',
    provider: {
      organization: 'ZKProofport',
      url: 'https://zkproofport.app',
    },
    capabilities: {
      streaming: true,
      pushNotifications: false,
      stateTransitionHistory: true,
    },
    skills: [
      {
        id: 'request_signing',
        name: 'Request Wallet Signing',
        description: '[STEP 1/5] Start a proof generation session. Returns a URL where the user connects their wallet and signs. Use the same contextId for all subsequent calls (check_status, request_payment, generate_proof) to auto-link the session.',
        tags: ['signing', 'wallet', 'session'],
        examples: [
          'I want to generate a KYC proof',
          'Start a proof for my Coinbase attestation',
        ],
        inputModes: ['application/json'],
        outputModes: ['application/json'],
      },
      {
        id: 'check_status',
        name: 'Check Request Status',
        description: '[STEP 2/5] Check signing and payment status. Returns phase: signing | payment | ready | expired. If using the same contextId as request_signing, the requestId is auto-resolved. When phase is "payment", call request_payment. When "ready", call generate_proof.',
        tags: ['status', 'polling'],
        examples: [
          'Check if signing is complete',
          'What is the status of my request?',
        ],
        inputModes: ['application/json'],
        outputModes: ['application/json'],
      },
      {
        id: 'request_payment',
        name: 'Request Payment',
        description: '[STEP 3/5] Initiate USDC payment for proof generation. Returns a payment URL. Only call when check_status shows phase "payment". Signing must be completed first.',
        tags: ['payment', 'usdc', 'x402'],
        examples: [
          'I need to pay for the proof',
          'Get the payment link',
        ],
        inputModes: ['application/json'],
        outputModes: ['application/json'],
      },
      {
        id: 'generate_proof',
        name: 'Generate ZK Proof',
        description: '[STEP 4/5] Generate a zero-knowledge proof. Call when check_status shows phase "ready". If using the same contextId, the requestId is auto-resolved. Proof generation takes 30-90 seconds.',
        tags: ['zk-proof', 'privacy', 'coinbase', 'attestation', 'noir'],
        examples: [
          'Generate a KYC proof for my Coinbase account',
          'Create a country attestation proof for US residency',
          'Prove Coinbase verification without revealing identity',
        ],
        inputModes: ['application/json'],
        outputModes: ['application/json'],
      },
      {
        id: 'verify_proof',
        name: 'Verify ZK Proof',
        description: '[STEP 5/5 — OPTIONAL] Verify a zero-knowledge proof on-chain against the deployed verifier contract. Not part of the standard generation flow.',
        tags: ['verification', 'on-chain', 'smart-contract'],
        examples: [
          'Verify this proof on Base Sepolia',
          'Check if a KYC proof is valid on-chain',
        ],
        inputModes: ['application/json'],
        outputModes: ['application/json'],
      },
      {
        id: 'get_supported_circuits',
        name: 'Get Supported Circuits',
        description: '[DISCOVERY] List all supported ZK circuits with metadata. Call this first to discover available circuits before starting a proof generation flow.',
        tags: ['circuits', 'metadata', 'discovery'],
        examples: [
          'What circuits do you support?',
          'List available proof types',
        ],
        inputModes: ['application/json'],
        outputModes: ['application/json'],
      },
    ],
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
        attestationEndpoint: `${config.a2aBaseUrl}/api/v1/attestation/{proofId}`,
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
    protocolVersion: '2025-11-25',
    serverInfo: {
      name: 'proveragent.base.eth',
      version: config.agentVersion,
      description: 'proveragent.base.eth — Autonomous ZK proof generation. ERC-8004 identity. x402 payments. Powered by ZKProofport',
    },
    capabilities: {
      tools: {},
    },
    tools: [
      {
        name: 'request_signing',
        description: '[STEP 1/5] Start a proof generation session. Returns a signing URL and requestId. After user signs, call check_status with the requestId.',
        inputSchema: {
          type: 'object',
          properties: {
            circuitId: { type: 'string', description: 'Circuit identifier: coinbase_attestation or coinbase_country_attestation' },
            scope: { type: 'string', description: 'Privacy scope string' },
            countryList: { type: 'array', items: { type: 'string' }, description: 'Country codes for country attestation' },
            isIncluded: { type: 'boolean', description: 'Prove inclusion or exclusion from country list' },
          },
          required: ['circuitId', 'scope'],
        },
      },
      {
        name: 'check_status',
        description: '[STEP 2/5] Check signing and payment status of a proof request. Returns phase: signing | payment | ready | expired. When "payment", call request_payment. When "ready", call generate_proof.',
        inputSchema: {
          type: 'object',
          properties: {
            requestId: { type: 'string', description: 'Request ID from request_signing' },
          },
          required: ['requestId'],
        },
      },
      {
        name: 'request_payment',
        description: '[STEP 3/5] Initiate USDC payment for proof generation. Returns a payment URL. Only call when check_status shows phase "payment".',
        inputSchema: {
          type: 'object',
          properties: {
            requestId: { type: 'string', description: 'Request ID from request_signing' },
          },
          required: ['requestId'],
        },
      },
      {
        name: 'generate_proof',
        description: '[STEP 4/5] Generate a zero-knowledge proof. Call with requestId when check_status shows phase "ready". Takes 30-90 seconds.',
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
        description: '[STEP 5/5 — OPTIONAL] Verify a zero-knowledge proof on-chain via deployed verifier contract. Not part of the standard generation flow.',
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
        description: '[DISCOVERY] List all supported ZK circuits with metadata. Call first before starting a proof generation flow.',
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
    ...(config.teeMode !== 'disabled' && {
      'x-tee': {
        mode: config.teeMode,
        attestationEnabled: config.teeAttestationEnabled,
        attestationFormat: config.teeMode === 'nitro' ? 'aws-nitro-nsm' : 'simulated',
        attestationEndpoint: `${config.a2aBaseUrl}/api/v1/attestation/{proofId}`,
      },
    }),
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
    name: 'proveragent.base.eth',
    description:
      'Autonomous ZK proof generation. ERC-8004 identity. x402 payments. Powered by ZKProofport',
    image: `${config.a2aBaseUrl}/icon.png`,
    agentType: 'service',
    tags: ['ZK', 'Privacy', 'Proof', 'Coinbase', 'KYC', 'Attestation', 'x402'],
    services: [
      {
        name: 'web',
        endpoint: config.websiteUrl,
        version: config.agentVersion,
      },
      {
        name: 'OASF',
        endpoint: `${config.a2aBaseUrl}/.well-known/oasf.json`,
        version: 'v0.8.0',
        skills: ['Proof Session Management', 'Proof Generation', 'Proof Verification', 'Circuit Management'],
        domains: ['Privacy', 'Identity'],
      },
      {
        name: 'A2A',
        endpoint: `${config.a2aBaseUrl}/.well-known/agent-card.json`,
        version: '0.3.0',
        a2aSkills: ['request_signing', 'check_status', 'request_payment', 'generate_proof', 'verify_proof', 'get_supported_circuits'],
      },
      {
        name: 'MCP',
        endpoint: `${config.a2aBaseUrl}/.well-known/mcp.json`,
        version: '2024-11-05',
        mcpTools: ['request_signing', 'check_status', 'request_payment', 'generate_proof', 'verify_proof', 'get_supported_circuits'],
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
    ...(config.teeMode !== 'disabled' && {
      teeMetadata: {
        mode: config.teeMode,
        attestationEnabled: config.teeAttestationEnabled,
        attestationFormat: config.teeMode === 'nitro' ? 'aws-nitro-nsm' : 'simulated',
        attestationEndpoint: `${config.a2aBaseUrl}/api/v1/attestation/{proofId}`,
      },
    }),
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
export function getAgentCardHandler(config: Config, tokenId?: bigint | null): (req: Request, res: Response) => void | Promise<void> {
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
export function getMcpDiscoveryHandler(config: Config): (req: Request, res: Response) => void | Promise<void> {
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
export function getOasfAgentHandler(config: Config, tokenId?: bigint | null): (req: Request, res: Response) => void | Promise<void> {
  const oasfAgent = buildOasfAgent(config, tokenId);

  return (_req: Request, res: Response) => {
    res.setHeader('Content-Type', 'application/json');
    res.json(oasfAgent);
  };
}
