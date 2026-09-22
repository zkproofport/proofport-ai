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
  return 'the ZKProofport prover';
}

function paymentNetworks(config: Config): string {
  return resolvePaymentNetworks(config.paymentNetworks).map(network => `${network.id} (${network.caip2})`).join(', ');
}

function serviceDescription(config: Config): string {
  return `ZK proof generation for Coinbase KYC, country verification, OIDC domain verification, Arc eligibility, and GIWA attestations with optional action authorization. ` +
    `Provable circuits: ${PROVABLE_CIRCUIT_IDS.join(', ')}. Noir circuits execute in ${executionDescription(config)}. ` +
    `Configured x402 USDC payment networks: ${paymentNetworks(config)}. See /identity/status for verified ERC-8004 registrations.`;
}

/**
 * The name this deployment publishes: the primary chain identity's name.
 *
 * Exported because the literal `proveragent.base.eth` was typed out in the
 * index route, the OpenAPI title, the traces, the A2A prompt and the
 * validation registration — the MAINNET name, served by a testnet deployment,
 * so staging introduced itself as two different agents depending on which
 * document you read.
 */
export function discoveryName(config: Config): string {
  const primary = getChainIdentities(config).find(identity => identity.chainId === getChainId(config));
  return primary?.agentName ?? 'ZKProofport prover';
}

function circuitGuides(config: Config): Record<string, string> {
  return {
    description: 'Step-by-step guides for preparing circuit-specific proof inputs. Read the guide BEFORE calling prove.',
    ...Object.fromEntries(PROVABLE_CIRCUIT_IDS.map(id => [id, `${config.a2aBaseUrl}/api/v1/guide/${id}`])),
    // Preserve existing discovery keys for clients using the original aliases.
    coinbase_kyc: `${config.a2aBaseUrl}/api/v1/guide/coinbase_kyc`,
    coinbase_country: `${config.a2aBaseUrl}/api/v1/guide/coinbase_country`,
  };
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
  guides?: Record<string, string>;
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
  const erc8004Identity = config.erc8004IdentityAddress || (isProduction
    ? ERC8004_ADDRESSES.mainnet.identity
    : ERC8004_ADDRESSES.sepolia.identity);
  const chainId = getChainId(config);
  const chainName = isProduction ? 'Ethereum Mainnet' : 'Ethereum Sepolia';
  const chainVerifiers = getChainVerifiers(String(chainId));
  const verifiers = verifierLine(chainName, chainId, chainVerifiers);

  return {
    name: discoveryName(config),
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
Coinbase circuits use wallet/attestation witnesses. arc_eligibility and giwa_attestation support optional EIP-712 action binding: provide both domain_separator and action_hash for a signed action, or omit both for an identity-only proof. GIWA uses its own configured attester. OIDC domain verification uses its OIDC witness.

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
    guides: circuitGuides(config),
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
      name: discoveryName(config),
      version: config.agentVersion,
      description: serviceDescription(config),
    },
    capabilities: {
      tools: {},
    },
    tools: [
      {
        name: 'prove',
        description: `[SINGLE-STEP x402] Generate a zero-knowledge proof via x402 single-step flow. POST circuit + inputs → receive 402 with nonce → pay USDC → retry with X-Payment-TX and X-Payment-Nonce headers. Generates the ZK proof in ${executionDescription(config)}. Configured payment networks: ${paymentNetworks(config)}. Takes 30-90 seconds. Provable circuits: ${PROVABLE_CIRCUIT_IDS.join(', ')}. EAS schemas — coinbase_attestation 0xf8b05c79f090979bf4a80270aba232dff11a10d9ca55c4f88de95317970f0de9, coinbase_country_attestation 0x1801901fabd0e6189356b4fb52bb0ab855276d84f7ec140839fbd1f6801ca065. arc_eligibility and giwa_attestation support optional EIP-712 action binding; omit the action for an identity-only proof. Arc uses Coinbase attestations and GIWA uses its configured attester. Read each circuit guide for its verification chain and witness fields. Authorized signers: [0x952f32128AF084422539C4Ff96df5C525322E564, 0x8844591D47F17bcA6F5dF8f6B64F4a739F1C0080, 0x88fe64ea2e121f49bb77abea6c0a45e93638c3c5, 0x44ace9abb148e8412ac4492e9a1ae6bd88226803]. Returns proof (hex), publicInputs, proofWithInputs (for on-chain verification)${config.teeMode === 'nitro' && config.teeAttestationEnabled ? ", hardware TEE attestation when requested" : ". No hardware TEE attestation is advertised"}. ${verifiers}.`,
        inputSchema: {
          type: 'object',
          properties: {
            circuit: { type: 'string', description: `Canonical circuit id. Values: ${PROVABLE_CIRCUIT_IDS.join(', ')}` },
            inputs: {
              type: 'object',
              description: 'Circuit-specific prepared witness from the SDK. Read /api/v1/guide/{circuit}; OIDC uses jwt, jwks, scope and provider, while attestation circuits use wallet/attestation inputs. Optional action binding takes both domain_separator and action_hash, or neither.',
              additionalProperties: true,
            },
          },
          required: ['circuit', 'inputs'],
        },
      },
      {
        name: 'get_supported_circuits',
        description: `[DISCOVERY] List all supported ZK circuits with metadata, verifier addresses, attestation sources, and chain information. Provable circuits: ${PROVABLE_CIRCUIT_IDS.join(', ')}.`,
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
    'x-guides': circuitGuides(config),
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
  const erc8004Identity = config.erc8004IdentityAddress || (isProduction
    ? ERC8004_ADDRESSES.mainnet.identity
    : ERC8004_ADDRESSES.sepolia.identity);

  return {
    type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
    name: discoveryName(config),
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
        version: '2025-11-25',
        mcpTools: ['prove', 'get_supported_circuits', 'get_guide'],
      },
      {
        name: 'DID',
        endpoint: `did:web:${didWebHost(config.a2aBaseUrl)}`,
      },
      {
        name: 'agentWallet',
        endpoint: `eip155:${chainId}:${new ethers.Wallet(config.proverPrivateKey).address}`,
      },
    ],
    guides: circuitGuides(config),
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
  const identityAddress = config.erc8004IdentityAddress || (isProductionChain(config)
    ? ERC8004_ADDRESSES.mainnet.identity
    : ERC8004_ADDRESSES.sepolia.identity);

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
 * The did:web identifier for a base URL — the host, and the port when there is
 * one.
 *
 * did:web encodes a port as `%3A` (W3C did:web, "The Method Specific
 * Identifier"). Dropping it, which this did until 2026-09-22, makes a service
 * on a port publish `did:web:localhost`, which resolves to
 * `https://localhost/.well-known/did.json` — a different place entirely.
 * Deployments carry no port, so their documents do not change.
 */
export function didWebHost(baseUrl: string): string {
  const url = new URL(baseUrl);
  return url.port ? `${url.hostname}%3A${url.port}` : url.hostname;
}

/**
 * Express handler for GET /.well-known/did.json
 * W3C DID Document for did:web resolution
 */
export function getDidHandler(config: Config): (req: Request, res: Response) => void {
  const hostname = didWebHost(config.a2aBaseUrl);
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
  return `---
name: zk-proof-generator
version: ${config.agentVersion}
description: ${serviceDescription(config)}
---

# ZKProofport prover

Provable circuits: ${PROVABLE_CIRCUIT_IDS.join(', ')}.
Execution: ${executionDescription(config)}.

## Discover and read the integration instructions

Validate the ERC-8004 registration's current owner and active capability metadata.
Use its x402 endpoint's origin to read this document and the circuit guide.
${PROVABLE_CIRCUIT_IDS.map(id => `- ${id}: ${config.a2aBaseUrl}/api/v1/guide/${id}`).join('\n')}

## Local MCP for agents

Install with \`npm install -g @zkproofport-ai/mcp@latest\` (GIWA and optional action support: 0.2.14+) and launch \`zkproofport-mcp\` over stdio.
Set PROOFPORT_URL=${config.a2aBaseUrl} in that local process.
Load the existing ATTESTATION_KEY only into the local signer process; never send credentials to an LLM.
Connect and call \`tools/list\`; use the returned inputSchema for \`tools/call\`.

Local tools: generate_proof, deposit_to_gateway, gateway_balance, get_supported_circuits,
request_challenge, prepare_inputs, submit_proof, verify_proof.
Read guides with HTTPS GET; get_guide is a remote service tool, not a local SDK tool.

For a single attestation + exact-action authorization proof, select \`generate_proof\` with:
- circuit: \`arc_eligibility\` or \`giwa_attestation\`
- action: the application's complete EIP-712 typed action (optional; omit for an identity-only proof)
- scope: the application's scope, e.g. \`ledger-house\`
- pay_with: \`arc\` for an existing Circle Agent Wallet
- pay_on: \`arc-testnet-nano\` only when present in the live offered networks below

Circle Agent Wallet uses an existing authenticated Circle CLI session and optional ARC_AGENT_WALLET.
The key-based adapter instead uses PAYMENT_PRIVATE_KEY with pay_with=key. These are separate choices;
there is no automatic payment fallback to the KYC signer's key.
The deposit_to_gateway and gateway_balance convenience tools use the key-based adapter;
for an Agent Wallet inspect its Gateway balance through the Circle CLI.

After proof generation, call \`verify_proof\` with the proof result. The application must also bind
its domain, delegate, amount, action, expiry, nonce, scope and trusted attester root before staking.
Arc and GIWA prove the configured attestation and, when an action is supplied, that same wallet's authorization in one circuit. Without an action, the wallet signs the challenge instead; an identity-only proof does not authorize an application action. Coinbase KYC, Coinbase country and OIDC domain circuits do not take an action.

## x402 payment

Configured networks: ${network}.
Configured proof price: ${config.paymentProofPrice} USDC.
POST ${config.a2aBaseUrl}/api/v1/prove with circuit and prepared inputs to receive a 402 challenge.
Read the live \`accepts\` list and \`PAYMENT-REQUIRED\` header; do not substitute a static payment domain.
The SDK signs the selected offer and retries with \`PAYMENT-SIGNATURE\` and \`X-Payment-Nonce\`.

For arc-testnet-nano, @circle-fin/x402-batching selects the GatewayWalletBatched domain.
The Circle Agent Wallet's backing EOA signs against its deposited Gateway balance; Gateway verifies
and settles the payment. A proof purchase does not require a separate buyer transfer transaction.
USDC held in the Agent Wallet and USDC deposited in Gateway are different balances.

## CLI equivalent

Choose any canonical circuit above and its guide. For GIWA, replace arc_eligibility below with giwa_attestation; omit --action for an identity-only proof. With the existing signer environment loaded and an offered Arc nanopayment network:

\`PROOFPORT_URL=${config.a2aBaseUrl} zkproofport-prove arc_eligibility --action action.json --scope ledger-house --pay-with arc --pay-on arc-testnet-nano --max-payment 0.001 --silent\`

This CLI calls the local MCP generate_proof tool. An agent already connected to the local MCP
server can call that tool directly without spawning the prove CLI.

## Protocols and identity

- Remote MCP: ${config.a2aBaseUrl}/mcp (tools: prove, get_supported_circuits, get_guide)
- A2A: ${config.a2aBaseUrl}/a2a
- REST: ${config.a2aBaseUrl}/api/v1/*
- Verified ERC-8004 registrations: ${config.a2aBaseUrl}/identity/status
- Registration document: ${config.a2aBaseUrl}/.well-known/agent-registration.json
- Agent metadata: ${config.a2aBaseUrl}/.well-known/agent.json
- Agent card: ${config.a2aBaseUrl}/.well-known/agent-card.json
- MCP discovery: ${config.a2aBaseUrl}/.well-known/mcp.json
- OpenAPI: ${config.a2aBaseUrl}/openapi.json
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
