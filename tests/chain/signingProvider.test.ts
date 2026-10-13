/**
 * A wallet's provider must send one request per HTTP call.
 *
 * The server below answers the way the production Base gateway
 * (base.gateway.tenderly.co) was measured to on 2026-10-13: a batch carrying
 * eth_sendRawTransaction gets HTTP 429, batched reads and single requests are
 * answered normally. Against that, a default ethers provider retries the 429
 * until its own timeout, which is how the Base ERC-8004 metadata update hung
 * for 120 s on two production deploys.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ethers } from 'ethers';
import { signingProvider } from '../../src/chain/signingProvider.js';

type RpcCall = { id: number; method: string };

const bodies: unknown[] = [];
let server: Server;
let url: string;

function answer(call: RpcCall) {
  switch (call.method) {
    case 'eth_chainId': return { jsonrpc: '2.0', id: call.id, result: '0x2105' };
    case 'eth_blockNumber': return { jsonrpc: '2.0', id: call.id, result: '0x10' };
    case 'eth_sendRawTransaction':
      return { jsonrpc: '2.0', id: call.id, error: { code: -32003, message: 'insufficient funds for gas * price + value' } };
    default: return { jsonrpc: '2.0', id: call.id, error: { code: -32601, message: `unexpected ${call.method}` } };
  }
}

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => (raw += chunk));
    req.on('end', () => {
      const body = JSON.parse(raw) as RpcCall | RpcCall[];
      bodies.push(body);
      res.setHeader('Content-Type', 'application/json');
      if (Array.isArray(body) && body.some(c => c.method === 'eth_sendRawTransaction')) {
        res.statusCode = 429;
        res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32005, message: 'rate limit exceeded' } }));
        return;
      }
      res.end(JSON.stringify(Array.isArray(body) ? body.map(answer) : answer(body)));
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>(r => server.close(() => r())));

async function signedTransfer(): Promise<string> {
  const wallet = ethers.Wallet.createRandom();
  return wallet.signTransaction({
    type: 2, chainId: 8453, nonce: 0, to: wallet.address, value: 0, gasLimit: 21000,
    maxFeePerGas: 20_000_000n, maxPriorityFeePerGas: 1_000_000n,
  });
}

const settlesWithin = <T>(p: Promise<T>, ms: number) =>
  Promise.race([
    p.then(() => 'resolved', (e: Error) => `rejected: ${(e as { shortMessage?: string }).shortMessage ?? e.message}`),
    new Promise<string>(r => setTimeout(() => r('still pending'), ms)),
  ]);

describe('signingProvider', () => {
  it('gets the node\'s answer to a send instead of retrying a 429 forever', async () => {
    const provider = signingProvider(url);
    const outcome = await settlesWithin(provider.broadcastTransaction(await signedTransfer()), 5_000);
    expect(outcome).toMatch(/^rejected: insufficient funds/);
    provider.destroy();
  });

  it('never sends a batch', async () => {
    bodies.length = 0;
    const provider = signingProvider(url);
    await Promise.allSettled([provider.getBlockNumber(), provider.broadcastTransaction(await signedTransfer())]);
    expect(bodies.length).toBeGreaterThan(0);
    expect(bodies.filter(Array.isArray)).toEqual([]);
    provider.destroy();
  });

  it('keeps the caller\'s options and cannot be talked back into batching', () => {
    const provider = signingProvider(url, { cacheTimeout: -1, batchMaxCount: 10 });
    expect(provider._getOption('cacheTimeout')).toBe(-1);
    expect(provider._getOption('batchMaxCount')).toBe(1);
    provider.destroy();
  });

  it('the hazard is real: a default provider is still waiting on the same server', async () => {
    const provider = new ethers.JsonRpcProvider(url, undefined);
    const outcome = await settlesWithin(provider.broadcastTransaction(await signedTransfer()), 2_000);
    expect(outcome).toBe('still pending');
    provider.destroy();
  });
});

describe('every wallet that sends uses it', () => {
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap(name => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? files(path) : path.endsWith('.ts') ? [path] : [];
    });

  it('no source file builds a Wallet on a provider it made with new JsonRpcProvider', () => {
    const offenders = files(join(__dirname, '../../src')).filter(path => {
      const src = readFileSync(path, 'utf8');
      return /new ethers\.Wallet\([^)]*,\s*\w+/.test(src) && /new ethers\.JsonRpcProvider\(/.test(src);
    });
    expect(offenders).toEqual([]);
  });
});
