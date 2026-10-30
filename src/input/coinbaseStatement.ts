/**
 * The server-signed revocation statements of the Coinbase v2 circuits:
 * coinbase_attestation (KYC, circuits `coinbase-attestation-v2`) and
 * coinbase_country_attestation (Country, circuits
 * `coinbase-country-attestation-v2`).
 *
 * v1 of both proved that Coinbase once sent the attestation transaction. That
 * stays provable after Coinbase revokes the attestation. v2 also requires a
 * statement -- "at time T this wallet's Coinbase attestation was unrevoked,
 * for THIS request and THIS scope" -- signed with ECDSA P-256 by a key the
 * circuit pins. On a phone Apple App Attest (or Android key attestation) signs
 * it; for SDK/MCP callers this server does, with a Cloud KMS key
 * (`COINBASE_STATEMENT_KMS_KEY`). Each circuit's README, "What the server
 * signs", is the specification.
 *
 * The two statements share one layout ("ZKProofport/AA/1", 225 bytes) and
 * differ in the circuit tag at offset 16, the EAS schema at 76, and -- for
 * Country only -- two more bytes at 225: the country the attestation names,
 * which the circuit requires to equal the proven transaction's country (so an
 * old attestCountry transaction cannot ride on a newer attestation's
 * statement). Country's statement is 227 bytes.
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

/** The statement's magic: what the message is and its version (both circuits). */
const MAGIC = new TextEncoder().encode('ZKProofport/AA/1');
/** coinbase_attestation v2's statement length (circuits coinbase-v2-libs client_data.nr). */
export const CLIENT_DATA_LEN = 225;
/** coinbase_country_attestation v2's: KYC's layout plus the 2-byte country (coinbase-country-v2-libs). */
export const COUNTRY_CLIENT_DATA_LEN = 227;
/** keccak256(<canonical circuit id>): the statement kind and nullifier tag, never the package name. */
export const circuitTag = (circuitId: StatementCircuitId): Uint8Array =>
  ethers.getBytes(ethers.keccak256(ethers.toUtf8Bytes(statementSpec(circuitId).id)));
/** keccak256("coinbase_attestation"). */
export const coinbaseCircuitTag = (): Uint8Array => circuitTag(CIRCUIT_IDS.COINBASE_ATTESTATION);
/** Coinbase Verified Account schema on Base EAS. */
export const COINBASE_KYC_SCHEMA = (CIRCUITS[CIRCUIT_IDS.COINBASE_ATTESTATION] as { easSchemaId: string }).easSchemaId;
/** Coinbase Verified Country schema on Base EAS. */
export const COINBASE_COUNTRY_SCHEMA = (CIRCUITS[CIRCUIT_IDS.COINBASE_COUNTRY_ATTESTATION] as { easSchemaId: string }).easSchemaId;
/** The EAS predeploy on Base (OP-stack predeploy address). */
export const BASE_EAS_CONTRACT = '0x4200000000000000000000000000000000000021';
/** attestCountry(uint256): what Coinbase's attester is called with for a Country attestation. */
export const ATTEST_COUNTRY_SELECTOR = '0x0a225248';

/** The circuits whose witness carries this server's revocation statement. */
export type StatementCircuitId =
  | typeof CIRCUIT_IDS.COINBASE_ATTESTATION
  | typeof CIRCUIT_IDS.COINBASE_COUNTRY_ATTESTATION;

interface StatementSpec {
  id: StatementCircuitId;
  /** For messages a person reads. */
  label: string;
  schema: string;
  length: number;
  /** Country: the attestation's country is appended at offset 225 and must equal the transaction's. */
  carriesCountry: boolean;
}

/**
 * One row per circuit, and an unknown id is an error: a statement built for
 * the wrong circuit is refused by the circuit only after the caller paid.
 */
const STATEMENT_SPECS: Readonly<Record<StatementCircuitId, StatementSpec>> = Object.freeze({
  [CIRCUIT_IDS.COINBASE_ATTESTATION]: {
    id: CIRCUIT_IDS.COINBASE_ATTESTATION,
    label: 'Coinbase KYC',
    schema: COINBASE_KYC_SCHEMA,
    length: CLIENT_DATA_LEN,
    carriesCountry: false,
  },
  [CIRCUIT_IDS.COINBASE_COUNTRY_ATTESTATION]: {
    id: CIRCUIT_IDS.COINBASE_COUNTRY_ATTESTATION,
    label: 'Coinbase Country',
    schema: COINBASE_COUNTRY_SCHEMA,
    length: COUNTRY_CLIENT_DATA_LEN,
    carriesCountry: true,
  },
});

/** Whether `circuitId`'s witness needs this server's revocation statement. */
export function isStatementCircuit(circuitId: unknown): circuitId is StatementCircuitId {
  return typeof circuitId === 'string' && Object.hasOwn(STATEMENT_SPECS, circuitId);
}

export function statementSpec(circuitId: string): StatementSpec {
  if (!isStatementCircuit(circuitId)) {
    throw new Error(`No revocation statement for circuit '${circuitId}'. Known: ${Object.keys(STATEMENT_SPECS).join(', ')}.`);
  }
  return STATEMENT_SPECS[circuitId];
}

const EAS_ABI = [
  'function getAttestation(bytes32 uid) view returns ((bytes32 uid, bytes32 schema, uint64 time, uint64 expirationTime, uint64 revocationTime, bytes32 refUID, address recipient, address attester, bool revocable, bytes data))',
];

export interface ServerStatement {
  /** The bytes both signers sign: 225 for KYC, 227 for Country. */
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

/** An ISO 3166-1 alpha-2 code as the circuit compares it: exactly two ASCII A-Z bytes. */
const COUNTRY_CODE = /^[A-Z]{2}$/;

/**
 * README "clientData format": fixed offsets, binary. 225 bytes for
 * coinbase_attestation; coinbase_country_attestation appends the 2-byte
 * country (and refuses to be built without one, as KYC refuses one).
 */
export function buildClientData(p: {
  circuitId: StatementCircuitId;
  wallet: string;
  timestamp: number;
  attestationUid: string;
  requestDigest: Uint8Array;
  scope: Uint8Array;
  /** coinbase_country_attestation only: the attestation's country, two ASCII A-Z letters. */
  country?: string;
}): Uint8Array {
  const spec = statementSpec(p.circuitId);
  if (!Number.isSafeInteger(p.timestamp) || p.timestamp <= 0) throw new Error(`Invalid statement timestamp ${p.timestamp}`);
  if (spec.carriesCountry !== (p.country !== undefined)) {
    throw new Error(`${spec.id}'s statement ${spec.carriesCountry ? 'needs' : 'takes no'} country`);
  }
  if (p.country !== undefined && !COUNTRY_CODE.test(p.country)) {
    throw new Error(`Country '${p.country}' is not two ASCII letters A-Z`);
  }
  const time = new Uint8Array(8);
  new DataView(time.buffer).setBigUint64(0, BigInt(p.timestamp), false);
  const parts: Uint8Array[] = [
    MAGIC,
    circuitTag(spec.id),
    ethers.getBytes(ethers.getAddress(p.wallet)),
    time,
    ethers.getBytes(spec.schema),
    ethers.getBytes(COINBASE_ATTESTER_CONTRACT),
    ethers.getBytes(p.attestationUid),
    new Uint8Array([0]), // revoked = 0: the only statement this server signs
    p.requestDigest,
    p.scope,
  ];
  const lengths = [16, 32, 20, 8, 32, 20, 32, 1, 32, 32];
  if (p.country !== undefined) {
    parts.push(ethers.toUtf8Bytes(p.country));
    lengths.push(2);
  }
  parts.forEach((part, i) => {
    if (part.length !== lengths[i]) throw new Error(`client_data field ${i} is ${part.length} bytes, expected ${lengths[i]}`);
  });
  const out = ethers.getBytes(ethers.concat(parts));
  if (out.length !== spec.length) throw new Error(`client_data is ${out.length} bytes, expected ${spec.length}`);
  return out;
}

// ─── the country: from the attestation, and from the transaction ────────

/**
 * The country a Coinbase Verified Country attestation names: its data is
 * `abi.encode(string verifiedCountry)`. Anything but two ASCII A-Z letters is
 * refused -- the circuit compares bytes, so "kr" or "KOR" would only fail
 * after payment.
 */
export function attestedCountry(uid: string, data: string): string {
  let country: string;
  try {
    [country] = ethers.AbiCoder.defaultAbiCoder().decode(['string'], data) as unknown as [string];
  } catch (e) {
    throw new StatementRefusal('COINBASE_COUNTRY_UNREADABLE', `Coinbase Country attestation ${uid} does not hold an ABI-encoded string: ${(e as Error).message}`);
  }
  if (!COUNTRY_CODE.test(country)) {
    throw new StatementRefusal(
      'COINBASE_COUNTRY_UNREADABLE',
      `Coinbase Country attestation ${uid} names ${JSON.stringify(country)}, not a two-letter code A-Z`,
    );
  }
  return country;
}

/**
 * The country in the request's attestCountry transaction, read the way the
 * circuit reads it (calldata[14..16], the address at calldata[16..36]).
 * Refuses, before any payment, a transaction the circuit would refuse:
 * not EIP-1559, not to Coinbase's attester, not attestCountry, or for another
 * wallet.
 */
export function transactionCountry(rawTransaction: string, txLength: number, wallet: string): string {
  const bad = (why: string): never => { throw new StatementRefusal('INVALID_REQUEST', `raw_transaction ${why}`); };
  if (typeof rawTransaction !== 'string' || !/^0x([0-9a-fA-F]{2})+$/.test(rawTransaction)) bad('must be 0x-prefixed hex');
  const bytes = ethers.getBytes(rawTransaction);
  if (!Number.isSafeInteger(txLength) || txLength <= 0 || txLength > 300) bad(`length ${txLength} is not 1..300 (the circuit's buffer)`);
  if (bytes.length < txLength || bytes.slice(txLength).some(b => b !== 0)) bad(`does not match tx_length ${txLength}`);
  let tx: ethers.Transaction;
  try {
    tx = ethers.Transaction.from(ethers.hexlify(bytes.slice(0, txLength)));
  } catch (e) {
    return bad(`is not a signed transaction: ${(e as Error).message}`);
  }
  if (tx.type !== 2) bad(`is type ${tx.type}; Coinbase attestations are EIP-1559 (type 2)`);
  if (!tx.to || ethers.getAddress(tx.to) !== ethers.getAddress(COINBASE_ATTESTER_CONTRACT)) bad(`is not sent to Coinbase's attester`);
  const data = ethers.getBytes(tx.data);
  if (data.length !== 36 || ethers.hexlify(data.slice(0, 4)) !== ATTEST_COUNTRY_SELECTOR) bad('is not an attestCountry(uint256) call');
  if (ethers.getAddress(ethers.hexlify(data.slice(16, 36))) !== ethers.getAddress(wallet)) bad('attests another wallet');
  const country = String.fromCharCode(data[14], data[15]);
  if (!COUNTRY_CODE.test(country)) bad(`attests ${JSON.stringify(country)}, not a two-letter code A-Z`);
  return country;
}

// ─── the on-chain revocation read ───────────────────────────────────────

export interface OnChainAttestation {
  uid: string; schema: string; recipient: string; attester: string;
  revocationTime: bigint; expirationTime: bigint;
  /** The attestation's data, ABI-encoded per its schema (Country: `string verifiedCountry`). */
  data: string;
}

export interface AttestationReader {
  /** The newest attestation uid of this circuit's schema for `wallet` an index reports unrevoked. */
  latestUid(circuitId: StatementCircuitId, wallet: string): Promise<string>;
  /** The attestation as the EAS contract on Base holds it now. */
  onChain(uid: string): Promise<OnChainAttestation>;
}

export function easAttestationReader(easGraphqlEndpoint: string, baseRpcUrl: string): AttestationReader {
  if (!easGraphqlEndpoint) throw new Error('EAS_GRAPHQL_ENDPOINT is required to find the Coinbase attestation');
  if (!baseRpcUrl) throw new Error('BASE_RPC_URL is required to read the Coinbase attestation on chain');
  const provider = new ethers.JsonRpcProvider(baseRpcUrl, 8453, { staticNetwork: true });
  const eas = new ethers.Contract(BASE_EAS_CONTRACT, EAS_ABI, provider);
  return {
    async latestUid(circuitId, wallet) {
      const a = await fetchAttestationFromEAS(easGraphqlEndpoint, statementSpec(circuitId).id, wallet);
      return a.id;
    },
    async onChain(uid) {
      const a = await eas.getAttestation(uid);
      return {
        uid: a.uid, schema: a.schema, recipient: a.recipient, attester: a.attester,
        revocationTime: BigInt(a.revocationTime), expirationTime: BigInt(a.expirationTime),
        data: a.data,
      };
    },
  };
}

/**
 * Read the wallet's attestation of this circuit's schema on chain and refuse
 * unless it is Coinbase's, for this wallet, under that schema, unrevoked and
 * unexpired. Returns its uid and data.
 */
export async function confirmUnrevoked(
  reader: AttestationReader,
  circuitId: StatementCircuitId,
  wallet: string,
  nowSeconds: number,
): Promise<{ uid: string; data: string }> {
  const spec = statementSpec(circuitId);
  let uid: string;
  try {
    uid = await reader.latestUid(spec.id, wallet);
  } catch (e) {
    throw new StatementRefusal('NO_COINBASE_ATTESTATION', `No unrevoked ${spec.label} attestation found for ${wallet}: ${(e as Error).message}`);
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(uid)) throw new Error(`EAS index returned a malformed uid '${uid}'`);
  const a = await reader.onChain(uid);
  const same = (x: string, y: string) => x.toLowerCase() === y.toLowerCase();
  if (!same(a.uid, uid)) throw new StatementRefusal('NO_COINBASE_ATTESTATION', `EAS on Base has no attestation ${uid}`);
  if (!same(a.schema, spec.schema)) throw new StatementRefusal('NO_COINBASE_ATTESTATION', `Attestation ${uid} is not under the ${spec.label} schema`);
  if (!same(a.recipient, wallet)) throw new StatementRefusal('NO_COINBASE_ATTESTATION', `Attestation ${uid} is for another wallet`);
  if (!same(a.attester, COINBASE_ATTESTER_CONTRACT)) throw new StatementRefusal('NO_COINBASE_ATTESTATION', `Attestation ${uid} was not made by Coinbase's attester`);
  if (a.revocationTime !== 0n) throw new StatementRefusal('COINBASE_ATTESTATION_REVOKED', `Coinbase revoked attestation ${uid} at ${a.revocationTime}`);
  if (a.expirationTime !== 0n && a.expirationTime <= BigInt(nowSeconds)) {
    throw new StatementRefusal('COINBASE_ATTESTATION_EXPIRED', `Coinbase attestation ${uid} expired at ${a.expirationTime}`);
  }
  return { uid, data: a.data };
}

/**
 * Everything the server kind adds to a Coinbase v2 witness (KYC or Country).
 *
 * Refuses (before anything is charged) a nullifier that does not follow v2's
 * wallet + circuit-tag rule -- an SDK still on v1's signal-hash rule would
 * otherwise pay and then fail inside the circuit with "Nullifier mismatch" --
 * and, for Country, a transaction whose country is not the one the unrevoked
 * attestation names (the circuit refuses that too: "clientData names another
 * country").
 */
export async function prepareServerStatement(
  input: {
    circuitId: StatementCircuitId;
    userAddress: string;
    signalHash: Uint8Array;
    scopeBytes: Uint8Array;
    nullifierBytes: Uint8Array;
    domainSeparator?: string;
    actionHash?: string;
    /** coinbase_country_attestation only: the request's attestCountry transaction. */
    rawTransaction?: string;
    txLength?: number;
  },
  deps: { reader: AttestationReader; signer: StatementSigner; now?: () => number },
): Promise<ServerStatement> {
  const spec = statementSpec(input.circuitId);
  const wallet = ethers.getAddress(input.userAddress);
  if (input.scopeBytes.length !== 32) throw new StatementRefusal('INVALID_REQUEST', 'scope_bytes must be 32 bytes');
  const expected = computeWalletNullifier(wallet, spec.id, input.scopeBytes);
  if (ethers.hexlify(expected) !== ethers.hexlify(input.nullifierBytes)) {
    throw new StatementRefusal(
      'NULLIFIER_RULE',
      `${spec.id} v2 derives the nullifier from the wallet and the circuit tag: ` +
      `keccak256(keccak256(address ++ keccak256("${spec.id}")) ++ scope). The request carries ` +
      'a different one (an SDK built for v1 derives it from signal_hash); update the SDK.',
    );
  }
  // The transaction's country first: a malformed request is refused without
  // touching the index, the chain or the key.
  let txCountry: string | undefined;
  if (spec.carriesCountry) {
    if (input.rawTransaction === undefined || input.txLength === undefined) {
      throw new StatementRefusal('INVALID_REQUEST', `${spec.id} needs raw_transaction and tx_length to bind the attested country`);
    }
    txCountry = transactionCountry(input.rawTransaction, input.txLength, wallet);
  }
  const nowSeconds = Math.floor((deps.now ?? Date.now)() / 1000);
  const found = await confirmUnrevoked(deps.reader, spec.id, wallet, nowSeconds);
  let country: string | undefined;
  if (spec.carriesCountry) {
    country = attestedCountry(found.uid, found.data);
    if (country !== txCountry) {
      throw new StatementRefusal(
        'COINBASE_COUNTRY_MISMATCH',
        `The unrevoked Coinbase Country attestation ${found.uid} names ${country}; the request's transaction attests ${txCountry}. ` +
        'Prove with the transaction of the current attestation.',
      );
    }
  }
  const clientData = buildClientData({
    circuitId: spec.id,
    wallet,
    timestamp: nowSeconds,
    attestationUid: found.uid,
    requestDigest: requestDigest(input.signalHash, input.domainSeparator, input.actionHash),
    scope: input.scopeBytes,
    ...(country !== undefined && { country }),
  });
  const signature = await signStatement(deps.signer, clientData);
  log.info({ action: 'coinbase.statement.signed', circuit: spec.id, attestedAt: nowSeconds }, 'Server statement signed');
  return { clientData, signature, attestedAt: nowSeconds, attestationUid: found.uid };
}
