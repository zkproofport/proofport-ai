/**
 * Multi-Turn Flow E2E Tests
 *
 * Tests the FULL signing → payment → ready flow across all protocols.
 * Simulates user interaction via internal signing/payment endpoints.
 *
 * Uses SDK clients for A2A (@a2a-js/sdk/client) and MCP
 * (@modelcontextprotocol/sdk/client) protocol sections.
 * REST endpoint tests use raw fetch (no SDK exists for custom REST).
 *
 * Prerequisites:
 *   cd proofport-ai && docker compose up --build -d
 *   Wait for healthy: curl http://localhost:4002/health
 *
 * Run: npx vitest run tests/e2e/multi-turn-flow.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { ethers } from 'ethers';
import { ClientFactory } from '@a2a-js/sdk/client';
import type { Client as A2aClient } from '@a2a-js/sdk/client';
import type { Task, Artifact } from '@a2a-js/sdk';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:4002';

// Test wallet — loaded from .env.test (via tests/setup.ts)
const PROVER_KEY = process.env.PROVER_PRIVATE_KEY;
if (!PROVER_KEY) throw new Error('PROVER_PRIVATE_KEY is required in .env.test');
const TEST_WALLET = new ethers.Wallet(PROVER_KEY);
const TEST_ADDRESS = TEST_WALLET.address;

// ─── SDK Clients (initialized in beforeAll) ──────────────────────────────────

let a2aClient: A2aClient;

// ─── SDK Helpers ─────────────────────────────────────────────────────────────

function extractDataFromArtifacts(artifacts: Artifact[] | undefined): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const artifact of artifacts || []) {
    for (const part of artifact.parts || []) {
      if (part.kind === 'data' && (part as any).data) {
        Object.assign(result, (part as any).data);
      }
    }
  }
  return result;
}

async function createMcpSdkClient(): Promise<{ client: McpClient; transport: StreamableHTTPClientTransport }> {
  const client = new McpClient(
    { name: 'e2e-test', version: '1.0.0' },
    { capabilities: {} },
  );
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE_URL}/mcp`));
  await client.connect(transport);
  return { client, transport };
}

function parseToolResult(result: any): any {
  const textContents = result.content?.filter((c: any) => c.type === 'text');
  if (!textContents || textContents.length === 0) return null;
  return JSON.parse(textContents[textContents.length - 1].text);
}

// ─── REST Helpers (kept as raw fetch) ────────────────────────────────────────

async function jsonPost(path: string, body: unknown, headers?: Record<string, string>) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: any;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: res.status, headers: res.headers, text, json };
}

async function jsonGet(path: string) {
  const res = await fetch(`${BASE_URL}${path}`);
  const json = await res.json();
  return { status: res.status, headers: res.headers, json };
}

/**
 * Simulate the sign-page flow:
 *   1. POST /api/signing/:requestId/prepare  → signalHash
 *   2. Sign signalHash with test wallet
 *   3. POST /api/signing/callback/:requestId → signing complete
 */
async function simulateSigning(requestId: string): Promise<void> {
  // Step 1: Prepare — compute signalHash from address + scope + circuitId
  const prepareRes = await jsonPost(`/api/signing/${requestId}/prepare`, {
    address: TEST_ADDRESS,
  });
  expect(prepareRes.status).toBe(200);
  expect(prepareRes.json.signalHash).toBeDefined();

  const signalHash = prepareRes.json.signalHash;

  // Step 2: Sign the signalHash (same as sign-page does with WalletConnect)
  const signalHashBytes = ethers.getBytes(signalHash);
  const signature = await TEST_WALLET.signMessage(signalHashBytes);

  // Step 3: Submit signature via callback
  const callbackRes = await jsonPost(`/api/signing/callback/${requestId}`, {
    signature,
    address: TEST_ADDRESS,
  });
  expect(callbackRes.status).toBe(200);
  expect(callbackRes.json.success).toBe(true);
}

/**
 * Simulate payment confirmation (as if the payment page confirmed a tx).
 */
async function simulatePayment(requestId: string): Promise<void> {
  const confirmRes = await jsonPost(`/api/payment/confirm/${requestId}`, {
    txHash: `0xe2e_test_${Date.now().toString(16)}`,
  });
  expect(confirmRes.status).toBe(200);
}

// ─── Connectivity + config check ──────────────────────────────────────────────

let paymentMode: string;

beforeAll(async () => {
  try {
    const res = await fetch(`${BASE_URL}/health`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`Health check failed: ${res.status}`);
    const health = await res.json();
    paymentMode = health.paymentMode;
  } catch (err) {
    throw new Error(
      `Cannot connect to ${BASE_URL}. Ensure the container is running:\n` +
      `  cd proofport-ai && docker compose up --build -d\n` +
      `Original error: ${err}`,
    );
  }

  // Initialize A2A SDK client
  const factory = new ClientFactory();
  a2aClient = await factory.createFromUrl(BASE_URL);
});

// ═══════════════════════════════════════════════════════════════════════════════
// REST Protocol — Full Multi-Turn Flow
// ═══════════════════════════════════════════════════════════════════════════════

describe('Multi-Turn Flow — REST Protocol', () => {
  let requestId: string;

  it('Step 1: POST /api/v1/signing creates session with requestId + signingUrl', async () => {
    const { status, json } = await jsonPost('/api/v1/signing', {
      circuitId: 'coinbase_attestation',
      scope: 'rest-flow-test.zkproofport.app',
    });

    expect(status).toBe(200);
    expect(json.requestId).toBeDefined();
    expect(json.signingUrl).toBeDefined();
    expect(json.signingUrl).toContain('/s/');
    expect(json.signingUrl).toContain(json.requestId);
    expect(json.expiresAt).toBeDefined();
    expect(json.circuitId).toBe('coinbase_attestation');
    expect(json.scope).toBe('rest-flow-test.zkproofport.app');

    requestId = json.requestId;
  });

  it('Step 2: check_status returns phase: signing', async () => {
    expect(requestId).toBeDefined();

    const { status, json } = await jsonGet(`/api/v1/signing/${requestId}/status`);
    expect(status).toBe(200);
    expect(json.requestId).toBe(requestId);
    expect(json.phase).toBe('signing');
    expect(json.signing.status).toBe('pending');
  });

  it('Step 3: request_payment before signing fails with 400', async () => {
    expect(requestId).toBeDefined();

    const { status, json } = await jsonPost(`/api/v1/signing/${requestId}/payment`, {});
    expect(status).toBe(400);
    expect(json.error).toBeDefined();
    expect(json.error.toLowerCase()).toMatch(/sign/);
  });

  it('Step 4: Simulate signing completion via prepare + callback', async () => {
    expect(requestId).toBeDefined();
    await simulateSigning(requestId);
  });

  it('Step 5: check_status after signing shows correct phase', async () => {
    expect(requestId).toBeDefined();

    const { status, json } = await jsonGet(`/api/v1/signing/${requestId}/status`);
    expect(status).toBe(200);
    expect(json.signing.status).toBe('completed');
    expect(json.signing.address).toBe(TEST_ADDRESS);

    if (paymentMode === 'disabled') {
      expect(json.phase).toBe('ready');
      expect(json.payment.status).toBe('not_required');
    } else {
      expect(json.phase).toBe('payment');
      expect(json.payment.status).toBe('pending');
      expect(json.payment.paymentUrl).toBeDefined();
      expect(json.payment.paymentUrl).toContain('/pay/');
    }
  });

  it('Step 6: request_payment after signing returns paymentUrl (or skips if disabled)', async () => {
    expect(requestId).toBeDefined();

    if (paymentMode === 'disabled') {
      // Payment not required — request_payment should return error
      const { status, json } = await jsonPost(`/api/v1/signing/${requestId}/payment`, {});
      expect(status).toBe(400);
      expect(json.error).toMatch(/not required|disabled/i);
      return;
    }

    const { status, json } = await jsonPost(`/api/v1/signing/${requestId}/payment`, {});
    expect(status).toBe(200);
    expect(json.requestId).toBe(requestId);
    expect(json.paymentUrl).toBeDefined();
    expect(json.paymentUrl).toContain('/pay/');
    expect(json.amount).toBeDefined();
    expect(json.currency).toBe('USDC');
    expect(json.network).toBeDefined();
  });

  it('Step 7: Simulate payment confirmation (if payment enabled)', async () => {
    expect(requestId).toBeDefined();
    if (paymentMode === 'disabled') return;

    await simulatePayment(requestId);
  });

  it('Step 8: check_status shows phase: ready after payment', async () => {
    expect(requestId).toBeDefined();

    const { status, json } = await jsonGet(`/api/v1/signing/${requestId}/status`);
    expect(status).toBe(200);
    expect(json.phase).toBe('ready');
    expect(json.signing.status).toBe('completed');

    if (paymentMode !== 'disabled') {
      expect(json.payment.status).toBe('completed');
      expect(json.payment.txHash).toBeDefined();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// REST — Country Circuit Flow (coinbase_country_attestation)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Multi-Turn Flow — REST Country Circuit', () => {
  let requestId: string;

  it('Step 1: Create session for coinbase_country_attestation', async () => {
    const { status, json } = await jsonPost('/api/v1/signing', {
      circuitId: 'coinbase_country_attestation',
      scope: 'country-flow-test.zkproofport.app',
      countryList: ['US', 'CA', 'GB'],
      isIncluded: true,
    });

    expect(status).toBe(200);
    expect(json.requestId).toBeDefined();
    expect(json.circuitId).toBe('coinbase_country_attestation');
    requestId = json.requestId;
  });

  it('Step 2: Simulate signing + verify phase transition', async () => {
    await simulateSigning(requestId);

    const { status, json } = await jsonGet(`/api/v1/signing/${requestId}/status`);
    expect(status).toBe(200);
    expect(json.signing.status).toBe('completed');
    if (paymentMode === 'disabled') {
      expect(json.phase).toBe('ready');
    } else {
      expect(json.phase).toBe('payment');
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// A2A Protocol — Full Multi-Turn Flow (SDK Client)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Multi-Turn Flow — A2A Protocol', () => {
  let requestId: string;

  it('Step 1: A2A request_signing returns requestId + signingUrl', async () => {
    const result = await a2aClient.sendMessage({
      message: {
        kind: 'message',
        messageId: randomUUID(),
        role: 'user',
        parts: [{ kind: 'data', data: { skill: 'request_signing', circuitId: 'coinbase_attestation', scope: 'a2a-flow-test.zkproofport.app' } }],
      },
    });

    const task = result as Task;
    expect(task.status.state).toBe('input-required');

    const data = extractDataFromArtifacts(task.artifacts);
    expect(data.requestId).toBeDefined();
    expect(data.signingUrl).toBeDefined();
    expect(typeof data.signingUrl).toBe('string');
    expect((data.signingUrl as string)).toContain('/s/');

    requestId = data.requestId as string;
  });

  it('Step 2: A2A check_status returns phase: signing', async () => {
    expect(requestId).toBeDefined();

    const result = await a2aClient.sendMessage({
      message: {
        kind: 'message',
        messageId: randomUUID(),
        role: 'user',
        parts: [{ kind: 'data', data: { skill: 'check_status', requestId } }],
      },
    });

    const task = result as Task;
    expect(task.status.state).toBe('input-required');

    const data = extractDataFromArtifacts(task.artifacts);
    expect(data.phase).toBe('signing');
    expect((data.signing as any).status).toBe('pending');
  });

  it('Step 3: A2A request_payment before signing fails', async () => {
    expect(requestId).toBeDefined();

    const result = await a2aClient.sendMessage({
      message: {
        kind: 'message',
        messageId: randomUUID(),
        role: 'user',
        parts: [{ kind: 'data', data: { skill: 'request_payment', requestId } }],
      },
    });

    const task = result as Task;
    expect(task.status.state).toBe('failed');
  });

  it('Step 4: Simulate signing completion', async () => {
    expect(requestId).toBeDefined();
    await simulateSigning(requestId);
  });

  it('Step 5: A2A check_status after signing shows correct phase', async () => {
    expect(requestId).toBeDefined();

    const result = await a2aClient.sendMessage({
      message: {
        kind: 'message',
        messageId: randomUUID(),
        role: 'user',
        parts: [{ kind: 'data', data: { skill: 'check_status', requestId } }],
      },
    });

    const task = result as Task;
    const data = extractDataFromArtifacts(task.artifacts);
    expect((data.signing as any).status).toBe('completed');

    if (paymentMode === 'disabled') {
      expect(data.phase).toBe('ready');
    } else {
      expect(data.phase).toBe('payment');
    }
  });

  it('Step 6: A2A request_payment after signing succeeds (or disabled)', async () => {
    expect(requestId).toBeDefined();

    const result = await a2aClient.sendMessage({
      message: {
        kind: 'message',
        messageId: randomUUID(),
        role: 'user',
        parts: [{ kind: 'data', data: { skill: 'request_payment', requestId } }],
      },
    });

    const task = result as Task;

    if (paymentMode === 'disabled') {
      // Should fail with "not required" error
      expect(task.status.state).toBe('failed');
    } else {
      expect(task.status.state).toBe('input-required');
      const data = extractDataFromArtifacts(task.artifacts);
      expect(data.paymentUrl).toBeDefined();
      expect((data.paymentUrl as string)).toContain('/pay/');
      expect(data.amount).toBeDefined();
      expect(data.currency).toBe('USDC');
    }
  });

  it('Step 7: Simulate payment + verify ready phase', async () => {
    expect(requestId).toBeDefined();
    if (paymentMode === 'disabled') return;

    await simulatePayment(requestId);

    const result = await a2aClient.sendMessage({
      message: {
        kind: 'message',
        messageId: randomUUID(),
        role: 'user',
        parts: [{ kind: 'data', data: { skill: 'check_status', requestId } }],
      },
    });

    const task = result as Task;
    const data = extractDataFromArtifacts(task.artifacts);
    expect(data.phase).toBe('ready');
    expect((data.payment as any).status).toBe('completed');
    expect((data.payment as any).txHash).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// MCP Protocol — Full Multi-Turn Flow (SDK Client)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Multi-Turn Flow — MCP Protocol', () => {
  let requestId: string;
  let mcpClient: McpClient;
  let mcpTransport: StreamableHTTPClientTransport;

  beforeAll(async () => {
    const conn = await createMcpSdkClient();
    mcpClient = conn.client;
    mcpTransport = conn.transport;
  });

  afterAll(async () => {
    try { await mcpTransport.close(); } catch { /* ignore */ }
  });

  it('Step 1: MCP request_signing returns requestId + signingUrl', async () => {
    const result = await mcpClient.callTool({
      name: 'request_signing',
      arguments: {
        circuitId: 'coinbase_attestation',
        scope: 'mcp-flow-test.zkproofport.app',
      },
    });

    const data = parseToolResult(result);
    expect(data).not.toBeNull();
    expect(data.requestId).toBeDefined();
    expect(data.signingUrl).toBeDefined();
    expect(data.signingUrl).toContain('/s/');

    requestId = data.requestId;
  });

  it('Step 2: MCP check_status returns phase: signing', async () => {
    expect(requestId).toBeDefined();

    const result = await mcpClient.callTool({
      name: 'check_status',
      arguments: { requestId },
    });

    const data = parseToolResult(result);
    expect(data).not.toBeNull();
    expect(data.phase).toBe('signing');
    expect(data.signing.status).toBe('pending');
  });

  it('Step 3: MCP request_payment before signing fails', async () => {
    expect(requestId).toBeDefined();

    const result = await mcpClient.callTool({
      name: 'request_payment',
      arguments: { requestId },
    });

    // Should be an error (isError: true or error field)
    const data = parseToolResult(result);
    expect(data).not.toBeNull();
    const hasError = (result as any).isError || data.error || data.isError;
    expect(hasError).toBeTruthy();
  });

  it('Step 4: Simulate signing completion', async () => {
    expect(requestId).toBeDefined();
    await simulateSigning(requestId);
  });

  it('Step 5: MCP check_status after signing shows correct phase', async () => {
    expect(requestId).toBeDefined();

    const result = await mcpClient.callTool({
      name: 'check_status',
      arguments: { requestId },
    });

    const data = parseToolResult(result);
    expect(data).not.toBeNull();
    expect(data.signing.status).toBe('completed');

    if (paymentMode === 'disabled') {
      expect(data.phase).toBe('ready');
    } else {
      expect(data.phase).toBe('payment');
      expect(data.payment.status).toBe('pending');
      expect(data.payment.paymentUrl).toContain('/pay/');
    }
  });

  it('Step 6: MCP request_payment after signing succeeds (or disabled)', async () => {
    expect(requestId).toBeDefined();

    const result = await mcpClient.callTool({
      name: 'request_payment',
      arguments: { requestId },
    });

    const data = parseToolResult(result);
    expect(data).not.toBeNull();

    if (paymentMode === 'disabled') {
      const hasError = (result as any).isError || data.error || data.isError;
      expect(hasError).toBeTruthy();
    } else {
      expect(data.requestId).toBe(requestId);
      expect(data.paymentUrl).toBeDefined();
      expect(data.paymentUrl).toContain('/pay/');
      expect(data.amount).toBeDefined();
      expect(data.currency).toBe('USDC');
      expect(data.network).toBeDefined();
    }
  });

  it('Step 7: Simulate payment + verify ready phase', async () => {
    expect(requestId).toBeDefined();
    if (paymentMode === 'disabled') return;

    await simulatePayment(requestId);

    const result = await mcpClient.callTool({
      name: 'check_status',
      arguments: { requestId },
    });

    const data = parseToolResult(result);
    expect(data).not.toBeNull();
    expect(data.phase).toBe('ready');
    expect(data.payment.status).toBe('completed');
    expect(data.payment.txHash).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Cross-Protocol Flow — Start in REST, check in A2A, payment in MCP
// ═══════════════════════════════════════════════════════════════════════════════

describe('Multi-Turn Flow — Cross-Protocol', () => {
  let requestId: string;
  let mcpClient: McpClient;
  let mcpTransport: StreamableHTTPClientTransport;

  beforeAll(async () => {
    const conn = await createMcpSdkClient();
    mcpClient = conn.client;
    mcpTransport = conn.transport;
  });

  afterAll(async () => {
    try { await mcpTransport.close(); } catch { /* ignore */ }
  });

  it('Step 1: REST request_signing creates session', async () => {
    const { status, json } = await jsonPost('/api/v1/signing', {
      circuitId: 'coinbase_attestation',
      scope: 'cross-protocol-test.zkproofport.app',
    });

    expect(status).toBe(200);
    requestId = json.requestId;
  });

  it('Step 2: A2A check_status reads the same session', async () => {
    expect(requestId).toBeDefined();

    const result = await a2aClient.sendMessage({
      message: {
        kind: 'message',
        messageId: randomUUID(),
        role: 'user',
        parts: [{ kind: 'data', data: { skill: 'check_status', requestId } }],
      },
    });

    const task = result as Task;
    expect(task.status.state).toBe('input-required');

    const data = extractDataFromArtifacts(task.artifacts);
    expect(data.phase).toBe('signing');
  });

  it('Step 3: Simulate signing completion', async () => {
    await simulateSigning(requestId);
  });

  it('Step 4: MCP check_status after signing shows correct phase', async () => {
    expect(requestId).toBeDefined();

    const result = await mcpClient.callTool({
      name: 'check_status',
      arguments: { requestId },
    });

    const data = parseToolResult(result);
    expect(data.signing.status).toBe('completed');
    if (paymentMode === 'disabled') {
      expect(data.phase).toBe('ready');
    } else {
      expect(data.phase).toBe('payment');
    }
  });

  it('Step 5: Simulate payment + REST check_status shows ready', async () => {
    if (paymentMode === 'disabled') return;

    await simulatePayment(requestId);

    const { status, json } = await jsonGet(`/api/v1/signing/${requestId}/status`);
    expect(status).toBe(200);
    expect(json.phase).toBe('ready');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Edge Cases
// ═══════════════════════════════════════════════════════════════════════════════

describe('Multi-Turn Flow — Edge Cases', () => {
  it('request_payment with fake requestId returns error', async () => {
    const { status, json } = await jsonPost('/api/v1/signing/nonexistent-request-id/payment', {});
    expect(status).toBe(400);
    expect(json.error).toBeDefined();
    expect(json.error).toMatch(/not found|expired/i);
  });

  it('check_status with expired requestId returns not found', async () => {
    const { status, json } = await jsonGet('/api/v1/signing/expired-request-id/status');
    expect(status).toBe(404);
    expect(json.error).toBeDefined();
  });

  it('duplicate request_payment call is idempotent', async () => {
    if (paymentMode === 'disabled') return;

    // Create and sign a session
    const createRes = await jsonPost('/api/v1/signing', {
      circuitId: 'coinbase_attestation',
      scope: 'idempotent-test.zkproofport.app',
    });
    const reqId = createRes.json.requestId;
    await simulateSigning(reqId);

    // Call request_payment twice
    const pay1 = await jsonPost(`/api/v1/signing/${reqId}/payment`, {});
    expect(pay1.status).toBe(200);
    expect(pay1.json.paymentUrl).toBeDefined();

    const pay2 = await jsonPost(`/api/v1/signing/${reqId}/payment`, {});
    expect(pay2.status).toBe(200);
    expect(pay2.json.paymentUrl).toBe(pay1.json.paymentUrl);
  });

  it('request_payment after payment completed returns error', async () => {
    if (paymentMode === 'disabled') return;

    // Create, sign, pay
    const createRes = await jsonPost('/api/v1/signing', {
      circuitId: 'coinbase_attestation',
      scope: 'double-pay-test.zkproofport.app',
    });
    const reqId = createRes.json.requestId;
    await simulateSigning(reqId);
    await jsonPost(`/api/v1/signing/${reqId}/payment`, {});
    await simulatePayment(reqId);

    // Try to request payment again
    const { status, json } = await jsonPost(`/api/v1/signing/${reqId}/payment`, {});
    expect(status).toBe(400);
    expect(json.error).toMatch(/already completed|proceed/i);
  });

  it('A2A request_payment via message/stream returns SSE events', async () => {
    if (paymentMode === 'disabled') return;

    // Create and sign
    const createRes = await jsonPost('/api/v1/signing', {
      circuitId: 'coinbase_attestation',
      scope: 'sse-payment-test.zkproofport.app',
    });
    const reqId = createRes.json.requestId;
    await simulateSigning(reqId);

    // Call request_payment via sendMessageStream (SDK)
    const events: any[] = [];

    const stream = a2aClient.sendMessageStream({
      message: {
        kind: 'message',
        messageId: randomUUID(),
        role: 'user',
        parts: [{ kind: 'data', data: { skill: 'request_payment', requestId: reqId } }],
      },
    });

    for await (const event of stream) {
      events.push(event);
    }

    expect(events.length).toBeGreaterThan(0);

    // Should contain an input-required task or status-update (request_payment returns input-required)
    const completedEvent = events.find(
      (e) =>
        (e.kind === 'status-update' && e.status?.state === 'input-required') ||
        (e.kind === 'task' && e.status?.state === 'input-required'),
    );
    expect(completedEvent).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// REST Flow Endpoint — Orchestrated Flow
// ═══════════════════════════════════════════════════════════════════════════════

describe('REST Flow Endpoint — Orchestrated Flow', () => {
  let flowId: string;
  let flowRequestId: string;

  it('POST /api/v1/flow creates a flow with signing phase', async () => {
    const { status, json } = await jsonPost('/api/v1/flow', {
      circuitId: 'coinbase_attestation',
      scope: 'flow-endpoint-test.zkproofport.app',
    });

    expect(status).toBe(200);
    expect(json.flowId).toBeDefined();
    expect(json.requestId).toBeDefined();
    expect(json.signingUrl).toBeDefined();
    expect(json.signingUrl).toContain('/s/');
    expect(json.phase).toBe('signing');
    expect(json.circuitId).toBe('coinbase_attestation');
    expect(json.scope).toBe('flow-endpoint-test.zkproofport.app');
    expect(json.createdAt).toBeDefined();
    expect(json.expiresAt).toBeDefined();

    flowId = json.flowId;
    flowRequestId = json.requestId;
  });

  it('GET /api/v1/flow/:flowId returns current flow state (signing)', async () => {
    expect(flowId).toBeDefined();

    const { status, json } = await jsonGet(`/api/v1/flow/${flowId}`);
    expect(status).toBe(200);
    expect(json.flowId).toBe(flowId);
    expect(json.requestId).toBe(flowRequestId);
    expect(json.phase).toBe('signing');
  });

  it('Simulate signing, then GET /api/v1/flow/:flowId auto-advances', async () => {
    expect(flowId).toBeDefined();
    expect(flowRequestId).toBeDefined();

    await simulateSigning(flowRequestId);

    const { status, json } = await jsonGet(`/api/v1/flow/${flowId}`);
    expect(status).toBe(200);
    expect(json.flowId).toBe(flowId);

    if (paymentMode === 'disabled') {
      // Should auto-advance past payment to generating/completed/failed
      // (proof generation may fail in test env, but phase should not be 'signing')
      expect(json.phase).not.toBe('signing');
    } else {
      expect(json.phase).toBe('payment');
      expect(json.paymentUrl).toBeDefined();
      expect(json.paymentUrl).toContain('/pay/');
    }
  });

  it('Simulate payment (if enabled) then flow auto-advances to generating/completed/failed', async () => {
    expect(flowId).toBeDefined();
    if (paymentMode === 'disabled') return;

    await simulatePayment(flowRequestId);

    const { status, json } = await jsonGet(`/api/v1/flow/${flowId}`);
    expect(status).toBe(200);
    // After payment, advanceFlow should trigger proof generation
    // In test env, proof generation will likely fail (no real attestation)
    // but phase should advance past 'payment'
    expect(json.phase).not.toBe('payment');
    expect(json.phase).not.toBe('signing');
  });

  it('POST /api/v1/flow with missing circuitId returns 400', async () => {
    const { status, json } = await jsonPost('/api/v1/flow', {
      scope: 'test.zkproofport.app',
    });
    expect(status).toBe(400);
    expect(json.error).toBeDefined();
  });

  it('POST /api/v1/flow with missing scope returns 400', async () => {
    const { status, json } = await jsonPost('/api/v1/flow', {
      circuitId: 'coinbase_attestation',
    });
    expect(status).toBe(400);
    expect(json.error).toBeDefined();
  });

  it('GET /api/v1/flow/:flowId with non-existent flowId returns 404', async () => {
    const { status, json } = await jsonGet('/api/v1/flow/nonexistent-flow-id-00000');
    expect(status).toBe(404);
    expect(json.error).toBeDefined();
  });

  it('POST /api/v1/flow with country circuit includes extra params', async () => {
    const { status, json } = await jsonPost('/api/v1/flow', {
      circuitId: 'coinbase_country_attestation',
      scope: 'flow-country-test.zkproofport.app',
      countryList: ['US', 'CA'],
      isIncluded: true,
    });

    expect(status).toBe(200);
    expect(json.flowId).toBeDefined();
    expect(json.circuitId).toBe('coinbase_country_attestation');
    expect(json.countryList).toEqual(['US', 'CA']);
    expect(json.isIncluded).toBe(true);
    expect(json.phase).toBe('signing');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// REST Flow Endpoint — SSE Events
// ═══════════════════════════════════════════════════════════════════════════════

describe('REST Flow Endpoint — SSE Events', () => {
  it('GET /api/v1/flow/:flowId/events returns SSE stream with initial state', async () => {
    // Create a flow first
    const createRes = await jsonPost('/api/v1/flow', {
      circuitId: 'coinbase_attestation',
      scope: 'flow-sse-test.zkproofport.app',
    });
    expect(createRes.status).toBe(200);
    const flowId = createRes.json.flowId;

    // Connect to SSE — use AbortController to close after first event
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);

    try {
      const res = await fetch(`${BASE_URL}/api/v1/flow/${flowId}/events`, {
        signal: controller.signal,
        headers: { 'Accept': 'text/event-stream' },
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/event-stream');

      // Read some of the stream
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let text = '';

      // Read chunks until we have enough data or timeout
      const readPromise = async () => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          text += decoder.decode(value, { stream: true });
          // Stop after we get the initial phase event
          if (text.includes('event: phase')) break;
        }
      };

      await Promise.race([
        readPromise(),
        new Promise(resolve => setTimeout(resolve, 2000)),
      ]);

      // Should have at least the initial phase event
      expect(text).toContain('event: phase');
      expect(text).toContain('"phase":"signing"');
    } catch (err: any) {
      if (err.name !== 'AbortError') throw err;
    } finally {
      clearTimeout(timeout);
      controller.abort();
    }
  });

  it('GET /api/v1/flow/:flowId/events with non-existent flowId returns 404', async () => {
    const res = await fetch(`${BASE_URL}/api/v1/flow/nonexistent-sse-id/events`);
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// A2A Context Linking — contextId auto-resolves requestId (SDK Client)
// ═══════════════════════════════════════════════════════════════════════════════

describe('A2A Context Linking — contextId auto-resolution', () => {
  const contextId = `e2e-ctx-${Date.now()}`;
  let requestId: string;

  it('Step 1: request_signing with contextId stores requestId mapping', async () => {
    const result = await a2aClient.sendMessage({
      message: {
        kind: 'message',
        messageId: randomUUID(),
        role: 'user',
        contextId,
        parts: [{ kind: 'data', data: { skill: 'request_signing', circuitId: 'coinbase_attestation', scope: 'context-link-test.zkproofport.app' } }],
      },
    });

    const task = result as Task;
    expect(task.status.state).toBe('input-required');

    const data = extractDataFromArtifacts(task.artifacts);
    expect(data.requestId).toBeDefined();
    expect(data.signingUrl).toBeDefined();

    requestId = data.requestId as string;
  });

  it('Step 2: check_status with same contextId, WITHOUT requestId, auto-resolves', async () => {
    expect(requestId).toBeDefined();

    // Note: no requestId in params — should be auto-resolved from contextId
    const result = await a2aClient.sendMessage({
      message: {
        kind: 'message',
        messageId: randomUUID(),
        role: 'user',
        contextId,
        parts: [{ kind: 'data', data: { skill: 'check_status' } }],
      },
    });

    const task = result as Task;
    expect(task.status.state).toBe('input-required');

    const data = extractDataFromArtifacts(task.artifacts);
    expect(data.phase).toBe('signing');
    expect(data.requestId).toBe(requestId);
  });

  it('Step 3: Simulate signing, then check_status with contextId shows new phase', async () => {
    expect(requestId).toBeDefined();
    await simulateSigning(requestId);

    const result = await a2aClient.sendMessage({
      message: {
        kind: 'message',
        messageId: randomUUID(),
        role: 'user',
        contextId,
        parts: [{ kind: 'data', data: { skill: 'check_status' } }],
      },
    });

    const task = result as Task;
    const data = extractDataFromArtifacts(task.artifacts);
    expect((data.signing as any).status).toBe('completed');

    if (paymentMode === 'disabled') {
      expect(data.phase).toBe('ready');
    } else {
      expect(data.phase).toBe('payment');
    }
  });

  it('Step 4: request_payment with contextId auto-resolves requestId', async () => {
    expect(requestId).toBeDefined();

    // No requestId in params — auto-resolved
    const result = await a2aClient.sendMessage({
      message: {
        kind: 'message',
        messageId: randomUUID(),
        role: 'user',
        contextId,
        parts: [{ kind: 'data', data: { skill: 'request_payment' } }],
      },
    });

    const task = result as Task;

    if (paymentMode === 'disabled') {
      expect(task.status.state).toBe('failed');
    } else {
      expect(task.status.state).toBe('input-required');
      const data = extractDataFromArtifacts(task.artifacts);
      expect(data.paymentUrl).toBeDefined();
    }
  });

  it('Step 5: check_status with explicit requestId still works (no regression)', async () => {
    expect(requestId).toBeDefined();

    // Explicitly passing requestId — should still work
    const result = await a2aClient.sendMessage({
      message: {
        kind: 'message',
        messageId: randomUUID(),
        role: 'user',
        contextId,
        parts: [{ kind: 'data', data: { skill: 'check_status', requestId } }],
      },
    });

    const task = result as Task;
    // Phase depends on paymentMode: 'ready' → completed, 'payment' → input-required
    if (paymentMode === 'disabled') {
      expect(task.status.state).toBe('completed');
    } else {
      expect(task.status.state).toBe('input-required');
    }

    const data = extractDataFromArtifacts(task.artifacts);
    expect(data.requestId).toBe(requestId);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// A2A Context Linking — No contextId regression (SDK Client)
// ═══════════════════════════════════════════════════════════════════════════════

describe('A2A Context Linking — No contextId (backward compatible)', () => {
  it('check_status without contextId and without requestId returns error', async () => {
    const result = await a2aClient.sendMessage({
      message: {
        kind: 'message',
        messageId: randomUUID(),
        role: 'user',
        parts: [{ kind: 'data', data: { skill: 'check_status' } }],
      },
    });

    const task = result as Task;
    // Should fail because no requestId and no contextId to auto-resolve from
    expect(task.status.state).toBe('failed');
  });

  it('request_signing without contextId still works normally', async () => {
    const result = await a2aClient.sendMessage({
      message: {
        kind: 'message',
        messageId: randomUUID(),
        role: 'user',
        parts: [{
          kind: 'data',
          data: {
            skill: 'request_signing',
            circuitId: 'coinbase_attestation',
            scope: 'no-context-test.zkproofport.app',
          },
        }],
      },
    });

    const task = result as Task;
    expect(task.status.state).toBe('input-required');

    const data = extractDataFromArtifacts(task.artifacts);
    expect(data.requestId).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// A2A TextPart — LLM Inference E2E (SDK Client)
// ═══════════════════════════════════════════════════════════════════════════════

describe('A2A TextPart — LLM Inference E2E', () => {
  it('TextPart: "list supported circuits" → get_supported_circuits skill executed, returns circuits', { timeout: 30000 }, async () => {
    const result = await a2aClient.sendMessage({
      message: {
        kind: 'message',
        messageId: randomUUID(),
        role: 'user',
        parts: [{ kind: 'text', text: 'list supported circuits' }],
      },
    });

    const task = result as Task;
    expect(task.status.state).toBe('completed');

    const data = extractDataFromArtifacts(task.artifacts);
    expect(data.circuits).toBeDefined();
    expect(Array.isArray(data.circuits)).toBe(true);
    expect((data.circuits as any[]).length).toBeGreaterThan(0);
  });

  it('TextPart: "verify proof 0xaabb for coinbase_attestation" → verify_proof skill executed', { timeout: 30000 }, async () => {
    const result = await a2aClient.sendMessage({
      message: {
        kind: 'message',
        messageId: randomUUID(),
        role: 'user',
        parts: [{ kind: 'text', text: 'verify proof 0xaabb with publicInputs 0x' + 'cc'.repeat(32) + ' for coinbase_attestation on chain 84532' }],
      },
    });

    const task = result as Task;
    // verify_proof may complete or fail depending on proof data, but skill should execute
    expect(['completed', 'failed']).toContain(task.status.state);
  });

  it('TextPart: "generate proof for coinbase_attestation scope test.com" → request_signing flow started', { timeout: 30000 }, async () => {
    const result = await a2aClient.sendMessage({
      message: {
        kind: 'message',
        messageId: randomUUID(),
        role: 'user',
        parts: [{ kind: 'text', text: 'generate proof for coinbase_attestation with scope textpart-test.zkproofport.app' }],
      },
    });

    const task = result as Task;
    // LLM routes to request_signing (input-required) or generate_proof (completed/failed)
    // All are valid — the key is the skill executed successfully
    expect(['completed', 'failed', 'input-required']).toContain(task.status.state);

    if (task.status.state === 'completed') {
      const data = extractDataFromArtifacts(task.artifacts);
      // If routed to request_signing: should have requestId + signingUrl
      // If routed to generate_proof: would fail (no signing done yet) but still returns
      if (data.requestId) {
        expect(data.signingUrl).toBeDefined();
        expect(typeof data.signingUrl).toBe('string');
      }
    }
  });

  it('TextPart multi-turn: request_signing → check_status via natural language', { timeout: 60000 }, async () => {
    // Step 1: Start signing via TextPart
    const result1 = await a2aClient.sendMessage({
      message: {
        kind: 'message',
        messageId: randomUUID(),
        role: 'user',
        parts: [{ kind: 'text', text: 'I need a KYC proof for coinbase_attestation with scope textpart-multi.zkproofport.app' }],
      },
    });

    const task1 = result1 as Task;
    expect(task1.status.state).toBe('input-required');

    const data1 = extractDataFromArtifacts(task1.artifacts);
    // LLM should route to request_signing
    if (!data1.requestId) {
      // If LLM routed to generate_proof instead, that's also valid but we can't continue multi-turn
      return;
    }

    const requestId = data1.requestId as string;

    // Step 2: Check status using DataPart (reliable) to verify the request exists
    const result2 = await a2aClient.sendMessage({
      message: {
        kind: 'message',
        messageId: randomUUID(),
        role: 'user',
        parts: [{ kind: 'data', data: { skill: 'check_status', requestId } }],
      },
    });

    const task2 = result2 as Task;
    expect(task2.status.state).toBe('input-required');

    const data2 = extractDataFromArtifacts(task2.artifacts);
    expect(data2.phase).toBe('signing');
  });

  it('TextPart: message with no LLM configured returns error gracefully', { timeout: 15000 }, async () => {
    // If LLM is configured, this will succeed. If not, should return a failed task.
    // Either way, the server should NOT crash or return 500.
    const result = await a2aClient.sendMessage({
      message: {
        kind: 'message',
        messageId: randomUUID(),
        role: 'user',
        parts: [{ kind: 'text', text: 'hello world' }],
      },
    });

    // SDK returns a Task (either completed or failed)
    const task = result as Task;
    expect(task.status).toBeDefined();
    expect(task.status.state).toBeDefined();
  });
});
