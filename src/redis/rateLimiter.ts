import type { RedisClient } from './client.js';

export interface RateLimiterConfig {
  maxRequests: number;
  windowSeconds: number;
  keyPrefix: string;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  limit: number;
  retryAfter?: number;
}

export class RateLimiter {
  private redis: RedisClient;
  private config: RateLimiterConfig;

  constructor(redis: RedisClient, config: RateLimiterConfig) {
    this.redis = redis;
    this.config = config;
  }

  async check(identifier: string): Promise<RateLimitResult> {
    const key = `${this.config.keyPrefix}:${identifier}`;
    const count = await this.redis.incr(key);

    if (count === 1) {
      await this.redis.expire(key, this.config.windowSeconds);
    }

    if (count > this.config.maxRequests) {
      const ttl = await this.redis.ttl(key);
      return {
        allowed: false,
        remaining: 0,
        limit: this.config.maxRequests,
        retryAfter: ttl,
      };
    }

    return {
      allowed: true,
      remaining: this.config.maxRequests - count,
      limit: this.config.maxRequests,
    };
  }
}
