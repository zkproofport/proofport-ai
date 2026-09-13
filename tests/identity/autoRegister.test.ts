import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Config } from '../../src/config/index.js';

const state = vi.hoisted(() => ({
  instances: [] as any[], registered: false, fail: '' as string,
  metadata: new Map<string, any>(),
}));
vi.mock('../../src/identity/register.js', () => {
  class AgentRegistration {
    agentAddress = '0x1234567890123456789012345678901234567890';
    constructor(public config: any) { state.instances.push(this); }
    isRegistered = vi.fn(async () => { if (state.fail === 'rpc') throw new Error('RPC down'); return state.registered; });
    getRegistration = vi.fn(async (cached?: bigint) => {
      if (state.fail === 'unresolved') throw new Error('token unresolved');
      if (state.fail === 'null') return null;
      return { tokenId: cached ?? 42n, owner: this.agentAddress, isRegistered: true, metadataUri: JSON.stringify(state.metadata.get(this.config.chainRpcUrl) ?? {}) };
    });
    assertTokenOwner = vi.fn(async () => { if (state.fail === 'owner') throw new Error('wrong owner'); });
    register = vi.fn(async () => ({ tokenId: 42n, transactionHash: '0xmint', agentAddress: this.agentAddress }));
    updateMetadata = vi.fn(async (_: bigint, metadata: any) => {
      if (state.fail === 'write') throw new Error('write reverted');
      state.metadata.set(this.config.chainRpcUrl, metadata); return '0xupdate';
    });
    getTokenMetadata = vi.fn(async () => JSON.stringify(state.fail === 'readback' ? {} : state.metadata.get(this.config.chainRpcUrl)));
    getOnchainMetadata = vi.fn(async () => state.fail === 'active' ? 'false' : 'true');
    setOnchainMetadata = vi.fn(async () => { throw new Error('active reverted'); });
  }
  return { AgentRegistration, parseMetadataUri: (uri: string) => JSON.parse(uri) };
});
vi.mock('../../src/identity/registrationLock.js', () => ({ withRegistrationLock: (_url: string, _key: string, run: () => Promise<unknown>) => run() }));
import { ensureAgentRegistered } from '../../src/identity/autoRegister.js';
import { getChainIdentities } from '../../src/config/index.js';

const config = {
  erc8004IdentityAddress: '', erc8004ReputationAddress: '', chainRpcUrl: 'https://sepolia.base.org',
  ethereumRpcUrl: '', agentTokenId: '', agentTokenIdEthereum: '', teeMode: 'local',
  proverPrivateKey: '0x' + '12'.repeat(32), a2aBaseUrl: 'https://stg-ai.zkproofport.app',
  arcRpcUrl: 'https://rpc.testnet.arc.io', arcChainId: 5042002,
  arcIdentityAddress: '0x8004A818BFB912233c491871b3d84c89A494BD9e', arcAgentTokenId: '',
} as Config;

beforeEach(() => { state.instances.length = 0; state.registered = false; state.fail = ''; state.metadata.clear(); });

describe('Arc deployment registration', () => {
  it('registers Arc without unrelated Base or reputation registry configuration', async () => {
    expect(getChainIdentities(config).map(c => c.chainId)).toEqual([5042002]);
    expect(await ensureAgentRegistered(config)).toEqual(new Map([[5042002, 42n]]));
    expect(state.instances[0].config.chainRpcUrl).toBe(config.arcRpcUrl);
    expect(state.instances[0].register).toHaveBeenCalledOnce();
    expect(state.instances[0].assertTokenOwner).toHaveBeenCalledWith(42n);
  });

  it('publishes Arc capability, payment endpoint and mint backreference without a false TEE claim', async () => {
    await ensureAgentRegistered(config);
    const metadata = state.metadata.get(config.arcRpcUrl);
    expect(metadata.capabilities).toContain('arc_eligibility');
    expect(metadata.circuits).toContain('arc_eligibility');
    expect(metadata.services).toContainEqual({ name: 'x402', endpoint: `${config.a2aBaseUrl}/api/v1/prove` });
    expect(metadata.registrations).toEqual([{ agentId: 42, agentRegistry: `eip155:5042002:${config.arcIdentityAddress}` }]);
    expect(metadata.tee).toBeUndefined();
    expect(metadata.tags).not.toContain('TEE');
    expect(metadata.supportedTrust).toEqual([]);
  });

  it('updates existing metadata once then performs no writes on the next startup', async () => {
    state.registered = true;
    await ensureAgentRegistered(config);
    await ensureAgentRegistered(config);
    expect(state.instances[0].updateMetadata).toHaveBeenCalledOnce();
    expect(state.instances[1].updateMetadata).not.toHaveBeenCalled();
    expect(state.instances[1].register).not.toHaveBeenCalled();
    expect(state.instances[1].getTokenMetadata).toHaveBeenCalledOnce();
  });

  it.each(['rpc', 'unresolved', 'null', 'owner', 'write', 'readback', 'active'])('fails visibly on %s instead of publishing readiness', async fail => {
    state.registered = true; state.fail = fail;
    await expect(ensureAgentRegistered(config)).rejects.toThrow('Required Arc ERC-8004 registration failed');
    expect(state.instances[0].register).not.toHaveBeenCalled();
  });

  it.each(['0', '1', String(Number.MAX_SAFE_INTEGER)])('passes cached id %s through verified registration lookup', async tokenId => {
    state.registered = true;
    expect((await ensureAgentRegistered({ ...config, arcAgentTokenId: tokenId })).get(5042002)).toBe(BigInt(tokenId));
    expect(state.instances[0].getRegistration).toHaveBeenCalledWith(BigInt(tokenId));
  });

  it.each([' ', '-1', '1junk', '1e2', '0x2', '한글', '😀', '<script>', '1\n', String(BigInt(Number.MAX_SAFE_INTEGER) + 1n)])('rejects invalid or unsafe cached id %j', async tokenId => {
    state.registered = true;
    await expect(ensureAgentRegistered({ ...config, arcAgentTokenId: tokenId })).rejects.toThrow('Required Arc');
    expect(state.instances[0].updateMetadata).not.toHaveBeenCalled();
  });

  it.each(['http://localhost:4002', 'https://localhost', 'http://127.0.0.1:4002', 'https://[::1]', 'https://service.localhost'])('has no public registration side effect for %s', async a2aBaseUrl => {
    expect((await ensureAgentRegistered({ ...config, a2aBaseUrl })).size).toBe(0);
    expect(state.instances).toHaveLength(0);
  });

  it('leaves unconfigured registration disabled', async () => {
    expect((await ensureAgentRegistered({ ...config, arcRpcUrl: '' })).size).toBe(0);
    expect(state.instances).toHaveLength(0);
  });

  it('retains hardware trust only for Nitro configuration', async () => {
    await ensureAgentRegistered({ ...config, teeMode: 'nitro' });
    expect(state.metadata.get(config.arcRpcUrl).tee).toBe('nitro');
  });

  it.each([0, -1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 1])('rejects invalid configured Arc chain id %s', chainId => {
    expect(() => getChainIdentities({ ...config, arcChainId: chainId })).toThrow('ARC_CHAIN_ID');
  });

  it('rejects missing Arc registry instead of borrowing a Base address', () => {
    expect(() => getChainIdentities({ ...config, arcIdentityAddress: '' })).toThrow('ARC_IDENTITY_ADDRESS');
  });
});
