# proofport-ai

Agent-native ZK proof infrastructure for ZKProofport, with a TEE-based proving architecture, SDK and local MCP package. Supported Nitro deployments encrypt inputs to the enclave; encryption and hardware-attestation guarantees depend on the selected endpoint and actual returned evidence. GIWA exact-action authorization remains **EXPERIMENTAL on GIWA Sepolia (91342)**.

## Architecture

The following diagram describes the Nitro deployment. Endpoints without an attested enclave key receive readable inputs over HTTPS; the current GCP Cloud Run deployments use that mode and do not supply hardware attestation. A valid proof alone is not evidence of enclave execution.

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

Callers must validate the live offer rather than substitute a documentation price.

Use `max_payment: "0.001"` and `approved_payment` in local MCP, or `maxPayment` and `approvedPayment` in the SDK. Exact approved terms include `network`, `scheme`, `amount` (USDC base units), `asset`, `payTo` and `extra: {name, version, verifyingContract}`. The SDK rejects a changed fee, recipient, asset, network or signing domain before signing. Proof payment and any application transaction that relies on the proof require separate approvals.

Base and Base Sepolia use Dexter first and PayAI as a backup. `--pay-with key`
and `--pay-with cdp` still choose the buyer's signing wallet; neither selects
the server's facilitator. Provider failover reuses the identical EIP-3009
authorization, including its nonce, amount and recipient. Ethereum direct
settlement keeps its own settlement route.

The server tries each configured facilitator at most once for connection
failures, timeouts, HTTP 429/5xx or malformed responses. Payment rejections
such as insufficient balance, invalid signatures and expired authorizations
stop immediately. Before contacting the backup, the server checks the USDC
authorization state on the selected chain. A pending settlement or an
already consumed authorization is not submitted again. If that state cannot
be established, the API reports `settlement_unknown`; known pending responses
report `settlement_pending`, with a transaction hash when available. These
outcomes require reconciliation, not a newly signed payment. This failover
does not implement resumption of a proof request after its settlement response
was lost. Final on-chain payment verification still runs before proof generation.

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
| `get_action_approval` | Read the state of a human action approval |

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

GIWA optional-action support requires **SDK 0.2.14 or later** and **MCP 0.2.15 or later** for the step-by-step input preparation path. MCP 0.2.14 has input-validation bugs in that path; its all-in-one tool delegates to the SDK. Install from npm and check the resolved version. Release Please manages package versions and the release workflow publishes them; repository source changes alone do not update `@latest`.

## Guide System

`GET /api/v1/guide/:circuit` returns a comprehensive JSON guide for client AI agents to prepare all proof inputs. Includes:

- Step-by-step instructions with code examples
- Constants (attester keys, contract addresses, EAS schema UIDs)
- Formulas (nullifier computation, signal hash, Merkle tree construction)
- Input schema with types and descriptions
- EAS GraphQL query templates

Circuits use aliases: `coinbase_kyc` → `coinbase_attestation`, `coinbase_country` → `coinbase_country_attestation`, `oidc_domain` → `oidc_domain_attestation`. `giwa_attestation` has no alias — it is named canonically or not at all.

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

### Human wallet approval links

SDK/MCP 0.3.0 introduce a human wallet approval pause for requests containing a GIWA action. The AI service serves `/approve/:id`: a responsive request page with proof conditions, domain/network details, expandable typed action fields and wallet selection. Ordinary proofs without an action retain the existing flow. See the [MCP human-approval instructions](packages/mcp/README.md#human-approval-for-actions) and [SDK examples](packages/sdk/README.md).

The service stores ten-minute approval sessions in Redis. Browser and requester capabilities are separate; approval is bound to the original action and consumed once before proof preparation/payment. Build the page with `npm run build` (included in the Docker image). `A2A_BASE_URL` must identify the externally reachable AI origin. Set `WALLETCONNECT_PROJECT_ID` to enable mobile-wallet pairing; browser extensions work without it. Deploy the compatible AI service before clients use the SDK/MCP 0.3.0 approval flow. The shared application SDK remains a separate dependency.

The approval UI ignores repeated, validated wallet state notifications while invalidating signatures on actual account/network changes or disconnects. Its WalletConnect 2.25.0 adapter consumes normalized chain events without echoing raw notifications back as switch commands, avoiding a request-before-provider-initialization race during pairing. Explicit network selection still uses the public provider API. Run the approval workspace tests, browser tests, and a real local wallet approval before deployment when changing this adapter. The modal uses the page's system font stack so AppKit does not preload unused remote font variants.

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
| `PROVER_PRIVATE_KEY` | Agent wallet private key (64 hex chars, optional 0x); also submits direct payment settlements |
| `PAYMENT_MODE` | `disabled` / `testnet` / `mainnet` |
| `A2A_BASE_URL` | Public-facing service URL (for Agent Card) |
| `COINBASE_STATEMENT_KMS_KEY` | Cloud KMS key version (`projects/…/cryptoKeyVersions/N`, `EC_SIGN_P256_SHA256`) that signs coinbase_attestation v2's revocation statement; the circuit pins its public key. The server refuses to start unless it can read the key. Credentials come from the runtime service account (Cloud Run) or `GOOGLE_APPLICATION_CREDENTIALS` (local; see `docker-compose.kms.yml`) |

### Optional

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `4002` | Express server port |
| `WALLETCONNECT_PROJECT_ID` | Unset | Public WalletConnect project ID for human action approval; injected wallets remain available when unset |
| `APPROVAL_TRUST_PROXY_HOPS` | Unset (proxy trust disabled) | Integer `1`–`16` for the verified ingress proxy count; scoped to approval creation rate limits |
| `NODE_ENV` | `development` | Node environment |
| `BB_PATH` | `bb` | Barretenberg CLI path |
| `CIRCUITS_DIR` | `/app/circuits` | Circuit artifacts directory |
| `CIRCUITS_REPO_URL` | (GitHub raw URL) | Circuit artifacts download URL |
| `TEE_MODE` | `disabled` | `disabled` / `local` / `nitro`; GCP uses `local` without hardware attestation |
| `ENCLAVE_CID` | — | Nitro Enclave CID (required when `TEE_MODE=nitro`) |
| `ENCLAVE_PORT` | `5000` | Nitro Enclave port |
| `TEE_ATTESTATION` | `false` | Enable attestation verification |
| `PAYMENT_PAY_TO` | — | Payment recipient (required when payment enabled); must match the prover wallet when direct settlement is offered |
| `PAYMENT_PROOF_PRICE` | `$0.10` | Price per proof (USD) |
| `X402_FACILITATOR_URL` | `https://x402.dexter.cash` | Primary Base / Base Sepolia facilitator |
| `X402_FALLBACK_FACILITATOR_URL` | `https://facilitator.payai.network` | Backup for the same authorization; empty disables failover |
| `X402_FACILITATOR_TIMEOUT_MS` | `15000` | Per-provider deadline including response body, integer 1–60000 ms |
| `GIWA_RPC_URL`, `GIWA_EXPLORER_URL` | — | GIWA Sepolia input source and proof verification endpoints |
| `ERC8004_IDENTITY_ADDRESS` | — | ERC-8004 Identity contract |
| `ERC8004_REPUTATION_ADDRESS` | — | ERC-8004 Reputation contract |
| `GEMINI_API_KEY` | — | Gemini API key for chat |
| `OPENAI_API_KEY` | — | OpenAI API key for chat |
| `PHOENIX_COLLECTOR_ENDPOINT` | — | Phoenix OTLP endpoint for tracing |
| `AGENT_VERSION` | Server package version | Optional advertised agent version override |

Human action approvals expire after ten minutes and retain an authenticated
tombstone for five more minutes. Creation allows ten requests per client IP
per minute. On Cloud Run, configure `APPROVAL_TRUST_PROXY_HOPS` only after
verifying the ingress proxy count and ensuring requests cannot take a shorter
path. With the setting unset, clients behind a proxy share its socket-IP
bucket; arbitrary `X-Forwarded-For` headers are ignored. This setting does not
change proxy trust for other service routes. Deployment workflows do not
enable it automatically.

### Direct payment settlement wallet

`PROVER_PRIVATE_KEY` is the single operator key for agent identity signing and
direct x402 settlement. No separate `PAYMENT_SETTLER_PRIVATE_KEY` is read.
When a configured payment network uses payee settlement, startup checks that the
prover key is valid and its address matches `PAYMENT_PAY_TO`. A mismatch stops
startup before the service offers payment. Fund this wallet for transaction gas
on each directly settled network. Facilitator settlement does not use
this wallet to submit each payment; payment-disabled operation skips this check.

For local paid-path tests, provide `PROVER_PRIVATE_KEY` and its public address as
`PAYMENT_PAY_TO` in the shell, then run `./scripts/ai-dev.sh --payment`. The
script uses the same prover key in the server container. `scripts/verify-payment.ts`
also uses this pair for direct settlement, plus a distinct `PAYMENT_BUYER_KEY`
for the customer-side authorization; keep private keys out of shell history.

## Deployment

The current deployment target is **GCP Cloud Run**, through the parent workspace's
`deploy-ai.yml` workflow. Commit service changes to `main`, update the parent's
pinned service commit, and dispatch that parent's `main`. Staging uses testnets;
production uses mainnets. Cloud Run uses `TEE_MODE=local`, so it does not provide
Nitro hardware attestation or the Nitro encrypted-payload endpoint.

The deployment gate verifies all configured ERC-8004 identities, all five circuit
discovery entries, and every payment offer. Actual paid proof E2E is a separate
check: use `scripts/run-published-e2e.mjs` with an explicit `E2E_BASE_URL` to install
and exercise the versions in the package manifests. It verifies generated proofs
on chain; a successful 402 response alone is not a paid proof test.

### AWS Nitro reference

The retained AWS deployment supports hardware-attested proving and blue-green
slot switching. It is not the current deployment target; use it only after an
explicit change to that deployment decision.

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
npm run test:unit       # Unit and integration tests
npm run test:e2e        # E2E against Docker stack
npm run test:watch      # Watch mode
```

### Deployed approval HTTP smoke

After deploying the approval feature, explicitly opt in to its canonical staging
or production origin. This check uses a public deterministic fixture signer,
creates two short-lived approval sessions, and never calls proof, payment, or
chain RPC endpoints:

```bash
node scripts/verify-approval-deployment.mjs \
  --allow-deployed --base-url https://stg-ai.zkproofport.app \
  --expected-version "$(node -p 'require("./package.json").version')" \
  --expected-assets-dir public/approval \
  --output "${TMPDIR:-/tmp}/proofport-approval-staging-smoke.json"
```

Use `https://ai.zkproofport.app` explicitly for production. The script rejects
other hosts, non-HTTPS origins, URL credentials, paths, queries, fragments, and
redirects. The existing local-container approval test remains localhost-only.
`--expected-assets-dir` compares the deployed HTML and referenced JS/CSS bytes
with the supplied build; `--expected-index-sha256` can additionally pin an exact
HTML digest. Output contains case results, service version, and public asset
hashes, never capabilities, approval URLs, signatures, or response bodies.

Coverage includes capability separation, signature validation, altered-request
rejection, atomic consumption, terminal rejection, public-status privacy, and
fixed expiry without extension. Actual expiration is reported as untested in
the quick run because the server TTL is ten minutes. Add `--wait-for-expiry` to
create one more fixture and observe that transition; it takes about ten minutes.
This is a deployed HTTP check with a public test EOA, not a real human-wallet or
paid-proof end-to-end test.

### Published SDK/MCP E2E

```bash
E2E_BASE_URL=https://stg-ai.zkproofport.app \
E2E_PAYMENT_NETWORK=base-sepolia \
npm run test:e2e:published
```

This installs the exact SDK/MCP versions from their package manifests into an
isolated temporary directory. It also installs the SDK's optional wallet adapters: CDP and x402 extensions
use the tested versions in the root lockfile. All adapter modules are imported from the
isolated installation before any paid test begins. Missing or newly added
optional peers fail this preflight instead of failing after a proof starts.
It verifies those versions and puts the installation's binaries first on every
test subprocess's PATH; the global installation is neither used nor changed. SDK imports and the
MCP process use the installed registry artifacts, not workspace links. The
installation is removed after testing. Use `-- --sdk-version X.Y.Z --mcp-version
X.Y.Z` to validate a specific already published release.

The full run creates paid testnet proofs. Supply credentials in the untracked
`.env.test` or process environment: `ATTESTATION_KEY`, `GIWA_ATTESTATION_KEY`,
`E2E_PAYER_WALLET_KEY`, and `E2E_OIDC_JWT` (or an authenticated gcloud account).
`E2E_PAYMENT_NETWORK` selects the proof suites' payment network. The separate
payment matrix checks Base Sepolia and Ethereum Sepolia individually. Give it
funded test wallets using explicit `E2E_PAYER_KEY_BASE_SEPOLIA` and
`E2E_PAYER_KEY_ETHEREUM_SEPOLIA` overrides when the common payer cannot pay on
those networks. The runner never derives a payer from the prover key or
transfers funds automatically.

For an existing Base Sepolia or Ethereum Sepolia payer that lacks USDC, use the
explicit faucet helper below. Put `CDP_API_KEY_ID` and `CDP_API_KEY_SECRET` in the
untracked `.env.test`; no wallet secret or payer private key is needed for this
request. Set `E2E_PAYER_ADDRESS` to the public address of the wallet already used
by your test fixture, then run:

```bash
node --env-file=.env.test --import tsx scripts/request-testnet-usdc.ts \
  --network ethereum-sepolia --address "$E2E_PAYER_ADDRESS" --min-usdc 0.01
# Use --network base-sepolia for that testnet instead.
```

The helper checks the USDC balance first and requests faucet funds only below
the minimum. It accepts only those two testnets and USDC, creates no wallet,
and spends no real assets. `requested` includes the public transaction hash;
wait for confirmation and rerun until the status is `adequate` before E2E.
`rate_limited`, `missing_credentials`, `balance_unavailable`, or `faucet_failed`
returns a failing exit status and a sanitized message, without automatic retry
or printing provider errors. Funding is a separate explicit action; the E2E
runner never invokes this helper automatically.

A free package/discovery check is:

```bash
E2E_BASE_URL=https://stg-ai.zkproofport.app \
npm run test:e2e:published -- -t 'should list all 5 circuits'
```

That check does not establish proof generation or settlement success.

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
