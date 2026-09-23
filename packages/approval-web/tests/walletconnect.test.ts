import { it, expect, vi } from 'vitest';
const mock = vi.hoisted(() => ({ connect: vi.fn(async () => { }), init: vi.fn() }));
vi.mock('@walletconnect/ethereum-provider', () => ({ EthereumProvider: { init: mock.init } }));
import { mobileWallet } from '../src/walletconnect';
it('opens an explicit WalletConnect session with the requested chain and origin-only metadata', async () => {
    vi.stubGlobal('location', { origin: 'https://approval.example', href: 'https://approval.example/approve/private#capability' });
    const provider = { connect: mock.connect, request: vi.fn() };
    mock.init.mockResolvedValue(provider);
    expect(await mobileWallet('project-id', 91337)).toBe(provider);
    expect(mock.connect).toHaveBeenCalledTimes(1);
    expect(mock.init.mock.calls[0][0]).toMatchObject({ projectId: 'project-id', optionalChains: [91337], showQrModal: true, metadata: { url: 'https://approval.example' } });
    expect(JSON.stringify(mock.init.mock.calls[0][0])).not.toContain('capability');
    vi.unstubAllGlobals();
});
