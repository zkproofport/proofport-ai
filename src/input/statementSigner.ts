/**
 * The server's statement signer: one Cloud KMS P-256 key that the circuits
 * pin (circuits `statement-signer/src/server_key.nr`).
 *
 * It signs two kinds of statement, and the circuits tell them apart by magic,
 * circuit tag and length:
 *   - "ZKProofport/AA/1", 225 bytes: coinbase_attestation v2, the attestation
 *     was unrevoked (./coinbaseStatement.ts);
 *   - "ZKProofport/PK/1", 313 bytes: oidc_domain_attestation, the RSA key a
 *     token was checked with is in the provider's published key list
 *     (./oidcStatement.ts).
 * The environment variable keeps its first name, COINBASE_STATEMENT_KMS_KEY:
 * the deploy workflow and both Cloud Run services already set it, and the key
 * behind it is the one both circuits pin.
 */
import { ethers } from 'ethers';

const P256_N = BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551');
const P256_HALF_N = P256_N >> 1n;

/** Signs a SHA-256 digest with ECDSA P-256 and returns DER, as Cloud KMS does. */
export interface StatementSigner {
  /** DER ECDSA-Sig-Value over `digest` (32 bytes). */
  signDigest(digest: Uint8Array): Promise<Uint8Array>;
  /** The signing key's public key, SPKI PEM. */
  publicKeyPem(): Promise<string>;
}

/** A refusal the caller can act on; mapped to 4xx, raised before payment. */
export class StatementRefusal extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

/**
 * DER ECDSA-Sig-Value -> r || s (32 bytes each, big-endian), s in low form.
 * The circuit's P-256 black box refuses s > n/2 and Google's documentation
 * says nothing about normalising it.
 */
export function derToLowSRawSignature(der: Uint8Array): Uint8Array {
  const fail = (why: string): never => { throw new Error(`Malformed DER ECDSA signature: ${why}`); };
  if (der.length < 8 || der[0] !== 0x30) fail('not a SEQUENCE');
  let p = 2;
  if (der[1] & 0x80) fail('long-form length');
  if (der[1] !== der.length - 2) fail('SEQUENCE length does not match');
  const readInt = (): bigint => {
    if (der[p] !== 0x02) fail('expected INTEGER');
    const len = der[p + 1];
    if (len === 0 || len > 33 || p + 2 + len > der.length) fail('bad INTEGER length');
    const bytes = der.slice(p + 2, p + 2 + len);
    p += 2 + len;
    return BigInt(ethers.hexlify(bytes));
  };
  const r = readInt();
  let s = readInt();
  if (p !== der.length) fail('trailing bytes');
  if (r <= 0n || r >= P256_N || s <= 0n || s >= P256_N) fail('r or s out of range');
  if (s > P256_HALF_N) s = P256_N - s;
  return ethers.getBytes(ethers.concat([ethers.toBeHex(r, 32), ethers.toBeHex(s, 32)]));
}

/** Verifies r || s over SHA256(message) with a P-256 SPKI key (node:crypto). */
export async function verifyRawP256(publicKeyPem: string, message: Uint8Array, raw: Uint8Array): Promise<boolean> {
  const { createPublicKey, verify } = await import('node:crypto');
  const key = createPublicKey(publicKeyPem);
  const jwk = key.export({ format: 'jwk' }) as { kty?: string; crv?: string };
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256') {
    throw new Error(`Statement key must be EC P-256, got ${jwk.kty} ${jwk.crv ?? ''}`);
  }
  return verify('sha256', message, { key, dsaEncoding: 'ieee-p1363' }, raw);
}

/**
 * Sign `statement` the way every circuit using statement-signer checks it:
 * KMS signs SHA256(statement), DER becomes r || s with s in low form, and the
 * result must verify under the key's own public key before anything proves
 * with it. Returns the 64-byte r || s.
 */
export async function signStatement(signer: StatementSigner, statement: Uint8Array): Promise<Uint8Array> {
  const digest = ethers.getBytes(ethers.sha256(statement));
  const signature = derToLowSRawSignature(await signer.signDigest(digest));
  if (!(await verifyRawP256(await signer.publicKeyPem(), statement, signature))) {
    throw new Error('The statement signature does not verify under the signing key; refusing to prove with it');
  }
  return signature;
}

/** Cloud KMS EC_SIGN_P256_SHA256 key version, used through asymmetricSign. */
export class KmsStatementSigner implements StatementSigner {
  private pem?: Promise<string>;
  private client?: Promise<import('@google-cloud/kms').KeyManagementServiceClient>;

  constructor(private readonly keyVersionName: string) {
    if (!/^projects\/[^/]+\/locations\/[^/]+\/keyRings\/[^/]+\/cryptoKeys\/[^/]+\/cryptoKeyVersions\/\d+$/.test(keyVersionName)) {
      throw new Error(
        `COINBASE_STATEMENT_KMS_KEY must be a key version: projects/P/locations/L/keyRings/R/cryptoKeys/K/cryptoKeyVersions/V (got '${keyVersionName}')`,
      );
    }
  }

  private kms() {
    this.client ??= import('@google-cloud/kms').then(m => new m.KeyManagementServiceClient());
    return this.client;
  }

  async publicKeyPem(): Promise<string> {
    this.pem ??= (async () => {
      const [key] = await (await this.kms()).getPublicKey({ name: this.keyVersionName });
      if (key.algorithm !== 'EC_SIGN_P256_SHA256') {
        throw new Error(`${this.keyVersionName} is ${String(key.algorithm)}; the circuit verifies EC_SIGN_P256_SHA256`);
      }
      if (!key.pem) throw new Error(`Cloud KMS returned no public key for ${this.keyVersionName}`);
      return key.pem;
    })();
    try {
      return await this.pem;
    } catch (e) {
      this.pem = undefined; // a transient failure must not be cached for the process lifetime
      throw e;
    }
  }

  async signDigest(digest: Uint8Array): Promise<Uint8Array> {
    if (digest.length !== 32) throw new Error(`SHA-256 digest is ${digest.length} bytes, not 32`);
    const [res] = await (await this.kms()).asymmetricSign({ name: this.keyVersionName, digest: { sha256: digest } });
    if (res.name !== this.keyVersionName) {
      throw new Error(`Cloud KMS signed with ${String(res.name)}, not ${this.keyVersionName}`);
    }
    if (!res.signature || res.signature.length === 0) throw new Error('Cloud KMS returned an empty signature');
    return typeof res.signature === 'string' ? ethers.decodeBase64(res.signature) : new Uint8Array(res.signature);
  }
}

/** The signer this deployment uses, from COINBASE_STATEMENT_KMS_KEY. No default. */
export function statementSignerFromEnv(env: NodeJS.ProcessEnv = process.env): StatementSigner {
  const name = env.COINBASE_STATEMENT_KMS_KEY;
  if (!name) {
    throw new Error(
      'COINBASE_STATEMENT_KMS_KEY environment variable is required: coinbase_attestation v2 and ' +
      'oidc_domain_attestation proofs need statements signed by the Cloud KMS key the circuits pin.',
    );
  }
  return new KmsStatementSigner(name);
}
