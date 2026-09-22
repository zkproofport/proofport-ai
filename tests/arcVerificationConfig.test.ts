import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, getChainIdentities, type Config } from '../src/config/index.js';
import { chooseVerificationTarget } from '../src/proof/proofRoutes.js';
import { buildGuide } from '../src/proof/guideBuilder.js';

const production = {
  chainRpcUrl: 'https://mainnet.base.org', ethereumRpcUrl: 'https://ethereum-rpc.publicnode.com',
  erc8004IdentityAddress: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
  arcRpcUrl: '', arcChainId: 0, arcIdentityAddress: '', arcAgentTokenId: '',
  arcVerificationRpcUrl: 'https://rpc.testnet.arc.io', arcVerificationChainId: 5042002,
  paymentMode: 'mainnet', paymentNetworks: 'base,ethereum', paymentProofPrice: '$0.001',
  paymentPayTo: '0x' + '12'.repeat(20), a2aBaseUrl: 'https://ai.zkproofport.app', teeMode: 'local',
} as Config;

describe('Arc proof verification is independent of published identities', () => {
  afterEach(() => vi.unstubAllEnvs());
  it('production offers an Arc proof verifier and guide while publishing only Ethereum and Base identities', () => {
    expect(getChainIdentities(production).map(identity => identity.chainId)).toEqual([1, 8453]);
    const target = chooseVerificationTarget(production, 'arc_eligibility', false);
    expect(target).toMatchObject({ chainId: 5042002, rpcUrl: production.arcVerificationRpcUrl });
    const guide = buildGuide('arc_eligibility', production) as any;
    expect(guide.constants.verification).toMatchObject({ chain_id: target!.chainId, rpc_url: target!.rpcUrl, verifier_address: target!.verifierAddress });
    expect(guide.constants.x402.chains.map((chain: any) => chain.network_name)).toEqual(['base', 'ethereum']);
  });
  it('explicit verification pair wins without altering legacy identity configuration', () => {
    const config = { ...production, arcRpcUrl: 'https://identity-rpc.example', arcChainId: 5042002, arcIdentityAddress: production.erc8004IdentityAddress };
    expect(chooseVerificationTarget(config, 'arc_eligibility', false)?.rpcUrl).toBe(production.arcVerificationRpcUrl);
    expect(getChainIdentities(config).find(identity => identity.chainId === 5042002)?.rpcUrl).toBe(config.arcRpcUrl);
  });
  it('keeps legacy paired settings when neither explicit verification setting exists', () => {
    const config = { ...production, arcVerificationRpcUrl: undefined, arcVerificationChainId: undefined, arcRpcUrl: 'https://legacy.arc.example', arcChainId: 5042002 };
    expect(chooseVerificationTarget(config, 'arc_eligibility', false)).toMatchObject({ chainId: 5042002, rpcUrl: config.arcRpcUrl });
    expect((buildGuide('arc_eligibility', config) as any).constants.verification.rpc_url).toBe(config.arcRpcUrl);
  });
  it.each([
    { arcVerificationRpcUrl: undefined, arcVerificationChainId: 5042002 },
    { arcVerificationRpcUrl: 'https://rpc.testnet.arc.io', arcVerificationChainId: undefined },
    { arcVerificationRpcUrl: '', arcVerificationChainId: 5042002 },
    { arcVerificationRpcUrl: 'https://rpc.testnet.arc.io', arcVerificationChainId: 0 },
    { arcVerificationRpcUrl: 'not-a-url', arcVerificationChainId: 5042002 },
    { arcVerificationRpcUrl: 'https://?', arcVerificationChainId: 5042002 },
  ])('rejects incomplete or invalid explicit pair instead of mixing in legacy values: %j', pair => {
    const config = { ...production, arcRpcUrl: 'https://legacy.arc.example', arcChainId: 5042002, ...pair };
    expect(() => chooseVerificationTarget(config, 'arc_eligibility', false)).toThrow(/ARC_VERIFICATION/);
    expect(() => buildGuide('arc_eligibility', config)).toThrow(/ARC_VERIFICATION/);
  });
  it('loads the separate verification variables and rejects a partial pair at startup', () => {
    for (const [name, value] of Object.entries({ REDIS_URL: 'redis://localhost', BASE_RPC_URL: 'https://mainnet.base.org', EAS_GRAPHQL_ENDPOINT: 'https://base.easscan.org/graphql', CHAIN_RPC_URL: 'https://mainnet.base.org', PROVER_PRIVATE_KEY: '0x' + '11'.repeat(32), A2A_BASE_URL: 'https://ai.zkproofport.app', PAYMENT_MODE: 'mainnet', PAYMENT_NETWORKS: 'base,ethereum', ARC_RPC_URL: '', ARC_CHAIN_ID: '', ARC_IDENTITY_ADDRESS: '', ARC_VERIFICATION_RPC_URL: 'https://rpc.testnet.arc.io', ARC_VERIFICATION_CHAIN_ID: '5042002' })) vi.stubEnv(name, value);
    expect(loadConfig()).toMatchObject({ arcVerificationRpcUrl: 'https://rpc.testnet.arc.io', arcVerificationChainId: 5042002, arcRpcUrl: '', arcChainId: 0 });
    vi.stubEnv('ARC_VERIFICATION_CHAIN_ID', undefined);
    expect(() => loadConfig()).toThrow(/ARC_VERIFICATION/);
  });
});
