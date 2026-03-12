#!/usr/bin/env node

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// ─── Resolve path to index.js in the same dist/ directory ─────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const serverPath = join(__dirname, 'index.js');

// ─── Parse CLI arguments (before validation, so --silent works early) ──
const args = process.argv.slice(2);

let silent = false;
let circuit = 'coinbase_kyc';
let scope = 'proofport';
let countries: string[] | undefined;
let included: boolean | undefined;

let i = 0;
// Check if first arg is positional (not a flag)
if (args[0] && !args[0].startsWith('--')) {
  circuit = args[0];
  i = 1;
}

for (; i < args.length; i++) {
  if (args[i] === '--silent') {
    silent = true;
  } else if (args[i] === '--scope' && args[i + 1]) {
    scope = args[++i];
  } else if (args[i] === '--countries' && args[i + 1]) {
    countries = args[++i].split(',').map((c) => c.trim());
  } else if (args[i] === '--included' && args[i + 1]) {
    included = args[++i].toLowerCase() === 'true';
  }
}

// ─── Silent-aware log helper ───────────────────────────────────────────
const log = silent ? (..._args: unknown[]) => {} : console.error.bind(console);

// ─── Validate ATTESTATION_KEY ──────────────────────────────────────────
const attestationKey = process.env.ATTESTATION_KEY;
if (!attestationKey) {
  if (silent) {
    console.error(JSON.stringify({ error: 'ATTESTATION_KEY environment variable is required' }));
  } else {
    console.error('Error: ATTESTATION_KEY environment variable is required');
    console.error('');
    console.error('Usage: ATTESTATION_KEY=0x... zkproofport-prove [circuit] [options]');
    console.error('');
    console.error('Environment variables:');
    console.error('  ATTESTATION_KEY    (required) Private key of wallet with Coinbase EAS attestation');
    console.error('  PAYMENT_KEY        (optional) Separate payment wallet private key');
    console.error('  CDP_API_KEY_ID     (optional) Coinbase Developer Platform MPC wallet credentials');
    console.error('  CDP_API_KEY_SECRET (optional) (all three CDP vars must be set together)');
    console.error('  CDP_WALLET_SECRET  (optional)');
    console.error('  CDP_WALLET_ADDRESS (optional) Reuse existing CDP wallet');
    console.error('');
    console.error('  If no payment wallet is set, the attestation wallet is used for payment.');
    console.error('');
    console.error('Options:');
    console.error('  --scope <scope>           Scope for nullifier (default: "proofport")');
    console.error('  --countries <codes>        Comma-separated ISO codes (for coinbase_country)');
    console.error('  --included <true|false>    Inclusion proof (for coinbase_country)');
    console.error('  --silent                   Suppress all logs; output raw proof JSON only');
    console.error('');
    console.error('Examples:');
    console.error('  ATTESTATION_KEY=0x... zkproofport-prove coinbase_kyc');
    console.error('  ATTESTATION_KEY=0x... PAYMENT_KEY=0x... zkproofport-prove coinbase_kyc --scope my-app');
    console.error('  ATTESTATION_KEY=0x... zkproofport-prove coinbase_country --countries US,KR --included true');
  }
  process.exit(1);
}

// ─── Privacy warning if no separate payment wallet ───────────────────
if (!process.env.PAYMENT_KEY && !process.env.CDP_API_KEY_ID) {
  log('');
  log('WARNING: No separate payment wallet configured (PAYMENT_KEY or CDP credentials).');
  log('The attestation wallet will be used for payment. This exposes your KYC-verified');
  log('wallet address on-chain in the payment transaction, linking your identity to');
  log('on-chain activity. Set PAYMENT_KEY for privacy.');
  log('');
}

// ─── Validate circuit-specific args ───────────────────────────────────
if (circuit === 'coinbase_country') {
  if (!countries || countries.length === 0) {
    if (silent) {
      console.error(JSON.stringify({ error: '--countries <codes> is required for coinbase_country circuit' }));
    } else {
      console.error('Error: --countries <codes> is required for coinbase_country circuit');
      console.error('Example: --countries US,KR');
    }
    process.exit(1);
  }
  if (included === undefined) {
    if (silent) {
      console.error(JSON.stringify({ error: '--included <true|false> is required for coinbase_country circuit' }));
    } else {
      console.error('Error: --included <true|false> is required for coinbase_country circuit');
    }
    process.exit(1);
  }
}

// ─── Build tool arguments ──────────────────────────────────────────────
const toolArgs: Record<string, unknown> = { circuit, scope };
if (countries !== undefined) toolArgs.country_list = countries;
if (included !== undefined) toolArgs.is_included = included;

// ─── Start MCP server and call generate_proof ──────────────────────────
log(`[zkproofport-prove] Circuit: ${circuit}`);
log(`[zkproofport-prove] Scope: ${scope}`);
if (countries) log(`[zkproofport-prove] Countries: ${countries.join(', ')}`);
if (included !== undefined) log(`[zkproofport-prove] Included: ${included}`);
log('[zkproofport-prove] Starting MCP server...');

const transport = new StdioClientTransport({
  command: 'node',
  args: [serverPath],
  env: { ...process.env, ATTESTATION_KEY: attestationKey, ...(silent ? { ZKPROOFPORT_SILENT: '1' } : {}) },
  ...(silent ? { stderr: 'ignore' as const } : {}),
});

const client = new Client({ name: 'zkproofport-prove', version: '1.0.0' });

try {
  await client.connect(transport);
  log('[zkproofport-prove] Connected. Generating proof (30-90 seconds)...');

  const result = await client.callTool({
    name: 'generate_proof',
    arguments: toolArgs,
  });

  const isError = (result as any).isError;
  if (silent) {
    const content = (result as any).content;
    const output = content?.[0]?.text ?? JSON.stringify(result, null, 2);
    if (isError) {
      console.error(output);
      process.exit(1);
    }
    console.log(output);
  } else {
    if (isError) {
      const content = (result as any).content;
      console.error(content?.[0]?.text ?? JSON.stringify(result, null, 2));
      process.exit(1);
    }
    console.log(JSON.stringify(result, null, 2));
  }
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  if (silent) {
    console.error(JSON.stringify({ error: message }));
  } else {
    console.error(`[zkproofport-prove] Error: ${message}`);
  }
  process.exit(1);
} finally {
  await client.close();
}
