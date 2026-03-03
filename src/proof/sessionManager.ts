import { randomUUID, randomBytes } from 'crypto';
import type { RedisClient } from '../redis/client.js';
import type { ProofSession } from './types.js';
import type { CircuitId } from '../config/circuits.js';
import { createLogger } from '../logger.js';

const log = createLogger('ProofSession');
const SESSION_TTL = 600; // 10 minutes
const SESSION_KEY_PREFIX = 'proof_session:';

export class ProofSessionManager {
  constructor(private redis: RedisClient) {}

  async createSession(params: {
    circuit: CircuitId;
  }): Promise<ProofSession> {
    const session_id = `ses_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const payment_nonce = `0x${randomBytes(16).toString('hex')}`;

    const now = new Date();
    const session: ProofSession = {
      session_id,
      status: 'PAYMENT_PENDING',
      circuit: params.circuit,
      payment_nonce,
      created_at: now.toISOString(),
      expires_at: new Date(now.getTime() + SESSION_TTL * 1000).toISOString(),
    };

    await this.redis.set(
      `${SESSION_KEY_PREFIX}${session_id}`,
      JSON.stringify(session),
      'EX',
      SESSION_TTL,
    );

    log.info({ action: 'session.created', session_id, circuit: params.circuit }, 'Proof session created');
    return session;
  }

  async getSession(sessionId: string): Promise<ProofSession | null> {
    const data = await this.redis.get(`${SESSION_KEY_PREFIX}${sessionId}`);
    if (!data) return null;
    return JSON.parse(data) as ProofSession;
  }

  async updateSession(sessionId: string, updates: Partial<ProofSession>): Promise<ProofSession | null> {
    const session = await this.getSession(sessionId);
    if (!session) return null;

    const updated = { ...session, ...updates };
    const ttl = await this.redis.ttl(`${SESSION_KEY_PREFIX}${sessionId}`);
    await this.redis.set(
      `${SESSION_KEY_PREFIX}${sessionId}`,
      JSON.stringify(updated),
      'EX',
      ttl > 0 ? ttl : SESSION_TTL,
    );

    return updated;
  }
}
