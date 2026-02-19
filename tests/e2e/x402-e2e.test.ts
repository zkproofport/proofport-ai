/**
 * x402 Payment Gating — Real E2E Tests
 *
 * Tests against the REAL Docker container with PAYMENT_MODE=testnet.
 * NO vi.mock(), NO supertest — real HTTP to localhost:4002.
 *
 * Prerequisites:
 *   docker compose -f docker-compose.yml -f docker-compose.e2e-payment.yml up -d
 *   Wait for: curl http://localhost:4002/health | grep testnet
 *
 * Run: npx vitest run tests/e2e/x402-e2e.test.ts
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { ethers } from 'ethers';
import { wrapFetchWithPaymentFromConfig } from '@x402/fetch';
import { ExactEvmScheme } from '@x402/evm';

const BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:4002';

// ─── Helpers ────────────────────────────────────────────────────────────

async function signForProof(walletKey: string, address: string, scope: string, circuitId: string) {
  const wallet = new ethers.Wallet(walletKey);
  const signalPreimage = ethers.solidityPacked(
    ['address', 'string', 'string'],
    [address, scope, circuitId],
  );
  const signalHash = ethers.getBytes(ethers.keccak256(signalPreimage));
  const signature = await wallet.signMessage(signalHash);
  return signature;
}

function ensurePublicInputsArray(publicInputs: any): string[] {
  if (Array.isArray(publicInputs)) return publicInputs;
  if (typeof publicInputs !== 'string') return [];
  const clean = publicInputs.startsWith('0x') ? publicInputs.slice(2) : publicInputs;
  if (clean.length === 0) return [];
  const chunks: string[] = [];
  for (let i = 0; i < clean.length; i += 64) {
    chunks.push('0x' + clean.slice(i, i + 64).padEnd(64, '0'));
  }
  return chunks;
}

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

// ─── Connectivity + Payment Mode check ──────────────────────────────────

beforeAll(async () => {
  try {
    const res = await fetch(`${BASE_URL}/health`, { signal: AbortSignal.timeout(5000) });
    const health = await res.json();

    if (!res.ok) throw new Error(`Health check failed: ${res.status}`);
    if (health.paymentMode !== 'testnet') {
      throw new Error(
        `Container is running with PAYMENT_MODE=${health.paymentMode}, but testnet is required.\n` +
        `Fix: docker compose -f docker-compose.yml -f docker-compose.e2e-payment.yml up -d ai`
      );
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes('PAYMENT_MODE')) throw err;
    throw new Error(
      `Cannot connect to ${BASE_URL}. Ensure the container is running with PAYMENT_MODE=testnet:\n` +
      `  docker compose -f docker-compose.yml -f docker-compose.e2e-payment.yml up -d\n` +
      `Original error: ${err}`
    );
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Payment status verification
// ═══════════════════════════════════════════════════════════════════════════

describe('Payment Mode Verification', () => {
  it('/health shows paymentMode=testnet and paymentRequired=true', async () => {
    const { status, json } = await jsonGet('/health');
    expect(status).toBe(200);
    expect(json.paymentMode).toBe('testnet');
    expect(json.paymentRequired).toBe(true);
  });

  it('/payment/status shows testnet config with network and price', async () => {
    const { status, json } = await jsonGet('/payment/status');
    expect(status).toBe(200);
    expect(json.mode).toBe('testnet');
    expect(json.network).toBe('eip155:84532');
    expect(json.requiresPayment).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// A2A: generate_proof requires payment (402 without, free skills OK)
// ═══════════════════════════════════════════════════════════════════════════

describe('A2A Payment Gating', () => {
  it('message/send generate_proof WITHOUT payment → 402', async () => {
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
            data: {
              skill: 'generate_proof',
              circuitId: 'coinbase_attestation',
              scope: 'test.com',
              address: '0x' + 'dd'.repeat(20),
              signature: '0x' + 'ee'.repeat(65),
            },
          }],
        },
      },
    });

    expect(status).toBe(402);
  });

  it('message/send get_supported_circuits WITHOUT payment → 200 (free)', async () => {
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
            data: { skill: 'get_supported_circuits', chainId: '84532' },
          }],
        },
      },
    });

    expect(status).toBe(200);
    expect(json.result).toBeDefined();
    expect(json.result.status.state).toBe('completed');
  });

  it('message/send verify_proof WITHOUT payment → 200 (free)', async () => {
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
            data: { skill: 'verify_proof' },
          }],
        },
      },
    });

    // Should NOT be 402 — verify_proof is free (will fail due to missing params, but that's OK)
    expect(status).not.toBe(402);
    expect(status).toBe(200);
  });

  it('tasks/get WITHOUT payment → 200 (always free)', async () => {
    const { status, json } = await jsonPost('/a2a', {
      jsonrpc: '2.0',
      id: 4,
      method: 'tasks/get',
      params: { id: 'nonexistent' },
    });

    expect(status).toBe(200);
    expect(json.error.code).toBe(-32001); // not found, but NOT 402
  });

  it('tasks/cancel WITHOUT payment → 200 (always free)', async () => {
    const { status, json } = await jsonPost('/a2a', {
      jsonrpc: '2.0',
      id: 5,
      method: 'tasks/cancel',
      params: { id: 'nonexistent' },
    });

    expect(status).toBe(200);
    expect(json.error.code).toBe(-32001);
  });

  it('tasks/resubscribe WITHOUT payment → 200 (always free)', async () => {
    const { status, json } = await jsonPost('/a2a', {
      jsonrpc: '2.0',
      id: 6,
      method: 'tasks/resubscribe',
      params: { id: 'nonexistent' },
    });

    expect(status).toBe(200);
    expect(json.error.code).toBe(-32001);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// MCP: generate_proof requires payment, other tools free
// ═══════════════════════════════════════════════════════════════════════════

describe('MCP Payment Gating', () => {
  it('tools/call generate_proof WITHOUT payment → 402', async () => {
    const res = await fetch(`${BASE_URL}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 10,
        method: 'tools/call',
        params: {
          name: 'generate_proof',
          arguments: {
            circuitId: 'coinbase_attestation',
            scope: 'test.com',
          },
        },
      }),
    });

    expect(res.status).toBe(402);
  });

  it('tools/call get_supported_circuits WITHOUT payment → 200 (free)', async () => {
    const res = await fetch(`${BASE_URL}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 11,
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
    expect(events.length).toBeGreaterThan(0);
  });

  it('tools/call verify_proof WITHOUT payment → 200 (free)', async () => {
    const res = await fetch(`${BASE_URL}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 12,
        method: 'tools/call',
        params: {
          name: 'verify_proof',
          arguments: {
            circuitId: 'coinbase_attestation',
            proof: '0xaabb',
            publicInputs: ['0x' + 'cc'.repeat(32)],
          },
        },
      }),
    });

    expect(res.status).toBe(200);
  });

  it('initialize WITHOUT payment → 200 (free)', async () => {
    const res = await fetch(`${BASE_URL}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 13,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'e2e-payment-test', version: '1.0.0' },
        },
      }),
    });

    expect(res.status).toBe(200);
  });

  it('tools/list WITHOUT payment → 200 (free)', async () => {
    const res = await fetch(`${BASE_URL}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 14,
        method: 'tools/list',
        params: {},
      }),
    });

    expect(res.status).toBe(200);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// REST: POST /api/v1/proofs requires payment
// ═══════════════════════════════════════════════════════════════════════════

describe('REST Payment Gating', () => {
  it('POST /api/v1/proofs WITHOUT payment → 402', async () => {
    const { status } = await jsonPost('/api/v1/proofs', {
      circuitId: 'coinbase_attestation',
      scope: 'test.com',
      address: '0x' + 'dd'.repeat(20),
      signature: '0x' + 'ee'.repeat(65),
    });

    expect(status).toBe(402);
  });

  it('GET /api/v1/circuits WITHOUT payment → 200 (free)', async () => {
    const { status, json } = await jsonGet('/api/v1/circuits');
    expect(status).toBe(200);
    expect(json.circuits.length).toBeGreaterThan(0);
  });

  it('POST /api/v1/proofs/verify WITHOUT payment → 200 (free)', async () => {
    const { status } = await jsonPost('/api/v1/proofs/verify', {
      circuitId: 'coinbase_attestation',
      proof: '0xaabb',
      publicInputs: ['0x' + 'cc'.repeat(32)],
      chainId: '84532',
    });

    // Should NOT be 402 (verify is free), might be 200 or 400 depending on proof validity
    expect(status).not.toBe(402);
  });

  it('GET /api/v1/proofs/:taskId WITHOUT payment → not 402 (free)', async () => {
    const { status } = await jsonGet('/api/v1/proofs/nonexistent-id');
    expect(status).not.toBe(402);
    expect(status).toBe(404);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Status/Discovery endpoints always free (even with PAYMENT_MODE=testnet)
// ═══════════════════════════════════════════════════════════════════════════

describe('Always-Free Endpoints (with payment enabled)', () => {
  const freeEndpoints = [
    '/health',
    '/payment/status',
    '/signing/status',
    '/tee/status',
    '/identity/status',
    '/.well-known/agent-card.json',
    '/.well-known/agent.json',
    '/.well-known/mcp.json',
    '/api/v1/circuits',
  ];

  for (const endpoint of freeEndpoints) {
    it(`GET ${endpoint} → 200 (not 402)`, async () => {
      const { status } = await jsonGet(endpoint);
      expect(status).toBe(200);
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 402 response header format verification
// ═══════════════════════════════════════════════════════════════════════════

describe('402 Payment Required Header Format', () => {
  it('POST /api/v1/proofs → 402 with correct PAYMENT-REQUIRED header format', async () => {
    const res = await fetch(`${BASE_URL}/api/v1/proofs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        circuitId: 'coinbase_attestation',
        scope: 'test.com',
        address: '0x' + 'dd'.repeat(20),
        signature: '0x' + 'ee'.repeat(65),
      }),
    });

    expect(res.status).toBe(402);

    const paymentHeader = res.headers.get('payment-required') ?? res.headers.get('PAYMENT-REQUIRED');
    expect(paymentHeader).toBeDefined();

    // Decode base64 header
    const decoded = JSON.parse(Buffer.from(paymentHeader!, 'base64').toString('utf8'));
    expect(decoded.x402Version).toBe(2);
    expect(decoded.accepts).toBeDefined();
    expect(Array.isArray(decoded.accepts)).toBe(true);
    expect(decoded.accepts[0].network).toBe('eip155:84532');
    expect(decoded.accepts[0].asset).toBe('0x036CbD53842c5426634e7929541eC2318f3dCF7e');
  });

  it('A2A generate_proof → 402 with correct PAYMENT-REQUIRED header format', async () => {
    const res = await fetch(`${BASE_URL}/a2a`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
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
                scope: 'test.com',
                address: '0x' + 'dd'.repeat(20),
                signature: '0x' + 'ee'.repeat(65),
              },
            }],
          },
        },
      }),
    });

    expect(res.status).toBe(402);

    const paymentHeader = res.headers.get('payment-required') ?? res.headers.get('PAYMENT-REQUIRED');
    expect(paymentHeader).toBeDefined();

    const decoded = JSON.parse(Buffer.from(paymentHeader!, 'base64').toString('utf8'));
    expect(decoded.x402Version).toBe(2);
    expect(decoded.accepts).toBeDefined();
    expect(decoded.accepts[0].network).toBe('eip155:84532');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// x402 Paid Proof Generation — Full Flow (pay → generate → verify)
// ═══════════════════════════════════════════════════════════════════════════

const PAYER_KEY = process.env.E2E_PAYER_WALLET_KEY || '0xf7c6da5a5104441555f2e65f3a94cce3a3cf452dc190ae3a67e28ece024d845a';
const ATTESTATION_KEY = process.env.E2E_ATTESTATION_WALLET_KEY;
const ATTESTATION_ADDRESS = process.env.E2E_ATTESTATION_WALLET_ADDRESS;

describe.skipIf(!ATTESTATION_KEY || !ATTESTATION_ADDRESS)(
  'x402 Paid Proof Generation — Full Flow',
  () => {
    const payFetch = makePayFetch(PAYER_KEY);

    // ── REST: pay → generate_proof → success ────────────────────────────

    it(
      'REST: POST /api/v1/proofs with payment → proof returned',
      async () => {
        const signature = await signForProof(
          ATTESTATION_KEY!,
          ATTESTATION_ADDRESS!,
          'test.zkproofport.app',
          'coinbase_attestation',
        );

        const res = await payFetch(`${BASE_URL}/api/v1/proofs`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            circuitId: 'coinbase_attestation',
            scope: 'test.zkproofport.app',
            address: ATTESTATION_ADDRESS,
            signature,
          }),
        });

        // After payment auto-handled, should not be 402
        expect(res.status).not.toBe(402);

        const text = await res.text();
        let json: any;
        try { json = JSON.parse(text); } catch { json = null; }

        // Expect successful task creation or direct result
        expect(res.status).toBeGreaterThanOrEqual(200);
        expect(res.status).toBeLessThan(300);
        expect(json).not.toBeNull();

        // Should have taskId or proof data
        const hasTaskId = json.taskId !== undefined;
        const hasProof = json.proof !== undefined;
        expect(hasTaskId || hasProof).toBe(true);

        // If async task, poll until complete
        if (hasTaskId) {
          const taskId = json.taskId;
          let proofResult: any = null;
          const deadline = Date.now() + 240_000; // 4 min polling window
          while (Date.now() < deadline) {
            await new Promise(r => setTimeout(r, 5000));
            const pollRes = await fetch(`${BASE_URL}/api/v1/proofs/${taskId}`);
            const pollJson = await pollRes.json();
            if (pollJson.status === 'completed' || pollJson.proof) {
              proofResult = pollJson;
              break;
            }
            if (pollJson.status === 'failed') {
              throw new Error(`Proof generation failed: ${pollJson.error}`);
            }
          }
          expect(proofResult).not.toBeNull();
          expect(proofResult.proof || proofResult.result?.proof).toBeDefined();
        }
      },
      300_000,
    );

    // ── REST: pay → generate → verify on-chain ──────────────────────────

    it(
      'REST: generate proof with payment then verify on-chain',
      async () => {
        const signature = await signForProof(
          ATTESTATION_KEY!,
          ATTESTATION_ADDRESS!,
          'verify.zkproofport.app',
          'coinbase_attestation',
        );

        // Step 1: generate (with auto-payment)
        const genRes = await payFetch(`${BASE_URL}/api/v1/proofs`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            circuitId: 'coinbase_attestation',
            scope: 'verify.zkproofport.app',
            address: ATTESTATION_ADDRESS,
            signature,
          }),
        });

        expect(genRes.status).not.toBe(402);
        const genJson = await genRes.json();

        // Resolve proof (poll if async)
        let proof: string | undefined;
        let publicInputs: string[] | undefined;

        if (genJson.proof) {
          proof = genJson.proof;
          publicInputs = genJson.publicInputs;
        } else if (genJson.taskId) {
          const deadline = Date.now() + 240_000;
          while (Date.now() < deadline) {
            await new Promise(r => setTimeout(r, 5000));
            const pollRes = await fetch(`${BASE_URL}/api/v1/proofs/${genJson.taskId}`);
            const pollJson = await pollRes.json();
            if (pollJson.status === 'completed' || pollJson.proof) {
              proof = pollJson.proof || pollJson.result?.proof;
              publicInputs = pollJson.publicInputs || pollJson.result?.publicInputs;
              break;
            }
            if (pollJson.status === 'failed') {
              throw new Error(`Proof generation failed: ${pollJson.error}`);
            }
          }
        }

        expect(proof).toBeDefined();
        expect(publicInputs).toBeDefined();

        // Step 2: verify on-chain (free endpoint)
        // REST response returns publicInputs as single hex string, verify needs string[]
        const verifyRes = await fetch(`${BASE_URL}/api/v1/proofs/verify`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            circuitId: 'coinbase_attestation',
            proof,
            publicInputs: ensurePublicInputsArray(publicInputs),
            chainId: '84532',
          }),
        });

        expect(verifyRes.status).not.toBe(402);
        const verifyJson = await verifyRes.json();
        expect(verifyJson.valid).toBe(true);
      },
      300_000,
    );

    // ── A2A: pay → generate_proof → success ─────────────────────────────

    it(
      'A2A: message/send generate_proof with payment → task completed',
      async () => {
        const signature = await signForProof(
          ATTESTATION_KEY!,
          ATTESTATION_ADDRESS!,
          'a2a.zkproofport.app',
          'coinbase_attestation',
        );

        const res = await payFetch(`${BASE_URL}/a2a`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
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
                    circuitId: 'coinbase_attestation',
                    scope: 'a2a.zkproofport.app',
                    address: ATTESTATION_ADDRESS,
                    signature,
                  },
                }],
              },
            },
          }),
        });

        // After payment auto-handled, should not be 402
        expect(res.status).not.toBe(402);
        expect(res.status).toBe(200);

        const json = await res.json();
        expect(json.result).toBeDefined();

        // Task may be in submitted/working state initially — poll if needed
        const taskId = json.result?.id;
        if (taskId && json.result?.status?.state !== 'completed') {
          const deadline = Date.now() + 240_000;
          let finalState: string = json.result?.status?.state;
          while (Date.now() < deadline && finalState !== 'completed' && finalState !== 'failed') {
            await new Promise(r => setTimeout(r, 5000));
            const pollRes = await fetch(`${BASE_URL}/a2a`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                jsonrpc: '2.0',
                id: 201,
                method: 'tasks/get',
                params: { id: taskId },
              }),
            });
            const pollJson = await pollRes.json();
            finalState = pollJson.result?.status?.state;
          }
          expect(finalState).toBe('completed');
        } else {
          expect(json.result.status.state).toBe('completed');
        }
      },
      300_000,
    );
  },
);
