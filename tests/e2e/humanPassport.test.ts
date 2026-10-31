/**
 * human_passport_score against a real server (local container or staging),
 * through the SDK, the stdio MCP and the REST route.
 *
 * What runs without a scored wallet: everything the server and the clients
 * refuse BEFORE payment.
 *   - the E2E wallet has no Human Passport score on Base, so a request for it
 *     is refused with NO_HUMAN_PASSPORT_SCORE (403) -- after the client has
 *     signed a payment authorization, which the server never settles: a
 *     server that took payment first would answer with a settlement result,
 *     not this code;
 *   - thresholds the circuit cannot carry are refused by the SDK before the
 *     wallet signs, and by the server (INVALID_REQUEST) when sent raw;
 *   - a nullifier from another rule is refused (NULLIFIER_RULE);
 *   - the guide names the 195 public inputs and core's pinned verifier.
 * A proof needs a wallet with a Human Passport score, which these suites do not hold.
 *
 * Needs ATTESTATION_KEY (any wallet without a score) and, when the server
 * charges, E2E_PAYER_WALLET_KEY. scripts/run-published-e2e.mjs runs it with
 * the registry SDK and MCP.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { ethers } from 'ethers';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import * as sdk from '@zkproofport-ai/sdk';
import { createConfig, fromPrivateKey, type ClientConfig } from '@zkproofport-ai/sdk';
import { PINNED_VERIFIERS } from '@zkproofport-app/core';
import { planPayment, type PayerPlan } from './payer.js';

const BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:4002';
const ATTESTATION_KEY = process.env.ATTESTATION_KEY;
const PAYER_KEY = process.env.E2E_PAYER_WALLET_KEY;

describe('human_passport_score (refusals before payment)', () => {
  let config: ClientConfig;
  let plan: PayerPlan | undefined;

  beforeAll(async () => {
    if (!ATTESTATION_KEY) throw new Error('ATTESTATION_KEY required');
    config = createConfig({ baseUrl: BASE_URL });
    const challenge = await sdk.requestChallenge(config, 'human_passport' as never);
    if (challenge.requiresPayment !== false) {
      if (!PAYER_KEY) throw new Error(`${BASE_URL} charges; E2E_PAYER_WALLET_KEY is required`);
      plan = await planPayment(config, 'human_passport', PAYER_KEY);
    }
  });

  it('SDK: a wallet with no score is refused with NO_HUMAN_PASSPORT_SCORE, never charged', async () => {
    await expect(sdk.generateProof(
      config,
      { attestation: fromPrivateKey(ATTESTATION_KEY!), payment: plan?.wallet },
      { circuit: 'human_passport' as never, scope: 'e2e:human-passport', minScore: 20, payOn: plan?.payOn } as never,
    )).rejects.toThrow(/NO_HUMAN_PASSPORT_SCORE/);
  }, 120_000);

  it.each([0, -1, '20', 20.00001])('SDK: refuses minScore %p before the wallet signs', async bad => {
    let signed = 0;
    const signer = fromPrivateKey(ATTESTATION_KEY!);
    const counting = { getAddress: () => signer.getAddress(), signMessage: async (m: unknown) => { signed++; return signer.signMessage(m as never); } };
    await expect(sdk.generateProof(config, { attestation: counting as never }, { circuit: 'human_passport', minScore: bad } as never))
      .rejects.toThrow(/minScore/);
    expect(signed).toBe(0);
  });

  async function rawRequest(over: Record<string, unknown>) {
    const wallet = new ethers.Wallet(ATTESTATION_KEY!);
    const prepared = sdk.prepareHumanPassportInputs({
      userAddress: wallet.address,
      userSignature: await wallet.signMessage(sdk.computeSignalHash(wallet.address, 'e2e:raw', 'human_passport_score')),
      scope: 'e2e:raw', minScore: 20,
    });
    const challenge = await sdk.requestChallenge(config, 'human_passport' as never);
    return fetch(`${BASE_URL}/api/v1/prove`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Payment-Nonce': challenge.nonce },
      body: JSON.stringify({ circuit: 'human_passport', inputs: { ...prepared, ...over } }),
    });
  }

  it.each([[0], [-5], ['20'], [1.123456], [null]])('REST: min_score %p is INVALID_REQUEST before any lookup', async bad => {
    const res = await rawRequest({ min_score: bad });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('INVALID_REQUEST');
  });

  it('REST: a nullifier from the signal-hash rule is NULLIFIER_RULE', async () => {
    const res = await rawRequest({ nullifier: '0x' + '11'.repeat(32) });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('NULLIFIER_RULE');
  });

  it('REST: no score is a 403 naming the cause, with nothing settled', async () => {
    const res = await rawRequest({});
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('NO_HUMAN_PASSPORT_SCORE');
  });

  it('MCP: generate_proof human_passport refuses the unscored wallet', async () => {
    const transport = new StdioClientTransport({
      command: process.env.E2E_MCP_ENTRY ? process.execPath : 'npx',
      args: process.env.E2E_MCP_ENTRY ? [process.env.E2E_MCP_ENTRY] : ['--no-install', 'zkproofport-mcp'],
      env: {
        ...(process.env as Record<string, string>), PROOFPORT_URL: BASE_URL, ATTESTATION_KEY: ATTESTATION_KEY!,
        ...(PAYER_KEY ? { PAYMENT_PRIVATE_KEY: PAYER_KEY } : {}),
      },
      stderr: 'ignore',
    });
    const client = new Client({ name: 'e2e-human-passport', version: '1.0.0' });
    await client.connect(transport);
    try {
      const result = await client.callTool({
        name: 'generate_proof',
        // .env.test also configures a CDP wallet; name the key wallet, as the MCP
        // refuses to pick between two.
        arguments: { circuit: 'human_passport', scope: 'e2e:mcp', min_score: 20, ...(PAYER_KEY ? { pay_with: 'key' } : {}), ...(plan?.payOn ? { pay_on: plan.payOn } : {}) },
      }, undefined, { timeout: 120_000 });
      expect((result as { isError?: boolean }).isError).toBe(true);
      expect(JSON.stringify(result)).toMatch(/NO_HUMAN_PASSPORT_SCORE/);
    } finally {
      await client.close();
    }
  }, 150_000);

  it('guide: 195 public inputs and core\'s pinned verifier for the deployment chain', async () => {
    const res = await fetch(`${BASE_URL}/api/v1/guide/human_passport`);
    expect(res.status).toBe(200);
    const guide = await res.json();
    expect(guide.circuit_id).toBe('human_passport_score');
    expect(guide.constants.verification.public_input_count).toBe(195);
    const chain = guide.constants.verification.chain_id as number;
    const pinned = (PINNED_VERIFIERS as Record<string, Record<number, { address: string }>>).human_passport_score[chain];
    expect(pinned, `core pins no human_passport_score verifier on ${chain}`).toBeDefined();
    expect(guide.constants.verification.verifier_address.toLowerCase()).toBe(pinned.address);
  });
});
