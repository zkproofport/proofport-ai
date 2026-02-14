export function buildSwaggerSpec(baseUrl: string) {
  return {
    openapi: '3.0.3',
    info: {
      title: 'ZKProofport AI - MCP Prover Server',
      version: '0.1.0',
      description:
        'Agent-native ZK proof infrastructure. Provides MCP (Model Context Protocol) tools for zero-knowledge proof generation and verification using Noir circuits + bb CLI.',
    },
    servers: [
      {
        url: baseUrl,
        description: 'API Server',
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
    '/a2a': {
      post: {
        summary: 'A2A v0.3 JSON-RPC endpoint',
        description:
          'Handles all A2A protocol v0.3 methods via JSON-RPC 2.0. Methods: message/send (blocking), message/stream (SSE), tasks/get, tasks/cancel, tasks/resubscribe. Payment (x402) required only for message/send and message/stream.',
        tags: ['A2A'],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['jsonrpc', 'method'],
                properties: {
                  jsonrpc: { type: 'string', enum: ['2.0'] },
                  id: { type: 'string' },
                  method: {
                    type: 'string',
                    enum: ['message/send', 'message/stream', 'tasks/get', 'tasks/cancel', 'tasks/resubscribe'],
                  },
                  params: { type: 'object' },
                },
              },
              examples: {
                messageSend: {
                  summary: 'message/send — Send message and block until completion',
                  value: {
                    jsonrpc: '2.0',
                    id: 'req-1',
                    method: 'message/send',
                    params: {
                      message: {
                        role: 'user',
                        parts: [
                          {
                            kind: 'data',
                            mimeType: 'application/json',
                            data: {
                              skill: 'generate_proof',
                              address: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
                              signature: '0x...',
                              scope: 'zkproofport.app',
                              circuitId: 'coinbase_attestation',
                            },
                          },
                        ],
                      },
                    },
                  },
                },
                messageStream: {
                  summary: 'message/stream — Send message and return SSE stream',
                  value: {
                    jsonrpc: '2.0',
                    id: 'req-2',
                    method: 'message/stream',
                    params: {
                      message: {
                        role: 'user',
                        parts: [
                          {
                            kind: 'data',
                            mimeType: 'application/json',
                            data: {
                              skill: 'generate_proof',
                              address: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
                              signature: '0x...',
                              scope: 'zkproofport.app',
                              circuitId: 'coinbase_attestation',
                            },
                          },
                        ],
                      },
                    },
                  },
                },
                tasksGet: {
                  summary: 'tasks/get — Get task by ID with optional history',
                  value: {
                    jsonrpc: '2.0',
                    id: 'req-3',
                    method: 'tasks/get',
                    params: {
                      taskId: 'task-123',
                      historyLength: 10,
                    },
                  },
                },
                tasksCancel: {
                  summary: 'tasks/cancel — Cancel a running task',
                  value: {
                    jsonrpc: '2.0',
                    id: 'req-4',
                    method: 'tasks/cancel',
                    params: {
                      taskId: 'task-123',
                    },
                  },
                },
                tasksResubscribe: {
                  summary: 'tasks/resubscribe — Resubscribe to task events',
                  value: {
                    jsonrpc: '2.0',
                    id: 'req-5',
                    method: 'tasks/resubscribe',
                    params: {
                      taskId: 'task-123',
                    },
                  },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'A2A JSON-RPC response',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    jsonrpc: { type: 'string' },
                    id: { type: 'string' },
                    result: { type: 'object' },
                  },
                },
              },
            },
          },
          '402': {
            description: 'Payment required (x402)',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    error: { type: 'string' },
                    paymentRequired: { type: 'boolean' },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/.well-known/agent.json': {
      get: {
        summary: 'OASF Agent Discovery',
        description: 'Returns OASF-compliant agent identity with ERC-8004 on-chain identity reference',
        tags: ['Discovery'],
        responses: {
          '200': {
            description: 'Agent identity document',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    name: { type: 'string' },
                    version: { type: 'string' },
                    identity: {
                      type: 'object',
                      properties: {
                        chainId: { type: 'number' },
                        identityContract: { type: 'string' },
                        tokenId: { type: 'string' },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/.well-known/agent-card.json': {
      get: {
        summary: 'A2A Agent Card',
        description: 'Returns A2A v0.3 agent capabilities and endpoints',
        tags: ['Discovery'],
        responses: {
          '200': {
            description: 'Agent card',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    name: { type: 'string' },
                    version: { type: 'string' },
                    capabilities: {
                      type: 'object',
                      properties: {
                        mcp: { type: 'boolean' },
                        a2a: { type: 'boolean' },
                        payment: {
                          type: 'array',
                          items: { type: 'string' },
                        },
                      },
                    },
                    endpoints: {
                      type: 'object',
                      properties: {
                        jsonrpc: { type: 'string' },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/.well-known/mcp.json': {
      get: {
        summary: 'MCP Discovery',
        description: 'Returns MCP protocol endpoint and available tools',
        tags: ['Discovery'],
        responses: {
          '200': {
            description: 'MCP discovery document',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    protocol: { type: 'string' },
                    version: { type: 'string' },
                    endpoint: { type: 'string' },
                    tools: {
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
    },
    '/payment/status': {
      get: {
        summary: 'Payment mode status',
        description: 'Returns payment mode configuration and network information',
        tags: ['Status'],
        responses: {
          '200': {
            description: 'Payment mode info',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    mode: { type: 'string', example: 'disabled' },
                    network: { type: 'string', example: 'testnet' },
                    requiresPayment: { type: 'boolean', example: false },
                    description: { type: 'string', example: 'Payment disabled (free tier)' },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/signing/status': {
      get: {
        summary: 'Signing provider status',
        description: 'Returns enabled signing methods and configuration',
        tags: ['Status'],
        responses: {
          '200': {
            description: 'Signing provider status',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    providers: {
                      type: 'object',
                      properties: {
                        privy: {
                          type: 'object',
                          properties: {
                            enabled: { type: 'boolean' },
                          },
                        },
                        web: {
                          type: 'object',
                          properties: {
                            enabled: { type: 'boolean' },
                            signPageUrl: { type: 'string', nullable: true },
                          },
                        },
                        eip7702: {
                          type: 'object',
                          properties: {
                            enabled: { type: 'boolean' },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/tee/status': {
      get: {
        summary: 'TEE mode status',
        description: 'Returns TEE configuration and availability',
        tags: ['Status'],
        responses: {
          '200': {
            description: 'TEE mode info',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    mode: { type: 'string', example: 'disabled' },
                    attestationEnabled: { type: 'boolean', example: false },
                    available: { type: 'boolean', example: false },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/identity/status': {
      get: {
        summary: 'ERC-8004 identity status',
        description: 'Returns ERC-8004 identity and reputation contract configuration',
        tags: ['Status'],
        responses: {
          '200': {
            description: 'ERC-8004 identity config',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    erc8004: {
                      type: 'object',
                      properties: {
                        identityContract: { type: 'string', nullable: true },
                        reputationContract: { type: 'string', nullable: true },
                        configured: { type: 'boolean' },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/api/signing/{requestId}': {
      get: {
        summary: 'Get signing request details',
        description: 'Retrieves signing request information by request ID',
        tags: ['Signing'],
        parameters: [
          {
            name: 'requestId',
            in: 'path',
            required: true,
            schema: { type: 'string' },
            description: 'Signing request ID',
          },
        ],
        responses: {
          '200': {
            description: 'Signing request details',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    address: { type: 'string', nullable: true },
                    signalHash: { type: 'string', nullable: true },
                    scope: { type: 'string' },
                    circuitId: { type: 'string' },
                    status: { type: 'string' },
                    expiresAt: { type: 'number' },
                  },
                },
              },
            },
          },
          '404': {
            description: 'Request not found or expired',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    error: { type: 'string', example: 'Request not found or expired' },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/api/signing/{requestId}/prepare': {
      post: {
        summary: 'Prepare signing request',
        description: 'Computes signalHash from connected wallet address for an existing signing request',
        tags: ['Signing'],
        parameters: [
          {
            name: 'requestId',
            in: 'path',
            required: true,
            schema: { type: 'string' },
            description: 'Signing request ID',
          },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['address'],
                properties: {
                  address: { type: 'string', description: 'Connected wallet address' },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Signal hash computed successfully',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    signalHash: { type: 'string' },
                  },
                },
              },
            },
          },
          '400': {
            description: 'Invalid request',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    error: { type: 'string', example: 'Missing address' },
                  },
                },
              },
            },
          },
          '404': {
            description: 'Request not found or expired',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    error: { type: 'string', example: 'Request not found or expired' },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/api/signing/callback/{requestId}': {
      post: {
        summary: 'Signing callback',
        description: 'Receives signed transaction from the web signing page. Internal endpoint used by sign-page.',
        tags: ['Signing'],
        parameters: [
          {
            name: 'requestId',
            in: 'path',
            required: true,
            schema: { type: 'string' },
            description: 'Signing request ID',
          },
        ],
        responses: {
          '200': {
            description: 'Signature received',
          },
        },
      },
    },
    '/api/signing/batch': {
      post: {
        summary: 'Batch signing via EIP-7702',
        description: 'Submit batch signing request using EIP-7702 session keys.',
        tags: ['Signing'],
        responses: {
          '200': {
            description: 'Batch signing request submitted',
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
    {
      name: 'A2A',
      description: 'Agent-to-Agent Protocol v0.3 — JSON-RPC 2.0 methods for task management and proof generation',
    },
    {
      name: 'Discovery',
      description: 'Agent discovery endpoints for A2A, OASF, and MCP',
    },
    {
      name: 'Status',
      description: 'Service status endpoints for payment, signing, TEE, and identity',
    },
    {
      name: 'Signing',
      description: 'Web signing flow endpoints for wallet-based signature collection',
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
}
