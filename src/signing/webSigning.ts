import { randomUUID } from 'crypto';
import type { RedisClient } from '../redis/client.js';
import type {
  SigningProvider,
  SigningRequest,
  SigningResult,
  SigningRequestRecord,
} from './types.js';

export interface WebSigningConfig {
  redis: RedisClient;
  signPageUrl: string;
  callbackBaseUrl: string;
  ttlSeconds?: number;
}

export class WebSigningProvider implements SigningProvider {
  readonly method = 'web' as const;

  private redis: RedisClient;
  private signPageUrl: string;
  private callbackBaseUrl: string;
  private ttlSeconds: number;

  constructor(config: WebSigningConfig) {
    this.redis = config.redis;
    this.signPageUrl = config.signPageUrl;
    this.callbackBaseUrl = config.callbackBaseUrl;
    this.ttlSeconds = config.ttlSeconds ?? 300;
  }

  async isAvailable(_address: string): Promise<boolean> {
    return true;
  }

  async sign(request: SigningRequest): Promise<SigningResult> {
    const requestId = randomUUID();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.ttlSeconds * 1000);

    const record: SigningRequestRecord = {
      id: requestId,
      address: request.address,
      signalHash: request.signalHash,
      scope: request.scope,
      circuitId: '',
      status: 'pending',
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
    };

    const key = `signing:${requestId}`;
    await this.redis.set(key, JSON.stringify(record), 'EX', this.ttlSeconds);

    const signingUrl = getSigningUrl(this.signPageUrl, requestId);
    console.log(`Web signing URL: ${signingUrl}`);

    return new Promise((resolve, reject) => {
      const checkInterval = setInterval(async () => {
        try {
          const data = await this.redis.get(key);
          if (!data) {
            clearInterval(checkInterval);
            reject(new Error('Signing request expired or not found'));
            return;
          }

          const updatedRecord: SigningRequestRecord = JSON.parse(data);

          if (updatedRecord.status === 'completed' && updatedRecord.signature) {
            clearInterval(checkInterval);
            resolve({
              signature: updatedRecord.signature,
              address: updatedRecord.address!,
              method: 'web',
            });
          } else if (updatedRecord.status === 'expired') {
            clearInterval(checkInterval);
            reject(new Error('Signing request expired'));
          }
        } catch (error) {
          clearInterval(checkInterval);
          reject(error);
        }
      }, 2000);

      setTimeout(() => {
        clearInterval(checkInterval);
        reject(new Error('Signing timeout'));
      }, this.ttlSeconds * 1000);
    });
  }
}

export function getSigningUrl(signPageUrl: string, requestId: string): string {
  const baseUrl = signPageUrl.endsWith('/') ? signPageUrl.slice(0, -1) : signPageUrl;
  return `${baseUrl}/s/${requestId}`;
}

export function createSigningCallbackHandler(redis: RedisClient) {
  return async (req: any, res: any) => {
    const { requestId } = req.params;
    const { signature, address } = req.body;

    const key = `signing:${requestId}`;
    const data = await redis.get(key);

    if (!data) {
      return res.status(404).json({
        success: false,
        error: 'Request not found or expired',
      });
    }

    const record: SigningRequestRecord = JSON.parse(data);

    if (record.status !== 'pending') {
      return res.status(404).json({
        success: false,
        error: 'Request not found or expired',
      });
    }

    if (!signature || !address) {
      return res.status(400).json({
        success: false,
        error: 'Missing signature or address',
      });
    }

    if (record.address && address.toLowerCase() !== record.address.toLowerCase()) {
      return res.status(400).json({
        success: false,
        error: 'Address mismatch',
      });
    }

    const updatedRecord: SigningRequestRecord = {
      ...record,
      status: 'completed',
      signature,
    };

    await redis.set(key, JSON.stringify(updatedRecord), 'EX', 300);

    return res.status(200).json({ success: true });
  };
}
