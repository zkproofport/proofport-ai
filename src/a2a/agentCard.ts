import type { Config } from '../config/index.js';
import type { Request, Response } from 'express';
import type { AgentCard as SDKAgentCard } from '@a2a-js/sdk';
import { ERC8004_ADDRESSES } from '../config/contracts.js';

export type AgentCard = SDKAgentCard & {
  guides?: {
    description: string;
    coinbase_kyc: string;
    coinbase_country: string;
  };
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
    description: 'ZK proof generation agent for Coinbase KYC and country-of-residence verification. Generates zero-knowledge proofs from Coinbase Verified Account attestations on Base chain using Noir circuits in AWS Nitro TEE. Supports: (1) coinbase_kyc — prove KYC verification without revealing identity, (2) coinbase_country — prove country of residence with inclusion/exclusion lists. Payment via USDC on Base. ERC-8004 registered identity. x402 payment protocol compatible.',
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
        id: 'prove',
        name: 'Generate ZK Proof',
        description: `[SINGLE-STEP x402] Generate a zero-knowledge proof via x402 single-step flow. POST circuit + inputs → receive 402 with nonce → pay USDC → retry with X-Payment-TX and X-Payment-Nonce headers. Atomically verifies USDC payment on-chain and generates the ZK proof in TEE. Takes 30-90 seconds.

SUPPORTED CIRCUITS:
- coinbase_kyc: Prove Coinbase KYC verification without revealing identity. EAS schema 0xf8b05c79f090979bf4a80270aba232dff11a10d9ca55c4f88de95317970f0de9.
- coinbase_country: Prove country of residence with inclusion/exclusion list. EAS schema 0x1801901fabd0e6189356b4fb52bb0ab855276d84f7ec140839fbd1f6801ca065.

REQUIRED INPUTS (all prepared client-side — see guide_url for detailed instructions):
- circuit: "coinbase_kyc" or "coinbase_country"
- signal_hash: 0x-prefixed 32-byte signal hash (keccak256 of scope + address)
- nullifier: 0x-prefixed 32-byte nullifier (derived from attestation UID + scope)
- scope_bytes: 0x-prefixed 32-byte keccak256 of scope string
- merkle_root: 0x-prefixed 32-byte Merkle root of authorized signers tree
- user_address: 0x-prefixed 20-byte wallet address with Coinbase attestation
- signature: eth_sign(signal_hash) from the KYC wallet, 65 bytes (r+s+v)
- user_pubkey_x, user_pubkey_y: secp256k1 public key coordinates (recover via ecrecover from signature)
- raw_transaction: RLP-encoded EAS attestation transaction (zero-padded to 300 bytes)
- tx_length: Actual byte length before padding
- coinbase_attester_pubkey_x/y: Attester public key (recover via ecrecover from attestation TX)
- merkle_proof: Merkle proof for attester in authorized signers list (max depth 8)
- leaf_index, depth: Position in Merkle tree

PAYMENT: 0.1 USDC on Base. x402 protocol — nonce returned in 402 body, pay, retry with headers.

RETURNS: proof (hex), publicInputs (hex), proofWithInputs (hex for on-chain verification), TEE attestation document

ON-CHAIN VERIFICATION:
- Verifier contracts on Base Sepolia: coinbase_attestation=0x0036B61dBFaB8f3CfEEF77dD5D45F7EFBFE2035c, coinbase_country_attestation=0xdEe363585926c3c28327Efd1eDd01cf4559738cf
- Call verifier.verify(proofWithInputs) to verify on-chain`,
        tags: ['zk-proof', 'generate', 'tee', 'noir', 'privacy', 'coinbase', 'attestation', 'on-chain-verification', 'x402', 'kyc', 'identity', 'country-verification', 'eas'],
        examples: [
          'Generate a KYC proof for my Coinbase account',
          'Prove my Coinbase verification without revealing identity',
          'Create a country attestation proof',
          'Submit my proof inputs and generate the ZK proof',
          'Verify my Coinbase identity privately using ZK proof',
        ],
        inputModes: ['application/json'],
        outputModes: ['application/json'],
      },
      {
        id: 'get_supported_circuits',
        name: 'Get Supported Circuits',
        description: '[DISCOVERY] List all supported ZK circuits with metadata, verifier addresses, EAS schema IDs, and chain information. Call this first to discover available proof types before starting a session.',
        tags: ['circuits', 'metadata', 'discovery', 'coinbase', 'kyc', 'country', 'eas'],
        examples: [
          'What circuits do you support?',
          'List available proof types',
          'Show me Coinbase verification options',
        ],
        inputModes: ['application/json'],
        outputModes: ['application/json'],
      },
      {
        id: 'get_guide',
        name: 'Get Circuit Guide',
        description: '[GUIDE] Get a comprehensive step-by-step guide for preparing all inputs required for a specific circuit. Read this BEFORE attempting proof generation.',
        tags: ['guide', 'instructions', 'tutorial', 'coinbase', 'kyc', 'country', 'inputs'],
        examples: [
          'How do I prepare inputs for coinbase_kyc?',
          'Show me the guide for proof generation',
          'What inputs do I need for country verification?',
        ],
        inputModes: ['application/json'],
        outputModes: ['application/json'],
      },
    ],
    defaultInputModes: ['application/json'],
    defaultOutputModes: ['application/json'],
    guides: {
      description: 'Step-by-step guides for preparing proof inputs. Read the guide BEFORE calling prove.',
      coinbase_kyc: `${config.a2aBaseUrl}/api/v1/guide/coinbase_kyc`,
      coinbase_country: `${config.a2aBaseUrl}/api/v1/guide/coinbase_country`,
    },
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
      description: 'proveragent.base.eth — ZK proof generation agent for Coinbase KYC and country-of-residence verification. Generates zero-knowledge proofs from Coinbase Verified Account attestations on Base chain using Noir circuits in AWS Nitro TEE. Supports: (1) coinbase_kyc — prove KYC verification without revealing identity, (2) coinbase_country — prove country of residence with inclusion/exclusion lists. Payment via USDC on Base. ERC-8004 registered identity. x402 payment protocol compatible.',
    },
    capabilities: {
      tools: {},
    },
    tools: [
      {
        name: 'prove',
        description: '[SINGLE-STEP x402] Generate a zero-knowledge proof via x402 single-step flow. POST circuit + inputs → receive 402 with nonce → pay USDC → retry with X-Payment-TX and X-Payment-Nonce headers. Atomically verifies USDC payment on-chain and generates the ZK proof in AWS Nitro TEE. Takes 30-90 seconds. Supported circuits: coinbase_kyc (EAS schema 0xf8b05c79f090979bf4a80270aba232dff11a10d9ca55c4f88de95317970f0de9) and coinbase_country (EAS schema 0x1801901fabd0e6189356b4fb52bb0ab855276d84f7ec140839fbd1f6801ca065). Authorized signers: [0x952f32128AF084422539C4Ff96df5C525322E564, 0x8844591D47F17bcA6F5dF8f6B64F4a739F1C0080, 0x88fe64ea2e121f49bb77abea6c0a45e93638c3c5, 0x44ace9abb148e8412ac4492e9a1ae6bd88226803]. Returns proof (hex), publicInputs, proofWithInputs (for on-chain verification), and TEE attestation. Verifier contracts on Base Sepolia: coinbase_attestation=0x0036B61dBFaB8f3CfEEF77dD5D45F7EFBFE2035c, coinbase_country_attestation=0xdEe363585926c3c28327Efd1eDd01cf4559738cf.',
        inputSchema: {
          type: 'object',
          properties: {
            circuit: { type: 'string', description: 'Circuit name. Values: coinbase_kyc, coinbase_country' },
            inputs: {
              type: 'object',
              properties: {
                signal_hash: { type: 'string', description: '0x-prefixed 32-byte signal hash' },
                nullifier: { type: 'string', description: '0x-prefixed 32-byte nullifier' },
                scope_bytes: { type: 'string', description: '0x-prefixed 32-byte keccak256 of scope string' },
                merkle_root: { type: 'string', description: '0x-prefixed 32-byte Merkle root' },
                user_address: { type: 'string', description: '0x-prefixed 20-byte wallet address' },
                signature: { type: 'string', description: 'eth_sign(signal_hash), 65 bytes hex' },
                user_pubkey_x: { type: 'string' },
                user_pubkey_y: { type: 'string' },
                raw_transaction: { type: 'string' },
                tx_length: { type: 'number' },
                coinbase_attester_pubkey_x: { type: 'string' },
                coinbase_attester_pubkey_y: { type: 'string' },
                merkle_proof: { type: 'array', items: { type: 'string' } },
                leaf_index: { type: 'number' },
                depth: { type: 'number' },
                country_list: { type: 'array', items: { type: 'string' } },
                is_included: { type: 'boolean' },
              },
              required: ['signal_hash', 'nullifier', 'scope_bytes', 'merkle_root', 'user_address', 'signature', 'user_pubkey_x', 'user_pubkey_y', 'raw_transaction', 'tx_length', 'coinbase_attester_pubkey_x', 'coinbase_attester_pubkey_y', 'merkle_proof', 'leaf_index', 'depth'],
            },
          },
          required: ['circuit', 'inputs'],
        },
      },
      {
        name: 'get_supported_circuits',
        description: '[DISCOVERY] List all supported ZK circuits with metadata, verifier addresses, EAS schema IDs, and chain information. Call this first to discover available proof types (coinbase_kyc, coinbase_country) before starting a session.',
        inputSchema: {
          type: 'object',
          properties: {},
          required: [],
        },
      },
      {
        name: 'get_guide',
        description: '[GUIDE] Get a comprehensive step-by-step guide for preparing all inputs required for a specific circuit. Read this BEFORE attempting proof generation.',
        inputSchema: {
          type: 'object',
          properties: {
            circuit: { type: 'string', description: 'Circuit alias: "coinbase_kyc" or "coinbase_country"' },
          },
          required: ['circuit'],
        },
      },
    ],
    'x-guides': {
      description: 'Step-by-step guides for preparing proof inputs. Read the guide BEFORE calling prove.',
      coinbase_kyc: `${config.a2aBaseUrl}/api/v1/guide/coinbase_kyc`,
      coinbase_country: `${config.a2aBaseUrl}/api/v1/guide/coinbase_country`,
    },
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
      'ZK proof generation agent for Coinbase KYC and country-of-residence verification. Generates zero-knowledge proofs from Coinbase Verified Account attestations on Base chain using Noir circuits in AWS Nitro TEE. Supports: (1) coinbase_kyc — prove KYC verification without revealing identity, (2) coinbase_country — prove country of residence with inclusion/exclusion lists. Payment via USDC on Base. ERC-8004 registered identity. x402 payment protocol compatible.',
    image: `${config.a2aBaseUrl}/icon.png`,
    agentType: 'service',
    tags: ['ZK', 'Privacy', 'Proof', 'Coinbase', 'KYC', 'Attestation', 'x402', 'Identity', 'Country', 'Verification', 'Base', 'USDC', 'TEE', 'Noir', 'EAS', 'Zero-Knowledge'],
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
        skills: ['Generate ZK Proof', 'Get Supported Circuits'],
        domains: ['Privacy', 'Identity'],
      },
      {
        name: 'A2A',
        endpoint: `${config.a2aBaseUrl}/.well-known/agent-card.json`,
        version: '0.3.0',
        a2aSkills: ['prove', 'get_supported_circuits', 'get_guide'],
      },
      {
        name: 'MCP',
        endpoint: `${config.a2aBaseUrl}/.well-known/mcp.json`,
        version: '2024-11-05',
        mcpTools: ['prove', 'get_supported_circuits', 'get_guide'],
      },
    ],
    guides: {
      description: 'Step-by-step guides for preparing proof inputs. Read the guide BEFORE calling prove.',
      coinbase_kyc: `${config.a2aBaseUrl}/api/v1/guide/coinbase_kyc`,
      coinbase_country: `${config.a2aBaseUrl}/api/v1/guide/coinbase_country`,
    },
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

/**
 * Build SKILL.md content — Base ecosystem standard discovery document.
 * Lightweight service description for AI agent auto-discovery.
 */
export function buildSkillMd(config: Config): string {
  const isTestnet = config.paymentMode === 'testnet';
  const network = isTestnet ? 'Base Sepolia' : 'Base';
  const priceStr = config.paymentProofPrice || '$0.10';

  return `---
name: zk-proof-generator
version: ${config.agentVersion}
description: ZK proof generation for Coinbase KYC and country verification on Base. Noir circuits in AWS Nitro TEE. x402 payment. ERC-8004 registered.
author: zkproofport
tags: zk-proof, privacy, coinbase, kyc, base, noir, tee, x402, identity, country, eas, usdc
---

# proveragent.base.eth

ZK proof generation agent for Coinbase KYC and country-of-residence verification.
Generates zero-knowledge proofs from Coinbase Verified Account attestations on Base chain.

## Skills

### get_supported_circuits
- **Description**: List all supported ZK circuits with metadata and verifier addresses.
- **Method**: Available via MCP tool or A2A skill
- **Input**: None
- **Output**: Array of circuit objects with EAS schema IDs, verifier addresses, chain info

### get_guide
- **Description**: Get comprehensive step-by-step guide for preparing proof inputs.
- **Method**: Available via MCP tool, A2A skill, or REST \`GET /api/v1/guide/{circuit}\`
- **Input**: Circuit alias (\`coinbase_kyc\` or \`coinbase_country\`)
- **Output**: Setup instructions, environment variables, manual step reference

### prove
- **Description**: Generate a ZK proof via x402 single-step flow.
- **Method**: \`POST ${config.a2aBaseUrl}/api/v1/prove\`
- **Input**: \`{ "circuit": "coinbase_kyc" | "coinbase_country", "inputs": { ... } }\`
- **Output**: ZK proof (hex), public inputs, TEE attestation
- **Duration**: 30-90 seconds
- **Flow**: POST with circuit+inputs → 402 with nonce → pay USDC → retry with \`X-Payment-TX\` and \`X-Payment-Nonce\` headers. Nonce is single-use and circuit-bound.

## Payment

- **Protocol**: x402
- **Amount**: ${priceStr} USDC
- **Network**: ${network}
- **Method**: ${isTestnet ? 'Direct USDC transfer with nonce in calldata (testnet USDC lacks EIP-3009)' : 'EIP-3009 TransferWithAuthorization via x402 facilitator (https://www.x402.org/facilitator)'}
- **x402 Single-Step**: POST /prove with \`{ circuit, inputs }\` → 402 response includes nonce in body → pay with signature → retry with \`X-Payment-TX\` and \`X-Payment-Nonce\` headers. Nonce is single-use and circuit-bound.

## Quick Start

\`@proofport/client\` is **not published to npm** — clone the GitHub repo directly.

### Option A: Local MCP Server (Recommended for Agents)

\`\`\`bash
git clone https://github.com/zkproofport/proofport-ai.git
cd proofport-ai && npm install
\`\`\`

Configure in \`claude_desktop_config.json\`:
\`\`\`json
{
  "mcpServers": {
    "proofport": {
      "command": "npx",
      "args": ["tsx", "packages/mcp-server/src/index.ts"],
      "env": {
        "ATTESTATION_KEY": "0x... (private key of wallet with Coinbase EAS attestation on Base)",
        "PAYMENT_KEY": "0x... (optional: private key of wallet with USDC, defaults to ATTESTATION_KEY)",
        "PROOFPORT_URL": "${config.a2aBaseUrl}"
      }
    }
  }
}
\`\`\`

Or run directly:
\`\`\`bash
ATTESTATION_KEY=0x... npx tsx packages/mcp-server/src/index.ts
\`\`\`

Tools: generate_proof, get_supported_circuits, prepare_inputs, request_challenge, make_payment, submit_proof, verify_proof, request_testnet_usdc

### Option B: SDK (Programmatic)

\`\`\`bash
git clone https://github.com/zkproofport/proofport-ai.git
cd proofport-ai && npm install
\`\`\`

\`\`\`typescript
import { generateProof } from '@proofport/client';
const result = await generateProof(config, signers, { circuit: 'coinbase_kyc' });
\`\`\`

### Option C: CLI

\`\`\`bash
git clone https://github.com/zkproofport/proofport-ai.git
cd proofport-ai && npm install
ATTESTATION_KEY=0x... PAYMENT_KEY=0x... SERVER_URL=${config.a2aBaseUrl} npx tsx packages/client/examples/full-flow.ts
\`\`\`

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| ATTESTATION_KEY | Yes | Private key of wallet with Coinbase EAS attestation on Base |
| PAYMENT_KEY | No | Private key of wallet with USDC balance (defaults to ATTESTATION_KEY) |
| PROOFPORT_URL | No | Server URL (default: production) |

## CDP Wallet (Optional)

Use Coinbase MPC wallet instead of PAYMENT_KEY. Private keys never leave Coinbase's TEE.

Set these env vars alongside ATTESTATION_KEY:

| Variable | Description |
|----------|-------------|
| CDP_API_KEY_ID | Coinbase Developer Platform API key ID |
| CDP_API_KEY_SECRET | CDP API key secret |
| CDP_WALLET_SECRET | CDP wallet encryption secret |
| CDP_WALLET_ADDRESS | (Optional) Existing CDP wallet address to reuse |

Get credentials at https://portal.cdp.coinbase.com

The \`request_testnet_usdc\` MCP tool auto-funds your wallet with testnet USDC via CDP faucet.

## Guides

Detailed step-by-step guides for preparing proof inputs:
- Coinbase KYC: ${config.a2aBaseUrl}/api/v1/guide/coinbase_kyc
- Coinbase Country: ${config.a2aBaseUrl}/api/v1/guide/coinbase_country

## Protocols

- **MCP (Remote)**: ${config.a2aBaseUrl}/mcp (StreamableHTTP, tools: prove, get_supported_circuits, get_guide)
- **MCP (Local)**: \`npx tsx packages/mcp-server/src/index.ts\` (stdio, tools: generate_proof, get_supported_circuits, prepare_inputs, request_challenge, make_payment, submit_proof, verify_proof, request_testnet_usdc)
- **A2A**: ${config.a2aBaseUrl}/a2a (JSON-RPC v0.3)
- **REST**: ${config.a2aBaseUrl}/api/v1/*

## Discovery

- OASF Identity: ${config.a2aBaseUrl}/.well-known/agent.json
- A2A Agent Card: ${config.a2aBaseUrl}/.well-known/agent-card.json
- MCP Discovery: ${config.a2aBaseUrl}/.well-known/mcp.json
- OpenAPI: ${config.a2aBaseUrl}/openapi.json

## Identity

- **ERC-8004**: Registered on-chain (Base Sepolia + Base Mainnet)
- **TEE**: AWS Nitro Enclave with NSM attestation
- **8004scan**: https://testnet.8004scan.io
`;
}

/**
 * Express handler for GET /.well-known/SKILL.md
 */
export function getSkillMdHandler(config: Config): (req: Request, res: Response) => void {
  const skillMd = buildSkillMd(config);

  return (_req: Request, res: Response) => {
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.send(skillMd);
  };
}
