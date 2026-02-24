# Stage 1: Build Rust binary
FROM rust:1.82-bookworm AS builder

WORKDIR /app

# Copy manifests first for dependency caching
COPY Cargo.toml Cargo.lock* ./

# Create dummy src to build dependencies
RUN mkdir src && echo 'fn main() { println!("stub"); }' > src/main.rs
RUN cargo build --release 2>/dev/null || true

# Copy actual source
COPY src/ src/

# Build the real binary
RUN cargo build --release

# Stage 2: Runtime with Ubuntu 24.04 for glibc >= 2.38
FROM ubuntu:24.04

# Install required runtime dependencies
# - ca-certificates: for HTTPS connections (SRS download)
# - wget: for health checks
# - jq: used internally by bb (barretenberg)
RUN apt-get update && apt-get install -y \
    ca-certificates \
    wget \
    jq \
    && rm -rf /var/lib/apt/lists/*

# Copy the compiled binary
COPY --from=builder /app/target/release/proofport-prover /usr/local/bin/

# Circuit files are expected to be mounted at runtime
ENV CIRCUITS_DIR=/app/circuits
ENV PORT=4003
ENV RUST_LOG=info

EXPOSE 4003

CMD ["proofport-prover"]
