import type { EthereumProvider } from '@walletconnect/ethereum-provider';
import { ApprovalError, type EvmProvider } from './wallet';

interface MobileConnection {
    projectId: string;
    chainId: number;
    provider?: Promise<InstanceType<typeof EthereumProvider>>;
    connecting?: Promise<EvmProvider>;
}
let connection: MobileConnection | undefined;

export async function mobileWallet(projectId: string, chainId: number): Promise<EvmProvider> {
    if (!connection)
        connection = { projectId, chainId };
    const current = connection;
    if (current.projectId !== projectId || current.chainId !== chainId)
        throw new ApprovalError('The mobile wallet configuration changed. Reload this request before connecting.');
    if (!current.provider) {
        current.provider = import('@walletconnect/ethereum-provider').then(({ EthereumProvider }) => EthereumProvider.init({
            projectId, optionalChains: [chainId], showQrModal: true,
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
            if (provider.session) {
                const compatible = Object.values(provider.session.namespaces).some(namespace =>
                    namespace.accounts.some(account => account.startsWith(`eip155:${chainId}:`)) &&
                    namespace.methods.includes('eth_signTypedData_v4'));
                if (!compatible)
                    await provider.disconnect();
            }
            if (!provider.session)
                await provider.connect();
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
