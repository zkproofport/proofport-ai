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
let jwt: string | undefined;
let provider: string | undefined;

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
  } else if (args[i] === '--jwt' && args[i + 1]) {
    jwt = args[++i];
  } else if (args[i] === '--provider' && args[i + 1]) {
    provider = args[++i];
  }
}

// ─── Silent-aware log helper ───────────────────────────────────────────
const log = silent ? (..._args: unknown[]) => {} : console.error.bind(console);

// ─── Determine if this is an OIDC circuit ─────────────────────────────
const isOidc = circuit === 'oidc_domain';

// ─── Validate keys based on circuit type ──────────────────────────────
const attestationKey = process.env.ATTESTATION_KEY;
const paymentKey = process.env.PAYMENT_KEY;

if (isOidc) {
  // OIDC circuits: only need a payment wallet (no EAS attestation)
  if (!paymentKey) {
    if (silent) {
      console.error(JSON.stringify({ error: 'PAYMENT_KEY environment variable is required for oidc_domain circuit' }));
    } else {
      console.error('Error: PAYMENT_KEY environment variable is required for oidc_domain circuit');
      console.error('');
      console.error('Usage: PAYMENT_KEY=0x... zkproofport-prove oidc_domain --jwt <token> [options]');
      console.error('');
      console.error('Environment variables:');
      console.error('  PAYMENT_KEY    (required) Private key of wallet with USDC for x402 payment');
      console.error('');
      console.error('Options:');
      console.error('  --jwt <token>              OIDC JWT id_token (required)');
      console.error('  --scope <scope>            Scope for nullifier (default: "proofport")');
      console.error('  --silent                   Suppress all logs; output raw proof JSON only');
      console.error('');
      console.error('How to obtain a JWT id_token (Google OAuth):');
      console.error('  1. Register OAuth app at https://console.cloud.google.com/apis/credentials');
      console.error('  2. Exchange authorization code for tokens:');
      console.error('     curl -X POST https://oauth2.googleapis.com/token \\');
      console.error('       -d grant_type=authorization_code \\');
      console.error('       -d code=<AUTH_CODE> \\');
      console.error('       -d client_id=<CLIENT_ID> \\');
      console.error('       -d client_secret=<CLIENT_SECRET> \\');
      console.error('       -d redirect_uri=<REDIRECT_URI>');
      console.error('  3. Use the id_token from the response');
      console.error('');
      console.error('Example:');
      console.error('  PAYMENT_KEY=0x... zkproofport-prove oidc_domain --jwt eyJhbGciOi... --scope my-app');
    }
    process.exit(1);
  }
} else {
  // Coinbase circuits: need attestation wallet (EAS attested)
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
      console.error('  PAYMENT_KEY        (recommended) Separate payment wallet private key');
      console.error('  CDP_API_KEY_ID     (optional) Coinbase Developer Platform MPC wallet credentials');
      console.error('  CDP_API_KEY_SECRET (optional) (all three CDP vars must be set together)');
      console.error('  CDP_WALLET_SECRET  (optional)');
      console.error('  CDP_WALLET_ADDRESS (optional) Reuse existing CDP wallet');
      console.error('');
      console.error('  WARNING: Always use PAYMENT_KEY or CDP wallet for payment.');
      console.error('  Without a separate payment wallet, the attestation wallet is used');
      console.error('  as fallback — this exposes your KYC-verified wallet address on-chain,');
      console.error('  linking your identity to payment transactions.');
      console.error('');
      console.error('Options:');
      console.error('  --scope <scope>            Scope for nullifier (default: "proofport")');
      console.error('  --countries <codes>         Comma-separated ISO codes (for coinbase_country)');
      console.error('  --included <true|false>     Inclusion proof (for coinbase_country)');
      console.error('  --silent                    Suppress all logs; output raw proof JSON only');
      console.error('');
      console.error('Circuits:');
      console.error('  coinbase_kyc       Prove Coinbase KYC verification (requires ATTESTATION_KEY)');
      console.error('  coinbase_country   Prove KYC country attestation (requires ATTESTATION_KEY)');
      console.error('  oidc_domain        Prove email domain via OIDC JWT (requires PAYMENT_KEY + --jwt)');
      console.error('');
      console.error('Examples:');
      console.error('  ATTESTATION_KEY=0x... PAYMENT_KEY=0x... zkproofport-prove coinbase_kyc --scope my-app');
      console.error('  ATTESTATION_KEY=0x... PAYMENT_KEY=0x... zkproofport-prove coinbase_country --countries US,KR --included true');
      console.error('  PAYMENT_KEY=0x... zkproofport-prove oidc_domain --jwt eyJhbGciOi... --scope my-app');
    }
    process.exit(1);
  }
}

// ─── Privacy warning if no separate payment wallet (Coinbase circuits only) ──
if (!isOidc && !paymentKey && !process.env.CDP_API_KEY_ID) {
  log('');
  log('WARNING: No separate payment wallet configured (PAYMENT_KEY).');
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

// ─── Validate OIDC-specific args ─────────────────────────────────────
if (isOidc) {
  if (!jwt) {
    if (silent) {
      console.error(JSON.stringify({ error: '--jwt <token> is required for oidc_domain circuit' }));
    } else {
      console.error('Error: --jwt <token> is required for oidc_domain circuit');
      console.error('Obtain a JWT id_token via Google OAuth (see usage above)');
    }
    process.exit(1);
  }
}

// ─── Build tool arguments ──────────────────────────────────────────────
const toolArgs: Record<string, unknown> = { circuit, scope };
if (countries !== undefined) toolArgs.country_list = countries;
if (included !== undefined) toolArgs.is_included = included;
if (jwt !== undefined) toolArgs.jwt = jwt;
if (provider !== undefined) toolArgs.provider = provider;

// ─── Start MCP server and call generate_proof ──────────────────────────
log(`[zkproofport-prove] Circuit: ${circuit}`);
log(`[zkproofport-prove] Scope: ${scope}`);
if (countries) log(`[zkproofport-prove] Countries: ${countries.join(', ')}`);
if (included !== undefined) log(`[zkproofport-prove] Included: ${included}`);
if (jwt) log(`[zkproofport-prove] JWT: ${jwt.slice(0, 20)}...`);
log('[zkproofport-prove] Starting MCP server...');

// For OIDC: pass PAYMENT_KEY as ATTESTATION_KEY to MCP server (attestation signer
// is unused for OIDC, but the server needs at least one key for type compatibility)
const serverEnv: Record<string, string> = { ...process.env as Record<string, string> };
if (isOidc && !attestationKey && paymentKey) {
  serverEnv.ATTESTATION_KEY = paymentKey;
  serverEnv.PAYMENT_KEY = paymentKey;
}

const transport = new StdioClientTransport({
  command: 'node',
  args: [serverPath],
  env: { ...serverEnv, ...(silent ? { ZKPROOFPORT_SILENT: '1' } : {}) },
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
  const content = (result as any).content;
  const output = content?.[0]?.text ?? JSON.stringify(result, null, 2);
  if (isError) {
    console.error(output);
    process.exit(1);
  }
  console.log(output);
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
