import type { ApprovalSession } from './model';
export class ApiError extends Error {
}
interface TokenStorage {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
}
export function captureCapability(location: Pick<Location, 'pathname' | 'hash' | 'search'>, replace: (path: string) => void, storage?: TokenStorage): {
    id: string;
    token: string;
} {
    const fragment = location.hash.slice(1);
    replace(location.pathname);
    const match = /^\/approve\/([A-Za-z0-9_-]{1,128})\/?$/.exec(location.pathname);
    if (!match)
        throw new ApiError('This approval link is invalid.');
    const id = match[1], key = `proofport.approval.${id}`;
    let token = fragment;
    if (!token) {
        try {
            token = storage?.getItem(key) ?? '';
        }
        catch { /* Storage is optional. */ }
    }
    if (!token || token.length > 2048 || !/^[A-Za-z0-9._~-]+$/.test(token))
        throw new ApiError('This approval link is invalid or missing its access token. Reopen the original link.');
    try {
        storage?.setItem(key, token);
    }
    catch { /* In-memory use remains available. */ }
    return { id, token };
}
export class ApprovalApi {
    private path: string;
    constructor(id: string, private token: string, private fetcher: typeof fetch = (input, init) => fetch(input, init)) { this.path = `/api/v1/action-approvals/${encodeURIComponent(id)}`; }
    private async request(path: string, body?: unknown, authenticated = true): Promise<unknown> {
        let response: Response;
        try {
            response = await this.fetcher(path, { method: body === undefined ? 'GET' : 'POST', headers: { ...(authenticated ? { Authorization: `Bearer ${this.token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error', signal: AbortSignal.timeout(15000) });
        }
        catch {
            throw new ApiError(body === undefined ? 'The request could not be loaded. Check your connection and reload.' : 'The result could not be confirmed. Reload this page to check the request status before trying again.');
        }
        if (!response.ok) {
            const messages: Record<number, string> = { 400: 'The approval request could not be accepted. Reload and review the request.', 401: 'This approval link is invalid or no longer available.', 403: 'This approval link is invalid or no longer available.', 409: 'This request has changed or has already been handled. Reload to see its current status.', 410: 'This approval request has expired.', 429: 'Too many requests. Wait a moment and reload.' };
            throw new ApiError(messages[response.status] ?? 'The approval service is unavailable. Try reloading shortly.');
        }
        try {
            return await response.json();
        }
        catch {
            throw new ApiError('The approval service returned an invalid response.');
        }
    }
    read(): Promise<ApprovalSession> { return this.request(this.path) as Promise<ApprovalSession>; }
    approve(address: string, signature: string): Promise<unknown> { return this.request(`${this.path}/approve`, { address, signature }); }
    reject(): Promise<unknown> { return this.request(`${this.path}/reject`, {}); }
    config(): Promise<{
        walletConnectProjectId?: string;
    }> { return this.request('/api/v1/action-approvals/config', undefined, false) as Promise<{
        walletConnectProjectId?: string;
    }>; }
}
