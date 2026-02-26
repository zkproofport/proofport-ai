import type { LLMTool } from './llmProvider.js';

export const CHAT_TOOLS: LLMTool[] = [
  {
    name: 'request_signing',
    description: '[STEP 1/5] Start a proof generation session. Creates a signing request and returns a URL where the user connects their wallet and signs. Returns: requestId (session ID for subsequent steps), signingUrl (URL for user to open), expiresAt (session expiration), circuitId, scope.',
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
    description: '[STEP 2/5] Check proof request status. Returns: phase ("signing"|"payment"|"ready"|"expired"), signing.status, signing.address, payment.status, payment.txHash, payment.paymentReceiptUrl (Basescan link). When phase is "ready", also returns: circuitId, verifierAddress, verifierExplorerUrl (Basescan link to contract), expiresAt.',
    parameters: {
      type: 'object',
      properties: {
        requestId: {
          type: 'string',
          description: 'The request ID returned from request_signing. Omit if unknown — the server auto-resolves it from the session context.',
        },
      },
      required: [],
    },
  },
  {
    name: 'request_payment',
    description: '[STEP 3/5] Initiate USDC payment. Only call after signing is complete. Returns: requestId, paymentUrl (URL for user to pay via x402, no gas needed), amount, currency ("USDC"), network ("Base Sepolia" or "Base"). After user pays, call check_status to verify phase is "ready".',
    parameters: {
      type: 'object',
      properties: {
        requestId: {
          type: 'string',
          description: 'The request ID returned from request_signing. Omit if unknown — the server auto-resolves it from the session context.',
        },
      },
      required: [],
    },
  },
  {
    name: 'generate_proof',
    description: '[STEP 4/5] Generate a zero-knowledge proof (30-90 seconds). When following a session flow (request_signing → check_status → request_payment → check_status), just call with no parameters — requestId, circuitId, and scope are auto-resolved from the session. For direct flow, provide address+signature+circuitId+scope. Returns: proofId, verifyUrl (verification page), attestationUrl (TEE attestation page), verifierAddress, verifierExplorerUrl (Basescan link to contract), nullifier, signalHash, paymentTxHash, paymentReceiptUrl (Basescan link to payment tx), proof (raw hex), publicInputs (raw hex), cached (boolean), attestation (TEE).',
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
      required: [],
    },
  },
  {
    name: 'verify_proof',
    description: '[STEP 5/5 — OPTIONAL] Verify a proof on-chain. Provide proofId (from generate_proof) or circuitId+proof+publicInputs. Returns: valid (boolean), circuitId, verifierAddress, verifierExplorerUrl (Basescan link to contract), chainId, error (if failed).',
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
    description: '[DISCOVERY] List all supported ZK circuits. Returns: circuits[] with id (use as circuitId), displayName, description, requiredInputs, verifierAddress. Also returns chainId.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
];
