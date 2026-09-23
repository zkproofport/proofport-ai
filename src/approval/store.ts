import { randomBytes } from 'node:crypto';
import { recoverAddress, Signature } from 'ethers';
import type { RedisClient } from '../redis/client.js';
import { ApprovalError, approvalAddress, approvalOrigin, sha256, type ApprovalRequest } from './validation.js';

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'consumed' | 'expired';
interface Session extends ApprovalRequest {
  approvalId: string; status: ApprovalStatus; createdAt: number; expiresAt: number;
  browserHash: string; requesterHash: string; address?: string; signature?: string;
}

// Redis is the clock and state authority across replicas. KEEPTTL preserves
// the original deadline; the extra five minutes are an authenticated tombstone.
const CREATE = `
local count = redis.call('INCR', KEYS[2])
if count == 1 then redis.call('PEXPIRE', KEYS[2], 60000) end
if count > 10 then return {'RATE_LIMITED', tostring(redis.call('PTTL', KEYS[2]))} end
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local session = cjson.decode(ARGV[1])
session.createdAt = now
session.expiresAt = now + 600000
local value = cjson.encode(session)
if not redis.call('SET', KEYS[1], value, 'NX', 'PX', 900000) then return {'UNAVAILABLE'} end
return {'OK', value}
`;
const TRANSITION = `
local function equal(a, b)
  if type(a) ~= 'string' or type(b) ~= 'string' or #a ~= 64 or #b ~= 64 then return false end
  local diff = 0
  for i = 1, 64 do diff = bit.bor(diff, bit.bxor(string.byte(a, i), string.byte(b, i))) end
  return diff == 0
end
local raw = redis.call('GET', KEYS[1])
if not raw then return {'UNAUTHORIZED'} end
local session = cjson.decode(raw)
local browser = equal(session.browserHash, ARGV[2])
local requester = equal(session.requesterHash, ARGV[2])
local authorized = false
if ARGV[3] == 'browser' then authorized = browser
elseif ARGV[3] == 'requester' then authorized = requester
elseif ARGV[3] == 'either' then authorized = browser or requester end
if not authorized then return {'UNAUTHORIZED'} end
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
if now >= session.expiresAt and (session.status == 'pending' or session.status == 'approved') then
  session.status = 'expired'
  session.signature = nil
  redis.call('SET', KEYS[1], cjson.encode(session), 'KEEPTTL')
end
if ARGV[1] == 'read' then return {'OK', cjson.encode(session)} end
if session.status == 'expired' then return {'EXPIRED'} end
if ARGV[1] == 'approve' then
  if session.status ~= 'pending' then return {'CONFLICT'} end
  session.address = ARGV[4]
  session.signature = ARGV[5]
  session.status = 'approved'
elseif ARGV[1] == 'reject' then
  if session.status ~= 'pending' then return {'CONFLICT'} end
  session.status = 'rejected'
elseif ARGV[1] == 'consume' then
  if session.status ~= 'approved' then return {'CONFLICT'} end
  if not equal(session.requestHash, ARGV[4]) then return {'BINDING_MISMATCH'} end
  local approved = cjson.encode(session)
  session.status = 'consumed'
  session.signature = nil
  redis.call('SET', KEYS[1], cjson.encode(session), 'KEEPTTL')
  return {'OK', approved}
else return {'UNAVAILABLE'} end
local value = cjson.encode(session)
redis.call('SET', KEYS[1], value, 'KEEPTTL')
return {'OK', value}
`;

export class ActionApprovalStore {
  readonly origin: string;
  private readonly prefix: string;
  constructor(private readonly redis: Pick<RedisClient, 'eval'>, origin: string) {
    this.origin = approvalOrigin(origin); this.prefix = `action-approval:v1:${sha256(this.origin)}:`;
  }
  private async eval(script: string, keys: string[], args: string[]): Promise<Session> {
    let result: unknown;
    try { result = await this.redis.eval(script, keys.length, ...keys, ...args); }
    catch { throw new ApprovalError(503, 'APPROVAL_UNAVAILABLE', 'Approval storage is temporarily unavailable.'); }
    if (!Array.isArray(result)) throw new ApprovalError(503, 'APPROVAL_UNAVAILABLE', 'Approval storage returned an invalid response.');
    const [code, value] = result;
    if (code === 'OK') {
      const stored = JSON.parse(String(value));
      if (typeof stored.requestJson !== 'string') throw new ApprovalError(503, 'APPROVAL_UNAVAILABLE', 'Approval storage returned an invalid request.');
      return { ...JSON.parse(stored.requestJson), ...stored } as Session;
    }
    if (code === 'UNAUTHORIZED') throw new ApprovalError(401, 'APPROVAL_UNAUTHORIZED', 'A valid approval capability is required.');
    if (code === 'EXPIRED') throw new ApprovalError(410, 'APPROVAL_EXPIRED', 'The approval request has expired.');
    if (code === 'CONFLICT') throw new ApprovalError(409, 'APPROVAL_STATE_CONFLICT', 'The approval request cannot make this transition.');
    if (code === 'BINDING_MISMATCH') throw new ApprovalError(409, 'APPROVAL_BINDING_MISMATCH', 'Circuit, scope and action must match the approved request.');
    if (code === 'RATE_LIMITED') throw new ApprovalError(429, 'APPROVAL_RATE_LIMITED', String(Math.max(1, Math.ceil(Number(value) / 1000))));
    throw new ApprovalError(503, 'APPROVAL_UNAVAILABLE', 'Approval storage is temporarily unavailable.');
  }
  private transition(id: string, token: string, operation: string, role: string, ...values: string[]): Promise<Session> {
    if (!/^[0-9a-f]{32}$/.test(id) || !/^[0-9a-f]{64}$/.test(token)) throw new ApprovalError(401, 'APPROVAL_UNAUTHORIZED', 'A valid approval capability is required.');
    return this.eval(TRANSITION, [this.prefix + id], [operation, sha256(token), role, ...values]);
  }
  async create(request: ApprovalRequest, clientAddress: string) {
    const approvalId = randomBytes(16).toString('hex');
    const browserToken = randomBytes(32).toString('hex'); const requesterToken = randomBytes(32).toString('hex');
    const session = await this.eval(CREATE, [this.prefix + approvalId, this.prefix + 'rate:' + sha256(clientAddress)], [JSON.stringify({
      // Keep the frozen request opaque to Redis cjson: decoding/re-encoding
      // [] there turns it into {}, changing what the wallet reviewed/signed.
      requestJson: JSON.stringify(request), requestHash: request.requestHash,
      approvalId, status: 'pending', browserHash: sha256(browserToken), requesterHash: sha256(requesterToken),
    })]);
    return { approvalId, approvalUrl: `${this.origin}/approve/${approvalId}#${browserToken}`, requesterToken, expiresAt: new Date(session.expiresAt).toISOString(), status: 'pending' as const };
  }
  async read(id: string, token: string) { return this.public(await this.transition(id, token, 'read', 'either')); }
  async approve(id: string, token: string, addressValue: unknown, signatureValue: unknown) {
    const session = await this.transition(id, token, 'read', 'browser');
    const address = approvalAddress(addressValue);
    if (session.expectedSigner && address !== session.expectedSigner) throw new ApprovalError(400, 'APPROVAL_SIGNER_MISMATCH', 'Connect the requested credential wallet.');
    let signature: string;
    try {
      if (typeof signatureValue !== 'string' || !/^0x(?:[0-9a-fA-F]{128}|[0-9a-fA-F]{130})$/.test(signatureValue)) throw new Error('Invalid signature');
      signature = Signature.from(signatureValue).serialized;
      if (recoverAddress(session.digest, signature) !== address) throw new Error('Wrong signer');
    } catch { throw new ApprovalError(400, 'APPROVAL_SIGNATURE_INVALID', 'The signature does not authorize this action for the selected wallet.'); }
    return this.public(await this.transition(id, token, 'approve', 'browser', address, signature));
  }
  async reject(id: string, token: string) { return this.public(await this.transition(id, token, 'reject', 'browser')); }
  async consume(id: string, token: string, request: ApprovalRequest) {
    const s = await this.transition(id, token, 'consume', 'requester', request.requestHash);
    return { address: s.address!, signature: s.signature!, circuit: s.circuit, scope: s.scope, action: s.action };
  }
  private public(s: Session) {
    return { approvalId: s.approvalId, status: s.status, expiresAt: new Date(s.expiresAt).toISOString(), circuit: s.circuit, scope: s.scope, action: s.action,
      ...(s.expectedSigner === undefined ? {} : { expectedSigner: s.expectedSigner }), ...(s.address === undefined ? {} : { address: s.address }) };
  }
}
