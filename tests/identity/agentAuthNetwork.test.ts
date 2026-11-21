import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * createAgentAuthMiddleware picks the ERC-8004 identity registry and the RPC
 * it reads from by the deployment's chainNetwork. It used to decide with
 * `chainRpcUrl.includes('sepolia')`, so a testnet RPC named without that word
 * looked agents up in the mainnet registry.
 */

const seen = vi.hoisted(() => ({ rpcUrls: [] as string[], registries: [] as string[] }));

vi.mock('ethers', async (importOriginal) => {
  const real = await importOriginal<typeof import('ethers')>();
  class JsonRpcProvider { constructor(url: string) { seen.rpcUrls.push(url); } }
  class Contract {
    constructor(address: string) { seen.registries.push(address); }
    async balanceOf() { return 0n; }
  }
  return { ...real, ethers: { ...real.ethers, JsonRpcProvider, Contract } };
});

const { ethers } = await import('ethers');
const { createAgentAuthMiddleware } = await import('../../src/identity/agentAuth.js');
const { ERC8004_ADDRESSES } = await import('../../src/config/contracts.js');
import type { Config } from '../../src/config/index.js';

const TESTNET_RPC_WITHOUT_THE_WORD = 'https://base-testnet.rpc.example.com/v1/key';
const MAINNET_RPC_WITH_THE_WORD = 'https://mainnet.example.com/not-sepolia';
const ETHEREUM_RPC = 'https://ethereum.rpc.example.com';

async function lookUp(config: Config) {
  const wallet = ethers.Wallet.createRandom();
  const body = { hello: 'world' };
  const hash = ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(body)));
  const signature = await wallet.signMessage(ethers.getBytes(hash));
  const req = { headers: { 'x-agent-signature': signature, 'x-agent-address': wallet.address }, body } as never;
  const next = vi.fn();
  await createAgentAuthMiddleware(config)(req, {} as never, next);
  expect(next).toHaveBeenCalledOnce();
  return (req as { agentIdentity?: { verified: boolean } }).agentIdentity;
}

beforeEach(() => { seen.rpcUrls.length = 0; seen.registries.length = 0; });

describe('agent auth reads the registry of the configured network', () => {
  it('testnet with a non-"sepolia" RPC: Sepolia registry over the chain RPC', async () => {
    const identity = await lookUp({ chainNetwork: 'testnet', chainRpcUrl: TESTNET_RPC_WITHOUT_THE_WORD, ethereumRpcUrl: ETHEREUM_RPC } as Config);
    expect(identity?.verified).toBe(true);
    expect(seen.registries).toEqual([ERC8004_ADDRESSES.sepolia.identity]);
    expect(seen.rpcUrls).toEqual([TESTNET_RPC_WITHOUT_THE_WORD]);
  });

  it('mainnet with a "sepolia"-containing RPC: mainnet registry over the Ethereum RPC', async () => {
    await lookUp({ chainNetwork: 'mainnet', chainRpcUrl: MAINNET_RPC_WITH_THE_WORD, ethereumRpcUrl: ETHEREUM_RPC } as Config);
    expect(seen.registries).toEqual([ERC8004_ADDRESSES.mainnet.identity]);
    expect(seen.rpcUrls).toEqual([ETHEREUM_RPC]);
  });

  it.each([undefined, '', 'sepolia', 'Testnet'])('refuses to build the middleware for chainNetwork %j', (value) => {
    expect(() => createAgentAuthMiddleware({ chainNetwork: value, chainRpcUrl: TESTNET_RPC_WITHOUT_THE_WORD } as unknown as Config))
      .toThrow(`Unknown chainNetwork ${JSON.stringify(value)}`);
  });
});
