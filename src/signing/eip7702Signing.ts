import type { SigningProvider, SigningRequest, SigningResult } from './types.js';
import type { RedisClient } from '../redis/client.js';
import type { Request, Response, NextFunction } from 'express';

interface Eip7702Config {
  redis: RedisClient;
  ttlSeconds?: number;
}

interface StoredSignature {
  signature: string;
  address: string;
  createdAt: string;
}

export class Eip7702SigningProvider implements SigningProvider {
  readonly method = 'eip7702' as const;
  private redis: RedisClient;
  private ttlSeconds: number;

  constructor(config: Eip7702Config) {
    this.redis = config.redis;
    this.ttlSeconds = config.ttlSeconds ?? 86400; // 24 hours default
  }

  async sign(request: SigningRequest): Promise<SigningResult> {
    const key = `signing:pool:${request.address}:${request.signalHash}`;
    const data = await this.redis.get(key);

    if (!data) {
      throw new Error('No pre-signed signature available for this signalHash');
    }

    let storedData: StoredSignature;
    try {
      storedData = JSON.parse(data);
    } catch (error) {
      throw new Error('Invalid stored signature data');
    }

    if (storedData.address.toLowerCase() !== request.address.toLowerCase()) {
      throw new Error('Address mismatch: stored signature does not match request address');
    }

    return {
      signature: storedData.signature,
      address: storedData.address,
      method: 'eip7702',
    };
  }

  async isAvailable(address: string): Promise<boolean> {
    try {
      const countKey = `signing:pool:count:${address}`;
      const count = await this.redis.get(countKey);
      return count !== null && parseInt(count, 10) > 0;
    } catch (error) {
      return false;
    }
  }
}

interface StoreSignatureParams {
  address: string;
  signalHash: string;
  signature: string;
  ttlSeconds?: number;
}

export async function storePreSignedSignature(
  redis: RedisClient,
  params: StoreSignatureParams
): Promise<void> {
  const { address, signalHash, signature, ttlSeconds = 86400 } = params;

  const key = `signing:pool:${address}:${signalHash}`;
  const data: StoredSignature = {
    signature,
    address,
    createdAt: new Date().toISOString(),
  };

  await redis.set(key, JSON.stringify(data), 'EX', ttlSeconds);

  const countKey = `signing:pool:count:${address}`;
  await redis.incr(countKey);
}

export async function getPoolSize(redis: RedisClient, address: string): Promise<number> {
  try {
    const countKey = `signing:pool:count:${address}`;
    const count = await redis.get(countKey);
    return count !== null ? parseInt(count, 10) : 0;
  } catch (error) {
    return 0;
  }
}

interface BatchSignatureEntry {
  signalHash: string;
  signature: string;
}

interface BatchSigningRequest {
  address: string;
  signatures: BatchSignatureEntry[];
}

export function createBatchSigningHandler(redis: RedisClient) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const body = req.body as Partial<BatchSigningRequest>;

      if (!body.address) {
        res.status(400).json({ error: 'Missing required field: address' });
        return;
      }

      if (!body.signatures) {
        res.status(400).json({ error: 'Missing required field: signatures' });
        return;
      }

      if (!Array.isArray(body.signatures) || body.signatures.length === 0) {
        res.status(400).json({ error: 'signatures array cannot be empty' });
        return;
      }

      if (body.signatures.length > 50) {
        res.status(400).json({ error: 'signatures must be an array with at most 50 items' });
        return;
      }

      for (const entry of body.signatures) {
        if (
          !entry.signalHash ||
          !entry.signature ||
          typeof entry.signalHash !== 'string' ||
          typeof entry.signature !== 'string' ||
          entry.signalHash.trim() === '' ||
          entry.signature.trim() === ''
        ) {
          res.status(400).json({
            error: 'Each signature entry must have signalHash and signature as non-empty strings',
          });
          return;
        }
      }

      let stored = 0;
      for (const entry of body.signatures) {
        await storePreSignedSignature(redis, {
          address: body.address,
          signalHash: entry.signalHash,
          signature: entry.signature,
        });
        stored++;
      }

      res.json({
        stored,
        address: body.address,
      });
    } catch (error) {
      next(error);
    }
  };
}
