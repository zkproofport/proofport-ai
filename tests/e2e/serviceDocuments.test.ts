/**
 * The documents the service publishes about itself, against a real deployment.
 *
 * `GET /`, `GET /openapi.json`, `GET /.well-known/did.json` and `GET /docs`
 * had no coverage at all. Each of them is a promise made to a caller who has
 * not connected yet — a list of endpoints, a spec, an identity — and a promise
 * nothing checks is one that drifts.
 *
 * Two of these would have caught real defects from 2026-09-05:
 *
 *   - The deploy's own discovery check asserted fields that do not exist
 *     (`protocolVersion` on the OASF document, a top-level `name` on the MCP
 *     one, a `/identity/status` route that has never existed). It printed FAIL
 *     and exited 0 for months, so nobody saw it. Reading the spec and following
 *     what it declares is how that stops being invisible.
 *   - The first GCP production deploy ran on testnet under a hostname called
 *     `ai`: chain 11155111 while the agent's registrations were meant to be on
 *     mainnet. Nothing compared the two documents, so nothing objected. The
 *     chain agreement below is that comparison, and it works on either
 *     environment because it asserts they MATCH rather than naming a chain.
 *
 * Run: E2E_BASE_URL=https://stg-ai.zkproofport.app npx vitest run --project e2e
 */
import { describe, it, expect, beforeAll } from 'vitest';

const BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:4002';
const HOST = new URL(BASE_URL).host;

async function getJson(path: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${BASE_URL}${path}`);
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // left as text — the assertions say which they expect
  }
  return { status: res.status, body };
}

describe('service documents', () => {
  beforeAll(async () => {
    const res = await fetch(`${BASE_URL}/health`, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`${BASE_URL} is not healthy (HTTP ${res.status})`);
  });

  // Everything below asserts that a path ANSWERS. That means nothing unless an
  // unknown path does not, so establish it first.
  it('does not answer an unknown path, so the checks below mean something', async () => {
    const { status } = await getJson('/.well-known/there-is-no-such-document.json');
    expect(status).toBe(404);
  });

  describe('GET / — the index a caller reads first', () => {
    it('names the agent, and the name matches the A2A card', async () => {
      const index = (await getJson('/')).body as { name?: string };
      const card = (await getJson('/.well-known/agent-card.json')).body as { name?: string };
      expect(index.name).toBeTruthy();
      expect(index.name).toBe(card.name);
    });

    it('advertises only endpoints that answer', async () => {
      const { body } = await getJson('/');
      const { endpoints } = body as { endpoints: Record<string, unknown> };
      expect(endpoints).toBeTruthy();

      // The map nests one level: discovery holds a group of its own.
      const paths: string[] = [];
      for (const value of Object.values(endpoints)) {
        if (typeof value === 'string') paths.push(value);
        else if (value && typeof value === 'object') {
          for (const nested of Object.values(value as Record<string, unknown>)) {
            if (typeof nested === 'string') paths.push(nested);
          }
        }
      }
      expect(paths.length).toBeGreaterThan(0);

      // POST-only endpoints are listed here too. `/a2a` is JSON-RPC and
      // answers 404 to a GET, which is correct and not the same as absent — so
      // a path only counts as missing when it is absent for BOTH methods.
      const missing: string[] = [];
      for (const path of paths) {
        if ((await fetch(`${BASE_URL}${path}`)).status !== 404) continue;
        const posted = await fetch(`${BASE_URL}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        });
        if (posted.status === 404) missing.push(`${path} → 404 on GET and POST`);
      }
      expect(missing).toEqual([]);
    });
  });

  describe('GET /openapi.json — the spec must not describe a service that is not there', () => {
    it('is an OpenAPI 3 document with a title', async () => {
      const { status, body } = await getJson('/openapi.json');
      expect(status).toBe(200);
      const spec = body as { openapi?: string; info?: { title?: string }; paths?: object };
      expect(spec.openapi).toMatch(/^3\./);
      expect(spec.info?.title).toBeTruthy();
      expect(Object.keys(spec.paths ?? {}).length).toBeGreaterThan(0);
    });

    it('every path it declares as a GET actually answers', async () => {
      const { body } = await getJson('/openapi.json');
      const { paths } = body as { paths: Record<string, Record<string, unknown>> };

      const missing: string[] = [];
      for (const [path, operations] of Object.entries(paths)) {
        if (!operations.get) continue;
        if (path.includes('{')) continue; // templated; no value to substitute here
        const res = await fetch(`${BASE_URL}${path}`);
        if (res.status === 404) missing.push(`${path} → 404`);
      }
      expect(missing).toEqual([]);
    });
  });

  describe('GET /.well-known/did.json — the published identity', () => {
    it('is a did:web for the host it is served from', async () => {
      const { status, body } = await getJson('/.well-known/did.json');
      expect(status).toBe(200);
      const doc = body as {
        id: string;
        verificationMethod: { id: string; controller: string; blockchainAccountId: string }[];
        service: { serviceEndpoint: string }[];
      };
      expect(doc.id).toBe(`did:web:${HOST}`);
      expect(doc.verificationMethod[0].controller).toBe(doc.id);
      expect(doc.verificationMethod[0].id.startsWith(doc.id)).toBe(true);
      expect(doc.service[0].serviceEndpoint).toBe(`https://${HOST}`);
    });

    it('names the same chain the agent is registered on', async () => {
      // This is the assertion that a testnet deployment behind a production
      // hostname fails. It compares two documents rather than naming a chain,
      // so it holds on staging and production alike.
      const did = (await getJson('/.well-known/did.json')).body as {
        verificationMethod: { blockchainAccountId: string }[];
      };
      const registration = (await getJson('/.well-known/agent-registration.json')).body as {
        registrations: { agentRegistry: string }[];
      };

      // Both are CAIP-10 / CAIP-2 shaped: eip155:<chain>:<address>.
      const didChain = did.verificationMethod[0].blockchainAccountId.split(':')[1];
      const registeredChains = registration.registrations.map((r) => r.agentRegistry.split(':')[1]);

      expect(registeredChains.length).toBeGreaterThan(0);
      expect(registeredChains).toContain(didChain);
    });
  });

  describe('GET /docs — the human-readable API reference', () => {
    it('serves the reference, following its redirect to the trailing slash', async () => {
      const res = await fetch(`${BASE_URL}/docs`, { redirect: 'follow' });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/text\/html/);
      expect(await res.text()).toMatch(/swagger|openapi/i);
    });
  });
});
