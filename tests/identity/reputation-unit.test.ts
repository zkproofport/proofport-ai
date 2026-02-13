import { describe, it, expect } from 'vitest';
import type { AgentReputationConfig } from '../../src/identity/types.js';

describe('AgentReputation Unit Tests', () => {
  describe('Constructor validation', () => {
    it('should throw if reputationContractAddress missing', async () => {
      const { AgentReputation } = await import('../../src/identity/reputation.js');

      const config = {
        chainRpcUrl: 'https://sepolia.base.org',
      } as AgentReputationConfig;

      expect(() => new AgentReputation(config)).toThrow(/reputationContractAddress.*required/i);
    });

    it('should throw if chainRpcUrl missing', async () => {
      const { AgentReputation } = await import('../../src/identity/reputation.js');

      const config = {
        reputationContractAddress: '0x8004B663056A597Dffe9eCcC1965A193B7388713',
      } as AgentReputationConfig;

      expect(() => new AgentReputation(config)).toThrow(/chainRpcUrl.*required/i);
    });

    it('should create instance with valid config', async () => {
      const { AgentReputation } = await import('../../src/identity/reputation.js');

      const config: AgentReputationConfig = {
        reputationContractAddress: '0x8004B663056A597Dffe9eCcC1965A193B7388713',
        chainRpcUrl: 'https://sepolia.base.org',
      };

      const reputation = new AgentReputation(config);
      expect(reputation).toBeDefined();
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
    it('should have getAverageScore method', async () => {
      const { AgentReputation } = await import('../../src/identity/reputation.js');

      const config: AgentReputationConfig = {
        reputationContractAddress: '0x8004B663056A597Dffe9eCcC1965A193B7388713',
        chainRpcUrl: 'https://sepolia.base.org',
      };

      const reputation = new AgentReputation(config);
      expect(typeof reputation.getAverageScore).toBe('function');
    });

    it('should have getFeedbackCount method', async () => {
      const { AgentReputation } = await import('../../src/identity/reputation.js');

      const config: AgentReputationConfig = {
        reputationContractAddress: '0x8004B663056A597Dffe9eCcC1965A193B7388713',
        chainRpcUrl: 'https://sepolia.base.org',
      };

      const reputation = new AgentReputation(config);
      expect(typeof reputation.getFeedbackCount).toBe('function');
    });
  });
});
