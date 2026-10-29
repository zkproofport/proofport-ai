import { afterEach, describe, expect, it, vi } from 'vitest';
import { getVerifierAddress, syncDeployments } from '../src/config/deployments.js';

/**
 * Testnet verifier addresses come from the same circuits ref as the artifacts.
 *
 * They were read from main while the artifacts came from CIRCUITS_REPO_URL, so
 * a server proving with another branch's circuits verified against main's
 * contracts and every proof reverted (ProofLengthWrong, 2026-10-22). GIWA
 * Sepolia was not synced at all.
 */
const REPO = 'https://raw.githubusercontent.com/zkproofport/circuits/some-branch';
const ADDR = '0x00000000000000000000000000000000000000a1';

function broadcastFetch() {
  return vi.fn(async (url: string) => ({
    ok: true,
    status: 200,
    json: async () => ({ transactions: [{ contractName: 'HonkVerifier', contractAddress: ADDR }] }),
    url,
  }));
}

afterEach(() => vi.unstubAllGlobals());

describe('testnet verifier addresses follow the circuits ref', () => {
  it('reads every testnet broadcast from the given ref, never from main', async () => {
    const fetchMock = broadcastFetch();
    vi.stubGlobal('fetch', fetchMock);

    await syncDeployments('testnet', 'https://sepolia.base.org', REPO);

    const urls = fetchMock.mock.calls.map(([u]) => String(u));
    expect(urls.length).toBeGreaterThan(0);
    for (const u of urls) {
      expect(u.startsWith(REPO + '/broadcast/')).toBe(true);
      expect(u).not.toContain('/circuits/main/');
    }
  });

  it('syncs GIWA Sepolia, the only chain giwa_attestation lives on', async () => {
    const fetchMock = broadcastFetch();
    vi.stubGlobal('fetch', fetchMock);

    await syncDeployments('testnet', 'https://sepolia.base.org', REPO);

    const urls = fetchMock.mock.calls.map(([u]) => String(u));
    expect(urls).toContain(`${REPO}/broadcast/DeployGiwaAttestation.s.sol/91342/run-latest.json`);
    expect(getVerifierAddress('giwa_attestation', '91342')).toBe(ADDR);
  });

  it('refuses to run without a ref rather than guessing main', async () => {
    vi.stubGlobal('fetch', broadcastFetch());
    await expect(syncDeployments('testnet', 'https://sepolia.base.org', '')).rejects.toThrow(/circuits repo URL/);
  });
});

/**
 * Production reads the circuits release marked Latest, which stays on an old
 * release because installed apps read it. On 2026-10-29 that was v1.3.0,
 * naming OIDC v1 verifiers on Base and Ethereum: syncing them over the pinned
 * fallback would answer every production OIDC proof with a verifier that
 * reverts it.
 */
describe('production keeps a core-pinned verifier over an older release', () => {
  const OLD: Record<string, string> = {
    'DeployOidcDomainAttestation.s.sol/8453': '0x9677ba46ad226ce8b3c4517d9c0143e4d458beae',
    'DeployOidcDomainAttestation.s.sol/1': '0x440eaa25603ed5480cad0ee51d9808a1993ef267',
    'DeployCoinbaseCountryAttestation.s.sol/8453': '0xf3d5a09d2c85b28c52ef2905c1be3a852b609d0c',
    'DeployCoinbaseCountryAttestation.s.sol/1': '0x78792554e1582cb49d858eacb5c3607b42d28224',
    'DeployCoinbaseAttestationV2.s.sol/8453': ADDR,
  };

  function releaseFetch() {
    return vi.fn(async (url: string) => {
      if (url.includes('/releases/latest')) {
        return { ok: true, status: 200, json: async () => ({ tag_name: 'v1.3.0' }) };
      }
      const key = Object.keys(OLD).find(k => url.includes(`/broadcast/${k}/`));
      if (!key) return { ok: false, status: 404, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ transactions: [{ contractName: 'HonkVerifier', contractAddress: OLD[key] }] }) };
    });
  }

  it('ignores the release for every pinned row, on Base and Ethereum', async () => {
    vi.resetModules();
    const fresh = await import('../src/config/deployments.js');
    const { FALLBACK_VERIFIERS } = await import('../src/config/contracts.js');
    const fetchMock = releaseFetch();
    vi.stubGlobal('fetch', fetchMock);

    await fresh.syncDeployments('mainnet', 'https://mainnet.base.org', REPO);

    expect(fetchMock.mock.calls.map(([u]) => String(u))).toContain(
      'https://raw.githubusercontent.com/zkproofport/circuits/v1.3.0/broadcast/DeployOidcDomainAttestation.s.sol/8453/run-latest.json',
    );
    for (const chain of ['1', '8453']) {
      for (const circuit of ['oidc_domain_attestation', 'coinbase_country_attestation'] as const) {
        expect(fresh.getVerifierAddress(circuit, chain), `${circuit} on ${chain}`).toBe(FALLBACK_VERIFIERS[chain][circuit]);
      }
    }
  });

  it('still takes the release for a row core does not pin (coinbase_attestation v2)', async () => {
    vi.resetModules();
    const fresh = await import('../src/config/deployments.js');
    vi.stubGlobal('fetch', releaseFetch());

    await fresh.syncDeployments('mainnet', 'https://mainnet.base.org', REPO);

    expect(fresh.getVerifierAddress('coinbase_attestation', '8453')).toBe(ADDR);
  });

  it('staging still follows its circuits ref over a pinned row', async () => {
    vi.resetModules();
    const fresh = await import('../src/config/deployments.js');
    vi.stubGlobal('fetch', broadcastFetch());

    await fresh.syncDeployments('testnet', 'https://sepolia.base.org', REPO);

    expect(fresh.getVerifierAddress('oidc_domain_attestation', '84532')).toBe(ADDR);
  });
});
