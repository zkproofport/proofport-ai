import { describe, expect, it, vi } from 'vitest';
import { installPublishedPackages, missingPublishedRelease } from '../scripts/install-published-packages.mjs';
const versions = { '@zkproofport-ai/sdk': '0.2.16', '@zkproofport-ai/mcp': '0.2.16' };
const missing = { code: 1, stderr: 'npm error code ETARGET\nnpm error notarget No matching version found for @zkproofport-ai/mcp@0.2.16.' };

describe('published package propagation retry', () => {
  it('retries the exact freshly published package with online revalidation', async () => {
    const execute = vi.fn().mockRejectedValueOnce(missing).mockResolvedValue({ stdout: 'installed', stderr: '' });
    const wait = vi.fn(); const report = vi.fn();
    expect(await installPublishedPackages('/tmp/isolated', versions, { execute, wait, report })).toEqual({ stdout: 'installed', stderr: '' });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[0][1]).toContain('--prefer-online');
    expect(wait).toHaveBeenCalledExactlyOnceWith(15_000);
    expect(report.mock.calls[0][0]).toContain('@zkproofport-ai/mcp@0.2.16');
  });
  it('recognizes npm E404 only for the exact requested first-party release', () => {
    expect(missingPublishedRelease({ stderr: "npm error code E404\nnpm error 404 '@zkproofport-ai/sdk@0.2.16' is not in this registry." }, versions)).toBe('@zkproofport-ai/sdk@0.2.16');
  });
  it.each([
    'npm error code ERESOLVE\nNo matching version found for @zkproofport-ai/mcp@0.2.16.',
    'npm error code ETARGET\nNo matching version found for @circle-fin/cli@1.1.4.',
    'npm error code ETARGET\nNo matching version found for @zkproofport-ai/mcp@0.2.160.',
    'npm error code E404\n404 https://registry.npmjs.org/other-package',
    'npm error code E401 Unauthorized',
    'npm error code ECONNRESET',
  ])('fails immediately for unrelated install errors: %s', async stderr => {
    const error = { stderr }; const execute = vi.fn().mockRejectedValue(error); const wait = vi.fn();
    await expect(installPublishedPackages('/tmp/isolated', versions, { execute, wait })).rejects.toBe(error);
    expect(execute).toHaveBeenCalledTimes(1); expect(wait).not.toHaveBeenCalled();
  });
  it('fails after a bounded number of attempts without hiding the final npm error', async () => {
    const execute = vi.fn().mockRejectedValue(missing); const wait = vi.fn();
    await expect(installPublishedPackages('/tmp/isolated', versions, { execute, wait, report: vi.fn(), maxAttempts: 3 })).rejects.toBe(missing);
    expect(execute).toHaveBeenCalledTimes(3); expect(wait).toHaveBeenCalledTimes(2);
  });
});
