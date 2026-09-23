import { describe, expect, it, vi } from 'vitest';
import { waitForActionApproval } from '../src/approvalCli.js';

const pending = {
  status: 'awaiting_approval', approval_id: 'approval_0123456789',
  approval_url: 'https://approval.example.com/approve/id#browser',
  expires_at: new Date(Date.now() + 600_000).toISOString(),
};
const reply = (data: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(data) }] });

describe('CLI approval waiting', () => {
  it('displays the URL and resumes exactly once after status becomes approved', async () => {
    const messages: string[] = [];
    const calls: Array<{ name: string; arguments?: Record<string, unknown> }> = [];
    const callTool = async (call: { name: string; arguments?: Record<string, unknown> }) => {
      calls.push(call);
      return reply({ status: calls.length === 1 ? 'pending' : 'approved' });
    };
    const id = await waitForActionApproval(pending, callTool, text => messages.push(text), { pollIntervalMs: 0 });
    expect(id).toBe(pending.approval_id);
    expect(messages.join('\n')).toContain(pending.approval_url);
    expect(calls).toEqual([
      { name: 'get_action_approval', arguments: { approval_id: pending.approval_id } },
      { name: 'get_action_approval', arguments: { approval_id: pending.approval_id } },
    ]);
  });

  it.each(['rejected', 'expired', 'consumed'])('stops at %s without polling again', async status => {
    const callTool = vi.fn(async () => reply({ status }));
    await expect(waitForActionApproval(pending, callTool, () => {}, { pollIntervalMs: 0 })).rejects.toThrow(status);
    expect(callTool).toHaveBeenCalledTimes(1);
  });

  it('never treats a tool error or unknown state as approval', async () => {
    await expect(waitForActionApproval(pending, async () => ({ ...reply({ error: 'server unavailable' }), isError: true }), () => {})).rejects.toThrow(/server unavailable/);
    await expect(waitForActionApproval(pending, async () => reply({ status: 'mystery' }), () => {})).rejects.toThrow(/mystery/);
  });

  it('cancels an in-flight status read without waiting for the provider', async () => {
    const controller = new AbortController();
    const result = waitForActionApproval(pending, () => new Promise(() => {}), () => {}, { signal: controller.signal });
    controller.abort();
    await expect(result).rejects.toThrow(/cancel/i);
  }, 1000);

  it('does not accept a delayed approved response after local expiry', async () => {
    const expiresAt = Date.now() + 60_000;
    const now = vi.spyOn(Date, 'now');
    try {
      await expect(waitForActionApproval({ ...pending, expires_at: new Date(expiresAt).toISOString() }, async () => {
        now.mockReturnValue(expiresAt + 1);
        return reply({ status: 'approved' });
      }, () => {})).rejects.toThrow(/expired/i);
    } finally { now.mockRestore(); }
  });

  it('honors local expiry and cancellation without starting another request', async () => {
    const callTool = vi.fn();
    await expect(waitForActionApproval({ ...pending, expires_at: new Date(0).toISOString() }, callTool, () => {})).rejects.toThrow(/expired/i);
    const controller = new AbortController();
    controller.abort();
    await expect(waitForActionApproval(pending, callTool, () => {}, { signal: controller.signal })).rejects.toThrow(/cancel/i);
    expect(callTool).not.toHaveBeenCalled();
  });
});
