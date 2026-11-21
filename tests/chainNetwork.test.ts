import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type Config,
  getChainId,
  getChainIdentities,
  getPaymentChainId,
  isProductionChain,
  isTestnet,
  loadConfig,
} from '../src/config/index.js';
import { assertPaymentModeMatchesNetwork, parseChainNetwork } from '../src/config/chainNetwork.js';
import { buildAgentCard } from '../src/a2a/agentCard.js';
import { ERC8004_ADDRESSES } from '../src/config/contracts.js';

/**
 * The network is CHAIN_NETWORK, never the RPC hostname. Until 2026-11-21
 * `isTestnet` was `chainRpcUrl.includes('sepolia')`, so a testnet RPC whose
 * name lacked that word (a gateway, a proxy, a custom node) ran as mainnet:
 * mainnet chain ids, mainnet verifiers, mainnet identity registry.
 */

// A testnet endpoint with no "sepolia" anywhere in it, and a mainnet one that has it.
const TESTNET_RPC_WITHOUT_THE_WORD = 'https://base-testnet.rpc.example.com/v1/key';
const MAINNET_RPC_WITH_THE_WORD = 'https://mainnet.example.com/not-sepolia';

describe('CHAIN_NETWORK parsing', () => {
  it.each(['testnet', 'mainnet'] as const)('accepts %s exactly', (value) => {
    expect(parseChainNetwork(value)).toBe(value);
  });

  it('refuses a missing value, naming the variable and the allowed ones', () => {
    expect(() => parseChainNetwork(undefined)).toThrow(/CHAIN_NETWORK environment variable is required\. Allowed: testnet, mainnet/);
  });

  it('refuses an empty string as its own case', () => {
    expect(() => parseChainNetwork('')).toThrow('Unknown CHAIN_NETWORK "". Allowed: testnet, mainnet.');
  });

  it.each([' ', '\t', '\n', ' testnet', 'testnet ', 'mainnet\n', '\ttestnet'])(
    'refuses whitespace %j rather than trimming it',
    (value) => {
      expect(() => parseChainNetwork(value)).toThrow(`Unknown CHAIN_NETWORK ${JSON.stringify(value)}`);
    },
  );

  it.each(['Testnet', 'TESTNET', 'Mainnet', 'MAINNET', 'mainNet'])('refuses wrong case %j', (value) => {
    expect(() => parseChainNetwork(value)).toThrow(`Unknown CHAIN_NETWORK ${JSON.stringify(value)}`);
  });

  it.each([
    'sepolia', 'base-sepolia', 'production', 'staging', 'disabled', 'local', 'devnet',
    '%', '_', '\\', "testnet' OR 1=1 --", '<script>alert(1)</script>', 'test\u0000net',
    '테스트넷', '🧪', 'toString', '__proto__', 'constructor', 'testnet,mainnet',
  ])('refuses unknown value %j', (value) => {
    expect(() => parseChainNetwork(value)).toThrow(`Unknown CHAIN_NETWORK ${JSON.stringify(value)}. Allowed: testnet, mainnet.`);
  });

  it('refuses a very large value', () => {
    expect(() => parseChainNetwork('t'.repeat(100_000))).toThrow(/Unknown CHAIN_NETWORK/);
  });
});

describe('PAYMENT_MODE and CHAIN_NETWORK must agree', () => {
  it.each([
    ['disabled', 'testnet'], ['disabled', 'mainnet'],
    ['testnet', 'testnet'], ['mainnet', 'mainnet'],
  ] as const)('PAYMENT_MODE=%s with CHAIN_NETWORK=%s starts', (mode, network) => {
    expect(() => assertPaymentModeMatchesNetwork(mode, network)).not.toThrow();
  });

  it('refuses taking mainnet payment on a testnet deployment', () => {
    expect(() => assertPaymentModeMatchesNetwork('mainnet', 'testnet'))
      .toThrow('PAYMENT_MODE=mainnet requires CHAIN_NETWORK=mainnet (got: testnet).');
  });

  it('refuses taking testnet payment on a mainnet deployment', () => {
    expect(() => assertPaymentModeMatchesNetwork('testnet', 'mainnet'))
      .toThrow('PAYMENT_MODE=testnet requires CHAIN_NETWORK=testnet (got: mainnet).');
  });

  it.each(['bogus', '', '__proto__', 'toString'])('refuses an unknown payment mode %j instead of waving it through', (mode) => {
    expect(() => assertPaymentModeMatchesNetwork(mode, 'testnet')).toThrow(/Unknown PAYMENT_MODE/);
  });
});

describe('loadConfig reads CHAIN_NETWORK', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.REDIS_URL = 'redis://redis:6379';
    process.env.BASE_RPC_URL = 'https://mainnet.base.org';
    process.env.EAS_GRAPHQL_ENDPOINT = 'https://base.easscan.org/graphql';
    process.env.CHAIN_RPC_URL = 'https://sepolia.base.org';
    process.env.PROVER_PRIVATE_KEY = '0x' + 'ab'.repeat(32);
    process.env.A2A_BASE_URL = 'http://localhost:4002';
    process.env.PAYMENT_MODE = 'disabled';
    process.env.PAYMENT_NETWORKS = 'base-sepolia';
    process.env.CHAIN_NETWORK = 'testnet';
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('refuses to start when CHAIN_NETWORK is unset, even with a sepolia RPC', () => {
    delete process.env.CHAIN_NETWORK;
    expect(() => loadConfig()).toThrow(/CHAIN_NETWORK environment variable is required/);
  });

  it.each(['', ' ', 'Testnet', 'sepolia', 'production'])('refuses to start with CHAIN_NETWORK=%j', (value) => {
    process.env.CHAIN_NETWORK = value;
    expect(() => loadConfig()).toThrow(`Unknown CHAIN_NETWORK ${JSON.stringify(value)}`);
  });

  it('keeps a testnet whose RPC hostname has no "sepolia" in it', () => {
    process.env.CHAIN_RPC_URL = TESTNET_RPC_WITHOUT_THE_WORD;
    const config = loadConfig();
    expect(config.chainNetwork).toBe('testnet');
    expect(isTestnet(config)).toBe(true);
    expect(getChainId(config)).toBe(11155111);
    expect(getPaymentChainId(config)).toBe(84532);
  });

  it('keeps a mainnet whose RPC URL happens to contain "sepolia"', () => {
    process.env.CHAIN_NETWORK = 'mainnet';
    process.env.CHAIN_RPC_URL = MAINNET_RPC_WITH_THE_WORD;
    const config = loadConfig();
    expect(config.chainNetwork).toBe('mainnet');
    expect(isTestnet(config)).toBe(false);
    expect(getChainId(config)).toBe(1);
    expect(getPaymentChainId(config)).toBe(8453);
  });

  it('refuses PAYMENT_MODE=mainnet with CHAIN_NETWORK=testnet at startup', () => {
    process.env.PAYMENT_MODE = 'mainnet';
    process.env.PAYMENT_NETWORKS = 'base';
    expect(() => loadConfig()).toThrow('PAYMENT_MODE=mainnet requires CHAIN_NETWORK=mainnet (got: testnet).');
  });

  it('refuses PAYMENT_MODE=testnet with CHAIN_NETWORK=mainnet at startup', () => {
    process.env.PAYMENT_MODE = 'testnet';
    process.env.CHAIN_NETWORK = 'mainnet';
    expect(() => loadConfig()).toThrow('PAYMENT_MODE=testnet requires CHAIN_NETWORK=testnet (got: mainnet).');
  });
});

/** A config whose RPC URL says the opposite of its network, so a URL test cannot pass. */
function configFor(network: 'testnet' | 'mainnet'): Config {
  return {
    chainNetwork: network,
    chainRpcUrl: network === 'testnet' ? TESTNET_RPC_WITHOUT_THE_WORD : MAINNET_RPC_WITH_THE_WORD,
    ethereumRpcUrl: 'https://ethereum.rpc.example.com',
    erc8004IdentityAddress: '0x0000000000000000000000000000000000000033',
    agentTokenId: '',
    agentTokenIdEthereum: '',
    paymentMode: 'disabled',
    paymentNetworks: network === 'testnet' ? 'base-sepolia' : 'base',
    paymentProofPrice: '$0.10',
    paymentPayTo: '',
    a2aBaseUrl: 'https://proof.example.com',
    websiteUrl: 'https://example.com',
    agentVersion: '0.0.0',
    teeMode: 'local',
  } as unknown as Config;
}

describe('every consumer follows chainNetwork, not the RPC URL', () => {
  const EXPECTED = {
    testnet: {
      isTestnet: true, chainId: 11155111, paymentChainId: 84532,
      identities: [[11155111, 'Ethereum Sepolia', 'proveragent.sepolia'], [84532, 'Base Sepolia', 'proveragent.base.sepolia']],
      cardIdentity: ERC8004_ADDRESSES.sepolia.identity,
    },
    mainnet: {
      isTestnet: false, chainId: 1, paymentChainId: 8453,
      identities: [[1, 'Ethereum Mainnet', 'proveragent.eth'], [8453, 'Base Mainnet', 'proveragent.base.eth']],
      cardIdentity: ERC8004_ADDRESSES.mainnet.identity,
    },
  } as const;

  for (const network of ['testnet', 'mainnet'] as const) {
    const want = EXPECTED[network];

    it(`${network}: isTestnet / isProductionChain`, () => {
      expect(isTestnet(configFor(network))).toBe(want.isTestnet);
      expect(isProductionChain(configFor(network))).toBe(!want.isTestnet);
    });

    it(`${network}: getChainId and getPaymentChainId`, () => {
      expect(getChainId(configFor(network))).toBe(want.chainId);
      expect(getPaymentChainId(configFor(network))).toBe(want.paymentChainId);
    });

    it(`${network}: getChainIdentities names the right chains and registers`, () => {
      const ids = getChainIdentities(configFor(network));
      expect(ids.map(i => [i.chainId, i.chainName, i.agentName])).toEqual(want.identities);
    });

    it(`${network}: the agent card advertises the right ERC-8004 chain`, () => {
      const config = { ...configFor(network), erc8004IdentityAddress: '' } as Config;
      const card = buildAgentCard(config);
      expect(card.identity.erc8004.chainId).toBe(want.chainId);
      expect(card.identity.erc8004.contractAddress).toBe(want.cardIdentity);
    });
  }

  it('a config with no chainNetwork is an error at every consumer, never mainnet', () => {
    const config = { ...configFor('mainnet'), chainNetwork: undefined } as unknown as Config;
    for (const fn of [isTestnet, isProductionChain, getChainId, getPaymentChainId, getChainIdentities]) {
      expect(() => fn(config), fn.name).toThrow('Unknown chainNetwork undefined. Known: testnet, mainnet.');
    }
  });

  it.each(['sepolia', 'Mainnet', 'toString', '__proto__'])('a config with chainNetwork=%j is an error, not a lookup hit', (value) => {
    const config = { ...configFor('mainnet'), chainNetwork: value } as unknown as Config;
    expect(() => getChainId(config)).toThrow(`Unknown chainNetwork ${JSON.stringify(value)}`);
    expect(() => isTestnet(config)).toThrow(`Unknown chainNetwork ${JSON.stringify(value)}`);
  });
});

describe('syncDeployments follows the network it is given', () => {
  afterEach(() => vi.unstubAllGlobals());

  async function chainsFetchedFor(network: string) {
    vi.resetModules();
    const { syncDeployments } = await import('../src/config/deployments.js');
    const fetchMock = vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) }));
    vi.stubGlobal('fetch', fetchMock);
    await syncDeployments(network as 'testnet');
    return [...new Set(fetchMock.mock.calls.map(([u]) => Number(/\/(\d+)\/run-latest\.json$/.exec(String(u))?.[1])))].sort((a, b) => a - b);
  }

  it('testnet reads Ethereum Sepolia, Base Sepolia and GIWA Sepolia records only', async () => {
    expect(await chainsFetchedFor('testnet')).toEqual([84532, 91342, 11155111]);
  });

  it('mainnet reads Ethereum and Base mainnet records only', async () => {
    expect(await chainsFetchedFor('mainnet')).toEqual([1, 8453]);
  });

  it.each([undefined, '', 'sepolia', 'disabled', 'Mainnet', '__proto__'])('refuses network %j and fetches nothing', async (value) => {
    vi.resetModules();
    const { syncDeployments } = await import('../src/config/deployments.js');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(syncDeployments(value as 'testnet')).rejects.toThrow(`Unknown chainNetwork ${JSON.stringify(value)}`);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
