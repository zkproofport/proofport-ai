import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile, lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ActionApproval } from '@zkproofport-ai/sdk';

type Service = { baseUrl: string };
type StoredApproval = {
  origin: string;
  approval: ActionApproval;
  operation: string;
  requestHash: string;
};

// Object key order is irrelevant; array order and every scalar value matter.
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  }
  return value;
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const requestHash = (value: unknown) => hash(JSON.stringify(canonical(value)));

/** Local continuation secrets stay out of model-facing MCP tool results. */
export class ApprovalStore {
  constructor(private directory = process.env.ZKPROOFPORT_APPROVAL_DIR || join(homedir(), '.config', 'zkproofport', 'approvals')) {}

  private path(config: Service, id: string): string {
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(id)) throw new Error('Invalid approval identifier');
    return join(this.directory, `${hash(config.baseUrl)}-${id}.json`);
  }

  private async ensureDirectory(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const info = await lstat(this.directory);
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
      throw new Error('Approval directory must be a private directory (permissions 0700)');
    }
  }

  private async read<T>(path: string): Promise<T> {
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
        throw new Error('Approval record must be a private regular file (permissions 0600)');
      }
      return JSON.parse(await readFile(path, 'utf8')) as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('Approval record not found for this service; use its original MCP client');
      throw error;
    }
  }

  async save(config: Service, approval: ActionApproval, operation: string, request: unknown): Promise<string> {
    await this.ensureDirectory();
    const path = this.path(config, approval.approvalId);
    const record: StoredApproval = { origin: config.baseUrl, approval, operation, requestHash: requestHash(request) };
    try {
      await writeFile(path, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const existing = await this.read<StoredApproval>(path);
      if (JSON.stringify(existing) !== JSON.stringify(record)) throw new Error('Approval already exists and does not match the original request');
    }
    return approval.approvalId;
  }

  async get(config: Service, id: string): Promise<ActionApproval> {
    const record = await this.read<StoredApproval>(this.path(config, id));
    if (record.origin !== config.baseUrl || record.approval.approvalId !== id) throw new Error('Approval service or identifier does not match');
    return record.approval;
  }

  async load(config: Service, id: string, operation: string, request: unknown): Promise<ActionApproval> {
    const record = await this.read<StoredApproval>(this.path(config, id));
    if (record.origin !== config.baseUrl || record.approval.approvalId !== id || record.operation !== operation || record.requestHash !== requestHash(request)) {
      throw new Error('Approval does not match the original operation and request; restore the original parameters or create a new request');
    }
    return record.approval;
  }

  async saveInputs(config: Service, circuit: string, inputs: unknown): Promise<string> {
    await this.ensureDirectory();
    const id = `inputs_${randomBytes(24).toString('hex')}`;
    await writeFile(this.path(config, id), JSON.stringify({ origin: config.baseUrl, circuit, inputs, expiresAt: Date.now() + 600_000 }), { flag: 'wx', mode: 0o600 });
    return id;
  }

  async consumeInputs(config: Service, id: string, circuit: string): Promise<Record<string, unknown>> {
    const path = this.path(config, id);
    const record = await this.read<{ origin: string; circuit: string; inputs: Record<string, unknown>; expiresAt: number }>(path);
    if (record.origin !== config.baseUrl || record.circuit !== circuit) throw new Error('Prepared inputs belong to a different service or circuit');
    if (record.expiresAt <= Date.now()) throw new Error('Prepared inputs have expired; do not automatically repeat a payment');
    const consumed = `${path}.consumed-${randomBytes(16).toString('hex')}`;
    try { await rename(path, consumed); }
    catch { throw new Error('Prepared inputs were already consumed'); }
    await unlink(consumed);
    return record.inputs;
  }
}
