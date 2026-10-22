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
