# Stage 1: bb Binary Source
# Reuse bb binary from the last successful image in Artifact Registry.
# The GitHub nightly release (v1.0.0-nightly.20250723) was deleted — downloading
# from GitHub is no longer possible. The binary and its x86-64 libs are already
# baked into the existing staging-latest image.
FROM --platform=linux/amd64 us-central1-docker.pkg.dev/zkproofport/proofport/proofport-ai:staging-latest AS bb-extractor

# Stage 2: TypeScript Build (native arch)
FROM node:20-slim AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src/ ./src/

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

# Copy bb binary and x86 libs from Stage 1
COPY --from=bb-extractor /opt/bb/bb /opt/bb/bb
COPY --from=bb-extractor /opt/x86-libs /opt/x86-libs

# Create bb wrapper script for cross-architecture execution
RUN echo '#!/bin/bash\n\
if [ "$(uname -m)" = "aarch64" ]; then\n\
  /opt/x86-libs/ld-linux-x86-64.so.2 --library-path /opt/x86-libs /opt/bb/bb "$@"\n\
else\n\
  /opt/bb/bb "$@"\n\
fi' > /usr/local/bin/bb-wrapper && \
    chmod +x /usr/local/bin/bb-wrapper

WORKDIR /app

# Install production dependencies
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts

# Copy built JavaScript from builder stage
COPY --from=builder /app/dist ./dist

# Copy public static assets (agent icon, etc.)
COPY public/ ./public/

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
