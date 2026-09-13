import { type Config, getChainId, getChainIdentities, isProductionChain } from '../config/index.js';
import type { Request, Response } from 'express';
import type { AgentCard as SDKAgentCard } from '@a2a-js/sdk';
import { ERC8004_ADDRESSES } from '../config/contracts.js';
import { getChainVerifiers } from '../config/deployments.js';
import { CIRCUIT_IDS, PROVABLE_CIRCUIT_IDS } from '../config/circuitIds.js';
import { ethers } from 'ethers';
import { resolvePaymentNetworks } from '../payment/networks.js';

export type TokenIdRef = { chains: Map<number, bigint> };

function executionDescription(config: Config): string {
  if (config.teeMode === 'nitro') return 'AWS Nitro Enclave';
  return `deployed prover (${config.teeMode} mode, no hardware TEE attestation)`;
}

function paymentNetworks(config: Config): string {
  return resolvePaymentNetworks(config.paymentNetworks).map(network => `${network.id} (${network.caip2})`).join(', ');
}

function serviceDescription(config: Config): string {
  return `ZK proof generation for Coinbase KYC, country verification, OIDC domain verification, and Arc action eligibility. ` +
    `Provable circuits: ${PROVABLE_CIRCUIT_IDS.join(', ')}. Noir circuits execute in ${executionDescription(config)}. ` +
    `Configured x402 USDC payment networks: ${paymentNetworks(config)}. See /identity/status for verified ERC-8004 registrations.`;
}

function registrationRows(config: Config, chains: Map<number, bigint>) {
  const identities = new Map(getChainIdentities(config).map(identity => [identity.chainId, identity]));
  return [...chains].map(([chainId, tokenId]) => {
    const identity = identities.get(chainId);
    if (!identity) throw new Error(`Unknown registered chain ${chainId}; no configured identity registry.`);
    if (tokenId < 0n || tokenId > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`Agent ID on chain ${chainId} exceeds safe registration JSON integer range.`);
    return { agentId: Number(tokenId), agentRegistry: `eip155:${chainId}:${identity.identityAddress}` };
  });
}

export type AgentCard = SDKAgentCard & {
  protocolVersions?: string[];
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

/**
 * The on-chain verification line an agent reads to know where to check a proof.
 *
 * Built from PROVABLE_CIRCUIT_IDS rather than two hand-named circuits. The
 * hand-written version listed Coinbase KYC and Coinbase country only, so an
 * agent was never told this server also proves OIDC domain — which it has done
 * for months — nor arc_eligibility.
 *
 * A circuit with no verifier on this chain is named as such instead of being
 * dressed up. The previous `?? '(address not yet loaded)'` published a string
 * that reads like a transient failure for a contract that is deliberately not
 * there, and an agent retrying on it waits forever.
 */
function verifierLine(chainName: string, chainId: number, chainVerifiers: Record<string, string | null>): string {
  const entries = PROVABLE_CIRCUIT_IDS.map(id => {
    const address = chainVerifiers[id];
    return address ? `${id}=${address}` : `${id}=(no verifier on this chain)`;
  });
  return `Verifier contracts on ${chainName} (chainId=${chainId}): ${entries.join(', ')}`;
}

export function buildAgentCard(config: Config, tokenId?: bigint | null): AgentCard {
  // Determine chain from RPC URL, independent of payment mode
  const isProduction = isProductionChain(config);
  const erc8004Identity = isProduction
    ? ERC8004_ADDRESSES.mainnet.identity
    : ERC8004_ADDRESSES.sepolia.identity;
  const chainId = getChainId(config);
  const chainName = isProduction ? 'Ethereum Mainnet' : 'Ethereum Sepolia';
  const chainVerifiers = getChainVerifiers(String(chainId));
  const verifiers = verifierLine(chainName, chainId, chainVerifiers);

  return {
    name: 'proveragent.base.eth',
    description: serviceDescription(config),
    url: `${config.a2aBaseUrl}/a2a`,
    version: config.agentVersion,
    protocolVersion: '0.3.0',
    protocolVersions: ['0.3'],
    provider: {
      organization: 'ZKProofport',
      url: 'https://zkproofport.app',
    },
    capabilities: {
      streaming: true,
      pushNotifications: false,
      stateTransitionHistory: true,
    },
    securitySchemes: {
      x402: {
        type: 'apiKey',
        in: 'header',
        name: 'X-402-Payment',
      },
    },
    security: [{ x402: [] }],
    skills: [
      {
        id: 'prove',
        name: 'Generate ZK Proof',
        description: `[SINGLE-STEP x402] Generate a zero-knowledge proof via x402 single-step flow in ${executionDescription(config)}. Read the payment requirements returned by the service for the selected payment scheme.

SUPPORTED CIRCUITS:
${PROVABLE_CIRCUIT_IDS.join(', ')}
- coinbase_kyc: Prove Coinbase KYC verification without revealing identity. EAS schema 0xf8b05c79f090979bf4a80270aba232dff11a10d9ca55c4f88de95317970f0de9.
- coinbase_country: Prove country of residence with inclusion/exclusion list. EAS schema 0x1801901fabd0e6189356b4fb52bb0ab855276d84f7ec140839fbd1f6801ca065.

REQUIRED INPUTS:
Inputs are circuit-specific. Read /api/v1/guide/{circuit} and prepare them with the client SDK.
Coinbase circuits use wallet/attestation witnesses. arc_eligibility additionally requires the EIP-712 domain separator and action hash signed by the KYC wallet. OIDC domain verification uses its OIDC witness.

PAYMENT: ${config.paymentProofPrice} USDC. Configured networks: ${paymentNetworks(config)}. Read the returned x402 offers.

RETURNS: proof (hex), publicInputs (hex), proofWithInputs (hex for on-chain verification)${config.teeMode === 'nitro' && config.teeAttestationEnabled ? ', hardware TEE attestation when requested' : '. No hardware TEE attestation is advertised'}

ON-CHAIN VERIFICATION:
- ${verifiers}
- Call verifier.verify(proofWithInputs) to verify on-chain`,
        tags: ['zk-proof', 'generate', ...(config.teeMode === 'nitro' ? ['tee'] : []), 'noir', 'privacy', 'coinbase', 'attestation', 'on-chain-verification', 'x402', 'kyc', 'identity', 'country-verification', 'eas'],
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
    ...(config.teeMode === 'nitro' && {
      tee: {
        mode: config.teeMode,
        attestationEnabled: config.teeAttestationEnabled,
        attestationFormat: 'aws-nitro-nsm',
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
  const chainId = getChainId(config);
  const chainName = isProductionChain(config) ? 'Ethereum Mainnet' : 'Ethereum Sepolia';
  const chainVerifiers = getChainVerifiers(String(chainId));
  const verifiers = verifierLine(chainName, chainId, chainVerifiers);

  return {
    protocolVersion: '2025-11-25',
    serverInfo: {
      name: 'proveragent.base.eth',
      version: config.agentVersion,
      description: serviceDescription(config),
    },
    capabilities: {
      tools: {},
    },
    tools: [
      {
        name: 'prove',
        description: `[SINGLE-STEP x402] Generate a zero-knowledge proof via x402 single-step flow. POST circuit + inputs → receive 402 with nonce → pay USDC → retry with X-Payment-TX and X-Payment-Nonce headers. Generates the ZK proof in ${executionDescription(config)}. Configured payment networks: ${paymentNetworks(config)}. Takes 30-90 seconds. Provable circuits: ${PROVABLE_CIRCUIT_IDS.join(', ')}. EAS schemas — coinbase_attestation 0xf8b05c79f090979bf4a80270aba232dff11a10d9ca55c4f88de95317970f0de9, coinbase_country_attestation 0x1801901fabd0e6189356b4fb52bb0ab855276d84f7ec140839fbd1f6801ca065. arc_eligibility reads the same Coinbase attestation as coinbase_attestation but binds the proof to one EIP-712 action the wallet signed; it is EXPERIMENTAL and its verifier is on Arc Testnet only. Authorized signers: [0x952f32128AF084422539C4Ff96df5C525322E564, 0x8844591D47F17bcA6F5dF8f6B64F4a739F1C0080, 0x88fe64ea2e121f49bb77abea6c0a45e93638c3c5, 0x44ace9abb148e8412ac4492e9a1ae6bd88226803]. Returns proof (hex), publicInputs, proofWithInputs (for on-chain verification)${config.teeMode === 'nitro' && config.teeAttestationEnabled ? ", hardware TEE attestation when requested" : ". No hardware TEE attestation is advertised"}. ${verifiers}.`,
        inputSchema: {
          type: 'object',
          properties: {
            circuit: { type: 'string', description: `Canonical circuit id. Values: ${PROVABLE_CIRCUIT_IDS.join(', ')}` },
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
            circuit: { type: 'string', description: `Canonical circuit id: ${PROVABLE_CIRCUIT_IDS.join(', ')}` },
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
      paymentRequired: config.paymentMode !== 'disabled',  // whether payment is actually charged
      baseUrl: config.a2aBaseUrl,
      documentation: 'https://docs.zkproofport.app',
    },
    ...(config.teeMode === 'nitro' && {
      'x-tee': {
        mode: config.teeMode,
        attestationEnabled: config.teeAttestationEnabled,
        attestationFormat: 'aws-nitro-nsm',
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
  const isProduction = isProductionChain(config);
  const chainId = getChainId(config);
  const erc8004Identity = isProduction
    ? ERC8004_ADDRESSES.mainnet.identity
    : ERC8004_ADDRESSES.sepolia.identity;

  return {
    type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
    name: 'proveragent.base.eth',
    description: serviceDescription(config),
    image: `${config.a2aBaseUrl}/icon.png`,
    agentType: 'service',
    tags: ['ZK', 'Privacy', 'Proof', 'Coinbase', 'KYC', 'Attestation', 'x402', 'Identity', 'Country', 'Verification', 'Base', 'USDC', ...(config.teeMode === 'nitro' ? ['TEE'] : []), 'Arc', 'Noir', 'EAS', 'Zero-Knowledge'],
    domains: [
      { name: 'technology/blockchain', id: 109 },
      { name: 'technology/security', id: 107 },
      { name: 'trust_and_safety/data_privacy', id: 404 },
    ],
    skills: [
      { name: 'security_privacy/privacy_risk_assessment', id: 804 },
      { name: 'security_privacy/threat_detection', id: 801 },
    ],
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
        endpoint: `${config.a2aBaseUrl}/mcp`,
        version: '2024-11-05',
        mcpTools: ['prove', 'get_supported_circuits', 'get_guide'],
      },
      {
        name: 'ENS',
        endpoint: 'proveragent.base.eth',
      },
      {
        name: 'DID',
        endpoint: `did:web:${new URL(config.a2aBaseUrl).hostname}`,
      },
      {
        name: 'agentWallet',
        endpoint: `eip155:${chainId}:${new ethers.Wallet(config.proverPrivateKey).address}`,
      },
    ],
    guides: {
      description: 'Step-by-step guides for preparing proof inputs. Read the guide BEFORE calling prove.',
      coinbase_kyc: `${config.a2aBaseUrl}/api/v1/guide/coinbase_kyc`,
      coinbase_country: `${config.a2aBaseUrl}/api/v1/guide/coinbase_country`,
    },
    x402Support: true,  // always supports x402 protocol (price may be $0 when disabled)
    active: true,
    registrations: [
      ...(tokenId !== null && tokenId !== undefined
        ? [
            {
              agentId: Number(tokenId),
              agentRegistry: `eip155:${chainId}:${erc8004Identity}`,
            },
          ]
        : []),
    ],
    supportedTrust: config.teeMode === 'nitro' && config.teeAttestationEnabled
      ? ['reputation', 'tee-attestation']
      : ['reputation'],
    ...(config.teeMode === 'nitro' && {
      teeMetadata: {
        mode: config.teeMode,
        attestationEnabled: config.teeAttestationEnabled,
        attestationFormat: 'aws-nitro-nsm',
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
export function getAgentCardHandler(config: Config, tokenIdRef: TokenIdRef): (req: Request, res: Response) => void | Promise<void> {
  return (_req: Request, res: Response) => {
    const primaryTokenId = tokenIdRef.chains.get(getChainId(config)) ?? null;
    const agentCard = buildAgentCard(config, primaryTokenId);
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
export function getOasfAgentHandler(config: Config, tokenIdRef: TokenIdRef): (req: Request, res: Response) => void | Promise<void> {
  return (_req: Request, res: Response) => {
    const primaryTokenId = tokenIdRef.chains.get(getChainId(config)) ?? null;
    const oasfAgent = buildOasfAgent(config, primaryTokenId);
    if (tokenIdRef.chains.size > 0) oasfAgent.registrations = registrationRows(config, tokenIdRef.chains);
    res.setHeader('Content-Type', 'application/json');
    res.json(oasfAgent);
  };
}

/**
 * Express handler for GET /.well-known/agent-registration.json
 * Provides bidirectional link between domain and on-chain identity (Rule 4)
 */
export function getAgentRegistrationHandler(config: Config, tokenIdRef: TokenIdRef): (req: Request, res: Response) => void {
  const identityAddress = isProductionChain(config)
    ? ERC8004_ADDRESSES.mainnet.identity
    : ERC8004_ADDRESSES.sepolia.identity;

  return (_req: Request, res: Response) => {
    const registrations: { agentId: number | null; agentRegistry: string }[] = registrationRows(config, tokenIdRef.chains);
    if (registrations.length === 0) {
      const primaryChainId = getChainId(config);
      registrations.push({
        agentId: null,
        agentRegistry: `eip155:${primaryChainId}:${identityAddress}`,
      });
    }
    res.setHeader('Content-Type', 'application/json');
    res.json({ registrations });
  };
}

/**
 * Express handler for GET /.well-known/did.json
 * W3C DID Document for did:web resolution
 */
export function getDidHandler(config: Config): (req: Request, res: Response) => void {
  const hostname = new URL(config.a2aBaseUrl).hostname;
  const agentAddress = new ethers.Wallet(config.proverPrivateKey).address;

  return (_req: Request, res: Response) => {
    res.setHeader('Content-Type', 'application/json');
    res.json({
      '@context': [
        'https://www.w3.org/ns/did/v1',
        'https://w3id.org/security/suites/secp256k1recovery-2020/v2',
      ],
      id: `did:web:${hostname}`,
      verificationMethod: [{
        id: `did:web:${hostname}#key-1`,
        type: 'EcdsaSecp256k1RecoveryMethod2020',
        controller: `did:web:${hostname}`,
        blockchainAccountId: `eip155:${getChainId(config)}:${agentAddress}`,
      }],
      service: [{
        id: `did:web:${hostname}#agent`,
        type: 'ERC8004Agent',
        serviceEndpoint: config.a2aBaseUrl,
      }],
    });
  };
}

/**
 * Build SKILL.md content — Base ecosystem standard discovery document.
 * Lightweight service description for AI agent auto-discovery.
 */
export function buildSkillMd(config: Config): string {
  const network = paymentNetworks(config);
  const priceStr = config.paymentProofPrice;

  return `---
name: zk-proof-generator
version: ${config.agentVersion}
description: ${serviceDescription(config)}
author: zkproofport
tags: zk-proof, privacy, coinbase, kyc, base, arc, noir${config.teeMode === 'nitro' ? ', tee' : ''}, x402, identity, country, eas, usdc
---

# proveragent.base.eth

ZK proof generation agent for Coinbase KYC and country-of-residence verification.
Provable circuits: ${PROVABLE_CIRCUIT_IDS.join(', ')}.
Execution: ${executionDescription(config)}.

## Skills

### get_supported_circuits
- **Description**: List all supported ZK circuits with metadata and verifier addresses.
- **Method**: Available via MCP tool or A2A skill
- **Input**: None
- **Output**: Array of circuit objects with EAS schema IDs, verifier addresses, chain info

### get_guide
- **Description**: Get comprehensive step-by-step guide for preparing proof inputs.
- **Method**: Available via MCP tool, A2A skill, or REST \`GET /api/v1/guide/{circuit}\`
- **Input**: Canonical circuit id: ${PROVABLE_CIRCUIT_IDS.join(', ')}
- **Output**: Setup instructions, environment variables, manual step reference

### prove
- **Description**: Generate a ZK proof via x402 single-step flow.
- **Method**: \`POST ${config.a2aBaseUrl}/api/v1/prove\`
- **Input**: \`{ "circuit": "<canonical circuit id>", "inputs": { ... } }\`. Read the circuit guide for its inputs.
- **Output**: ZK proof (hex), public inputs${config.teeMode === 'nitro' && config.teeAttestationEnabled ? ', hardware TEE attestation when requested' : '; no hardware TEE attestation'}
- **Duration**: 30-90 seconds
- **Flow**: POST with circuit+inputs → 402 with nonce → pay USDC → retry with \`X-Payment-TX\` and \`X-Payment-Nonce\` headers. Nonce is single-use and circuit-bound.

## Payment

- **Protocol**: x402
- **Amount**: ${priceStr} USDC
- **Network**: ${network}
- **Method**: Read the returned x402 payment offers; the scheme and settlement method depend on the selected network.
- **x402 Single-Step**: POST /prove with \`{ circuit, inputs }\` → 402 response includes nonce in body → pay with signature → retry with \`X-Payment-TX\` and \`X-Payment-Nonce\` headers. Nonce is single-use and circuit-bound.

## Quick Start

\`@zkproofport-ai/sdk\` — install via npm or clone the GitHub repo.

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
      "args": ["tsx", "packages/mcp/src/index.ts"],
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
ATTESTATION_KEY=0x... npx tsx packages/mcp/src/index.ts
\`\`\`

Tools: generate_proof, get_supported_circuits, prepare_inputs, request_challenge, make_payment, submit_proof, verify_proof

### Option B: SDK (Programmatic)

\`\`\`bash
git clone https://github.com/zkproofport/proofport-ai.git
cd proofport-ai && npm install
\`\`\`

\`\`\`typescript
import { generateProof } from '@zkproofport-ai/sdk';
const result = await generateProof(config, signers, { circuit: 'coinbase_kyc' });
\`\`\`

### Option C: CLI

\`\`\`bash
git clone https://github.com/zkproofport/proofport-ai.git
cd proofport-ai && npm install
ATTESTATION_KEY=0x... PAYMENT_KEY=0x... SERVER_URL=${config.a2aBaseUrl} npx tsx packages/sdk/examples/full-flow.ts
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

## Guides

Detailed step-by-step guides for preparing proof inputs:
- Coinbase KYC: ${config.a2aBaseUrl}/api/v1/guide/coinbase_kyc
- Coinbase Country: ${config.a2aBaseUrl}/api/v1/guide/coinbase_country

## Protocols

- **MCP (Remote)**: ${config.a2aBaseUrl}/mcp (StreamableHTTP, tools: prove, get_supported_circuits, get_guide)
- **MCP (Local)**: \`npx tsx packages/mcp/src/index.ts\` (stdio, tools: generate_proof, get_supported_circuits, prepare_inputs, request_challenge, make_payment, submit_proof, verify_proof)
- **A2A**: ${config.a2aBaseUrl}/a2a (JSON-RPC v0.3)
- **REST**: ${config.a2aBaseUrl}/api/v1/*

## Discovery

- OASF Identity: ${config.a2aBaseUrl}/.well-known/agent.json
- A2A Agent Card: ${config.a2aBaseUrl}/.well-known/agent-card.json
- MCP Discovery: ${config.a2aBaseUrl}/.well-known/mcp.json
- OpenAPI: ${config.a2aBaseUrl}/openapi.json

## Identity

- **ERC-8004**: Check ${config.a2aBaseUrl}/identity/status and /.well-known/agent-registration.json for verified registrations.
- **Execution**: ${executionDescription(config)}
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
