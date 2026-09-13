import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
const mocks = vi.hoisted(() => ({ connect: vi.fn(), set: vi.fn(), eval: vi.fn(), disconnect: vi.fn(), on: vi.fn() }));
vi.mock('ioredis', () => ({ Redis: class { connect = mocks.connect; set = mocks.set; eval = mocks.eval; disconnect = mocks.disconnect; on = mocks.on; } }));
import { withRegistrationLock } from '../../src/identity/registrationLock.js';
beforeEach(() => { vi.resetAllMocks(); mocks.connect.mockResolvedValue(undefined); mocks.set.mockResolvedValue('OK'); });
afterEach(() => vi.useRealTimers());
describe('distributed registration lease', () => {
  it('requires a shared store before any registration side effect', async () => {
    const run = vi.fn();
    await expect(withRegistrationLock('', 'key', run)).rejects.toThrow('REDIS_URL');
    expect(run).not.toHaveBeenCalled();
  });
  it('runs after atomic lease acquisition and releases only its own lease', async () => {
    const run = vi.fn(async () => { expect(mocks.set).toHaveBeenCalledOnce(); return 42; });
    expect(await withRegistrationLock('redis://localhost', 'registry:owner', run)).toBe(42);
    const [key, owner, px, ttl, nx] = mocks.set.mock.calls[0];
    expect([key, px, ttl, nx]).toEqual(['registry:owner', 'PX', 1800000, 'NX']);
    expect(mocks.eval).toHaveBeenCalledWith(expect.stringContaining("redis.call('get', KEYS[1]) == ARGV[1]"), 1, key, owner);
    expect(mocks.disconnect).toHaveBeenCalledOnce();
  });
  it('waits for another instance instead of minting concurrently', async () => {
    vi.useFakeTimers(); mocks.set.mockResolvedValueOnce(null).mockResolvedValueOnce('OK');
    const run = vi.fn(async () => 7);
    const result = withRegistrationLock('redis://localhost', 'key', run);
    await vi.advanceTimersByTimeAsync(999);
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toBe(7);
    expect(run).toHaveBeenCalledOnce();
  });
  it('releases after registration throws without hiding its failure', async () => {
    await expect(withRegistrationLock('redis://localhost', 'key', async () => { throw new Error('chain failed'); })).rejects.toThrow('chain failed');
    expect(mocks.eval).toHaveBeenCalledOnce();
    expect(mocks.disconnect).toHaveBeenCalledOnce();
  });
  it('fails closed when Redis cannot coordinate writers', async () => {
    mocks.connect.mockRejectedValue(new Error('Redis down'));
    const run = vi.fn();
    await expect(withRegistrationLock('redis://localhost', 'key', run)).rejects.toThrow('Redis down');
    expect(run).not.toHaveBeenCalled();
    expect(mocks.eval).not.toHaveBeenCalled();
    expect(mocks.disconnect).toHaveBeenCalledOnce();
  });
});
