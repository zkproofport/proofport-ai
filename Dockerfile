# Stage 1: bb Binary Extractor (amd64 only)
FROM --platform=linux/amd64 ubuntu:24.04 AS bb-extractor

RUN apt-get update && \
    apt-get install -y curl && \
    rm -rf /var/lib/apt/lists/*

# Download and extract bb binary (locked version: v1.0.0-nightly.20250723)
RUN mkdir -p /opt/bb && \
    curl -L "https://github.com/AztecProtocol/aztec-packages/releases/download/v1.0.0-nightly.20250723/barretenberg-amd64-linux.tar.gz" \
    -o /tmp/bb.tar.gz && \
    tar -xzf /tmp/bb.tar.gz -C /opt/bb && \
    rm /tmp/bb.tar.gz

# Copy x86_64 shared libraries needed by bb
RUN mkdir -p /opt/x86-libs && \
    cp /lib64/ld-linux-x86-64.so.2 /opt/x86-libs/ && \
    cp /lib/x86_64-linux-gnu/libc.so.6 /opt/x86-libs/ && \
    cp /lib/x86_64-linux-gnu/libm.so.6 /opt/x86-libs/ && \
    cp /lib/x86_64-linux-gnu/libstdc++.so.6 /opt/x86-libs/ && \
    cp /lib/x86_64-linux-gnu/libgcc_s.so.1 /opt/x86-libs/ && \
    cp /lib/x86_64-linux-gnu/libpthread.so.0 /opt/x86-libs/ || true && \
    cp /lib/x86_64-linux-gnu/libdl.so.2 /opt/x86-libs/ || true

# Stage 2: TypeScript Build (native arch)
FROM node:20-slim AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/

RUN npm run build

# Stage 2.5: Sign Page Build (native arch)
FROM node:20-alpine AS sign-page-builder
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY sign-page/package*.json ./
RUN npm ci
COPY sign-page/ .
ARG NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID
ARG NEXT_PUBLIC_API_BASE_URL
ENV NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID=$NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID
ENV NEXT_PUBLIC_API_BASE_URL=$NEXT_PUBLIC_API_BASE_URL
RUN npm run build

# Stage 3: Production Runtime (native arch)
FROM ubuntu:24.04

# Install Node.js 20.x via NodeSource and build tools
RUN apt-get update && \
    apt-get install -y curl wget jq git ca-certificates gnupg && \
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
    apt-get install -y nodejs && \
    rm -rf /var/lib/apt/lists/*

# Install nargo (native arch detection)
RUN ARCH=$(uname -m) && \
    if [ "$ARCH" = "aarch64" ]; then NARGO_ARCH="aarch64-unknown-linux-gnu"; \
    else NARGO_ARCH="x86_64-unknown-linux-gnu"; fi && \
    curl -L "https://github.com/noir-lang/noir/releases/download/v1.0.0-beta.8/nargo-${NARGO_ARCH}.tar.gz" | tar xz -C /usr/local/bin/

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
RUN npm ci --production

# Copy built JavaScript from builder stage
COPY --from=builder /app/dist ./dist

# Copy public static assets (agent icon, etc.)
COPY public/ ./public/

# Create circuits directory
RUN mkdir -p /app/circuits

# Copy sign-page standalone build
COPY --from=sign-page-builder /app/.next/standalone /app/sign-page
COPY --from=sign-page-builder /app/.next/static /app/sign-page/.next/static

# Environment variables
ENV NODE_ENV=production
ENV BB_PATH=/usr/local/bin/bb-wrapper
ENV NARGO_PATH=/usr/local/bin/nargo
ENV CIRCUITS_DIR=/app/circuits

EXPOSE 4002 3200

CMD ["sh", "-c", "HOSTNAME=0.0.0.0 PORT=3200 node /app/sign-page/server.js & node dist/index.js"]
