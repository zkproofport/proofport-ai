# proofport-ai

Agent-native ZK proof infrastructure for ZKProofport, with a TEE-based proving architecture, SDK and local MCP package. Supported Nitro deployments encrypt inputs to the enclave; encryption and hardware-attestation guarantees depend on the selected endpoint and actual returned evidence. Arc exact-action authorization remains **EXPERIMENTAL on Arc Testnet (5042002)**.

## Architecture

The following diagram describes the Nitro deployment. Endpoints without an attested enclave key receive readable inputs over HTTPS; the current Arc staging demo uses that mode and does not supply hardware attestation. A valid proof alone is not evidence of enclave execution.

```
Client (AI Agent / SDK)
  │
  │  1. POST /api/v1/prove  →  402 { nonce, price, teePublicKey }
  │  2. Sign EIP-3009 USDC payment
  │  3. Encrypt inputs with TEE X25519 public key (ECIES)
  │  4. POST /api/v1/prove + X-Payment-TX + X-Payment-Nonce + encrypted_payload
  │
  ▼
┌─────────────────────────────────────┐
│  Node.js Server (port 4002)        │
│  ─ Verify USDC payment on-chain    │
│  ─ Blind relay: pass encrypted     │
│    payload to enclave via vsock     │
│  ─ Return proof + TEE attestation  │
└────────────┬────────────────────────┘
             │ vsock
             ▼
┌─────────────────────────────────────┐
│  AWS Nitro Enclave                  │
│  ─ X25519 key pair (bound to NSM)  │
│  ─ Decrypt inputs (AES-256-GCM)    │
│  ─ bb prove (Barretenberg CLI)     │
│  ─ NSM attestation of proof hash   │
└─────────────────────────────────────┘
```

**Key properties:**
- **E2E encryption** — X25519 ECDH + AES-256-GCM. In `nitro` mode, plaintext inputs are rejected.
- **Blind relay in Nitro mode** — The host forwards enclave-encrypted inputs. This property does not apply to an endpoint accepting plaintext circuit inputs.
- **x402 payment** — Single-step flow: 402 challenge → USDC payment → proof generation. No middleware.
- **Hardware attestation in Nitro mode** — An actual validated NSM document binds the TEE key to enclave measurements (PCRs); do not infer it from proof validity.

## Directory Structure

```
proofport-ai/
├── src/
│   ├── index.ts                  # Express server entry (port 4002)
│   ├── logger.ts                 # Pino logger
│   ├── swagger.ts                # OpenAPI spec
│   ├── tracing.ts                # OpenTelemetry tracing
│   ├── a2a/
│   │   ├── agentCard.ts          # /.well-known/agent.json, agent-card.json
│   │   ├── proofportExecutor.ts  # A2A task executor
│   │   └── redisTaskStore.ts     # Redis-backed task persistence
│   ├── chat/
│   │   ├── geminiClient.ts       # Gemini API client
│   │   ├── llmProvider.ts        # LLM provider interface
│   │   ├── multiProvider.ts      # Multi-provider routing
│   │   └── openaiClient.ts       # OpenAI API client
│   ├── circuit/
│   │   └── artifactManager.ts    # Circuit artifact download/cache
│   ├── config/
│   │   ├── index.ts              # Environment config
│   │   ├── circuits.ts           # Circuit metadata
│   │   └── contracts.ts          # Deployed contract addresses
│   ├── identity/
│   │   ├── agentAuth.ts          # Agent JWT authentication
│   │   ├── autoRegister.ts       # ERC-8004 auto-registration
│   │   ├── register.ts           # Identity registration
│   │   └── reputation.ts         # Reputation management
│   ├── input/
│   │   ├── attestationFetcher.ts # EAS GraphQL attestation fetch
│   │   ├── inputBuilder.ts       # Circuit input construction
│   │   └── merkleTree.ts         # Merkle tree builder
│   ├── mcp/
│   │   ├── server.ts             # StreamableHTTP MCP server
│   │   └── stdio.ts              # stdio MCP server (local use)
│   ├── payment/
│   │   └── freeTier.ts           # Payment mode config
│   ├── proof/
│   │   ├── proofRoutes.ts        # x402 single-step proof API
│   │   ├── guideBuilder.ts       # Dynamic proof generation guide
│   │   ├── paymentVerifier.ts    # On-chain USDC payment verification
│   │   ├── sessionManager.ts     # Proof session/nonce management
│   │   └── types.ts
│   ├── prover/
│   │   ├── bbProver.ts           # bb CLI direct prover
│   │   ├── tomlBuilder.ts        # Prover.toml builder
│   │   └── verifier.ts           # On-chain verification (ethers v6)
│   ├── redis/
│   │   ├── client.ts             # Redis client
│   │   ├── cleanupWorker.ts      # Expired data cleanup
│   │   ├── constants.ts          # Redis key prefixes
│   │   ├── proofCache.ts         # Proof result caching
│   │   ├── proofResultStore.ts   # Proof result persistence
│   │   └── rateLimiter.ts        # Rate limiting
│   ├── skills/
│   │   ├── skillHandler.ts       # Skill routing
│   │   └── flowGuidance.ts       # Step-by-step flow guidance
│   ├── tee/
│   │   ├── index.ts              # TEE mode config
│   │   ├── attestation.ts        # NSM attestation validation (COSE Sign1)
│   │   ├── detect.ts             # TEE environment detection
│   │   ├── enclaveBuilder.ts     # Enclave image builder
│   │   ├── enclaveClient.ts      # Nitro Enclave vsock client
│   │   ├── encryption.ts         # AES-256-GCM encryption utilities
│   │   ├── teeKeyExchange.ts     # X25519 ECDH key exchange
│   │   └── validationSubmitter.ts # TEE validation on-chain
│   └── types/
│       └── index.ts
├── packages/
│   ├── sdk/                      # @zkproofport-ai/sdk (npm)
│   └── mcp/                      # @zkproofport-ai/mcp (npm)
├── aws/
│   ├── enclave-server.ts         # TypeScript TEE prover (Nitro Enclave)
│   ├── Dockerfile.enclave        # Enclave image
│   ├── deploy-blue-green.sh      # Zero-downtime deployment
│   ├── boot-active-slot.sh       # Systemd boot script
│   ├── stop-active-slot.sh       # Systemd stop script
│   ├── build-enclave.sh          # Enclave build helper
│   ├── ec2-setup.sh              # EC2 instance setup
│   ├── Caddyfile                 # Reverse proxy config
│   ├── docker-compose.aws.yml    # AWS Docker Compose
│   ├── vsock-bridge.py           # vsock-to-TCP bridge
│   └── systemd/                  # Systemd service files
├── sign-page/                    # Next.js signing page (WalletConnect)
├── tests/
│   ├── e2e/                      # Full E2E tests (REST, MCP, A2A, proof, verify)
│   ├── a2a/                      # A2A unit tests
│   ├── identity/                 # ERC-8004 identity tests
│   ├── integration/              # Integration tests
│   ├── payment/                  # Payment tests
│   ├── tee/                      # TEE tests
│   └── *.test.ts                 # Unit tests
├── docker-compose.yml            # Local dev: server + redis
├── docker-compose.test.yml       # Test stack: + a2a-ui + Phoenix
├── Dockerfile                    # Node.js server image
└── README.md
```

## Quick Start

### npm (Development)

```bash
npm install
npm run dev          # Hot reload with tsx
npm run build        # Build TypeScript
npm start            # Production
npm test             # Run tests
npm run test:e2e     # E2E tests against Docker stack
```

### Docker Compose (Local)

```bash
docker compose up --build     # Start redis + server
docker compose down           # Stop
docker compose down -v        # Reset data
```

- Port 4002: Node.js server
- Port 6380 (host) → 6379 (container): Redis

## E2E Encryption (Blind Relay)

For the supported Nitro deployment, proof inputs are encrypted between the client and the enclave. The host passes the encrypted blob without reading it. This section describes that protocol, not every endpoint.

**Protocol:** X25519 ECDH + AES-256-GCM (ECIES pattern)

1. TEE generates X25519 key pair on startup, binds public key to NSM attestation
2. Client fetches TEE public key from 402 response, verifies attestation
3. Client generates ephemeral X25519 keypair, computes ECDH shared secret, derives AES key via SHA-256
4. Client encrypts inputs with AES-256-GCM, sends `{ ephemeralPublicKey, iv, ciphertext, authTag, keyId }`
5. Server passes encrypted envelope to enclave via vsock (blind relay)
6. Enclave decrypts, generates proof, returns proof + NSM attestation

**Enforcement:** In `nitro` mode, plaintext inputs are rejected with `PLAINTEXT_REJECTED`.

## x402 Payment Flow

The live `402` challenge determines the offered routes, price, asset, recipient and signing domain. Select a compatible wallet and explicit route, obtain user approval, then sign the exact terms and retry the request using the SDK's payment headers. Do not assume every endpoint is free or that every wallet works on every offered chain.

For Arc Gateway nanopayments, `pay_on: "arc-testnet-nano"` draws from an already funded Gateway balance. The initial direct deposit is an on-chain operation requiring gas; each proof payment signs an authorization against that balance. The demo proof fee is 0.001 USDC, but callers must validate the live offer rather than substitute a documentation price.

Use `max_payment: "0.001"` and `approved_payment` in local MCP, or `maxPayment` and `approvedPayment` in the SDK. Exact approved terms include `network`, `scheme`, `amount` (USDC base units), `asset`, `payTo` and `extra: {name, version, verifyingContract}`. The SDK rejects a changed fee, recipient, asset, network or signing domain before signing. Proof payment and an eventual staking transaction require separate approvals.

## REST Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/health` | GET | Health check + TEE status + payment mode |
| `/api/v1/prove` | POST | x402 single-step proof generation |
| `/api/v1/guide/:circuit` | GET | Dynamic proof generation guide (JSON) |
| `/mcp` | POST | StreamableHTTP MCP endpoint |
| `/a2a` | POST | A2A JSON-RPC endpoint |
| `/.well-known/agent.json` | GET | OASF Agent Card |
| `/agent-card.json` | GET | A2A Agent Card |
| `/.well-known/mcp.json` | GET | MCP discovery |
| `/docs` | GET | Swagger UI |
| `/openapi.json` | GET | OpenAPI spec |

## MCP Tools

Remote `/mcp` and the local npm MCP server have separate tool surfaces. Consult each actual `tools/list` response. The local package includes:

| Tool | Purpose |
|------|---------|
| `generate_proof` | All-in-one proof generation (x402 payment + E2E encryption auto-detect) |
| `verify_proof` | On-chain proof verification |
| `get_supported_circuits` | List available circuits |
| `request_challenge` | Request 402 challenge (step-by-step flow) |
| `submit_proof` | Submit proof inputs (step-by-step flow) |
| `prepare_inputs` | Prepare circuit inputs (step-by-step flow) |
| `gateway_balance` | Read Gateway balance using `PAYMENT_PRIVATE_KEY` only |
| `deposit_to_gateway` | Deposit to Gateway using `PAYMENT_PRIVATE_KEY` only; on-chain |

## npm Packages

```
@zkproofport-ai/sdk   — TypeScript SDK for proof generation (ethers v6)
@zkproofport-ai/mcp   — Local MCP server for AI agents (stdio transport)
```

Install the MCP server for local AI agent usage:

```bash
npm install @zkproofport-ai/mcp@latest @zkproofport-ai/sdk@latest ethers
npx zkproofport-mcp    # Starts stdio MCP server
```

Arc support described here requires SDK/MCP **0.2.11 or later**. Install from npm and check the resolved version. Release Please manages package versions and the release workflow publishes them; repository source changes alone do not update `@latest`.

### Circle Agent Wallet on Arc — EXPERIMENTAL

Use the existing Circle CLI login and wallet. `walletFor('arc')` / `walletFromArcAgent` wraps that CLI; MCP selects it with `pay_with: "arc"`. This differs from `pay_with: "circle"`, which uses Circle developer-controlled wallet credentials. Keep credential keys and login secrets out of model prompts and logs.

```bash
# Inspect the existing wallet; do not replace it or create a new one.
circle wallet list --chain ARC-TESTNET --type agent
circle gateway balance --address "$ARC_AGENT_WALLET" --chain ARC-TESTNET --output json
# Execute only after the user approves this funding amount:
circle gateway deposit --amount 0.1 --address "$ARC_AGENT_WALLET" --chain ARC-TESTNET --method direct
```

The local `gateway_balance` and `deposit_to_gateway` tools remain **`PAYMENT_PRIVATE_KEY` only**. Use Circle CLI for the Circle Agent Wallet instead of substituting another wallet. Circle's backing EOA signs Gateway authorizations internally; the exact action still names the operational Wallet B.

The supported flow is: discover the dApp policy and prover → prepare the exact action → approve the action and live payment terms → call `generate_proof` with `arc_eligibility`, `action`, `pay_with: "arc"`, `pay_on: "arc-testnet-nano"`, `max_payment` and `approved_payment` → verify the actual proof → obtain separate stake approval → submit from Wallet B and check the receipt. No all-chain wallet compatibility is implied.

See the [SDK Arc example](packages/sdk/README.md#arc-circle-agent-wallet-path--experimental) and [MCP setup and arguments](packages/mcp/README.md#arc-testnet--experimental). User-facing **exact-action authorization** retains the existing `CredentialDelegation` / `delegate` wire fields.

## Guide System

`GET /api/v1/guide/:circuit` returns a comprehensive JSON guide for client AI agents to prepare all proof inputs. Includes:

- Step-by-step instructions with code examples
- Constants (attester keys, contract addresses, EAS schema UIDs)
- Formulas (nullifier computation, signal hash, Merkle tree construction)
- Input schema with types and descriptions
- EAS GraphQL query templates

Circuits use aliases: `coinbase_kyc` → `coinbase_attestation`, `coinbase_country` → `coinbase_country_attestation`, `oidc_domain` → `oidc_domain_attestation`. `arc_eligibility` has no alias — it is named canonically or not at all.

## A2A Protocol

A2A v0.3 JSON-RPC endpoint at `POST /a2a`:

| Method | Purpose |
|--------|---------|
| `message/send` | Submit proof task (blocking) |
| `message/stream` | Submit proof task (SSE streaming) |
| `tasks/get` | Query task status |
| `tasks/cancel` | Cancel a running task |
| `tasks/resubscribe` | Resubscribe to task events |

Agent Card at `/.well-known/agent.json` provides ERC-8004 on-chain identity and capability discovery.

## TEE Integration (AWS Nitro Enclave)

| Mode | Behavior |
|------|----------|
| `disabled` | Standard Linux, no TEE, plaintext allowed |
| `nitro` | AWS Nitro Enclave, hardware attestation, E2E encryption enforced |

The enclave runs `aws/enclave-server.ts` (compiled to `dist/aws/enclave-server.js`) which executes `bb prove` with `--oracle_hash keccak` (required for Solidity verifier compatibility). NSM attestation binds the proof hash and TEE public key to the enclave measurement (PCR0/PCR1/PCR2).

**Attestation validation chain:** AWS Nitro Root CA → Regional → Zonal → Instance → Leaf certificate, verified with COSE ES384 signature.

## Supported Circuits

### Coinbase KYC (`coinbase_attestation`)

Proves holder has passed Coinbase KYC verification.

- **Aliases:** `coinbase_kyc`, `coinbase_attestation`
- **Public Inputs:** address, scope
- **Nullifier:** Yes (privacy, replay prevention)

### Coinbase Country (`coinbase_country_attestation`)

Proves holder's KYC country matches attestation.

- **Aliases:** `coinbase_country`, `coinbase_country_attestation`
- **Public Inputs:** address, country, scope
- **Nullifier:** Yes (privacy, replay prevention)

### OIDC Domain (`oidc_domain_attestation`)

Proves holder owns an email address at a specific domain via OIDC JWT verification.

- **Aliases:** `oidc_domain`, `oidc_domain_attestation`
- **Input type:** OIDC JWT (`id_token` from Google, etc.)
- **Public Inputs:** domain hash, scope
- **Nullifier:** Yes (privacy, replay prevention)

### Arc Eligibility (`arc_eligibility`) — EXPERIMENTAL

The same Coinbase attestation as `coinbase_attestation`, with the wallet signing
a named EIP-712 action instead of an opaque signal hash. The proof then carries
the action's domain separator and struct hash, so a verifier checks **which**
action was authorised rather than only that somebody eligible signed something.
That is the difference that matters once an agent moves money: `personal_sign`
over 32 opaque bytes shows a person a hex string.

- **Aliases:** none — the canonical id only
- **Required inputs:** `domainSeparator` and `actionHash`. A request without
  both is refused; there is nothing to prove without them
- **Public inputs, in order:** `signal_hash`, `domain_separator`, `action_hash`,
  `signer_list_merkle_root`, `scope`, `nullifier` — scope at fields 128–159 and
  nullifier at 160–191, which is 64 further along than every other circuit here
- **Nullifier:** Yes, derived from `signal_hash` exactly as on Base, so it stays
  one-per-person rather than one-per-action
- **Verifier:** `0xCbC8E63fF92659E8B44cFF117D33005Bb669a018` on Arc Testnet (chain 5042002). No Arc mainnet support is claimed.
- **Status:** `experimental` in `@zkproofport-app/sdk` — provable and
  verifiable, but the layout and the verifier address can still change

## Contract Addresses

### Arc Testnet — EXPERIMENTAL (5042002)

| Contract | Address |
|---|---|
| Arc eligibility verifier | `0xCbC8E63fF92659E8B44cFF117D33005Bb669a018` |
| Ledger House EligibilityGate | `0xD0F3eE648386B59B484157332E736388Fcc41F47` |

The gate checks the credential policy, authorized actor, exact action, unused nonce and deadline together with proof verification. Its deployed EIP-712 action shape is described in the package READMEs. The layout and deployments remain experimental; do not treat this as a mainnet guarantee.

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
| ERC-8004 Identity | `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` |
| ERC-8004 Reputation | `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63` |

## ERC-8004 Agent Identity

The agent auto-registers on-chain at startup via the ERC-8004 Identity contract. Reputation score increments after each successful proof generation.

## Environment Variables

### Required

| Variable | Description |
|----------|-------------|
| `REDIS_URL` | Redis connection string |
| `BASE_RPC_URL` | Base chain RPC endpoint |
| `CHAIN_RPC_URL` | RPC for proof verification |
| `EAS_GRAPHQL_ENDPOINT` | EAS GraphQL endpoint for attestation queries |
| `PROVER_PRIVATE_KEY` | Agent wallet private key (64 hex chars, no 0x) |
| `PAYMENT_MODE` | `disabled` / `testnet` / `mainnet` |
| `A2A_BASE_URL` | Public-facing service URL (for Agent Card) |

### Optional

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `4002` | Express server port |
| `NODE_ENV` | `development` | Node environment |
| `BB_PATH` | `bb` | Barretenberg CLI path |
| `NARGO_PATH` | `nargo` | Nargo CLI path |
| `CIRCUITS_DIR` | `/app/circuits` | Circuit artifacts directory |
| `CIRCUITS_REPO_URL` | (GitHub raw URL) | Circuit artifacts download URL |
| `TEE_MODE` | `disabled` | `disabled` / `nitro` |
| `ENCLAVE_CID` | — | Nitro Enclave CID (required when `TEE_MODE=nitro`) |
| `ENCLAVE_PORT` | `5000` | Nitro Enclave port |
| `TEE_ATTESTATION` | `false` | Enable attestation verification |
| `PAYMENT_PAY_TO` | — | Operator wallet (required when payment enabled) |
| `PAYMENT_PROOF_PRICE` | `$0.10` | Price per proof (USD) |
| `ERC8004_IDENTITY_ADDRESS` | — | ERC-8004 Identity contract |
| `ERC8004_REPUTATION_ADDRESS` | — | ERC-8004 Reputation contract |
| `GEMINI_API_KEY` | — | Gemini API key for chat |
| `OPENAI_API_KEY` | — | OpenAI API key for chat |
| `PHOENIX_COLLECTOR_ENDPOINT` | — | Phoenix OTLP endpoint for tracing |
| `AGENT_VERSION` | `1.0.0` | Agent version string |

## Deployment (AWS Nitro Enclave)

proofport-ai deploys to **AWS EC2** with Nitro Enclave support. Deployment uses **blue-green slot switching** for zero downtime.

### Blue-Green Deployment

```
aws/deploy-blue-green.sh
```

- Two slots: blue (ports 4002/3200) and green (ports 4003/3201)
- Active slot tracked in `/opt/proofport-ai/active-slot`
- Caddy reload (not restart) switches traffic
- In-flight request drain before switching (up to 660s for proof generation)
- Automatic rollback if new container health check fails

### Infrastructure

- **Caddy** — Reverse proxy with HTTPS (Cloudflare Full SSL)
- **systemd** — Services: `proofport-ai`, `proofport-ai-redis`, `proofport-ai-enclave`, `vsock-bridge`
- **CloudWatch** — Log driver `awslogs`, 30-day retention
- **GitHub Actions** — `deploy-ai-aws.yml` workflow (NOT `deploy.yml` which is GCP)

### Boot / Stop

```bash
aws/boot-active-slot.sh    # Start active slot containers
aws/stop-active-slot.sh    # Stop active slot containers
```

## Testing

```bash
npm test                # Unit tests
npm run test:e2e        # E2E against Docker stack
npm run test:watch      # Watch mode
```

### A2A Testing (a2a-ui + Phoenix)

```bash
docker compose -f docker-compose.yml -f docker-compose.test.yml up --build -d
```

| Service | URL | Purpose |
|---------|-----|---------|
| proofport-ai | `http://localhost:4002` | Agent server |
| a2a-ui | `http://localhost:3001` | A2A web test UI |
| Phoenix | `http://localhost:6006` | Trace visualization |

## Version Locks

| Tool | Version |
|------|---------|
| bb (Barretenberg) | `v1.0.0-nightly.20250723` |
| nargo | `1.0.0-beta.8` |
| ethers | `^6.13.0` |
| @modelcontextprotocol/sdk | `^1.0.0` |
| Node.js | 20 LTS |

## License

Apache 2.0
