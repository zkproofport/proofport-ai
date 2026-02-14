export const swaggerSpec = {
  openapi: '3.0.3',
  info: {
    title: 'ZKProofport AI - MCP Prover Server',
    version: '0.1.0',
    description:
      'Agent-native ZK proof infrastructure. Provides MCP (Model Context Protocol) tools for zero-knowledge proof generation and verification using Noir circuits + bb CLI.',
  },
  servers: [
    {
      url: 'http://localhost:4002',
      description: 'Local Docker',
    },
  ],
  paths: {
    '/health': {
      get: {
        summary: 'Health check',
        tags: ['System'],
        responses: {
          '200': {
            description: 'Server is healthy',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    status: { type: 'string', example: 'healthy' },
                    service: { type: 'string', example: 'proofport-ai' },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/mcp': {
      post: {
        summary: 'MCP StreamableHTTP endpoint',
        description:
          'Handles MCP JSON-RPC requests (initialize, tools/list, tools/call). Stateless mode — each request creates a fresh transport.',
        tags: ['MCP'],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['jsonrpc', 'method'],
                properties: {
                  jsonrpc: { type: 'string', enum: ['2.0'] },
                  id: { type: 'number', example: 1 },
                  method: {
                    type: 'string',
                    enum: ['initialize', 'tools/list', 'tools/call'],
                  },
                  params: { type: 'object' },
                },
              },
              examples: {
                initialize: {
                  summary: 'Initialize MCP session',
                  value: {
                    jsonrpc: '2.0',
                    id: 1,
                    method: 'initialize',
                    params: {
                      protocolVersion: '2025-11-25',
                      capabilities: {},
                      clientInfo: { name: 'test', version: '1.0.0' },
                    },
                  },
                },
                listTools: {
                  summary: 'List available tools',
                  value: {
                    jsonrpc: '2.0',
                    id: 2,
                    method: 'tools/list',
                    params: {},
                  },
                },
                callGetCircuits: {
                  summary: 'Call get_supported_circuits',
                  value: {
                    jsonrpc: '2.0',
                    id: 3,
                    method: 'tools/call',
                    params: {
                      name: 'get_supported_circuits',
                      arguments: {},
                    },
                  },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'MCP JSON-RPC response',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    jsonrpc: { type: 'string' },
                    id: { type: 'number' },
                    result: { type: 'object' },
                  },
                },
              },
            },
          },
        },
      },
      get: {
        summary: 'SSE stream (not supported)',
        tags: ['MCP'],
        description: 'Returns 405 — SSE not supported in stateless mode.',
        responses: {
          '405': {
            description: 'Method not allowed',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    error: { type: 'string' },
                  },
                },
              },
            },
          },
        },
      },
      delete: {
        summary: 'Close session (not supported)',
        tags: ['MCP'],
        description: 'Returns 405 — session management not supported in stateless mode.',
        responses: {
          '405': {
            description: 'Method not allowed',
          },
        },
      },
    },
  },
  tags: [
    {
      name: 'System',
      description: 'Server health and status',
    },
    {
      name: 'MCP',
      description:
        'Model Context Protocol endpoints. Tools: generate_proof, verify_proof, get_supported_circuits',
    },
  ],
  components: {
    schemas: {
      MCPToolGenerateProof: {
        type: 'object',
        description: 'MCP tool: generate_proof — Generate a ZK proof for a circuit',
        required: ['address', 'signature', 'scope', 'circuitId'],
        properties: {
          address: {
            type: 'string',
            description: 'KYC wallet address (0x-prefixed, 20 bytes)',
            example: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
          },
          signature: {
            type: 'string',
            description: 'User signature over the signal hash (0x-prefixed, 65 bytes)',
          },
          scope: {
            type: 'string',
            description: 'Privacy scope string for nullifier computation',
            example: 'zkproofport.app',
          },
          circuitId: {
            type: 'string',
            enum: ['coinbase_attestation', 'coinbase_country_attestation'],
          },
          countryList: {
            type: 'array',
            items: { type: 'string' },
            description: 'Country codes (required for coinbase_country_attestation)',
            example: ['US', 'KR'],
          },
          isIncluded: {
            type: 'boolean',
            description: 'Prove inclusion or exclusion from country list',
          },
        },
      },
      MCPToolVerifyProof: {
        type: 'object',
        description: 'MCP tool: verify_proof — Verify a ZK proof on-chain',
        required: ['proof', 'publicInputs', 'circuitId'],
        properties: {
          proof: {
            type: 'string',
            description: 'Proof bytes (0x-prefixed hex)',
          },
          publicInputs: {
            type: 'array',
            items: { type: 'string' },
            description: 'Public inputs as bytes32 hex strings',
          },
          circuitId: {
            type: 'string',
            enum: ['coinbase_attestation', 'coinbase_country_attestation'],
          },
          chainId: {
            type: 'string',
            description: 'Chain ID (default: 84532 for Base Sepolia)',
            example: '84532',
          },
        },
      },
      MCPToolGetCircuits: {
        type: 'object',
        description: 'MCP tool: get_supported_circuits — List supported circuits',
        properties: {
          circuits: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', example: 'coinbase_attestation' },
                displayName: { type: 'string', example: 'Coinbase KYC' },
                description: { type: 'string' },
                requiredInputs: {
                  type: 'array',
                  items: { type: 'string' },
                },
              },
            },
          },
        },
      },
    },
  },
};
