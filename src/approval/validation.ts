import { createHash } from 'node:crypto';
import { getAddress, TypedDataEncoder } from 'ethers';
import { validateTypedAction, type TypedAction } from '@zkproofport-app/sdk';

export const APPROVAL_BODY_LIMIT = 32 * 1024;
export class ApprovalError extends Error {
  constructor(public readonly statusCode: number, public readonly code: string, message: string) { super(message); }
}
function invalid(message: string): never { throw new ApprovalError(400, 'INVALID_APPROVAL_REQUEST', message); }
export function sha256(value: string): string { return createHash('sha256').update(value).digest('hex'); }

export function boundedJson(value: unknown): void {
  let nodes = 0;
  function visit(v: unknown, depth: number): void {
    if (++nodes > 2048 || depth > 12) invalid('Approval request exceeds the nesting or field limit.');
    if (v === null || typeof v === 'boolean') return;
    if (typeof v === 'string') {
      if (Buffer.byteLength(v) > 4096 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(v)) invalid('Approval string is too long or contains control characters.');
      return;
    }
    if (typeof v === 'number') { if (!Number.isSafeInteger(v)) invalid('Use decimal strings for large integers; numeric values must be safe integers.'); return; }
    if (!v || typeof v !== 'object') invalid('Approval request must contain JSON values only.');
    if (Array.isArray(v)) {
      if (v.length > 128) invalid('Approval arrays may contain at most 128 entries.');
      for (const entry of v) visit(entry, depth + 1);
      return;
    }
    if (Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) invalid('Approval objects must be plain JSON objects.');
    const entries = Object.entries(v);
    if (entries.length > 64) invalid('Approval objects may contain at most 64 fields.');
    for (const [key, entry] of entries) {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) invalid('Unsafe approval field name.');
      visit(key, depth + 1); visit(entry, depth + 1);
    }
  }
  visit(value, 0);
  if (Buffer.byteLength(JSON.stringify(value)) > APPROVAL_BODY_LIMIT) throw new ApprovalError(413, 'APPROVAL_TOO_LARGE', 'Approval request exceeds 32 KiB.');
}
function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`${label} must be an object.`);
  return value as Record<string, unknown>;
}
export function exactKeys(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) invalid('Approval request contains an undeclared field.');
}
export function approvalAddress(value: unknown): string {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value)) invalid('Signer must be a 20-byte hex address.');
  try { return getAddress(value); } catch { return invalid('Signer address is invalid.'); }
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

export interface ApprovalRequest {
  circuit: 'giwa_attestation' | 'arc_eligibility'; scope: string; action: TypedAction; expectedSigner?: string;
  requestHash: string; domainSeparator: string; actionHash: string; digest: string;
}
export function validateApprovalRequest(value: unknown, creating = true): ApprovalRequest {
  boundedJson(value);
  const body = object(value, 'Approval request');
  exactKeys(body, creating ? ['circuit', 'scope', 'action', 'expectedSigner'] : ['circuit', 'scope', 'action']);
  if (body.circuit !== 'giwa_attestation' && body.circuit !== 'arc_eligibility') invalid('Human action approval supports only giwa_attestation and arc_eligibility.');
  if (typeof body.scope !== 'string' || !body.scope.trim() || Buffer.byteLength(body.scope) > 1024) invalid('Scope must contain between 1 and 1024 UTF-8 bytes.');
  const sharedError = validateTypedAction(body.action);
  if (sharedError) invalid(sharedError);
  const action = body.action as TypedAction;
  exactKeys(object(action, 'Action'), ['domain', 'types', 'primaryType', 'message']);
  exactKeys(object(action.domain, 'Action domain'), ['name', 'version', 'chainId', 'verifyingContract']);
  if (!action.domain.name.trim() || !action.domain.version.trim() || !Number.isSafeInteger(action.domain.chainId) || action.domain.chainId <= 0) invalid('Action domain requires a name, version and positive safe chain ID.');
  if (Object.hasOwn(action.types, 'EIP712Domain')) invalid('Action types must omit EIP712Domain.');
  let fieldCount = 0;
  for (const [name, fields] of Object.entries(action.types)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || !Array.isArray(fields)) invalid('Invalid action struct declaration.');
    fieldCount += fields.length;
    for (const field of fields) {
      exactKeys(object(field, 'Action field'), ['name', 'type']);
      if (typeof field.name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(field.name) || typeof field.type !== 'string' || !field.type) invalid('Invalid action field declaration.');
    }
  }
  if (fieldCount > 128) invalid('Actions may declare at most 128 fields.');
  try {
    const encoder = TypedDataEncoder.from(action.types);
    if (encoder.primaryType !== action.primaryType) invalid('Action primary type must match its EIP-712 root.');
    function validateValue(type: string, value: unknown): void {
      const array = /^(.*)\[([0-9]*)\]$/.exec(type);
      if (array) {
        if (!Array.isArray(value)) invalid('Action array value is invalid.');
        for (const element of value) validateValue(array[1], element);
      } else if (Object.hasOwn(action.types, type)) {
        const record = object(value, 'Action struct'); const fields = action.types[type];
        exactKeys(record, fields.map(field => field.name));
        for (const field of fields) {
          if (!Object.hasOwn(record, field.name)) invalid('Action message is missing a declared field.');
          validateValue(field.type, record[field.name]);
        }
      } else if (type === 'bool' && typeof value !== 'boolean') invalid('Action boolean fields must be true or false.');
    }
    validateValue(action.primaryType, action.message);
    const domainSeparator = TypedDataEncoder.hashDomain(action.domain);
    const actionHash = encoder.hash(action.message);
    const digest = TypedDataEncoder.hash(action.domain, action.types, action.message);
    const immutable = JSON.parse(JSON.stringify({ circuit: body.circuit, scope: body.scope, action }));
    const expectedSigner = body.expectedSigner === undefined ? undefined : approvalAddress(body.expectedSigner);
    return { ...immutable, ...(expectedSigner === undefined ? {} : { expectedSigner }), requestHash: sha256(canonical(immutable)), domainSeparator, actionHash, digest };
  } catch (error) {
    if (error instanceof ApprovalError) throw error;
    return invalid('Action cannot be encoded as the declared EIP-712 data.');
  }
}

export function approvalOrigin(value: string): string {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Approval origin must be an explicit HTTP(S) origin without credentials, path, query or fragment.');
  return url.origin;
}
