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
 *   - OpenAI: openai (OpenAI SDK)
 *
 * Raw fetch kept for: REST endpoints, discovery, status, signing, proofs,
 * payment, HTML pages, and edge cases testing raw JSON-RPC validation.
 *
 * Run: npx vitest run tests/e2e/endpoints.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { ethers } from 'ethers';
import { wrapFetchWithPaymentFromConfig } from '@x402/fetch';
import { ExactEvmScheme } from '@x402/evm';

// SDK clients
import { ClientFactory } from '@a2a-js/sdk/client';
import type { Client as A2AClient } from '@a2a-js/sdk/client';
import type { Task, Artifact, Part } from '@a2a-js/sdk';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import OpenAI from 'openai';

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

function findDataPart(artifacts: Artifact[] | undefined): any {
  if (!artifacts) return undefined;
  for (const artifact of artifacts) {
    const found = artifact.parts?.find((p: Part) => p.kind === 'data');
    if (found) return found;
  }
  return undefined;
}

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

function findTextPart(artifacts: Artifact[] | undefined): any {
  if (!artifacts) return undefined;
  for (const artifact of artifacts) {
    const found = artifact.parts?.find((p: Part) => p.kind === 'text');
    if (found) return found;
  }
  return undefined;
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

async function signForProof(walletKey: string, address: string, scope: string, circuitId: string) {
  const { ethers } = await import('ethers');
  const wallet = new ethers.Wallet(walletKey);
  const signalPreimage = ethers.solidityPacked(
    ['address', 'string', 'string'],
    [address, scope, circuitId],
  );
  const signalHash = ethers.getBytes(ethers.keccak256(signalPreimage));
  const signature = await wallet.signMessage(signalHash);
  return signature;
}

// ─── SDK Client Instances ────────────────────────────────────────────────────

let a2aClient: A2AClient;
let openaiClient: OpenAI;

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

  // Create OpenAI SDK client
  openaiClient = new OpenAI({
    apiKey: 'test-key',
    baseURL: `${BASE_URL}/v1`,
  });
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

  it('GET /.well-known/agent-card.json returns A2A agent card with 6 skills', async () => {
    const { status, json } = await jsonGet('/.well-known/agent-card.json');
    expect(status).toBe(200);
    expect(json.name).toBe('proveragent.eth');
    expect(json.protocolVersion).toBe('0.3.0');
    expect(Array.isArray(json.skills)).toBe(true);
    expect(json.skills.length).toBe(6);
    const skillIds = json.skills.map((s: any) => s.id).sort();
    expect(skillIds).toEqual([
      'check_status',
      'generate_proof',
      'get_supported_circuits',
      'request_payment',
      'request_signing',
      'verify_proof',
    ]);
  });

  it('GET /.well-known/agent.json returns OASF agent descriptor', async () => {
    const { status, json } = await jsonGet('/.well-known/agent.json');
    expect(status).toBe(200);
    expect(json.name).toBeDefined();
    expect(json.name).toBe('proveragent.eth');
    expect(Array.isArray(json.skills)).toBe(true);
  });

  it('GET /.well-known/mcp.json returns MCP server metadata with 6 tools', async () => {
    const { status, json } = await jsonGet('/.well-known/mcp.json');
    expect(status).toBe(200);
    expect(json.serverInfo).toBeDefined();
    expect(json.serverInfo.name).toBeDefined();
    expect(Array.isArray(json.tools)).toBe(true);
    expect(json.tools.length).toBe(6);
    const toolNames = json.tools.map((t: any) => t.name).sort();
    expect(toolNames).toEqual([
      'check_status',
      'generate_proof',
      'get_supported_circuits',
      'request_payment',
      'request_signing',
      'verify_proof',
    ]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Status Endpoints (raw fetch — custom REST)
// ═══════════════════════════════════════════════════════════════════════════

describe('Status Endpoints', () => {
  it('GET /payment/status returns mode', async () => {
    const { status, json } = await jsonGet('/payment/status');
    expect(status).toBe(200);
    expect(json.mode).toBeDefined();
    expect(['disabled', 'testnet', 'mainnet']).toContain(json.mode);
  });

  it('GET /signing/status returns provider info', async () => {
    const { status, json } = await jsonGet('/signing/status');
    expect(status).toBe(200);
    expect(json.providers).toBeDefined();
  });

  it('GET /tee/status returns mode', async () => {
    const { status, json } = await jsonGet('/tee/status');
    expect(status).toBe(200);
    expect(json.mode).toBeDefined();
  });

  it('GET /identity/status returns erc8004 config', async () => {
    const { status, json } = await jsonGet('/identity/status');
    expect(status).toBe(200);
    expect(json.erc8004).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// REST API — Circuits (raw fetch — custom REST)
// ═══════════════════════════════════════════════════════════════════════════

describe('REST API — Circuits', () => {
  it('GET /api/v1/circuits returns both canonical circuits', async () => {
    const { status, json } = await jsonGet('/api/v1/circuits');
    expect(status).toBe(200);
    expect(Array.isArray(json.circuits)).toBe(true);
    expect(json.circuits.length).toBeGreaterThanOrEqual(2);

    const ids = json.circuits.map((c: any) => c.id);
    expect(ids).toContain('coinbase_attestation');
    expect(ids).toContain('coinbase_country_attestation');

    // Each circuit entry has required fields
    const kyc = json.circuits.find((c: any) => c.id === 'coinbase_attestation');
    expect(kyc.displayName).toBeDefined();
    expect(kyc.description).toBeDefined();
    expect(Array.isArray(kyc.requiredInputs)).toBe(true);
  });

  it('GET /api/v1/circuits with chainId query param returns verifier addresses', async () => {
    const res = await fetch(`${BASE_URL}/api/v1/circuits?chainId=84532`);
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(Array.isArray(json.circuits)).toBe(true);
    expect(json.chainId).toBe('84532');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// REST API — Signing Session (raw fetch — custom REST)
// ═══════════════════════════════════════════════════════════════════════════

describe('REST API — Signing Session', () => {
  // Shared state across sequential signing tests
  let createdRequestId: string;

  it('POST /api/v1/signing with valid body returns requestId, signingUrl, expiresAt', async () => {
    const { status, json } = await jsonPost('/api/v1/signing', {
      circuitId: 'coinbase_attestation',
      scope: 'e2e-test.zkproofport.app',
    });

    expect(status).toBe(200);
    expect(typeof json.requestId).toBe('string');
    expect(json.requestId.length).toBeGreaterThan(0);
    expect(typeof json.signingUrl).toBe('string');
    expect(json.signingUrl).toContain(json.requestId);
    expect(typeof json.expiresAt).toBe('string');
    expect(new Date(json.expiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(json.circuitId).toBe('coinbase_attestation');
    expect(json.scope).toBe('e2e-test.zkproofport.app');

    createdRequestId = json.requestId;
  });

  it('GET /api/v1/signing/:requestId/status with valid requestId returns phase: signing', async () => {
    expect(createdRequestId).toBeDefined();

    const { status, json } = await jsonGet(`/api/v1/signing/${createdRequestId}/status`);
    expect(status).toBe(200);
    expect(json.requestId).toBe(createdRequestId);
    expect(json.phase).toBe('signing');
    expect(json.signing).toBeDefined();
    expect(json.signing.status).toBe('pending');
    expect(json.expiresAt).toBeDefined();
  });

  it('POST /api/v1/signing/:requestId/payment before signing complete returns error or disabled message', async () => {
    expect(createdRequestId).toBeDefined();

    const { status, json } = await jsonPost(`/api/v1/signing/${createdRequestId}/payment`, {});
    // With paymentMode=disabled: returns message about payment not required
    // With paymentMode=testnet/mainnet: returns error about signing not complete
    expect([200, 400]).toContain(status);
    const text = JSON.stringify(json).toLowerCase();
    expect(text).toMatch(/sign|complet|pending|not required|disabled|payment/);
  });

  it('POST /api/v1/signing with missing circuitId returns 400', async () => {
    const { status, json } = await jsonPost('/api/v1/signing', {
      scope: 'e2e-test.zkproofport.app',
    });
    expect(status).toBe(400);
    expect(json.error).toBeDefined();
    expect(json.error).toContain('circuitId');
  });

  it('POST /api/v1/signing with unknown circuitId returns 400', async () => {
    const { status, json } = await jsonPost('/api/v1/signing', {
      circuitId: 'nonexistent_circuit',
      scope: 'e2e-test.zkproofport.app',
    });
    expect(status).toBe(400);
    expect(json.error).toBeDefined();
    expect(json.error).toMatch(/[Uu]nknown circuit/);
  });

  it('POST /api/v1/signing with empty scope returns 400', async () => {
    const { status, json } = await jsonPost('/api/v1/signing', {
      circuitId: 'coinbase_attestation',
      scope: '',
    });
    expect(status).toBe(400);
    expect(json.error).toBeDefined();
    expect(json.error).toContain('scope');
  });

  it('GET /api/v1/signing/:requestId/status with fake requestId returns 404', async () => {
    const { status, json } = await jsonGet('/api/v1/signing/fake-request-id-00000000/status');
    expect(status).toBe(404);
    expect(json.error).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// REST API — Proof Generation Validation (raw fetch — custom REST)
// ═══════════════════════════════════════════════════════════════════════════

describe('REST API — Proof Generation Validation', () => {
  it('POST /api/v1/proofs with no params returns 400', async () => {
    const { status, json } = await jsonPost('/api/v1/proofs', {});
    // When paymentMode=testnet, payment middleware intercepts before validation → 402
    expect([400, 402]).toContain(status);
    if (status === 400) {
      expect(json.error).toBeDefined();
    }
  });

  it('POST /api/v1/proofs with missing circuitId returns 400', async () => {
    const { status, json } = await jsonPost('/api/v1/proofs', {
      address: '0x' + 'aa'.repeat(20),
      signature: '0x' + 'bb'.repeat(65),
      scope: 'test.com',
    });
    // When paymentMode=testnet, payment middleware intercepts before validation → 402
    expect([400, 402]).toContain(status);
    if (status === 400) {
      expect(json.error).toBeDefined();
    }
  });

  it('POST /api/v1/proofs/verify with missing params returns 400', async () => {
    const { status, json } = await jsonPost('/api/v1/proofs/verify', {});
    expect(status).toBe(400);
    expect(json.error).toBeDefined();
  });

  it('GET /api/v1/proofs/:taskId returns 404 for non-existent task', async () => {
    const { status, json } = await jsonGet('/api/v1/proofs/nonexistent-task-id');
    expect(status).toBe(404);
    expect(json.error).toBeDefined();
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

describe('A2A message/send — request_signing + check_status (multi-turn)', () => {
  let a2aRequestId: string;

  it('request_signing returns requestId and signingUrl', async () => {
    const result = await a2aClient.sendMessage(
      makeDataPartMessage({
        skill: 'request_signing',
        circuitId: 'coinbase_attestation',
        scope: 'a2a-e2e-test.zkproofport.app',
      }),
    );

    const task = result as Task;
    expect(task.status.state).toBe('input-required');

    // Extract requestId and signingUrl from artifacts
    const data = extractDataFromArtifacts(task.artifacts);
    expect(data.requestId).toBeDefined();
    expect(data.signingUrl).toBeDefined();
    expect(data.signingUrl as string).toContain(data.requestId as string);
    a2aRequestId = data.requestId as string;
  });

  it('check_status for the created requestId returns phase: signing', async () => {
    expect(a2aRequestId).toBeDefined();

    const result = await a2aClient.sendMessage(
      makeDataPartMessage({ skill: 'check_status', requestId: a2aRequestId }),
    );

    const task = result as Task;
    expect(task.status.state).toBe('input-required');

    const data = extractDataFromArtifacts(task.artifacts);
    expect(data.phase).toBe('signing');
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

  it('generate_proof with unknown circuit returns failed task', async () => {
    // When paymentMode=testnet, payment middleware intercepts before the handler → 402
    // Check with raw fetch first to detect 402
    const rawRes = await fetch(`${BASE_URL}/a2a`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 27,
        method: 'message/send',
        params: {
          message: {
            messageId: randomUUID(),
            role: 'user',
            parts: [{
              kind: 'data',
              mimeType: 'application/json',
              data: {
                skill: 'generate_proof',
                circuitId: 'nonexistent_circuit',
                address: '0x' + 'aa'.repeat(20),
                signature: '0x' + 'bb'.repeat(65),
                scope: 'test.com',
              },
            }],
          },
        },
      }),
    });

    if (rawRes.status === 402) {
      return;
    }

    const result = await a2aClient.sendMessage(
      makeDataPartMessage({
        skill: 'generate_proof',
        circuitId: 'nonexistent_circuit',
        address: '0x' + 'aa'.repeat(20),
        signature: '0x' + 'bb'.repeat(65),
        scope: 'test.com',
      }),
    );

    const task = result as Task;
    expect(task.status.state).toBe('failed');
  });

  it('generate_proof with missing address and signature returns failed task', async () => {
    // When paymentMode=testnet, payment middleware intercepts before the handler → 402
    const rawRes = await fetch(`${BASE_URL}/a2a`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 28,
        method: 'message/send',
        params: {
          message: {
            messageId: randomUUID(),
            role: 'user',
            parts: [{
              kind: 'data',
              mimeType: 'application/json',
              data: {
                skill: 'generate_proof',
                circuitId: 'coinbase_attestation',
                scope: 'test.com',
              },
            }],
          },
        },
      }),
    });

    if (rawRes.status === 402) {
      return;
    }

    const result = await a2aClient.sendMessage(
      makeDataPartMessage({
        skill: 'generate_proof',
        circuitId: 'coinbase_attestation',
        scope: 'test.com',
        // missing address and signature
      }),
    );

    const task = result as Task;
    expect(task.status.state).toBe('failed');
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

  it('tools/list returns all 6 tools', async () => {
    const { client, transport } = await createMcpClient();
    try {
      const result = await client.listTools();
      expect(result.tools).toBeDefined();
      expect(result.tools.length).toBe(6);

      const toolNames = result.tools.map((t) => t.name).sort();
      expect(toolNames).toEqual([
        'check_status',
        'generate_proof',
        'get_supported_circuits',
        'request_payment',
        'request_signing',
        'verify_proof',
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

  it('tools/call request_signing returns signingUrl or error', async () => {
    const { client, transport } = await createMcpClient();
    try {
      const result = await client.callTool({
        name: 'request_signing',
        arguments: {
          circuitId: 'coinbase_attestation',
          scope: 'mcp-e2e-test.zkproofport.app',
        },
      });

      expect(result.content).toBeDefined();

      const textContent = (result.content as any[])?.find((c: any) => c.type === 'text');
      expect(textContent).toBeDefined();

      // Should contain requestId and signingUrl — try JSON parse first
      let parsed: any;
      try {
        parsed = JSON.parse(textContent.text);
      } catch {
        parsed = null;
      }

      if (result.isError || (parsed && parsed.error)) {
        // Tool returned an error (e.g., SIGN_PAGE_URL not configured)
        const errorText = parsed?.error || textContent.text;
        expect(errorText.toLowerCase()).toMatch(/sign|config|url/);
      } else if (parsed && parsed.requestId) {
        expect(parsed.requestId).toBeDefined();
        expect(parsed.signingUrl).toBeDefined();
        expect(typeof parsed.signingUrl).toBe('string');
      } else {
        // Plain text response — should mention signing or request
        expect(textContent.text.toLowerCase()).toMatch(/sign|request/);
      }
    } finally {
      await transport.close();
    }
  });

  it('tools/call generate_proof with missing params returns error in content', async () => {
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
          name: 'generate_proof',
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
        name: 'generate_proof',
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
// OpenAI Chat Completions — SDK client
// ═══════════════════════════════════════════════════════════════════════════

describe('OpenAI Chat Completions', () => {
  it('POST /v1/chat/completions responds (configured or 503 if no LLM key)', async () => {
    try {
      const completion = await openaiClient.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          { role: 'user', content: 'What ZK circuits do you support?' },
        ],
      });

      // 200 path: LLM configured — validate OpenAI-compatible response format
      expect(completion.id).toBeDefined();
      expect(Array.isArray(completion.choices)).toBe(true);
      expect(completion.choices.length).toBeGreaterThan(0);
      expect(completion.choices[0].message).toBeDefined();
      expect(completion.choices[0].message.role).toBe('assistant');
      expect(typeof completion.choices[0].message.content).toBe('string');
      expect(completion.model).toBeDefined();
      expect(completion.usage).toBeDefined();
    } catch (err: any) {
      // 503 path: chat not configured
      expect(err.status).toBe(503);
    }
  });

  it('POST /api/v1/chat returns 410 Gone (deprecated endpoint)', async () => {
    // Raw fetch — tests deprecated endpoint, not OpenAI protocol
    const { status, json } = await jsonPost('/api/v1/chat', {
      messages: [{ role: 'user', content: 'test' }],
    });
    expect(status).toBe(410);
    expect(json.error).toBeDefined();
    expect(json.error.type).toBe('gone');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Multi-Turn Flow Tests
// ═══════════════════════════════════════════════════════════════════════════

describe('Multi-Turn Flow — REST signing → check_status', () => {
  let flowRequestId: string;

  it('Step 1: POST /api/v1/signing creates a session', async () => {
    const { status, json } = await jsonPost('/api/v1/signing', {
      circuitId: 'coinbase_attestation',
      scope: 'multi-turn-test.zkproofport.app',
    });

    expect(status).toBe(200);
    expect(json.requestId).toBeDefined();
    expect(json.signingUrl).toBeDefined();
    expect(json.expiresAt).toBeDefined();
    flowRequestId = json.requestId;
  });

  it('Step 2: GET /api/v1/signing/:requestId/status returns signing phase', async () => {
    expect(flowRequestId).toBeDefined();

    const { status, json } = await jsonGet(`/api/v1/signing/${flowRequestId}/status`);
    expect(status).toBe(200);
    expect(json.requestId).toBe(flowRequestId);
    expect(json.phase).toBe('signing');
    expect(json.signing.status).toBe('pending');
  });

  it('Step 3: POST /api/v1/signing/:requestId/payment rejects (signing incomplete)', async () => {
    expect(flowRequestId).toBeDefined();

    const { status, json } = await jsonPost(`/api/v1/signing/${flowRequestId}/payment`, {});
    // Signing not complete — payment must be rejected
    expect(status).toBe(400);
    expect(json.error).toBeDefined();
  });
});

describe('Multi-Turn Flow — A2A request_signing → check_status', () => {
  let a2aFlowRequestId: string;

  it('Step 1: A2A request_signing for coinbase_country_attestation', async () => {
    const result = await a2aClient.sendMessage(
      makeDataPartMessage({
        skill: 'request_signing',
        circuitId: 'coinbase_country_attestation',
        scope: 'country-flow-test.zkproofport.app',
        countryList: ['US', 'CA'],
        isIncluded: true,
      }),
    );

    const task = result as Task;
    expect(task.status.state).toBe('input-required');

    const data = extractDataFromArtifacts(task.artifacts);
    expect(data.requestId).toBeDefined();
    a2aFlowRequestId = data.requestId as string;
  });

  it('Step 2: A2A check_status for same requestId shows phase: signing', async () => {
    expect(a2aFlowRequestId).toBeDefined();

    const result = await a2aClient.sendMessage(
      makeDataPartMessage({ skill: 'check_status', requestId: a2aFlowRequestId }),
    );

    const task = result as Task;
    expect(task.status.state).toBe('input-required');

    const data = extractDataFromArtifacts(task.artifacts);
    expect(data.phase).toBe('signing');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Signing Internal Endpoints (raw fetch — custom REST)
// ═══════════════════════════════════════════════════════════════════════════

describe('Signing Internal Endpoints', () => {
  it('GET /api/signing/:requestId returns 404 for non-existent requestId', async () => {
    const { status } = await jsonGet('/api/signing/nonexistent-id');
    expect(status).toBe(404);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Payment Endpoints (raw fetch — custom REST)
// ═══════════════════════════════════════════════════════════════════════════

describe('Payment Endpoints', () => {
  it('GET /api/payment/:requestId returns 404 for non-existent', async () => {
    const { status } = await jsonGet('/api/payment/nonexistent-id');
    expect(status).toBe(404);
  });

  it('GET /payment/status returns payment config', async () => {
    const { status, json } = await jsonGet('/payment/status');
    expect(status).toBe(200);
    expect(json.mode).toBeDefined();
    expect(['disabled', 'testnet', 'mainnet']).toContain(json.mode);
    expect(typeof json.requiresPayment).toBe('boolean');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// HTML Pages (raw fetch — custom REST)
// ═══════════════════════════════════════════════════════════════════════════

describe('HTML Pages', () => {
  it('GET /pay/:requestId returns HTML payment page', async () => {
    const res = await fetch(`${BASE_URL}/pay/test-request-id`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const body = await res.text();
    expect(body).toContain('<!DOCTYPE html');
  });

  it('GET /v/:proofId returns HTML verification page', async () => {
    const res = await fetch(`${BASE_URL}/v/test-proof-id`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const body = await res.text();
    expect(body).toContain('<!DOCTYPE html');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Proof Generation & Verification (Real bb/nargo — requires attestation wallet)
// ═══════════════════════════════════════════════════════════════════════════

const ATTESTATION_KEY = process.env.E2E_ATTESTATION_WALLET_KEY;
const ATTESTATION_ADDRESS = process.env.E2E_ATTESTATION_WALLET_ADDRESS;
const PAYER_KEY = process.env.E2E_PAYER_WALLET_KEY;

// Payment-wrapped helpers for proof generation when paymentMode=testnet
function makePayFetch(payerKey: string) {
  const payerWallet = new ethers.Wallet(payerKey);
  const signer = {
    address: payerWallet.address as `0x${string}`,
    signTypedData: async ({ domain, types, primaryType, message }: {
      domain: Record<string, unknown>;
      types: Record<string, unknown>;
      primaryType: string;
      message: Record<string, unknown>;
    }) => {
      const { EIP712Domain: _ignored, ...cleanTypes } = types as any;
      return payerWallet.signTypedData(domain as any, cleanTypes, message) as Promise<`0x${string}`>;
    },
  };
  return wrapFetchWithPaymentFromConfig(fetch, {
    schemes: [{
      network: 'eip155:84532',
      client: new ExactEvmScheme(signer),
    }],
  });
}

async function paidJsonPost(payFetch: typeof fetch, path: string, body: unknown) {
  const res = await payFetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: any;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: res.status, headers: res.headers, text, json };
}

describe.skipIf(!ATTESTATION_KEY || !ATTESTATION_ADDRESS)(
  'Real Proof Generation & Verification',
  () => {
    let generatedProof: string;
    let generatedPublicInputs: string;
    let paymentRequired = false;
    let payFetch: typeof fetch;

    beforeAll(async () => {
      const health = await fetch(`${BASE_URL}/health`).then(r => r.json());
      paymentRequired = health.paymentRequired === true;
      if (paymentRequired && PAYER_KEY) {
        payFetch = makePayFetch(PAYER_KEY);
      }
    });

    it('A2A: generate_proof produces a real proof', { timeout: 300_000 }, async (ctx) => {
      const scope = 'e2e-test.zkproofport.app';
      const signature = await signForProof(ATTESTATION_KEY!, ATTESTATION_ADDRESS!, scope, 'coinbase_attestation');

      // For paid requests, use raw fetch with payment wrapper (SDK doesn't support x402 headers)
      if (paymentRequired && payFetch) {
        const res = await payFetch(`${BASE_URL}/a2a`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 100,
            method: 'message/send',
            params: {
              message: {
                messageId: randomUUID(),
                role: 'user',
                parts: [{
                  kind: 'data',
                  mimeType: 'application/json',
                  data: {
                    skill: 'generate_proof',
                    circuitId: 'coinbase_attestation',
                    address: ATTESTATION_ADDRESS,
                    signature,
                    scope,
                  },
                }],
              },
            },
          }),
        });
        const text = await res.text();
        let json: any;
        try { json = JSON.parse(text); } catch { json = null; }

        // Skip if x402 facilitator settlement is unavailable
        if (res.status === 402 && json?.error === 'Settlement failed') {
          console.warn('x402 facilitator settlement failed — skipping (external dependency)');
          ctx.skip();
          return;
        }

        expect(res.status).toBe(200);
        expect(json.result).toBeDefined();
        expect(json.result.status.state).toBe('completed');

        const proofArtifact = json.result.artifacts?.find((a: any) =>
          a.parts.some((p: any) => p.kind === 'data' && p.data?.proof)
        );
        expect(proofArtifact).toBeDefined();

        const proofData = proofArtifact.parts.find((p: any) => p.data?.proof).data;
        generatedProof = proofData.proof;
        generatedPublicInputs = proofData.publicInputs;
      } else {
        // No payment required — use SDK client
        const result = await a2aClient.sendMessage(
          makeDataPartMessage({
            skill: 'generate_proof',
            circuitId: 'coinbase_attestation',
            address: ATTESTATION_ADDRESS,
            signature,
            scope,
          }),
        );

        const task = result as Task;
        expect(task.status.state).toBe('completed');

        const proofArtifact = task.artifacts?.find((a: Artifact) =>
          a.parts.some((p: Part) => p.kind === 'data' && (p as any).data?.proof)
        );
        expect(proofArtifact).toBeDefined();

        const proofPart = proofArtifact!.parts.find((p: Part) => p.kind === 'data' && (p as any).data?.proof) as any;
        generatedProof = proofPart.data.proof;
        generatedPublicInputs = proofPart.data.publicInputs;
      }

      expect(generatedProof).toBeDefined();
      expect(generatedProof.startsWith('0x')).toBe(true);
      expect(generatedPublicInputs).toBeDefined();
    });

    it('A2A: verify_proof validates the generated proof on-chain', { timeout: 60_000 }, async (ctx) => {
      if (!generatedProof) {
        ctx.skip();
        return;
      }

      const result = await a2aClient.sendMessage(
        makeDataPartMessage({
          skill: 'verify_proof',
          circuitId: 'coinbase_attestation',
          proof: generatedProof,
          publicInputs: generatedPublicInputs,
          chainId: '84532',
        }),
      );

      const task = result as Task;
      expect(task.status.state).toBe('completed');

      const verifyArtifact = task.artifacts?.find((a: Artifact) =>
        a.parts.some((p: Part) => p.kind === 'data' && (p as any).data?.valid !== undefined)
      );
      expect(verifyArtifact).toBeDefined();
      const verifyData = (verifyArtifact!.parts.find(
        (p: Part) => p.kind === 'data' && (p as any).data?.valid !== undefined,
      ) as any).data;
      expect(verifyData.valid).toBe(true);
    });

    it('MCP: generate_proof via tools/call', { timeout: 300_000 }, async (ctx) => {
      const scope = 'e2e-mcp-test.zkproofport.app';
      const signature = await signForProof(ATTESTATION_KEY!, ATTESTATION_ADDRESS!, scope, 'coinbase_attestation');

      // For paid requests, must use raw fetch with payment wrapper
      if (paymentRequired && payFetch) {
        const res = await payFetch(`${BASE_URL}/mcp`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json, text/event-stream',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 102,
            method: 'tools/call',
            params: {
              name: 'generate_proof',
              arguments: {
                circuitId: 'coinbase_attestation',
                address: ATTESTATION_ADDRESS,
                signature,
                scope,
              },
            },
          }),
        });

        if (res.status === 402) {
          const text = await res.text();
          let json: any;
          try { json = JSON.parse(text); } catch { json = null; }
          if (json?.error === 'Settlement failed') {
            console.warn('x402 facilitator settlement failed — skipping (external dependency)');
            ctx.skip();
            return;
          }
        }

        expect(res.status).toBe(200);
        const text = await res.text();
        const events = parseSseEvents(text);
        expect(events.length).toBeGreaterThan(0);

        const result = events[0];
        expect(result.result).toBeDefined();
        expect(result.result.content).toBeDefined();

        const textContent = result.result.content.find((c: any) => c.type === 'text');
        expect(textContent).toBeDefined();

        try {
          const parsed = JSON.parse(textContent.text);
          expect(parsed.proof).toBeDefined();
          expect(parsed.proof.startsWith('0x')).toBe(true);
        } catch {
          expect(textContent.text).toMatch(/proof|0x[0-9a-fA-F]{10,}/);
        }
      } else {
        // No payment required — use MCP SDK client
        const { client, transport } = await createMcpClient();
        try {
          const result = await client.callTool({
            name: 'generate_proof',
            arguments: {
              circuitId: 'coinbase_attestation',
              address: ATTESTATION_ADDRESS,
              signature,
              scope,
            },
          });

          expect(result.isError).toBeFalsy();
          const parsed = parseToolResult(result);
          expect(parsed).toBeDefined();
          expect(parsed.proof).toBeDefined();
          expect(parsed.proof.startsWith('0x')).toBe(true);
        } finally {
          await transport.close();
        }
      }
    });

    it('REST: POST /api/v1/proofs generates proof', { timeout: 300_000 }, async (ctx) => {
      const scope = 'e2e-rest-test.zkproofport.app';
      const signature = await signForProof(ATTESTATION_KEY!, ATTESTATION_ADDRESS!, scope, 'coinbase_attestation');

      const body = {
        circuitId: 'coinbase_attestation',
        address: ATTESTATION_ADDRESS,
        signature,
        scope,
      };

      let status: number;
      let json: any;

      if (paymentRequired && payFetch) {
        ({ status, json } = await paidJsonPost(payFetch, '/api/v1/proofs', body));
      } else {
        ({ status, json } = await jsonPost('/api/v1/proofs', body));
      }

      // Skip if x402 facilitator settlement is unavailable
      if (status === 402 && json?.error === 'Settlement failed') {
        console.warn('x402 facilitator settlement failed — skipping (external dependency)');
        ctx.skip();
        return;
      }

      expect(status).toBe(200);
      expect(json.proof).toBeDefined();
      expect(json.proof.startsWith('0x')).toBe(true);
    });

    it('REST: POST /api/v1/proofs/verify validates on-chain', { timeout: 60_000 }, async (ctx) => {
      if (!generatedProof) {
        ctx.skip();
        return;
      }

      let publicInputsArray: string[];
      if (Array.isArray(generatedPublicInputs)) {
        publicInputsArray = generatedPublicInputs;
      } else {
        const clean = generatedPublicInputs.startsWith('0x')
          ? generatedPublicInputs.slice(2)
          : generatedPublicInputs;
        publicInputsArray = [];
        for (let i = 0; i < clean.length; i += 64) {
          publicInputsArray.push('0x' + clean.slice(i, i + 64).padEnd(64, '0'));
        }
      }

      const { status, json } = await jsonPost('/api/v1/proofs/verify', {
        circuitId: 'coinbase_attestation',
        proof: generatedProof,
        publicInputs: publicInputsArray,
        chainId: '84532',
      });

      expect(status).toBe(200);
      expect(json.valid).toBe(true);
      expect(json.circuitId).toBe('coinbase_attestation');
    });
  }
);
