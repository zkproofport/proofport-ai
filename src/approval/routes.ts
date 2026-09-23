import express, { type Request, type Response, type NextFunction } from 'express';
import type { RedisClient } from '../redis/client.js';
import { ActionApprovalStore } from './store.js';
import { APPROVAL_BODY_LIMIT, ApprovalError, approvalOrigin, boundedJson, exactKeys, validateApprovalRequest } from './validation.js';

export function approvalSecurityHeaders(_req: Request, res: Response, next: NextFunction) {
  res.setHeader('Cache-Control', 'no-store'); res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('X-Frame-Options', 'DENY'); next();
}
function bearer(req: Request): string {
  const header = req.headers.authorization;
  if (typeof header !== 'string' || !/^Bearer [0-9a-f]{64}$/.test(header)) throw new ApprovalError(401, 'APPROVAL_UNAUTHORIZED', 'A valid approval capability is required.');
  return header.substring(7);
}
function wrap(fn: (req: Request, res: Response) => Promise<unknown>) {
  return (req: Request, res: Response, next: NextFunction) => { void fn(req, res).catch(next); };
}
export function createActionApprovalRouter(options: { redis: Pick<RedisClient, 'eval'>; origin: string; walletConnectProjectId?: string; trustProxyHops?: number | false }) {
  // An isolated sub-app keeps explicitly configured ingress trust from
  // changing identity/payment/proof routes on the containing application.
  const router = express(); const origin = approvalOrigin(options.origin);
  const hops = options.trustProxyHops ?? false;
  if (hops !== false && (!Number.isInteger(hops) || hops < 1 || hops > 16)) throw new Error('APPROVAL_TRUST_PROXY_HOPS must be an integer from 1 to 16, or unset.');
  router.set('trust proxy', hops);
  const store = new ActionApprovalStore(options.redis, origin);
  router.use(approvalSecurityHeaders);
  router.use((req, res, next) => {
    const requested = req.headers.origin;
    if (requested !== undefined && requested !== origin) return res.status(403).json({ error: 'APPROVAL_ORIGIN_FORBIDDEN', message: 'Approval requests must use the service origin.' });
    if (requested === origin) {
      res.setHeader('Access-Control-Allow-Origin', origin); res.vary('Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
  router.use(express.json({ limit: APPROVAL_BODY_LIMIT, inflate: false }));
  router.get('/config', (_req, res) => res.json(options.walletConnectProjectId ? { walletConnectProjectId: options.walletConnectProjectId } : {}));
  router.post('/', wrap(async (req, res) => {
    const value = validateApprovalRequest(req.body);
    // Express uses only the socket address unless the operator explicitly
    // configures trusted proxies. Never take an arbitrary forwarded header.
    if (!req.ip) throw new ApprovalError(503, 'APPROVAL_UNAVAILABLE', 'The approval client address is unavailable.');
    res.status(201).json(await store.create(value, req.ip));
  }));
  router.get('/:id', wrap(async (req, res) => res.json(await store.read(req.params.id, bearer(req)))));
  router.post('/:id/approve', wrap(async (req, res) => {
    const token = bearer(req); boundedJson(req.body);
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) throw new ApprovalError(400, 'INVALID_APPROVAL_REQUEST', 'Approval requires an address and signature.');
    exactKeys(req.body, ['address', 'signature']);
    res.json(await store.approve(req.params.id, token, req.body.address, req.body.signature));
  }));
  router.post('/:id/reject', wrap(async (req, res) => {
    const token = bearer(req); boundedJson(req.body);
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) throw new ApprovalError(400, 'INVALID_APPROVAL_REQUEST', 'Rejection body must be an empty object.');
    exactKeys(req.body, []); res.json(await store.reject(req.params.id, token));
  }));
  router.post('/:id/consume', wrap(async (req, res) => {
    const token = bearer(req); const value = validateApprovalRequest(req.body, false);
    res.json(await store.consume(req.params.id, token, value));
  }));
  router.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof ApprovalError) {
      if (error.statusCode === 429) res.setHeader('Retry-After', error.message);
      return res.status(error.statusCode).json({ error: error.code, message: error.statusCode === 429 ? 'Too many approval requests. Try again later.' : error.message });
    }
    const parsed = error as { type?: string; status?: number };
    if (parsed?.type === 'entity.too.large') return res.status(413).json({ error: 'APPROVAL_TOO_LARGE', message: 'Approval request exceeds 32 KiB.' });
    if (parsed?.status === 400 || parsed?.status === 415) return res.status(parsed.status).json({ error: 'INVALID_APPROVAL_REQUEST', message: 'Approval requests require an uncompressed JSON body.' });
    // Never serialize provider errors, request bodies, capabilities or signatures.
    return res.status(503).json({ error: 'APPROVAL_UNAVAILABLE', message: 'Approval is temporarily unavailable.' });
  });
  return router;
}
