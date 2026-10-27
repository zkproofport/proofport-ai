/**
 * The server-signed revocation statement of coinbase_attestation v2.
 *
 * coinbase_attestation v1 proved that Coinbase once sent attestAccount(wallet).
 * That stays provable after Coinbase revokes the attestation. v2 (circuits
 * `coinbase-attestation-v2`) also requires a 225-byte statement -- "at time T
 * this wallet's Coinbase KYC attestation was unrevoked, for THIS request and
 * THIS scope" -- signed with ECDSA P-256 by a key the circuit pins. On a phone
 * Apple App Attest signs it; for SDK/MCP callers this server does, with a
 * Cloud KMS key (`COINBASE_STATEMENT_KMS_KEY`). The circuit's README,
 * "What the server signs", is the specification; every step below cites it.
 *
 * The server signs only after it has itself read the attestation ON CHAIN
 * (EAS on Base) and found it unrevoked and unexpired: the signature is the
 * server vouching for that read, so the read cannot come from the caller or
 * from an indexer alone.
 */
import { ethers } from 'ethers';
import { createLogger } from '../logger.js';
import { CIRCUITS } from '../config/circuits.js';
import { CIRCUIT_IDS } from '../config/circuitIds.js';
import { COINBASE_ATTESTER_CONTRACT } from '../config/contracts.js';
import { fetchAttestationFromEAS } from './attestationFetcher.js';
import { computeWalletNullifier } from './inputBuilder.js';

const log = createLogger('CoinbaseStatement');

/** client_data layout -- circuits coinbase-attestation-v2/src/client_data.nr. */
export const CLIENT_DATA_LEN = 225;
const MAGIC = new TextEncoder().encode('ZKProofport/AA/1');
/** keccak256("coinbase_attestation"): the canonical id, not the package name. */
export const coinbaseCircuitTag = (): Uint8Array =>
  ethers.getBytes(ethers.keccak256(ethers.toUtf8Bytes(CIRCUIT_IDS.COINBASE_ATTESTATION)));
/** Coinbase Verified Account schema on Base EAS. */
export const COINBASE_KYC_SCHEMA = (CIRCUITS[CIRCUIT_IDS.COINBASE_ATTESTATION] as { easSchemaId: string }).easSchemaId;
/** The EAS predeploy on Base (OP-stack predeploy address). */
export const BASE_EAS_CONTRACT = '0x4200000000000000000000000000000000000021';

const P256_N = BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551');
const P256_HALF_N = P256_N >> 1n;

const EAS_ABI = [
  'function getAttestation(bytes32 uid) view returns ((bytes32 uid, bytes32 schema, uint64 time, uint64 expirationTime, uint64 revocationTime, bytes32 refUID, address recipient, address attester, bool revocable, bytes data))',
];

export interface ServerStatement {
  /** The 225 bytes both signers sign. */
  clientData: Uint8Array;
  /** P-256 r || s, s in low form. */
  signature: Uint8Array;
  /** The statement's timestamp, also the public input `attested_at`. */
  attestedAt: number;
  /** The EAS attestation the server found unrevoked (carried in client_data, not checked in-circuit). */
  attestationUid: string;
}

/** Signs a SHA-256 digest with ECDSA P-256 and returns DER, as Cloud KMS does. */
export interface StatementSigner {
  /** DER ECDSA-Sig-Value over `digest` (32 bytes). */
  signDigest(digest: Uint8Array): Promise<Uint8Array>;
  /** The signing key's public key, SPKI PEM. */
  publicKeyPem(): Promise<string>;
}

// ─── client_data ────────────────────────────────────────────────────────

/**
 * The 32 bytes the wallet signed: EIP-191 over signal_hash, or the EIP-712
 * digest of the action. Must equal the circuit's `signed_digest`.
 */
export function requestDigest(signalHash: Uint8Array, domainSeparator?: string, actionHash?: string): Uint8Array {
  if (Boolean(domainSeparator) !== Boolean(actionHash)) {
    throw new Error('Half an action: send both domain_separator and action_hash, or neither.');
  }
  if (domainSeparator && actionHash) {
    return ethers.getBytes(ethers.keccak256(ethers.concat(['0x1901', domainSeparator, actionHash])));
  }
  if (signalHash.length !== 32) throw new Error(`signal_hash is ${signalHash.length} bytes, not 32`);
  return ethers.getBytes(ethers.hashMessage(signalHash));
}

/** README "clientData format": fixed offsets, binary, 225 bytes. */
export function buildClientData(p: {
  wallet: string;
  timestamp: number;
  attestationUid: string;
  requestDigest: Uint8Array;
  scope: Uint8Array;
}): Uint8Array {
  if (!Number.isSafeInteger(p.timestamp) || p.timestamp <= 0) throw new Error(`Invalid statement timestamp ${p.timestamp}`);
  const time = new Uint8Array(8);
  new DataView(time.buffer).setBigUint64(0, BigInt(p.timestamp), false);
  const parts: Uint8Array[] = [
    MAGIC,
    coinbaseCircuitTag(),
    ethers.getBytes(ethers.getAddress(p.wallet)),
    time,
    ethers.getBytes(COINBASE_KYC_SCHEMA),
    ethers.getBytes(COINBASE_ATTESTER_CONTRACT),
    ethers.getBytes(p.attestationUid),
    new Uint8Array([0]), // revoked = 0: the only statement this server signs
    p.requestDigest,
    p.scope,
  ];
  const lengths = [16, 32, 20, 8, 32, 20, 32, 1, 32, 32];
  parts.forEach((part, i) => {
    if (part.length !== lengths[i]) throw new Error(`client_data field ${i} is ${part.length} bytes, expected ${lengths[i]}`);
  });
  const out = ethers.getBytes(ethers.concat(parts));
  if (out.length !== CLIENT_DATA_LEN) throw new Error(`client_data is ${out.length} bytes, expected ${CLIENT_DATA_LEN}`);
  return out;
}

// ─── signatures ─────────────────────────────────────────────────────────

/**
 * DER ECDSA-Sig-Value -> r || s (32 bytes each, big-endian), s in low form.
 * The circuit's P-256 black box refuses s > n/2 and Google's documentation
 * says nothing about normalising it (README step 5).
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
      'COINBASE_STATEMENT_KMS_KEY environment variable is required: coinbase_attestation v2 proofs need the ' +
      'server statement signed by the Cloud KMS key the circuit pins.',
    );
  }
  return new KmsStatementSigner(name);
}

// ─── the on-chain revocation read ───────────────────────────────────────

export interface AttestationReader {
  /** The newest Coinbase KYC attestation uid for `wallet` an index reports unrevoked. */
  latestUid(wallet: string): Promise<string>;
  /** The attestation as the EAS contract on Base holds it now. */
  onChain(uid: string): Promise<{
    uid: string; schema: string; recipient: string; attester: string;
    revocationTime: bigint; expirationTime: bigint;
  }>;
}

export function easAttestationReader(easGraphqlEndpoint: string, baseRpcUrl: string): AttestationReader {
  if (!easGraphqlEndpoint) throw new Error('EAS_GRAPHQL_ENDPOINT is required to find the Coinbase attestation');
  if (!baseRpcUrl) throw new Error('BASE_RPC_URL is required to read the Coinbase attestation on chain');
  const provider = new ethers.JsonRpcProvider(baseRpcUrl, 8453, { staticNetwork: true });
  const eas = new ethers.Contract(BASE_EAS_CONTRACT, EAS_ABI, provider);
  return {
    async latestUid(wallet) {
      const a = await fetchAttestationFromEAS(easGraphqlEndpoint, CIRCUIT_IDS.COINBASE_ATTESTATION, wallet);
      return a.id;
    },
    async onChain(uid) {
      const a = await eas.getAttestation(uid);
      return {
        uid: a.uid, schema: a.schema, recipient: a.recipient, attester: a.attester,
        revocationTime: BigInt(a.revocationTime), expirationTime: BigInt(a.expirationTime),
      };
    },
  };
}

/** A refusal the caller can act on; mapped to 4xx, raised before payment. */
export class StatementRefusal extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

/**
 * Read the wallet's Coinbase KYC attestation on chain and refuse unless it is
 * Coinbase's, for this wallet, under the KYC schema, unrevoked and unexpired.
 * Returns its uid.
 */
export async function confirmUnrevoked(reader: AttestationReader, wallet: string, nowSeconds: number): Promise<string> {
  let uid: string;
  try {
    uid = await reader.latestUid(wallet);
  } catch (e) {
    throw new StatementRefusal('NO_COINBASE_ATTESTATION', `No unrevoked Coinbase KYC attestation found for ${wallet}: ${(e as Error).message}`);
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(uid)) throw new Error(`EAS index returned a malformed uid '${uid}'`);
  const a = await reader.onChain(uid);
  const same = (x: string, y: string) => x.toLowerCase() === y.toLowerCase();
  if (!same(a.uid, uid)) throw new StatementRefusal('NO_COINBASE_ATTESTATION', `EAS on Base has no attestation ${uid}`);
  if (!same(a.schema, COINBASE_KYC_SCHEMA)) throw new StatementRefusal('NO_COINBASE_ATTESTATION', `Attestation ${uid} is not under the Coinbase KYC schema`);
  if (!same(a.recipient, wallet)) throw new StatementRefusal('NO_COINBASE_ATTESTATION', `Attestation ${uid} is for another wallet`);
  if (!same(a.attester, COINBASE_ATTESTER_CONTRACT)) throw new StatementRefusal('NO_COINBASE_ATTESTATION', `Attestation ${uid} was not made by Coinbase's attester`);
  if (a.revocationTime !== 0n) throw new StatementRefusal('COINBASE_ATTESTATION_REVOKED', `Coinbase revoked attestation ${uid} at ${a.revocationTime}`);
  if (a.expirationTime !== 0n && a.expirationTime <= BigInt(nowSeconds)) {
    throw new StatementRefusal('COINBASE_ATTESTATION_EXPIRED', `Coinbase attestation ${uid} expired at ${a.expirationTime}`);
  }
  return uid;
}

/**
 * Everything the server kind adds to a coinbase_attestation v2 witness.
 *
 * Refuses (before anything is charged) a nullifier that does not follow v2's
 * wallet + circuit-tag rule -- an SDK still on v1's signal-hash rule would
 * otherwise pay and then fail inside the circuit with "Nullifier mismatch".
 */
export async function prepareServerStatement(
  input: {
    userAddress: string;
    signalHash: Uint8Array;
    scopeBytes: Uint8Array;
    nullifierBytes: Uint8Array;
    domainSeparator?: string;
    actionHash?: string;
  },
  deps: { reader: AttestationReader; signer: StatementSigner; now?: () => number },
): Promise<ServerStatement> {
  const wallet = ethers.getAddress(input.userAddress);
  if (input.scopeBytes.length !== 32) throw new StatementRefusal('INVALID_REQUEST', 'scope_bytes must be 32 bytes');
  const expected = computeWalletNullifier(wallet, CIRCUIT_IDS.COINBASE_ATTESTATION, input.scopeBytes);
  if (ethers.hexlify(expected) !== ethers.hexlify(input.nullifierBytes)) {
    throw new StatementRefusal(
      'NULLIFIER_RULE',
      'coinbase_attestation v2 derives the nullifier from the wallet and the circuit tag: ' +
      'keccak256(keccak256(address ++ keccak256("coinbase_attestation")) ++ scope). The request carries ' +
      'a different one (an SDK built for v1 derives it from signal_hash); update the SDK.',
    );
  }
  const nowSeconds = Math.floor((deps.now ?? Date.now)() / 1000);
  const uid = await confirmUnrevoked(deps.reader, wallet, nowSeconds);
  const clientData = buildClientData({
    wallet,
    timestamp: nowSeconds,
    attestationUid: uid,
    requestDigest: requestDigest(input.signalHash, input.domainSeparator, input.actionHash),
    scope: input.scopeBytes,
  });
  const digest = ethers.getBytes(ethers.sha256(clientData));
  const signature = derToLowSRawSignature(await deps.signer.signDigest(digest));
  if (!(await verifyRawP256(await deps.signer.publicKeyPem(), clientData, signature))) {
    throw new Error('The statement signature does not verify under the signing key; refusing to prove with it');
  }
  log.info({ action: 'coinbase.statement.signed', attestedAt: nowSeconds }, 'Server statement signed');
  return { clientData, signature, attestedAt: nowSeconds, attestationUid: uid };
}
