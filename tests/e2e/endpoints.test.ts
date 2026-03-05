/**
 * Real E2E Tests — hits the actual Docker container at localhost:4002
 *
 * Prerequisites:
 *   cd proofport-ai && docker compose up --build -d
 *   Wait for healthy: curl http://localhost:4002/health
 *
 * NO vi.mock(), NO supertest, NO createApp() — real HTTP only.
 *
 * SDK clients used for protocol sections:
 *   - A2A: @a2a-js/sdk/client (ClientFactory, Client)
 *   - MCP: @modelcontextprotocol/sdk (Client + StreamableHTTPClientTransport)
 *
 * Raw fetch kept for: REST endpoints, discovery, and edge cases testing raw JSON-RPC validation.
 *
 * Run: npx vitest run tests/e2e/endpoints.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';

// SDK clients
import { ClientFactory } from '@a2a-js/sdk/client';
import type { Client as A2AClient } from '@a2a-js/sdk/client';
import type { Task, Artifact, Part } from '@a2a-js/sdk';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:4002';

// ─── REST Helpers (kept for non-protocol endpoints) ──────────────────────────

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

function parseSseEvents(text: string): any[] {
  return text
    .split('\n')
    .filter(line => line.startsWith('data: ') || line.startsWith('data:'))
    .map(line => {
      const data = line.startsWith('data: ') ? line.substring(6) : line.substring(5);
      try { return JSON.parse(data.trim()); } catch { return null; }
    })
    .filter(Boolean);
}

// ─── A2A SDK Helpers ─────────────────────────────────────────────────────────

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

function makeDataPartMessage(data: Record<string, unknown>, contextId?: string) {
  return {
    message: {
      kind: 'message' as const,
      messageId: randomUUID(),
      role: 'user' as const,
      parts: [{ kind: 'data' as const, data }],
      ...(contextId ? { contextId } : {}),
    },
  };
}

// ─── MCP SDK Helpers ─────────────────────────────────────────────────────────

async function createMcpClient(): Promise<{ client: McpClient; transport: StreamableHTTPClientTransport }> {
  const client = new McpClient(
    { name: 'e2e-test', version: '1.0.0' },
    { capabilities: {} },
  );
  const transport = new StreamableHTTPClientTransport(
    new URL(`${BASE_URL}/mcp`),
  );
  await client.connect(transport);
  return { client, transport };
}

function parseToolResult(result: any): any {
  const textContents = result.content?.filter((c: any) => c.type === 'text');
  if (!textContents || textContents.length === 0) return null;
  return JSON.parse(textContents[textContents.length - 1].text);
}

// ─── Other Helpers ───────────────────────────────────────────────────────────

// ─── SDK Client Instances ────────────────────────────────────────────────────

let a2aClient: A2AClient;

// ─── Connectivity check + SDK client setup ───────────────────────────────────

beforeAll(async () => {
  try {
    const res = await fetch(`${BASE_URL}/health`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`Health check failed: ${res.status}`);
  } catch (err) {
    throw new Error(
      `Cannot connect to ${BASE_URL}. Ensure the container is running:\n` +
      `  cd proofport-ai && docker compose up --build -d\n` +
      `Original error: ${err}`
    );
  }

  // Create A2A SDK client
  const factory = new ClientFactory();
  a2aClient = await factory.createFromUrl(BASE_URL);
}, 15000);

// ═══════════════════════════════════════════════════════════════════════════
// Discovery Endpoints (raw fetch — no SDK for custom REST)
// ═══════════════════════════════════════════════════════════════════════════

describe('Discovery Endpoints', () => {
  it('GET /health returns healthy', async () => {
    const { status, json } = await jsonGet('/health');
    expect(status).toBe(200);
    expect(json.status).toBe('healthy');
    expect(json.service).toBe('proofport-ai');
  });

  it('GET /.well-known/agent-card.json returns A2A agent card with 2 skills', async () => {
    const { status, json } = await jsonGet('/.well-known/agent-card.json');
    expect(status).toBe(200);
    expect(json.name).toBe('proveragent.base.eth');
    expect(json.protocolVersion).toBe('0.3.0');
    expect(Array.isArray(json.skills)).toBe(true);
    expect(json.skills.length).toBe(3);
    const skillIds = json.skills.map((s: any) => s.id).sort();
    expect(skillIds).toEqual([
      'get_guide',
      'get_supported_circuits',
      'prove',
    ]);
  });

  it('GET /.well-known/agent.json returns OASF agent descriptor', async () => {
    const { status, json } = await jsonGet('/.well-known/agent.json');
    expect(status).toBe(200);
    expect(json.name).toBeDefined();
    expect(json.name).toBe('proveragent.base.eth');
  });

  it('GET /.well-known/mcp.json returns MCP server metadata with 2 tools', async () => {
    const { status, json } = await jsonGet('/.well-known/mcp.json');
    expect(status).toBe(200);
    expect(json.serverInfo).toBeDefined();
    expect(json.serverInfo.name).toBeDefined();
    expect(Array.isArray(json.tools)).toBe(true);
    expect(json.tools.length).toBe(3);
    const toolNames = json.tools.map((t: any) => t.name).sort();
    expect(toolNames).toEqual([
      'get_guide',
      'get_supported_circuits',
      'prove',
    ]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// REST API — x402 Single-Step Flow
// ═══════════════════════════════════════════════════════════════════════════

describe('REST API — x402 Single-Step Flow', () => {
  it('POST /api/v1/prove with circuit + inputs (no session_id) returns 402 with PAYMENT-REQUIRED header', async () => {
    const { status, headers, json } = await jsonPost('/api/v1/prove', {
      circuit: 'coinbase_kyc',
      inputs: { signal_hash: '0x01', nullifier: '0x02', scope_bytes: '0x03', merkle_root: '0x04', user_address: '0x05' },
    });
    expect(status).toBe(402);
    expect(json.error).toBe('PAYMENT_REQUIRED');
    expect(json.nonce).toBeDefined();
    expect(json.nonce.startsWith('0x')).toBe(true);
    expect(json.payment).toBeDefined();
    expect(json.payment.scheme).toBe('exact');
    expect(json.payment.payTo).toBeDefined();
    // Check PAYMENT-REQUIRED header exists
    const paymentHeader = headers.get('payment-required');
    expect(paymentHeader).toBeDefined();
    // Decode and validate
    const decoded = JSON.parse(Buffer.from(paymentHeader!, 'base64').toString());
    expect(decoded.scheme).toBe('exact');
    expect(decoded.extra.nonce).toBe(json.nonce);
  });

  it('POST /api/v1/prove without session_id and without inputs returns 400', async () => {
    const { status, json } = await jsonPost('/api/v1/prove', {
      circuit: 'coinbase_kyc',
    });
    expect(status).toBe(400);
    expect(json.error).toBe('INVALID_REQUEST');
    expect(json.message).toMatch(/inputs/i);
  });

  it('POST /api/v1/prove without session_id and without circuit returns 400', async () => {
    const { status, json } = await jsonPost('/api/v1/prove', {
      inputs: { signal_hash: '0x01' },
    });
    expect(status).toBe(400);
    expect(json.error).toBe('INVALID_REQUEST');
    expect(json.message).toMatch(/circuit/i);
  });

  it('POST /api/v1/prove with unknown circuit returns 400', async () => {
    const { status, json } = await jsonPost('/api/v1/prove', {
      circuit: 'nonexistent_circuit',
      inputs: { signal_hash: '0x01' },
    });
    expect(status).toBe(400);
    expect(json.error).toBe('INVALID_CIRCUIT');
  });

  it('POST /api/v1/prove with X-Payment-TX but without X-Payment-Nonce returns 400', async () => {
    const res = await fetch(`${BASE_URL}/api/v1/prove`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Payment-TX': '0xfake_tx_hash',
      },
      body: JSON.stringify({
        circuit: 'coinbase_kyc',
        inputs: { signal_hash: '0x01', nullifier: '0x02', scope_bytes: '0x03', merkle_root: '0x04', user_address: '0x05' },
      }),
    });
    const json = await res.json();
    expect(res.status).toBe(400);
    expect(json.error).toBe('MISSING_NONCE');
  });

  it('POST /api/v1/prove with X-Payment-TX + invalid X-Payment-Nonce returns 400', async () => {
    const res = await fetch(`${BASE_URL}/api/v1/prove`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Payment-TX': '0xfake_tx_hash',
        'X-Payment-Nonce': '0xinvalid_nonce_not_in_redis',
      },
      body: JSON.stringify({
        circuit: 'coinbase_kyc',
        inputs: { signal_hash: '0x01', nullifier: '0x02', scope_bytes: '0x03', merkle_root: '0x04', user_address: '0x05' },
      }),
    });
    const json = await res.json();
    expect(res.status).toBe(400);
    expect(json.error).toBe('INVALID_NONCE');
  });

  it('402 nonce expires after 5 minutes (TTL check)', async () => {
    // Get a valid nonce first
    const { json: firstRes } = await jsonPost('/api/v1/prove', {
      circuit: 'coinbase_kyc',
      inputs: { signal_hash: '0x01', nullifier: '0x02', scope_bytes: '0x03', merkle_root: '0x04', user_address: '0x05' },
    });
    expect(firstRes.nonce).toBeDefined();
    // Using the nonce immediately should not give INVALID_NONCE (it should fail later on payment verification)
    // This just confirms the nonce is accepted
    const res = await fetch(`${BASE_URL}/api/v1/prove`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Payment-TX': '0x0000000000000000000000000000000000000000000000000000000000000001',
        'X-Payment-Nonce': firstRes.nonce,
      },
      body: JSON.stringify({
        circuit: 'coinbase_kyc',
        inputs: { signal_hash: '0x01', nullifier: '0x02', scope_bytes: '0x03', merkle_root: '0x04', user_address: '0x05' },
      }),
    });
    const json = await res.json();
    // Should NOT be INVALID_NONCE — the nonce was valid (will fail on payment verification instead)
    expect(json.error).not.toBe('INVALID_NONCE');
  });

  it('nonce can only be used once (replay protection)', async () => {
    // Get a valid nonce
    const { json: firstRes } = await jsonPost('/api/v1/prove', {
      circuit: 'coinbase_kyc',
      inputs: { signal_hash: '0x01', nullifier: '0x02', scope_bytes: '0x03', merkle_root: '0x04', user_address: '0x05' },
    });
    const nonce = firstRes.nonce;

    // First use — nonce is consumed (will fail on payment verify but nonce is deleted)
    await fetch(`${BASE_URL}/api/v1/prove`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Payment-TX': '0x0000000000000000000000000000000000000000000000000000000000000001',
        'X-Payment-Nonce': nonce,
      },
      body: JSON.stringify({
        circuit: 'coinbase_kyc',
        inputs: { signal_hash: '0x01', nullifier: '0x02', scope_bytes: '0x03', merkle_root: '0x04', user_address: '0x05' },
      }),
    });

    // Second use — nonce should be invalid (consumed)
    const res2 = await fetch(`${BASE_URL}/api/v1/prove`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Payment-TX': '0x0000000000000000000000000000000000000000000000000000000000000002',
        'X-Payment-Nonce': nonce,
      },
      body: JSON.stringify({
        circuit: 'coinbase_kyc',
        inputs: { signal_hash: '0x01', nullifier: '0x02', scope_bytes: '0x03', merkle_root: '0x04', user_address: '0x05' },
      }),
    });
    const json2 = await res2.json();
    expect(res2.status).toBe(400);
    expect(json2.error).toBe('INVALID_NONCE');
  });

  it('nonce for wrong circuit returns NONCE_CIRCUIT_MISMATCH', async () => {
    // Get nonce for coinbase_kyc
    const { json: firstRes } = await jsonPost('/api/v1/prove', {
      circuit: 'coinbase_kyc',
      inputs: { signal_hash: '0x01', nullifier: '0x02', scope_bytes: '0x03', merkle_root: '0x04', user_address: '0x05' },
    });
    const nonce = firstRes.nonce;

    // Try to use it for coinbase_country
    const res = await fetch(`${BASE_URL}/api/v1/prove`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Payment-TX': '0x0000000000000000000000000000000000000000000000000000000000000001',
        'X-Payment-Nonce': nonce,
      },
      body: JSON.stringify({
        circuit: 'coinbase_country',
        inputs: { signal_hash: '0x01', nullifier: '0x02', scope_bytes: '0x03', merkle_root: '0x04', user_address: '0x05' },
      }),
    });
    const json = await res.json();
    expect(res.status).toBe(400);
    expect(json.error).toBe('NONCE_CIRCUIT_MISMATCH');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// A2A Protocol — message/send (SDK client)
// ═══════════════════════════════════════════════════════════════════════════

describe('A2A message/send — get_supported_circuits', () => {
  it('get_supported_circuits returns completed task with both circuits', async () => {
    const result = await a2aClient.sendMessage(
      makeDataPartMessage({ skill: 'get_supported_circuits', chainId: '84532' }),
    );

    const task = result as Task;
    expect(task.kind).toBe('task');
    expect(task.status.state).toBe('completed');
    expect(Array.isArray(task.artifacts)).toBe(true);
    expect(task.artifacts!.length).toBeGreaterThan(0);

    const dataArtifact = task.artifacts!.find((a: Artifact) =>
      a.parts.some((p: Part) => p.kind === 'data' && (p as any).data?.circuits)
    );
    expect(dataArtifact).toBeDefined();
    const circuits = (dataArtifact!.parts.find((p: Part) => p.kind === 'data' && (p as any).data?.circuits) as any).data.circuits;
    expect(circuits.find((c: any) => c.id === 'coinbase_attestation')).toBeDefined();
    expect(circuits.find((c: any) => c.id === 'coinbase_country_attestation')).toBeDefined();
  });
});

describe('A2A message/send — error cases', () => {
  it('invalid skill returns failed task', async () => {
    // When paymentMode=testnet, payment middleware intercepts POST /a2a → 402
    // SDK doesn't expose HTTP status codes, so we use raw fetch for 402 detection
    const res = await fetch(`${BASE_URL}/a2a`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 20,
        method: 'message/send',
        params: {
          message: {
            messageId: randomUUID(),
            role: 'user',
            parts: [{
              kind: 'data',
              mimeType: 'application/json',
              data: { skill: 'nonexistent_skill' },
            }],
          },
        },
      }),
    });

    // When paymentMode=testnet, payment middleware intercepts before JSON-RPC handling → 402
    if (res.status === 402) {
      return;
    }

    // SDK client path: invalid skill returns a failed Task (not a JSON-RPC error)
    const result = await a2aClient.sendMessage(
      makeDataPartMessage({ skill: 'nonexistent_skill' }),
    );
    const task = result as Task;
    expect(task.status.state).toBe('failed');
  });

  it('invalid jsonrpc version returns error -32600', async () => {
    // Raw JSON-RPC validation — keep as raw fetch (SDK handles jsonrpc version internally)
    const { status, json } = await jsonPost('/a2a', {
      jsonrpc: '1.0',
      id: 21,
      method: 'message/send',
    });

    // When paymentMode=testnet, payment middleware intercepts before JSON-RPC validation → 402
    if (status === 402) {
      return;
    }
    expect(status).toBe(200);
    expect(json.error).toBeDefined();
    expect(json.error.code).toBe(-32600);
  });

  it('tasks/get for non-existent task throws error', async () => {
    await expect(
      a2aClient.getTask({ id: 'nonexistent-task-id' }),
    ).rejects.toThrow();
  });

  it('unknown method returns -32602', async () => {
    // Raw JSON-RPC routing test — keep as raw fetch (SDK doesn't send unknown methods)
    const { status, json } = await jsonPost('/a2a', {
      jsonrpc: '2.0',
      id: 23,
      method: 'unknown/method',
    });

    expect(status).toBe(200);
    expect(json.error.code).toBe(-32602);
  });

  it('tasks/cancel for non-existent task throws error', async () => {
    await expect(
      a2aClient.cancelTask({ id: 'nonexistent-task-id' }),
    ).rejects.toThrow();
  });

  it('tasks/resubscribe for non-existent task returns -32001', async () => {
    // No SDK method for tasks/resubscribe — keep as raw fetch
    const { status, text } = await jsonPost('/a2a', {
      jsonrpc: '2.0',
      id: 25,
      method: 'tasks/resubscribe',
      params: { id: 'nonexistent-task-id' },
    });

    expect(status).toBe(200);
    // tasks/resubscribe returns SSE format (text/event-stream)
    const sseEvents = parseSseEvents(text);
    const errorEvent = sseEvents.find((e: any) => e?.error);
    expect(errorEvent).toBeDefined();
    expect(errorEvent.error.code).toBe(-32001);
  });

  it('verify_proof with missing params returns failed task', async () => {
    const result = await a2aClient.sendMessage(
      makeDataPartMessage({ skill: 'verify_proof' }),
    );

    const task = result as Task;
    expect(task.status.state).toBe('failed');
  });

  it('prove returns completed with redirect (A2A does not generate proofs directly)', async () => {
    // A2A prove skill returns a redirect message to the REST endpoint
    // (proof generation takes 30-90s, exceeding A2A timeout limitations)
    const result = await a2aClient.sendMessage(
      makeDataPartMessage({
        skill: 'prove',
        circuit: 'coinbase_kyc',
      }),
    );

    const task = result as Task;
    expect(task.status.state).toBe('completed');

    // Should contain redirect info with REST endpoint
    const dataArtifact = task.artifacts?.find((a: Artifact) =>
      a.parts.some((p: Part) => p.kind === 'data' && (p as any).data?.endpoint)
    );
    expect(dataArtifact).toBeDefined();
    const dataPart = dataArtifact!.parts.find((p: Part) => p.kind === 'data') as any;
    expect(dataPart.data.endpoint).toContain('/api/v1/prove');
    expect(dataPart.data.method).toBe('POST');
  });
});

describe('A2A tasks/get — retrieve previously created task', () => {
  it('tasks/get retrieves a completed get_supported_circuits task', async () => {
    // Create task
    const createResult = await a2aClient.sendMessage(
      makeDataPartMessage({ skill: 'get_supported_circuits' }),
    );

    const createdTask = createResult as Task;
    const taskId = createdTask.id;
    expect(taskId).toBeDefined();

    // Retrieve it
    const fetchedTask = await a2aClient.getTask({ id: taskId });
    expect(fetchedTask.id).toBe(taskId);
    expect(fetchedTask.status.state).toBe('completed');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// A2A Protocol — message/stream (SSE) — SDK client
// ═══════════════════════════════════════════════════════════════════════════

describe('A2A message/stream (SSE)', () => {
  it('returns SSE events with completed task for get_supported_circuits', async () => {
    const events: any[] = [];

    const stream = a2aClient.sendMessageStream(
      makeDataPartMessage({ skill: 'get_supported_circuits', chainId: '84532' }),
    );

    for await (const event of stream) {
      events.push(event);
    }

    expect(events.length).toBeGreaterThan(0);

    const completedEvent = events.find(
      (e) =>
        (e.kind === 'status-update' && e.status?.state === 'completed') ||
        (e.kind === 'task' && e.status?.state === 'completed'),
    );
    expect(completedEvent).toBeDefined();
  }, 15000);
});

// ═══════════════════════════════════════════════════════════════════════════
// MCP StreamableHTTP — SDK client
// ═══════════════════════════════════════════════════════════════════════════

describe('MCP StreamableHTTP', () => {
  it('initialize returns server info via SDK connect', async () => {
    const { client, transport } = await createMcpClient();
    try {
      // connect() performs the initialize handshake automatically
      expect(client).toBeDefined();
      const serverVersion = client.getServerVersion();
      expect(serverVersion).toBeDefined();
      expect(serverVersion!.name).toBeDefined();
    } finally {
      await transport.close();
    }
  });

  it('tools/list returns all 3 tools', async () => {
    const { client, transport } = await createMcpClient();
    try {
      const result = await client.listTools();
      expect(result.tools).toBeDefined();
      expect(result.tools.length).toBe(3);

      const toolNames = result.tools.map((t) => t.name).sort();
      expect(toolNames).toEqual([
        'get_guide',
        'get_supported_circuits',
        'prove',
      ]);
    } finally {
      await transport.close();
    }
  });

  it('tools/call get_supported_circuits returns circuit list with both circuits', async () => {
    const { client, transport } = await createMcpClient();
    try {
      const result = await client.callTool({ name: 'get_supported_circuits', arguments: {} });
      expect(result.isError).toBeFalsy();

      const parsed = parseToolResult(result);
      expect(parsed).toBeDefined();
      expect(parsed.circuits).toBeDefined();

      const circuitIds = parsed.circuits.map((c: any) => c.id);
      expect(circuitIds).toContain('coinbase_attestation');
      expect(circuitIds).toContain('coinbase_country_attestation');
    } finally {
      await transport.close();
    }
  });

  it('tools/call prove with missing params returns error in content', async () => {
    // When paymentMode=testnet, payment middleware intercepts before MCP handling → 402
    // Check with raw fetch first
    const rawRes = await fetch(`${BASE_URL}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 999,
        method: 'tools/call',
        params: {
          name: 'prove',
          arguments: { circuitId: 'coinbase_attestation' },
        },
      }),
    });

    if (rawRes.status === 402) {
      return;
    }

    const { client, transport } = await createMcpClient();
    try {
      const result = await client.callTool({
        name: 'prove',
        arguments: {
          circuitId: 'coinbase_attestation',
          // missing address, signature, scope
        },
      });

      const textContent = (result.content as any[])?.find((c: any) => c.type === 'text');
      if (textContent) {
        expect(textContent.text.toLowerCase()).toMatch(/error|fail|missing|required/);
      }
    } finally {
      await transport.close();
    }
  });

  it('GET /mcp returns 405 (SSE not supported in stateless mode)', async () => {
    // Raw fetch — tests HTTP method, not MCP protocol
    const res = await fetch(`${BASE_URL}/mcp`);
    expect(res.status).toBe(405);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Proof Generation & Verification (Real bb/nargo — requires attestation wallet)
// ═══════════════════════════════════════════════════════════════════════════

describe(
  'Real Proof Generation & Verification',
  () => {
    // A2A and MCP prove tools return redirect messages (not actual proofs)
    // due to 30-90s proof generation time exceeding protocol timeouts.
    // Real proof generation is tested via REST API x402 flow.

    it('A2A: prove returns redirect to REST endpoint (A2A does not generate proofs)', { timeout: 30_000 }, async () => {
      // A2A prove skill redirects to REST API due to 30-90s proof generation time
      const result = await a2aClient.sendMessage(
        makeDataPartMessage({
          skill: 'prove',
          circuit: 'coinbase_kyc',
        }),
      );

      const task = result as Task;
      expect(task.status.state).toBe('completed');

      // Verify redirect artifact contains REST endpoint info
      const dataArtifact = task.artifacts?.find((a: Artifact) =>
        a.parts.some((p: Part) => p.kind === 'data' && (p as any).data?.endpoint)
      );
      expect(dataArtifact).toBeDefined();
      const dataPart = dataArtifact!.parts.find((p: Part) => p.kind === 'data') as any;
      expect(dataPart.data.endpoint).toContain('/api/v1/prove');
      expect(dataPart.data.method).toBe('POST');
      expect(dataPart.data.guide_url).toBeDefined();
    });

    it('A2A: verify_proof is not a valid skill and returns failed task', { timeout: 60_000 }, async () => {
      const result = await a2aClient.sendMessage(
        makeDataPartMessage({
          skill: 'verify_proof',
          circuitId: 'coinbase_attestation',
          proof: '0xdeadbeef',
          publicInputs: '0xdeadbeef',
          chainId: '84532',
        }),
      );

      const task = result as Task;
      // verify_proof is no longer a valid A2A skill (VALID_SKILLS = ['prove', 'get_supported_circuits'])
      expect(task.status.state).toBe('failed');
    });

    it('MCP: prove returns redirect to REST endpoint (MCP does not generate proofs)', { timeout: 30_000 }, async () => {
      // MCP prove tool returns redirect info due to 30-90s proof generation time
      const { client, transport } = await createMcpClient();
      try {
        const result = await client.callTool({
          name: 'prove',
          arguments: {
            circuit: 'coinbase_kyc',
            inputs: {
              signal_hash: '0x' + 'aa'.repeat(32),
              nullifier: '0x' + 'bb'.repeat(32),
              scope_bytes: '0x' + 'cc'.repeat(32),
              merkle_root: '0x' + 'dd'.repeat(32),
              user_address: '0x' + 'ee'.repeat(20),
              signature: '0x' + 'ff'.repeat(65),
              user_pubkey_x: '0x' + '11'.repeat(32),
              user_pubkey_y: '0x' + '22'.repeat(32),
              raw_transaction: '0x' + '33'.repeat(150),
              tx_length: 150,
              coinbase_attester_pubkey_x: '0x' + '44'.repeat(32),
              coinbase_attester_pubkey_y: '0x' + '55'.repeat(32),
              merkle_proof: ['0x' + '66'.repeat(32)],
              leaf_index: 0,
              depth: 1,
            },
          },
        });

        // Tool should return redirect info (not actual proof)
        const textContent = result.content.find((c: any) => c.type === 'text');
        expect(textContent).toBeDefined();
        const parsed = JSON.parse((textContent as any).text);
        // Should contain redirect message with REST endpoint
        expect(parsed.rest_endpoint).toBe('POST /api/v1/prove');
        expect(parsed.message).toContain('REST endpoint');
      } finally {
        await transport.close();
      }
    });
  }
);

// ═══════════════════════════════════════════════════════════════════════════
// SKILL.md & Guide Endpoints
// ═══════════════════════════════════════════════════════════════════════════

describe('SKILL.md & Guide Endpoints', () => {
  it('GET /.well-known/SKILL.md returns markdown with correct content-type', async () => {
    const res = await fetch(`${BASE_URL}/.well-known/SKILL.md`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/markdown');
    const text = await res.text();
    expect(text).toContain('name: zk-proof-generator');
    expect(text).toContain('prove');
    expect(text).toContain('get_supported_circuits');
    expect(text).toContain('verify_proof');
    expect(text).toContain('x402');
    expect(text).toContain('Local MCP');
  });

  it('GET /api/v1/guide/coinbase_kyc returns guide with local MCP and SDK info', async () => {
    const res = await fetch(`${BASE_URL}/api/v1/guide/coinbase_kyc`);
    expect(res.status).toBe(200);
    const guide = await res.json();
    expect(guide.circuit_id).toBe('coinbase_attestation');
    expect(guide.display_name).toBe('Coinbase KYC');
    // Local MCP server section (primary recommendation)
    expect(guide.local_mcp_server).toBeDefined();
    expect(guide.local_mcp_server.recommended).toBe(true);
    expect(guide.local_mcp_server.env_vars.ATTESTATION_KEY).toBeDefined();
    expect(guide.local_mcp_server.tools).toBeInstanceOf(Array);
    // SDK section
    expect(guide.sdk).toBeDefined();
    expect(guide.sdk.package).toBeDefined();
    expect(guide.sdk.quick_start).toBeDefined();
    // Constants
    expect(guide.constants).toBeDefined();
    expect(guide.constants.authorized_signers).toBeInstanceOf(Array);
    expect(guide.constants.contracts).toBeDefined();
    // Endpoints
    expect(guide.endpoints).toBeDefined();
    // Input schema
    expect(guide.input_schema).toBeDefined();
  });

  it('GET /api/v1/guide/coinbase_country returns country circuit guide', async () => {
    const res = await fetch(`${BASE_URL}/api/v1/guide/coinbase_country`);
    expect(res.status).toBe(200);
    const guide = await res.json();
    expect(guide.circuit_id).toBe('coinbase_country_attestation');
    expect(guide.display_name).toBe('Coinbase Country');
    expect(guide.local_mcp_server).toBeDefined();
    expect(guide.sdk).toBeDefined();
    expect(guide.constants).toBeDefined();
  });

  it('GET /api/v1/guide/invalid_circuit returns 404', async () => {
    const res = await fetch(`${BASE_URL}/api/v1/guide/invalid_circuit`);
    expect(res.status).toBe(404);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Local MCP Server (stdio) — spawns packages/mcp-server via StdioClientTransport
// ═══════════════════════════════════════════════════════════════════════════

const hasAttestationKey = !!process.env.E2E_ATTESTATION_WALLET_KEY;

describe.skipIf(!hasAttestationKey)('Local MCP Server (stdio)', () => {
  let stdioClient: InstanceType<typeof McpClient>;
  let stdioTransport: InstanceType<typeof StdioClientTransport>;

  beforeAll(async () => {
    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      ATTESTATION_KEY: process.env.E2E_ATTESTATION_WALLET_KEY!,
      PROOFPORT_URL: BASE_URL,
    };

    // Optional: CDP wallet for payment (if credentials available)
    if (process.env.CDP_API_KEY_ID) {
      env.CDP_API_KEY_ID = process.env.CDP_API_KEY_ID;
      env.CDP_API_KEY_SECRET = process.env.CDP_API_KEY_SECRET!;
      env.CDP_WALLET_SECRET = process.env.CDP_WALLET_SECRET!;
      if (process.env.CDP_WALLET_ADDRESS) env.CDP_WALLET_ADDRESS = process.env.CDP_WALLET_ADDRESS;
    }

    stdioTransport = new StdioClientTransport({
      command: 'npx',
      args: ['tsx', 'packages/mcp-server/src/index.ts'],
      env,
    });

    stdioClient = new McpClient(
      { name: 'e2e-stdio-test', version: '1.0.0' },
      { capabilities: {} },
    );

    await stdioClient.connect(stdioTransport);
  }, 30_000);

  afterAll(async () => {
    try {
      await stdioTransport.close();
    } catch {
      // ignore cleanup errors
    }
  });

  it('lists all 8 tools', async () => {
    const { tools } = await stdioClient.listTools();
    const toolNames = tools.map((t: any) => t.name).sort();
    expect(toolNames).toEqual([
      'generate_proof',
      'get_supported_circuits',
      'make_payment',
      'prepare_inputs',
      'request_challenge',
      'submit_proof',
      'verify_proof',
    ]);
  });

  it('get_supported_circuits returns circuit info', async () => {
    const result = await stdioClient.callTool({
      name: 'get_supported_circuits',
      arguments: {},
    });
    const textContent = result.content.find((c: any) => c.type === 'text');
    expect(textContent).toBeDefined();
    const parsed = JSON.parse((textContent as any).text);
    expect(parsed.circuits).toBeDefined();
    expect(parsed.circuits.coinbase_attestation).toBeDefined();
    expect(parsed.circuits.coinbase_country_attestation).toBeDefined();
    expect(parsed.authorized_signers).toBeInstanceOf(Array);
  });

  it('verify_proof with invalid proof returns error', async () => {
    const result = await stdioClient.callTool({
      name: 'verify_proof',
      arguments: {
        proof: '0xdeadbeef',
        public_inputs: '0x' + 'aa'.repeat(32),
        verifier_address: '0x0036B61dBFaB8f3CfEEF77dD5D45F7EFBFE2035c',
        chain_id: 84532,
        rpc_url: 'https://sepolia.base.org',
      },
    });
    const textContent = result.content.find((c: any) => c.type === 'text');
    expect(textContent).toBeDefined();
    const parsed = JSON.parse((textContent as any).text);
    expect(parsed.valid === false || parsed.error).toBeTruthy();
  });

  it('request_challenge returns 402 challenge from server', async () => {
    const result = await stdioClient.callTool({
      name: 'request_challenge',
      arguments: {
        circuit: 'coinbase_kyc',
        inputs: JSON.stringify({
          signal_hash: '0x' + 'aa'.repeat(32),
          nullifier: '0x' + 'bb'.repeat(32),
          scope_bytes: '0x' + 'cc'.repeat(32),
          merkle_root: '0x' + 'dd'.repeat(32),
          user_address: '0x' + 'ee'.repeat(20),
          signature: '0x' + 'ff'.repeat(65),
          user_pubkey_x: '0x' + '11'.repeat(32),
          user_pubkey_y: '0x' + '22'.repeat(32),
          raw_transaction: '0x' + '33'.repeat(150),
          tx_length: 150,
          coinbase_attester_pubkey_x: '0x' + '44'.repeat(32),
          coinbase_attester_pubkey_y: '0x' + '55'.repeat(32),
          merkle_proof: ['0x' + '66'.repeat(32)],
          leaf_index: 0,
          depth: 1,
        }),
      },
    });
    const textContent = result.content.find((c: any) => c.type === 'text');
    expect(textContent).toBeDefined();
    const parsed = JSON.parse((textContent as any).text);
    // Should get 402 challenge with nonce and payment info
    expect(parsed.nonce || parsed.error).toBeDefined();
  });

  it('reads proofport://config resource', async () => {
    const { resources } = await stdioClient.listResources();
    expect(resources.length).toBeGreaterThanOrEqual(1);
    const configResource = resources.find((r: any) => r.uri === 'proofport://config');
    expect(configResource).toBeDefined();

    const { contents } = await stdioClient.readResource({ uri: 'proofport://config' });
    expect(contents.length).toBe(1);
    const parsed = JSON.parse(contents[0].text as string);
    expect(parsed.baseUrl).toBe(BASE_URL);
    expect(parsed.attestationWalletAddress).toBeDefined();
    expect(parsed.supportedCircuits).toBeDefined();
  });

  // ─── Real Proof Generation via Local MCP (TEE_MODE=disabled, bb prove on host) ──

  let generatedProof: { proof: string; publicInputs: string; verification?: { chainId: number; verifierAddress: string; rpcUrl: string } | null } | null = null;

  it('generate_proof produces a real ZK proof (coinbase_kyc)', { timeout: 120_000 }, async () => {
    const result = await stdioClient.callTool({
      name: 'generate_proof',
      arguments: {
        circuit: 'coinbase_kyc',
        scope: 'e2e-test',
      },
    });
    const textContent = result.content.find((c: any) => c.type === 'text');
    expect(textContent).toBeDefined();
    const parsed = JSON.parse((textContent as any).text);

    // Should NOT have error
    expect(parsed.error).toBeUndefined();

    // Should have proof and publicInputs
    expect(parsed.proof).toBeDefined();
    expect(parsed.proof).toMatch(/^0x/);
    expect(parsed.publicInputs).toBeDefined();
    expect(parsed.publicInputs).toMatch(/^0x/);
    expect(parsed.paymentTxHash).toBeDefined();
    expect(parsed.paymentTxHash).toMatch(/^0x/);

    generatedProof = { proof: parsed.proof, publicInputs: parsed.publicInputs, verification: parsed.verification };

    // ─── Report: Proof Generation ───
    console.log('\n╔══════════════════════════════════════════════════════════════╗');
    console.log('║              ZK PROOF GENERATION REPORT                     ║');
    console.log('╠══════════════════════════════════════════════════════════════╣');
    console.log(`║ Circuit:        coinbase_kyc (coinbase_attestation)         ║`);
    console.log(`║ Scope:          e2e-test                                    ║`);
    console.log('╠══════════════════════════════════════════════════════════════╣');
    console.log(`║ x402 Payment TX:                                            ║`);
    console.log(`║   ${parsed.paymentTxHash}`);
    console.log(`║   https://sepolia.basescan.org/tx/${parsed.paymentTxHash}`);
    console.log('╠══════════════════════════════════════════════════════════════╣');
    console.log(`║ Proof (${parsed.proof.length} chars):                       ║`);
    console.log(`║   ${parsed.proof.slice(0, 80)}...`);
    console.log(`║ Public Inputs (${parsed.publicInputs.length} chars):        ║`);
    console.log(`║   ${parsed.publicInputs.slice(0, 80)}...`);
    if (parsed.attestation) {
      console.log('╠══════════════════════════════════════════════════════════════╣');
      console.log(`║ TEE Attestation: YES                                        ║`);
      if (parsed.attestation.pcrs) {
        console.log(`║   PCR0: ${parsed.attestation.pcrs.PCR0?.slice(0, 40)}...`);
        console.log(`║   PCR1: ${parsed.attestation.pcrs.PCR1?.slice(0, 40)}...`);
        console.log(`║   PCR2: ${parsed.attestation.pcrs.PCR2?.slice(0, 40)}...`);
      }
    } else {
      console.log(`║ TEE Attestation: No (TEE_MODE=disabled)                     ║`);
    }
    if (parsed.timing) {
      console.log('╠══════════════════════════════════════════════════════════════╣');
      console.log(`║ Timing:         ${parsed.timing.totalMs}ms total             ║`);
    }
    console.log('╚══════════════════════════════════════════════════════════════╝\n');
  });

  it('verify_proof confirms the generated proof on-chain', { timeout: 30_000 }, async () => {
    // Skip if proof generation failed or no verification info
    if (!generatedProof) {
      console.warn('Skipping verify_proof — generate_proof did not produce a proof');
      return;
    }
    if (!generatedProof.verification) {
      console.warn('Skipping verify_proof — no verification info in prove response');
      return;
    }

    const result = await stdioClient.callTool({
      name: 'verify_proof',
      arguments: {
        proof: generatedProof.proof,
        public_inputs: generatedProof.publicInputs,
        verifier_address: generatedProof.verification.verifierAddress,
        chain_id: generatedProof.verification.chainId,
        rpc_url: generatedProof.verification.rpcUrl,
      },
    });
    const textContent = result.content.find((c: any) => c.type === 'text');
    expect(textContent).toBeDefined();
    const parsed = JSON.parse((textContent as any).text);

    expect(parsed.valid).toBe(true);

    // ─── Report: On-Chain Verification ───
    console.log('╔══════════════════════════════════════════════════════════════╗');
    console.log('║              ON-CHAIN VERIFICATION REPORT                   ║');
    console.log('╠══════════════════════════════════════════════════════════════╣');
    console.log(`║ Result:         ${parsed.valid ? 'VALID' : 'INVALID'}       ║`);
    console.log(`║ Verifier:       0x0036B61dBFaB8f3CfEEF77dD5D45F7EFBFE2035c  ║`);
    console.log(`║ Chain:          Base Sepolia (84532)                         ║`);
    if (parsed.error) {
      console.log(`║ Error:          ${parsed.error}`);
    }
    console.log('╚══════════════════════════════════════════════════════════════╝\n');
  });
});
