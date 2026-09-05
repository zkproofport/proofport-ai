/**
 * Vitest global setup — loads .env.test into process.env, and gives the suite
 * a connection pool it can close.
 * No external dependencies (no dotenv).
 */
import { afterAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const envPath = resolve(__dirname, '..', '.env.test');

try {
  const content = readFileSync(envPath, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    // Only set if not already defined (real env takes precedence)
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
} catch {
  // .env.test is optional — tests can still run with real env vars
}

/**
 * Give `fetch` a connection pool that cannot open an HTTP/2 session, and close
 * it when the file is done.
 *
 * Node's fetch negotiates HTTP/2 with the Cloud Run front end and keeps the
 * session in a pool shared by every request in the process. Nothing in the
 * suite closes it, and while a proof-generation test runs for one to two
 * minutes the session sits idle past the server's limit. Node then raises
 *
 *     InformationalError: socket idle timeout   (code UND_ERR_INFO)
 *     at Timeout.onHttp2SessionIdleTimeout
 *
 * as an UNCAUGHT exception — it belongs to no request, so no `catch` can see
 * it. Vitest counts it, warns that it "might cause false positive tests", and
 * exits 1 with every test passing. On 2026-09-05 that made the E2E command red
 * on a run where all 74 tests passed.
 *
 * Isolating it took bisecting the suite: no single file and no single group
 * reproduces it, because it needs one connection to sit idle while a long test
 * runs elsewhere. That also ruled out the first suspect — the A2A client built
 * in `beforeAll` of endpoints.test.ts and never closed. It is not that client;
 * it is the pool underneath every client.
 *
 * Over HTTP/1.1 the idle timer this throws from does not exist. Everything the
 * suite talks to serves both, and the requests are few, so there is nothing to
 * gain from HTTP/2 here.
 *
 * Done through the symbol Node's fetch reads rather than by installing undici,
 * so the Agent is the exact implementation fetch already uses — a separate
 * undici from npm may register a different symbol and silently do nothing.
 */
type Closable = { constructor: new (options: unknown) => unknown; close?: () => Promise<void> };

async function useConnectionsWeCanClose(): Promise<void> {
  // The pool is created on first use. Poke it locally so it exists — this asks
  // for a port nothing listens on and is refused immediately.
  await fetch('http://127.0.0.1:1').catch(() => {});

  // Sort by name explicitly: the default comparator stringifies, and a Symbol
  // cannot be converted to a string implicitly — `.sort()` alone throws.
  // Highest-numbered slot wins; that is the one fetch reads.
  const symbols = Object.getOwnPropertySymbols(globalThis)
    .filter((s) => String(s).startsWith('Symbol(undici.globalDispatcher.'))
    .sort((a, b) => String(a).localeCompare(String(b)));
  const slot = symbols[symbols.length - 1];
  if (!slot) {
    console.warn('[setup] no fetch connection pool found; leaving it alone');
    return;
  }

  const holder = globalThis as unknown as Record<symbol, Closable>;
  const existing = holder[slot];
  const Pool = existing?.constructor;
  if (typeof Pool !== 'function') {
    console.warn('[setup] fetch connection pool is not constructible; leaving it alone');
    return;
  }

  const replacement = new Pool({ allowH2: false }) as Closable;
  holder[slot] = replacement;

  afterAll(async () => {
    await replacement.close?.().catch(() => {});
  });
}

await useConnectionsWeCanClose();
