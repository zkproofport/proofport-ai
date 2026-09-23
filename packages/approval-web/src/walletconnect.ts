import type { EthereumProvider } from '@walletconnect/ethereum-provider';
import { ApprovalError, matchesChain, type EvmProvider } from './wallet';

interface MobileConnection {
    projectId: string;
    chainId: number;
    provider?: Promise<InstanceType<typeof EthereumProvider>>;
    connecting?: Promise<EvmProvider>;
    resetting?: Promise<void>;
}
let connection: MobileConnection | undefined;
function grantsRequest(provider: InstanceType<typeof EthereumProvider>, chainId: number): boolean {
    return !!provider.session && Object.values(provider.session.namespaces).some(namespace =>
        namespace.accounts.some(account => account.startsWith(`eip155:${chainId}:`)) &&
        namespace.methods.includes('eth_signTypedData_v4'));
}

export async function resetMobileWallet(): Promise<void> {
    const current = connection;
    if (!current?.provider)
        return;
    if (current.connecting || current.resetting)
        throw new ApprovalError('Finish or close the current mobile wallet request before disconnecting.');
    const reset = current.provider.then(provider => provider.disconnect());
    current.resetting = reset;
    try { await reset; }
    finally { if (current.resetting === reset) current.resetting = undefined; }
}

export async function mobileWallet(projectId: string, chainId: number): Promise<EvmProvider> {
    if (!connection)
        connection = { projectId, chainId };
    const current = connection;
    if (current.resetting)
        throw new ApprovalError('The mobile wallet is disconnecting. Wait before connecting again.');
    if (current.projectId !== projectId || current.chainId !== chainId)
        throw new ApprovalError('The mobile wallet configuration changed. Reload this request before connecting.');
    if (!current.provider) {
        current.provider = import('./mobile-provider').then(({ ApprovalEthereumProvider }) => ApprovalEthereumProvider.init({
            projectId, optionalChains: [chainId], showQrModal: true,
            qrModalOptions: { themeVariables: { '--wcm-font-family': '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' } },
            optionalMethods: ['eth_signTypedData_v4', 'eth_accounts', 'eth_requestAccounts', 'eth_chainId'],
            optionalEvents: ['accountsChanged', 'chainChanged'],
            metadata: { name: 'ZKProofport', description: 'Review and approve a proof action with your wallet.', url: location.origin, icons: [] },
        })).catch(error => {
            current.provider = undefined;
            throw error;
        });
    }
    if (!current.connecting) {
        current.connecting = current.provider.then(async provider => {
            // Reconnecting the review UI must not create another Core or pairing.
            if (provider.session && !grantsRequest(provider, chainId))
                await provider.disconnect();
            if (!provider.session)
                await provider.connect();
            if (!grantsRequest(provider, chainId))
                throw new ApprovalError(`The mobile session has not approved chain ${chainId} and action signing. Reset the mobile connection and pair again.`);
            // WalletConnect restores the wrapper chain and its internal EIP-155
            // default separately. Select only a chain already granted by this
            // session, through the public API; this never changes the action.
            await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: `0x${chainId.toString(16)}` }] });
            const selected = await provider.request({ method: 'eth_chainId' });
            if (!matchesChain(selected, chainId) || !matchesChain(provider.chainId, chainId))
                throw new ApprovalError(`The mobile session could not select chain ${chainId}. Reset the mobile connection and pair again.`);
            return provider as unknown as EvmProvider;
        });
    }
    const attempt = current.connecting;
    try {
        return await attempt;
    }
    finally {
        if (current.connecting === attempt)
            current.connecting = undefined;
    }
}
