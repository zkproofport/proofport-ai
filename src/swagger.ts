export function buildSwaggerSpec(baseUrl: string) {
  return {
    openapi: '3.0.3',
    info: {
      title: 'proveragent.eth - ZK Proof Generation Agent',
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
        parameters: [
          {
            name: 'Accept',
            in: 'header',
            required: true,
            schema: { type: 'string', default: 'application/json, text/event-stream' },
            description: 'Must include both application/json and text/event-stream. Without this header, the MCP SDK returns 406 Not Acceptable.',
          },
        ],
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
                callRequestSigning: {
                  summary: 'Call request_signing',
                  value: {
                    jsonrpc: '2.0',
                    id: 4,
                    method: 'tools/call',
                    params: {
                      name: 'request_signing',
                      arguments: {
                        circuitId: 'coinbase_attestation',
                        scope: 'myapp.com',
                      },
                    },
                  },
                },
                callCheckStatus: {
                  summary: 'Call check_status',
                  value: {
                    jsonrpc: '2.0',
                    id: 5,
                    method: 'tools/call',
                    params: {
                      name: 'check_status',
                      arguments: {
                        requestId: '<requestId from request_signing>',
                      },
                    },
                  },
                },
                callRequestPayment: {
                  summary: 'Call request_payment',
                  value: {
                    jsonrpc: '2.0',
                    id: 6,
                    method: 'tools/call',
                    params: {
                      name: 'request_payment',
                      arguments: {
                        requestId: '<requestId from request_signing>',
                      },
                    },
                  },
                },
                callGenerateProof: {
                  summary: 'Call generate_proof (with requestId)',
                  value: {
                    jsonrpc: '2.0',
                    id: 7,
                    method: 'tools/call',
                    params: {
                      name: 'generate_proof',
                      arguments: {
                        circuitId: 'coinbase_attestation',
                        scope: 'myapp.com',
                        requestId: '<requestId from request_signing>',
                      },
                    },
                  },
                },
                callVerifyProof: {
                  summary: 'Call verify_proof',
                  value: {
                    jsonrpc: '2.0',
                    id: 8,
                    method: 'tools/call',
                    params: {
                      name: 'verify_proof',
                      arguments: {
                        circuitId: 'coinbase_attestation',
                        proof: '0x...',
                        publicInputs: ['0x...'],
                        chainId: '84532',
                      },
                    },
                  },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'MCP JSON-RPC response (SSE event stream with JSON-RPC payloads)',
            content: {
              'text/event-stream': {
                schema: {
                  type: 'string',
                  description: 'SSE stream with `data:` lines containing JSON-RPC responses',
                  example: 'event: message\ndata: {"result":{"content":[{"type":"text","text":"..."}]},"jsonrpc":"2.0","id":1}\n\n',
                },
              },
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
          '406': {
            description: 'Not Acceptable — client must accept both application/json and text/event-stream',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    jsonrpc: { type: 'string', example: '2.0' },
                    error: {
                      type: 'object',
                      properties: {
                        code: { type: 'number', example: -32000 },
                        message: { type: 'string', example: 'Not Acceptable: Client must accept both application/json and text/event-stream' },
                      },
                    },
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
                messageSendGetCircuits: {
                  summary: 'message/send — get_supported_circuits',
                  value: {
                    jsonrpc: '2.0',
                    id: 'req-6',
                    method: 'message/send',
                    params: {
                      message: {
                        role: 'user',
                        parts: [{ kind: 'data', mimeType: 'application/json', data: { skill: 'get_supported_circuits' } }],
                      },
                    },
                  },
                },
                messageSendRequestSigning: {
                  summary: 'message/send — request_signing',
                  value: {
                    jsonrpc: '2.0',
                    id: 'req-7',
                    method: 'message/send',
                    params: {
                      message: {
                        role: 'user',
                        parts: [{ kind: 'data', mimeType: 'application/json', data: { skill: 'request_signing', circuitId: 'coinbase_attestation', scope: 'myapp.com' } }],
                      },
                    },
                  },
                },
                messageSendCheckStatus: {
                  summary: 'message/send — check_status',
                  value: {
                    jsonrpc: '2.0',
                    id: 'req-8',
                    method: 'message/send',
                    params: {
                      message: {
                        role: 'user',
                        parts: [{ kind: 'data', mimeType: 'application/json', data: { skill: 'check_status', requestId: '<requestId from request_signing>' } }],
                      },
                    },
                  },
                },
                messageSendRequestPayment: {
                  summary: 'message/send — request_payment',
                  value: {
                    jsonrpc: '2.0',
                    id: 'req-9',
                    method: 'message/send',
                    params: {
                      message: {
                        role: 'user',
                        parts: [{ kind: 'data', mimeType: 'application/json', data: { skill: 'request_payment', requestId: '<requestId from request_signing>' } }],
                      },
                    },
                  },
                },
                messageSendVerifyProof: {
                  summary: 'message/send — verify_proof',
                  value: {
                    jsonrpc: '2.0',
                    id: 'req-10',
                    method: 'message/send',
                    params: {
                      message: {
                        role: 'user',
                        parts: [{ kind: 'data', mimeType: 'application/json', data: { skill: 'verify_proof', circuitId: 'coinbase_attestation', proof: '0x...', publicInputs: ['0x...'], chainId: '84532' } }],
                      },
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
    '/.well-known/oasf.json': {
      get: {
        summary: 'OASF Agent Discovery (alias)',
        description: 'Alias for /.well-known/agent.json — returns the same OASF agent identity',
        tags: ['Discovery'],
        responses: {
          '200': {
            description: 'Agent identity document',
            content: { 'application/json': { schema: { type: 'object' } } },
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
    '/api/v1/circuits': {
      get: {
        summary: 'List supported ZK circuits',
        description: 'Returns all available zero-knowledge circuits with metadata, required inputs, and on-chain verifier addresses.',
        tags: ['REST API'],
        responses: {
          '200': {
            description: 'List of supported circuits',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    circuits: {
                      type: 'array',
                      items: { $ref: '#/components/schemas/MCPToolGetCircuits/properties/circuits/items' },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/api/v1/signing': {
      post: {
        summary: 'Create a signing session',
        description: 'Creates a new signing request. Returns a requestId, signingUrl (where the user signs), and expiresAt timestamp. This is the first step in the multi-turn proof generation flow.',
        tags: ['REST API'],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['circuitId', 'scope'],
                properties: {
                  circuitId: {
                    type: 'string',
                    enum: ['coinbase_attestation', 'coinbase_country_attestation'],
                    description: 'Which circuit to use',
                  },
                  scope: {
                    type: 'string',
                    description: 'Privacy scope (e.g., "myapp.com")',
                    example: 'myapp.com',
                  },
                  countryList: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Country codes for country attestation (ISO 3166-1 alpha-2)',
                  },
                  isIncluded: {
                    type: 'boolean',
                    description: 'For country attestation: true for inclusion, false for exclusion',
                  },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Signing session created',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    requestId: { type: 'string', description: 'Unique request ID for this session' },
                    signingUrl: { type: 'string', description: 'URL where the user signs with their wallet' },
                    expiresAt: { type: 'string', format: 'date-time', description: 'When this signing session expires' },
                  },
                },
              },
            },
          },
          '400': { description: 'Invalid parameters (missing circuitId, unknown circuit, etc.)' },
        },
      },
    },
    '/api/v1/signing/{requestId}/status': {
      get: {
        summary: 'Check signing/payment status',
        description: 'Returns the current phase of a signing request: signing (waiting for signature), payment (signature received, awaiting payment), ready (all prerequisites met, can generate proof), or expired.',
        tags: ['REST API'],
        parameters: [
          {
            name: 'requestId',
            in: 'path',
            required: true,
            schema: { type: 'string' },
            description: 'Request ID from POST /api/v1/signing',
          },
        ],
        responses: {
          '200': {
            description: 'Current status of the signing request',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    requestId: { type: 'string' },
                    phase: { type: 'string', enum: ['signing', 'payment', 'ready', 'expired'] },
                    signing: {
                      type: 'object',
                      properties: {
                        status: { type: 'string', enum: ['pending', 'completed'] },
                        address: { type: 'string', nullable: true },
                      },
                    },
                    payment: {
                      type: 'object',
                      nullable: true,
                      properties: {
                        required: { type: 'boolean' },
                        status: { type: 'string', enum: ['pending', 'completed'] },
                      },
                    },
                    expiresAt: { type: 'string', format: 'date-time' },
                  },
                },
              },
            },
          },
          '404': { description: 'Request not found or expired' },
        },
      },
    },
    '/api/v1/signing/{requestId}/payment': {
      post: {
        summary: 'Initiate payment for proof generation',
        description: 'Creates a payment request for the given signing session. Signing must be completed first. Returns a paymentUrl where the user pays $0.10 USDC. If payment mode is disabled, returns a message to proceed directly to generate_proof.',
        tags: ['REST API'],
        parameters: [
          {
            name: 'requestId',
            in: 'path',
            required: true,
            schema: { type: 'string' },
            description: 'Request ID from POST /api/v1/signing',
          },
        ],
        responses: {
          '200': {
            description: 'Payment initiated or not required',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    message: { type: 'string', description: 'Status message' },
                    paymentUrl: { type: 'string', nullable: true, description: 'URL where user pays (null if payment disabled)' },
                    requestId: { type: 'string' },
                  },
                },
              },
            },
          },
          '400': { description: 'Signing not completed yet or payment already completed' },
          '404': { description: 'Request not found or expired' },
        },
      },
    },
    '/api/v1/proofs': {
      post: {
        summary: 'Generate a ZK proof',
        description: 'Generates a zero-knowledge proof. Three modes: (1) Web signing — send circuitId+scope, get signingUrl; (2) Resume — send requestId after user signed; (3) Direct — send address+signature for immediate proof.',
        tags: ['REST API'],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/MCPToolGenerateProof' },
              examples: {
                webSigning: {
                  summary: 'Web signing flow (step 1)',
                  value: { circuitId: 'coinbase_attestation', scope: 'my-dapp.example.com' },
                },
                resume: {
                  summary: 'Resume after signing (step 2)',
                  value: { circuitId: 'coinbase_attestation', scope: 'my-dapp.example.com', requestId: '22d302e0-...' },
                },
                direct: {
                  summary: 'Direct signing',
                  value: { circuitId: 'coinbase_attestation', scope: 'my-dapp.example.com', address: '0xD6C7...', signature: '0x1234...' },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Proof generated or signing request created',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    taskId: { type: 'string' },
                    state: { type: 'string', enum: ['input-required', 'completed'] },
                    signingUrl: { type: 'string', description: 'Present when state is input-required' },
                    requestId: { type: 'string', description: 'Present when state is input-required' },
                    proof: { type: 'string', description: 'Present when state is completed' },
                    publicInputs: { type: 'string', description: 'Present when state is completed' },
                    nullifier: { type: 'string', description: 'Present when state is completed' },
                    signalHash: { type: 'string', description: 'Present when state is completed' },
                  },
                },
              },
            },
          },
          '400': { description: 'Invalid request parameters' },
          '402': { description: 'Payment required (x402)' },
        },
      },
    },
    '/api/v1/proofs/{taskId}': {
      get: {
        summary: 'Check proof generation status',
        description: 'Returns the current status of a proof generation task.',
        tags: ['REST API'],
        parameters: [
          {
            name: 'taskId',
            in: 'path',
            required: true,
            schema: { type: 'string' },
            description: 'Task ID from generateProof',
          },
        ],
        responses: {
          '200': {
            description: 'Task status',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    taskId: { type: 'string' },
                    state: { type: 'string' },
                    message: { type: 'string' },
                    proof: { type: 'string' },
                    publicInputs: { type: 'string' },
                    nullifier: { type: 'string' },
                    signalHash: { type: 'string' },
                    signingUrl: { type: 'string' },
                    requestId: { type: 'string' },
                    error: { type: 'string' },
                  },
                },
              },
            },
          },
          '404': { description: 'Task not found' },
        },
      },
    },
    '/api/v1/proofs/verify': {
      post: {
        summary: 'Verify a ZK proof on-chain',
        description: 'Verifies a zero-knowledge proof against the deployed on-chain verifier contract.',
        tags: ['REST API'],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/MCPToolVerifyProof' },
            },
          },
        },
        responses: {
          '200': {
            description: 'Verification result',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    valid: { type: 'boolean' },
                    circuitId: { type: 'string' },
                    verifierAddress: { type: 'string' },
                    chainId: { type: 'string' },
                    error: { type: 'string' },
                  },
                },
              },
            },
          },
          '400': { description: 'Invalid request parameters' },
          '402': { description: 'Payment required (x402)' },
        },
      },
    },
    '/api/v1/verify/{proofId}': {
      get: {
        summary: 'Verify a stored proof on-chain by proofId',
        description: 'Retrieves a stored proof result and verifies it on-chain. Used by QR code scanning after proof generation.',
        tags: ['REST API'],
        parameters: [
          {
            name: 'proofId',
            in: 'path',
            required: true,
            schema: { type: 'string' },
            description: 'Proof ID returned from proof generation',
          },
        ],
        responses: {
          '200': {
            description: 'Verification result',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    proofId: { type: 'string' },
                    circuitId: { type: 'string' },
                    nullifier: { type: 'string' },
                    isValid: { type: 'boolean' },
                    verifierAddress: { type: 'string' },
                    chainId: { type: 'string' },
                  },
                },
              },
            },
          },
          '404': { description: 'Proof not found or expired' },
        },
      },
    },
    '/v1/chat/completions': {
      post: {
        summary: 'OpenAI-compatible chat completions',
        description: 'OpenAI Chat Completions API-compatible endpoint. Supports natural language interaction with automatic function calling for ZK proof generation/verification. Session management via HTTP headers (X-Session-Id / X-Session-Secret). Structured data (proof results, signing URLs) embedded in assistant content as a fenced ```proofport DSL block.',
        tags: ['Chat'],
        parameters: [
          {
            name: 'X-Session-Id',
            in: 'header',
            schema: { type: 'string' },
            description: 'Session ID for conversation continuity. Auto-generated on first request and returned in response headers.',
          },
          {
            name: 'X-Session-Secret',
            in: 'header',
            schema: { type: 'string' },
            description: 'Session secret (required when continuing an existing session). Returned in response headers on session creation.',
          },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['messages'],
                properties: {
                  messages: {
                    type: 'array',
                    items: {
                      type: 'object',
                      required: ['role', 'content'],
                      properties: {
                        role: { type: 'string', enum: ['system', 'user', 'assistant'] },
                        content: { type: 'string' },
                      },
                    },
                    description: 'OpenAI-compatible message array',
                  },
                  model: { type: 'string', default: 'zkproofport' },
                  stream: { type: 'boolean', default: false, description: 'Enable SSE streaming' },
                  temperature: { type: 'number' },
                  max_tokens: { type: 'number' },
                },
              },
              examples: {
                simple: {
                  summary: 'Simple question',
                  value: { messages: [{ role: 'user', content: 'What proofs can you generate?' }], model: 'zkproofport' },
                },
                proofGeneration: {
                  summary: 'Proof generation request',
                  value: { messages: [{ role: 'user', content: 'Generate a Coinbase KYC proof for scope zkproofport.app' }], model: 'zkproofport' },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Chat completion response (standard OpenAI format)',
            headers: {
              'X-Session-Id': { schema: { type: 'string' }, description: 'Session ID (returned on first request)' },
              'X-Session-Secret': { schema: { type: 'string' }, description: 'Session secret (returned only on session creation)' },
            },
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    id: { type: 'string', example: 'chatcmpl-abc123' },
                    object: { type: 'string', example: 'chat.completion' },
                    created: { type: 'number' },
                    model: { type: 'string', example: 'zkproofport' },
                    choices: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          index: { type: 'number' },
                          message: {
                            type: 'object',
                            properties: {
                              role: { type: 'string', example: 'assistant' },
                              content: { type: 'string', description: 'Response text. May include a fenced ```proofport block with structured JSON data (proof results, signing URLs, etc.).' },
                            },
                          },
                          finish_reason: { type: 'string', example: 'stop' },
                        },
                      },
                    },
                    usage: {
                      type: 'object',
                      properties: {
                        prompt_tokens: { type: 'number' },
                        completion_tokens: { type: 'number' },
                        total_tokens: { type: 'number' },
                      },
                    },
                  },
                },
              },
            },
          },
          '400': { description: 'Invalid request (missing or empty messages)' },
          '402': { description: 'Payment required (x402)' },
          '403': { description: 'Invalid or missing session secret' },
          '404': { description: 'Session not found or expired' },
          '503': { description: 'Chat not configured (no LLM API key set)' },
        },
      },
    },
    '/v1/models': {
      get: {
        summary: 'List available models',
        description: 'Returns available model list (OpenAI-compatible). Returns a single model: zkproofport.',
        tags: ['Chat'],
        responses: {
          '200': {
            description: 'Model list',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    object: { type: 'string', example: 'list' },
                    data: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          id: { type: 'string', example: 'zkproofport' },
                          object: { type: 'string', example: 'model' },
                          owned_by: { type: 'string', example: 'zkproofport' },
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
    '/api/v1/chat': {
      post: {
        summary: 'Chat endpoint (DEPRECATED)',
        description: 'This endpoint has been moved to /v1/chat/completions. Returns 410 Gone.',
        tags: ['Chat'],
        deprecated: true,
        responses: {
          '410': {
            description: 'Gone — endpoint moved to /v1/chat/completions',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    error: { type: 'string', example: 'This endpoint has been moved to /v1/chat/completions' },
                    newEndpoint: { type: 'string', example: '/v1/chat/completions' },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/v/{proofId}': {
      get: {
        summary: 'Proof verification page (HTML)',
        description: 'Returns an HTML page that displays proof verification results. Used for QR code scanning after proof generation.',
        tags: ['HTML Pages'],
        parameters: [
          { name: 'proofId', in: 'path', required: true, schema: { type: 'string' }, description: 'Proof ID from proof generation' },
        ],
        responses: {
          '200': { description: 'HTML verification page', content: { 'text/html': { schema: { type: 'string' } } } },
        },
      },
    },
    '/pay/{requestId}': {
      get: {
        summary: 'Payment page (HTML)',
        description: 'Returns an HTML page where the user can pay $0.10 USDC for proof generation. Used in the multi-turn signing flow.',
        tags: ['HTML Pages'],
        parameters: [
          { name: 'requestId', in: 'path', required: true, schema: { type: 'string' }, description: 'Request ID from signing session' },
        ],
        responses: {
          '200': { description: 'HTML payment page', content: { 'text/html': { schema: { type: 'string' } } } },
        },
      },
    },
    '/api/payment/{requestId}': {
      get: {
        summary: 'Get payment request details',
        description: 'Returns payment request information including amount, network, and status.',
        tags: ['Payment'],
        parameters: [
          { name: 'requestId', in: 'path', required: true, schema: { type: 'string' }, description: 'Request ID from signing session' },
        ],
        responses: {
          '200': {
            description: 'Payment request details',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    requestId: { type: 'string' },
                    amount: { type: 'string', example: '100000' },
                    token: { type: 'string', example: 'USDC' },
                    network: { type: 'string', example: 'base-sepolia' },
                    payTo: { type: 'string' },
                    status: { type: 'string', enum: ['pending', 'completed'] },
                  },
                },
              },
            },
          },
          '404': { description: 'Payment request not found' },
        },
      },
    },
    '/api/payment/confirm/{requestId}': {
      post: {
        summary: 'Confirm payment completion',
        description: 'Called after USDC payment transaction is confirmed on-chain. Updates the signing request payment status.',
        tags: ['Payment'],
        parameters: [
          { name: 'requestId', in: 'path', required: true, schema: { type: 'string' }, description: 'Request ID' },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  txHash: { type: 'string', description: 'On-chain transaction hash' },
                },
                required: ['txHash'],
              },
            },
          },
        },
        responses: {
          '200': { description: 'Payment confirmed', content: { 'application/json': { schema: { type: 'object', properties: { message: { type: 'string' } } } } } },
          '400': { description: 'Invalid request or already confirmed' },
          '404': { description: 'Request not found' },
        },
      },
    },
    '/api/payment/sign/{requestId}': {
      post: {
        summary: 'Get EIP-3009 signing data for payment',
        description: 'Returns the EIP-712 typed data for TransferWithAuthorization (EIP-3009) that the user needs to sign for USDC payment.',
        tags: ['Payment'],
        parameters: [
          { name: 'requestId', in: 'path', required: true, schema: { type: 'string' }, description: 'Request ID' },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  payerAddress: { type: 'string', description: 'Payer wallet address' },
                },
                required: ['payerAddress'],
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'EIP-712 typed data for signing',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    domain: { type: 'object' },
                    types: { type: 'object' },
                    value: { type: 'object' },
                    primaryType: { type: 'string' },
                  },
                },
              },
            },
          },
          '400': { description: 'Invalid request' },
          '404': { description: 'Request not found' },
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
        'Model Context Protocol endpoints. Tools: get_supported_circuits, request_signing, check_status, request_payment, generate_proof, verify_proof',
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
    {
      name: 'REST API',
      description: 'REST API endpoints for GPT Actions and direct HTTP integration. Wraps the same proof generation/verification capabilities as A2A and MCP.',
    },
    {
      name: 'Chat',
      description: 'OpenAI Chat Completions-compatible endpoint. Session via X-Session-Id/X-Session-Secret headers. Structured data in content via ```proofport DSL block.',
    },
    {
      name: 'Payment',
      description: 'Web payment flow endpoints for USDC payment via EIP-3009 TransferWithAuthorization',
    },
    {
      name: 'HTML Pages',
      description: 'HTML pages for web-based signing, payment, and proof verification',
    },
  ],
  components: {
    schemas: {
      MCPToolGenerateProof: {
        type: 'object',
        description: 'MCP tool: generate_proof — Generate a ZK proof for a circuit',
        required: ['circuitId', 'scope'],
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
          requestId: {
            type: 'string',
            description: 'Request ID from request_signing (for session-based flow)',
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
