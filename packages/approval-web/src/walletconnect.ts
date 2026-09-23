import type { EvmProvider } from './wallet';
export async function mobileWallet(projectId: string, chainId: number): Promise<EvmProvider> {
    const { EthereumProvider } = await import('@walletconnect/ethereum-provider');
    const provider = await EthereumProvider.init({
        projectId, optionalChains: [chainId], showQrModal: true,
        optionalMethods: ['eth_signTypedData_v4', 'eth_accounts', 'eth_requestAccounts', 'eth_chainId'],
        optionalEvents: ['accountsChanged', 'chainChanged'],
        metadata: { name: 'ZKProofport', description: 'Review and approve a proof action with your wallet.', url: location.origin, icons: [] },
    });
    await provider.connect();
    return provider as unknown as EvmProvider;
}
