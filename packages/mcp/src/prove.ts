#!/usr/bin/env node

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// ─── Resolve path to index.js in the same dist/ directory ─────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const serverPath = join(__dirname, 'index.js');

// ─── Device Code Flow helpers ─────────────────────────────────────────

// ZKProofport's own OAuth credentials — customers do NOT configure these
const GOOGLE_CLIENT_ID = '995938448974-5k6078o9ie7q5ecimc67apd6e4ktumrt.apps.googleusercontent.com';
const GOOGLE_CLIENT_SECRET = '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';
const MICROSOFT_CLIENT_ID = 'cd5404cc-d313-431c-8112-725e629dad28';
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

  console.error('');
  console.error(`  Open: ${codeData.verification_url}`);
  console.error(`  Code: ${codeData.user_code}`);
  console.error('');
  console.error('  Waiting for authorization...');

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
      console.error('  Authorization successful!');
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

  console.error('');
  console.error(`  Open: ${codeData.verification_uri}`);
  console.error(`  Code: ${codeData.user_code}`);
  console.error('');
  console.error('  Waiting for authorization...');

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
      console.error('  Authorization successful!');
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
let circuit = 'coinbase_kyc';
let scope = 'proofport';
let countries: string[] | undefined;
let included: boolean | undefined;
let jwt: string | undefined;
let provider: string | undefined;
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
  } else if (args[i] === '--login-google') {
    loginGoogle = true;
  } else if (args[i] === '--login-google-workspace') {
    loginGoogleWorkspace = true;
  } else if (args[i] === '--login-microsoft-365') {
    loginMicrosoft365 = true;
  }
}

// ─── Silent-aware log helper ───────────────────────────────────────────
const log = silent ? (..._args: unknown[]) => {} : console.error.bind(console);

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
      console.error(JSON.stringify({ error: 'ATTESTATION_KEY environment variable is required' }));
    } else {
      console.error('Error: ATTESTATION_KEY environment variable is required');
      console.error('');
      console.error('Usage: ATTESTATION_KEY=0x... zkproofport-prove [circuit] [options]');
      console.error('');
      console.error('Environment variables:');
      console.error('  ATTESTATION_KEY    (required) Private key of wallet with Coinbase EAS attestation');
      console.error('');
      console.error('Options:');
      console.error('  --scope <scope>            Scope for nullifier (default: "proofport")');
      console.error('  --countries <codes>         Comma-separated ISO codes (for coinbase_country)');
      console.error('  --included <true|false>     Inclusion proof (for coinbase_country)');
      console.error('  --silent                    Suppress all logs; output raw proof JSON only');
      console.error('  --login-google             Login with Google account (device flow)');
      console.error('  --login-google-workspace   Login with Google Workspace (device flow)');
      console.error('  --login-microsoft-365      Login with Microsoft 365 (device flow)');
      console.error('');
      console.error('Circuits:');
      console.error('  coinbase_kyc       Prove Coinbase KYC verification (requires ATTESTATION_KEY)');
      console.error('  coinbase_country   Prove KYC country attestation (requires ATTESTATION_KEY)');
      console.error('  oidc_domain        Prove email domain via OIDC JWT (--jwt required)');
      console.error('');
      console.error('Examples:');
      console.error('  ATTESTATION_KEY=0x... zkproofport-prove coinbase_kyc --scope my-app');
      console.error('  ATTESTATION_KEY=0x... zkproofport-prove coinbase_country --countries US,KR --included true');
      console.error('  zkproofport-prove oidc_domain --jwt eyJhbGciOi... --scope my-app');
    }
    process.exit(1);
  }
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
if (isOidc && !hasLoginFlag) {
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

// ─── Mutual exclusivity: --login-* vs --jwt ──────────────────────────
const loginFlags = [loginGoogle, loginGoogleWorkspace, loginMicrosoft365].filter(Boolean);
if (loginFlags.length > 1) {
  console.error('Error: Only one --login-* flag can be specified at a time');
  process.exit(1);
}
if (loginFlags.length === 1 && jwt) {
  console.error('Error: --login-* and --jwt are mutually exclusive');
  process.exit(1);
}

// ─── Device flow login ───────────────────────────────────────────────
if (loginGoogle || loginGoogleWorkspace || loginMicrosoft365) {
  // Device flow implies oidc_domain circuit
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
      console.error(JSON.stringify({ error: message }));
    } else {
      console.error(`[zkproofport-prove] Login failed: ${message}`);
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
if (jwt) log(`[zkproofport-prove] JWT: ${jwt}`);
log('[zkproofport-prove] Starting MCP server...');

// Pass env to MCP server (index.ts handles ephemeral key for OIDC/login if no ATTESTATION_KEY)
const serverEnv: Record<string, string> = { ...process.env as Record<string, string> };

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
