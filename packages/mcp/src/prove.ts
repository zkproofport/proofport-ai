#!/usr/bin/env node

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { fromPrivateKey, CIRCUIT_NAME_MAP } from '@zkproofport-ai/sdk';

const privateValues = [process.env.ATTESTATION_KEY, process.env.E2E_ATTESTATION_WALLET_ADDRESS]
  .filter((value): value is string => typeof value === 'string' && value.length >= 8);
if (process.env.ATTESTATION_KEY) {
  try { privateValues.push(await fromPrivateKey(process.env.ATTESTATION_KEY).getAddress()); }
  catch { /* The MCP server validates credentials; never log invalid key contents. */ }
}
function safeText(value: unknown): string {
  let text = String(value);
  for (const secret of [...privateValues, ...(jwt ? [jwt] : [])]) {
    for (const form of [secret, JSON.stringify(secret).slice(1, -1)]) {
      text = text.replace(new RegExp(form.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '****');
    }
  }
  return text;
}
const stderr = console.error.bind(console);
function writeError(...values: unknown[]) { stderr(...values.map(safeText)); }

// ─── Resolve path to index.js in the same dist/ directory ─────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const serverPath = join(__dirname, 'index.js');
// Opt-in lifecycle events contain no credential, witness, response body or address.
function demoTrace(event: 'mcp_start' | 'mcp_connected' | 'mcp_generate_proof' | 'mcp_result') {
  if (process.env.ZKPROOFPORT_DEMO_TRACE === '1') writeError(`[demo-cli] ${event}`);
}

// ─── Device Code Flow helpers ─────────────────────────────────────────

// ZKProofport's own OAuth credentials — customers do NOT configure these
const GOOGLE_CLIENT_ID = '491923400813-pr17m6kpin2rsbbes18jpb60j1s3qmv4.apps.googleusercontent.com';
const GOOGLE_CLIENT_SECRET = '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';
const MICROSOFT_CLIENT_ID = '8b09c842-d7a8-4d9c-a6ea-46c797412bac';
const MICROSOFT_TENANT = 'organizations'; // allows any org account

interface DeviceFlowResult {
  idToken: string;
}

async function googleDeviceFlow(): Promise<DeviceFlowResult> {
  // 1. Request device code
  const codeRes = await fetch('https://oauth2.googleapis.com/device/code', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      scope: 'openid email profile',
    }),
  });
  if (!codeRes.ok) {
    const err = await codeRes.text();
    throw new Error(`Google device code request failed: ${err}`);
  }
  const codeData = await codeRes.json() as {
    device_code: string;
    user_code: string;
    verification_url: string;
    expires_in: number;
    interval: number;
  };

  writeError('');
  writeError(`  Open: ${codeData.verification_url}`);
  writeError(`  Code: ${codeData.user_code}`);
  writeError('');
  writeError('  Waiting for authorization...');

  // 2. Poll for token
  const deadline = Date.now() + 5 * 60 * 1000; // 5 minute timeout
  let interval = (codeData.interval || 5) * 1000;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, interval));

    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        device_code: codeData.device_code,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }),
    });

    const tokenData = await tokenRes.json() as any;

    if (tokenRes.ok && tokenData.id_token) {
      writeError('  Authorization successful!');
      return { idToken: tokenData.id_token };
    }

    const error = tokenData.error;
    if (error === 'authorization_pending') continue;
    if (error === 'slow_down') {
      interval += 5000;
      continue;
    }
    if (error === 'access_denied') {
      throw new Error('User denied the authorization request');
    }
    if (error === 'expired_token') {
      throw new Error('Device code expired. Please try again.');
    }
    // Unknown error
    throw new Error(`Google token polling failed: ${JSON.stringify(tokenData)}`);
  }

  throw new Error('Device code flow timed out after 5 minutes');
}

async function microsoftDeviceFlow(): Promise<DeviceFlowResult> {
  // 1. Request device code
  const codeRes = await fetch(
    `https://login.microsoftonline.com/${MICROSOFT_TENANT}/oauth2/v2.0/devicecode`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: MICROSOFT_CLIENT_ID,
        scope: 'openid email profile',
      }),
    },
  );
  if (!codeRes.ok) {
    const err = await codeRes.text();
    throw new Error(`Microsoft device code request failed: ${err}`);
  }
  const codeData = await codeRes.json() as {
    device_code: string;
    user_code: string;
    verification_uri: string;
    expires_in: number;
    interval: number;
    message: string;
  };

  writeError('');
  writeError(`  Open: ${codeData.verification_uri}`);
  writeError(`  Code: ${codeData.user_code}`);
  writeError('');
  writeError('  Waiting for authorization...');

  // 2. Poll for token
  const deadline = Date.now() + 5 * 60 * 1000;
  let interval = (codeData.interval || 5) * 1000;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, interval));

    const tokenRes = await fetch(
      `https://login.microsoftonline.com/${MICROSOFT_TENANT}/oauth2/v2.0/token`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: MICROSOFT_CLIENT_ID,
          device_code: codeData.device_code,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        }),
      },
    );

    const tokenData = await tokenRes.json() as any;

    if (tokenRes.ok && tokenData.id_token) {
      writeError('  Authorization successful!');
      return { idToken: tokenData.id_token };
    }

    const error = tokenData.error;
    if (error === 'authorization_pending') continue;
    if (error === 'slow_down') {
      interval += 5000;
      continue;
    }
    if (error === 'authorization_declined') {
      throw new Error('User declined the authorization request');
    }
    if (error === 'expired_token') {
      throw new Error('Device code expired. Please try again.');
    }
    throw new Error(`Microsoft token polling failed: ${JSON.stringify(tokenData)}`);
  }

  throw new Error('Device code flow timed out after 5 minutes');
}

// ─── Parse CLI arguments (before validation, so --silent works early) ──
const args = process.argv.slice(2);

let silent = false;
// No default. A circuit decides which proof gets made and which verifier can
// check it, so guessing one produces a proof nobody asked for -- the caller
// finds out much later, somewhere else. See the identifier rule in CLAUDE.md.
let circuit: string | undefined;
let scope = 'proofport';
let actionFile: string | undefined;
let countries: string[] | undefined;
let included: boolean | undefined;
let jwt: string | undefined;
let provider: string | undefined;
let payWith: string | undefined;
let payOn: string | undefined;
let maxPayment: string | undefined;
let loginGoogle = false;
let loginGoogleWorkspace = false;
let loginMicrosoft365 = false;

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
  } else if (args[i] === '--action' && args[i + 1]) {
    actionFile = args[++i];
  } else if (args[i] === '--pay-with' && args[i + 1]) {
    payWith = args[++i];
  } else if (args[i] === '--pay-on' && args[i + 1]) {
    payOn = args[++i];
  } else if (args[i] === '--max-payment') {
    maxPayment = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : '';
  } else if (args[i] === '--login-google') {
    loginGoogle = true;
  } else if (args[i] === '--login-google-workspace') {
    loginGoogleWorkspace = true;
  } else if (args[i] === '--login-microsoft-365') {
    loginMicrosoft365 = true;
  }
}

// ─── Silent-aware log helper ───────────────────────────────────────────
const log = silent ? (..._args: unknown[]) => {} : writeError;

function printUsage() {
  writeError('Usage: ATTESTATION_KEY=0x... zkproofport-prove [circuit] [options]');
  writeError('');
  writeError('Environment variables:');
  writeError('  ATTESTATION_KEY    (required) Private key of wallet with Coinbase EAS attestation');
  writeError('');
  writeError('Paying (only when the service charges — the wallet and the chain are separate choices):');
  writeError('  --pay-with arc      an Arc agent wallet, signed by Circle CLI (no key here)');
  writeError('                      optional: ARC_AGENT_WALLET picks one when several exist');
  writeError('  --pay-with key      PAYMENT_PRIVATE_KEY');
  writeError('  --pay-with cdp      CDP_API_KEY_ID, CDP_API_KEY_SECRET, CDP_WALLET_SECRET');
  writeError('  --pay-with circle   CIRCLE_API_KEY, CIRCLE_ENTITY_SECRET, CIRCLE_WALLET_ID');
  writeError('');
  writeError('  The payer signs a USDC authorization and the service submits it, so no gas');
  writeError('  and no native balance are needed on the paying chain — only USDC.');
  writeError('');
  writeError('Options:');
  writeError('  --scope <scope>            Scope for nullifier (default: "proofport")');
  writeError('  --countries <codes>         Comma-separated ISO codes (for coinbase_country)');
  writeError('  --included <true|false>     Inclusion proof (for coinbase_country)');
  writeError('  --silent                    Suppress all logs; output raw proof JSON only');
  writeError('  --login-google             Login with Google account (device flow)');
  writeError('  --login-google-workspace   Login with Google Workspace (device flow)');
  writeError('  --login-microsoft-365      Login with Microsoft 365 (device flow)');
  writeError('  --action <file.json>        EIP-712 action (arc_eligibility, giwa_attestation)');
  writeError('  --pay-with <key|cdp|circle|arc> Which wallet pays, when the service charges');
  writeError('  --pay-on <chain>            Which chain to pay on (e.g. arc-testnet, base-sepolia)');
  writeError('  --max-payment <USDC>        Maximum proof fee, up to six decimal places');
  writeError('');
  writeError('Circuits:');
  writeError('  coinbase_kyc       Prove Coinbase KYC verification (requires ATTESTATION_KEY)');
  writeError('  coinbase_country   Prove KYC country attestation (requires ATTESTATION_KEY)');
  writeError('  oidc_domain        Prove email domain via OIDC JWT (--jwt required)');
  writeError('  arc_eligibility    Coinbase KYC, optionally binding one EIP-712 action (--action)');
  writeError('  giwa_attestation   GIWA account attestation, optionally binding one action');
  writeError('');
  writeError('ATTESTATION_KEY must be the wallet attested for the circuit you ask for:');
  writeError('  Coinbase attests on Base; GIWA attests on GIWA Sepolia, and one');
  writeError('  wallet is rarely attested by both.');
  writeError('');
  writeError('Examples:');
  writeError('  # pay on Arc from a Circle wallet');
  writeError('  zkproofport-prove coinbase_kyc --pay-with circle --pay-on arc-testnet');
  writeError('  # pay on Base Sepolia from a CDP wallet');
  writeError('  zkproofport-prove coinbase_kyc --pay-with cdp --pay-on base-sepolia');
  writeError('  ATTESTATION_KEY=0x... zkproofport-prove coinbase_kyc --scope my-app');
  writeError('  ATTESTATION_KEY=0x... zkproofport-prove coinbase_country --countries US,KR --included true');
  writeError('  zkproofport-prove oidc_domain --jwt eyJhbGciOi... --scope my-app');
}

/**
 * `--help` prints usage and exits 0.
 *
 * It used to die with "A circuit is required" -- the usage text existed but
 * lived inside the missing-ATTESTATION_KEY branch, so the only way to see it
 * was to trigger a different error. Nobody could discover `--pay-with` that
 * way, which is the whole point of adding it.
 */
if (args.includes('--help') || args.includes('-h')) {
  printUsage();
  process.exit(0);
}

if (maxPayment !== undefined && !/^\d+(\.\d{1,6})?$/.test(maxPayment)) {
  const message = '--max-payment requires a non-negative USDC amount with up to six decimal places.';
  writeError(silent ? JSON.stringify({error: message}) : `Error: ${message}`);
  process.exit(1);
}

// ─── The circuit must be named ────────────────────────────────────────
// Device-flow login sets it further down, so this only rejects a run that
// names neither.
const wantsDeviceFlow = loginGoogle || loginGoogleWorkspace || loginMicrosoft365;
if (!circuit && !wantsDeviceFlow) {
  // The list comes from the name map, not from four names typed here: the
  // usage text above went two circuits out of date exactly that way.
  const msg =
    `A circuit is required. Pass one of: ${Object.keys(CIRCUIT_NAME_MAP).join(', ')}.`;
  if (silent) writeError(JSON.stringify({ error: msg }));
  else writeError(`Error: ${msg}`);
  process.exit(1);
}

// ─── Determine if this is an OIDC circuit ─────────────────────────────
const isOidc = circuit === 'oidc_domain';

// ─── Validate keys based on circuit type ──────────────────────────────
const attestationKey = process.env.ATTESTATION_KEY;

const hasLoginFlag = loginGoogle || loginGoogleWorkspace || loginMicrosoft365;

// Coinbase circuits require ATTESTATION_KEY (EAS-attested wallet)
// OIDC/login flows do not require any key — ephemeral key is generated internally
if (!isOidc && !hasLoginFlag) {
  if (!attestationKey) {
    if (silent) {
      writeError(JSON.stringify({ error: 'ATTESTATION_KEY environment variable is required' }));
    } else {
      writeError('Error: ATTESTATION_KEY environment variable is required');
      writeError('');
      printUsage();
    }
    process.exit(1);
  }
}

// ─── Validate circuit-specific args ───────────────────────────────────
if (circuit === 'coinbase_country') {
  if (!countries || countries.length === 0) {
    if (silent) {
      writeError(JSON.stringify({ error: '--countries <codes> is required for coinbase_country circuit' }));
    } else {
      writeError('Error: --countries <codes> is required for coinbase_country circuit');
      writeError('Example: --countries US,KR');
    }
    process.exit(1);
  }
  if (included === undefined) {
    if (silent) {
      writeError(JSON.stringify({ error: '--included <true|false> is required for coinbase_country circuit' }));
    } else {
      writeError('Error: --included <true|false> is required for coinbase_country circuit');
    }
    process.exit(1);
  }
}

// ─── Validate OIDC-specific args ─────────────────────────────────────
if (isOidc && !hasLoginFlag) {
  if (!jwt) {
    if (silent) {
      writeError(JSON.stringify({ error: '--jwt <token> is required for oidc_domain circuit' }));
    } else {
      writeError('Error: --jwt <token> is required for oidc_domain circuit');
      writeError('Obtain a JWT id_token via Google OAuth (see usage above)');
    }
    process.exit(1);
  }
}

// ─── Mutual exclusivity: --login-* vs --jwt ──────────────────────────
const loginFlags = [loginGoogle, loginGoogleWorkspace, loginMicrosoft365].filter(Boolean);
if (loginFlags.length > 1) {
  writeError('Error: Only one --login-* flag can be specified at a time');
  process.exit(1);
}
if (loginFlags.length === 1 && jwt) {
  writeError('Error: --login-* and --jwt are mutually exclusive');
  process.exit(1);
}

// ─── Device flow login ───────────────────────────────────────────────
if (loginGoogle || loginGoogleWorkspace || loginMicrosoft365) {
  // A login flag means the OIDC circuit. Asking for a different one at the
  // same time is a contradiction, and overwriting it silently -- which is what
  // this did -- produced an OIDC proof for someone who asked for a Coinbase
  // one and said so on the command line.
  if (circuit && circuit !== 'oidc_domain') {
    const msg =
      `--login-* signs in with an identity provider and proves oidc_domain, but '${circuit}' was requested. ` +
      'Drop the circuit argument, or drop the login flag.';
    if (silent) writeError(JSON.stringify({ error: msg }));
    else writeError(`Error: ${msg}`);
    process.exit(1);
  }
  circuit = 'oidc_domain';

  try {
    if (loginGoogle) {
      log('[zkproofport-prove] Starting Google device flow login...');
      const result = await googleDeviceFlow();
      jwt = result.idToken;
      // --login-google: no provider (generic Google account)
    } else if (loginGoogleWorkspace) {
      log('[zkproofport-prove] Starting Google Workspace device flow login...');
      const result = await googleDeviceFlow();
      jwt = result.idToken;
      provider = 'google';
    } else if (loginMicrosoft365) {
      log('[zkproofport-prove] Starting Microsoft 365 device flow login...');
      const result = await microsoftDeviceFlow();
      jwt = result.idToken;
      provider = 'microsoft';
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (silent) {
      writeError(JSON.stringify({ error: message }));
    } else {
      writeError(`[zkproofport-prove] Login failed: ${message}`);
    }
    process.exit(1);
  }
}

// ─── The action-bound circuit needs the typed action ──────────────────
//
// Read from a file rather than a flag: an EIP-712 structure is nested JSON,
// and a shell-quoted one loses its quoting in ways that surface as a wrong
// hash rather than a parse error.
let action: unknown;
const canBindAction = circuit === 'arc_eligibility' || circuit === 'giwa_attestation';
if (actionFile && !canBindAction) {
  const msg =
    `--action was given but '${circuit}' has no inputs for one. Only ` +
    'arc_eligibility and giwa_attestation carry an action.';
  if (silent) writeError(JSON.stringify({ error: msg }));
  else writeError(`Error: ${msg}`);
  process.exit(1);
}
if (canBindAction && actionFile) {
  // Optional since 2026-09-22: both circuits sign the request's signal hash
  // when no action is given. It used to be required for arc_eligibility
  // because that circuit had no second path.
  const { readFileSync } = await import('node:fs');
  try {
    action = JSON.parse(readFileSync(actionFile, 'utf8'));
  } catch (err) {
    const msg = `--action file could not be read as JSON: ${(err as Error).message}`;
    if (silent) writeError(JSON.stringify({ error: msg }));
    else writeError(`Error: ${msg}`);
    process.exit(1);
  }
  // Valid JSON is not a valid action. The circuit hashes the structure without
  // reading it, so a missing field produces a proof of the wrong thing rather
  // than an error -- and the wallet shows only the fields that are present, so
  // nobody sees what is absent either.
  const { validateTypedAction } = await import('@zkproofport-ai/sdk');
  const actionProblem = validateTypedAction(action);
  if (actionProblem) {
    if (silent) writeError(JSON.stringify({ error: actionProblem }));
    else writeError(`Error: ${actionProblem}`);
    process.exit(1);
  }
}

// ─── Build tool arguments ──────────────────────────────────────────────
const toolArgs: Record<string, unknown> = { circuit, scope };
if (action !== undefined) toolArgs.action = action;
if (countries !== undefined) toolArgs.country_list = countries;
if (included !== undefined) toolArgs.is_included = included;
if (jwt !== undefined) toolArgs.jwt = jwt;
if (provider !== undefined) toolArgs.provider = provider;
if (payWith !== undefined) toolArgs.pay_with = payWith;
if (payOn !== undefined) toolArgs.pay_on = payOn;
if (maxPayment !== undefined) toolArgs.max_payment = maxPayment;

// ─── Start MCP server and call generate_proof ──────────────────────────
log(`[zkproofport-prove] Circuit: ${circuit}`);
log(`[zkproofport-prove] Scope: ${scope}`);
if (countries) log(`[zkproofport-prove] Countries: ${countries.join(', ')}`);
if (included !== undefined) log(`[zkproofport-prove] Included: ${included}`);
if (jwt) log('[zkproofport-prove] OIDC token provided (hidden)');
if (payWith) log(`[zkproofport-prove] Paying with: ${payWith}${payOn ? ` on ${payOn}` : ''}`);
log('[zkproofport-prove] Starting MCP server...');

// Pass env to MCP server (index.ts handles ephemeral key for OIDC/login if no ATTESTATION_KEY)
const serverEnv: Record<string, string> = { ...process.env as Record<string, string> };

const transport = new StdioClientTransport({
  command: 'node',
  args: [serverPath],
  env: { ...serverEnv, ...(silent ? { ZKPROOFPORT_SILENT: '1' } : {}) },
  // Never inherit provider diagnostics: they can contain the credential holder.
  stderr: 'ignore',
});

const client = new Client({ name: 'zkproofport-prove', version: '1.0.0' });

try {
  demoTrace('mcp_start');
  await client.connect(transport);
  demoTrace('mcp_connected');
  log('[zkproofport-prove] Connected. Generating proof (30-90 seconds)...');

  demoTrace('mcp_generate_proof');
  const result = await client.callTool({
    name: 'generate_proof',
    arguments: toolArgs,
  }, undefined, {timeout: 240000});

  const isError = (result as any).isError;
  const content = (result as any).content;
  const output = content?.[0]?.text ?? JSON.stringify(result, null, 2);
  if (isError) {
    writeError(output);
    process.exit(1);
  }
  demoTrace('mcp_result');
  console.log(safeText(output));
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  if (silent) {
    writeError(JSON.stringify({ error: message }));
  } else {
    writeError(`[zkproofport-prove] Error: ${message}`);
  }
  process.exit(1);
} finally {
  await client.close();
}
