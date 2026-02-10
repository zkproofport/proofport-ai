import { createHash } from 'node:crypto';
import type { RedisClient } from './client.js';

export interface ProofCacheConfig {
  ttlSeconds: number;
}

export interface CachedProofResult {
  proof: string;
  publicInputs: string;
  nullifier: string;
  signalHash: string;
}

export interface ProofCacheInputs {
  address: string;
  scope: string;
  countryList?: string[];
  isIncluded?: boolean;
}

export class ProofCache {
  private redis: RedisClient;
  private config: ProofCacheConfig;

  constructor(redis: RedisClient, config: ProofCacheConfig) {
    this.redis = redis;
    this.config = config;
  }

  private buildKey(circuitId: string, inputs: ProofCacheInputs): string {
    const parts: Record<string, unknown> = {
      circuit: circuitId,
      address: inputs.address,
      scope: inputs.scope,
    };

    if (inputs.countryList !== undefined) {
      parts.countryList = inputs.countryList;
    }
    if (inputs.isIncluded !== undefined) {
      parts.isIncluded = inputs.isIncluded;
    }

    const hash = createHash('sha256')
      .update(JSON.stringify(parts))
      .digest('hex')
      .slice(0, 16);

    return `proof:${circuitId}:${hash}`;
  }

  async get(circuitId: string, inputs: ProofCacheInputs): Promise<CachedProofResult | null> {
    const key = this.buildKey(circuitId, inputs);
    const cached = await this.redis.get(key);
    if (!cached) return null;
    return JSON.parse(cached) as CachedProofResult;
  }

  async set(circuitId: string, inputs: ProofCacheInputs, result: CachedProofResult): Promise<void> {
    const key = this.buildKey(circuitId, inputs);
    await this.redis.set(key, JSON.stringify(result), 'EX', this.config.ttlSeconds);
  }

  async invalidate(circuitId: string, inputs: ProofCacheInputs): Promise<void> {
    const key = this.buildKey(circuitId, inputs);
    await this.redis.del(key);
  }
}
