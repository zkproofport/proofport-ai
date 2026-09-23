import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApprovalEthereumProvider } from '../src/mobile-provider';
import { UniversalProvider } from '@walletconnect/universal-provider';
import { ApprovalWallet } from '../src/wallet';
import { freezeAction } from '../src/model';

const address = `0x${'a'.repeat(40)}`;
beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Unexpected test network request'); }));
    vi.stubGlobal('WebSocket', class { constructor() { throw new Error('Unexpected test WebSocket'); } });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function pairingFixture() {
    const events = new EventEmitter();
    const store = new Map<string, unknown>();
    let writes = 0, releaseWrite!: () => void, writeStarted!: () => void;
    const started = new Promise<void>(resolve => { writeStarted = resolve; });
    const firstWrite = new Promise<void>(resolve => { releaseWrite = resolve; });
    const storage = {
        getItem: async (key: string) => store.get(key),
        setItem: async (key: string, value: unknown) => {
            store.set(key, value);
            if (++writes === 1) { writeStarted(); await firstWrite; }
        },
        removeItem: async (key: string) => { store.delete(key); },
    };
    const namespace = {
        chains: ['eip155:91342', 'eip155:1'],
        accounts: [`eip155:91342:${address}`, `eip155:1:${address}`],
        methods: ['eth_signTypedData_v4'], events: ['chainChanged', 'accountsChanged'],
    };
    const session = { topic: 'offline-session', namespaces: { eip155: namespace } };
    const phoneRequest = vi.fn(async (): Promise<unknown> => { throw new Error('Unexpected phone request'); });
    const universal = new UniversalProvider({ disableProviderPing: true, logger: 'silent' });
    universal.client = {
        core: { projectId: 'offline-fixture', storage }, on: events.on.bind(events),
        connect: async () => ({ approval: async () => session }), request: phoneRequest,
    } as never;
    universal.namespaces = {};
    universal.optionalNamespaces = { eip155: namespace };
    (universal as any).registerEventListeners();
    const ethereum = new ApprovalEthereumProvider();
    ethereum.signer = universal;
    (ethereum as any).registerEventListeners();
    const returnedRequests: Array<Promise<{ fulfilled: boolean; error?: unknown }>> = [];
    const request = ethereum.request.bind(ethereum);
    const requestSpy = vi.spyOn(ethereum, 'request').mockImplementation(args => {
        const returned = request(args);
        // Observe each actual returned promise immediately. This records the
        // fire-and-forget rejection without suppressing process-wide failures.
        returnedRequests.push(returned.then(() => ({ fulfilled: true }), error => ({ fulfilled: false, error })));
        return returned;
    });
    const pairing = universal.pair(undefined);
    await started;
    const emitChain = (data: unknown) => events.emit('session_event', {
        topic: session.topic, params: { chainId: 'eip155:91342', event: { name: 'chainChanged', data } },
    });
    return { ethereum, universal, phoneRequest, requestSpy, returnedRequests, emitChain, releaseWrite, pairing };
}

describe('actual WalletConnect pairing and normalized event regression', () => {
    it('does not echo a chain notification into a request while pairing persistence is incomplete', async () => {
        const f = await pairingFixture();
        let returned;
        try {
            expect(f.universal.session).toBeDefined();
            expect(Object.keys((f.universal as any).rpcProviders)).toEqual([]);
            f.emitChain(91342);
            returned = await Promise.all(f.returnedRequests);
        }
        finally { f.releaseWrite(); await f.pairing; }
        expect(returned).toEqual([]);
        expect(f.requestSpy).not.toHaveBeenCalled();
        expect(f.phoneRequest).not.toHaveBeenCalled();
        expect(await f.ethereum.request({ method: 'eth_chainId' })).toBe(91342);
    });
    it('preserves genuine normalized chain changes and explicit public chain selection without echoing notifications', async () => {
        const f = await pairingFixture(); f.releaseWrite(); await f.pairing;
        const changed: unknown[] = [];
        f.ethereum.on('chainChanged', value => changed.push(value));
        for (const [input, expected] of [[1, 1], ['0x164ce', 91342], ['eip155:1', 1], [91342, 91342]] as const) {
            const before = f.requestSpy.mock.calls.length;
            f.emitChain(input);
            await Promise.all(f.returnedRequests);
            expect(f.requestSpy.mock.calls.length).toBe(before);
            expect(f.ethereum.chainId).toBe(expected);
            expect(await f.ethereum.request({ method: 'eth_chainId' })).toBe(expected);
        }
        expect(changed).toEqual(['0x1', '0x164ce', '0x1', '0x164ce']);
        await f.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x1' }] });
        expect(f.ethereum.chainId).toBe(1);
        expect(await f.ethereum.request({ method: 'eth_chainId' })).toBe(1);
        await f.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x164ce' }] });
        expect(f.ethereum.chainId).toBe(91342);
        expect(await f.ethereum.request({ method: 'eth_chainId' })).toBe(91342);
        expect(f.phoneRequest).not.toHaveBeenCalled();
    });
    it('still invalidates approval if the real normalized chain changes away and back during signing', async () => {
        const f = await pairingFixture(); f.releaseWrite(); await f.pairing;
        await f.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x164ce' }] });
        const submit = vi.fn(async () => {});
        const action = freezeAction({ domain: { name: 'Offline action', version: '1', chainId: 91342, verifyingContract: address }, primaryType: 'Action', types: { Action: [{ name: 'count', type: 'uint256' }] }, message: { count: '0' } });
        const wallet = new ApprovalWallet(action, address, () => true, submit, vi.fn());
        await wallet.connect(f.ethereum);
        f.phoneRequest.mockImplementation(async () => {
            f.emitChain(1); f.emitChain(91342);
            return `0x${'1'.repeat(130)}`;
        });
        await expect(wallet.sign()).rejects.toThrow(/wallet|changed|review/i);
        await Promise.all(f.returnedRequests);
        expect(submit).not.toHaveBeenCalled();
        expect(wallet.address).toBeUndefined();
        expect(f.phoneRequest).toHaveBeenCalledTimes(1);
    });
});
