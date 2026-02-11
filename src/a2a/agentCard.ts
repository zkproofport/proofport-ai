import type { Config } from '../config/index.js';
import type { Request, Response } from 'express';
import { ERC8004_ADDRESSES } from '../config/contracts.js';

export type AgentCard = {
  name: string;
  description: string;
  url: string;
  version: string;
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
    schemes: string[];
  };
  identity: {
    erc8004: {
      contractAddress: string;
      chainId: number;
      tokenId: bigint | null;
    };
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
      schemes: ['x402'],
    },
    identity: {
      erc8004: {
        contractAddress: erc8004Identity,
        chainId,
        tokenId: tokenId ?? null,
      },
    },
  };
}

/**
 * Express handler for GET /.well-known/agent.json
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
