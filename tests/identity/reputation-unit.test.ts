import { describe, it, expect } from 'vitest';
import type { AgentReputationConfig } from '../../src/identity/types.js';

describe('AgentReputation Unit Tests', () => {
  describe('Constructor validation', () => {
    it('should throw if reputationContractAddress missing', async () => {
      const { AgentReputation } = await import('../../src/identity/reputation.js');

      const config = {
        chainRpcUrl: 'https://sepolia.base.org',
        privateKey: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
      } as AgentReputationConfig;

      expect(() => new AgentReputation(config)).toThrow(/reputationContractAddress.*required/i);
    });

    it('should throw if chainRpcUrl missing', async () => {
      const { AgentReputation } = await import('../../src/identity/reputation.js');

      const config = {
        reputationContractAddress: '0x8004B663056A597Dffe9eCcC1965A193B7388713',
        privateKey: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
      } as AgentReputationConfig;

      expect(() => new AgentReputation(config)).toThrow(/chainRpcUrl.*required/i);
    });

    it('should throw if privateKey missing', async () => {
      const { AgentReputation } = await import('../../src/identity/reputation.js');

      const config = {
        reputationContractAddress: '0x8004B663056A597Dffe9eCcC1965A193B7388713',
        chainRpcUrl: 'https://sepolia.base.org',
      } as AgentReputationConfig;

      expect(() => new AgentReputation(config)).toThrow(/privateKey.*required/i);
    });

    it('should create instance with valid config', async () => {
      const { AgentReputation } = await import('../../src/identity/reputation.js');

      const config: AgentReputationConfig = {
        reputationContractAddress: '0x8004B663056A597Dffe9eCcC1965A193B7388713',
        chainRpcUrl: 'https://sepolia.base.org',
        privateKey: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
      };

      const reputation = new AgentReputation(config);
      expect(reputation).toBeDefined();
      expect(reputation.agentAddress).toBeDefined();
      expect(typeof reputation.agentAddress).toBe('string');
      expect(reputation.agentAddress).toMatch(/^0x[a-fA-F0-9]{40}$/);
    });
  });

  describe('Type exports', () => {
    it('should export AgentReputation class', async () => {
      const module = await import('../../src/identity/reputation.js');
      expect(module.AgentReputation).toBeDefined();
      expect(typeof module.AgentReputation).toBe('function');
    });
  });

  describe('Method existence', () => {
    it('should have incrementScore method', async () => {
      const { AgentReputation } = await import('../../src/identity/reputation.js');

      const config: AgentReputationConfig = {
        reputationContractAddress: '0x8004B663056A597Dffe9eCcC1965A193B7388713',
        chainRpcUrl: 'https://sepolia.base.org',
        privateKey: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
      };

      const reputation = new AgentReputation(config);
      expect(typeof reputation.incrementScore).toBe('function');
    });

    it('should have getScore method', async () => {
      const { AgentReputation } = await import('../../src/identity/reputation.js');

      const config: AgentReputationConfig = {
        reputationContractAddress: '0x8004B663056A597Dffe9eCcC1965A193B7388713',
        chainRpcUrl: 'https://sepolia.base.org',
        privateKey: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
      };

      const reputation = new AgentReputation(config);
      expect(typeof reputation.getScore).toBe('function');
    });

    it('should have getReputationDetails method', async () => {
      const { AgentReputation } = await import('../../src/identity/reputation.js');

      const config: AgentReputationConfig = {
        reputationContractAddress: '0x8004B663056A597Dffe9eCcC1965A193B7388713',
        chainRpcUrl: 'https://sepolia.base.org',
        privateKey: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
      };

      const reputation = new AgentReputation(config);
      expect(typeof reputation.getReputationDetails).toBe('function');
    });

    it('should have agentAddress getter', async () => {
      const { AgentReputation } = await import('../../src/identity/reputation.js');

      const config: AgentReputationConfig = {
        reputationContractAddress: '0x8004B663056A597Dffe9eCcC1965A193B7388713',
        chainRpcUrl: 'https://sepolia.base.org',
        privateKey: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
      };

      const reputation = new AgentReputation(config);
      expect(reputation.agentAddress).toBeDefined();
    });
  });
});
