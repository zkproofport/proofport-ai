/**
 * The SDK's OPRF entry points (packages/sdk/src/oprf/index.ts): name rules,
 * the wallet's EIP-712 request signature, the service's environment, and the
 * re-check of an evaluation before it is sent. Real values come from the
 * recorded test-network evaluation (tests/fixtures/oprf-exchange.json).
 *
 * Edge-case rows: boundaries (1 / 256 / 257 bytes, multi-byte), hostile names
 * (control, format, bidi, zero-width, markup, SQL, wildcards), empty /
 * whitespace / null / undefined / non-string separately, deadline past / now /
 * +600 / +601, unknown and production environment, service errors, tampered
 * evaluation values.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { ethers } from 'ethers';
import {
  assertOprfName,
  assertOprfAvailable,
  checkPreparedOprf,
  fetchOprfEnvironment,
  prepareOprf,
  signOprfRequest,
  evaluateOprf,
  OPRF_INPUT_KEYS,
  type PreparedOprf,
} from '../packages/sdk/src/oprf/index.js';
import { oprfNameError } from '@zkproofport-app/core/oprf';
import { fromPrivateKey } from '../packages/sdk/src/signer.js';

const REC = createRequire(import.meta.url)('./fixtures/oprf-exchange.json');
const recorded = (): PreparedOprf => ({
  environment: 'staging',
  circuitId: REC.circuitId,
  address: REC.address,
  oprfDomain: REC.domainName,
  scope: REC.scopeName,
  inputs: { ...REC.result },
});

afterEach(() => vi.unstubAllGlobals());

describe('OPRF names (domain and scope)', () => {
  const ok: [string, string][] = [
    ['one byte', 'a'],
    ['256 ASCII bytes', 'a'.repeat(256)],
    ['85 Hangul syllables = 255 bytes', '가'.repeat(85)],
    ['64 four-byte emoji = 256 bytes', '🔐'.repeat(64)],
    ['a single space (no trimming)', ' '],
    ['surrounding spaces kept', '  app.example.com  '],
    ['markup', '<script>alert(1)</script>'],
    ['SQL-shaped', "x'; DROP TABLE users; --"],
    ['wildcards and escape', '%_\\*?'],
    ['regional-indicator flag', '🇰🇷'],
    ['variation selector', '❤️'],
  ];
  it.each(ok)('accepts %s', (_l, name) => {
    expect(oprfNameError(name)).toBeNull();
    expect(assertOprfName(name, 'scope')).toBe(name);
  });

  const refused: [string, unknown, string][] = [
    ['empty', '', 'empty'],
    ['257 ASCII bytes', 'a'.repeat(257), 'too-long'],
    ['86 Hangul = 258 bytes', '가'.repeat(86), 'too-long'],
    ['65 emoji = 260 bytes', '🔐'.repeat(65), 'too-long'],
    ['null', null, 'not-a-string'],
    ['undefined', undefined, 'not-a-string'],
    ['number', 42, 'not-a-string'],
    ['NUL', 'a\u0000b', 'control-character'],
    ['newline', 'a\nb', 'control-character'],
    ['tab', 'a\tb', 'control-character'],
    ['DEL', 'a\u007fb', 'control-character'],
    ['C1 NEL', 'a\u0085b', 'control-character'],
    ['zero-width joiner emoji', '👩‍💻', 'format-character'],
    ['right-to-left override', 'abc‮def', 'format-character'],
    ['BOM', '﻿app', 'format-character'],
    ['soft hyphen', 'ap­p', 'format-character'],
    ['tag character', 'a\u{E0041}', 'format-character'],
    ['lone surrogate', 'a\uD800b', 'not-utf8'],
  ];
  it.each(refused)('refuses %s', (_l, name, why) => {
    expect(oprfNameError(name)).toBe(why);
    expect(() => assertOprfName(name, 'domain')).toThrow(new RegExp(`cannot name an OPRF nullifier: ${why}`));
  });
});

describe('signOprfRequest (the wallet\'s EIP-712 OprfRequest)', () => {
  const wallet = ethers.Wallet.createRandom();
  const signer = fromPrivateKey(wallet.privateKey);
  const recover = (digest: string, sig: string) => ethers.recoverAddress(digest, sig);
  const now = 1_800_000_000;

  it('signs the typed data whose digest recovers to the wallet', async () => {
    const { signature, digest } = await signOprfRequest(signer, { address: wallet.address, domainName: 'app.example.com', scopeName: '투표 🔐', deadline: now + 600, nowSeconds: now }, recover);
    expect(ethers.recoverAddress(digest, signature)).toBe(wallet.address);
    expect(digest).toBe(ethers.TypedDataEncoder.hash(
      { name: 'TACEO:OPRF', version: '1' },
      { OprfRequest: [{ name: 'statement', type: 'string' }, { name: 'domainName', type: 'string' }, { name: 'scopeName', type: 'string' }, { name: 'deadline', type: 'uint256' }] },
      { statement: 'TACEO:OPRF Request', domainName: 'app.example.com', scopeName: '투표 🔐', deadline: now + 600 },
    ));
  });

  it.each([
    ['deadline passed', now - 1, /has passed/],
    ['deadline 601 s ahead', now + 601, /more than 600 s ahead/],
    ['negative deadline', -1, /non-negative integer/],
    ['fractional deadline', now + 1.5, /non-negative integer/],
  ])('%s: refused before the wallet is asked', async (_l, deadline, re) => {
    const spy = vi.spyOn(signer, 'signTypedData');
    await expect(signOprfRequest(signer, { address: wallet.address, domainName: 'a', scopeName: 'b', deadline, nowSeconds: now }, recover)).rejects.toThrow(re);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('deadline equal to now is accepted (the node\'s inclusive bound)', async () => {
    await expect(signOprfRequest(signer, { address: wallet.address, domainName: 'a', scopeName: 'b', deadline: now, nowSeconds: now }, recover)).resolves.toBeTruthy();
  });

  it.each([['domainName', { domainName: 'a\nb', scopeName: 'b' }], ['scopeName', { domainName: 'a', scopeName: '' }]])(
    'a refused %s never reaches the wallet', async (_l, names) => {
      const spy = vi.spyOn(signer, 'signTypedData');
      await expect(signOprfRequest(signer, { address: wallet.address, ...names, deadline: now, nowSeconds: now }, recover)).rejects.toThrow(/cannot name an OPRF nullifier/);
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    },
  );

  it('a signature from another wallet is refused', async () => {
    const other = ethers.Wallet.createRandom();
    await expect(signOprfRequest(fromPrivateKey(other.privateKey), { address: wallet.address, domainName: 'a', scopeName: 'b', deadline: now, nowSeconds: now }, recover)).rejects.toThrow(/signed by/);
  });
});

describe('the service\'s OPRF environment (GET /api/v1/oprf)', () => {
  const config = { baseUrl: 'https://svc.test' };
  const stub = (status: number, body: unknown, raw = false) =>
    vi.stubGlobal('fetch', vi.fn(async () => new Response(raw ? (body as string) : JSON.stringify(body), { status })));

  it.each(['staging', 'local', 'production'])('reads %s', async env => {
    stub(200, { environment: env });
    await expect(fetchOprfEnvironment(config)).resolves.toBe(env);
  });

  it.each([['prod'], ['Staging'], [''], [null], [undefined]])('refuses an unknown environment %j', async env => {
    stub(200, { environment: env });
    await expect(fetchOprfEnvironment(config)).rejects.toThrow(/Known: production, staging, local/);
  });

  it('a 503 is reported with the service\'s message', async () => {
    stub(503, { error: 'OPRF_NOT_CONFIGURED', message: 'OPRF_ENVIRONMENT is not set on this service' });
    await expect(fetchOprfEnvironment(config)).rejects.toThrow(/OPRF_ENVIRONMENT is not set/);
  });

  it('a non-JSON error body is reported by status', async () => {
    stub(502, '<html>bad gateway</html>', true);
    await expect(fetchOprfEnvironment(config)).rejects.toThrow(/HTTP 502/);
  });

  it('an unreachable service is reported', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    await expect(fetchOprfEnvironment(config)).rejects.toThrow(/Could not reach .*ECONNREFUSED/);
  });

  it('production: prepareOprf refuses by name and opens no socket', async () => {
    stub(200, { environment: 'production' });
    const webSocket = vi.fn();
    await expect(prepareOprf(config, { circuitId: 'coinbase_attestation', address: REC.address, oprfDomain: 'a', scope: 'b', webSocket }))
      .rejects.toThrow(/No OPRF network is registered for the 'production' environment/);
    expect(webSocket).not.toHaveBeenCalled();
  });

  it('a refused name is refused before the service is asked', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await expect(prepareOprf(config, { circuitId: 'coinbase_attestation', address: REC.address, oprfDomain: undefined, scope: 'b' })).rejects.toThrow(/oprfDomain is required/);
    await expect(prepareOprf(config, { circuitId: 'coinbase_attestation', address: REC.address, oprfDomain: 'a', scope: '   ​' })).rejects.toThrow(/format-character/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([
    ['OIDC', 'staging', 'oidc_domain_attestation', /has no OPRF nullifier/],
    ['unknown circuit', 'staging', 'nope', /Unknown circuit/],
    ['production', 'production', 'coinbase_attestation', /No OPRF network/],
    ['unknown environment', 'prod', 'coinbase_attestation', /Unknown OPRF environment/],
  ])('assertOprfAvailable refuses %s', (_l, env, circuit, re) => {
    expect(() => assertOprfAvailable(env, circuit)).toThrow(re);
  });

  it('evaluateOprf refuses production before any socket', async () => {
    const webSocket = vi.fn();
    await expect(evaluateOprf({ environment: 'production', circuitId: 'coinbase_attestation', address: REC.address, domainName: 'a', scopeName: 'b', webSocket }))
      .rejects.toThrow(/production/);
    expect(webSocket).not.toHaveBeenCalled();
  });
});

describe('checkPreparedOprf (re-verifies an evaluation before it is sent)', () => {
  const expectFor = { circuitId: REC.circuitId, address: REC.address, scope: REC.scopeName };

  it('accepts the recorded real evaluation and returns its 11 values unchanged', () => {
    expect(checkPreparedOprf(recorded(), expectFor)).toEqual(REC.result);
    expect(Object.keys(REC.result).sort()).toEqual([...OPRF_INPUT_KEYS].sort());
  });

  it('accepts the wallet address in another letter case', () => {
    expect(() => checkPreparedOprf(recorded(), { ...expectFor, address: REC.address.toUpperCase().replace('0X', '0x') })).not.toThrow();
  });

  it.each(OPRF_INPUT_KEYS.map(k => [k]))('a changed %s is refused', key => {
    const p = recorded();
    const v = BigInt((p.inputs as unknown as Record<string, string>)[key]);
    (p.inputs as unknown as Record<string, string>)[key] = '0x' + (v ^ 1n).toString(16).padStart(64, '0');
    expect(() => checkPreparedOprf(p, expectFor)).toThrow();
  });

  it.each([
    ['missing', undefined, /missing: call prepareOprf/],
    ['for another circuit', { ...recorded(), circuitId: 'giwa_attestation' }, /made for giwa_attestation/],
    ['for another wallet', { ...recorded(), address: '0x' + '11'.repeat(20) }, /made for wallet/],
    ['for another scope', { ...recorded(), scope: 'other' }, /made for scope/],
    ['for another domain (same values)', { ...recorded(), oprfDomain: 'other.example' }, /Chaum-Pedersen|does not match/],
    ['under production', { ...recorded(), environment: 'production' as const }, /No OPRF key is registered for the 'production'/],
    ['uppercase hex', { ...recorded(), inputs: { ...REC.result, nullifier: REC.result.nullifier.toUpperCase().replace('0X', '0x') } }, /lowercase hex/],
    ['a short value', { ...recorded(), inputs: { ...REC.result, oprf_beta: '0x01' } }, /oprf_beta must be/],
    ['a missing value', { ...recorded(), inputs: { ...REC.result, oprf_dlog_s: undefined } }, /oprf_dlog_s must be/],
  ])('an evaluation %s is refused', (_l, p, re) => {
    expect(() => checkPreparedOprf(p, expectFor)).toThrow(re as RegExp);
  });
});
