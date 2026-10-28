/**
 * The provider-key statement of oidc_domain_attestation (circuits
 * `oidc-domain-attestation/src/provider_key.nr`, README "Provider-key
 * statement"; fix list item 12 in .claude/agents/circuits-dev.md).
 *
 * The RSA modulus is a public input, and the circuit's RSA check only says the
 * token was signed by THAT key. A self-made key and a self-signed token would
 * verify unless someone compared the modulus with Google's / Microsoft's
 * published keys -- which a contract cannot fetch. So the circuit also
 * requires a P-256 signature, by the phone (App Attest) or by this server
 * (Cloud KMS, signer kind 2), over:
 *
 *   off  len  field
 *     0   16  "ZKProofport/PK/1"
 *    16   32  keccak256("oidc_domain_attestation")
 *    48    1  provider (0 Google, 1 Microsoft) = public `provider`
 *    49    8  unix seconds, big-endian       = public `now`
 *    57  256  the RSA modulus n, big-endian (the JWKS `n`, base64url-decoded)
 *   313
 *
 * This server signs only after it has itself found that modulus in the
 * provider's published key list, through @zkproofport-app/core's
 * checkOidcProviderKey -- the same fetch and the same acceptance rules every
 * ZKProofport verifier applies, so the server vouches for exactly what a
 * verifier would accept. Everything here runs BEFORE any payment.
 */
import { ethers } from 'ethers';
import {
  checkOidcProviderKey,
  OIDC_DOMAIN_ATTESTATION_PUBLIC_INPUT_LAYOUT as LAYOUT,
  OIDC_PUBLIC_INPUT_COUNT as CORE_OIDC_PUBLIC_INPUT_COUNT,
} from '@zkproofport-app/core';
import { createLogger } from '../logger.js';
import { CIRCUIT_IDS } from '../config/circuitIds.js';
import { signStatement, StatementRefusal, type StatementSigner } from './statementSigner.js';
import { oidcStatementSubject, type OidcProvePayload, type OidcProviderKeyStatement } from '../prover/oidcProver.js';

export type { OidcProviderKeyStatement };

const log = createLogger('OidcStatement');

export const OIDC_STATEMENT_LEN = 313;
const MAGIC = new TextEncoder().encode('ZKProofport/PK/1');
const MODULUS_LEN = 256;
const LIMB_BITS = 120n;
const LIMB_COUNT = 18;

/** keccak256("oidc_domain_attestation"): the canonical id. */
export const oidcCircuitTag = (): Uint8Array =>
  ethers.getBytes(ethers.keccak256(ethers.toUtf8Bytes(CIRCUIT_IDS.OIDC_DOMAIN_ATTESTATION)));

/**
 * The JWKS `n` as exactly 256 big-endian bytes. Leading zero bytes are
 * dropped (an encoder may keep the sign byte); anything that is not then a
 * 2048-bit modulus -- shorter, longer, top bit clear -- is refused, because
 * the circuit verifies RSA-2048 only and would refuse it after payment.
 */
export function providerKeyModulusBytes(nB64url: unknown): Uint8Array {
  if (typeof nB64url !== 'string' || !/^[A-Za-z0-9_-]+$/.test(nB64url) || nB64url.length % 4 === 1) {
    throw new StatementRefusal('OIDC_PROVIDER_KEY_INVALID', 'The JWKS key `n` is not base64url.');
  }
  let n = ethers.getBytes(ethers.decodeBase64(nB64url.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (nB64url.length % 4)) % 4)));
  let start = 0;
  while (n.length - start > MODULUS_LEN && n[start] === 0) start++;
  n = n.slice(start);
  if (n.length !== MODULUS_LEN || (n[0] & 0x80) === 0) {
    throw new StatementRefusal(
      'OIDC_PROVIDER_KEY_INVALID',
      `The JWKS key is not a 2048-bit RSA modulus (${n.length} bytes${n.length === MODULUS_LEN ? ', top bit clear' : ''}); the circuit verifies RSA-2048 only.`,
    );
  }
  return n;
}

/** The 313 bytes the circuit rebuilds from its public inputs (provider_key.nr). */
export function buildProviderKeyStatement(provider: number, now: bigint, modulus: Uint8Array): Uint8Array {
  if (provider !== 0 && provider !== 1) throw new Error(`Unknown OIDC provider value ${provider}. Known: 0 (Google), 1 (Microsoft).`);
  if (now < 0n || now >= 1n << 64n) throw new Error(`now ${now} is not a u64`);
  if (modulus.length !== MODULUS_LEN) throw new Error(`modulus is ${modulus.length} bytes, expected ${MODULUS_LEN}`);
  const time = new Uint8Array(8);
  new DataView(time.buffer).setBigUint64(0, now, false);
  const out = ethers.getBytes(ethers.concat([MAGIC, oidcCircuitTag(), new Uint8Array([provider]), time, modulus]));
  if (out.length !== OIDC_STATEMENT_LEN) throw new Error(`provider-key statement is ${out.length} bytes, expected ${OIDC_STATEMENT_LEN}`);
  return out;
}

/** Is `modulus` in `provider`'s published key list right now? */
export type ProviderKeyCheck = (provider: number, modulus: Uint8Array) => Promise<{ ok: true } | { ok: false; error: string }>;

/**
 * core's checkOidcProviderKey, which reads a proof's public inputs. Only the
 * two fields it reads are filled -- the provider and the modulus limbs -- in
 * core's own layout; the rest stay zero.
 */
export const coreProviderKeyCheck: ProviderKeyCheck = async (provider, modulus) => {
  const inputs: string[] = new Array(CORE_OIDC_PUBLIC_INPUT_COUNT).fill('0');
  let n = BigInt(ethers.hexlify(modulus));
  const mask = (1n << LIMB_BITS) - 1n;
  for (let i = 0; i < LIMB_COUNT; i++) {
    inputs[LAYOUT.PUBKEY_MODULUS_START + i] = (n & mask).toString();
    n >>= LIMB_BITS;
  }
  inputs[LAYOUT.PROVIDER] = String(provider);
  return checkOidcProviderKey(inputs);
};

/**
 * Validate the token as the prover will, check its key against the live key
 * list, and sign the provider-key statement for the `now` the proof will
 * carry. Refuses (StatementRefusal, before payment) a token the prover would
 * refuse, a key that is not RSA-2048, and a key the provider does not publish;
 * a key-list fetch that fails refuses too -- nothing is ever signed from a
 * value this server did not just confirm. A KMS failure or a signature that
 * does not verify throws (500), also before payment.
 */
export async function prepareOidcProviderKeyStatement(
  payload: OidcProvePayload,
  deps: { signer: StatementSigner; checkProviderKey?: ProviderKeyCheck; now?: () => number },
): Promise<OidcProviderKeyStatement> {
  const clockSeconds = Math.floor((deps.now ?? Date.now)() / 1000);
  let subject: ReturnType<typeof oidcStatementSubject>;
  try {
    subject = oidcStatementSubject(payload, clockSeconds);
  } catch (e) {
    throw new StatementRefusal('OIDC_TOKEN_REFUSED', (e as Error).message);
  }
  const modulus = providerKeyModulusBytes(subject.modulusB64url);
  const check = await (deps.checkProviderKey ?? coreProviderKeyCheck)(subject.provider, modulus);
  if (!check.ok) {
    log.warn({ action: 'oidc.statement.key_refused', provider: subject.provider, kid: subject.kid, reason: check.error }, 'Provider key not confirmed');
    throw new StatementRefusal('OIDC_PROVIDER_KEY_UNPUBLISHED', check.error);
  }
  const statement = buildProviderKeyStatement(subject.provider, subject.now, modulus);
  const signature = await signStatement(deps.signer, statement);
  log.info({ action: 'oidc.statement.signed', provider: subject.provider, kid: subject.kid, now: subject.now.toString() }, 'Provider-key statement signed');
  return { now: subject.now.toString(), modulus: ethers.hexlify(modulus), signature: ethers.hexlify(signature) };
}
