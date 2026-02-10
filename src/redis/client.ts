import { Redis } from 'ioredis';

export type RedisClient = Redis;

export function createRedisClient(url: string): RedisClient {
  return new Redis(url);
}
