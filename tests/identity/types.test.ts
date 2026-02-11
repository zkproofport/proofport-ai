import { describe, it, expect } from 'vitest';
import type { AgentMetadata, AgentRegistrationConfig, AgentRegistrationResult, AgentIdentityInfo } from '../../src/identity/types.js';

describe('Identity Types', () => {
  describe('AgentMetadata', () => {
    it('should have required string fields', () => {
      const metadata: AgentMetadata = {
        name: 'Test Agent',
        description: 'Test description',
        agentUrl: 'https://ai.zkproofport.app',
        capabilities: ['generate_proof', 'verify_proof'],
        protocols: ['mcp', 'a2a'],
        circuits: ['coinbase_attestation'],
      };

      expect(metadata.name).toBe('Test Agent');
      expect(metadata.description).toBe('Test description');
      expect(metadata.agentUrl).toBe('https://ai.zkproofport.app');
      expect(metadata.capabilities).toEqual(['generate_proof', 'verify_proof']);
      expect(metadata.protocols).toEqual(['mcp', 'a2a']);
      expect(metadata.circuits).toEqual(['coinbase_attestation']);
      expect(metadata.tee).toBeUndefined();
    });

    it('should support optional tee field', () => {
      const metadata: AgentMetadata = {
        name: 'TEE Agent',
        description: 'TEE-enabled agent',
        agentUrl: 'https://ai.zkproofport.app',
        capabilities: [],
        protocols: [],
        circuits: [],
        tee: 'aws-nitro',
      };

      expect(metadata.tee).toBe('aws-nitro');
    });

    it('should allow empty arrays', () => {
      const metadata: AgentMetadata = {
        name: 'Minimal Agent',
        description: 'Minimal',
        agentUrl: 'https://example.com',
        capabilities: [],
        protocols: [],
        circuits: [],
      };

      expect(metadata.capabilities).toHaveLength(0);
      expect(metadata.protocols).toHaveLength(0);
      expect(metadata.circuits).toHaveLength(0);
    });
  });

  describe('AgentRegistrationConfig', () => {
    it('should have all required config fields', () => {
      const config: AgentRegistrationConfig = {
        identityContractAddress: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
        reputationContractAddress: '0x8004B663056A597Dffe9eCcC1965A193B7388713',
        chainRpcUrl: 'https://sepolia.base.org',
        privateKey: '0x1234567890123456789012345678901234567890123456789012345678901234',
      };

      expect(config.identityContractAddress).toBe('0x8004A818BFB912233c491871b3d84c89A494BD9e');
      expect(config.reputationContractAddress).toBe('0x8004B663056A597Dffe9eCcC1965A193B7388713');
      expect(config.chainRpcUrl).toBe('https://sepolia.base.org');
      expect(config.privateKey).toBe('0x1234567890123456789012345678901234567890123456789012345678901234');
    });
  });

  describe('AgentRegistrationResult', () => {
    it('should have tokenId, transactionHash, and agentAddress', () => {
      const result: AgentRegistrationResult = {
        tokenId: 1n,
        transactionHash: '0xabcd1234',
        agentAddress: '0x1234567890123456789012345678901234567890',
      };

      expect(result.tokenId).toBe(1n);
      expect(result.transactionHash).toBe('0xabcd1234');
      expect(result.agentAddress).toBe('0x1234567890123456789012345678901234567890');
    });

    it('should support large tokenId values', () => {
      const result: AgentRegistrationResult = {
        tokenId: 999999999999999999n,
        transactionHash: '0xhash',
        agentAddress: '0xaddr',
      };

      expect(result.tokenId).toBe(999999999999999999n);
    });
  });

  describe('AgentIdentityInfo', () => {
    it('should have all identity fields', () => {
      const info: AgentIdentityInfo = {
        tokenId: 42n,
        owner: '0x1234567890123456789012345678901234567890',
        metadataUri: 'data:application/json;base64,eyJuYW1lIjoiVGVzdCJ9',
        isRegistered: true,
      };

      expect(info.tokenId).toBe(42n);
      expect(info.owner).toBe('0x1234567890123456789012345678901234567890');
      expect(info.metadataUri).toContain('data:application/json;base64,');
      expect(info.isRegistered).toBe(true);
    });

    it('should support unregistered state', () => {
      const info: AgentIdentityInfo = {
        tokenId: 0n,
        owner: '0x0000000000000000000000000000000000000000',
        metadataUri: '',
        isRegistered: false,
      };

      expect(info.isRegistered).toBe(false);
      expect(info.tokenId).toBe(0n);
    });
  });
});
