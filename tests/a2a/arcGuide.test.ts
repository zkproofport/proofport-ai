import { describe, expect, it } from 'vitest';
import type { Config } from '../../src/config/index.js';
import { buildGuide } from '../../src/proof/guideBuilder.js';
import { buildSkillMd } from '../../src/a2a/agentCard.js';

const config = {
  teeMode: 'local', teeAttestationEnabled: false, paymentNetworks: 'arc-testnet-nano',
  paymentMode: 'testnet', paymentProofPrice: '$0.001', a2aBaseUrl: 'https://stg-ai.zkproofport.app',
  agentVersion: '1.0.0', paymentPayTo: '0x' + '12'.repeat(20),
  arcRpcUrl: 'https://rpc.testnet.arc.network', arcChainId: 5042002,
  baseRpcUrl: 'https://mainnet.base.org', easGraphqlEndpoint: 'https://base.easscan.org/graphql',
} as Config;

describe('Arc discovery integration instructions', () => {
  it('describes one action-bound KYC proof with Arc verification and actual Gateway payment domain', () => {
    const guide = buildGuide('arc_eligibility', config) as any;
    expect(guide.e2e_encryption.enabled).toBe(false);
    expect(guide.constants.verification.chain_id).toBe(5042002);
    expect(guide.constants.verification.verifier_address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(guide.constants.x402.chains[0]).toMatchObject({network_name: 'arc-testnet-nano',
      eip712_domain: {name: 'GatewayWalletBatched', version: '1', chainId: 5042002,
        verifyingContract: '0x0077777d7EBA4688BDeF3E311b846F25870A19B9'}, settlement: 'gateway'});
    expect(guide.endpoints.guide.url).toBe(config.a2aBaseUrl + '/api/v1/guide/arc_eligibility');
    expect(guide.local_mcp_server.generate_proof).toMatchObject({circuit:'arc_eligibility',pay_with:'arc',pay_on:'arc-testnet-nano'});
    expect(guide.local_mcp_server.optional_arguments).toContain('action');
    expect(guide.sdk.quick_start).toContain('walletFromArcAgent');
    expect(guide.sdk.quick_start).toContain('action');
    expect(JSON.stringify(guide)).not.toMatch(/coinbase_country|NOT_DEPLOYED|PAYMENT_KEY/);
  });

  it('requires encryption in Nitro even when optional attestation output is disabled', () => {
    const guide=buildGuide('arc_eligibility',{...config,teeMode:'nitro',teeAttestationEnabled:false}) as any;
    expect(guide.e2e_encryption.enabled).toBe(true);
  });

  it('keeps verification independent of the first offered payment chain', () => {
    const guide = buildGuide('arc_eligibility', {...config,paymentNetworks:'base-sepolia,arc-testnet-nano'}) as any;
    expect(guide.constants.verification.chain_id).toBe(5042002);
    expect(guide.constants.x402.chains.map((n:any)=>n.network_name)).toEqual(['base-sepolia','arc-testnet-nano']);
  });

  it('fails unknown circuits and does not invent a nanopayment offer', () => {
    expect(()=>buildGuide('unknown' as never,config)).toThrow(/unknown/i);
    const guide=buildGuide('arc_eligibility',{...config,paymentNetworks:'base-sepolia'}) as any;
    expect(guide.local_mcp_server.generate_proof).not.toHaveProperty('pay_on');
    expect(guide.constants.x402.chains).toHaveLength(1);
  });

  it('publishes live local MCP names and signature headers, without obsolete payment-key fallbacks', () => {
    const skill=buildSkillMd(config);
    expect(skill).toContain('PAYMENT-SIGNATURE');
    expect(skill).toContain('tools/list');
    expect(skill).toContain('generate_proof');
    expect(skill).toContain('pay_with');
    expect(skill).toContain('arc-testnet-nano');
    expect(skill).toContain('/api/v1/guide/arc_eligibility');
    expect(skill).not.toMatch(/X-Payment-TX|PAYMENT_KEY|make_payment|AWS Nitro/);
  });
});
