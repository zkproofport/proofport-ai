export function buildSwaggerSpec(baseUrl: string, agentName = 'ZKProofport prover') {
  return {
    openapi: '3.0.3',
    info: {
      // The deployment's own name, not the mainnet one. This said
      // `proveragent.base.eth` on every environment.
      title: `${agentName} - ZK Proof Generation Agent`,
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
    '/': {
      get: {
        summary: 'Service summary',
        description: 'Returns agent name, description, and available endpoint paths.',
        tags: ['System'],
        responses: {
          '200': {
            description: 'Service summary with endpoint map',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    name: { type: 'string' },
                    description: { type: 'string' },
                    endpoints: { type: 'object' },
                  },
                },
              },
            },
          },
        },
      },
    },
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
                callProve: {
                  summary: 'Call prove — returns REST redirect (use POST /api/v1/prove instead)',
                  value: {
                    jsonrpc: '2.0',
                    id: 4,
                    method: 'tools/call',
                    params: {
                      name: 'prove',
                      arguments: {
                        circuit: 'coinbase_kyc',
                        inputs: {
                          signal_hash: '0x...',
                          oprf_key_hash: '0x...',
                          domain: '0x...',
                          scope: '0x...',
                          nullifier: '0x...',
                          oprf_public_key_x: '0x...',
                          oprf_public_key_y: '0x...',
                          oprf_beta: '0x...',
                          oprf_dlog_e: '0x...',
                          oprf_dlog_s: '0x...',
                          oprf_response_x: '0x...',
                          oprf_response_y: '0x...',
                          merkle_root: '0x...',
                          user_address: '0x...',
                          signature: '0x...',
                          user_pubkey_x: '0x...',
                          user_pubkey_y: '0x...',
                          raw_transaction: '0x...',
                          tx_length: 256,
                          coinbase_attester_pubkey_x: '0x...',
                          coinbase_attester_pubkey_y: '0x...',
                          merkle_proof: ['0x...'],
                          leaf_index: 0,
                          depth: 10,
                        },
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
                messageSendProve: {
                  summary: 'message/send — prove (x402 single-step, returns REST redirect)',
                  value: {
                    jsonrpc: '2.0',
                    id: 'req-1',
                    method: 'message/send',
                    params: {
                      message: {
                        role: 'user',
                        parts: [{ kind: 'data', mimeType: 'application/json', data: { skill: 'prove', circuit: 'coinbase_kyc' } }],
                      },
                    },
                  },
                },
                messageStreamProve: {
                  summary: 'message/stream — prove (SSE)',
                  value: {
                    jsonrpc: '2.0',
                    id: 'req-2',
                    method: 'message/stream',
                    params: {
                      message: {
                        role: 'user',
                        parts: [{ kind: 'data', mimeType: 'application/json', data: { skill: 'prove', circuit: 'coinbase_kyc' } }],
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
                messageSendProveWithInputs: {
                  summary: 'message/send — prove with inputs (returns REST redirect)',
                  value: {
                    jsonrpc: '2.0',
                    id: 'req-7',
                    method: 'message/send',
                    params: {
                      message: {
                        role: 'user',
                        parts: [{ kind: 'data', mimeType: 'application/json', data: { skill: 'prove', circuit: 'coinbase_kyc', inputs: {} } }],
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
    '/.well-known/SKILL.md': {
      get: {
        summary: 'SKILL.md — Agent capability document',
        description: 'Returns a Markdown document describing this agent\'s capabilities, supported circuits, payment info, and usage examples. Part of the Base ecosystem SKILL.md standard for AI agent auto-discovery.',
        tags: ['Discovery'],
        responses: {
          '200': {
            description: 'SKILL.md document',
            content: {
              'text/markdown': {
                schema: {
                  type: 'string',
                  description: 'Markdown-formatted agent capability document',
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
    '/.well-known/agent-registration.json': {
      get: {
        summary: 'Agent Registration (ERC-8004 Rule 4)',
        description: 'Bidirectional link between domain and on-chain identity. Returns agentId (ERC-721 tokenId) and agentRegistry (EIP-155 contract reference).',
        tags: ['Discovery'],
        responses: {
          '200': {
            description: 'Agent registration document',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    registrations: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          agentId: { type: 'number', nullable: true, description: 'ERC-8004 token ID' },
                          agentRegistry: { type: 'string', description: 'EIP-155 format registry address (eip155:{chainId}:{address})' },
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
    '/.well-known/did.json': {
      get: {
        summary: 'DID Document (W3C did:web)',
        description: 'W3C Decentralized Identifier document for did:web resolution. Contains verification method (EcdsaSecp256k1RecoveryMethod2020) and ERC8004Agent service endpoint.',
        tags: ['Discovery'],
        responses: {
          '200': {
            description: 'DID Document',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    '@context': { type: 'array', items: { type: 'string' } },
                    id: { type: 'string', description: 'DID identifier (did:web:{hostname})' },
                    verificationMethod: { type: 'array', items: { type: 'object' } },
                    service: { type: 'array', items: { type: 'object' } },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/api/v1/prove': {
      post: {
        summary: 'Generate ZK proof (x402 single-step)',
        description: 'x402 single-step flow: POST circuit + inputs → 402 with nonce → pay USDC → retry with X-Payment-TX and X-Payment-Nonce headers. Atomically verifies USDC payment on-chain and generates ZK proof in TEE. Takes 30-90 seconds.',
        tags: ['Proof Generation'],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['circuit', 'inputs'],
                properties: {
                  circuit: {
                    type: 'string',
                    enum: ['coinbase_kyc', 'coinbase_country', 'oidc_domain', 'giwa_attestation', 'human_passport'],
                    description: 'Which circuit to use',
                  },
                  inputs: {
                    type: 'object',
                    description: 'Circuit inputs for proof generation',
                    required: ['signal_hash', 'oprf_key_hash', 'domain', 'scope', 'nullifier', 'oprf_public_key_x', 'oprf_public_key_y', 'oprf_beta', 'oprf_dlog_e', 'oprf_dlog_s', 'oprf_response_x', 'oprf_response_y', 'merkle_root', 'user_address', 'signature', 'user_pubkey_x', 'user_pubkey_y', 'raw_transaction', 'tx_length', 'coinbase_attester_pubkey_x', 'coinbase_attester_pubkey_y', 'merkle_proof', 'leaf_index', 'depth'],
                    properties: {
                      signal_hash: { type: 'string', description: '0x-prefixed 32-byte signal hash' },
                      oprf_key_hash: { type: 'string', description: 'Public. Hash of the OPRF network key that answered. Must equal the key hash pinned for this deployment\'s environment (GET /api/v1/oprf) and the circuit, or the request is refused before payment (OPRF_KEY_HASH_MISMATCH). 0x + exactly 64 hex, below the BN254 field modulus p; never reduced. Computed by the SDK OPRF step (@zkproofport-ai/sdk generateProof / the MCP prepare step), which asks the OPRF network for this wallet in (domain, scope) and verifies its answer.' },
                      domain: { type: 'string', description: 'Public. The nullifier domain: keccak256(UTF-8 domain name) mod p, where the domain name (1-256 UTF-8 bytes, no control or format characters) names the service the proof is for. 0x + exactly 64 hex, below the BN254 field modulus p; never reduced. Computed by the SDK OPRF step (@zkproofport-ai/sdk generateProof / the MCP prepare step), which asks the OPRF network for this wallet in (domain, scope) and verifies its answer.' },
                      scope: { type: 'string', description: 'Public. The nullifier scope: keccak256(UTF-8 scope name) mod p. The Coinbase statement binds these 32 bytes big-endian. 0x + exactly 64 hex, below the BN254 field modulus p; never reduced. Computed by the SDK OPRF step (@zkproofport-ai/sdk generateProof / the MCP prepare step), which asks the OPRF network for this wallet in (domain, scope) and verifies its answer.' },
                      nullifier: { type: 'string', description: 'Public. One value per wallet per (domain, scope) under the pinned key; nobody without the OPRF key can compute it from an address. 0x + exactly 64 hex, below the BN254 field modulus p; never reduced. Computed by the SDK OPRF step (@zkproofport-ai/sdk generateProof / the MCP prepare step), which asks the OPRF network for this wallet in (domain, scope) and verifies its answer.' },
                      oprf_public_key_x: { type: 'string', description: 'Private. OPRF network public key, x. 0x + exactly 64 hex, below the BN254 field modulus p; never reduced. Computed by the SDK OPRF step (@zkproofport-ai/sdk generateProof / the MCP prepare step), which asks the OPRF network for this wallet in (domain, scope) and verifies its answer.' },
                      oprf_public_key_y: { type: 'string', description: 'Private. OPRF network public key, y. 0x + exactly 64 hex, below the BN254 field modulus p; never reduced. Computed by the SDK OPRF step (@zkproofport-ai/sdk generateProof / the MCP prepare step), which asks the OPRF network for this wallet in (domain, scope) and verifies its answer.' },
                      oprf_beta: { type: 'string', description: 'Private. The blinding factor the SDK drew from a secure random source: 0x + 64 hex, non-zero, below the BabyJubJub subgroup order r.' },
                      oprf_dlog_e: { type: 'string', description: 'Private. Challenge of the OPRF network\'s DLog-equality proof. 0x + exactly 64 hex, below the BN254 field modulus p; never reduced. Computed by the SDK OPRF step (@zkproofport-ai/sdk generateProof / the MCP prepare step), which asks the OPRF network for this wallet in (domain, scope) and verifies its answer.' },
                      oprf_dlog_s: { type: 'string', description: 'Private. Response of the OPRF network\'s DLog-equality proof: 0x + 64 hex, below the subgroup order r.' },
                      oprf_response_x: { type: 'string', description: 'Private. The unblinded OPRF answer, x. 0x + exactly 64 hex, below the BN254 field modulus p; never reduced. Computed by the SDK OPRF step (@zkproofport-ai/sdk generateProof / the MCP prepare step), which asks the OPRF network for this wallet in (domain, scope) and verifies its answer.' },
                      oprf_response_y: { type: 'string', description: 'Private. The unblinded OPRF answer, y. 0x + exactly 64 hex, below the BN254 field modulus p; never reduced. Computed by the SDK OPRF step (@zkproofport-ai/sdk generateProof / the MCP prepare step), which asks the OPRF network for this wallet in (domain, scope) and verifies its answer.' },
                      merkle_root: { type: 'string', description: '0x-prefixed 32-byte Merkle root' },
                      user_address: { type: 'string', description: '0x-prefixed 20-byte wallet address' },
                      signature: { type: 'string', description: 'Wallet signature over signal_hash' },
                      user_pubkey_x: { type: 'string', description: 'User public key X coordinate' },
                      user_pubkey_y: { type: 'string', description: 'User public key Y coordinate' },
                      raw_transaction: { type: 'string', description: 'Raw attestation transaction data' },
                      tx_length: { type: 'number', description: 'Transaction data length' },
                      coinbase_attester_pubkey_x: { type: 'string', description: 'Coinbase attester public key X' },
                      coinbase_attester_pubkey_y: { type: 'string', description: 'Coinbase attester public key Y' },
                      merkle_proof: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'Merkle proof path',
                      },
                      leaf_index: { type: 'number', description: 'Leaf index in Merkle tree' },
                      depth: { type: 'number', description: 'Merkle tree depth' },
                      country_list: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'Country codes (for country circuit only)',
                      },
                      is_included: {
                        type: 'boolean',
                        description: 'Inclusion/exclusion flag (for country circuit only)',
                      },
                      min_score: {
                        type: 'number',
                        description: 'human_passport only: the Human Passport score threshold in points (e.g. 20; above 0, at most four decimals). For human_passport send only signal_hash, the eleven OPRF values (oprf_key_hash, domain, scope, nullifier, oprf_*), user_address, signature, user_pubkey_x, user_pubkey_y, min_score, chain (and optionally domain_separator + action_hash); the server finds the wallet\'s score on that chain itself. See GET /api/v1/guide/human_passport.',
                      },
                      chain: {
                        type: 'number',
                        description: 'human_passport only, required: the chain id the Human Passport score is recorded on (8453 Base, 10 OP Mainnet, 42161 Arbitrum One, 59144 Linea, 534352 Scroll, 324 zkSync Era). An unknown or missing chain is INVALID_REQUEST.',
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
            description: 'Proof generated successfully',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    proof: { type: 'string', description: 'ZK proof bytes (0x-prefixed hex)' },
                    publicInputs: {
                      type: 'array',
                      items: { type: 'string' },
                      description: 'Public inputs as bytes32 hex strings',
                    },
                    proofWithInputs: { type: 'string', description: 'Combined proof + public inputs (0x-prefixed hex)' },
                    attestation: {
                      type: 'object',
                      nullable: true,
                      description: 'TEE attestation (null if TEE disabled)',
                      properties: {
                        document: { type: 'string', description: 'COSE_Sign1 attestation document (base64)' },
                        proof_hash: { type: 'string', description: 'Hash of proof included in attestation' },
                        verification: {
                          type: 'object',
                          properties: {
                            rootCaValid: { type: 'boolean' },
                            chainValid: { type: 'boolean' },
                            certificateValid: { type: 'boolean' },
                            signatureValid: { type: 'boolean' },
                          },
                        },
                      },
                    },
                    timing: {
                      type: 'object',
                      description: 'Performance timing breakdown',
                      properties: {
                        totalMs: { type: 'number' },
                        paymentVerifyMs: { type: 'number' },
                        inputBuildMs: { type: 'number' },
                        proveMs: { type: 'number' },
                      },
                    },
                  },
                },
              },
            },
          },
          '402': { description: 'Payment invalid (transaction not found, wrong amount, or wrong recipient)' },
          '404': { description: 'Session not found or expired' },
        },
      },
    },
    '/api/v1/oprf': {
      get: {
        operationId: 'getOprfEnvironment',
        summary: 'Which OPRF environment wallet credential proofs use here',
        description:
          'Wallet credential proofs (coinbase_kyc, coinbase_country, giwa_attestation, human_passport) carry a nullifier from an OPRF network: ' +
          'one per wallet per (domain, scope), which nobody can compute from an address. The client SDK reads this endpoint to choose that ' +
          'network and the key hash pinned for the environment from its OWN table, so a caller configures nothing; an agent using the SDK or ' +
          'the MCP tools never calls it directly. No payment, no authentication. `production` has no OPRF key registered yet, and the SDK and ' +
          'this server refuse wallet credential proofs there by name; OIDC proofs are unaffected.',
        tags: ['Proof Generation'],
        responses: {
          '200': {
            description: 'The OPRF environment of this deployment',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['environment'],
                  properties: {
                    environment: {
                      type: 'string',
                      enum: ['production', 'staging', 'local'],
                      description: 'Selects the OPRF network and the pinned oprf_key_hash in the SDK. Every wallet credential prove request must carry that key hash.',
                    },
                  },
                },
              },
            },
          },
          '503': {
            description: 'OPRF_NOT_CONFIGURED: this deployment does not prove wallet credentials (OPRF_ENVIRONMENT unset).',
            content: { 'application/json': { schema: { type: 'object', properties: { error: { type: 'string' }, message: { type: 'string' } } } } },
          },
        },
      },
    },
    '/api/v1/guide/{circuit}': {
      get: {
        summary: 'Get circuit proof generation guide',
        description: 'Returns comprehensive step-by-step instructions for client AI agents to prepare all proof inputs. Includes code examples, constants, formulas, and EAS query templates.',
        tags: ['Guide'],
        parameters: [{
          name: 'circuit',
          in: 'path',
          required: true,
          schema: { type: 'string', enum: ['coinbase_kyc', 'coinbase_country', 'oidc_domain', 'giwa_attestation', 'human_passport'] },
          description: 'Circuit alias name',
        }],
        responses: {
          '200': {
            description: 'Circuit guide with complete flow instructions',
            content: { 'application/json': { schema: { type: 'object' } } },
          },
          '404': {
            description: 'Unknown circuit',
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
        'Model Context Protocol endpoints. Tools: get_supported_circuits, get_guide, prove',
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
      name: 'Proof Generation',
      description: 'x402 single-step proof API: POST /prove with circuit + inputs → 402 with nonce → pay USDC → retry with X-Payment-TX and X-Payment-Nonce headers.',
    },
    {
      name: 'Guide',
      description: 'Circuit-specific step-by-step guides for preparing proof inputs',
    },
  ],
  components: {
    schemas: {
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
