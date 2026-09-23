import { describe, it, expect, vi } from 'vitest';
import { captureCapability, ApprovalApi } from '../src/api';
describe('browser capability protection', () => {
    it('removes the token fragment and query before retaining a refresh capability', () => {
        const storage = new Map<string, string>();
        const replace = vi.fn();
        const capability = captureCapability({ pathname: '/approve/demo', hash: '#test-token', search: '?untrusted=1' }, replace, { getItem: k => storage.get(k) ?? null, setItem: (k, v) => { storage.set(k, v); } });
        expect(capability).toEqual({ id: 'demo', token: 'test-token' });
        expect(replace).toHaveBeenCalledWith('/approve/demo');
        expect(captureCapability({ pathname: '/approve/demo', hash: '', search: '' }, replace, { getItem: k => storage.get(k) ?? null, setItem: () => { } })).toEqual(capability);
    });
    it('does not reuse another request capability or require persistent storage', () => {
        const storage = { getItem: () => { throw Error('denied'); }, setItem: () => { throw Error('denied'); } };
        expect(captureCapability({ pathname: '/approve/demo', hash: '#token', search: '' }, () => { }, storage).token).toBe('token');
        expect(() => captureCapability({ pathname: '/approve/another', hash: '', search: '' }, () => { }, storage)).toThrow();
    });
    it('sends bearer only in same-origin no-referrer/no-store requests and hides raw API errors', async () => {
        const fetcher = vi.fn(async () => new Response('secret signature detail', { status: 401 }));
        const api = new ApprovalApi('demo', 'capability', fetcher as typeof fetch);
        await expect(api.read()).rejects.toThrow('This approval link is invalid or no longer available.');
        const [url, options] = fetcher.mock.calls[0] as any;
        expect(url).toBe('/api/v1/action-approvals/demo');
        expect(options.headers.Authorization).toBe('Bearer capability');
        expect(options.referrerPolicy).toBe('no-referrer');
        expect(options.cache).toBe('no-store');
    });
});
