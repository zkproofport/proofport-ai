import { EthereumProvider, type EthereumProviderOptions } from '@walletconnect/ethereum-provider';

/**
 * Compatibility adapter for the pinned WalletConnect EthereumProvider 2.25.0.
 *
 * UniversalProvider emits normalized chainChanged events before forwarding raw
 * session_event notifications. The inherited normalized handler updates the
 * chain, accounts and public events. The raw handler redundantly calls
 * setChainId -> wallet_switchEthereumChain without awaiting its promise. During
 * pairing, session_event can arrive between session assignment and RPC-provider
 * creation, so that redundant request rejects with undefined.request.
 *
 * Treat the raw notification as a notification, not another switch command.
 * Explicit public wallet_switchEthereumChain requests remain unchanged. Keep
 * the real-dependency pairing/change-away/change-back tests when upgrading.
 */
export class ApprovalEthereumProvider extends EthereumProvider {
    static override async init(options: EthereumProviderOptions): Promise<ApprovalEthereumProvider> {
        // The inherited static factory constructs the base class explicitly.
        const provider = new ApprovalEthereumProvider();
        await provider.initialize(options);
        return provider;
    }

    protected override setChainId(_chain: string): void {
        // The normalized signer.chainChanged handler owns wallet notifications.
    }
}
