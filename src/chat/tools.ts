import type { LLMTool } from './llmProvider.js';

export const CHAT_TOOLS: LLMTool[] = [
  {
    name: 'generate_proof',
    description:
      'Generate a zero-knowledge proof for Coinbase KYC or country attestation. ' +
      'If user has not provided address/signature, creates a web signing request where the user connects their wallet in a browser. ' +
      'For web signing flow, only circuitId and scope are required.',
    parameters: {
      type: 'object',
      properties: {
        circuitId: {
          type: 'string',
          enum: ['coinbase_attestation', 'coinbase_country_attestation'],
          description: 'Which circuit to use: coinbase_attestation for KYC, coinbase_country_attestation for country verification',
        },
        scope: {
          type: 'string',
          description: 'Privacy scope (usually the requesting app domain, e.g., "myapp.com")',
        },
        address: {
          type: 'string',
          description: 'User wallet address (0x-prefixed). Optional for web signing flow.',
        },
        signature: {
          type: 'string',
          description: 'User signature. Optional for web signing flow.',
        },
        requestId: {
          type: 'string',
          description: 'Request ID from previous signing step to resume proof generation.',
        },
        countryList: {
          type: 'array',
          items: { type: 'string' },
          description: 'Country codes (ISO 3166-1 alpha-2) for country attestation. Required only for coinbase_country_attestation.',
        },
        isIncluded: {
          type: 'boolean',
          description: 'For country attestation: true to prove inclusion in countryList, false to prove exclusion. Required only for coinbase_country_attestation.',
        },
      },
      required: ['circuitId', 'scope'],
    },
  },
  {
    name: 'verify_proof',
    description: 'Verify a zero-knowledge proof on-chain against the deployed verifier contract.',
    parameters: {
      type: 'object',
      properties: {
        circuitId: {
          type: 'string',
          enum: ['coinbase_attestation', 'coinbase_country_attestation'],
          description: 'Which circuit the proof is for',
        },
        proof: {
          type: 'string',
          description: 'Proof bytes (0x-prefixed hex string)',
        },
        publicInputs: {
          type: 'array',
          items: { type: 'string' },
          description: 'Public inputs as hex strings (0x-prefixed)',
        },
        chainId: {
          type: 'string',
          description: 'Chain ID (default: 84532 for Base Sepolia)',
        },
      },
      required: ['circuitId', 'proof', 'publicInputs'],
    },
  },
  {
    name: 'get_supported_circuits',
    description: 'List all supported ZK circuits with their metadata, descriptions, and required inputs.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
];
