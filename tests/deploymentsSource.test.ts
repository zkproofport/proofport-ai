import { afterEach, describe, expect, it, vi } from 'vitest';
import { CIRCUITS_COMMIT } from '../src/config/circuitsPin.js';

/**
 * Verifier addresses come from the pinned circuits commit, on every chain,
 * in staging and production alike -- the commit the baked artifacts come
 * from (src/config/circuitsPin.ts).
 *
 * Before 2026-11-17 staging read CIRCUITS_REPO_URL (default circuits `main`)
 * and production asked the GitHub API for `releases/latest`, so a merge to
 * circuits main or a release marked Latest changed the verifiers a server
 * named on its next start.
 */
const PINNED = `https://raw.githubusercontent.com/zkproofport/circuits/${CIRCUITS_COMMIT}`;
const ADDR = '0x00000000000000000000000000000000000000a1';

function broadcastFetch() {
  return vi.fn(async (url: string) => ({
    ok: true,
    status: 200,
    json: async () => ({ transactions: [{ contractName: 'HonkVerifier', contractAddress: ADDR }] }),
    url,
  }));
}

async function freshDeployments() {
  vi.resetModules();
  return import('../src/config/deployments.js');
}

afterEach(() => vi.unstubAllGlobals());

describe('verifier records follow the pinned circuits commit', () => {
  for (const [label, mode, rpc] of [
    ['staging (testnet)', 'testnet', 'https://sepolia.base.org'],
    ['production (mainnet)', 'mainnet', 'https://mainnet.base.org'],
    ['payment disabled on a mainnet RPC', 'disabled', 'https://mainnet.base.org'],
  ] as const) {
    it(`${label}: every broadcast URL is under the pinned commit, never main or a release`, async () => {
      const { syncDeployments } = await freshDeployments();
      const fetchMock = broadcastFetch();
      vi.stubGlobal('fetch', fetchMock);

      await syncDeployments(mode, rpc);

      const urls = fetchMock.mock.calls.map(([u]) => String(u));
      expect(urls.length).toBeGreaterThan(0);
      for (const u of urls) {
        expect(u.startsWith(`${PINNED}/broadcast/`), u).toBe(true);
        expect(u).not.toMatch(/\/circuits\/main\//);
        expect(u).not.toContain('api.github.com');
        expect(u).not.toContain('releases');
      }
    });
  }

  it('the pin is a full commit SHA, not a branch or a tag', () => {
    expect(CIRCUITS_COMMIT).toMatch(/^[0-9a-f]{40}$/);
  });

  it('reports no update when a record differs from the fallback only in letter case', async () => {
    const { syncDeployments } = await freshDeployments();
    const { FALLBACK_VERIFIERS } = await import('../src/config/contracts.js');
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const chain = /\/(\d+)\/run-latest\.json$/.exec(url)?.[1] ?? '';
      const circuit = Object.entries({
        DeployCoinbaseAttestationV2: 'coinbase_attestation', DeployCoinbaseCountryAttestationV2: 'coinbase_country_attestation',
        DeployOidcDomainAttestation: 'oidc_domain_attestation', DeployGiwaAttestation: 'giwa_attestation',
        DeployHumanPassportScore: 'human_passport_score',
      }).find(([script]) => url.includes(`/${script}.s.sol/`))?.[1] as string;
      const fallback = FALLBACK_VERIFIERS[chain]?.[circuit as 'giwa_attestation'];
      if (!fallback) return { ok: false, status: 404, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ transactions: [{ contractName: 'HonkVerifier', contractAddress: fallback.toLowerCase() }] }) };
    }));
    await expect(syncDeployments('testnet', 'https://sepolia.base.org')).resolves.toBe(false);
  });

  it('syncs GIWA Sepolia, the only chain giwa_attestation lives on', async () => {
    const { syncDeployments, getVerifierAddress } = await freshDeployments();
    const fetchMock = broadcastFetch();
    vi.stubGlobal('fetch', fetchMock);

    await syncDeployments('testnet', 'https://sepolia.base.org');

    const urls = fetchMock.mock.calls.map(([u]) => String(u));
    expect(urls).toContain(`${PINNED}/broadcast/DeployGiwaAttestation.s.sol/91342/run-latest.json`);
    expect(getVerifierAddress('giwa_attestation', '91342')).toBe(ADDR);
  });
});

/**
 * Production never replaces a core-pinned verifier with one core does not pin:
 * published clients would refuse every proof naming it. On 2026-10-29 the
 * release then read (v1.3.0) named OIDC v1 verifiers on Base and Ethereum.
 * A pinned commit can name an unpinned mainnet verifier too (a redeploy
 * recorded before core's release), so the guard stays.
 */
describe('production keeps a core-pinned verifier over an unpinned record', () => {
  const OLD: Record<string, string> = {
    'DeployOidcDomainAttestation.s.sol/8453': '0x9677ba46ad226ce8b3c4517d9c0143e4d458beae',
    'DeployOidcDomainAttestation.s.sol/1': '0x440eaa25603ed5480cad0ee51d9808a1993ef267',
    'DeployCoinbaseCountryAttestationV2.s.sol/8453': '0xf3d5a09d2c85b28c52ef2905c1be3a852b609d0c',
    'DeployCoinbaseCountryAttestationV2.s.sol/1': '0x78792554e1582cb49d858eacb5c3607b42d28224',
    'DeployCoinbaseAttestationV2.s.sol/8453': ADDR,
  };

  function unpinnedFetch() {
    return vi.fn(async (url: string) => {
      const key = Object.keys(OLD).find(k => url.includes(`/broadcast/${k}/`));
      if (!key) return { ok: false, status: 404, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ transactions: [{ contractName: 'HonkVerifier', contractAddress: OLD[key] }] }) };
    });
  }

  it('ignores the unpinned record for every pinned row, on Base and Ethereum', async () => {
    const fresh = await freshDeployments();
    const { FALLBACK_VERIFIERS } = await import('../src/config/contracts.js');
    const fetchMock = unpinnedFetch();
    vi.stubGlobal('fetch', fetchMock);

    await fresh.syncDeployments('mainnet', 'https://mainnet.base.org');

    expect(fetchMock.mock.calls.map(([u]) => String(u))).toContain(
      `${PINNED}/broadcast/DeployOidcDomainAttestation.s.sol/8453/run-latest.json`,
    );
    for (const chain of ['1', '8453']) {
      for (const circuit of ['oidc_domain_attestation', 'coinbase_country_attestation'] as const) {
        expect(fresh.getVerifierAddress(circuit, chain), `${circuit} on ${chain}`).toBe(FALLBACK_VERIFIERS[chain][circuit]);
      }
    }
    expect(fresh.getVerifierAddress('coinbase_attestation', '8453')).toBe(FALLBACK_VERIFIERS['8453'].coinbase_attestation);
  });

  it('staging takes the pinned commit\'s record over a pinned row', async () => {
    const fresh = await freshDeployments();
    vi.stubGlobal('fetch', broadcastFetch());

    await fresh.syncDeployments('testnet', 'https://sepolia.base.org');

    expect(fresh.getVerifierAddress('oidc_domain_attestation', '84532')).toBe(ADDR);
  });
});
