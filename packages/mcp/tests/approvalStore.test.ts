import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApprovalStore } from '../src/approvalStore.js';

let directory: string;
const config = { baseUrl: 'https://approval.example.com' };
const approval = {
  approvalId: 'approval_0123456789',
  approvalUrl: 'https://approval.example.com/approve/approval_0123456789#browser-secret',
  requesterToken: 'requester-secret',
  expiresAt: new Date(Date.now() + 600_000).toISOString(),
};
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'proofport-approval-store-')); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

describe('private approval continuation storage', () => {
  it('survives a client restart without exposing the requester credential in a handle', async () => {
    const store = new ApprovalStore(directory);
    const handle = await store.save(config, approval, 'generate_proof', { circuit: 'giwa_attestation', scope: 'Gotgan' });
    expect(handle).toBe(approval.approvalId);
    expect(handle).not.toContain(approval.requesterToken);
    const restored = await new ApprovalStore(directory).load(config, handle, 'generate_proof', { circuit: 'giwa_attestation', scope: 'Gotgan' });
    expect(restored).toEqual(approval);
    for (const name of await readdir(directory)) {
      expect((await stat(join(directory, name))).mode & 0o777).toBe(0o600);
    }
  });

  it('does not allow a changed operation, request, or service to resume an approval', async () => {
    const store = new ApprovalStore(directory);
    await store.save(config, approval, 'generate_proof', { scope: 'original', action: { amount: '1' } });
    await expect(store.load(config, approval.approvalId, 'prepare_inputs', { scope: 'original', action: { amount: '1' } })).rejects.toThrow(/match|operation/i);
    await expect(store.load(config, approval.approvalId, 'generate_proof', { scope: 'original', action: { amount: '2' } })).rejects.toThrow(/match|request/i);
    await expect(store.get({ baseUrl: 'https://other.example.com' }, approval.approvalId)).rejects.toThrow(/found|service/i);
    await expect(store.get(config, '../escape')).rejects.toThrow(/identifier/i);
  });

  it('retains original context when the same ID is saved again', async () => {
    const store = new ApprovalStore(directory);
    await store.save(config, approval, 'generate_proof', { scope: 'original' });
    await expect(store.save(config, approval, 'generate_proof', { scope: 'changed' })).rejects.toThrow(/match|exists/i);
    expect(await store.load(config, approval.approvalId, 'generate_proof', { scope: 'original' })).toEqual(approval);
  });

  it('keeps action witness inputs private and consumes their handle once', async () => {
    const store = new ApprovalStore(directory);
    const handle = await store.saveInputs(config, 'giwa_attestation', { user_signature: 'private-signature', value: [1, 2] });
    expect(handle).not.toContain('private-signature');
    await expect(store.consumeInputs(config, handle, 'arc_eligibility')).rejects.toThrow(/circuit/i);
    const results = await Promise.allSettled([
      store.consumeInputs(config, handle, 'giwa_attestation'),
      store.consumeInputs(config, handle, 'giwa_attestation'),
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(result => result.status === 'fulfilled')).toMatchObject({ value: { user_signature: 'private-signature', value: [1, 2] } });
    for (const name of await readdir(directory)) {
      expect(await readFile(join(directory, name), 'utf8')).not.toContain('private-signature');
    }
  });
});
