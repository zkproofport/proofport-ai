/**
 * coinbase_attestation v2's server statement (src/input/coinbaseStatement.ts).
 *
 * Edge-case matrix (drawn up before the code):
 *   boundary   timestamp 0 / negative / fraction; expirationTime == now / now+1 / 0;
 *              DER integers of 31, 32 and 33 bytes; s exactly n/2 and n/2 + 1
 *   hostile    malformed DER (tag, length, trailing bytes, r = 0, r >= n);
 *              a key on another curve; a signer that signs with another key
 *   empty      missing env key; empty KMS signature; missing PEM
 *   UTF-8      N/A -- every field is fixed-length binary
 *   large      N/A -- client_data is fixed at 225 bytes; the route caps every field (proofRouteCoinbaseStatement)
 *   authz      the attestation must be Coinbase's, for this wallet, under the KYC schema
 *   race       N/A here (one statement per request, no shared state); route test checks order vs payment
 *   contract   reader.latestUid, reader.onChain, signer.signDigest and signer.publicKeyPem are all called
 *   integrity  client_data offsets match the circuit's spec; the signature verifies over SHA256(client_data)
 *   external   KMS / RPC / index failures surface as errors, a transient PEM failure is not cached
 */
import { describe, it, expect, vi } from 'vitest';
import { ethers } from 'ethers';
import { generateKeyPairSync, createPublicKey } from 'node:crypto';
// ethers 6's own P-256 implementation (ethers depends on @noble/curves 1.2.0):
// node:crypto cannot sign a pre-computed digest, which is what KMS does.
import { p256 as nobleP256 } from '@noble/curves/p256';

const kmsMock = vi.hoisted(() => ({
  getPublicKey: vi.fn(),
  asymmetricSign: vi.fn(),
}));
vi.mock('@google-cloud/kms', () => ({
  KeyManagementServiceClient: class {
    getPublicKey = kmsMock.getPublicKey;
    asymmetricSign = kmsMock.asymmetricSign;
  },
}));

import {
  buildClientData,
  confirmUnrevoked,
  derToLowSRawSignature,
  KmsStatementSigner,
  prepareServerStatement,
  requestDigest,
  statementSignerFromEnv,
  StatementRefusal,
  verifyRawP256,
  CLIENT_DATA_LEN,
  COINBASE_KYC_SCHEMA,
  type AttestationReader,
  type StatementSigner,
} from '../src/input/coinbaseStatement.js';
import { computeWalletNullifier } from '../src/input/inputBuilder.js';
import { COINBASE_ATTESTER_CONTRACT } from '../src/config/contracts.js';

const N = BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551');
const WALLET = '0xD6C714247037E5201B7e3dEC97a3ab59a9d2F739';
const UID = '0x' + '5a'.repeat(32);
const SCOPE = ethers.getBytes(ethers.keccak256(ethers.toUtf8Bytes('proofport')));
const SIGNAL = ethers.getBytes(ethers.keccak256(ethers.toUtf8Bytes('signal')));
const NOW_MS = 1_800_000_000_000;
const KEY_VERSION = 'projects/p/locations/us-central1/keyRings/r/cryptoKeys/k/cryptoKeyVersions/1';

function p256() {
  const privateKey = nobleP256.utils.randomPrivateKey();
  const pub = nobleP256.getPublicKey(privateKey, false); // 04 || X || Y
  const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64url');
  const pem = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64(pub.slice(1, 33)), y: b64(pub.slice(33)) }, format: 'jwk' })
    .export({ format: 'pem', type: 'spki' }).toString();
  return { privateKey, pem };
}

/** A signer that signs like KMS: DER over a precomputed SHA-256 digest. */
function localSigner(key = p256(), override?: (der: Uint8Array) => Uint8Array): StatementSigner & { signDigest: ReturnType<typeof vi.fn>; publicKeyPem: ReturnType<typeof vi.fn> } {
  return {
    signDigest: vi.fn(async (digest: Uint8Array) => {
      // lowS: false, as KMS promises nothing about s.
      const der = nobleP256.sign(digest, key.privateKey, { lowS: false }).toDERRawBytes();
      return override ? override(der) : der;
    }),
    publicKeyPem: vi.fn(async () => key.pem),
  };
}

function reader(overrides: Partial<Awaited<ReturnType<AttestationReader['onChain']>>> = {}, latest: () => Promise<string> = async () => UID) {
  return {
    latestUid: vi.fn(latest),
    onChain: vi.fn(async (uid: string) => ({
      uid,
      schema: COINBASE_KYC_SCHEMA,
      recipient: WALLET.toLowerCase(),
      attester: COINBASE_ATTESTER_CONTRACT,
      revocationTime: 0n,
      expirationTime: 0n,
      ...overrides,
    })),
  };
}

function der(r: bigint, s: bigint): Uint8Array {
  const int = (v: bigint) => {
    let b = ethers.getBytes(ethers.toBeHex(v));
    if (b[0] & 0x80) b = ethers.getBytes(ethers.concat(['0x00', b]));
    return ethers.getBytes(ethers.concat(['0x02', ethers.toBeHex(b.length, 1), b]));
  };
  const body = ethers.getBytes(ethers.concat([int(r), int(s)]));
  return ethers.getBytes(ethers.concat(['0x30', ethers.toBeHex(body.length, 1), body]));
}

describe('requestDigest', () => {
  it('is EIP-191 over the signal hash without an action', () => {
    expect(ethers.hexlify(requestDigest(SIGNAL))).toBe(ethers.hashMessage(SIGNAL));
  });
  it('is the EIP-712 digest with an action', () => {
    const d = '0x' + 'aa'.repeat(32);
    const a = '0x' + 'bb'.repeat(32);
    expect(ethers.hexlify(requestDigest(SIGNAL, d, a))).toBe(ethers.keccak256(ethers.concat(['0x1901', d, a])));
  });
  it('refuses half an action', () => {
    expect(() => requestDigest(SIGNAL, '0x' + 'aa'.repeat(32))).toThrow(/Half an action/);
    expect(() => requestDigest(SIGNAL, undefined, '0x' + 'aa'.repeat(32))).toThrow(/Half an action/);
  });
  it('refuses a signal hash that is not 32 bytes', () => {
    expect(() => requestDigest(new Uint8Array(31))).toThrow(/not 32/);
  });
});

describe('buildClientData', () => {
  const digest = new Uint8Array(32).fill(0x77);
  const cd = buildClientData({ wallet: WALLET.toLowerCase(), timestamp: 1_800_000_000, attestationUid: UID, requestDigest: digest, scope: SCOPE });

  it('is 225 bytes at the offsets the circuit reads (client_data.nr)', () => {
    expect(cd.length).toBe(CLIENT_DATA_LEN);
    expect(new TextDecoder().decode(cd.slice(0, 16))).toBe('ZKProofport/AA/1');
    expect(ethers.hexlify(cd.slice(16, 48))).toBe(ethers.keccak256(ethers.toUtf8Bytes('coinbase_attestation')));
    expect(ethers.getAddress(ethers.hexlify(cd.slice(48, 68)))).toBe(WALLET);
    expect(new DataView(cd.buffer, cd.byteOffset + 68, 8).getBigUint64(0, false)).toBe(1_800_000_000n);
    expect(ethers.hexlify(cd.slice(76, 108))).toBe(COINBASE_KYC_SCHEMA);
    expect(ethers.getAddress(ethers.hexlify(cd.slice(108, 128)))).toBe(COINBASE_ATTESTER_CONTRACT);
    expect(ethers.hexlify(cd.slice(128, 160))).toBe(UID);
    expect(cd[160]).toBe(0);
    expect(ethers.hexlify(cd.slice(161, 193))).toBe(ethers.hexlify(digest));
    expect(ethers.hexlify(cd.slice(193, 225))).toBe(ethers.hexlify(SCOPE));
  });
  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])('refuses timestamp %s', (timestamp) => {
    expect(() => buildClientData({ wallet: WALLET, timestamp, attestationUid: UID, requestDigest: digest, scope: SCOPE })).toThrow(/timestamp/);
  });
  it('refuses a short uid, digest or scope', () => {
    expect(() => buildClientData({ wallet: WALLET, timestamp: 1, attestationUid: '0x' + '5a'.repeat(31), requestDigest: digest, scope: SCOPE })).toThrow(/field 6/);
    expect(() => buildClientData({ wallet: WALLET, timestamp: 1, attestationUid: UID, requestDigest: new Uint8Array(31), scope: SCOPE })).toThrow(/field 8/);
    expect(() => buildClientData({ wallet: WALLET, timestamp: 1, attestationUid: UID, requestDigest: digest, scope: new Uint8Array(33) })).toThrow(/field 9/);
  });
  it('refuses a malformed wallet', () => {
    expect(() => buildClientData({ wallet: '0x1234', timestamp: 1, attestationUid: UID, requestDigest: digest, scope: SCOPE })).toThrow();
  });
});

describe('derToLowSRawSignature', () => {
  it('passes a low s through and left-pads short integers', () => {
    const raw = derToLowSRawSignature(der(5n, 7n));
    expect(raw.length).toBe(64);
    expect(BigInt(ethers.hexlify(raw.slice(0, 32)))).toBe(5n);
    expect(BigInt(ethers.hexlify(raw.slice(32)))).toBe(7n);
  });
  it('normalises s > n/2 to n - s, and keeps s == n/2', () => {
    const half = N >> 1n;
    expect(BigInt(ethers.hexlify(derToLowSRawSignature(der(1n, half + 1n)).slice(32)))).toBe(N - half - 1n);
    expect(BigInt(ethers.hexlify(derToLowSRawSignature(der(1n, half)).slice(32)))).toBe(half);
  });
  it('accepts a 33-byte INTEGER (leading zero for a high bit)', () => {
    const r = BigInt('0x' + 'f0'.repeat(32)) % N;
    expect(BigInt(ethers.hexlify(derToLowSRawSignature(der(r, 3n)).slice(0, 32)))).toBe(r);
  });
  it.each([
    ['not a sequence', () => { const d = der(1n, 2n); d[0] = 0x31; return d; }],
    ['wrong length', () => { const d = der(1n, 2n); d[1] += 1; return d; }],
    ['trailing bytes', () => { const d = der(1n, 2n); return ethers.getBytes(ethers.concat([ethers.concat(['0x30', ethers.toBeHex(d[1] + 1, 1)]), d.slice(2), '0x00'])); }],
    ['r = 0', () => der(0n, 2n)],
    ['r >= n', () => der(N, 2n)],
    ['s = 0', () => der(1n, 0n)],
    ['too short', () => new Uint8Array([0x30, 0x00])],
  ])('refuses %s', (_name, make) => {
    expect(() => derToLowSRawSignature(make())).toThrow(/Malformed DER/);
  });
});

describe('verifyRawP256', () => {
  it('refuses a key on another curve', async () => {
    const k1 = generateKeyPairSync('ec', { namedCurve: 'secp256k1' }).publicKey.export({ format: 'pem', type: 'spki' }).toString();
    await expect(verifyRawP256(k1, new Uint8Array(1), new Uint8Array(64))).rejects.toThrow(/P-256/);
  });
});

describe('confirmUnrevoked', () => {
  const now = 1_800_000_000;
  it('returns the uid of an unrevoked, unexpired Coinbase KYC attestation (case-insensitive addresses)', async () => {
    await expect(confirmUnrevoked(reader(), WALLET, now)).resolves.toBe(UID);
  });
  it('accepts an expiration one second in the future', async () => {
    await expect(confirmUnrevoked(reader({ expirationTime: BigInt(now + 1) }), WALLET, now)).resolves.toBe(UID);
  });
  it.each([
    ['revoked', { revocationTime: 1n }, 'COINBASE_ATTESTATION_REVOKED'],
    ['expired at now', { expirationTime: BigInt(now) }, 'COINBASE_ATTESTATION_EXPIRED'],
    ['expired before now', { expirationTime: 1n }, 'COINBASE_ATTESTATION_EXPIRED'],
    ['another schema', { schema: '0x' + '00'.repeat(32) }, 'NO_COINBASE_ATTESTATION'],
    ['another recipient', { recipient: '0x' + '11'.repeat(20) }, 'NO_COINBASE_ATTESTATION'],
    ['another attester', { attester: '0x' + '22'.repeat(20) }, 'NO_COINBASE_ATTESTATION'],
    ['not on chain (zero uid)', { uid: '0x' + '00'.repeat(32) }, 'NO_COINBASE_ATTESTATION'],
  ])('refuses %s', async (_name, override, code) => {
    await expect(confirmUnrevoked(reader(override as never), WALLET, now)).rejects.toMatchObject({ code });
  });
  it('refuses when the index finds nothing', async () => {
    await expect(confirmUnrevoked(reader({}, async () => { throw new Error('No attestation found'); }), WALLET, now))
      .rejects.toMatchObject({ code: 'NO_COINBASE_ATTESTATION' });
  });
  it('treats a malformed uid from the index as a server error, not a refusal', async () => {
    const err = await confirmUnrevoked(reader({}, async () => '0x1234'), WALLET, now).catch(e => e);
    expect(err).not.toBeInstanceOf(StatementRefusal);
    expect(String(err.message)).toMatch(/malformed uid/);
  });
  it('lets an RPC failure surface as an error', async () => {
    const r = reader();
    r.onChain.mockRejectedValueOnce(new Error('rpc down'));
    await expect(confirmUnrevoked(r, WALLET, now)).rejects.toThrow('rpc down');
  });
});

describe('prepareServerStatement', () => {
  const input = () => ({
    userAddress: WALLET.toLowerCase(),
    signalHash: SIGNAL,
    scopeBytes: SCOPE,
    nullifierBytes: computeWalletNullifier(WALLET, 'coinbase_attestation', SCOPE),
  });

  it('reads on chain, signs SHA256(client_data) and returns a low-s signature that verifies', async () => {
    const r = reader();
    const signer = localSigner();
    const st = await prepareServerStatement(input(), { reader: r, signer, now: () => NOW_MS });
    expect(r.latestUid).toHaveBeenCalledWith(WALLET);
    expect(r.onChain).toHaveBeenCalledWith(UID);
    expect(signer.signDigest).toHaveBeenCalledOnce();
    expect(ethers.hexlify(signer.signDigest.mock.calls[0][0])).toBe(ethers.sha256(st.clientData));
    expect(signer.publicKeyPem).toHaveBeenCalled();
    expect(st.attestedAt).toBe(NOW_MS / 1000);
    expect(st.attestationUid).toBe(UID);
    expect(BigInt(ethers.hexlify(st.signature.slice(32))) <= N >> 1n).toBe(true);
    await expect(verifyRawP256(await signer.publicKeyPem(), st.clientData, st.signature)).resolves.toBe(true);
    expect(ethers.hexlify(st.clientData.slice(161, 193))).toBe(ethers.hashMessage(SIGNAL));
  });

  it('normalises a high-s signature from the signer', async () => {
    const key = p256();
    const highS = (d: Uint8Array) => {
      const raw = derToLowSRawSignature(d);
      return der(BigInt(ethers.hexlify(raw.slice(0, 32))), N - BigInt(ethers.hexlify(raw.slice(32))));
    };
    const st = await prepareServerStatement(input(), { reader: reader(), signer: localSigner(key, highS), now: () => NOW_MS });
    expect(BigInt(ethers.hexlify(st.signature.slice(32))) <= N >> 1n).toBe(true);
    await expect(verifyRawP256(key.pem, st.clientData, st.signature)).resolves.toBe(true);
  });

  it('refuses to return a signature made by a key other than the one it reports', async () => {
    const signer = localSigner();
    signer.publicKeyPem.mockResolvedValue(p256().pem);
    await expect(prepareServerStatement(input(), { reader: reader(), signer, now: () => NOW_MS })).rejects.toThrow(/does not verify/);
  });

  it('refuses a v1 (signal-hash) nullifier before reading anything or signing', async () => {
    const r = reader();
    const signer = localSigner();
    const v1 = ethers.getBytes(ethers.keccak256(ethers.concat([ethers.keccak256(ethers.concat([WALLET, SIGNAL])), SCOPE])));
    await expect(prepareServerStatement({ ...input(), nullifierBytes: v1 }, { reader: r, signer }))
      .rejects.toMatchObject({ code: 'NULLIFIER_RULE' });
    expect(r.latestUid).not.toHaveBeenCalled();
    expect(signer.signDigest).not.toHaveBeenCalled();
  });

  it('refuses a scope that is not 32 bytes', async () => {
    await expect(prepareServerStatement({ ...input(), scopeBytes: new Uint8Array(31) }, { reader: reader(), signer: localSigner() }))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });

  it('does not sign for a revoked attestation', async () => {
    const signer = localSigner();
    await expect(prepareServerStatement(input(), { reader: reader({ revocationTime: 5n }), signer, now: () => NOW_MS }))
      .rejects.toMatchObject({ code: 'COINBASE_ATTESTATION_REVOKED' });
    expect(signer.signDigest).not.toHaveBeenCalled();
  });

  it('binds the EIP-712 digest when an action is given', async () => {
    const d = '0x' + 'aa'.repeat(32);
    const a = '0x' + 'bb'.repeat(32);
    const st = await prepareServerStatement({ ...input(), domainSeparator: d, actionHash: a }, { reader: reader(), signer: localSigner(), now: () => NOW_MS });
    expect(ethers.hexlify(st.clientData.slice(161, 193))).toBe(ethers.keccak256(ethers.concat(['0x1901', d, a])));
  });
});

describe('KmsStatementSigner', () => {
  it.each(['', 'projects/p/locations/l/keyRings/r/cryptoKeys/k', 'projects/p/locations/l/keyRings/r/cryptoKeys/k/cryptoKeyVersions/x'])(
    'refuses key name %j', (name) => {
      expect(() => new KmsStatementSigner(name)).toThrow(/COINBASE_STATEMENT_KMS_KEY must be a key version/);
    });

  it('signs a 32-byte digest by asymmetricSign with digest.sha256 on the configured version', async () => {
    kmsMock.asymmetricSign.mockResolvedValueOnce([{ name: KEY_VERSION, signature: new Uint8Array([0x30, 1, 2]) }]);
    const signer = new KmsStatementSigner(KEY_VERSION);
    const digest = new Uint8Array(32).fill(3);
    await expect(signer.signDigest(digest)).resolves.toEqual(new Uint8Array([0x30, 1, 2]));
    expect(kmsMock.asymmetricSign).toHaveBeenLastCalledWith({ name: KEY_VERSION, digest: { sha256: digest } });
  });

  it('refuses a digest that is not 32 bytes', async () => {
    await expect(new KmsStatementSigner(KEY_VERSION).signDigest(new Uint8Array(31))).rejects.toThrow(/not 32/);
  });

  it('refuses a response signed by another version, or an empty signature', async () => {
    kmsMock.asymmetricSign.mockResolvedValueOnce([{ name: KEY_VERSION.replace(/1$/, '2'), signature: new Uint8Array([1]) }]);
    await expect(new KmsStatementSigner(KEY_VERSION).signDigest(new Uint8Array(32))).rejects.toThrow(/signed with/);
    kmsMock.asymmetricSign.mockResolvedValueOnce([{ name: KEY_VERSION, signature: new Uint8Array() }]);
    await expect(new KmsStatementSigner(KEY_VERSION).signDigest(new Uint8Array(32))).rejects.toThrow(/empty signature/);
  });

  it('refuses a key of another algorithm', async () => {
    kmsMock.getPublicKey.mockResolvedValueOnce([{ algorithm: 'EC_SIGN_SECP256K1_SHA256', pem: 'x' }]);
    await expect(new KmsStatementSigner(KEY_VERSION).publicKeyPem()).rejects.toThrow(/EC_SIGN_P256_SHA256/);
  });

  it('does not cache a failed public-key read', async () => {
    const pem = p256().pem;
    kmsMock.getPublicKey.mockRejectedValueOnce(new Error('unavailable')).mockResolvedValueOnce([{ algorithm: 'EC_SIGN_P256_SHA256', pem }]);
    const signer = new KmsStatementSigner(KEY_VERSION);
    await expect(signer.publicKeyPem()).rejects.toThrow('unavailable');
    await expect(signer.publicKeyPem()).resolves.toBe(pem);
    expect(createPublicKey(pem)).toBeTruthy();
  });

  it('is required: no environment key, no signer', () => {
    expect(() => statementSignerFromEnv({})).toThrow(/COINBASE_STATEMENT_KMS_KEY environment variable is required/);
    expect(statementSignerFromEnv({ COINBASE_STATEMENT_KMS_KEY: KEY_VERSION })).toBeInstanceOf(KmsStatementSigner);
  });
});
