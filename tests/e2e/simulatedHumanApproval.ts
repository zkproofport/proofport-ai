/**
 * TEST ONLY: simulate the human's browser callback with the fixture wallet.
 * This exercises real approval HTTP/signature validation during E2E, but is
 * not evidence of a person operating MetaMask or WalletConnect. Never import
 * this from an application or use it to bypass the production approval flow.
 */
import { deepStrictEqual } from 'node:assert';
import type * as Sdk from '@zkproofport-ai/sdk';

type Request = { circuit: string; scope: string; action: Sdk.TypedAction };
type PublicApproval = { approvalId: string; approvalUrl: string };
type ToolResult = { isError?: boolean; content?: Array<{ text?: string }> };
type ToolClient = {
  listTools(): Promise<{ tools: Array<{ name: string }> }>;
  callTool(call: { name: string; arguments: Record<string, unknown> }, extra?: undefined, options?: { timeout: number }): Promise<unknown>;
};

export function mcpFixtureData(result: unknown): Record<string, any> {
  const reply = result as ToolResult;
  try { return JSON.parse(reply.content?.[0]?.text ?? '{}'); }
  catch { throw new Error('E2E tool response was not JSON'); }
}

async function simulateHuman(config: Sdk.ClientConfig, request: Request, signer: Sdk.ProofportSigner, approval: PublicApproval): Promise<void> {
  const frozen = structuredClone(request);
  const token = new URL(approval.approvalUrl).hash.substring(1);
  if (!token || !approval.approvalId) throw new Error('E2E approval lacks a browser capability');
  const endpoint = `${config.baseUrl.replace(/\/$/, '')}/api/v1/action-approvals/${encodeURIComponent(approval.approvalId)}`;
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const read = await fetch(endpoint, { headers, redirect: 'error', signal: AbortSignal.timeout(15_000) });
  if (!read.ok) throw new Error(`E2E approval read failed: HTTP ${read.status}`);
  const status = await read.json();
  if (status.status !== 'pending' || status.approvalId !== approval.approvalId) throw new Error('E2E approval is not the pending request');
  // Never sign values supplied by a changed server response.
  try { deepStrictEqual({ circuit: status.circuit, scope: status.scope, action: status.action }, frozen); }
  catch { throw new Error('E2E approval request changed before simulated signing'); }
  const address = await signer.getAddress();
  if (status.expectedSigner && status.expectedSigner.toLowerCase() !== address.toLowerCase()) throw new Error('E2E fixture wallet does not match expected signer');
  const signature = await signer.signTypedData(frozen.action.domain, frozen.action.types, frozen.action.message);
  const approved = await fetch(`${endpoint}/approve`, {
    method: 'POST', headers, body: JSON.stringify({ address, signature }),
    redirect: 'error', signal: AbortSignal.timeout(15_000),
  });
  if (!approved.ok || (await approved.json()).status !== 'approved') throw new Error(`E2E simulated approval failed: HTTP ${approved.status}`);
}

/** Older isolated npm SDKs keep their historical direct-signing test path. */
export async function generateProofWithSimulatedApproval(
  sdk: typeof Sdk,
  config: Sdk.ClientConfig,
  signers: { attestation: Sdk.ProofportSigner; payment?: Sdk.PaymentWallet },
  params: Sdk.ProofParams,
): Promise<Sdk.ProofResult> {
  const frozen = structuredClone(params);
  if (!frozen.action || !('ActionApprovalRequiredError' in sdk)) return sdk.generateProof(config, signers, frozen);
  let approval: Sdk.ActionApproval;
  try {
    await sdk.generateProof(config, signers, frozen);
    throw new Error('Current SDK action proof bypassed the expected human approval pause');
  } catch (error) {
    if ((error as { code?: string }).code !== 'ACTION_APPROVAL_REQUIRED') throw error;
    approval = (error as { approval: Sdk.ActionApproval }).approval;
  }
  await simulateHuman(config, { circuit: frozen.circuit, scope: frozen.scope || 'proofport', action: frozen.action }, signers.attestation, approval);
  // Exactly one resume attempt. A consumed session/proof failure is never retried.
  return sdk.generateProof(config, signers, { ...frozen, actionApproval: approval });
}

/** New MCP actions return a private continuation; older npm tools return directly. */
export async function callToolWithSimulatedApproval(
  client: ToolClient, config: Sdk.ClientConfig, signer: Sdk.ProofportSigner,
  name: 'generate_proof' | 'prepare_inputs', args: Record<string, unknown>, timeout = 180_000,
): Promise<unknown> {
  const frozen = structuredClone(args);
  if (!frozen.action) return client.callTool({ name, arguments: frozen }, undefined, { timeout });
  const supportsApproval = (await client.listTools()).tools.some(tool => tool.name === 'get_action_approval');
  const first = await client.callTool({ name, arguments: frozen }, undefined, { timeout });
  if (!supportsApproval) return first;
  const pending = mcpFixtureData(first);
  if ((first as ToolResult).isError || pending.status !== 'awaiting_approval') throw new Error('Current MCP action did not pause for human approval');
  await simulateHuman(config, { circuit: frozen.circuit as string, scope: (frozen.scope as string) || 'proofport', action: frozen.action as Sdk.TypedAction }, signer,
    { approvalId: pending.approval_id, approvalUrl: pending.approval_url });
  return client.callTool({ name, arguments: { ...frozen, approval_id: pending.approval_id } }, undefined, { timeout });
}
