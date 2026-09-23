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
        connected: true, chainId: 91342, rpcChainId: 91342, accounts: session ? [address] : [],
        connect: vi.fn(async () => { provider.session = activeSession(); provider.accounts = [address]; }),
        disconnect: vi.fn(async () => { provider.session = undefined; provider.accounts = []; }),
        request: vi.fn(async ({ method, params }: { method: string; params?: unknown[] }) => {
            if (method === 'eth_chainId') return provider.rpcChainId;
            if (method === 'wallet_switchEthereumChain') {
                const chainId = (params?.[0] as { chainId: string }).chainId;
                if (!provider.session?.namespaces.eip155.accounts.some(account => account.startsWith(`eip155:${Number(chainId)}:`)))
                    throw new Error('Switching to an unapproved chain is forbidden');
                provider.rpcChainId = Number(chainId);
                return null;
            }
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
    it.each([{ wrapper: 91342, reported: 1 }, { wrapper: 1, reported: 91342 }])('synchronizes installed 2.25.0 restored caches (wrapper $wrapper, reported $reported)', async initial => {
        const { EthereumProvider } = await import('@walletconnect/ethereum-provider');
        const { UniversalProvider } = await import('@walletconnect/universal-provider');
        const store = new Map<string, unknown>();
        const storage = {
            getItem: async (key: string) => store.get(key),
            setItem: async (key: string, value: unknown) => { store.set(key, value); },
            removeItem: async (key: string) => { store.delete(key); },
        };
        // Construct the actual installed dependency classes offline. Only the
        // storage/client boundary is simulated; no Core, relay or phone is used.
        const universal = new UniversalProvider({ disableProviderPing: true });
        const walletRequest = vi.fn(async () => { throw new Error('Unexpected phone request'); });
        universal.client = { core: { projectId: 'offline-fixture', storage }, request: walletRequest, on: () => {} } as never;
        universal.namespaces = {
            eip155: { chains: ['eip155:1', 'eip155:91342'], methods: ['eth_signTypedData_v4'], events: ['chainChanged'], defaultChain: String(initial.reported) },
        };
        universal.optionalNamespaces = {};
        universal.session = { topic: 'offline-fixture', namespaces: { eip155: {
            ...universal.namespaces.eip155, accounts: [`eip155:1:${address}`, `eip155:91342:${address}`],
        } } } as never;
        (universal as any).createProviders();
        (universal as any).registerEventListeners();
        const ethereum = new EthereumProvider(); ethereum.signer = universal;
        (ethereum as any).registerEventListeners();
        store.set(`${ethereum.STORAGE_KEY}/chainId`, initial.wrapper);
        await (ethereum as any).loadPersistedSession();
        expect(ethereum.chainId).toBe(initial.wrapper);
        expect(await ethereum.request({ method: 'eth_chainId' })).toBe(initial.reported);
        mock.init.mockResolvedValue(ethereum);
        const { mobileWallet } = await import('../src/walletconnect');
        const wallet = await mobileWallet('project-id', 91342);
        expect(await wallet.request({ method: 'eth_chainId' })).toBe(91342);
        expect(ethereum.chainId).toBe(91342);
        expect(walletRequest).not.toHaveBeenCalled();
        expect(mock.init).toHaveBeenCalledTimes(1);
    });
    it.each(['restored', 'new pairing'])('synchronizes an approved chain before returning a %s session', async state => {
        const provider = providerFixture(state === 'restored' ? activeSession() : undefined);
        provider.rpcChainId = 1; mock.init.mockResolvedValue(provider);
        const { mobileWallet } = await import('../src/walletconnect');
        const wallet = await mobileWallet('project-id', 91342);
        expect(await wallet.request({ method: 'eth_chainId' })).toBe(91342);
        expect(provider.request).toHaveBeenCalledWith({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x164ce' }] });
        expect(provider.chainId).toBe(91342);
        expect(provider.accounts).toEqual([address]);
        expect(provider.request.mock.calls.some(([request]) => request.method === 'eth_signTypedData_v4')).toBe(false);
        expect(provider.connect).toHaveBeenCalledTimes(state === 'restored' ? 0 : 1);
        expect(mock.init).toHaveBeenCalledTimes(1);
    });
    it('rejects a chain synchronization that leaves the returned chain incorrect', async () => {
        const provider = providerFixture(activeSession()); provider.rpcChainId = 1;
        provider.request.mockImplementation(async ({ method }) => method === 'eth_chainId' ? 1 : null);
        mock.init.mockResolvedValue(provider);
        const { mobileWallet } = await import('../src/walletconnect');
        await expect(mobileWallet('project-id', 91342)).rejects.toThrow(/chain|network/i);
        expect(provider.request.mock.calls.some(([request]) => request.method === 'eth_signTypedData_v4')).toBe(false);
    });
    it('propagates rejected synchronization without returning a usable wallet', async () => {
        const provider = providerFixture(activeSession()); provider.rpcChainId = 1;
        provider.request.mockImplementation(async ({ method }) => {
            if (method === 'eth_chainId') return 1;
            throw Object.assign(new Error('Chain synchronization rejected'), { code: 4001 });
        });
        mock.init.mockResolvedValue(provider);
        const { mobileWallet } = await import('../src/walletconnect');
        await expect(mobileWallet('project-id', 91342)).rejects.toMatchObject({ code: 4001 });
        expect(provider.connect).not.toHaveBeenCalled();
    });
    it('resets the session so the next selection opens fresh pairing on the same Core', async () => {
        const provider = providerFixture(activeSession()); mock.init.mockResolvedValue(provider);
        const walletConnect = await import('../src/walletconnect');
        await walletConnect.mobileWallet('project-id', 91342);
        expect(walletConnect.resetMobileWallet).toBeTypeOf('function');
        await walletConnect.resetMobileWallet();
        expect(provider.session).toBeUndefined();
        expect(provider.disconnect).toHaveBeenCalledTimes(1);
        expect(provider.connect).not.toHaveBeenCalled();
        expect(await walletConnect.mobileWallet('project-id', 91342)).toBe(provider);
        expect(provider.connect).toHaveBeenCalledTimes(1);
        expect(mock.init).toHaveBeenCalledTimes(1);
    });
    it('refuses reset while pairing is in flight', async () => {
        const provider = providerFixture(); mock.init.mockResolvedValue(provider);
        let finishPairing!: () => void;
        provider.connect.mockImplementation(() => new Promise<void>(resolve => {
            finishPairing = () => { provider.session = activeSession(); provider.accounts = [address]; resolve(); };
        }));
        const { mobileWallet, resetMobileWallet } = await import('../src/walletconnect');
        const pairing = mobileWallet('project-id', 91342);
        await vi.waitFor(() => expect(provider.connect).toHaveBeenCalledTimes(1));
        await expect(resetMobileWallet()).rejects.toThrow(/finish|close|request/i);
        expect(provider.disconnect).not.toHaveBeenCalled();
        finishPairing();
        expect(await pairing).toBe(provider);
    });
    it('refuses connection while reset is in flight', async () => {
        const provider = providerFixture(activeSession()); mock.init.mockResolvedValue(provider);
        let finishReset!: () => void;
        provider.disconnect.mockImplementation(() => new Promise<void>(resolve => {
            finishReset = () => { provider.session = undefined; provider.accounts = []; resolve(); };
        }));
        const { mobileWallet, resetMobileWallet } = await import('../src/walletconnect');
        await mobileWallet('project-id', 91342);
        const resetting = resetMobileWallet();
        await vi.waitFor(() => expect(provider.disconnect).toHaveBeenCalledTimes(1));
        await expect(mobileWallet('project-id', 91342)).rejects.toThrow(/disconnect|wait/i);
        expect(provider.connect).not.toHaveBeenCalled();
        finishReset(); await resetting;
        expect(await mobileWallet('project-id', 91342)).toBe(provider);
        expect(provider.connect).toHaveBeenCalledTimes(1);
        expect(mock.init).toHaveBeenCalledTimes(1);
    });
    it('propagates disconnect failure and allows an explicit retry', async () => {
        const provider = providerFixture(activeSession()); mock.init.mockResolvedValue(provider);
        provider.disconnect.mockRejectedValueOnce(new Error('Disconnect failed'));
        const { mobileWallet, resetMobileWallet } = await import('../src/walletconnect');
        await mobileWallet('project-id', 91342);
        await expect(resetMobileWallet()).rejects.toThrow('Disconnect failed');
        expect(provider.session).toBeDefined();
        await resetMobileWallet();
        expect(provider.session).toBeUndefined();
        expect(provider.disconnect).toHaveBeenCalledTimes(2);
        expect(provider.connect).not.toHaveBeenCalled();
        expect(mock.init).toHaveBeenCalledTimes(1);
    });
    it('rejects a newly paired session that did not approve the requested chain before switching', async () => {
        const provider = providerFixture(); mock.init.mockResolvedValue(provider);
        provider.connect.mockImplementation(async () => {
            const wrong = activeSession();
            wrong.namespaces.eip155.chains = ['eip155:8453'];
            wrong.namespaces.eip155.accounts = [`eip155:8453:${address}`];
            provider.session = wrong; provider.accounts = [address];
        });
        const { mobileWallet } = await import('../src/walletconnect');
        await expect(mobileWallet('project-id', 91342)).rejects.toThrow(/approved|chain/i);
        expect(provider.request).not.toHaveBeenCalled();
        expect(provider.connect).toHaveBeenCalledTimes(1);
    });
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
