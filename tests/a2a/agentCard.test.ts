import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Config } from '../../src/config';
import { ERC8004_ADDRESSES } from '../../src/config/contracts';

type RequestHandler = (req: any, res: any) => void | Promise<void>;

describe('A2A Agent Card', () => {
  let mockConfig: Config;

  beforeEach(() => {
    mockConfig = {
      port: 4002,
      nodeEnv: 'development',
      proverUrl: 'http://localhost:4003',
      bbPath: 'bb',
      nargoPath: 'nargo',
      circuitsDir: '/app/circuits',
      circuitsRepoUrl: 'https://raw.githubusercontent.com/zkproofport/circuits/main',
      redisUrl: 'redis://localhost:6379',
      baseRpcUrl: 'https://mainnet.base.org',
      easGraphqlEndpoint: 'https://base.easscan.org/graphql',
      chainRpcUrl: 'https://sepolia.base.org',
      nullifierRegistryAddress: '0x1234567890123456789012345678901234567890',
      proverPrivateKey: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
      paymentMode: 'disabled',
      a2aBaseUrl: 'https://ai-dev.zkproofport.app',
      websiteUrl: 'https://zkproofport.app',
      agentVersion: '1.2.3',
      paymentPayTo: '',
      paymentFacilitatorUrl: '',
      paymentProofPrice: '$0.10',
      privyAppId: '',
      privyApiSecret: '',
      privyApiUrl: '',
      signPageUrl: '',
      signingTtlSeconds: 300,
      teeMode: 'disabled',
      enclaveCid: undefined,
      enclavePort: 5000,
      teeAttestationEnabled: false,
      erc8004IdentityAddress: '',
      erc8004ReputationAddress: '',
      erc8004ValidationAddress: '',
      settlementChainRpcUrl: '',
      settlementPrivateKey: '',
      settlementOperatorAddress: '',
      settlementUsdcAddress: '',
    };
  });

  describe('buildAgentCard', () => {
    it('should return valid Agent Card JSON structure', async () => {
      const { buildAgentCard } = await import('../../src/a2a/agentCard');
      const card = buildAgentCard(mockConfig);

      expect(card).toBeDefined();
      expect(typeof card).toBe('object');
      expect(card).toHaveProperty('name');
      expect(card).toHaveProperty('description');
      expect(card).toHaveProperty('url');
      expect(card).toHaveProperty('version');
      expect(card).toHaveProperty('protocolVersion');
      expect(card).toHaveProperty('preferredTransport');
      expect(card).toHaveProperty('provider');
      expect(card).toHaveProperty('capabilities');
      expect(card).toHaveProperty('skills');
      expect(card).toHaveProperty('securitySchemes');
      expect(card).toHaveProperty('identity');
    });

    it('should have correct product name', async () => {
      const { buildAgentCard } = await import('../../src/a2a/agentCard');
      const card = buildAgentCard(mockConfig);

      expect(card.name).toBe('proveragent.eth');
    });

    it('should have preferredTransport set to JSONRPC', async () => {
      const { buildAgentCard } = await import('../../src/a2a/agentCard');
      const card = buildAgentCard(mockConfig);

      expect(card.preferredTransport).toBe('JSONRPC');
    });

    it('should have provider with organization and url', async () => {
      const { buildAgentCard } = await import('../../src/a2a/agentCard');
      const card = buildAgentCard(mockConfig);

      expect(card.provider).toBeDefined();
      expect(card.provider.organization).toBe('ZKProofport');
      expect(card.provider.url).toBe('https://zkproofport.app');
    });

    it('should use config.a2aBaseUrl for url field', async () => {
      const { buildAgentCard } = await import('../../src/a2a/agentCard');
      const card = buildAgentCard(mockConfig);

      expect(card.url).toBe('https://ai-dev.zkproofport.app/a2a');

      // Test with different base URL
      mockConfig.a2aBaseUrl = 'https://ai-staging.zkproofport.app';
      const card2 = buildAgentCard(mockConfig);
      expect(card2.url).toBe('https://ai-staging.zkproofport.app/a2a');
    });

    it('should use config.agentVersion for version field', async () => {
      const { buildAgentCard } = await import('../../src/a2a/agentCard');
      const card = buildAgentCard(mockConfig);

      expect(card.version).toBe('1.2.3');

      // Test with different version
      mockConfig.agentVersion = '2.0.0';
      const card2 = buildAgentCard(mockConfig);
      expect(card2.version).toBe('2.0.0');
    });

    it('should have skills array with generate_proof skill', async () => {
      const { buildAgentCard } = await import('../../src/a2a/agentCard');
      const card = buildAgentCard(mockConfig);

      expect(Array.isArray(card.skills)).toBe(true);
      expect(card.skills.length).toBeGreaterThanOrEqual(1);

      const generateProofSkill = card.skills.find(s => s.id === 'generate_proof');
      expect(generateProofSkill).toBeDefined();
      expect(generateProofSkill?.name).toBe('Generate ZK Proof');
      expect(generateProofSkill?.description).toContain('zero-knowledge proof');
      expect(generateProofSkill?.inputModes).toContain('application/json');
      expect(generateProofSkill?.outputModes).toContain('application/json');
    });

    it('should have skills array with verify_proof skill', async () => {
      const { buildAgentCard } = await import('../../src/a2a/agentCard');
      const card = buildAgentCard(mockConfig);

      const verifyProofSkill = card.skills.find(s => s.id === 'verify_proof');
      expect(verifyProofSkill).toBeDefined();
      expect(verifyProofSkill?.name).toBe('Verify ZK Proof');
      expect(verifyProofSkill?.description.toLowerCase()).toContain('verify');
      expect(verifyProofSkill?.inputModes).toContain('application/json');
      expect(verifyProofSkill?.outputModes).toContain('application/json');
    });

    it('should have skills array with get_supported_circuits skill', async () => {
      const { buildAgentCard } = await import('../../src/a2a/agentCard');
      const card = buildAgentCard(mockConfig);

      const getCircuitsSkill = card.skills.find(s => s.id === 'get_supported_circuits');
      expect(getCircuitsSkill).toBeDefined();
      expect(getCircuitsSkill?.name).toBe('Get Supported Circuits');
      expect(getCircuitsSkill?.description).toContain('circuits');
      expect(getCircuitsSkill?.inputModes).toContain('application/json');
      expect(getCircuitsSkill?.outputModes).toContain('application/json');
    });

    it('should have all required skill fields including tags and examples', async () => {
      const { buildAgentCard } = await import('../../src/a2a/agentCard');
      const card = buildAgentCard(mockConfig);

      for (const skill of card.skills) {
        expect(skill).toHaveProperty('id');
        expect(skill).toHaveProperty('name');
        expect(skill).toHaveProperty('description');
        expect(skill).toHaveProperty('tags');
        expect(skill).toHaveProperty('examples');
        expect(skill).toHaveProperty('inputModes');
        expect(skill).toHaveProperty('outputModes');
        expect(typeof skill.id).toBe('string');
        expect(typeof skill.name).toBe('string');
        expect(typeof skill.description).toBe('string');
        expect(Array.isArray(skill.tags)).toBe(true);
        expect(Array.isArray(skill.examples)).toBe(true);
        expect(Array.isArray(skill.inputModes)).toBe(true);
        expect(Array.isArray(skill.outputModes)).toBe(true);
      }
    });

    it('should have capabilities.streaming set to true', async () => {
      const { buildAgentCard } = await import('../../src/a2a/agentCard');
      const card = buildAgentCard(mockConfig);

      expect(card.capabilities).toBeDefined();
      expect(card.capabilities.streaming).toBe(true);
    });

    it('should have capabilities.pushNotifications set to false', async () => {
      const { buildAgentCard } = await import('../../src/a2a/agentCard');
      const card = buildAgentCard(mockConfig);

      expect(card.capabilities.pushNotifications).toBe(false);
    });

    it('should have capabilities.stateTransitionHistory set to true', async () => {
      const { buildAgentCard } = await import('../../src/a2a/agentCard');
      const card = buildAgentCard(mockConfig);

      expect(card.capabilities.stateTransitionHistory).toBe(true);
    });

    it('should have securitySchemes containing x402', async () => {
      const { buildAgentCard } = await import('../../src/a2a/agentCard');
      const card = buildAgentCard(mockConfig);

      expect(card.securitySchemes).toBeDefined();
      expect(card.securitySchemes.x402).toBeDefined();
      expect(card.securitySchemes.x402.scheme).toBe('x402');
      expect(card.securitySchemes.x402.description).toBeDefined();
      expect(typeof card.securitySchemes.x402.description).toBe('string');
    });

    it('should use sepolia ERC-8004 address for development', async () => {
      const { buildAgentCard } = await import('../../src/a2a/agentCard');
      mockConfig.nodeEnv = 'development';
      const card = buildAgentCard(mockConfig);

      expect(card.identity).toBeDefined();
      expect(card.identity.erc8004).toBeDefined();
      expect(card.identity.erc8004.contractAddress).toBe(ERC8004_ADDRESSES.sepolia.identity);
      expect(card.identity.erc8004.chainId).toBe(84532); // Base Sepolia
      expect(card.identity.erc8004.tokenId).toBe(null);
    });

    it('should use mainnet ERC-8004 address for production', async () => {
      const { buildAgentCard } = await import('../../src/a2a/agentCard');
      mockConfig.nodeEnv = 'production';
      const card = buildAgentCard(mockConfig);

      expect(card.identity.erc8004.contractAddress).toBe(ERC8004_ADDRESSES.mainnet.identity);
      expect(card.identity.erc8004.chainId).toBe(8453); // Base Mainnet
      expect(card.identity.erc8004.tokenId).toBe(null);
    });

    it('should have proper description mentioning zero-knowledge and Coinbase', async () => {
      const { buildAgentCard } = await import('../../src/a2a/agentCard');
      const card = buildAgentCard(mockConfig);

      expect(card.description).toBeDefined();
      expect(typeof card.description).toBe('string');
      expect(card.description.toLowerCase()).toContain('zero-knowledge');
      expect(card.description.toLowerCase()).toContain('coinbase');
    });
  });

  describe('getAgentCardHandler', () => {
    it('should return an Express request handler', async () => {
      const { getAgentCardHandler } = await import('../../src/a2a/agentCard');
      const handler = getAgentCardHandler(mockConfig);

      expect(handler).toBeDefined();
      expect(typeof handler).toBe('function');
    });

    it('should set Content-Type to application/json', async () => {
      const { getAgentCardHandler } = await import('../../src/a2a/agentCard');
      const handler = getAgentCardHandler(mockConfig);

      const mockReq = {};
      const mockRes = {
        setHeader: vi.fn(),
        json: vi.fn(),
      };

      await handler(mockReq, mockRes);

      expect(mockRes.setHeader).toHaveBeenCalledWith('Content-Type', 'application/json');
    });

    it('should respond with the agent card JSON', async () => {
      const { getAgentCardHandler, buildAgentCard } = await import('../../src/a2a/agentCard');
      const handler = getAgentCardHandler(mockConfig);

      const mockReq = {};
      const mockRes = {
        setHeader: vi.fn(),
        json: vi.fn(),
      };

      await handler(mockReq, mockRes);

      const expectedCard = buildAgentCard(mockConfig);
      expect(mockRes.json).toHaveBeenCalledWith(expectedCard);
    });

    it('should produce valid JSON-serializable output', async () => {
      const { getAgentCardHandler } = await import('../../src/a2a/agentCard');
      const handler = getAgentCardHandler(mockConfig);

      const mockReq = {};
      let capturedResponse: any;
      const mockRes = {
        setHeader: vi.fn(),
        json: vi.fn((data) => {
          capturedResponse = data;
        }),
      };

      await handler(mockReq, mockRes);

      // Should be able to serialize to JSON and back
      expect(() => JSON.stringify(capturedResponse)).not.toThrow();
      const parsed = JSON.parse(JSON.stringify(capturedResponse));
      expect(parsed).toEqual(capturedResponse);
    });
  });
});
