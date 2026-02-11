/**
 * Enclave image builder for AWS Nitro Enclaves
 *
 * This module validates enclave image configuration and generates build commands.
 * It does NOT actually run Docker/nitro-cli (those are run by the operator).
 */

import type { EnclaveImageConfig } from './types.js';

/**
 * Validates enclave image configuration
 * @throws Error if configuration is invalid
 */
export function validateEnclaveImageConfig(config: EnclaveImageConfig): void {
  if (!config.circuits || config.circuits.length === 0) {
    throw new Error('Enclave image config validation failed: circuits array cannot be empty');
  }

  if (!config.proverBinaryPath || config.proverBinaryPath.trim() === '') {
    throw new Error('Enclave image config validation failed: proverBinaryPath cannot be empty');
  }

  if (!config.circuitArtifactsDir || config.circuitArtifactsDir.trim() === '') {
    throw new Error('Enclave image config validation failed: circuitArtifactsDir cannot be empty');
  }

  if (!config.outputPath || config.outputPath.trim() === '') {
    throw new Error('Enclave image config validation failed: outputPath cannot be empty');
  }

  if (!config.outputPath.endsWith('.eif')) {
    throw new Error('Enclave image config validation failed: outputPath must end with .eif extension');
  }
}

/**
 * Generates shell commands to build enclave image
 * @returns Array of commands: [docker build, nitro-cli build-enclave]
 */
export function generateBuildCommands(config: EnclaveImageConfig): string[] {
  return [
    'docker build -t proofport-prover-enclave -f Dockerfile.enclave .',
    `nitro-cli build-enclave --docker-uri proofport-prover-enclave --output-file ${config.outputPath}`,
  ];
}

/**
 * Generates Dockerfile.enclave content
 * @returns Dockerfile content as string
 */
export function generateDockerfileContent(config: EnclaveImageConfig): string {
  const circuitCopies = config.circuits
    .map((circuit) => `COPY ${config.circuitArtifactsDir}/${circuit}/ /app/circuits/${circuit}/`)
    .join('\n');

  return `# Multi-stage Dockerfile for Nitro Enclave

# Stage 1: Build stage - copy circuit artifacts
FROM node:20-slim AS build

WORKDIR /app

# Copy circuit artifacts for all specified circuits
${circuitCopies}

# Stage 2: Runtime stage - minimal image with prover binary
FROM node:20-slim

WORKDIR /app

# Copy circuit artifacts from build stage
COPY --from=build /app/circuits /app/circuits

# Copy prover binary
COPY ${config.proverBinaryPath} /app/prover

# Set executable permissions
RUN chmod +x /app/prover

# Expose vsock port
EXPOSE 5000

# Start prover service
CMD ["/app/prover"]
`;
}
