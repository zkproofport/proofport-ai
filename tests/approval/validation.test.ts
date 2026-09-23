import { describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { TypedDataEncoder } from 'ethers';
import { boundedJson, validateApprovalRequest } from '../../src/approval/validation.js';
import { createActionApprovalRouter } from '../../src/approval/routes.js';
import * as config from '../../src/config/index.js';

const action = {
  domain: { name: 'Action', version: '1', chainId: 91342, verifyingContract: '0x' + '11'.repeat(20) },
  types: { Action: [{ name: 'amount', type: 'uint256' }, { name: 'memo', type: 'string' }, { name: 'enabled', type: 'bool' }] },
  primaryType: 'Action', message: { amount: '0', memo: '한글 😀 <script> % _ \\ SELECT\n\t', enabled: false },
};
const body = { circuit: 'giwa_attestation', scope: 'Gotgan', action };
const clone = () => structuredClone(body);

describe('approval validation unit boundaries', () => {
  it.each(['giwa_attestation', 'arc_eligibility'])('accepts %s with exact inert UTF-8 action values and zero', circuit => {
    const result = validateApprovalRequest({ ...body, circuit });
    expect(result.action).toEqual(action);
    expect(result.digest).toBe(TypedDataEncoder.hash(action.domain, action.types, action.message));
  });
  it.each(['coinbase_kyc', 'coinbase_attestation', 'oidc_domain', 'unknown', '', null, undefined])('refuses unsupported circuit %j', circuit => {
    expect(() => validateApprovalRequest({ ...body, circuit })).toThrow(/only/);
  });
  it.each([undefined, null, '', ' ', [], {}])('refuses absent or malformed action %j', value => {
    expect(() => validateApprovalRequest({ ...body, action: value })).toThrow();
  });
  it.each([undefined, null, '', ' ', 0, 'a'.repeat(1025), 'a'.repeat(2048)])('refuses invalid scope %j', scope => {
    expect(() => validateApprovalRequest({ ...body, scope })).toThrow();
  });
  it.each([1, 1024])('accepts scope byte boundary %i', length => {
    expect(validateApprovalRequest({ ...body, scope: 'a'.repeat(length) }).scope).toHaveLength(length);
  });
  it.each([0, 1, 4096])('accepts string byte boundary %i', length => {
    const input = clone(); input.action.message.memo = 'x'.repeat(length);
    expect(validateApprovalRequest(input).action.message.memo).toHaveLength(length);
  });
  it.each([4097, 8192])('refuses string byte boundary %i', length => {
    const input = clone(); input.action.message.memo = 'x'.repeat(length);
    expect(() => validateApprovalRequest(input)).toThrow();
  });
  it.each([0, 1, 128])('accepts array size %i', length => { expect(() => boundedJson(Array(length).fill(0))).not.toThrow(); });
  it.each([129, 256])('refuses array size %i', length => { expect(() => boundedJson(Array(length).fill(0))).toThrow(/128/); });
  it('rejects unsafe numbers, prototype keys, controls, deep data and unknown signed fields', () => {
    for (const value of [Number.MAX_SAFE_INTEGER + 1, 0.5, Infinity, '\u0000', JSON.parse('{"__proto__":{}}')]) expect(() => boundedJson(value)).toThrow();
    let nested: unknown = 1; for (let i = 0; i < 14; i++) nested = [nested];
    expect(() => boundedJson(nested)).toThrow(/nesting/);
    const extra = clone(); (extra.action.message as any).unsigned = 'hidden';
    expect(() => validateApprovalRequest(extra)).toThrow(/undeclared/);
  });
  it('rejects a root mismatch, malformed fields and truthy coercion of nested booleans', () => {
    const root = clone(); root.action.primaryType = 'Other'; expect(() => validateApprovalRequest(root)).toThrow();
    const bool = clone(); (bool.action.message as any).enabled = 'false'; expect(() => validateApprovalRequest(bool)).toThrow(/boolean/);
    const nested = { ...body, action: { ...action, types: { Root: [{ name: 'child', type: 'Child[]' }], Child: [{ name: 'ok', type: 'bool' }] }, primaryType: 'Root', message: { child: [{ ok: 'false' }] } } };
    expect(() => validateApprovalRequest(nested)).toThrow(/boolean/);
    const field = clone(); (field.action.types.Action[0] as any).type = null; expect(() => validateApprovalRequest(field)).toThrow();
  });
  it('does not admit extra domain keys, zero chain IDs, malformed expected signer or EIP712Domain', () => {
    const extra = clone(); (extra.action.domain as any).other = 'unsigned'; expect(() => validateApprovalRequest(extra)).toThrow();
    const zero = clone(); zero.action.domain.chainId = 0; expect(() => validateApprovalRequest(zero)).toThrow();
    expect(() => validateApprovalRequest({ ...body, expectedSigner: null })).toThrow();
    const typed = clone(); (typed.action.types as any).EIP712Domain = []; expect(() => validateApprovalRequest(typed)).toThrow();
  });
  it('binds circuit, exact scope, field order and domain while accepting object-key reordering', () => {
    const original = validateApprovalRequest(body);
    expect(validateApprovalRequest({ action, scope: 'Gotgan', circuit: 'giwa_attestation' }).requestHash).toBe(original.requestHash);
    for (const input of [{ ...body, circuit: 'arc_eligibility' }, { ...body, scope: 'Gotgan ' }, { ...body, action: { ...action, domain: { ...action.domain, chainId: 1 } } }]) expect(validateApprovalRequest(input).requestHash).not.toBe(original.requestHash);
  });
  it('enforces exact depth, node-count and object-member boundaries', () => {
    let depth: unknown = 0; for (let i = 0; i < 12; i++) depth = [depth];
    expect(() => boundedJson(depth)).not.toThrow(); expect(() => boundedJson([depth])).toThrow(/nesting/);
    const atLimit = [...Array.from({ length: 15 }, () => Array(128).fill(0)), Array(111).fill(0)];
    expect(() => boundedJson(atLimit)).not.toThrow();
    atLimit[15].push(0); expect(() => boundedJson(atLimit)).toThrow(/field limit/);
    expect(() => boundedJson(Object.fromEntries(Array.from({ length: 64 }, (_, i) => ['f' + i, i])))).not.toThrow();
    expect(() => boundedJson(Object.fromEntries(Array.from({ length: 65 }, (_, i) => ['f' + i, i])))).toThrow(/64/);
  });
  it('counts UTF-8 bytes rather than characters', () => {
    expect(validateApprovalRequest({ ...body, scope: '한'.repeat(341) + 'a' }).scope).toHaveLength(342);
    expect(() => validateApprovalRequest({ ...body, scope: '한'.repeat(342) })).toThrow(/1024/);
  });
  it('enforces a 128-field limit across nested declarations', () => {
    const fields = (count: number) => Array.from({ length: count }, (_, i) => ({ name: 'f' + i, type: 'uint256' }));
    const values = (count: number) => Object.fromEntries(fields(count).map(field => [field.name, '0']));
    function input(second: number) { return { ...body, action: { ...action,
      primaryType: 'Root', types: { Root: [{ name: 'first', type: 'First' }, { name: 'second', type: 'Second' }], First: fields(63), Second: fields(second) },
      message: { first: values(63), second: values(second) } } }; }
    expect(() => validateApprovalRequest(input(63))).not.toThrow();
    expect(() => validateApprovalRequest(input(64))).toThrow(/128 fields/);
  });
});

describe('approval HTTP unit fail-closed behavior (Redis unavailable)', () => {
  function app(projectId?: string) {
    const server = express(); server.use('/api/v1/action-approvals', createActionApprovalRouter({ origin: 'https://approval.example', walletConnectProjectId: projectId, redis: { eval: async () => { throw Error('secret provider diagnostic'); } } as never })); return server;
  }
  it('returns a sanitized storage error with no signature, key fallback or provider diagnostic', async () => {
    const response = await request(app()).post('/api/v1/action-approvals').send(body);
    expect(response.status).toBe(503); expect(response.body).toEqual({ error: 'APPROVAL_UNAVAILABLE', message: 'Approval storage is temporarily unavailable.' });
  });
  it('returns only explicitly configured WalletConnect project ID', async () => {
    expect((await request(app('public-project')).get('/api/v1/action-approvals/config')).body).toEqual({ walletConnectProjectId: 'public-project' });
  });
  it('rejects malformed JSON and foreign preflight; permits only the exact origin', async () => {
    expect((await request(app()).post('/api/v1/action-approvals').type('json').send('{')).status).toBe(400);
    expect((await request(app()).options('/api/v1/action-approvals').set('Origin', 'null')).status).toBe(403);
    const response = await request(app()).options('/api/v1/action-approvals').set('Origin', 'https://approval.example');
    expect(response.status).toBe(204); expect(response.headers['access-control-allow-origin']).toBe('https://approval.example');
  });
});

describe('explicit approval trusted-proxy configuration', () => {
  it('disables proxy trust unless a bounded integer hop count is explicitly set', () => {
    expect(config.parseApprovalTrustProxyHops).toBeTypeOf('function');
    expect(config.parseApprovalTrustProxyHops(undefined)).toBe(false);
    expect(config.parseApprovalTrustProxyHops('1')).toBe(1);
    expect(config.parseApprovalTrustProxyHops('16')).toBe(16);
    for (const value of ['', ' ', 'true', 'false', '0', '-1', '17', '1.5', '1e1', '01', '*']) {
      expect(() => config.parseApprovalTrustProxyHops(value)).toThrow(/APPROVAL_TRUST_PROXY_HOPS/);
    }
  });
});
