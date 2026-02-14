# proofport-ai

Agent-native ZK proof infrastructure for ZKProofport. A self-contained microservice that generates and verifies zero-knowledge proofs using the Model Context Protocol (MCP) and Agent-to-Agent (A2A) communication protocols.

## Architecture Overview

proofport-ai is a **standalone service** that runs independently from the main proofport infrastructure. It provides:

- **MCP Server** — Standardized proof generation/verification tools via Model Context Protocol
- **A2A Protocol** — Agent-to-agent communication with Agent Card, JSON-RPC, and Server-Sent Events
- **Rust Prover Microservice** — High-performance proof generation using noir_rs (wrapped in Mutex for thread safety)
- **Payment Integration** — x402 payment middleware for proof generation requests
- **Signing Delegation** — Three progressive phases (Privy → Web → EIP-7702) for KYC wallet signatures
- **TEE Integration** — Optional AWS Nitro Enclave support for hardware-backed attestation
- **Agent Identity** — ERC-8004 registration and reputation management

## Directory Structure

```
proofport-ai/
├── src/                              # Node.js MCP/A2A server (TypeScript)
│   ├── index.ts                      # Express server entry (port 4002)
│   ├── mcp/
│   │   ├── server.ts                 # MCP protocol handler
│   │   ├── tools/
│   │   │   ├── generateProof.ts       # generate_proof tool
│   │   │   ├── verifyProof.ts         # verify_proof tool
│   │   │   └── getCircuits.ts         # get_supported_circuits tool
│   │   └── types.ts
│   ├── a2a/
│   │   ├── agentCard.ts              # /.well-known/agent.json endpoint
│   │   ├── taskHandler.ts            # POST /a2a request handler
│   │   ├── taskStore.ts              # Redis task persistence
│   │   ├── taskWorker.ts             # Background task execution worker
│   │   └── streaming.ts              # Server-Sent Events (SSE) streaming
│   ├── prover/
│   │   ├── proverClient.ts           # HTTP client to Rust prover
│   │   ├── bbProver.ts               # bb CLI direct prover (no Rust service)
│   │   ├── tomlBuilder.ts            # Prover.toml builder for bb
│   │   └── verifier.ts               # On-chain verification via ethers v6
│   ├── input/
│   │   ├── inputBuilder.ts           # Full circuit input construction
│   │   ├── attestationFetcher.ts     # EAS GraphQL attestation fetcher
│   │   └── merkleTree.ts             # Merkle tree builder
│   ├── payment/
│   │   ├── x402Middleware.ts         # @x402/express integration
│   │   ├── facilitator.ts            # Payment recording and tracking
│   │   ├── settlementWorker.ts       # On-chain USDC settlement worker
│   │   └── freeTier.ts               # Free tier / payment mode config
│   ├── signing/
│   │   ├── privySigning.ts           # Phase 1: Privy Delegated Actions
│   │   ├── webSigning.ts             # Phase 2: sign.zkproofport.app callback
│   │   └── eip7702Signing.ts         # Phase 3: EIP-7702 session keys
│   ├── tee/
│   │   ├── index.ts                  # TEE mode configuration
│   │   ├── enclaveClient.ts          # AWS Nitro Enclave wrapper
│   │   ├── enclaveBuilder.ts         # Enclave image builder
│   │   ├── attestation.ts            # TEE attestation validation
│   │   ├── encryption.ts             # TEE encryption utilities
│   │   └── types.ts                  # TEE type definitions
│   ├── identity/
│   │   ├── index.ts                  # Identity module entry
│   │   ├── register.ts               # ERC-8004 identity registration
│   │   ├── autoRegister.ts           # Automatic agent registration at startup
│   │   ├── reputation.ts             # Reputation management + proof completion handler
│   │   └── types.ts                  # Identity type definitions
│   ├── redis/
│   │   ├── client.ts                 # Redis client creation
│   │   ├── rateLimiter.ts            # Request rate limiting
│   │   └── proofCache.ts             # Proof result caching
│   ├── config/
│   │   ├── index.ts                  # Environment configuration
│   │   ├── circuits.ts               # Circuit metadata + file paths
│   │   └── contracts.ts              # Deployed contract addresses
│   ├── circuit/
│   │   └── artifactManager.ts        # Circuit artifact download/cache
│   ├── swagger.ts                    # OpenAPI specification
│   └── types/
│       └── index.ts                  # Shared type definitions
├── prover/                           # Rust prover microservice
│   ├── src/
│   │   ├── main.rs                   # axum HTTP server entry (port 4003)
│   │   ├── prover.rs                 # noir_rs wrapper with Mutex serialization
│   │   └── types.rs                  # Request/response types
│   ├── Cargo.toml
│   └── Dockerfile
├── sign-page/                        # Static Next.js signing page (deployed separately)
│   ├── src/app/page.tsx              # WalletConnect signing UI
│   └── vercel.json
├── tests/
│   ├── mcp.test.ts                   # MCP protocol tests
│   ├── prover.test.ts                # Rust prover integration tests
│   └── integration.test.ts           # End-to-end flow tests
├── circuits/                         # Compiled circuit artifacts (symlinked from parent)
│   ├── coinbase-attestation/
│   │   └── target/
│   │       ├── coinbase_attestation.json
│   │       └── vk
│   └── coinbase-country-attestation/
│       └── target/
│           ├── coinbase_country_attestation.json
│           └── vk
├── docker-compose.yml                # Self-contained stack (prover + server + redis)
├── Dockerfile                        # Node.js server image
├── package.json
├── tsconfig.json
└── README.md
```

## Quick Start

### npm Installation (Development)

```bash
cd proofport-ai

# Install dependencies
npm install

# Development (hot reload with tsx)
npm run dev

# Build TypeScript
npm run build

# Production
npm start

# Type check
npm run typecheck

# Run tests
npm test
npm run test:watch
```

### Docker Compose (Self-Contained Stack)

proofport-ai runs completely independently with its own Redis, Prover, and Server.

```bash
cd proofport-ai

# Start all services (redis + prover + server)
docker compose up --build

# Stop
docker compose down

# View logs
docker compose logs -f server
docker compose logs -f prover
docker compose logs redis

# Reset data
docker compose down -v
```

**Key points:**
- Port 4002: Node.js MCP/A2A server
- Port 4003: Rust prover microservice (internal only)
- Port 6379: Redis (host port 6380 to avoid conflict)
- Completely isolated from parent `docker-compose.yml`
- No connections to proofport-api, relay, or shared infrastructure

## MCP Server

### MCP Tools

| Tool | Purpose | Inputs | Outputs |
|------|---------|--------|---------|
| `generate_proof` | Generate zero-knowledge proof for KYC attestation | `address` (20 bytes), `signature` (64 bytes), `scope` (string), `circuitId` (string) | `proof`, `publicInputs`, `nullifier` |
| `verify_proof` | Verify proof on-chain via verifier contract | `proof` (bytes), `publicInputs` (bytes array), `circuitId` (string), `chainId` (number) | `isValid` (boolean), `verifierAddress` (address) |
| `get_supported_circuits` | List all available circuits with metadata | None | `circuits` array with ID, name, description, inputCount |

### Input Builder

The `generate_proof` MCP tool accepts only 4 simplified inputs. The server performs all complex input construction:

1. **Fetch Attestation** — Query EAS GraphQL on Base chain for attestation data
2. **Extract Data** — Get UID, recipient, attester, timestamp, expirationTime
3. **Signature Recovery** — Perform ecrecover to derive signer address
4. **Build Tree** — Construct Merkle tree from attestation fields
5. **Compute Nullifier** — `keccak256(keccak256(address + signalHash) + scope)`
6. **Format Inputs** — Convert to decimal string format for Rust prover
7. **Generate Proof** — Send to prover microservice via HTTP

### MCP Endpoint

**Development:**
```bash
# HTTP POST (stateless mode)
curl -X POST http://localhost:4002/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/list","id":1}'
```

**Production:**
```
POST https://ai.zkproofport.app/mcp
```

## A2A Protocol

### Agent Card

**Endpoint:** `GET /.well-known/agent.json`

Publicly accessible agent identity document. Used by other agents to discover capabilities and endpoints.

```json
{
  "name": "ZKProofport Prover Agent",
  "description": "Generate and verify zero-knowledge proofs for KYC attestations",
  "version": "1.0.0",
  "capabilities": {
    "mcp": true,
    "a2a": true,
    "payment": ["x402"]
  },
  "identity": {
    "erc8004": "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
    "chainId": 8453
  },
  "endpoints": {
    "jsonrpc": "https://ai.zkproofport.app/rpc",
    "sse": "https://ai.zkproofport.app/events",
    "mcp": "https://ai.zkproofport.app/mcp"
  }
}
```

### JSON-RPC Methods

| Method | Purpose | Status |
|--------|---------|--------|
| `tasks/send` | Submit proof generation task | Queued in Redis, processed by TaskWorker |
| `tasks/get` | Query task status (submitted, working, completed, failed) | Retrieved from Redis |
| `tasks/cancel` | Cancel a submitted or working task | Updates status to canceled |

### Server-Sent Events (SSE) Streaming

Real-time proof generation progress updates:

```
GET /a2a/stream/:taskId

Events:
- task.created (task received and queued)
- proof.generating (proof generation started)
- proof.completed (proof generated, includes result)
- proof.failed (error occurred)
```

## REST Endpoints

| Endpoint | Method | Auth | Purpose |
|----------|--------|------|---------|
| `/health` | GET | None | Health check + payment mode info |
| `/payment/status` | GET | None | Current payment mode configuration |
| `/signing/status` | GET | None | Enabled signing providers |
| `/tee/status` | GET | None | TEE mode and attestation config |
| `/identity/status` | GET | None | ERC-8004 identity contracts |
| `/.well-known/agent.json` | GET | None | Agent Card (public capability discovery) |
| `/a2a` | POST | x402 | Submit A2A task (payment-gated) |
| `/a2a/stream/:taskId` | GET | None | SSE stream for task updates |
| `/api/signing/callback/:requestId` | POST | None | Receive signature from web signing page |
| `/api/signing/batch` | POST | None | Batch signing callback (EIP-7702) |
| `/api/v1/chat` | POST | None | LLM chat interface (Gemini-powered) |
| `/mcp` | POST | x402 | MCP tool endpoint (payment-gated) |
| `/docs` | GET | None | Swagger UI documentation |
| `/openapi.json` | GET | None | OpenAPI spec (JSON) |

## Chat Endpoint (Natural Language Interface)

proofport-ai provides an LLM-powered chat interface for natural language interaction with proof generation and verification. This is useful for Telegram bots, web chat interfaces, or any conversational AI application.

### Configuration

```bash
GEMINI_API_KEY=your-gemini-api-key  # Optional — if not set, chat endpoint returns 503
```

**Free Tier:** Gemini 2.0 Flash provides 15 RPM, 1500 RPD, 1M TPM with no cost.

### Endpoint

**POST `/api/v1/chat`**

**Request:**
```json
{
  "message": "I need a Coinbase KYC proof for myapp.com",
  "sessionId": "uuid-session-id"  // Optional — auto-generated if omitted
}
```

**Response:**
```json
{
  "response": "I'll help you generate a Coinbase KYC proof. Since you haven't provided your wallet signature yet, I've created a signing request. Please open this URL in your browser to connect your wallet and sign...",
  "sessionId": "uuid-session-id",
  "skillResult": {
    "status": "awaiting_signature",
    "signingUrl": "https://sign.zkproofport.app/s/abc123",
    "requestId": "abc123",
    "message": "..."
  },
  "signingUrl": "https://sign.zkproofport.app/s/abc123"
}
```

### How It Works

1. **User sends natural language message** — "I want a KYC proof for my app"
2. **Gemini extracts intent** — Identifies `generate_proof` skill with `circuitId` and `scope`
3. **Function calling loop** — Gemini calls the skill via function calling, waits for result
4. **Task execution** — Chat handler creates A2A task, waits for completion (same worker as A2A endpoint)
5. **Natural language response** — Gemini formats the result in conversational text

### Session Management

- **Session TTL:** 1 hour in Redis
- **History limit:** Last 20 messages kept
- **Session ID:** Auto-generated UUID if not provided, returned in response
- **Conversation context:** Full conversation history passed to Gemini for context-aware responses

### Function Calling

The chat endpoint uses Gemini's function calling feature to execute skills:

- **generate_proof** — Generate ZK proof (creates web signing request if no signature)
- **verify_proof** — Verify proof on-chain
- **get_supported_circuits** — List available circuits

### Example Conversations

**Simple proof generation:**
```
User: "Generate a Coinbase KYC proof for example.com"
Agent: "I'll create a signing request. Please open [URL] to sign with your wallet."
```

**Verification:**
```
User: "Verify this proof: 0x... with public inputs: [...]"
Agent: "I've verified the proof on-chain. The proof is valid and was verified by contract 0x..."
```

**Discovery:**
```
User: "What proofs can you generate?"
Agent: "I can generate two types of zero-knowledge proofs:
1. Coinbase KYC — Prove you passed Coinbase KYC without revealing identity
2. Coinbase Country — Prove your country of residence matches Coinbase attestation"
```

### Rate Limiting

The chat endpoint has no function call limit per request (max 3 function calls to prevent infinite loops). Session-based rate limiting can be added via Redis if needed.

## Payment Integration (x402)

### Payment Modes

Set `PAYMENT_MODE` to one of:

| Mode | Network | Effect | Use Case |
|------|---------|--------|----------|
| `disabled` | None | All requests free, no payment validation | Development / free tier |
| `testnet` | Base Sepolia | Require x402 USDC payment receipt | Testing on testnet |
| `mainnet` | Base Mainnet | Require x402 USDC payment receipt | Production |

### How x402 Works

1. **Request** — Agent sends `X-402-Payment` header with payment receipt
2. **Validation** — `@x402/express` middleware validates USDC receipt via Coinbase CDP
3. **Gating** — If valid, proof generation proceeds. If invalid, returns 402 Payment Required
4. **Recording** — `PaymentFacilitator` records payment as pending in Redis
5. **Settlement** — `SettlementWorker` polls pending payments, executes on-chain USDC transfer to operator address
6. **Refund** — If proof generation fails, payment is refunded via PaymentFacilitator

### Configuration

```bash
# When PAYMENT_MODE != disabled:
PAYMENT_PAY_TO=0x...                    # Operator wallet address (receives USDC)
PAYMENT_FACILITATOR_URL=https://www.x402.org/facilitator  # x402 facilitator
PAYMENT_PROOF_PRICE=$0.10               # Price per proof (in USD)
```

## Signing Delegation

Three progressive phases for obtaining KYC wallet signatures:

### Phase 1: Privy Delegated Actions (Automatic)

**When:** User has Privy embedded wallet
**Flow:** No user interaction — server calls Privy API to sign
**UX:** Fully automatic

```bash
PRIVY_APP_ID=your-app-id
PRIVY_API_SECRET=your-api-secret
```

### Phase 2: Web Signing Page (3 Clicks)

**When:** User has external wallet (MetaMask, Ledger, etc.)
**Flow:** Redirect to `sign.zkproofport.app`, sign with WalletConnect, callback to server
**UX:** Seamless redirect + callback

```bash
SIGN_PAGE_URL=https://sign.zkproofport.app  # Or http://localhost:3200 for dev
SIGNING_TTL_SECONDS=300                     # Signature request timeout
```

### Phase 3: EIP-7702 Session Keys (Advanced)

**When:** User enables session key delegation
**Flow:** Pre-signed batch of proof requests via EIP-7702 delegation
**UX:** Session setup once, unlimited proofs

Set `EIP7702_SESSION_ENABLED=true` to enable batch signing.

## TEE Integration (AWS Nitro Enclave)

### Modes

| Mode | Behavior | Use Case |
|------|----------|----------|
| `disabled` | Standard Linux containers | Development |
| `local` | Simulated TEE (localhost) | Local testing |
| `nitro` | AWS Nitro Enclave (hardware-backed) | Production security |

### Configuration

```bash
TEE_MODE=disabled              # disabled | local | nitro
ENCLAVE_CID=16                 # Nitro Enclave CID (when TEE_MODE=nitro)
ENCLAVE_PORT=5000              # Enclave port
TEE_ATTESTATION=true           # Enable attestation verification
```

### Attestation Validation

When TEE_MODE is enabled, the enclave generates attestation documents:

- **PCR0** — Enclave image hash (tamper detection)
- **PCR1** — Kernel hash (integrity check)
- **PCR2** — Application hash (code verification)

Server validates attestation before accepting proof results.

## ERC-8004 Agent Identity

### Registration

Register agent on-chain via ERC-8004 Identity contract:

```bash
ERC8004_IDENTITY_ADDRESS=0x8004A169FB4a3325136EB29fA0ceB6D2e539a432
ERC8004_REPUTATION_ADDRESS=0x8004BAa17C55a88189AE136b182e5fdA19dE9b63
```

### Reputation Updates

After successful proof generation, agent's reputation score increments:

```
contract.incrementScore(agentAddress, proofType)
```

## Rust Prover Microservice

### HTTP Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/health` | GET | Health check |
| `/prove` | POST | Generate proof from circuit inputs |
| `/verify` | POST | Verify proof locally |
| `/circuits` | GET | List loaded circuits |

### Request/Response Format

**POST /prove:**
```json
{
  "circuitId": "coinbase_attestation",
  "inputs": ["149", "2", "100", ...]
}
```

**Response:**
```json
{
  "proof": "0x...",
  "publicInputs": ["0x..."],
  "verificationKey": "0x..."
}
```

### Build Commands

```bash
cd proofport-ai/prover

# Development
cargo build
cargo run

# Production
cargo build --release

# Tests
cargo test --all

# Docker
docker build -t proofport-ai-prover .
docker run -p 4003:4003 proofport-ai-prover
```

## Supported Circuits

### Coinbase KYC (`coinbase_attestation`)

Proves holder has passed Coinbase KYC verification.

- **Input Count:** 12 field elements
- **Public Inputs:** address, scope
- **Nullifier:** Yes (privacy, replay prevention)

### Coinbase Country (`coinbase_country_attestation`)

Proves holder's KYC country matches attestation.

- **Input Count:** 13 field elements
- **Public Inputs:** address, country, scope
- **Nullifier:** Yes (privacy, replay prevention)

## Contract Addresses

### Base Sepolia (Testnet)

| Contract | Address |
|----------|---------|
| KYC Verifier | `0x0036B61dBFaB8f3CfEEF77dD5D45F7EFBFE2035c` |
| Country Verifier | `0xdEe363585926c3c28327Efd1eDd01cf4559738cf` |
| ERC-8004 Identity | `0x8004A818BFB912233c491871b3d84c89A494BD9e` |
| ERC-8004 Reputation | `0x8004B663056A597Dffe9eCcC1965A193B7388713` |

### Base Mainnet (Production)

| Contract | Address |
|----------|---------|
| KYC Verifier | (from broadcast JSON) |
| Country Verifier | (from broadcast JSON) |
| ERC-8004 Identity | `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` |
| ERC-8004 Reputation | `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63` |

## Environment Variables

### Server Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PORT` | No | `4002` | Express server port |
| `NODE_ENV` | No | `development` | Node environment (development, production) |
| `PROVER_URL` | No | (empty) | Rust prover microservice URL (optional, bb CLI used if not set) |
| `BB_PATH` | No | `bb` | Barretenberg CLI path |
| `NARGO_PATH` | No | `nargo` | Nargo CLI path |
| `CIRCUITS_DIR` | No | `/app/circuits` | Circuit artifacts directory |
| `CIRCUITS_REPO_URL` | No | `https://raw.githubusercontent.com/zkproofport/circuits/main` | Circuit artifacts download URL |
| `REDIS_URL` | Yes | — | Redis connection string |

### Blockchain Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `BASE_RPC_URL` | Yes | — | Base chain RPC endpoint (mainnet or testnet) |
| `CHAIN_RPC_URL` | Yes | — | RPC for proof verification (can differ from BASE_RPC_URL) |
| `EAS_GRAPHQL_ENDPOINT` | Yes | — | EAS GraphQL endpoint for attestation queries |
| `NULLIFIER_REGISTRY_ADDRESS` | Yes | — | ZKProofportNullifierRegistry contract address |

### Agent Identity

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PROVER_PRIVATE_KEY` | Yes | — | Agent's wallet private key (64 hex chars, no 0x prefix) |
| `ERC8004_IDENTITY_ADDRESS` | No | — | ERC-8004 Identity contract address |
| `ERC8004_REPUTATION_ADDRESS` | No | — | ERC-8004 Reputation contract address |

### A2A Protocol

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `A2A_BASE_URL` | Yes | — | Public-facing service URL (for Agent Card) |
| `AGENT_VERSION` | No | `1.0.0` | Agent version string |

### Payment Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PAYMENT_MODE` | Yes | — | Payment mode (disabled, testnet, mainnet) |
| `PAYMENT_PAY_TO` | Conditional | (empty) | Operator wallet (required when PAYMENT_MODE != disabled) |
| `PAYMENT_FACILITATOR_URL` | No | `https://www.x402.org/facilitator` | x402 facilitator URL |
| `PAYMENT_PROOF_PRICE` | No | `$0.10` | Price per proof (in USD) |

### Settlement Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SETTLEMENT_CHAIN_RPC_URL` | Conditional | — | RPC for settlement transactions (required when PAYMENT_MODE != disabled) |
| `SETTLEMENT_PRIVATE_KEY` | Conditional | — | Wallet key for settlement transfers |
| `SETTLEMENT_OPERATOR_ADDRESS` | Conditional | — | Operator address receiving USDC settlements |
| `SETTLEMENT_USDC_ADDRESS` | No | (auto-detected) | USDC contract address (auto-detects from network) |

### Signing Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PRIVY_APP_ID` | Conditional | — | Privy App ID (for Phase 1 Privy signing) |
| `PRIVY_API_SECRET` | Conditional | — | Privy API Secret (for Phase 1) |
| `PRIVY_API_URL` | No | `https://auth.privy.io` | Privy API endpoint |
| `SIGN_PAGE_URL` | Conditional | — | Web signing page URL (for Phase 2) |
| `SIGNING_TTL_SECONDS` | No | `300` | Signature request timeout (5 minutes) |

### TEE Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `TEE_MODE` | No | `disabled` | TEE mode (disabled, local, nitro) |
| `ENCLAVE_CID` | Conditional | — | Nitro Enclave CID (required when TEE_MODE=nitro) |
| `ENCLAVE_PORT` | No | `5000` | Nitro Enclave port |
| `TEE_ATTESTATION` | No | `false` | Enable attestation verification |

### Chat / LLM Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `GEMINI_API_KEY` | No | (empty) | Gemini API key for chat endpoint (if not set, chat returns 503) |

## Docker Compose Services

### Services

**redis** — Redis 7 Alpine
- Container: `proofport-ai-redis`
- Port: 6380 (host) → 6379 (container)
- Data: `/data` volume
- Health check: redis-cli ping

**server** — Node.js MCP/A2A server
- Container: `proofport-ai`
- Port: 4002
- Depends on: redis (healthy)
- Health check: wget http://0.0.0.0:4002/health
- Restart: unless-stopped

**prover** — Rust proof generation service
- Port: 4003 (internal only)
- Depends on: server (loads circuits)

### Environment Setup

Create `.env.development` with all required variables:

```bash
# Copy .env.example
cp .env.example .env.development

# Edit with your values
vim .env.development

# Verify config
docker compose config
```

## Testing

### Run Tests

```bash
# Run all tests once
npm test

# Watch mode
npm run test:watch
```

### Test Structure

**Framework:** Vitest 3.x | **All passing**

```
tests/
├── a2a/
│   ├── agentCard.test.ts              # Agent Card endpoint tests
│   ├── integration.test.ts            # A2A end-to-end flows
│   ├── streaming.test.ts              # SSE streaming tests
│   ├── taskHandler.test.ts            # JSON-RPC task handler tests
│   └── taskWorker.test.ts             # Background task worker tests
├── identity/
│   ├── autoRegister.test.ts           # Auto-registration at startup tests
│   ├── identity-integration.test.ts   # ERC-8004 integration tests
│   ├── register.test.ts               # Identity registration tests
│   ├── reputation-unit.test.ts        # Reputation unit tests
│   └── types.test.ts                  # Identity type validation tests
├── payment/
│   ├── facilitator.test.ts            # Payment recording/tracking tests
│   ├── freeTier.test.ts               # Free tier config tests
│   ├── integration.test.ts            # Payment integration tests
│   ├── settlementWorker.test.ts       # On-chain USDC settlement tests
│   └── x402Middleware.test.ts         # x402 middleware tests
├── signing/
│   ├── eip7702Signing.test.ts         # EIP-7702 session key tests
│   ├── integration.test.ts            # Signing integration tests
│   ├── privySigning.test.ts           # Privy delegated action tests
│   ├── types.test.ts                  # Signing type tests
│   └── webSigning.test.ts             # Web signing callback tests
├── tee/
│   ├── attestation.test.ts            # TEE attestation tests
│   ├── enclaveBuilder.test.ts         # Enclave image builder tests
│   ├── enclaveClient.test.ts          # Enclave client tests
│   ├── encryption.test.ts             # TEE encryption tests
│   ├── integration.test.ts            # TEE integration tests
│   ├── tee-http.test.ts               # TEE HTTP endpoint tests
│   ├── tee-integration.test.ts        # Full TEE flow tests
│   └── types.test.ts                  # TEE type tests
├── artifactManager.test.ts            # Circuit artifact download tests
├── bbProver.test.ts                   # bb CLI prover tests
├── circuits.test.ts                   # Circuit config tests
├── config.test.ts                     # Configuration validation tests
├── contracts.test.ts                  # Contract address tests
├── inputBuilder.test.ts               # Input construction tests
├── mcp.test.ts                        # MCP protocol tests
├── proverClient.test.ts               # Rust prover client tests
├── redis.test.ts                      # Redis cache/rate limiting tests
├── tomlBuilder.test.ts                # TOML builder tests
├── types.test.ts                      # Type definition tests
└── verifier.test.ts                   # On-chain verification tests
```

### Test Infrastructure

- Framework: Vitest 3.x
- HTTP Mocking: supertest
- Redis: Mocked via ioredis test mode
- Prover: Mocked HTTP responses and bb CLI

## Version Locks

Critical version pins for reproducible builds:

| Tool | Version | Purpose |
|------|---------|---------|
| **noir_rs** | `v1.0.0-beta.8-3` (branch) | Rust Noir prover with Barretenberg FFI |
| **ethers** | `^6.13.0` | Ethereum interaction (NOT v5) |
| **@modelcontextprotocol/sdk** | `^1.0.0` | MCP protocol implementation |
| **@x402/express** | `^2.3.0` | x402 payment middleware |
| **Node.js** | 20 LTS | Server runtime |
| **Rust** | 2021 edition | Prover compilation |

**CRITICAL:** Do NOT upgrade noir_rs or @modelcontextprotocol/sdk without explicit coordination. These have tight integration requirements.

## Implementation Status

### Completed

- MCP server with 3 tools (generate_proof, verify_proof, get_supported_circuits)
- A2A protocol with Agent Card, JSON-RPC, and SSE streaming
- A2A Task Worker — Background task execution with Redis queue polling
- bb CLI prover — Direct proof generation without Rust microservice dependency
- Redis integration (proof cache, rate limiting, task store, task queue)
- x402 payment middleware integration with PaymentFacilitator
- Payment Settlement Worker — On-chain USDC transfer with retry logic
- Signing delegation: Privy (Phase 1), Web signing page (Phase 2), EIP-7702 (Phase 3)
- Web signing page (sign-page/) — Next.js 15 + RainbowKit + WalletConnect
- TEE integration with COSE/CBOR attestation validation (cbor-x)
- ERC-8004 identity auto-registration at startup
- ERC-8004 reputation updates after successful proof generation
- Docker Compose self-contained stack
- OpenAPI/Swagger documentation
- Comprehensive test suite (543+ tests)

### Requires Credentials

- Privy Delegated Actions (Phase 1) — Requires `PRIVY_APP_ID` and `PRIVY_API_SECRET`
- AWS Nitro Enclave (TEE_MODE=nitro) — Requires AWS Nitro hardware

### Future

- Multi-circuit composition
- Advanced payment analytics and settlement reports
- Agent reputation dashboard
- Rate limiting per agent (not just per IP)

## Troubleshooting

### "Circuit artifacts not found"

Circuit files are downloaded on startup from the circuits repository. Ensure:
- `CIRCUITS_DIR` is writable
- Network access to circuits CDN
- Sufficient disk space (circuits are ~100MB)

### "Prover service timeout"

Prover is slow for first proof (SRS initialization). Subsequent proofs are faster.

```bash
# Check prover health
curl http://localhost:4003/health

# View prover logs
docker compose logs -f prover
```

### "Payment validation failed"

Verify payment configuration:

```bash
# Check payment status
curl http://localhost:4002/payment/status

# Ensure PAYMENT_MODE matches environment
# Dev: disabled
# Staging: testnet
# Prod: mainnet
```

### "Redis connection refused"

Redis must be running before server starts:

```bash
# Check Redis status
docker compose ps redis

# Restart Redis
docker compose restart redis
```

## Development

### Local Development Workflow

```bash
# 1. Install dependencies
npm install

# 2. Start Docker services (redis + prover)
docker compose up redis prover -d

# 3. Run dev server (hot reload)
npm run dev

# 4. Test MCP endpoint in another terminal
curl -X POST http://localhost:4002/mcp \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "method": "tools/list",
    "id": 1
  }'
```

### Code Organization

- `src/mcp/` — Model Context Protocol implementation
- `src/a2a/` — Agent-to-Agent communication
- `src/prover/` — Proof generation orchestration
- `src/payment/` — x402 payment integration
- `src/signing/` — KYC wallet signing (3 phases)
- `src/tee/` — TEE integration and attestation
- `src/identity/` — ERC-8004 registration
- `src/redis/` — Cache, rate limiting, task store

## Contributing

### Before Committing

1. Run tests: `npm test`
2. Type check: `npm run typecheck`
3. Update README if changing:
   - MCP tool signatures
   - REST endpoints
   - Environment variables
   - Docker configuration
   - Contract addresses

### Commit Message Format

All commits MUST use Conventional Commits:

```
feat: add X-Ray payment receipt validation
fix: prevent duplicate nullifier registration
refactor: extract input builder logic
docs: update MCP tool examples
chore: update noir_rs version to v1.0.0-beta.8-4
```

## License

Apache 2.0