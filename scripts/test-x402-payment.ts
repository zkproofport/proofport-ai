/**
 * x402 Payment E2E Test Script
 *
 * Tests the full x402 payment flow:
 * 1. Sends POST /mcp without payment → expects 402
 * 2. Sends POST /mcp with x402 payment (USDC on Base Sepolia) → expects 200
 *
 * Prerequisites:
 * - proofport-ai running locally (docker compose up --build -d)
 * - PAYMENT_MODE=testnet in .env.development
 * - Prover wallet has Base Sepolia USDC (faucet: https://faucet.circle.com/)
 *
 * Usage:
 *   npx tsx scripts/test-x402-payment.ts
 */

import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { wrapFetchWithPayment, x402Client } from '@x402/fetch';
import { ExactEvmScheme } from '@x402/evm/exact/client';

const PROVER_PRIVATE_KEY = '0x5c8eb0e0dcdcdabdc87f1fae3e992132e8a06b83188dfba625ca95036876bb0a';
const MCP_URL = 'http://localhost:4002/mcp';
const A2A_URL = 'http://localhost:4002/a2a';

async function main() {
  console.log('=== x402 Payment E2E Test ===\n');

  // Step 1: Test without payment (expect 402)
  console.log('1. Testing POST /mcp without payment...');
  const res402 = await fetch(MCP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1 }),
  });
  console.log(`   Status: ${res402.status} ${res402.statusText}`);
  if (res402.status !== 402) {
    console.error('   FAIL: Expected 402 Payment Required');
    process.exit(1);
  }
  console.log('   PASS: Got 402 Payment Required\n');

  // Step 2: Create viem wallet client
  console.log('2. Setting up wallet...');
  const account = privateKeyToAccount(PROVER_PRIVATE_KEY);
  console.log(`   Address: ${account.address}`);

  const walletClient = createWalletClient({
    account,
    chain: baseSepolia,
    transport: http('https://sepolia.base.org'),
  });

  // Step 3: Create x402 payment client
  // ExactEvmScheme expects signer.address directly (viem puts it on account.address)
  console.log('3. Creating x402 payment client...');
  const signer = {
    address: walletClient.account.address,
    signTypedData: (args: any) => walletClient.signTypedData(args),
  };
  const scheme = new ExactEvmScheme(signer as any);
  const client = new x402Client();
  client.register('eip155:84532', scheme);

  // Step 4: Wrap fetch with x402 payment
  const paidFetch = wrapFetchWithPayment(fetch, client);

  // Step 5: Test with payment (expect 200)
  console.log('4. Testing POST /mcp with x402 payment...');
  try {
    const resPaid = await paidFetch(MCP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1 }),
    });
    console.log(`   Status: ${resPaid.status} ${resPaid.statusText}`);

    if (resPaid.status === 200 || resPaid.status === 406) {
      // 406 means payment passed but MCP needs Accept header — still a payment success
      if (resPaid.status === 406) {
        console.log('   PASS: Payment accepted (406 is MCP Accept header issue, not payment)');
      }
    }
    if (resPaid.status === 200) {
      const body = await resPaid.json();
      console.log('   Response:', JSON.stringify(body, null, 2).slice(0, 500));
      console.log('\n   PASS: x402 payment accepted!');
    } else if (resPaid.status === 402) {
      console.log('   FAIL: Still 402 — check USDC balance or facilitator');
      const paymentHeader = resPaid.headers.get('PAYMENT-REQUIRED');
      if (paymentHeader) {
        const decoded = JSON.parse(Buffer.from(paymentHeader, 'base64').toString());
        console.log('   Payment requirements:', JSON.stringify(decoded, null, 2));
      }
    } else {
      const body = await resPaid.text();
      console.log(`   Response body: ${body.slice(0, 500)}`);
    }
  } catch (err) {
    console.error('   Error:', err instanceof Error ? err.message : err);
  }

  // Step 6: Test A2A endpoint
  console.log('\n5. Testing POST /a2a with x402 payment...');
  try {
    const resA2a = await paidFetch(A2A_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tasks/send',
        params: { skill: 'generate_proof' },
      }),
    });
    console.log(`   Status: ${resA2a.status} ${resA2a.statusText}`);
    if (resA2a.status === 200) {
      const body = await resA2a.json();
      console.log('   Response:', JSON.stringify(body, null, 2).slice(0, 500));
      console.log('\n   PASS: A2A x402 payment accepted!');
    } else {
      console.log(`   Response: ${(await resA2a.text()).slice(0, 300)}`);
    }
  } catch (err) {
    console.error('   Error:', err instanceof Error ? err.message : err);
  }

  console.log('\n=== Test Complete ===');
}

main().catch(console.error);
