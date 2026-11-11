import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { publishedWalletDependencies } from '../scripts/published-wallet-dependencies.mjs';

const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
const sdk = JSON.parse(readFileSync(new URL('../packages/sdk/package.json', import.meta.url), 'utf8'));

describe('published E2E includes all optional wallet adapters', () => {
  it('installs every optional SDK wallet peer with a tested exact version', () => {
    const dependencies = publishedWalletDependencies(lock, sdk);
    for (const [name, metadata] of Object.entries(sdk.peerDependenciesMeta) as Array<[string, { optional: boolean }]>) {
      if (metadata.optional) expect(dependencies[name], name).toMatch(/^\d+\.\d+\.\d+$/);
    }
    expect(dependencies['@coinbase/cdp-sdk']).toBe(lock.packages['node_modules/@coinbase/cdp-sdk'].version);
    expect(dependencies['@x402/extensions']).toBe(lock.packages['node_modules/@x402/extensions'].version);
    expect(dependencies).not.toHaveProperty('@circle-fin/developer-controlled-wallets');
    for (const name of Object.keys(lock.packages['node_modules/@coinbase/cdp-sdk'].peerDependencies)) {
      expect(dependencies[name], `CDP adapter eagerly needs ${name}`).toBe(lock.packages[`node_modules/${name}`].version);
    }
    expect(dependencies['@solana/kit']).toBe(lock.packages['node_modules/@x402/svm/node_modules/@solana/kit'].version);
  });
  it.each(['@coinbase/cdp-sdk', '@x402/extensions', '@x402/svm'])('fails before installation if %s is not locked', name => {
    const missing = structuredClone(lock);
    delete missing.packages[`node_modules/${name}`];
    expect(() => publishedWalletDependencies(missing, sdk)).toThrow(name);
  });
  it('does not silently miss a newly introduced optional wallet integration', () => {
    const futureSdk = { ...sdk, peerDependenciesMeta: { ...sdk.peerDependenciesMeta, 'new-wallet-adapter': { optional: true } } };
    expect(() => publishedWalletDependencies(lock, futureSdk)).toThrow('new-wallet-adapter');
  });
  it('rejects a dependency range in place of a tested lock version', () => {
    const invalid = structuredClone(lock);
    invalid.packages['node_modules/@coinbase/cdp-sdk'].version = '^1.55.0';
    expect(() => publishedWalletDependencies(invalid, sdk)).toThrow('exact tested');
  });
});

describe('the SDK declares every package the CDP adapter loads', () => {
  // A customer installs what the SDK's peer list and its error message name.
  // Until 2026-11-11 both left out @x402/svm, which @coinbase/cdp-sdk/x402
  // imports, so the CDP wallet failed on a clean install; inside this
  // repository another package had already installed it and nothing noticed.
  const cdpPeers = Object.keys(lock.packages['node_modules/@coinbase/cdp-sdk'].peerDependencies);
  const provided = { ...sdk.dependencies, ...sdk.peerDependencies };

  it.each(cdpPeers)('%s is a dependency or an optional peer of the SDK', name => {
    expect(provided, name).toHaveProperty([name]);
    if (!(name in sdk.dependencies)) expect(sdk.peerDependenciesMeta[name]?.optional, name).toBe(true);
  });

  it('the CDP load error names every peer the SDK leaves to the customer', async () => {
    const { CDP_ADAPTER_PEERS } = await import('../packages/sdk/src/wallets.js');
    const leftToCustomer = cdpPeers.filter(name => !(name in sdk.dependencies));
    expect([...CDP_ADAPTER_PEERS].sort()).toEqual(leftToCustomer.sort());
  });
});
