import { describe, it, expect, vi } from 'vitest';
import { ApprovalWallet } from '../src/wallet';
import { freezeAction } from '../src/model';
const address = `0x${'a'.repeat(40)}`;
const other = `0x${'b'.repeat(40)}`;
const frozen = (chainId = 8453) => freezeAction({ domain: { name: 'Test', version: '1', chainId, verifyingContract: address }, types: { Action: [{ name: 'count', type: 'uint256' }] }, primaryType: 'Action', message: { count: '0' } });
function setup(chainId = 8453) {
    let accounts = [address];
    let chain: unknown = '0x2105';
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const provider = {
        request: vi.fn(async ({ method }: {
            method: string;
            params?: unknown[];
        }) => {
            if (method === 'eth_accounts' || method === 'eth_requestAccounts')
                return accounts;
            if (method === 'eth_chainId')
                return chain;
            if (method === 'eth_signTypedData_v4')
                return `0x${'1'.repeat(130)}`;
            throw new Error('unsupported');
        }),
        on: (event: string, listener: (...args: unknown[]) => void) => { listeners.set(event, listener); },
        removeListener: (event: string) => { listeners.delete(event); },
    };
    const submit = vi.fn(async () => { });
    const wallet = new ApprovalWallet(frozen(chainId), address, () => true, submit, vi.fn());
    return { wallet, provider, submit, listeners, setAccounts: (a: string[]) => { accounts = a; }, setChain: (c: unknown) => { chain = c; } };
}
describe('simulated wallet approval safety', () => {
    // Installed WalletConnect returns a number; injected providers commonly return hex.
    it.each([91342, '0x164ce', '0x164CE'])('accepts GIWA chain result %s and preserves the numeric signing domain', async chain => {
        const s = setup(91342);
        s.setChain(chain);
        await s.wallet.connect(s.provider);
        expect(s.wallet.address).toBe(address);
        await s.wallet.sign();
        expect(s.submit).toHaveBeenCalledTimes(1);
        const sign = s.provider.request.mock.calls.find(([request]) => request.method === 'eth_signTypedData_v4')!;
        expect(JSON.parse(sign[0].params![1] as string).domain.chainId).toBe(91342);
        expect(s.provider.request.mock.calls.filter(([request]) => request.method === 'eth_chainId')).toHaveLength(3);
    });
    it.each([91343, '0x164cf', 0, -91342, 91342.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '91342', '0x', '0x164cg', null, undefined, true, {}])('rejects wrong or malformed chain result %s before signing', async chain => {
        const s = setup(91342);
        s.setChain(chain);
        await expect(s.wallet.connect(s.provider)).rejects.toThrow(/chain/i);
        expect(s.wallet.address).toBeUndefined();
        expect(s.provider.request.mock.calls.some(([request]) => request.method === 'eth_signTypedData_v4')).toBe(false);
        expect(s.submit).not.toHaveBeenCalled();
    });
    it('rejects a silently changed numeric chain after the wallet signature resolves', async () => {
        const s = setup(91342);
        s.setChain('0x164ce');
        await s.wallet.connect(s.provider);
        s.provider.request.mockImplementation(async ({ method }) => {
            if (method === 'eth_accounts') return [address];
            if (method === 'eth_chainId') return s.provider.request.mock.calls.some(([request]) => request.method === 'eth_signTypedData_v4') ? 91343 : 91342;
            return `0x${'1'.repeat(130)}`;
        });
        await expect(s.wallet.sign()).rejects.toThrow(/chain/i);
        expect(s.provider.request.mock.calls.some(([request]) => request.method === 'eth_signTypedData_v4')).toBe(true);
        expect(s.submit).not.toHaveBeenCalled();
    });
    it('submits exact frozen typed data once after account and chain rechecks', async () => {
        const s = setup();
        await s.wallet.connect(s.provider);
        await s.wallet.sign();
        expect(s.submit).toHaveBeenCalledTimes(1);
        expect(s.submit).toHaveBeenCalledWith(address, `0x${'1'.repeat(130)}`);
        const call = s.provider.request.mock.calls.find(([p]) => p.method === 'eth_signTypedData_v4')!;
        expect(JSON.parse(call[0].params![1] as string).message).toEqual({ count: '0' });
        expect(s.provider.request.mock.calls.filter(([p]) => p.method === 'eth_chainId').length).toBeGreaterThanOrEqual(3);
    });
    it.each(['accountsChanged', 'chainChanged', 'disconnect'])('does not submit after %s during signing', async (event) => {
        const s = setup();
        await s.wallet.connect(s.provider);
        s.provider.request.mockImplementation(async ({ method }) => {
            if (method === 'eth_accounts')
                return [address];
            if (method === 'eth_chainId')
                return '0x2105';
            s.listeners.get(event)?.();
            return `0x${'1'.repeat(130)}`;
        });
        await expect(s.wallet.sign()).rejects.toThrow();
        expect(s.submit).not.toHaveBeenCalled();
        expect(s.wallet.address).toBeUndefined();
    });
    it.each([4001, 4200, 4900])('keeps rejected/unsupported/disconnected signing unapproved (%s)', async (code) => {
        const s = setup();
        await s.wallet.connect(s.provider);
        s.provider.request.mockImplementation(async ({ method }) => {
            if (method === 'eth_accounts')
                return [address];
            if (method === 'eth_chainId')
                return '0x2105';
            throw Object.assign(new Error('private wallet detail'), { code });
        });
        await expect(s.wallet.sign()).rejects.toThrow();
        expect(s.submit).not.toHaveBeenCalled();
    });
    it('detects silent account changes after signing, even without provider events', async () => {
        const s = setup();
        await s.wallet.connect(s.provider);
        s.provider.request.mockImplementation(async ({ method }) => {
            if (method === 'eth_accounts')
                return s.provider.request.mock.calls.some(([p]) => p.method === 'eth_signTypedData_v4') ? [other] : [address];
            if (method === 'eth_chainId')
                return '0x2105';
            return `0x${'1'.repeat(130)}`;
        });
        await expect(s.wallet.sign()).rejects.toThrow();
        expect(s.submit).not.toHaveBeenCalled();
    });
    it('rejects wrong expected wallet and wrong chain without signing', async () => {
        const s = setup();
        s.setAccounts([other]);
        await expect(s.wallet.connect(s.provider)).rejects.toThrow(/wallet/i);
        s.setAccounts([address]);
        s.setChain('0x1');
        await expect(s.wallet.connect(s.provider)).rejects.toThrow(/chain/i);
        expect(s.submit).not.toHaveBeenCalled();
    });
    it('requires account/chain/disconnect event support from a compatible provider', async () => {
        const s = setup();
        await expect(s.wallet.connect({ request: s.provider.request })).rejects.toThrow(/events/i);
        expect(s.submit).not.toHaveBeenCalled();
    });
    it('does not retry an approval POST with an unknown server outcome', async () => {
        const s = setup();
        s.submit.mockRejectedValueOnce(new Error('network failed'));
        await s.wallet.connect(s.provider);
        await expect(s.wallet.sign()).rejects.toThrow();
        await expect(s.wallet.sign()).rejects.toThrow();
        expect(s.submit).toHaveBeenCalledTimes(1);
    });
    it('does not sign an expired/rejected request or accept duplicate clicks', async () => {
        const s = setup();
        const wallet = new ApprovalWallet(frozen(), address, () => false, s.submit, vi.fn());
        await wallet.connect(s.provider);
        await expect(wallet.sign()).rejects.toThrow();
        expect(s.submit).not.toHaveBeenCalled();
        await s.wallet.connect(s.provider);
        await Promise.allSettled([s.wallet.sign(), s.wallet.sign()]);
        expect(s.submit).toHaveBeenCalledTimes(1);
    });
});
