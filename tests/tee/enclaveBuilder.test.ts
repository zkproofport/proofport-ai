import { describe, it, expect } from 'vitest';
import {
  validateEnclaveImageConfig,
  generateBuildCommands,
  generateDockerfileContent,
} from '../../src/tee/enclaveBuilder.js';
import type { EnclaveImageConfig } from '../../src/tee/types.js';

describe('Enclave Builder', () => {
  describe('validateEnclaveImageConfig', () => {
    it('should pass for valid config', () => {
      const config: EnclaveImageConfig = {
        circuits: ['coinbase_attestation'],
        proverBinaryPath: '/app/prover',
        circuitArtifactsDir: '/app/circuits',
        outputPath: '/build/enclave.eif',
      };
      expect(() => validateEnclaveImageConfig(config)).not.toThrow();
    });

    it('should throw if circuits array is empty', () => {
      const config: EnclaveImageConfig = {
        circuits: [],
        proverBinaryPath: '/app/prover',
        circuitArtifactsDir: '/app/circuits',
        outputPath: '/build/enclave.eif',
      };
      expect(() => validateEnclaveImageConfig(config)).toThrow(/circuits.*empty/i);
    });

    it('should throw if proverBinaryPath is empty', () => {
      const config: EnclaveImageConfig = {
        circuits: ['coinbase_attestation'],
        proverBinaryPath: '',
        circuitArtifactsDir: '/app/circuits',
        outputPath: '/build/enclave.eif',
      };
      expect(() => validateEnclaveImageConfig(config)).toThrow(/proverBinaryPath.*empty/i);
    });

    it('should throw if circuitArtifactsDir is empty', () => {
      const config: EnclaveImageConfig = {
        circuits: ['coinbase_attestation'],
        proverBinaryPath: '/app/prover',
        circuitArtifactsDir: '',
        outputPath: '/build/enclave.eif',
      };
      expect(() => validateEnclaveImageConfig(config)).toThrow(/circuitArtifactsDir.*empty/i);
    });

    it('should throw if outputPath is empty', () => {
      const config: EnclaveImageConfig = {
        circuits: ['coinbase_attestation'],
        proverBinaryPath: '/app/prover',
        circuitArtifactsDir: '/app/circuits',
        outputPath: '',
      };
      expect(() => validateEnclaveImageConfig(config)).toThrow(/outputPath.*empty/i);
    });

    it('should throw if outputPath does not end with .eif', () => {
      const config: EnclaveImageConfig = {
        circuits: ['coinbase_attestation'],
        proverBinaryPath: '/app/prover',
        circuitArtifactsDir: '/app/circuits',
        outputPath: '/build/enclave.img',
      };
      expect(() => validateEnclaveImageConfig(config)).toThrow(/outputPath.*\.eif/i);
    });

    it('should pass for multiple circuits', () => {
      const config: EnclaveImageConfig = {
        circuits: ['coinbase_attestation', 'coinbase_country_attestation'],
        proverBinaryPath: '/app/prover',
        circuitArtifactsDir: '/app/circuits',
        outputPath: '/build/enclave.eif',
      };
      expect(() => validateEnclaveImageConfig(config)).not.toThrow();
    });
  });

  describe('generateBuildCommands', () => {
    it('should generate docker build and nitro-cli commands', () => {
      const config: EnclaveImageConfig = {
        circuits: ['coinbase_attestation'],
        proverBinaryPath: '/app/prover',
        circuitArtifactsDir: '/app/circuits',
        outputPath: '/build/enclave.eif',
      };
      const commands = generateBuildCommands(config);

      expect(commands).toHaveLength(2);
      expect(commands[0]).toContain('docker build');
      expect(commands[0]).toContain('-t proofport-prover-enclave');
      expect(commands[0]).toContain('-f Dockerfile.enclave');
      expect(commands[1]).toContain('nitro-cli build-enclave');
      expect(commands[1]).toContain('--docker-uri proofport-prover-enclave');
      expect(commands[1]).toContain('--output-file /build/enclave.eif');
    });

    it('should use correct outputPath in commands', () => {
      const config: EnclaveImageConfig = {
        circuits: ['coinbase_attestation'],
        proverBinaryPath: '/app/prover',
        circuitArtifactsDir: '/app/circuits',
        outputPath: '/custom/path/my-enclave.eif',
      };
      const commands = generateBuildCommands(config);

      expect(commands[1]).toContain('--output-file /custom/path/my-enclave.eif');
    });

    it('should return commands in correct order', () => {
      const config: EnclaveImageConfig = {
        circuits: ['coinbase_attestation'],
        proverBinaryPath: '/app/prover',
        circuitArtifactsDir: '/app/circuits',
        outputPath: '/build/enclave.eif',
      };
      const commands = generateBuildCommands(config);

      // Docker build must come before nitro-cli
      expect(commands[0]).toMatch(/^docker build/);
      expect(commands[1]).toMatch(/^nitro-cli build-enclave/);
    });
  });

  describe('generateDockerfileContent', () => {
    it('should generate valid Dockerfile content', () => {
      const config: EnclaveImageConfig = {
        circuits: ['coinbase_attestation'],
        proverBinaryPath: '/app/prover',
        circuitArtifactsDir: '/app/circuits',
        outputPath: '/build/enclave.eif',
      };
      const content = generateDockerfileContent(config);

      expect(content).toContain('FROM');
      expect(content).toContain('COPY');
      expect(content).toContain('/app/prover');
      expect(content).toContain('/app/circuits');
    });

    it('should include prover binary path', () => {
      const config: EnclaveImageConfig = {
        circuits: ['coinbase_attestation'],
        proverBinaryPath: '/custom/prover-bin',
        circuitArtifactsDir: '/app/circuits',
        outputPath: '/build/enclave.eif',
      };
      const content = generateDockerfileContent(config);

      expect(content).toContain('/custom/prover-bin');
    });

    it('should include circuit artifacts directory', () => {
      const config: EnclaveImageConfig = {
        circuits: ['coinbase_attestation'],
        proverBinaryPath: '/app/prover',
        circuitArtifactsDir: '/custom/circuits',
        outputPath: '/build/enclave.eif',
      };
      const content = generateDockerfileContent(config);

      expect(content).toContain('/custom/circuits');
    });

    it('should include all specified circuits', () => {
      const config: EnclaveImageConfig = {
        circuits: ['coinbase_attestation', 'coinbase_country_attestation'],
        proverBinaryPath: '/app/prover',
        circuitArtifactsDir: '/app/circuits',
        outputPath: '/build/enclave.eif',
      };
      const content = generateDockerfileContent(config);

      expect(content).toContain('coinbase_attestation');
      expect(content).toContain('coinbase_country_attestation');
    });

    it('should have multi-stage build structure', () => {
      const config: EnclaveImageConfig = {
        circuits: ['coinbase_attestation'],
        proverBinaryPath: '/app/prover',
        circuitArtifactsDir: '/app/circuits',
        outputPath: '/build/enclave.eif',
      };
      const content = generateDockerfileContent(config);

      // Should have multiple FROM statements for multi-stage
      const fromCount = (content.match(/^FROM /gm) || []).length;
      expect(fromCount).toBeGreaterThanOrEqual(2);
    });

    it('should include Node.js runtime for prover', () => {
      const config: EnclaveImageConfig = {
        circuits: ['coinbase_attestation'],
        proverBinaryPath: '/app/prover',
        circuitArtifactsDir: '/app/circuits',
        outputPath: '/build/enclave.eif',
      };
      const content = generateDockerfileContent(config);

      expect(content).toMatch(/node/i);
    });

    it('should set executable permissions for prover binary', () => {
      const config: EnclaveImageConfig = {
        circuits: ['coinbase_attestation'],
        proverBinaryPath: '/app/prover',
        circuitArtifactsDir: '/app/circuits',
        outputPath: '/build/enclave.eif',
      };
      const content = generateDockerfileContent(config);

      expect(content).toMatch(/chmod.*\+x.*prover/i);
    });

    it('should expose vsock port', () => {
      const config: EnclaveImageConfig = {
        circuits: ['coinbase_attestation'],
        proverBinaryPath: '/app/prover',
        circuitArtifactsDir: '/app/circuits',
        outputPath: '/build/enclave.eif',
      };
      const content = generateDockerfileContent(config);

      expect(content).toContain('EXPOSE 5000');
    });

    it('should define CMD or ENTRYPOINT', () => {
      const config: EnclaveImageConfig = {
        circuits: ['coinbase_attestation'],
        proverBinaryPath: '/app/prover',
        circuitArtifactsDir: '/app/circuits',
        outputPath: '/build/enclave.eif',
      };
      const content = generateDockerfileContent(config);

      expect(content).toMatch(/^(CMD|ENTRYPOINT)/m);
    });
  });
});
