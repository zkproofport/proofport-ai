import { describe, expect, it } from 'vitest';
import request from 'supertest';
import express from 'express';
import type { Config } from '../../src/config/index.js';
import { buildAgentCard, buildMcpDiscovery, buildOasfAgent, buildSkillMd, getAgentRegistrationHandler, getOasfAgentHandler } from '../../src/a2a/agentCard.js';

const config = {
  teeMode: 'local', teeAttestationEnabled: true, paymentNetworks: 'base-sepolia,arc-testnet-nano',
  paymentMode: 'testnet', paymentProofPrice: '$0.07', a2aBaseUrl: 'https://proof.example.com',
  websiteUrl: 'https://example.com', chainRpcUrl: 'https://sepolia.base.org',
  erc8004IdentityAddress: '0x0000000000000000000000000000000000000011',
  ethereumRpcUrl: 'https://eth.example.com', arcRpcUrl: 'https://arc.example.com', arcChainId: 5042002,
  arcIdentityAddress: '0x0000000000000000000000000000000000000022',
  proverPrivateKey: '0x' + '11'.repeat(32), agentVersion: '1.0.0',
} as Config;

describe('deployment discovery metadata', () => {
  it.each(['local', 'disabled'] as const)('never advertises hardware Nitro trust for %s execution', (teeMode) => {
    const current = { ...config, teeMode };
    const card = buildAgentCard(current);
    const mcp = buildMcpDiscovery(current);
    const oasf = buildOasfAgent(current);
    const skill = buildSkillMd(current);
    for (const text of [JSON.stringify(card), JSON.stringify(mcp), JSON.stringify(oasf), skill]) {
      expect(text).not.toContain('AWS Nitro');
      expect(text).toContain('ZKProofport prover');
      expect(text).toContain('arc_eligibility');
      expect(text).toContain('arc-testnet-nano');
    }
    expect(card.tee).toBeUndefined();
    expect(mcp['x-tee']).toBeUndefined();
    expect(oasf.teeMetadata).toBeUndefined();
    expect(oasf.supportedTrust).not.toContain('tee-attestation');
  });

  it('advertises Nitro and attestation only for their actual configuration', () => {
    const current = { ...config, teeMode: 'nitro' as const };
    expect(buildAgentCard(current).tee?.attestationFormat).toBe('aws-nitro-nsm');
    expect(buildOasfAgent(current).supportedTrust).toContain('tee-attestation');
    expect(buildSkillMd(current)).toContain('AWS Nitro Enclave');
    expect(buildOasfAgent({ ...current, teeAttestationEnabled: false }).supportedTrust).not.toContain('tee-attestation');
  });

  it('rejects unknown or empty payment network configuration', () => {
    expect(() => buildAgentCard({ ...config, paymentNetworks: 'unknown-chain' })).toThrow(/unknown/i);
    expect(() => buildSkillMd({ ...config, paymentNetworks: '' })).toThrow();
  });

  it('publishes separate Base and Arc registry addresses in both discovery documents', async () => {
    const tokens = { chains: new Map([[84532, 2n], [5042002, 0n]]) };
    const app = express();
    app.get('/registration', getAgentRegistrationHandler(config, tokens));
    app.get('/oasf', getOasfAgentHandler(config, tokens));
    for (const endpoint of ['/registration', '/oasf']) {
      const response = await request(app).get(endpoint);
      expect(response.status).toBe(200);
      expect(response.body.registrations).toEqual([
        { agentId: 2, agentRegistry: `eip155:84532:${config.erc8004IdentityAddress}` },
        { agentId: 0, agentRegistry: `eip155:5042002:${config.arcIdentityAddress}` },
      ]);
    }
  });

  it('preserves the legacy empty-registration placeholder', async () => {
    const app = express();
    app.get('/', getAgentRegistrationHandler(config, { chains: new Map() }));
    const response = await request(app).get('/');
    expect(response.status).toBe(200);
    expect(response.body.registrations).toHaveLength(1);
    expect(response.body.registrations[0].agentId).toBeNull();
  });

  it.each([{ chainId: 999, tokenId: 1n }, { chainId: 5042002, tokenId: -1n }, { chainId: 5042002, tokenId: 9007199254740992n }])(
    'rejects unknown chain or unsafe token ID #%#', ({ chainId, tokenId }) => {
      const handler = getAgentRegistrationHandler(config, { chains: new Map([[chainId, tokenId]]) });
      expect(() => handler({} as never, {} as never)).toThrow();
    },
  );
});

describe('complete circuit discovery and deployment isolation', () => {
  const circuits = ['coinbase_attestation', 'coinbase_country_attestation', 'oidc_domain_attestation', 'arc_eligibility', 'giwa_attestation'];

  it('links every canonical guide on A2A, MCP, OASF and SKILL discovery', () => {
    const guides = [buildAgentCard(config).guides, buildMcpDiscovery(config)['x-guides'], buildOasfAgent(config).guides];
    for (const circuit of circuits) {
      const link = `${config.a2aBaseUrl}/api/v1/guide/${circuit}`;
      for (const guide of guides) expect(guide).toHaveProperty(circuit, link);
      expect(buildSkillMd(config)).toContain(link);
    }
  });

  it('describes optional action binding for both Arc and GIWA without forcing Coinbase witnesses on OIDC', () => {
    const card = buildAgentCard(config);
    const mcp = buildMcpDiscovery(config);
    for (const text of [card.skills[0].description, mcp.tools[0].description, buildSkillMd(config)]) {
      expect(text).toContain('giwa_attestation');
      expect(text).toMatch(/optional/i);
      expect(text).not.toContain('action (required)');
      expect(text).not.toContain('arc_eligibility additionally requires');
    }
    expect(mcp.tools[0].inputSchema.properties.inputs).not.toHaveProperty('required');
  });

  it.each([
    ['staging', config, [11155111, 84532, 5042002], 'proveragent.sepolia', 3288n],
    ['production', { ...config, chainRpcUrl: 'https://mainnet.base.org', ethereumRpcUrl: 'https://ethereum.example.com', arcRpcUrl: '', a2aBaseUrl: 'https://ai.zkproofport.app', paymentNetworks: 'base', erc8004IdentityAddress: '0x0000000000000000000000000000000000000033' }, [1, 8453], 'proveragent.eth', 99n],
  ] as const)('%s publishes only its configured names, registries and tokens', async (_name, current, chainIds, agentName, tokenId) => {
    const { getChainIdentities } = await import('../../src/config/index.js');
    expect(getChainIdentities(current).map(chain => chain.chainId)).toEqual(chainIds);
    const card = buildAgentCard(current, tokenId);
    const oasf = buildOasfAgent(current, tokenId);
    expect(card.name).toBe(agentName);
    expect(buildMcpDiscovery(current).serverInfo.name).toBe(agentName);
    expect(oasf.name).toBe(agentName);
    expect(card.identity?.erc8004).toEqual({ chainId: chainIds[0], contractAddress: current.erc8004IdentityAddress, tokenId: tokenId.toString() });
    expect(oasf.registrations).toEqual([{ agentId: Number(tokenId), agentRegistry: `eip155:${chainIds[0]}:${current.erc8004IdentityAddress}` }]);
    expect(oasf.services.some(service => service.name === 'ENS')).toBe(false);
    const app = express();
    const tokens = { chains: new Map(chainIds.map(chainId => [chainId, tokenId])) };
    app.get('/', getAgentRegistrationHandler(current, tokens));
    const response = await request(app).get('/');
    expect(response.body.registrations.map((row: { agentRegistry: string }) => Number(row.agentRegistry.split(':')[1]))).toEqual(chainIds);
    if (_name === 'production') {
      expect(JSON.stringify(response.body)).not.toMatch(/11155111|84532|5042002|3288/);
      expect(JSON.stringify(card)).not.toContain('stg-ai');
      expect(JSON.stringify(oasf)).not.toContain('sepolia');
    }
  });

  it('refuses to publish a staging token map under production configuration', () => {
    const production = { ...config, chainRpcUrl: 'https://mainnet.base.org', arcRpcUrl: '' };
    const handler = getAgentRegistrationHandler(production, { chains: new Map([[84532, 592n]]) });
    expect(() => handler({} as never, {} as never)).toThrow('Unknown registered chain 84532');
  });
});
