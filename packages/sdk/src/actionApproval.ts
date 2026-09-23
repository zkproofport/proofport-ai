import { getAddress, verifyTypedData } from 'ethers';
import { hashTypedAction } from './action.js';
import type { CircuitName, ClientConfig, TypedAction } from './types.js';

/** Requester capability. Keep this handle private; show only approvalUrl to the person. */
export interface ActionApproval {
  approvalId: string;
  approvalUrl: string;
  requesterToken: string;
  /** Fixed session expiry, as an ISO timestamp. This is not an on-chain signature deadline. */
  expiresAt: string;
}

export interface ActionApprovalRequest {
  circuit: CircuitName;
  scope: string;
  action: TypedAction;
  expectedSigner?: string;
}

export type ActionApprovalState = 'pending' | 'approved' | 'rejected' | 'consumed' | 'expired';
export interface ActionApprovalStatus extends ActionApprovalRequest {
  approvalId: string;
  status: ActionApprovalState;
  expiresAt: string;
  address?: string;
}

export type ActionApprovalErrorCode =
  | 'ACTION_APPROVAL_INVALID'
  | 'ACTION_APPROVAL_REJECTED'
  | 'ACTION_APPROVAL_CONSUMED'
  | 'ACTION_APPROVAL_EXPIRED'
  | 'ACTION_APPROVAL_UNAVAILABLE';

export class ActionApprovalError extends Error {
  constructor(public readonly code: ActionApprovalErrorCode, message: string) {
    super(message);
    this.name = 'ActionApprovalError';
  }
}

/** A resumable pause before proof work or payment, not a failed proof. */
export class ActionApprovalRequiredError extends Error {
  readonly code = 'ACTION_APPROVAL_REQUIRED';
  declare readonly approval: ActionApproval;

  constructor(approval: ActionApproval) {
    super('Human wallet approval is required before this action proof can continue.');
    this.name = 'ActionApprovalRequiredError';
    // Generic error serialization must not expose the requester capability.
    Object.defineProperty(this, 'approval', { value: { ...approval }, enumerable: false });
  }
}

const invalid = () => new ActionApprovalError('ACTION_APPROVAL_INVALID', 'Action approval does not match the requested action or has an invalid response.');
const expired = () => new ActionApprovalError('ACTION_APPROVAL_EXPIRED', 'Action approval expired. A new human approval is required.');

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
}

/** Compare the full JSON request, independently of object-key ordering. */
function canonical(value: unknown, depth = 0): string {
  if (depth > 64) throw invalid();
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(item => canonical(item, depth + 1)).join(',') + ']';
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical((value as Record<string, unknown>)[key], depth + 1)).join(',') + '}';
  }
  // JSON cannot preserve bigint/undefined/functions. Use decimal strings for large integers.
  throw invalid();
}

function address(value: unknown): string {
  if (typeof value !== 'string') throw invalid();
  try { return getAddress(value); } catch { throw invalid(); }
}

function snapshotRequest(request: ActionApprovalRequest): ActionApprovalRequest {
  try {
    const copy = structuredClone(request);
    if (copy.circuit !== 'giwa_attestation' && copy.circuit !== 'arc_eligibility') throw invalid();
    if (typeof copy.scope !== 'string' || !copy.scope.trim()) throw invalid();
    canonical(copy.action);
    hashTypedAction(copy.action);
    if (copy.expectedSigner !== undefined) copy.expectedSigner = address(copy.expectedSigner);
    return copy;
  } catch { throw invalid(); }
}

function timestamp(value: unknown): number {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value)) throw invalid();
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw invalid();
  return time;
}

function snapshotApproval(value: ActionApproval): ActionApproval {
  const item = object(value);
  if (typeof item.approvalId !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(item.approvalId)) throw invalid();
  if (typeof item.requesterToken !== 'string' || !/^[A-Za-z0-9._~-]{1,512}$/.test(item.requesterToken)) throw invalid();
  if (typeof item.approvalUrl !== 'string') throw invalid();
  try {
    const url = new URL(item.approvalUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw invalid();
  } catch { throw invalid(); }
  timestamp(item.expiresAt);
  return { approvalId: item.approvalId, approvalUrl: item.approvalUrl,
    requesterToken: item.requesterToken, expiresAt: item.expiresAt as string };
}

function assertLive(approval: ActionApproval): void {
  if (timestamp(approval.expiresAt) <= Date.now()) throw expired();
}

function assertRequest(response: Record<string, unknown>, request: ActionApprovalRequest): void {
  if (response.circuit !== request.circuit || response.scope !== request.scope || canonical(response.action) !== canonical(request.action)) throw invalid();
  // Also revalidate the EIP-712 schema and digest of the independently received action.
  try {
    const actual = hashTypedAction(response.action as TypedAction);
    const expected = hashTypedAction(request.action);
    if (actual.domainSeparator !== expected.domainSeparator || actual.actionHash !== expected.actionHash) throw invalid();
  } catch { throw invalid(); }
}

async function api(config: ClientConfig, path: string, method: string, token?: string, body?: unknown): Promise<Record<string, unknown>> {
  try {
    const response = await fetch(`${config.baseUrl.replace(/\/$/, '')}/api/v1/action-approvals${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) },
      ...(body !== undefined && { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15_000),
      cache: 'no-store',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
    });
    if (!response.ok) {
      // Provider bodies can reflect secrets; never incorporate them into an error.
      throw new ActionApprovalError('ACTION_APPROVAL_UNAVAILABLE', `Action approval request failed (HTTP ${response.status}). Check its status before trying again.`);
    }
    return object(await response.json());
  } catch (error) {
    if (error instanceof ActionApprovalError) throw error;
    throw new ActionApprovalError('ACTION_APPROVAL_UNAVAILABLE', 'Action approval request could not be completed. Check its status before trying again.');
  }
}

/** Create a pending session; this does not sign, prepare a proof, or pay. */
export async function createActionApproval(config: ClientConfig, request: ActionApprovalRequest): Promise<ActionApproval> {
  const frozen = snapshotRequest(request);
  const response = await api(config, '', 'POST', undefined, frozen);
  if (response.status !== 'pending') throw invalid();
  const approval = snapshotApproval(response as unknown as ActionApproval);
  assertLive(approval);
  return approval;
}

/** Status never returns a raw signature or a requester credential. */
export async function getActionApprovalStatus(config: ClientConfig, approval: ActionApproval): Promise<ActionApprovalStatus> {
  const handle = snapshotApproval(approval);
  const response = await api(config, `/${encodeURIComponent(handle.approvalId)}`, 'GET', handle.requesterToken);
  if (response.approvalId !== handle.approvalId || timestamp(response.expiresAt) !== timestamp(handle.expiresAt)) throw invalid();
  const state = response.status;
  if (state !== 'pending' && state !== 'approved' && state !== 'rejected' && state !== 'consumed' && state !== 'expired') throw invalid();
  const request = snapshotRequest({ circuit: response.circuit, scope: response.scope, action: response.action,
    ...(response.expectedSigner !== undefined && { expectedSigner: response.expectedSigner }) } as ActionApprovalRequest);
  const signer = response.address === undefined ? undefined : address(response.address);
  if (state === 'approved' && !signer) throw invalid();
  if (signer && request.expectedSigner && signer !== request.expectedSigner) throw invalid();
  return { ...request, approvalId: handle.approvalId, status: state, expiresAt: handle.expiresAt,
    ...(signer && { address: signer }) };
}

/**
 * Consume once and cryptographically check the returned signature against the
 * caller's frozen action. A lost response must be inspected, never auto-retried.
 */
export async function consumeActionApproval(config: ClientConfig, request: ActionApprovalRequest, approval: ActionApproval): Promise<{ address: string; signature: string }> {
  const frozen = snapshotRequest(request);
  const handle = snapshotApproval(approval);
  assertLive(handle);
  const response = await api(config, `/${encodeURIComponent(handle.approvalId)}/consume`, 'POST', handle.requesterToken,
    { circuit: frozen.circuit, scope: frozen.scope, action: frozen.action });
  assertLive(handle);
  assertRequest(response, frozen);
  const signer = address(response.address);
  if (frozen.expectedSigner && signer !== frozen.expectedSigner) throw invalid();
  if (typeof response.signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(response.signature)) throw invalid();
  try {
    const recovered = verifyTypedData(frozen.action.domain, frozen.action.types, frozen.action.message, response.signature);
    if (getAddress(recovered) !== signer) throw invalid();
  } catch { throw invalid(); }
  return { address: signer, signature: response.signature };
}

/** Resume an approved action, or yield a handle for human review before any proof work. */
export async function resolveActionApproval(config: ClientConfig, request: ActionApprovalRequest, approval?: ActionApproval): Promise<{ address: string; signature: string }> {
  const frozen = snapshotRequest(request);
  if (!approval) throw new ActionApprovalRequiredError(await createActionApproval(config, frozen));
  const handle = snapshotApproval(approval);
  assertLive(handle);
  const status = await getActionApprovalStatus(config, handle);
  assertLive(handle);
  assertRequest(status as unknown as Record<string, unknown>, frozen);
  if (frozen.expectedSigner && status.expectedSigner !== frozen.expectedSigner) throw invalid();
  switch (status.status) {
    case 'pending': throw new ActionApprovalRequiredError(handle);
    case 'rejected': throw new ActionApprovalError('ACTION_APPROVAL_REJECTED', 'The person rejected this action approval.');
    case 'expired': throw expired();
    case 'consumed': throw new ActionApprovalError('ACTION_APPROVAL_CONSUMED', 'This action approval was already consumed. Check the previous proof/payment outcome before requesting a new approval.');
    case 'approved': return consumeActionApproval(config, { ...frozen, expectedSigner: status.address! }, handle);
    default: throw invalid();
  }
}
