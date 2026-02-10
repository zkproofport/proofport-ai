# Docker Compose Setup for proofport-ai

## Overview

Standalone Docker Compose stack for proofport-ai with three services:
1. **Rust Prover Microservice** (port 4003) - ZK proof generation
2. **Node.js MCP/A2A Server** (port 4002) - Agent-native API
3. **Redis** (port 6380) - Own Redis instance (no shared infrastructure)

## Architecture

```
proofport-ai/
├── docker-compose.yml          # Three-service stack definition
├── Dockerfile                  # Node.js server multi-stage build
├── .dockerignore              # Node.js build exclusions
├── .env.example               # Environment variable template
└── prover/
    ├── Dockerfile             # Rust prover multi-stage build
    └── .dockerignore          # Rust build exclusions
```

## Key Design Decisions

### 1. Ubuntu 24.04 for Rust Prover Runtime
- **Why**: bb (barretenberg) requires glibc >= 2.38
- **Debian Bookworm fails**: glibc 2.36 (too old)
- **Ubuntu 24.04 works**: glibc 2.39 (meets requirement)

### 2. Redis on Port 6380 (External)
- **Why**: Avoid conflict with parent proofport-app-dev Redis on 6379
- **Internal**: Redis still listens on 6379 inside container
- **External**: Mapped to 6380 on host machine

### 3. Prover Dependencies
- `jq` - Used internally by bb (barretenberg)
- `wget` - Health check endpoint testing
- `ca-certificates` - HTTPS for SRS download (noir_rs auto-downloads)

### 4. Multi-Stage Builds
Both Dockerfiles use multi-stage builds to minimize final image size:
- **Node.js**: Build stage (npm ci + tsc) → Production stage (npm ci --production + dist/)
- **Rust**: Builder stage (cargo build --release) → Runtime stage (Ubuntu 24.04 + binary only)

### 5. Volume Mounts
- **circuits/**: Mounted read-only from parent repo (`../circuits:/app/circuits:ro`)
- **redis-data**: Named volume for Redis persistence

## Environment Variables

Copy `.env.example` to `.env` and fill in:

```bash
cp .env.example .env
```

### Required Variables
| Variable | Description | Example |
|----------|-------------|---------|
| `BASE_RPC_URL` | Base mainnet RPC endpoint | `https://mainnet.base.org` |
| `CHAIN_RPC_URL` | Chain RPC for verification | `https://mainnet.base.org` |
| `EAS_GRAPHQL_ENDPOINT` | EAS GraphQL API | `https://base.easscan.org/graphql` |
| `NULLIFIER_REGISTRY_ADDRESS` | Registry contract address | `0x1234...abcd` (checksummed) |
| `PROVER_PRIVATE_KEY` | Prover wallet private key | `64 hex chars, NO 0x prefix` |
| `PAYMENT_MODE` | Payment mode | `disabled` or `testnet` or `mainnet` |

### Optional Variables (with defaults)
| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `4002` | Node.js server port |
| `NODE_ENV` | `development` | Node environment |
| `PROVER_URL` | `http://prover:4003` | Internal prover URL |
| `REDIS_URL` | `redis://redis:6379` | Internal Redis URL |

## Usage

### Start All Services
```bash
docker compose up -d
```

### View Logs
```bash
# All services
docker compose logs -f

# Specific service
docker compose logs -f server
docker compose logs -f prover
docker compose logs -f redis
```

### Check Health
```bash
# Server health
curl http://localhost:4002/health

# Prover health
curl http://localhost:4003/health

# Redis
docker compose exec redis redis-cli ping
```

### Stop Services
```bash
docker compose down
```

### Rebuild After Code Changes
```bash
# Rebuild specific service
docker compose up -d --build server
docker compose up -d --build prover

# Rebuild all
docker compose up -d --build
```

### Reset Redis Data
```bash
docker compose down -v  # WARNING: Deletes redis-data volume
```

## Service Health Checks

### Prover Service
- Endpoint: `GET /health`
- Interval: 30s
- Timeout: 10s
- Start period: 60s (allows time for SRS download on first run)

### Server Service
- Endpoint: `GET /health`
- Interval: 15s
- Timeout: 5s
- Depends on: prover + redis (healthy)

### Redis
- Command: `redis-cli ping`
- Interval: 10s
- Timeout: 3s

## Troubleshooting

### Prover Fails with "GLIBC Not Found"
- **Cause**: Runtime image has glibc < 2.38
- **Fix**: Ensure `prover/Dockerfile` uses `FROM ubuntu:24.04` (NOT Debian Bookworm)

### Server Can't Connect to Prover
- **Check**: `docker compose logs prover` - Is prover healthy?
- **Check**: `docker compose ps` - Is prover service running?
- **Check**: Health check passing? (should show "healthy" status)

### Redis Connection Refused
- **Check**: `docker compose ps redis` - Is Redis running?
- **Check**: Server uses `redis://redis:6379` (internal), NOT `localhost:6380`
- **Note**: Port 6380 is for HOST access only, containers use internal network

### Circuit Files Not Found
- **Check**: `ls ../circuits/coinbase-attestation/target/` - Are circuits compiled?
- **Check**: Volume mount in `docker-compose.yml` points to correct parent directory
- **Build circuits first**: Use `/build-circuit` skill or `nargo compile + bb write_vk`

### Environment Variable Missing
- **Symptom**: Server crashes on startup with "X environment variable is required"
- **Fix**: Copy `.env.example` to `.env` and fill in ALL required variables
- **No fallbacks**: Service intentionally crashes if critical config missing (CLAUDE.md rule)

## Network Architecture

All services run on isolated `proofport-ai` bridge network:
- **Internal DNS**: Services resolve each other by service name (`prover`, `redis`)
- **External ports**: 4002 (server), 4003 (prover), 6380 (redis)
- **No shared network**: Completely isolated from parent proofport-app-dev stack

## Build Context

### Node.js Server
- Context: `/Users/nhn/Workspace/proofport-app-dev/proofport-ai/`
- Includes: `package.json`, `tsconfig.json`, `src/`
- Excludes: `node_modules`, `dist`, `prover`, `.env`, tests

### Rust Prover
- Context: `/Users/nhn/Workspace/proofport-app-dev/proofport-ai/prover/`
- Includes: `Cargo.toml`, `src/`
- Excludes: `target`, `Cargo.lock`

## Validation

Docker Compose configuration validated:
```bash
docker compose config
```

Output shows:
- ✅ Valid YAML syntax
- ✅ All service dependencies defined
- ✅ Health checks configured
- ✅ Volume mounts correct
- ✅ Network isolation configured
- ⚠️ Environment variables require `.env` file (warnings expected without it)

## Compliance with CLAUDE.md Rules

✅ **No environment-specific fallbacks**: Required env vars cause startup crash if missing
✅ **Standalone infrastructure**: Own Redis on port 6380, no shared services
✅ **Ubuntu 24.04 for prover**: glibc 2.39 meets bb requirement (>= 2.38)
✅ **jq installed**: Required by bb (barretenberg) internally
✅ **No hardcoded IPs**: Services use Docker DNS (`prover`, `redis`)
✅ **Full log output**: No truncation anywhere (verified in SETUP_SUMMARY.md)
