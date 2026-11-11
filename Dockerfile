# Stage 1: bb, the official Barretenberg release asset for the image's OWN
# architecture -- amd64 for Cloud Run, arm64 on an Apple-silicon dev VM.
# BB_VERSION must equal BB_VERSION in circuits/toolchain.env: the proof format
# belongs to the bb that wrote the circuit artifacts.
#
# This stage used to be pinned to linux/amd64. The 2025 nightly it held had no
# arm64 Linux build, and an x86 bb run under the arm64 VM's emulation computes
# wrong field arithmetic and aborts on every call -- so local proving needed an
# x86_64 VM and a ~20-minute emulated build. 4.2.0-aztecnr-rc.2 publishes both
# barretenberg-amd64-linux and barretenberg-arm64-linux, so each image now
# carries a native bb.
#
# BuildKit sets TARGETARCH; the classic builder (docker without buildx, as on
# a plain Colima install) leaves it empty, and there the stage runs on the
# daemon's own machine, so `uname -m` names the target. An architecture with
# no release asset stops the build.
FROM ubuntu:24.04 AS bb-extractor
ARG BB_VERSION=4.2.0-aztecnr-rc.2
ARG TARGETARCH

RUN set -e; \
    machine="${TARGETARCH:-$(uname -m)}"; \
    case "$machine" in \
      amd64|x86_64) asset=amd64 ;; \
      arm64|aarch64) asset=arm64 ;; \
      *) echo "No bb release asset for architecture '$machine'. Known: amd64/x86_64, arm64/aarch64" >&2; exit 1 ;; \
    esac; \
    apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && rm -rf /var/lib/apt/lists/*; \
    mkdir -p /opt/bb; \
    curl -fsSL "https://github.com/AztecProtocol/aztec-packages/releases/download/v${BB_VERSION}/barretenberg-${asset}-linux.tar.gz" | tar -xz -C /opt/bb; \
    chmod +x /opt/bb/bb; \
    got="$(/opt/bb/bb --version)"; \
    [ "$got" = "$BB_VERSION" ] || { echo "bb reports '$got', expected $BB_VERSION" >&2; exit 1; }

# Stage 2: TypeScript Build (native arch)
FROM node:20-slim AS builder

WORKDIR /app

COPY package*.json ./
COPY packages/sdk/package.json ./packages/sdk/package.json
COPY packages/mcp/package.json ./packages/mcp/package.json
COPY packages/approval-web/package.json ./packages/approval-web/package.json
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src/ ./src/
COPY packages/approval-web/ ./packages/approval-web/

RUN npm run build

# Stage 3: Production Runtime (native arch)
FROM ubuntu:24.04

# Install Node.js 20.x via NodeSource (git and nargo no longer needed — witness
# generation uses @noir-lang/noir_js with compiled circuit JSON instead of nargo CLI)
RUN apt-get update && \
    apt-get install -y curl wget jq ca-certificates gnupg && \
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
    apt-get install -y nodejs && \
    rm -rf /var/lib/apt/lists/*

# bb from Stage 1, same architecture as this stage, so it runs directly.
# /usr/local/bin/bb-wrapper is the path BB_PATH names here, in docker-compose
# and in both deploy workflows; it once chose an x86 loader on arm64 and is now
# a plain link. Running it here fails the build if this stage lacks a library
# bb needs, instead of failing the first proof request.
COPY --from=bb-extractor /opt/bb/bb /opt/bb/bb
RUN ln -s /opt/bb/bb /usr/local/bin/bb-wrapper && /usr/local/bin/bb-wrapper --version

WORKDIR /app

# Install production dependencies
COPY package*.json ./
COPY packages/sdk/package.json ./packages/sdk/package.json
COPY packages/mcp/package.json ./packages/mcp/package.json
COPY packages/approval-web/package.json ./packages/approval-web/package.json
RUN npm ci --omit=dev --ignore-scripts

# Copy built JavaScript from builder stage
COPY --from=builder /app/dist ./dist

# Copy public static assets (agent icon, etc.)
COPY public/ ./public/
COPY --from=builder /app/public/approval ./public/approval

# Copy AWS enclave build files (Dockerfile.enclave, enclave-server.ts, vsock-bridge.py, systemd/)
# These are extracted by deploy-ai-aws.yml during EC2 deployment.
COPY aws/ ./aws/

# Copy compiled circuit artifacts (JSON + VK).
# circuits/ is empty in source — artifacts are copied into the build context before docker build:
#   - Local dev: scripts/ai-dev.sh copies compiled JSON + VK from parent circuits/ repo
#   - CI/CD: deploy-ai-aws.yml copies compiled JSON + VK before running docker build
# The artifacts baked here are used by the enclave build step (EIF) for Nitro TEE mode.
COPY circuits/ /app/circuits/

# Environment variables
ENV NODE_ENV=production
ENV BB_PATH=/usr/local/bin/bb-wrapper
ENV CIRCUITS_DIR=/app/circuits

EXPOSE 4002

CMD ["node", "dist/index.js"]
