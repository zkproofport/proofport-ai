import { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';

/** Serialize registration across Cloud Run instances sharing one prover wallet. */
export async function withRegistrationLock<T>(redisUrl: string, key: string, run: () => Promise<T>): Promise<T> {
  if (!redisUrl) throw new Error('REDIS_URL is required for coordinated identity registration');
  const redis = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1, enableOfflineQueue: false });
  // The public error returned by ioredis never needs the connection URL.
  redis.on('error', () => {});
  const owner = randomUUID();
  let acquired = false;
  try {
    await redis.connect();
    // Longer than the bounded registration reads plus three five-minute TXs.
    // A crashed process releases its lease after thirty minutes.
    for (let attempt = 0; attempt < 120; attempt++) {
      acquired = await redis.set(key, owner, 'PX', 1800000, 'NX') === 'OK';
      if (acquired) break;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    if (!acquired) throw new Error('Another instance is still registering this agent; retry readiness after it completes');
    return await run();
  } finally {
    if (acquired) {
      try {
        await redis.eval("if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end", 1, key, owner);
      } catch {
        // The bounded lease expires even if Redis becomes unavailable at release.
      }
    }
    redis.disconnect();
  }
}
