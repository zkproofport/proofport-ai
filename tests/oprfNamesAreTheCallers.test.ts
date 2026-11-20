/**
 * User decisions 2026-11-20: nothing about a proof's names is filled in by us.
 *
 * - scope: required from the caller, every circuit; no 'proofport' default.
 * - oprfDomain: the caller's; ONLY when omitted AND running in a browser on a
 *   real http(s) page is it the page's hostname, lowercased. Omitted on a
 *   server / in Node (the MCP always) -> error naming oprfDomain. Never an IP.
 * - The nitro enclave pins the OPRF key hash for its own environment.
 * - Node 22+ (global WebSocket) for the SDK and MCP; no fallback transport.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { browserOprfDomain, resolveOprfDomain, requireOprfScope, prepareOprf } from '../packages/sdk/src/oprf/index.js';
import { defaultWebSocketFactory } from '../packages/sdk/src/oprf/transport.js';
import { generateProof } from '../packages/sdk/src/flow.js';
import { enclaveOprfInputs } from '../src/aws/enclaveOprf.js';
import { oprfWireInputs } from './helpers/oprfInputs.js';

const ROOT = join(import.meta.dirname, '..');
const req = createRequire(import.meta.url);

/** A browser-shaped global: window is itself, a document, a location. */
function browser(location: { protocol: string; hostname: string } | undefined, opts: { document?: unknown; windowIsSelf?: boolean } = {}) {
  const g: Record<string, unknown> = { document: 'document' in opts ? opts.document : {}, location };
  g.window = opts.windowIsSelf === false ? {} : g;
  return g;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('oprfDomain: the caller\'s, or the page hostname in a browser, else an error', () => {
  it.each([
    ['https page', { protocol: 'https:', hostname: 'app.example.com' }, 'app.example.com'],
    ['http page', { protocol: 'http:', hostname: 'app.example.com' }, 'app.example.com'],
    ['mixed-case hostname is lowercased', { protocol: 'https:', hostname: 'App.Example.COM' }, 'app.example.com'],
    ['localhost is a hostname', { protocol: 'http:', hostname: 'localhost' }, 'localhost'],
    ['punycode host as the browser reports it', { protocol: 'https:', hostname: 'xn--3e0b707e.example' }, 'xn--3e0b707e.example'],
  ])('omitted in a browser on an %s: filled from the hostname', (_l, location, want) => {
    expect(browserOprfDomain(browser(location))).toBe(want);
    expect(resolveOprfDomain(undefined, browser(location))).toBe(want);
  });

  it.each([
    ['Node / a server (no window, no document)', {}],
    ['a file: page', browser({ protocol: 'file:', hostname: '' })],
    ['an extension page', browser({ protocol: 'chrome-extension:', hostname: 'abcdef' })],
    ['a data: page', browser({ protocol: 'data:', hostname: '' })],
    ['an IPv4 host', browser({ protocol: 'https:', hostname: '203.0.113.7' })],
    ['an IPv6 host', browser({ protocol: 'http:', hostname: '[::1]' })],
    ['an IPv6 host without brackets', browser({ protocol: 'http:', hostname: '::1' })],
    ['an empty hostname', browser({ protocol: 'https:', hostname: '' })],
    ['no location', browser(undefined)],
    ['a location but no document (a worker or a polyfilled server)', browser({ protocol: 'https:', hostname: 'app.example.com' }, { document: undefined })],
    ['a window object that is not the global (spoofed)', browser({ protocol: 'https:', hostname: 'app.example.com' }, { windowIsSelf: false })],
  ])('omitted in %s: refused, naming oprfDomain, nothing filled in', (_l, g) => {
    expect(browserOprfDomain(g)).toBeNull();
    expect(() => resolveOprfDomain(undefined, g)).toThrow(/oprfDomain is required/);
  });

  it('this test process is Node: omitted is refused', () => {
    expect(() => resolveOprfDomain(undefined)).toThrow(/oprfDomain is required/);
  });

  it('the caller\'s value wins over the page hostname', () => {
    expect(resolveOprfDomain('other.example', browser({ protocol: 'https:', hostname: 'app.example.com' }))).toBe('other.example');
  });

  it.each([[''], ['a\nb'], [null], [42], ['x'.repeat(257)]])('a given but invalid value %j is refused even in a browser (no fallback to the hostname)', v => {
    expect(() => resolveOprfDomain(v, browser({ protocol: 'https:', hostname: 'app.example.com' }))).toThrow(/cannot name an OPRF nullifier/);
  });

  it('a hostname over 256 bytes is refused by the name rule, not cut', () => {
    const host = 'a'.repeat(250) + '.example';
    expect(() => resolveOprfDomain(undefined, browser({ protocol: 'https:', hostname: host }))).toThrow(/too-long/);
  });

  it('prepareOprf (step-by-step SDK) applies the same rule before asking the service', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await expect(prepareOprf({ baseUrl: 'https://svc.test' }, { circuitId: 'coinbase_attestation', address: '0x' + '11'.repeat(20), oprfDomain: undefined, scope: 's' }))
      .rejects.toThrow(/oprfDomain is required/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('scope: required, never "proofport"', () => {
  it('undefined is refused naming scope', () => {
    expect(() => requireOprfScope(undefined)).toThrow(/scope is required/);
  });
  it.each([[''], [null], [' ​'], ['x'.repeat(257)]])('%j is refused by the name rules', v => {
    expect(() => requireOprfScope(v)).toThrow(/cannot name an OPRF nullifier/);
  });
  it('a single space is a name (no trimming)', () => {
    expect(requireOprfScope(' ')).toBe(' ');
  });

  it.each([
    ['coinbase_kyc', { circuit: 'coinbase_kyc', oprfDomain: 'app.example.com' }],
    ['giwa_attestation', { circuit: 'giwa_attestation', oprfDomain: 'app.example.com' }],
    ['human_passport', { circuit: 'human_passport', oprfDomain: 'app.example.com', minScore: 20, chain: 8453 }],
    ['oidc_domain', { circuit: 'oidc_domain', jwt: 'a.b.c' }],
  ])('generateProof %s without scope: refused before any signature or request', async (_l, params) => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const signer = { getAddress: vi.fn(async () => '0x' + '11'.repeat(20)), signMessage: vi.fn(), signTypedData: vi.fn() };
    await expect(generateProof({ baseUrl: 'https://svc.test' }, { attestation: signer as never }, params as never)).rejects.toThrow(/scope is required/);
    expect(signer.signMessage).not.toHaveBeenCalled();
    expect(signer.getAddress).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('generateProof on Node without oprfDomain: refused naming oprfDomain before signing', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const signer = { getAddress: vi.fn(async () => '0x' + '11'.repeat(20)), signMessage: vi.fn() };
    await expect(generateProof({ baseUrl: 'https://svc.test' }, { attestation: signer as never }, { circuit: 'coinbase_kyc', scope: 's' }))
      .rejects.toThrow(/oprfDomain is required/);
    expect(signer.signMessage).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('nitro enclave pins the OPRF key hash for its own environment', () => {
  it('staging with the pinned hash: the values pass, lower-cased', () => {
    const out = enclaveOprfInputs('staging', 'coinbase_attestation', oprfWireInputs());
    expect(out.oprf_key_hash).toBe(oprfWireInputs().oprf_key_hash);
  });
  it('another key hash is refused', () => {
    const wrong = '0x' + '1'.padStart(64, '0');
    expect(() => enclaveOprfInputs('staging', 'coinbase_attestation', oprfWireInputs({ oprf_key_hash: wrong }))).toThrow(/key hash/i);
  });
  it('production (no key) is refused by name', () => {
    expect(() => enclaveOprfInputs('production', 'coinbase_attestation', oprfWireInputs())).toThrow(/production/);
  });
  it('an unset environment is refused naming OPRF_ENVIRONMENT', () => {
    expect(() => enclaveOprfInputs(undefined, 'coinbase_attestation', oprfWireInputs())).toThrow(/OPRF_ENVIRONMENT/);
  });
  it.each([['prod'], ['Staging'], ['']])('an unknown environment %j is refused', env => {
    expect(() => enclaveOprfInputs(env, 'coinbase_attestation', oprfWireInputs())).toThrow(/OPRF_ENVIRONMENT must be one of/);
  });
  it('a malformed value is still refused', () => {
    expect(() => enclaveOprfInputs('staging', 'coinbase_attestation', oprfWireInputs({ oprf_beta: '0x01' }))).toThrow(/oprf_beta/);
  });
  it('the enclave server converts every SDK-format request through it, with its own environment', () => {
    const src = readFileSync(join(ROOT, 'src/aws/enclave-server.ts'), 'utf8');
    expect(src).toContain('oprf: enclaveOprfInputs(process.env.OPRF_ENVIRONMENT, circuitId, inputs)');
    expect(src).not.toMatch(/OPRF_INPUT_KEYS\.map\(k => \[k, inputs\[k\]\]\)/);
  });
});

describe('Node 22+: a global WebSocket, no fallback transport', () => {
  it('without a global WebSocket the OPRF step fails naming the Node requirement', () => {
    vi.stubGlobal('WebSocket', undefined);
    expect(() => defaultWebSocketFactory()).toThrow(/Node\.js >= 22\.0\.0.*no fallback transport/is);
  });
  it('with one it is used', () => {
    const WS = vi.fn();
    vi.stubGlobal('WebSocket', WS);
    defaultWebSocketFactory()('wss://x.test/api/m/oprf');
    expect(WS).toHaveBeenCalledWith('wss://x.test/api/m/oprf');
  });
  it('the SDK and MCP packages, and their lockfile entries, require Node >= 22.0.0', () => {
    const lock = req('../package-lock.json');
    for (const pkg of ['sdk', 'mcp']) {
      expect(req(`../packages/${pkg}/package.json`).engines).toEqual({ node: '>=22.0.0' });
      expect(lock.packages[`packages/${pkg}`].engines).toEqual({ node: '>=22.0.0' });
    }
  });
  it('the server package and its lockfile entry require Node >= 22.0.0', () => {
    expect(req('../package.json').engines).toEqual({ node: '>=22.0.0' });
    expect(req('../package-lock.json').packages[''].engines).toEqual({ node: '>=22.0.0' });
  });
  it('CI, the emergency deploy, the server image and the enclave image run Node 22, never 20', () => {
    const read = (f: string) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
    for (const f of ['.github/workflows/ci.yml', '.github/workflows/emergency-deploy.yml']) {
      const versions = [...read(f).matchAll(/node-version:\s*'(\d+)'/g)].map(m => m[1]);
      expect(versions.length, f).toBeGreaterThan(0);
      for (const v of versions) expect(v, f).toBe('22');
    }
    const server = read('Dockerfile');
    expect(server).toMatch(/^FROM node:22-slim AS builder$/m);
    expect(server).toContain('deb.nodesource.com/setup_22.x');
    expect(read('aws/Dockerfile.enclave')).toContain('deb.nodesource.com/setup_22.x');
    for (const f of ['Dockerfile', 'aws/Dockerfile.enclave']) {
      expect(read(f), f).not.toMatch(/setup_20\.x|node:20/);
    }
  });
});
