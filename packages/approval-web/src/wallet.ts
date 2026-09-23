import { validAddress, walletPayload, type TypedAction } from './model';
export interface EvmProvider {
    request(args: {
        method: string;
        params?: unknown[];
    }): Promise<unknown>;
    on?(event: string, listener: (...args: unknown[]) => void): void;
    removeListener?(event: string, listener: (...args: unknown[]) => void): void;
    disconnect?(): Promise<void>;
}
export function walletError(error: unknown): string {
    const code = (error as {
        code?: number;
    })?.code;
    if (code === 4001)
        return 'The wallet request was declined. You can review and try again.';
    if (code === 4200 || code === -32601)
        return 'This wallet does not support the required signing method. Choose another compatible EVM wallet.';
    if (code === 4900 || code === 4901)
        return 'The wallet is disconnected. Connect it again before signing.';
    return error instanceof ApprovalError ? error.message : 'The wallet request could not be completed. Check your wallet and try again.';
}
export class ApprovalError extends Error {
}
export class ApprovalWallet {
    address?: string;
    busy = false;
    private provider?: EvmProvider;
    private epoch = 0;
    private submitted = false;
    private payload: string;
    private listeners = new Map<string, (...args: unknown[]) => void>();
    constructor(private action: TypedAction, private expected: string | undefined, private canSign: () => boolean, private submit: (address: string, signature: string) => Promise<void>, private changed: (message?: string) => void) { this.payload = walletPayload(action); }
    invalidate(message?: string): void { this.epoch++; this.address = undefined; this.changed(message); }
    dispose(): void {
        for (const [event, listener] of this.listeners)
            this.provider?.removeListener?.(event, listener);
        this.listeners.clear();
        this.invalidate();
    }
    async connect(provider: EvmProvider): Promise<void> {
        if (this.busy)
            throw new ApprovalError('A wallet request is already open.');
        if (typeof provider.on !== 'function' || typeof provider.removeListener !== 'function')
            throw new ApprovalError('This wallet does not support account and network events. Choose a compatible EVM wallet.');
        this.dispose();
        this.provider = provider;
        this.busy = true;
        this.changed();
        for (const event of ['accountsChanged', 'chainChanged', 'disconnect']) {
            const listener = () => this.invalidate('Your wallet account or network changed. Reconnect and review the request again.');
            this.listeners.set(event, listener);
            provider.on?.(event, listener);
        }
        try {
            await provider.request({ method: 'eth_requestAccounts' });
            const epoch = this.epoch;
            const address = await this.check(provider);
            if (epoch !== this.epoch)
                throw new ApprovalError('Your wallet changed while connecting. Connect again.');
            this.address = address;
        }
        catch (error) {
            this.address = undefined;
            throw error;
        }
        finally {
            this.busy = false;
            this.changed();
        }
    }
    private async check(provider: EvmProvider): Promise<string> {
        const accounts = await provider.request({ method: 'eth_accounts' });
        if (!Array.isArray(accounts) || !validAddress(accounts[0]))
            throw new ApprovalError('No wallet account is connected.');
        const address = accounts[0];
        if (this.expected && address.toLowerCase() !== this.expected.toLowerCase())
            throw new ApprovalError('The connected wallet does not match the expected signing wallet. Choose the requested wallet.');
        const chain = await provider.request({ method: 'eth_chainId' });
        let chainId: bigint | undefined;
        if (typeof chain === 'number' && Number.isSafeInteger(chain) && chain > 0)
            chainId = BigInt(chain);
        else if (typeof chain === 'string' && /^0x[0-9a-f]+$/i.test(chain))
            chainId = BigInt(chain);
        if (chainId !== BigInt(this.action.domain.chainId))
            throw new ApprovalError(`Switch your wallet to chain ${this.action.domain.chainId}, then connect again.`);
        return address;
    }
    async sign(): Promise<void> {
        if (this.busy || this.submitted || !this.canSign() || !this.provider || !this.address)
            throw new ApprovalError('This request is not ready for signing.');
        const provider = this.provider, pinned = this.address, epoch = this.epoch;
        this.busy = true;
        this.changed();
        const stable = () => { if (epoch !== this.epoch || !this.canSign() || this.address !== pinned)
            throw new ApprovalError('The request or wallet changed. Reconnect and review before signing.'); };
        try {
            const before = await this.check(provider);
            stable();
            if (before.toLowerCase() !== pinned.toLowerCase()) {
                this.invalidate();
                throw new ApprovalError('Your wallet account changed. Reconnect before signing.');
            }
            const signature = await provider.request({ method: 'eth_signTypedData_v4', params: [pinned, this.payload] });
            stable();
            const after = await this.check(provider);
            stable();
            if (after.toLowerCase() !== pinned.toLowerCase()) {
                this.invalidate();
                throw new ApprovalError('Your wallet account changed. Reconnect before signing.');
            }
            if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(signature))
                throw new ApprovalError('The wallet did not return a supported EOA signature.');
            this.submitted = true;
            // A failed POST can have reached the server. Reload its state; never retry automatically.
            await this.submit(pinned, signature);
        }
        finally {
            this.busy = false;
            this.changed();
        }
    }
}
