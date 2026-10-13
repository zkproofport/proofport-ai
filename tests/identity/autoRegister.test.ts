import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Config } from '../../src/config/index.js';

const state = vi.hoisted(() => ({
  instances: [] as any[], registered: false, fail: '' as string,
  metadata: new Map<string, any>(),
  failedRpcUrls: new Set<string>(), lockFailure: '' as string, staleReadbacks: 0, activeReadErrors: 0, ownerReadErrors: 0,
}));
vi.mock('../../src/identity/register.js', () => {
  class AgentRegistration {
    agentAddress = '0x1234567890123456789012345678901234567890';
    constructor(public config: any) { state.instances.push(this); }
    isRegistered = vi.fn(async () => { if (state.fail === 'rpc' || state.failedRpcUrls.has(this.config.chainRpcUrl)) throw new Error('RPC down'); return state.registered; });
    getRegistration = vi.fn(async (cached?: bigint) => {
      if (state.fail === 'unresolved') throw new Error('token unresolved');
      if (state.fail === 'null') return null;
      return { tokenId: cached ?? 42n, owner: this.agentAddress, isRegistered: true, metadataUri: JSON.stringify(state.metadata.get(this.config.chainRpcUrl) ?? {}) };
    });
    assertTokenOwner = vi.fn(async () => { if (state.ownerReadErrors > 0) { state.ownerReadErrors--; throw new Error('mint block not readable yet'); } if (state.fail === 'owner') throw new Error('wrong owner'); });
    register = vi.fn(async () => ({ tokenId: 42n, transactionHash: '0xmint', agentAddress: this.agentAddress }));
    updateMetadata = vi.fn(async (_: bigint, metadata: any) => {
      if (state.fail === 'write') throw new Error('write reverted');
      state.metadata.set(this.config.chainRpcUrl, metadata); return '0xupdate';
    });
    getTokenMetadata = vi.fn(async () => {
      if (state.staleReadbacks > 0) { state.staleReadbacks--; return '{}'; }
      return JSON.stringify(state.fail === 'readback' ? {} : state.metadata.get(this.config.chainRpcUrl));
    });
    getOnchainMetadata = vi.fn(async () => {
      if (state.activeReadErrors > 0) { state.activeReadErrors--; throw new Error('confirmed block not available yet'); }
      return state.fail === 'active' ? 'false' : 'true';
    });
    setOnchainMetadata = vi.fn(async () => { throw new Error('active reverted'); });
  }
  return { AgentRegistration, parseMetadataUri: (uri: string) => JSON.parse(uri) };
});
vi.mock('../../src/identity/registrationLock.js', () => ({ withRegistrationLock: async (_url: string, key: string, run: () => Promise<unknown>) => {
  if (state.lockFailure && key.includes(`:${state.lockFailure}:`)) throw new Error('Redis lock unavailable');
  return run();
} }));
import { ensureAgentRegistered } from '../../src/identity/autoRegister.js';
import { getChainIdentities } from '../../src/config/index.js';

const registry = '0x8004A818BFB912233c491871b3d84c89A494BD9e';
const config = {
  erc8004IdentityAddress: registry, erc8004ReputationAddress: '', chainRpcUrl: 'https://sepolia.base.org',
  ethereumRpcUrl: 'https://ethereum-sepolia.example', agentTokenId: '', agentTokenIdEthereum: '', teeMode: 'local',
  proverPrivateKey: '0x' + '12'.repeat(32), a2aBaseUrl: 'https://stg-ai.zkproofport.app',
} as Config;

/** The instances one run created, keyed by the RPC each chain was given. */
const run = (n: number) => state.instances.slice(n * 2, n * 2 + 2);
const baseOf = (n = 0) => run(n).find(i => i.config.chainRpcUrl === config.chainRpcUrl);

beforeEach(() => { state.instances.length = 0; state.registered = false; state.fail = ''; state.metadata.clear(); state.failedRpcUrls.clear(); state.lockFailure = ''; state.staleReadbacks = 0; state.activeReadErrors = 0; state.ownerReadErrors = 0; });

describe('testnet deployment registration', () => {
  it('registers Ethereum Sepolia and Base Sepolia, and nothing else', async () => {
    expect(getChainIdentities(config).map(c => c.chainId)).toEqual([11155111, 84532]);
    expect(await ensureAgentRegistered(config)).toEqual(new Map([[11155111, 42n], [84532, 42n]]));
    expect(state.instances.map(i => i.config.chainRpcUrl)).toEqual([config.ethereumRpcUrl, config.chainRpcUrl]);
    for (const instance of state.instances) {
      expect(instance.register).toHaveBeenCalledOnce();
      expect(instance.assertTokenOwner).toHaveBeenCalledWith(42n);
    }
  });

  it('publishes provable capabilities, payment endpoint and mint backreference without a false TEE claim', async () => {
    await ensureAgentRegistered(config);
    const metadata = state.metadata.get(config.chainRpcUrl);
    expect(metadata.capabilities).toContain('giwa_attestation');
    expect(metadata.circuits).toContain('giwa_attestation');
    expect(metadata.capabilities).not.toContain('arc_eligibility');
    expect(metadata.circuits).not.toContain('arc_eligibility');
    expect(metadata.tags).not.toContain('Arc');
    expect(metadata.services).toContainEqual({ name: 'x402', endpoint: `${config.a2aBaseUrl}/api/v1/prove` });
    expect(metadata.registrations).toEqual([{ agentId: 42, agentRegistry: `eip155:84532:${registry}` }]);
    expect(metadata.tee).toBeUndefined();
    expect(metadata.tags).not.toContain('TEE');
    expect(metadata.supportedTrust).toEqual([]);
  });

  it('updates existing metadata once then performs no writes on the next startup', async () => {
    state.registered = true;
    await ensureAgentRegistered(config);
    await ensureAgentRegistered(config);
    expect(baseOf(0).updateMetadata).toHaveBeenCalledOnce();
    expect(baseOf(1).updateMetadata).not.toHaveBeenCalled();
    expect(baseOf(1).register).not.toHaveBeenCalled();
    expect(baseOf(1).getTokenMetadata).toHaveBeenCalledOnce();
  });

  it.each(['rpc', 'unresolved', 'null', 'owner', 'write', 'readback', 'active'])('fails visibly on %s instead of publishing readiness', async fail => {
    state.registered = true; state.fail = fail;
    await expect(ensureAgentRegistered(config)).rejects.toThrow('Required ERC-8004 registration failed');
    for (const instance of state.instances) expect(instance.register).not.toHaveBeenCalled();
  });

  it.each(['0', '1', String(Number.MAX_SAFE_INTEGER)])('passes cached id %s through verified registration lookup', async tokenId => {
    state.registered = true;
    expect((await ensureAgentRegistered({ ...config, agentTokenId: tokenId })).get(84532)).toBe(BigInt(tokenId));
    expect(baseOf().getRegistration).toHaveBeenCalledWith(BigInt(tokenId));
  });

  it.each([' ', '-1', '1junk', '1e2', '0x2', '한글', '😀', '<script>', '1\n', String(BigInt(Number.MAX_SAFE_INTEGER) + 1n)])('rejects invalid or unsafe cached id %j', async tokenId => {
    state.registered = true;
    await expect(ensureAgentRegistered({ ...config, agentTokenId: tokenId })).rejects.toThrow('Required ERC-8004');
    expect(baseOf().updateMetadata).not.toHaveBeenCalled();
  });

  it.each(['http://localhost:4002', 'https://localhost', 'http://127.0.0.1:4002', 'https://[::1]', 'https://service.localhost'])('has no public registration side effect for %s', async a2aBaseUrl => {
    expect((await ensureAgentRegistered({ ...config, a2aBaseUrl })).size).toBe(0);
    expect(state.instances).toHaveLength(0);
  });

  it('leaves unconfigured registration disabled', async () => {
    expect((await ensureAgentRegistered({ ...config, erc8004IdentityAddress: '' })).size).toBe(0);
    expect(state.instances).toHaveLength(0);
  });

  it('ignores a leftover Arc identity setting: no Arc chain is registered', async () => {
    const leftover = { ...config, arcRpcUrl: 'https://rpc.testnet.arc.io', arcChainId: 5042002, arcIdentityAddress: registry } as unknown as Config;
    expect(getChainIdentities(leftover).map(c => c.chainId)).toEqual([11155111, 84532]);
    expect((await ensureAgentRegistered({ ...leftover, erc8004IdentityAddress: '' })).size).toBe(0);
    expect(state.instances).toHaveLength(0);
  });

  it('retains hardware trust only for Nitro configuration', async () => {
    await ensureAgentRegistered({ ...config, teeMode: 'nitro' });
    expect(state.metadata.get(config.chainRpcUrl).tee).toBe('nitro');
  });
});


describe('complete configured identity set', () => {
  it.each([
    [11155111, config.ethereumRpcUrl],
    [84532, config.chainRpcUrl],
  ])('fails readiness when chain %s fails, while checking every other configured chain', async (chainId, rpcUrl) => {
    state.failedRpcUrls.add(String(rpcUrl));
    await expect(ensureAgentRegistered(config)).rejects.toThrow(`Required ERC-8004 registration failed on chain(s): ${chainId}`);
    expect(state.instances).toHaveLength(2);
    expect(state.metadata.size).toBe(1);
  });

  it('reports every failed chain rather than only the first one', async () => {
    state.failedRpcUrls.add(config.ethereumRpcUrl);
    state.failedRpcUrls.add(config.chainRpcUrl);
    await expect(ensureAgentRegistered(config)).rejects.toThrow('11155111, 84532');
    expect(state.metadata.size).toBe(0);
  });

  it('attributes lock errors to the chain and continues verifying the remaining chains', async () => {
    state.lockFailure = '11155111';
    await expect(ensureAgentRegistered(config)).rejects.toThrow('Required ERC-8004 registration failed on chain(s): 11155111');
    expect(state.instances).toHaveLength(1);
    expect(state.metadata.size).toBe(1);
  });

  it('returns all configured verified identities', async () => {
    expect(await ensureAgentRegistered(config)).toEqual(new Map([[11155111, 42n], [84532, 42n]]));
  });

  it.each(['0', '592'])('verifies cached token %s directly even when balanceOf RPC is unavailable', async cachedTokenId => {
    state.fail = 'rpc';
    const cached = { ...config, agentTokenId: cachedTokenId, agentTokenIdEthereum: cachedTokenId };
    expect(await ensureAgentRegistered(cached)).toEqual(new Map([[11155111, BigInt(cachedTokenId)], [84532, BigInt(cachedTokenId)]]));
    for (const instance of state.instances) {
      expect(instance.isRegistered).not.toHaveBeenCalled();
      expect(instance.getRegistration).toHaveBeenCalledWith(BigInt(cachedTokenId));
      expect(instance.assertTokenOwner).toHaveBeenCalledWith(BigInt(cachedTokenId));
      expect(instance.register).not.toHaveBeenCalled();
    }
  });
});

it('retries delayed confirmed metadata visibility without resubmitting a transaction', async () => {
  state.staleReadbacks = 1;
  expect(await ensureAgentRegistered(config)).toEqual(new Map([[11155111, 42n], [84532, 42n]]));
  expect(state.instances[0].updateMetadata).toHaveBeenCalledOnce();
  expect(state.instances[0].getTokenMetadata).toHaveBeenCalledTimes(2);
});

it('waits for the confirmed block before deciding whether active metadata needs a write', async () => {
  state.activeReadErrors = 1;
  expect(await ensureAgentRegistered(config)).toEqual(new Map([[11155111, 42n], [84532, 42n]]));
  expect(state.instances[0].updateMetadata).toHaveBeenCalledOnce();
  expect(state.instances[0].setOnchainMetadata).not.toHaveBeenCalled();
});

it('retries a lagging owner read after minting without minting another token', async () => {
  state.ownerReadErrors = 1;
  expect(await ensureAgentRegistered(config)).toEqual(new Map([[11155111, 42n], [84532, 42n]]));
  expect(state.instances[0].register).toHaveBeenCalledOnce();
  expect(state.instances[0].assertTokenOwner).toHaveBeenCalledTimes(2);
});
