import { describe, expect, it, vi } from 'vitest';
import { ensureTestnetUsdc } from '../scripts/request-testnet-usdc.js';
const address = '0x8e635EDd51d35A1db33Ef24C9B99B87E1156604B';
const tx = '0x' + 'ab'.repeat(32);
const credentials = { apiKeyId: 'test-id', apiKeySecret: 'SECRET_DO_NOT_LOG' };
function dependencies(balance = 0n) {
  return { balanceOf: vi.fn().mockResolvedValue(balance), requestFaucet: vi.fn().mockResolvedValue({ transactionHash: tx }) };
}

describe('explicit existing-wallet testnet USDC funding', () => {
  it.each(['base', 'ethereum', 'arc-testnet', '', 'Ethereum-sepolia'])('rejects unsupported network %s before any RPC or faucet', async network => {
    const deps = dependencies();
    await expect(ensureTestnetUsdc({ network, address, credentials }, deps)).rejects.toThrow(/base-sepolia.*ethereum-sepolia/);
    expect(deps.balanceOf).not.toHaveBeenCalled(); expect(deps.requestFaucet).not.toHaveBeenCalled();
  });
  it.each(['', '0x1234', '0x' + '00'.repeat(20)])('requires an existing nonzero address: %s', async target => {
    const deps = dependencies();
    await expect(ensureTestnetUsdc({ network: 'ethereum-sepolia', address: target, credentials }, deps)).rejects.toThrow(/address/i);
    expect(deps.requestFaucet).not.toHaveBeenCalled();
  });
  it.each(['0', '-1', 'NaN', '0.0000001'])('rejects invalid minimum %s', async minimumUsdc => {
    const deps = dependencies();
    await expect(ensureTestnetUsdc({ network: 'ethereum-sepolia', address, minimumUsdc, credentials }, deps)).rejects.toThrow(/minimum/i);
    expect(deps.requestFaucet).not.toHaveBeenCalled();
  });
  it('does not call faucet when existing balance is sufficient, even without credentials', async () => {
    const deps = dependencies(10_000n);
    const result = await ensureTestnetUsdc({ network: 'ethereum-sepolia', address }, deps);
    expect(result.status).toBe('adequate'); expect(deps.requestFaucet).not.toHaveBeenCalled();
  });
  it.each([undefined, {}, { apiKeyId: 'id' }, { apiKeySecret: 'secret' }])('reports missing credentials without calling faucet', async credentials => {
    const deps = dependencies();
    const result = await ensureTestnetUsdc({ network: 'ethereum-sepolia', address, credentials }, deps);
    expect(result.status).toBe('missing_credentials'); expect(deps.requestFaucet).not.toHaveBeenCalled();
  });
  it.each(['base-sepolia', 'ethereum-sepolia'])('requests only USDC for the supplied existing wallet on %s', async network => {
    const deps = dependencies();
    const result = await ensureTestnetUsdc({ network, address, credentials }, deps);
    expect(result).toMatchObject({ status: 'requested', transactionHash: tx, network });
    expect(deps.requestFaucet).toHaveBeenCalledOnce();
    expect(deps.requestFaucet).toHaveBeenCalledWith({ address: expect.any(String), network, token: 'usdc' }, credentials);
    expect(deps.requestFaucet.mock.calls[0][0].address.toLowerCase()).toBe(address.toLowerCase());
  });
  it.each(['status', 'statusCode'])('reports rate limiting through %s without leaking provider error or retrying', async field => {
    const deps = dependencies(); deps.requestFaucet.mockRejectedValue({ [field]: 429, message: credentials.apiKeySecret });
    const result = await ensureTestnetUsdc({ network: 'ethereum-sepolia', address, credentials }, deps);
    expect(result.status).toBe('rate_limited'); expect(JSON.stringify(result)).not.toContain(credentials.apiKeySecret);
    expect(deps.requestFaucet).toHaveBeenCalledOnce();
  });
  it('sanitizes unknown faucet errors and balance RPC failures', async () => {
    const deps = dependencies(); deps.requestFaucet.mockRejectedValue(new Error(credentials.apiKeySecret));
    expect(await ensureTestnetUsdc({ network: 'ethereum-sepolia', address, credentials }, deps)).toMatchObject({ status: 'faucet_failed' });
    deps.balanceOf.mockRejectedValue(new Error(credentials.apiKeySecret)); deps.requestFaucet.mockClear();
    const result = await ensureTestnetUsdc({ network: 'ethereum-sepolia', address, credentials }, deps);
    expect(result.status).toBe('balance_unavailable'); expect(JSON.stringify(result)).not.toContain(credentials.apiKeySecret);
    expect(deps.requestFaucet).not.toHaveBeenCalled();
  });
});
