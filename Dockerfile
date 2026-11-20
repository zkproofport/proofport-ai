# Stage 1: bb, the official Barretenberg release asset for the image's OWN
# architecture -- amd64 for Cloud Run, arm64 on an Apple-silicon dev VM.
#
# WHICH bb: the one the baked circuits were built with, read from
# circuits/circuits-source.json (bbVersion = BB_VERSION of that circuits
# commit's toolchain.env). The proof format belongs to the bb that wrote the
# circuit artifacts, so the version is not written here: until 2026-11-17 it
# was an ARG default, a second copy of toolchain.env that a toolchain move had
# to remember to change, and an image could pair bb 6 with beta.19 artifacts.
# The stamp is written by scripts/bake-circuits.sh (local, AWS) or the build
# context scripts (GCP deploys); without it the build stops here. The server
# checks the same pairing again at boot (src/circuit/circuitsSource.ts).
#
# This stage used to be pinned to linux/amd64. The 2025 nightly it held had no
# arm64 Linux build, and an x86 bb run under the arm64 VM's emulation computes
# wrong field arithmetic and aborts on every call -- so local proving needed an
# x86_64 VM and a ~20-minute emulated build. Since 4.2.0-aztecnr-rc.2 the
# release publishes both barretenberg-amd64-linux and barretenberg-arm64-linux,
# so each image carries a native bb. 6.0.0 (paired with nargo 1.0.0) publishes
# both too; its binaries need glibc >= 2.34 (Ubuntu 24.04 has 2.39).
#
# BuildKit sets TARGETARCH; the classic builder (docker without buildx, as on
# a plain Colima install) leaves it empty, and there the stage runs on the
# daemon's own machine, so `uname -m` names the target. An architecture with
# no release asset stops the build.
FROM ubuntu:24.04 AS bb-extractor
ARG TARGETARCH
COPY circuits/circuits-source.json /tmp/circuits-source.json

RUN set -e; \
    machine="${TARGETARCH:-$(uname -m)}"; \
    case "$machine" in \
      amd64|x86_64) asset=amd64 ;; \
      arm64|aarch64) asset=arm64 ;; \
      *) echo "No bb release asset for architecture '$machine'. Known: amd64/x86_64, arm64/aarch64" >&2; exit 1 ;; \
    esac; \
    apt-get update && apt-get install -y --no-install-recommends curl ca-certificates jq && rm -rf /var/lib/apt/lists/*; \
    BB_VERSION="$(jq -er '.bbVersion | select(type == "string" and length > 0)' /tmp/circuits-source.json)" \
      || { echo "circuits/circuits-source.json names no bbVersion" >&2; exit 1; }; \
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

# Copy compiled circuit artifacts (JSON + VK), their hashes and their stamp.
# circuits/ is empty in source — artifacts are copied into the build context before docker build:
#   - Local dev and deploy-ai-aws.yml: scripts/bake-circuits.sh
#   - deploy-ai.yml / emergency-deploy.yml: the build context scripts
# The artifacts baked here are used by the enclave build step (EIF) for Nitro TEE mode.
COPY circuits/ /app/circuits/

# Environment variables
ENV NODE_ENV=production
ENV BB_PATH=/usr/local/bin/bb-wrapper
ENV CIRCUITS_DIR=/app/circuits

EXPOSE 4002

CMD ["node", "dist/index.js"]
