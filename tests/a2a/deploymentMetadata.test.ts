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
