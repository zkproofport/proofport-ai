/**
 * The payment wallets a buyer can pay from: a raw private key (`key`) and a
 * Coinbase CDP server wallet (`cdp`). Nothing else.
 *
 * A Circle developer-controlled wallet adapter existed once and was removed
 * without ever having signed a payment. These tests hold that removal: a
 * Circle name or credential must be refused or ignored, never resolved to
 * some other wallet.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { walletFor, walletFromEnv } from '../../packages/sdk/src/wallets.js';
import * as sdk from '../../packages/sdk/src/index.js';

const TEST_KEY = '0x' + '11'.repeat(32);
const CIRCLE_ENV = { CIRCLE_API_KEY: 'circle-key', CIRCLE_ENTITY_SECRET: 'secret', CIRCLE_WALLET_ID: 'wallet-id' };

describe('walletFor', () => {
  it('refuses circle and names the two wallets that exist', async () => {
    await expect(walletFor('circle', CIRCLE_ENV)).rejects.toThrow(
      "Unknown payment wallet 'circle'. Choose one of: key, cdp",
    );
  });

  it.each(['', 'CDP', 'Key', ' key', 'private-key'])('refuses %j rather than guessing a wallet', async (which) => {
    await expect(walletFor(which, { PAYMENT_PRIVATE_KEY: TEST_KEY })).rejects.toThrow(
      `Unknown payment wallet '${which}'. Choose one of: key, cdp`,
    );
  });

  it('builds the key wallet from PAYMENT_PRIVATE_KEY', async () => {
    const wallet = await walletFor('key', { PAYMENT_PRIVATE_KEY: TEST_KEY });
    expect(wallet.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it('names the missing credential for cdp instead of loading another wallet', async () => {
    await expect(walletFor('cdp', CIRCLE_ENV)).rejects.toThrow('Paying from a cdp wallet requires CDP_API_KEY_ID');
  });
});

describe('walletFromEnv', () => {
  it('reports no wallet configured when only Circle credentials are set', async () => {
    const error = await walletFromEnv(CIRCLE_ENV).then(
      () => { throw new Error('expected walletFromEnv to reject'); },
      (e: Error) => e,
    );
    expect(error.message).toContain('No payment wallet configured');
    expect(error.message).toContain('PAYMENT_PRIVATE_KEY');
    expect(error.message).toContain('CDP_API_KEY_ID');
    expect(error.message).not.toMatch(/circle/i);
  });

  it('does not count a Circle credential as a second wallet beside a key', async () => {
    const wallet = await walletFromEnv({ PAYMENT_PRIVATE_KEY: TEST_KEY, ...CIRCLE_ENV });
    expect(wallet.describe?.()).toContain('private key');
  });

  it('still refuses to choose between a key and a CDP wallet', async () => {
    await expect(walletFromEnv({ PAYMENT_PRIVATE_KEY: TEST_KEY, CDP_API_KEY_ID: 'id' })).rejects.toThrow(
      'More than one payment wallet is configured (key, cdp)',
    );
  });
});

describe('the published SDK surface', () => {
  it('exports no Circle wallet adapter', () => {
    expect(Object.keys(sdk).filter((name) => /circle/i.test(name))).toEqual([]);
  });

  it('declares no Circle peer dependency', () => {
    const manifest = JSON.parse(readFileSync(new URL('../../packages/sdk/package.json', import.meta.url), 'utf8'));
    expect(JSON.stringify(manifest.peerDependencies ?? {})).not.toMatch(/circle/i);
    expect(JSON.stringify(manifest.peerDependenciesMeta ?? {})).not.toMatch(/circle/i);
  });
});
