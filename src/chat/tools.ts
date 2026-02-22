import type { LLMTool } from './llmProvider.js';

export const CHAT_TOOLS: LLMTool[] = [
  {
    name: 'request_signing',
    description: '[STEP 1/5] Start a proof generation session. Creates a signing request and returns a URL where the user connects their wallet and signs. This is the first step in the proof generation flow.',
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
    name: 'check_status',
    description: '[STEP 2/5] Check the current status of a proof request. Returns the signing status, payment status, and current phase (signing, payment, ready, or expired). Use this after the user says they have signed or paid.',
    parameters: {
      type: 'object',
      properties: {
        requestId: {
          type: 'string',
          description: 'The request ID returned from request_signing.',
        },
      },
      required: ['requestId'],
    },
  },
  {
    name: 'request_payment',
    description: '[STEP 3/5] Initiate payment for proof generation. Returns a URL where the user pays $0.10 USDC. Can only be called after signing is complete. If payment is disabled, returns a message to proceed directly to generate_proof.',
    parameters: {
      type: 'object',
      properties: {
        requestId: {
          type: 'string',
          description: 'The request ID returned from request_signing.',
        },
      },
      required: ['requestId'],
    },
  },
  {
    name: 'generate_proof',
    description: '[STEP 4/5] Generate a zero-knowledge proof. Requires either: (1) a requestId from a completed signing+payment session, or (2) address+signature for direct generation. When using requestId, signing and payment must both be completed first — use check_status to verify phase is "ready" before calling.',
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
          description: 'User wallet address (0x-prefixed). Required for direct flow, not needed with requestId.',
        },
        signature: {
          type: 'string',
          description: 'User signature (0x-prefixed). Required for direct flow, not needed with requestId.',
        },
        requestId: {
          type: 'string',
          description: 'Request ID from request_signing. Signing and payment must be completed before calling generate_proof with this.',
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
    description: '[STEP 5/5 — OPTIONAL] Verify a zero-knowledge proof on-chain against the deployed verifier contract. Provide either proofId (from generate_proof result) or the triplet circuitId+proof+publicInputs.',
    parameters: {
      type: 'object',
      properties: {
        proofId: {
          type: 'string',
          description: 'Proof ID from generate_proof result. When provided, proof/publicInputs/circuitId are loaded from storage automatically.',
        },
        circuitId: {
          type: 'string',
          enum: ['coinbase_attestation', 'coinbase_country_attestation'],
          description: 'Which circuit the proof is for. Not needed when proofId is provided.',
        },
        proof: {
          type: 'string',
          description: 'Proof bytes (0x-prefixed hex string). Not needed when proofId is provided.',
        },
        publicInputs: {
          type: 'array',
          items: { type: 'string' },
          description: 'Public inputs as hex strings (0x-prefixed). Not needed when proofId is provided.',
        },
        chainId: {
          type: 'string',
          description: 'Chain ID (default: 84532 for Base Sepolia)',
        },
      },
      required: [],
    },
  },
  {
    name: 'get_supported_circuits',
    description: '[DISCOVERY] List all supported ZK circuits with their metadata, descriptions, and required inputs.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
];
