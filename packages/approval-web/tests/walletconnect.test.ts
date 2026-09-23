import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Pairing touches relays, browser storage and the QR modal. Simulate that boundary,
// while exercising the real module's initialization and retry lifecycle.
const mock = { init: vi.fn() };
const address = `0x${'a'.repeat(40)}`;
const activeSession = () => ({
    topic: 'fixture-session', expiry: 2_000_000_000,
    namespaces: { eip155: { chains: ['eip155:91342'], accounts: [`eip155:91342:${address}`], methods: ['eth_signTypedData_v4'], events: ['accountsChanged', 'chainChanged'] } },
});
function providerFixture(session?: ReturnType<typeof activeSession>) {
    const provider = {
        session,
        // The actual dependency's connected property describes relay connectivity.
        connected: true, chainId: 91342, accounts: session ? [address] : [],
        connect: vi.fn(async () => { provider.session = activeSession(); provider.accounts = [address]; }),
        disconnect: vi.fn(async () => { provider.session = undefined; provider.accounts = []; }),
        request: vi.fn(async ({ method }: { method: string }) => {
            if (method === 'eth_chainId') return 91342;
            if (method === 'eth_accounts' || method === 'eth_requestAccounts') return provider.accounts;
            throw new Error('Unsupported fixture request');
        }),
        on: vi.fn(), removeListener: vi.fn(),
    };
    return provider;
}
beforeEach(async () => {
    vi.restoreAllMocks(); vi.resetModules(); mock.init.mockReset();
    vi.stubGlobal('location', { origin: 'https://approval.example', href: 'https://approval.example/approve/private#capability' });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Unexpected unit test network request'); }));
    vi.stubGlobal('WebSocket', class { constructor() { throw new Error('Unexpected unit test WebSocket'); } });
    // Spy on the installed class's external initialization boundary. Concurrent
    // dynamic imports must observe the same spy; a virtual module mock can be
    // bypassed by Vitest's overlapping-import recursion handling.
    const { EthereumProvider } = await import('@walletconnect/ethereum-provider');
    vi.spyOn(EthereumProvider, 'init').mockImplementation(mock.init);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('simulated WalletConnect provider lifecycle', () => {
    it('starts the requested session with origin-only metadata and numeric chain support', async () => {
        const provider = providerFixture(); mock.init.mockResolvedValue(provider);
        const { mobileWallet } = await import('../src/walletconnect');
        const wallet = await mobileWallet('project-id', 91342);
        expect(wallet).toBe(provider);
        expect(await wallet.request({ method: 'eth_accounts' })).toEqual([address]);
        expect(await wallet.request({ method: 'eth_chainId' })).toBe(91342);
        expect(provider.connect).toHaveBeenCalledTimes(1);
        expect(mock.init.mock.calls[0][0]).toMatchObject({ projectId: 'project-id', optionalChains: [91342], showQrModal: true, metadata: { url: 'https://approval.example' } });
        expect(JSON.stringify(mock.init.mock.calls[0][0])).not.toContain('capability');
    });
    it('reuses the same initialized provider and active session on repeated selection', async () => {
        const provider = providerFixture(); mock.init.mockResolvedValue(provider);
        const { mobileWallet } = await import('../src/walletconnect');
        const first = await mobileWallet('project-id', 91342);
        const second = await mobileWallet('project-id', 91342);
        expect(second).toBe(first);
        expect(mock.init).toHaveBeenCalledTimes(1);
        expect(provider.connect).toHaveBeenCalledTimes(1);
        expect(await second.request({ method: 'eth_accounts' })).toEqual([address]);
    });
    it('does not create a new pairing when initialization restores an active session', async () => {
        const provider = providerFixture(activeSession()); mock.init.mockResolvedValue(provider);
        const { mobileWallet } = await import('../src/walletconnect');
        expect(await mobileWallet('project-id', 91342)).toBe(provider);
        expect(provider.connect).not.toHaveBeenCalled();
        expect(provider.disconnect).not.toHaveBeenCalled();
        expect(provider.session?.topic).toBe('fixture-session');
    });
    it.each(['different chain', 'missing signing permission'])('re-pairs an incompatible restored session (%s) on the same provider', async incompatibility => {
        const session = activeSession();
        if (incompatibility === 'different chain') {
            session.namespaces.eip155.chains = ['eip155:8453'];
            session.namespaces.eip155.accounts = [`eip155:8453:${address}`];
        }
        else session.namespaces.eip155.methods = ['eth_accounts'];
        const provider = providerFixture(session); mock.init.mockResolvedValue(provider);
        provider.connect.mockImplementation(async () => {
            // Pairing must start only after disconnect has cleared the old session.
            expect(provider.session).toBeUndefined();
            provider.session = activeSession(); provider.accounts = [address];
        });
        const { mobileWallet } = await import('../src/walletconnect');
        expect(await mobileWallet('project-id', 91342)).toBe(provider);
        expect(provider.disconnect).toHaveBeenCalledTimes(1);
        expect(provider.connect).toHaveBeenCalledTimes(1);
        expect(mock.init).toHaveBeenCalledTimes(1);
        expect(provider.session?.namespaces.eip155.accounts).toEqual([`eip155:91342:${address}`]);
        expect(provider.session?.namespaces.eip155.methods).toContain('eth_signTypedData_v4');
    });
    it('retries cancelled pairing on the same initialized provider', async () => {
        const provider = providerFixture(); mock.init.mockResolvedValue(provider);
        provider.connect.mockRejectedValueOnce(Object.assign(new Error('Pairing cancelled'), { code: 4001 }));
        const { mobileWallet } = await import('../src/walletconnect');
        await expect(mobileWallet('project-id', 91342)).rejects.toThrow('Pairing cancelled');
        expect(provider.session).toBeUndefined();
        const recovered = await mobileWallet('project-id', 91342);
        expect(recovered).toBe(provider);
        expect(mock.init).toHaveBeenCalledTimes(1);
        expect(provider.connect).toHaveBeenCalledTimes(2);
        expect(await recovered.request({ method: 'eth_accounts' })).toEqual([address]);
    });
    it('reconnects a disconnected session without constructing another provider', async () => {
        const provider = providerFixture(); mock.init.mockResolvedValue(provider);
        const { mobileWallet } = await import('../src/walletconnect');
        await mobileWallet('project-id', 91342);
        provider.session = undefined; provider.accounts = [];
        expect(await mobileWallet('project-id', 91342)).toBe(provider);
        expect(mock.init).toHaveBeenCalledTimes(1);
        expect(provider.connect).toHaveBeenCalledTimes(2);
        expect(provider.session).toBeDefined();
    });
    it('shares one initialization and pairing across concurrent callers', async () => {
        const provider = providerFixture();
        const finishPairings: Array<() => void> = [];
        provider.connect.mockImplementation(() => new Promise<void>(resolve => {
            finishPairings.push(() => { provider.session = activeSession(); provider.accounts = [address]; resolve(); });
        }));
        mock.init.mockResolvedValue(provider);
        const { mobileWallet } = await import('../src/walletconnect');
        const first = mobileWallet('project-id', 91342);
        const second = mobileWallet('project-id', 91342);
        await vi.waitFor(() => expect(provider.connect).toHaveBeenCalled());
        finishPairings.forEach(finish => finish());
        const connected = await Promise.all([first, second]);
        expect(mock.init).toHaveBeenCalledTimes(1);
        expect(provider.connect).toHaveBeenCalledTimes(1);
        expect(connected).toEqual([provider, provider]);
    });
    it('allows retry after initialization itself fails', async () => {
        const provider = providerFixture();
        mock.init.mockRejectedValueOnce(new Error('Initialization failed')).mockResolvedValueOnce(provider);
        const { mobileWallet } = await import('../src/walletconnect');
        await expect(mobileWallet('project-id', 91342)).rejects.toThrow('Initialization failed');
        expect(await mobileWallet('project-id', 91342)).toBe(provider);
        expect(mock.init).toHaveBeenCalledTimes(2);
        expect(provider.connect).toHaveBeenCalledTimes(1);
    });
});
