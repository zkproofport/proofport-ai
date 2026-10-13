/**
 * A single dropped connection must not fail a proof.
 *
 * On 2026-10-13 a GIWA proof failed with `ConnectTimeoutError` from the GIWA
 * explorer: the attestation lookup made one request and gave up, and the RPC
 * lookup beside it retried only `ECONNRESET` / `ETIMEDOUT`, never the code
 * Node's fetch actually reports for a connect that never completes
 * (`UND_ERR_CONNECT_TIMEOUT`). The explorer answered in 70 ms a minute later.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchAttestation, fetchRawTransaction, fetchWithTransientRetry } from '../packages/sdk/src/attestation.js';

const networkError = (code: string) => Object.assign(new TypeError('fetch failed'), { cause: { code } });
const answer = (status: number, body: unknown = {}) => new Response(JSON.stringify(body), { status });

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Run a call to completion while the fake clock skips the backoff waits. */
async function settle<T>(promise: Promise<T>): Promise<T> {
  const done = promise.then(v => ({ v }), e => ({ e }));
  await vi.runAllTimersAsync();
  const r = (await done) as { v?: T; e?: unknown };
  if ('e' in r) throw r.e;
  return r.v as T;
}

describe('fetchWithTransientRetry (the GIWA explorer lookup)', () => {
  it.each(['UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN'])(
    'retries after %s and returns the answer that follows',
    async code => {
      fetchMock.mockRejectedValueOnce(networkError(code)).mockResolvedValueOnce(answer(200, { ok: 1 }));
      const res = await settle(fetchWithTransientRetry('https://explorer.example/api'));
      expect(res.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    },
  );

  it('gives up after three attempts and throws the network error', async () => {
    fetchMock.mockRejectedValue(networkError('UND_ERR_CONNECT_TIMEOUT'));
    await expect(settle(fetchWithTransientRetry('https://explorer.example/api'))).rejects.toThrow('fetch failed');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it.each([['ENOTFOUND'], ['ECONNREFUSED'], [undefined]])('does not retry a non-transient failure (%s)', async code => {
    fetchMock.mockRejectedValue(code ? networkError(code) : new TypeError('Invalid URL'));
    await expect(settle(fetchWithTransientRetry('https://explorer.example/api'))).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries 429 and 5xx answers, then returns the success', async () => {
    fetchMock.mockResolvedValueOnce(answer(503)).mockResolvedValueOnce(answer(429)).mockResolvedValueOnce(answer(200));
    const res = await settle(fetchWithTransientRetry('https://explorer.example/api'));
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('returns the last 5xx answer after three attempts rather than looping', async () => {
    fetchMock.mockResolvedValue(answer(502));
    const res = await settle(fetchWithTransientRetry('https://explorer.example/api'));
    expect(res.status).toBe(502);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it.each([400, 404])('returns a %i at once: a wrong request does not improve by repeating it', async status => {
    fetchMock.mockResolvedValue(answer(status));
    const res = await settle(fetchWithTransientRetry('https://explorer.example/api'));
    expect(res.status).toBe(status);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('fetchRawTransaction (the RPC lookup) shares the same list of transient failures', () => {
  it('retries a connect timeout, which it used to treat as final', async () => {
    fetchMock
      .mockRejectedValueOnce(networkError('UND_ERR_CONNECT_TIMEOUT'))
      .mockResolvedValueOnce(answer(200, { jsonrpc: '2.0', id: 1, error: { message: 'stop here' } }));
    await expect(settle(fetchRawTransaction('https://rpc.example', '0x' + '11'.repeat(32)))).rejects.toThrow(
      'RPC error: stop here',
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('the GIWA attestation lookup goes through the retry', () => {
  it('survives a connect timeout on the explorer and reaches its answer', async () => {
    fetchMock
      .mockRejectedValueOnce(networkError('UND_ERR_CONNECT_TIMEOUT'))
      .mockResolvedValueOnce(answer(200, { result: [] }));
    await expect(
      settle(fetchAttestation({ baseUrl: 'https://ai.example' }, 'giwa_attestation', '0x' + '22'.repeat(20))),
    ).rejects.toThrow(/No GIWA attestation found/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0][0])).toContain('sepolia-explorer.giwa.io/api?module=account&action=txlist');
  });
});
