/**
 * Does the compiled oidc_domain_attestation circuit accept what this server's
 * OIDC builder produces? No Docker, no server, no Google sign-in: synthetic
 * RS256 tokens signed with a fresh key (the circuit does not check WHICH key
 * signed; verifiers do, against the provider's JWKS), built by
 * src/prover/oidcProver.ts, formatted by src/prover/inputFormatter.ts and
 * executed with noir_js -- the same steps bbProver.ts takes before `bb prove`.
 *
 *   npx tsx scripts/check-oidc-inputs.ts <path to oidc_domain_attestation.json>
 *
 * The circuit JSON is required and never guessed: pass the artifact of the
 * circuit version you mean (circuits repo:
 * oidc-domain-attestation/target/oidc_domain_attestation.json). The witness
 * must solve for each accepted case, and must FAIL for each tampered case,
 * which shows the circuit is actually checking the field (a check that
 * accepts everything would pass the first half alone).
 *
 * Exits non-zero on any unexpected result. Needs `env -u NODE_OPTIONS` on a
 * shell whose NODE_OPTIONS preloads a file that no longer exists.
 */
import { readFileSync } from 'fs';
import { generateKeyPairSync, sign } from 'crypto';
import { Noir } from '@noir-lang/noir_js';
import { prepareOidcCircuitInputs } from '../src/prover/oidcProver.js';
import { formatOidcInputs, type OidcCircuitInputs } from '../src/prover/inputFormatter.js';

const circuitPath = process.argv[2];
if (!circuitPath) {
  throw new Error('Usage: npx tsx scripts/check-oidc-inputs.ts <path to oidc_domain_attestation.json>');
}
const circuit = JSON.parse(readFileSync(circuitPath, 'utf8'));
const params = circuit.abi?.parameters as Array<{ name: string; visibility: string }> | undefined;
if (!params) throw new Error(`${circuitPath} has no abi.parameters; is it a compiled Noir circuit?`);
const publicNames = params.filter(p => p.visibility === 'public').map(p => p.name);
const expected = ['pubkey_modulus_limbs', 'domain', 'scope', 'nullifier', 'provider', 'aud_hash', 'nonce_mode', 'nonce_binding', 'now'];
if (publicNames.join(',') !== expected.join(',')) {
  throw new Error(`Public parameters are [${publicNames.join(', ')}], expected the v2 layout [${expected.join(', ')}].`);
}

const GOOGLE_DEVICE = '491923400813-pr17m6kpin2rsbbes18jpb60j1s3qmv4.apps.googleusercontent.com';
const MICROSOFT = '8b09c842-d7a8-4d9c-a6ea-46c797412bac';
const MS_ISS = 'https://login.microsoftonline.com/72f988bf-86f1-41af-91ab-2d7cd011db47/v2.0';
const clock = Math.floor(Date.now() / 1000);

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const baseJwk = publicKey.export({ format: 'jwk' }) as Record<string, string>;

function signJwt(payload: Record<string, unknown>, kid: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = sign('sha256', Buffer.from(`${header}.${body}`), privateKey);
  return `${header}.${body}.${sig.toString('base64url')}`;
}

function kidForHeaderLength(len: number): string {
  for (let n = 1; n < 200; n++) {
    const kid = 'k'.repeat(n);
    if (Buffer.from(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT' })).toString('base64url').length === len) return kid;
  }
  throw new Error(`no kid gives a ${len}-character header`);
}

const google = {
  iss: 'https://accounts.google.com', azp: GOOGLE_DEVICE, aud: GOOGLE_DEVICE, sub: '110169484474386276334',
  hd: 'example.com', email: 'alice@example.com', email_verified: true, iat: clock - 30, exp: clock + 3570,
};
const microsoftPayload = {
  aud: MICROSOFT, iss: MS_ISS, iat: clock - 30, nbf: clock - 30, exp: clock + 3570,
  aio: 'A'.repeat(200), email: 'bob@contoso.com', name: 'Bob', oid: '00000000-0000-0000-0000-000000000001',
  preferred_username: 'bob@contoso.com', rh: '0.ARoAv4j5cvGGr0GRqy180BHbR0IIwJsK', sub: 'abc',
  tid: '72f988bf-86f1-41af-91ab-2d7cd011db47', uti: 'x', ver: '2.0', xms_edov: true,
};

type Tamper = (i: OidcCircuitInputs) => void;
const cases: Array<{ name: string; jwt: string; kid: string; provider?: 'google' | 'microsoft'; tamper?: Tamper }> = [];
for (const len of [50, 63, 64, 127, 128]) {
  const kid = kidForHeaderLength(len);
  cases.push({ name: `google, ${len}-char header`, jwt: signJwt(google, kid), kid });
}
{
  const kid = kidForHeaderLength(63);
  cases.push({ name: 'microsoft work tenant, 200-char aio', jwt: signJwt(microsoftPayload, kid), kid, provider: 'microsoft' });
}
const flip = (bytes: number[], at: number) => { bytes[at] ^= 1; };
const tampered: Array<[string, Tamper]> = [
  ['aud_hash flipped', i => flip(i.aud_hash, 0)],
  ['nonce_mode 1 with the zero binding', i => { i.nonce_mode = 1; }],
  ['nonce_binding nonzero in mode 0', i => flip(i.nonce_binding, 31)],
  ['now = exp', i => { i.now = String(clock + 3570); }],
  ['now = iat - 1', i => { i.now = String(clock - 31); }],
  ['base64_decode_offset + 4', i => { i.base64_decode_offset += 4; }],
];
{
  const kid = kidForHeaderLength(63);
  for (const [name, tamper] of tampered) cases.push({ name: `google, tampered: ${name}`, jwt: signJwt(google, kid), kid, tamper });
}

let failures = 0;
const noir = new Noir(circuit);
for (const c of cases) {
  const built = prepareOidcCircuitInputs({
    jwt: c.jwt,
    jwks: { keys: [{ ...baseJwk, kid: c.kid, alg: 'RS256', use: 'sig' } as never] },
    scope: 'check:oidc-inputs',
    ...(c.provider ? { provider: c.provider } : {}),
  });
  c.tamper?.(built);
  let solved = true;
  let reason = '';
  try {
    await noir.execute(formatOidcInputs(built) as never);
  } catch (error) {
    solved = false;
    reason = error instanceof Error ? error.message : String(error);
  }
  const wanted = !c.tamper;
  const ok = solved === wanted;
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${c.name}: witness ${solved ? 'solved' : `refused (${reason})`}` +
    ` [partial_data ${built.partial_data.len} B, decode offset ${built.base64_decode_offset}]`);
}
console.log(`${cases.length - failures}/${cases.length} as expected against ${circuitPath}`);
process.exit(failures === 0 ? 0 : 1);
