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
import { signStatement, StatementRefusal, type StatementSigner } from './statementSigner.js';

// The signer, its DER handling and the refusal type are shared with the OIDC
// provider-key statement (./oidcStatement.ts); re-exported for existing callers.
export {
  derToLowSRawSignature,
  KmsStatementSigner,
  signStatement,
  statementSignerFromEnv,
  StatementRefusal,
  verifyRawP256,
  type StatementSigner,
} from './statementSigner.js';

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
  const signature = await signStatement(deps.signer, clientData);
  log.info({ action: 'coinbase.statement.signed', attestedAt: nowSeconds }, 'Server statement signed');
  return { clientData, signature, attestedAt: nowSeconds, attestationUid: uid };
}
