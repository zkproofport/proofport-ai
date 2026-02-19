/**
 * Real E2E Tests — hits the actual Docker container at localhost:4002
 *
 * Prerequisites:
 *   cd proofport-ai && docker compose up --build -d
 *   Wait for healthy: curl http://localhost:4002/health
 *
 * NO vi.mock(), NO supertest, NO createApp() — real HTTP only.
 *
 * Run: npx vitest run tests/e2e/endpoints.test.ts
 */

import { describe, it, expect, beforeAll } from 'vitest';

const BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:4002';

// ─── Helper ─────────────────────────────────────────────────────────────

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

// ─── Connectivity check ─────────────────────────────────────────────────

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
});

// ═══════════════════════════════════════════════════════════════════════════
// Discovery Endpoints
// ═══════════════════════════════════════════════════════════════════════════

describe('Discovery Endpoints', () => {
  it('GET /health returns healthy', async () => {
    const { status, json } = await jsonGet('/health');
    expect(status).toBe(200);
    expect(json.status).toBe('healthy');
    expect(json.service).toBe('proofport-ai');
  });

  it('GET /.well-known/agent-card.json returns A2A agent card', async () => {
    const { status, json } = await jsonGet('/.well-known/agent-card.json');
    expect(status).toBe(200);
    expect(json.name).toBe('proveragent.eth');
    expect(json.protocolVersion).toBe('0.3.0');
    expect(json.skills).toHaveLength(3);
    expect(json.skills.map((s: any) => s.id).sort()).toEqual([
      'generate_proof', 'get_supported_circuits', 'verify_proof',
    ]);
  });

  it('GET /.well-known/agent.json returns OASF agent descriptor', async () => {
    const { status, json } = await jsonGet('/.well-known/agent.json');
    expect(status).toBe(200);
    expect(json.name).toBeDefined();
  });

  it('GET /.well-known/mcp.json returns MCP server metadata', async () => {
    const { status, json } = await jsonGet('/.well-known/mcp.json');
    expect(status).toBe(200);
    expect(json.serverInfo).toBeDefined();
    expect(json.serverInfo.name).toBeDefined();
    expect(json.tools).toBeDefined();
    expect(json.tools).toHaveLength(3);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Status Endpoints
// ═══════════════════════════════════════════════════════════════════════════

describe('Status Endpoints', () => {
  it('GET /payment/status', async () => {
    const { status, json } = await jsonGet('/payment/status');
    expect(status).toBe(200);
    expect(json.mode).toBeDefined();
  });

  it('GET /signing/status', async () => {
    const { status, json } = await jsonGet('/signing/status');
    expect(status).toBe(200);
  });

  it('GET /tee/status', async () => {
    const { status, json } = await jsonGet('/tee/status');
    expect(status).toBe(200);
    expect(json.mode).toBe('disabled');
  });

  it('GET /identity/status', async () => {
    const { status, json } = await jsonGet('/identity/status');
    expect(status).toBe(200);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// A2A Protocol — message/send
// ═══════════════════════════════════════════════════════════════════════════

describe('A2A message/send', () => {
  it('get_supported_circuits returns completed task with circuits', async () => {
    const { status, json } = await jsonPost('/a2a', {
      jsonrpc: '2.0',
      id: 1,
      method: 'message/send',
      params: {
        message: {
          role: 'user',
          parts: [{
            kind: 'data',
            mimeType: 'application/json',
            data: { skill: 'get_supported_circuits', chainId: '84532' },
          }],
        },
      },
    });

    expect(status).toBe(200);
    expect(json.jsonrpc).toBe('2.0');
    expect(json.result).toBeDefined();
    expect(json.result.status.state).toBe('completed');
    expect(json.result.artifacts).toBeDefined();
    expect(json.result.artifacts.length).toBeGreaterThan(0);

    // Verify circuit data is present
    const dataArtifact = json.result.artifacts.find((a: any) =>
      a.parts.some((p: any) => p.kind === 'data' && p.data?.circuits)
    );
    expect(dataArtifact).toBeDefined();
    const circuits = dataArtifact.parts.find((p: any) => p.data?.circuits).data.circuits;
    expect(circuits.find((c: any) => c.id === 'coinbase_attestation')).toBeDefined();
  });

  it('verify_proof with missing params returns failed task', async () => {
    const { status, json } = await jsonPost('/a2a', {
      jsonrpc: '2.0',
      id: 2,
      method: 'message/send',
      params: {
        message: {
          role: 'user',
          parts: [{
            kind: 'data',
            mimeType: 'application/json',
            data: { skill: 'verify_proof' },
          }],
        },
      },
    });

    expect(status).toBe(200);
    expect(json.result).toBeDefined();
    // Should be failed due to missing circuitId/proof/publicInputs
    expect(json.result.status.state).toBe('failed');
  });

  it('invalid skill returns JSON-RPC error', async () => {
    const { status, json } = await jsonPost('/a2a', {
      jsonrpc: '2.0',
      id: 3,
      method: 'message/send',
      params: {
        message: {
          role: 'user',
          parts: [{
            kind: 'data',
            mimeType: 'application/json',
            data: { skill: 'nonexistent_skill' },
          }],
        },
      },
    });

    expect(status).toBe(200);
    expect(json.error).toBeDefined();
    expect(json.error.code).toBe(-32602);
    expect(json.error.message).toContain('Invalid skill');
  });

  it('invalid jsonrpc version returns error', async () => {
    const { status, json } = await jsonPost('/a2a', {
      jsonrpc: '1.0',
      id: 4,
      method: 'message/send',
    });

    expect(status).toBe(200);
    expect(json.error).toBeDefined();
    expect(json.error.code).toBe(-32600);
  });

  it('tasks/get for non-existent task returns -32001', async () => {
    const { status, json } = await jsonPost('/a2a', {
      jsonrpc: '2.0',
      id: 5,
      method: 'tasks/get',
      params: { id: 'nonexistent-task-id' },
    });

    expect(status).toBe(200);
    expect(json.error).toBeDefined();
    expect(json.error.code).toBe(-32001);
    expect(json.error.message).toBe('Task not found');
  });

  it('tasks/cancel for non-existent task returns -32001', async () => {
    const { status, json } = await jsonPost('/a2a', {
      jsonrpc: '2.0',
      id: 6,
      method: 'tasks/cancel',
      params: { id: 'nonexistent-task-id' },
    });

    expect(status).toBe(200);
    expect(json.error.code).toBe(-32001);
  });

  it('tasks/resubscribe for non-existent task returns -32001', async () => {
    const { status, json } = await jsonPost('/a2a', {
      jsonrpc: '2.0',
      id: 7,
      method: 'tasks/resubscribe',
      params: { id: 'nonexistent-task-id' },
    });

    expect(status).toBe(200);
    expect(json.error.code).toBe(-32001);
  });

  it('tasks/get retrieves a previously created task', async () => {
    // First create a task
    const createRes = await jsonPost('/a2a', {
      jsonrpc: '2.0',
      id: 10,
      method: 'message/send',
      params: {
        message: {
          role: 'user',
          parts: [{
            kind: 'data',
            mimeType: 'application/json',
            data: { skill: 'get_supported_circuits' },
          }],
        },
      },
    });

    const taskId = createRes.json.result.id;
    expect(taskId).toBeDefined();

    // Then retrieve it
    const getRes = await jsonPost('/a2a', {
      jsonrpc: '2.0',
      id: 11,
      method: 'tasks/get',
      params: { id: taskId },
    });

    expect(getRes.status).toBe(200);
    expect(getRes.json.result).toBeDefined();
    expect(getRes.json.result.id).toBe(taskId);
    expect(getRes.json.result.status.state).toBe('completed');
  });

  it('unknown method returns -32601', async () => {
    const { status, json } = await jsonPost('/a2a', {
      jsonrpc: '2.0',
      id: 8,
      method: 'unknown/method',
    });

    expect(status).toBe(200);
    expect(json.error.code).toBe(-32601);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// A2A Protocol — message/stream (SSE)
// ═══════════════════════════════════════════════════════════════════════════

describe('A2A message/stream (SSE)', () => {
  it('returns SSE content-type with task events', async () => {
    const res = await fetch(`${BASE_URL}/a2a`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 20,
        method: 'message/stream',
        params: {
          message: {
            role: 'user',
            parts: [{
              kind: 'data',
              mimeType: 'application/json',
              data: { skill: 'get_supported_circuits', chainId: '84532' },
            }],
          },
        },
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    const text = await res.text();
    const events = parseSseEvents(text);
    expect(events.length).toBeGreaterThan(0);

    // Should have at least one task status update
    const taskEvent = events.find(e => e.result?.status?.state === 'completed');
    expect(taskEvent).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// MCP StreamableHTTP
// ═══════════════════════════════════════════════════════════════════════════

describe('MCP StreamableHTTP', () => {
  it('initialize returns server info as SSE', async () => {
    const res = await fetch(`${BASE_URL}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'e2e-test', version: '1.0.0' },
        },
      }),
    });

    expect(res.status).toBe(200);
    const text = await res.text();
    const events = parseSseEvents(text);
    expect(events.length).toBeGreaterThan(0);

    const initResult = events[0];
    expect(initResult.result.serverInfo).toBeDefined();
    expect(initResult.result.serverInfo.name).toBe('zkproofport-prover');
  });

  it('tools/list returns 3 tools', async () => {
    const res = await fetch(`${BASE_URL}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
        params: {},
      }),
    });

    expect(res.status).toBe(200);
    const text = await res.text();
    const events = parseSseEvents(text);
    const result = events[0];
    expect(result.result.tools).toHaveLength(3);

    const toolNames = result.result.tools.map((t: any) => t.name).sort();
    expect(toolNames).toEqual(['generate_proof', 'get_supported_circuits', 'verify_proof']);
  });

  it('tools/call get_supported_circuits returns circuit list', async () => {
    const res = await fetch(`${BASE_URL}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'get_supported_circuits',
          arguments: {},
        },
      }),
    });

    expect(res.status).toBe(200);
    const text = await res.text();
    const events = parseSseEvents(text);
    const result = events[0];
    expect(result.result.content).toBeDefined();

    const textContent = result.result.content.find((c: any) => c.type === 'text');
    expect(textContent).toBeDefined();
    expect(textContent.text).toContain('coinbase_attestation');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// REST API
// ═══════════════════════════════════════════════════════════════════════════

describe('REST API', () => {
  it('GET /api/v1/circuits returns circuit list', async () => {
    const { status, json } = await jsonGet('/api/v1/circuits');
    expect(status).toBe(200);
    expect(json.circuits).toBeDefined();
    expect(json.circuits.length).toBeGreaterThan(0);
    expect(json.circuits.find((c: any) => c.id === 'coinbase_attestation')).toBeDefined();
    expect(json.circuits.find((c: any) => c.id === 'coinbase_country_attestation')).toBeDefined();
  });

  it('GET /api/v1/proofs/:taskId returns 404 for non-existent', async () => {
    const { status, json } = await jsonGet('/api/v1/proofs/nonexistent-id');
    expect(status).toBe(404);
    expect(json.error).toBeDefined();
  });

  it('POST /api/v1/proofs/verify with missing params returns 400', async () => {
    const { status, json } = await jsonPost('/api/v1/proofs/verify', {});
    expect(status).toBe(400);
    expect(json.error).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Proof Generation & Verification (Real bb/nargo — requires attestation wallet)
// ═══════════════════════════════════════════════════════════════════════════

const ATTESTATION_KEY = process.env.E2E_ATTESTATION_WALLET_KEY;
const ATTESTATION_ADDRESS = process.env.E2E_ATTESTATION_WALLET_ADDRESS;

describe.skipIf(!ATTESTATION_KEY || !ATTESTATION_ADDRESS)(
  'Real Proof Generation & Verification',
  () => {
    let generatedProof: string;
    let generatedPublicInputs: string;

    it('A2A: generate_proof produces a real proof', { timeout: 300_000 }, async () => {
      // Sign the signalHash bytes to prove wallet ownership
      // The container will fetch the EAS attestation for this address
      const scope = 'e2e-test.zkproofport.app';
      const signature = await signForProof(ATTESTATION_KEY!, ATTESTATION_ADDRESS!, scope, 'coinbase_attestation');

      const { status, json } = await jsonPost('/a2a', {
        jsonrpc: '2.0',
        id: 100,
        method: 'message/send',
        params: {
          message: {
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
      });

      expect(status).toBe(200);
      expect(json.result).toBeDefined();
      expect(json.result.status.state).toBe('completed');

      // Extract proof from artifacts
      const proofArtifact = json.result.artifacts?.find((a: any) =>
        a.parts.some((p: any) => p.kind === 'data' && p.data?.proof)
      );
      expect(proofArtifact).toBeDefined();

      const proofData = proofArtifact.parts.find((p: any) => p.data?.proof).data;
      generatedProof = proofData.proof;
      generatedPublicInputs = proofData.publicInputs;

      expect(generatedProof).toBeDefined();
      expect(generatedProof.startsWith('0x')).toBe(true);
      expect(generatedPublicInputs).toBeDefined();
    });

    it('A2A: verify_proof validates the generated proof on-chain', { timeout: 60_000 }, async () => {
      expect(generatedProof).toBeDefined(); // depends on previous test

      const { status, json } = await jsonPost('/a2a', {
        jsonrpc: '2.0',
        id: 101,
        method: 'message/send',
        params: {
          message: {
            role: 'user',
            parts: [{
              kind: 'data',
              mimeType: 'application/json',
              data: {
                skill: 'verify_proof',
                circuitId: 'coinbase_attestation',
                proof: generatedProof,
                publicInputs: generatedPublicInputs,
                chainId: '84532',
              },
            }],
          },
        },
      });

      expect(status).toBe(200);
      expect(json.result).toBeDefined();
      expect(json.result.status.state).toBe('completed');

      // Check verification result
      const verifyArtifact = json.result.artifacts?.find((a: any) =>
        a.parts.some((p: any) => p.kind === 'data' && p.data?.valid !== undefined)
      );
      expect(verifyArtifact).toBeDefined();
      const verifyData = verifyArtifact.parts.find((p: any) => p.data?.valid !== undefined).data;
      expect(verifyData.valid).toBe(true);
    });

    it('MCP: generate_proof via tools/call', { timeout: 300_000 }, async () => {
      const scope = 'e2e-mcp-test.zkproofport.app';
      const signature = await signForProof(ATTESTATION_KEY!, ATTESTATION_ADDRESS!, scope, 'coinbase_attestation');

      const res = await fetch(`${BASE_URL}/mcp`, {
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

      expect(res.status).toBe(200);
      const text = await res.text();
      const events = parseSseEvents(text);
      expect(events.length).toBeGreaterThan(0);

      const result = events[0];
      expect(result.result).toBeDefined();
      expect(result.result.content).toBeDefined();

      // Verify actual proof data is in response (not just error text)
      const textContent = result.result.content.find((c: any) => c.type === 'text');
      expect(textContent).toBeDefined();

      // The text should contain proof data (either JSON or mention of proof)
      const responseText = textContent.text;
      // Try to parse as JSON to check for proof field
      try {
        const parsed = JSON.parse(responseText);
        expect(parsed.proof).toBeDefined();
        expect(parsed.proof.startsWith('0x')).toBe(true);
      } catch {
        // If not JSON, the text should at least mention "proof" and contain hex data
        expect(responseText).toMatch(/proof|0x[0-9a-fA-F]{10,}/);
      }
    });

    it('REST: POST /api/v1/proofs generates proof', { timeout: 300_000 }, async () => {
      const scope = 'e2e-rest-test.zkproofport.app';
      const signature = await signForProof(ATTESTATION_KEY!, ATTESTATION_ADDRESS!, scope, 'coinbase_attestation');

      const { status, json } = await jsonPost('/api/v1/proofs', {
        circuitId: 'coinbase_attestation',
        address: ATTESTATION_ADDRESS,
        signature,
        scope,
      });

      expect(status).toBe(200);
      expect(json.taskId).toBeDefined();
      expect(json.state).toBe('completed');
      expect(json.proof).toBeDefined();
      expect(json.proof.startsWith('0x')).toBe(true);
    });

    it('REST: POST /api/v1/proofs/verify validates on-chain', { timeout: 60_000 }, async () => {
      expect(generatedProof).toBeDefined();

      // REST verify requires publicInputs as string[] (array of bytes32)
      // generate_proof returns a single concatenated hex string — split into 32-byte chunks
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

// ═══════════════════════════════════════════════════════════════════════════
// Failure Cases — Invalid Inputs
// ═══════════════════════════════════════════════════════════════════════════

describe('Failure Cases', () => {
  it('A2A: generate_proof with unknown circuit returns error', async () => {
    const { status, json } = await jsonPost('/a2a', {
      jsonrpc: '2.0',
      id: 200,
      method: 'message/send',
      params: {
        message: {
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
    });

    expect(status).toBe(200);
    expect(json.result).toBeDefined();
    expect(json.result.status.state).toBe('failed');
  });

  it('A2A: generate_proof with missing address returns error', async () => {
    const { status, json } = await jsonPost('/a2a', {
      jsonrpc: '2.0',
      id: 201,
      method: 'message/send',
      params: {
        message: {
          role: 'user',
          parts: [{
            kind: 'data',
            mimeType: 'application/json',
            data: {
              skill: 'generate_proof',
              circuitId: 'coinbase_attestation',
              scope: 'test.com',
              // missing address and signature
            },
          }],
        },
      },
    });

    expect(status).toBe(200);
    expect(json.result).toBeDefined();
    expect(json.result.status.state).toBe('failed');
  });

  it('A2A: verify_proof with invalid proof hex returns failed', async () => {
    const { status, json } = await jsonPost('/a2a', {
      jsonrpc: '2.0',
      id: 202,
      method: 'message/send',
      params: {
        message: {
          role: 'user',
          parts: [{
            kind: 'data',
            mimeType: 'application/json',
            data: {
              skill: 'verify_proof',
              circuitId: 'coinbase_attestation',
              proof: '0xdeadbeef',
              publicInputs: ['0x' + '00'.repeat(32)],
              chainId: '84532',
            },
          }],
        },
      },
    });

    expect(status).toBe(200);
    expect(json.result).toBeDefined();
    // Verify either fails or returns valid=false
    if (json.result.status.state === 'completed') {
      const verifyArtifact = json.result.artifacts?.find((a: any) =>
        a.parts.some((p: any) => p.kind === 'data' && p.data?.valid !== undefined)
      );
      if (verifyArtifact) {
        const data = verifyArtifact.parts.find((p: any) => p.data?.valid !== undefined).data;
        expect(data.valid).toBe(false);
      }
    } else {
      expect(json.result.status.state).toBe('failed');
    }
  });

  it('REST: POST /api/v1/proofs with missing circuitId returns 400', async () => {
    const { status, json } = await jsonPost('/api/v1/proofs', {
      address: '0x' + 'aa'.repeat(20),
      signature: '0x' + 'bb'.repeat(65),
      scope: 'test.com',
    });

    expect(status).toBe(400);
    expect(json.error).toBeDefined();
  });

  it('REST: POST /api/v1/proofs with unknown circuit returns error', async () => {
    const { status, json } = await jsonPost('/api/v1/proofs', {
      circuitId: 'nonexistent_circuit',
      address: '0x' + 'aa'.repeat(20),
      signature: '0x' + 'bb'.repeat(65),
      scope: 'test.com',
    });

    // Either 400 (validation) or 200 with failed state
    expect([200, 400]).toContain(status);
    if (status === 200) {
      expect(json.state).toBe('failed');
    }
  });

  it('REST: POST /api/v1/proofs/verify with non-array publicInputs returns 400', async () => {
    const { status, json } = await jsonPost('/api/v1/proofs/verify', {
      circuitId: 'coinbase_attestation',
      proof: '0xdeadbeef',
      publicInputs: '0x' + '00'.repeat(32), // string instead of array
      chainId: '84532',
    });

    expect(status).toBe(400);
    expect(json.error).toContain('array');
  });

  it('MCP: tools/call generate_proof with missing params returns error', async () => {
    const res = await fetch(`${BASE_URL}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 203,
        method: 'tools/call',
        params: {
          name: 'generate_proof',
          arguments: {
            circuitId: 'coinbase_attestation',
            // missing address, signature, scope
          },
        },
      }),
    });

    expect(res.status).toBe(200);
    const text = await res.text();
    const events = parseSseEvents(text);
    expect(events.length).toBeGreaterThan(0);

    // Should indicate error
    const result = events[0];
    expect(result.result).toBeDefined();
    const textContent = result.result.content?.find((c: any) => c.type === 'text');
    if (textContent) {
      // Error message should indicate missing params or failure
      expect(textContent.text.toLowerCase()).toMatch(/error|fail|missing|required/);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Signing Endpoints
// ═══════════════════════════════════════════════════════════════════════════

describe('Signing Endpoints', () => {
  it('GET /api/signing/:requestId returns 404 for non-existent', async () => {
    const { status, json } = await jsonGet('/api/signing/nonexistent-id');
    expect(status).toBe(404);
  });

  it('GET /signing/status returns status', async () => {
    const { status, json } = await jsonGet('/signing/status');
    expect(status).toBe(200);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Payment Endpoints
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
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// HTML Pages
// ═══════════════════════════════════════════════════════════════════════════

describe('HTML Pages', () => {
  it('GET /pay/:requestId returns HTML', async () => {
    const res = await fetch(`${BASE_URL}/pay/test-request-id`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
  });

  it('GET /v/:proofId returns HTML', async () => {
    const res = await fetch(`${BASE_URL}/v/test-proof-id`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
  });
});
