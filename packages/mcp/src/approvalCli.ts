import { setTimeout as delay } from 'node:timers/promises';

export type PendingActionApproval = {
  status: 'awaiting_approval'; approval_id: string; approval_url: string; expires_at: string;
};
type ToolCall = { name: string; arguments?: Record<string, unknown> };

export function toolData(result: unknown): Record<string, unknown> {
  const reply = result as { isError?: boolean; content?: Array<{ text?: string }> };
  const data = JSON.parse(reply.content?.[0]?.text ?? '{}') as Record<string, unknown>;
  if (reply.isError) throw new Error(typeof data.error === 'string' ? data.error : 'Approval tool request failed');
  return data;
}

async function abortable<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  if (signal.aborted) throw new Error('Action approval cancelled');
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
      abort = () => reject(new Error('Action approval cancelled'));
      signal.addEventListener('abort', abort, { once: true });
    })]);
  } finally { if (abort) signal.removeEventListener('abort', abort); }
}

/** Waiting is outside an MCP tool call, so the person's decision has no proof timeout. */
export async function waitForActionApproval(
  pending: PendingActionApproval,
  callTool: (call: ToolCall) => Promise<unknown>,
  write: (message: string) => void,
  options: { signal?: AbortSignal; pollIntervalMs?: number } = {},
): Promise<string> {
  const expires = Date.parse(pending.expires_at);
  if (!Number.isFinite(expires)) throw new Error('Approval response has an invalid expiry');
  write(`[zkproofport-prove] Human action signature required. Open: ${pending.approval_url}`);
  write(`[zkproofport-prove] Waiting for wallet approval until ${pending.expires_at}. Press Ctrl+C to stop.`);
  while (true) {
    if (options.signal?.aborted) throw new Error('Action approval cancelled');
    if (Date.now() >= expires) throw new Error('Action approval expired; no proof payment was started');
    const data = toolData(await abortable(callTool({ name: 'get_action_approval', arguments: { approval_id: pending.approval_id } }), options.signal));
    if (options.signal?.aborted) throw new Error('Action approval cancelled');
    if (Date.now() >= expires) throw new Error('Action approval expired; no proof payment was started');
    if (data.status === 'approved') return pending.approval_id;
    if (['rejected', 'expired', 'consumed'].includes(String(data.status))) throw new Error(`Action approval ${data.status}; no new proof payment was started`);
    if (data.status !== 'pending') throw new Error(`Unknown action approval status: ${String(data.status)}`);
    try { await delay(Math.min(options.pollIntervalMs ?? 2000, Math.max(0, expires - Date.now())), undefined, { signal: options.signal }); }
    catch { throw new Error('Action approval cancelled'); }
  }
}
