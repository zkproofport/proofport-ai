/**
 * human_passport_score: finding the issuance and checking it before payment.
 *
 * Matrix (written before the tests):
 *   real data      three REAL Base issuances (direct verifyAndAttest, ERC-4337
 *                  EntryPoint, 0xdb9b1e94) accepted against the PRODUCTION
 *                  anchors; issuer key, leaf 0, root = core's pin
 *   calldata scan  nested (execute wrapper) found; selector decoy before the
 *                  real call skipped; truncated, empty, other function refused;
 *                  non-hex thrown
 *   request shape  two entries, two requests, other schema, other wallet,
 *                  tampered data, other issuer, other domain index (leaf 1)
 *   data           192 / 10,240 bytes accepted, 191 / 10,241 refused by name;
 *                  decimals != 4; scorer != 335; dirty padding
 *   threshold      minScore 0, -1, NaN, Infinity, '20', 5 decimals, null,
 *                  undefined refused before any lookup; equal to the score
 *                  accepted, one unit above refused
 *   wallet         nullifier from signal_hash refused (NULLIFIER_RULE);
 *                  signature by another wallet, wrong pubkey, half an action,
 *                  malformed hex all INVALID_REQUEST, before any lookup
 *   lookup         no score (null) NO_HUMAN_PASSPORT_SCORE; index down / chain
 *                  down HUMAN_PASSPORT_LOOKUP_FAILED; revoked, attester,
 *                  schema, recipient mismatches; expired on chain and in the
 *                  signed request
 *   hostile        scope with SQL/HTML/wildcards/emoji only changes the hash
 *   formatter      noir_js-shaped inputs: every main() name, sizes, zero action
 *                  pair without an action, zero signal with one
 */
import { describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import {
  checkScoreData,
  findVerifyAndAttestCalls,
  HUMAN_PASSPORT_ANCHORS,
  issuanceFromCalldata,
  prepareHumanPassport,
  readScoreHead,
  type HumanPassportReader,
  VERIFY_AND_ATTEST_SELECTOR,
} from '../src/input/humanPassport.js';
import { formatHumanPassportInputs } from '../src/prover/inputFormatter.js';
import { StatementRefusal } from '../src/input/statementSigner.js';
import { HUMAN_PASSPORT_ISSUER, HUMAN_PASSPORT_ISSUER_ROOT, HUMAN_PASSPORT_SCORE_SCHEMA } from '@zkproofport-app/core/circuits';
import {
  buildIssuance, OTHER_ISSUER, OTHER_WALLET, REAL, requestInputs, TEST_WALLET, withDecoy,
} from './helpers/humanPassportFixture.js';

const refusal = (fn: () => unknown, code: string) => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(StatementRefusal);
    expect((e as StatementRefusal).code).toBe(code);
    return;
  }
  throw new Error(`expected refusal ${code}`);
};
const asyncRefusal = async (p: Promise<unknown>, code: string) => {
  await expect(p).rejects.toBeInstanceOf(StatementRefusal);
  await p.catch(e => expect((e as StatementRefusal).code).toBe(code));
};

/** scoreV2 data: head words + stamps offset, padded with zero stamp bytes to `length`. */
function scoreData(length: number, over: Partial<{ decimals: number; scorer: number; score: number; padding: boolean }> = {}): string {
  const w = (v: bigint) => ethers.zeroPadValue(ethers.toBeHex(v), 32);
  const head = ethers.concat([w(1n), w(BigInt(over.decimals ?? 4)), w(BigInt(over.scorer ?? 335)), w(BigInt(over.score ?? 233860)), w(200000n), w(0xc0n)]);
  const bytes = new Uint8Array(length);
  bytes.set(ethers.getBytes(head).slice(0, Math.min(192, length)));
  if (over.padding) bytes[3 * 32] = 1;
  return ethers.hexlify(bytes);
}

describe('real Base issuances, production anchors', () => {
  it.each(REAL.issuances.map(i => [i.to, i] as const))('accepts the issuance sent to %s', (_to, real) => {
    const i = issuanceFromCalldata({ calldata: real.input, txHash: real.txid, attestationUid: real.uid, wallet: real.recipient, attestationData: real.data });
    expect(i.leafIndex).toBe(0);
    expect(i.merkleRoot).toBe(HUMAN_PASSPORT_ISSUER_ROOT);
    expect(i.merkleDepth).toBe(1);
    expect(ethers.computeAddress('0x04' + i.issuerPubkeyX.slice(2) + i.issuerPubkeyY.slice(2))).toBe(ethers.getAddress(HUMAN_PASSPORT_ISSUER));
    expect(i.scorerId).toBe(335);
    expect(i.score).toBe(Number(readScoreHead(real.data).score));
    expect(i.request.recipient).toBe(ethers.getAddress(real.recipient));
  });

  it('refuses a real issuance for any other wallet', () => {
    const real = REAL.issuances[0];
    refusal(() => issuanceFromCalldata({ calldata: real.input, txHash: real.txid, attestationUid: real.uid, wallet: OTHER_WALLET.address, attestationData: real.data }), 'HUMAN_PASSPORT_ISSUANCE_UNREADABLE');
  });

  it('refuses a real issuance whose data was changed by one byte', () => {
    const real = REAL.issuances[0];
    const b = ethers.getBytes(real.data);
    b[b.length - 1] ^= 1;
    refusal(() => issuanceFromCalldata({ calldata: real.input, txHash: real.txid, attestationUid: real.uid, wallet: real.recipient, attestationData: ethers.hexlify(b) }), 'HUMAN_PASSPORT_ISSUANCE_UNREADABLE');
  });

  it('refuses a real issuance against anchors naming another issuer', () => {
    const real = REAL.issuances[0];
    const anchors = { ...HUMAN_PASSPORT_ANCHORS, issuer: OTHER_ISSUER.address };
    refusal(() => issuanceFromCalldata({ calldata: real.input, txHash: real.txid, attestationUid: real.uid, wallet: real.recipient, attestationData: real.data }, anchors), 'HUMAN_PASSPORT_ISSUANCE_UNREADABLE');
  });
});

describe('calldata scan', () => {
  it('names verifyAndAttest by its real selector', () => {
    const iface = new ethers.Interface(['function verifyAndAttest(((bytes32 schema,(address recipient,uint64 expirationTime,bool revocable,bytes32 refUID,bytes data,uint256 value)[] data)[] multiAttestationRequest,uint256 nonce,uint256 fee) attestationRequest,uint8 v,bytes32 r,bytes32 s) payable returns (bytes32[])']);
    expect(iface.getFunction('verifyAndAttest')!.selector).toBe(VERIFY_AND_ATTEST_SELECTOR);
  });

  const check = (calldata: string, b = buildIssuance()) =>
    issuanceFromCalldata({ calldata, txHash: '0x' + '11'.repeat(32), attestationUid: '0x' + '22'.repeat(32), wallet: TEST_WALLET.address, attestationData: b.data }, b.anchors);

  it('finds a call nested inside a wallet call', () => {
    const b = buildIssuance({ wrap: 'execute' });
    expect(b.calldata.slice(0, 10)).not.toBe('0x48a15e6f');
    expect(check(b.calldata, b).leafIndex).toBe(0);
  });
  it('skips a decoy selector before the real call', () => {
    const b = buildIssuance();
    expect(findVerifyAndAttestCalls(withDecoy(b.calldata))).toHaveLength(1);
    expect(check(withDecoy(b.calldata), b).leafIndex).toBe(0);
  });
  it('refuses truncated calldata, empty calldata and another function', () => {
    const b = buildIssuance();
    refusal(() => check(b.calldata.slice(0, 2 + 2 * Math.floor((b.calldata.length - 2) / 4)), b), 'HUMAN_PASSPORT_ISSUANCE_UNREADABLE');
    refusal(() => check('0x', b), 'HUMAN_PASSPORT_ISSUANCE_UNREADABLE');
    refusal(() => check('0xa9059cbb' + '00'.repeat(64), b), 'HUMAN_PASSPORT_ISSUANCE_UNREADABLE');
  });
  it('throws on calldata that is not hex bytes', () => {
    expect(() => findVerifyAndAttestCalls('0x123')).toThrow(/hex bytes/);
    expect(() => findVerifyAndAttestCalls('nothex')).toThrow(/hex bytes/);
  });
  it('picks the leaf of the domain the issuer signed under', () => {
    const b = buildIssuance({ verifierIndex: 1 });
    const i = check(b.calldata, b);
    expect(i.leafIndex).toBe(1);
    expect(i.merkleProof).toEqual([b.anchors.leaves[0].leaf]);
    expect(i.merkleRoot).toBe(b.anchors.root);
  });
  it.each([
    ['two entries in one request', { extraEntries: 1 }],
    ['two requests', { extraRequests: 1 }],
    ['another schema', { schema: '0x24620f482734b3806102678e4b8bb68baafb1adc1ec29e524bcd69c85f15b915' }],
    ['another wallet', { wallet: OTHER_WALLET.address }],
    ['another issuer', { signer: OTHER_ISSUER }],
  ] as const)('refuses %s', (_name, opts) => {
    const b = buildIssuance(opts as any);
    refusal(() => check(b.calldata, b), 'HUMAN_PASSPORT_ISSUANCE_UNREADABLE');
  });
});

describe('score data', () => {
  it('accepts 192 and 10,240 bytes', () => {
    expect(checkScoreData(scoreData(192), 'x').score).toBe(233860n);
    expect(checkScoreData(scoreData(10240), 'x').scorerId).toBe(335n);
  });
  it('refuses 10,241 bytes as too large and 191 as unreadable', () => {
    refusal(() => checkScoreData(scoreData(10241), 'x'), 'HUMAN_PASSPORT_DATA_TOO_LARGE');
    refusal(() => checkScoreData(scoreData(191), 'x'), 'HUMAN_PASSPORT_ISSUANCE_UNREADABLE');
  });
  it('refuses other decimals, another scorer and dirty padding', () => {
    refusal(() => checkScoreData(scoreData(256, { decimals: 2 }), 'x'), 'HUMAN_PASSPORT_ISSUANCE_UNREADABLE');
    refusal(() => checkScoreData(scoreData(256, { scorer: 336 }), 'x'), 'NO_HUMAN_PASSPORT_SCORE');
    refusal(() => checkScoreData(scoreData(256, { padding: true }), 'x'), 'HUMAN_PASSPORT_ISSUANCE_UNREADABLE');
  });
});

function fakeReader(b: ReturnType<typeof buildIssuance>, over: Partial<{
  latest: HumanPassportReader['latest']; revoked: bigint; expiration: bigint; attester: string; schema: string; recipient: string; calldataFails: boolean;
}> = {}) {
  const uid = '0x' + 'ab'.repeat(32);
  const txid = '0x' + 'cd'.repeat(32);
  const reader: HumanPassportReader = {
    latest: over.latest ?? vi.fn(async () => ({ uid, txid })),
    onChain: vi.fn(async () => ({
      uid, schema: over.schema ?? HUMAN_PASSPORT_SCORE_SCHEMA, recipient: over.recipient ?? TEST_WALLET.address,
      attester: over.attester ?? '0xCc90105D4A2aa067ee768120AdA19886021dF422',
      revocationTime: over.revoked ?? 0n, expirationTime: over.expiration ?? 1_900_000_000n, data: b.data,
    })),
    calldata: vi.fn(async () => { if (over.calldataFails) throw new Error('rpc down'); return b.calldata; }),
  };
  return reader;
}
const NOW = () => 1_800_000_000_000;

describe('prepareHumanPassport', () => {
  it('accepts a scored wallet at its own score and refuses one unit above it', async () => {
    const b = buildIssuance();
    const reader = fakeReader(b);
    const score = Number(readScoreHead(b.data).score);
    const ok = await prepareHumanPassport(await requestInputs({ minScore: score / 1e4 }), { reader, now: NOW, anchors: b.anchors });
    expect(ok.minScoreUnits).toBe(score);
    expect(ok.issuance.score).toBe(score);
    expect(ok.now).toBe(1_800_000_000);
    await asyncRefusal(prepareHumanPassport(await requestInputs({ minScore: (score + 1) / 1e4 }), { reader, now: NOW, anchors: b.anchors }), 'HUMAN_PASSPORT_SCORE_BELOW_THRESHOLD');
  });

  it('refuses the test issuance against the PRODUCTION anchors', async () => {
    const b = buildIssuance();
    await asyncRefusal(prepareHumanPassport(await requestInputs(), { reader: fakeReader(b), now: NOW }), 'HUMAN_PASSPORT_ISSUANCE_UNREADABLE');
  });

  it.each([0, -1, NaN, Infinity, '20', 20.00001, null, undefined])('refuses min_score %p before any lookup', async bad => {
    const reader = fakeReader(buildIssuance());
    await asyncRefusal(prepareHumanPassport(await requestInputs({ minScore: bad }), { reader, now: NOW }), 'INVALID_REQUEST');
    expect(reader.latest).not.toHaveBeenCalled();
  });

  it('refuses a nullifier made by another rule before any lookup', async () => {
    const reader = fakeReader(buildIssuance());
    const inputs = await requestInputs();
    inputs.nullifier = ethers.keccak256(ethers.concat([ethers.keccak256(ethers.concat([TEST_WALLET.address, inputs.signal_hash])), inputs.scope_bytes]));
    await asyncRefusal(prepareHumanPassport(inputs, { reader, now: NOW }), 'NULLIFIER_RULE');
    expect(reader.latest).not.toHaveBeenCalled();
  });

  it('refuses a signature by another wallet, a wrong public key, half an action and malformed hex', async () => {
    const reader = fakeReader(buildIssuance());
    const other = await requestInputs({ wallet: OTHER_WALLET });
    const mine = await requestInputs();
    await asyncRefusal(prepareHumanPassport({ ...mine, signature: other.signature }, { reader, now: NOW }), 'INVALID_REQUEST');
    await asyncRefusal(prepareHumanPassport({ ...mine, user_pubkey_x: other.user_pubkey_x }, { reader, now: NOW }), 'INVALID_REQUEST');
    await asyncRefusal(prepareHumanPassport({ ...mine, domain_separator: '0x' + '11'.repeat(32) }, { reader, now: NOW }), 'INVALID_REQUEST');
    await asyncRefusal(prepareHumanPassport({ ...mine, user_address: '0x1234' }, { reader, now: NOW }), 'INVALID_REQUEST');
    await asyncRefusal(prepareHumanPassport({ ...mine, scope_bytes: '0xzz' }, { reader, now: NOW }), 'INVALID_REQUEST');
    expect(reader.latest).not.toHaveBeenCalled();
  });

  it('accepts an EIP-712 action signed by the wallet', async () => {
    const b = buildIssuance();
    const domain = { name: 'Vault', version: '1', chainId: 8453, verifyingContract: '0x' + '33'.repeat(20) };
    const types = { Deposit: [{ name: 'amount', type: 'uint256' }] };
    const message = { amount: 10n };
    const signature = await TEST_WALLET.signTypedData(domain, types, message);
    const base = await requestInputs();
    const inputs = {
      ...base, signature,
      domain_separator: ethers.TypedDataEncoder.hashDomain(domain),
      action_hash: ethers.TypedDataEncoder.from(types).hash(message),
    };
    const ok = await prepareHumanPassport(inputs, { reader: fakeReader(b), now: NOW, anchors: b.anchors });
    expect(ok.issuance.request.recipient).toBe(TEST_WALLET.address);
  });

  it('refuses a wallet with no score, and says so', async () => {
    const reader = fakeReader(buildIssuance(), { latest: vi.fn(async () => null) });
    await asyncRefusal(prepareHumanPassport(await requestInputs(), { reader, now: NOW }), 'NO_HUMAN_PASSPORT_SCORE');
  });

  it('reports an index or chain that did not answer as a lookup failure', async () => {
    const down = fakeReader(buildIssuance(), { latest: vi.fn(async () => { throw new Error('EAS GraphQL request failed: HTTP 503'); }) });
    await asyncRefusal(prepareHumanPassport(await requestInputs(), { reader: down, now: NOW }), 'HUMAN_PASSPORT_LOOKUP_FAILED');
    const rpcDown = fakeReader(buildIssuance(), { calldataFails: true });
    await asyncRefusal(prepareHumanPassport(await requestInputs(), { reader: rpcDown, now: NOW }), 'HUMAN_PASSPORT_LOOKUP_FAILED');
  });

  it.each([
    ['revoked', { revoked: 1n }, 'NO_HUMAN_PASSPORT_SCORE'],
    ['another attester', { attester: '0x' + '44'.repeat(20) }, 'NO_HUMAN_PASSPORT_SCORE'],
    ['another schema on chain', { schema: '0x' + '55'.repeat(32) }, 'NO_HUMAN_PASSPORT_SCORE'],
    ['another recipient on chain', { recipient: OTHER_WALLET.address }, 'NO_HUMAN_PASSPORT_SCORE'],
    ['expired on chain', { expiration: 1_800_000_000n }, 'HUMAN_PASSPORT_SCORE_EXPIRED'],
  ] as const)('refuses an attestation %s', async (_n, over, code) => {
    const b = buildIssuance();
    await asyncRefusal(prepareHumanPassport(await requestInputs(), { reader: fakeReader(b, over as any), now: NOW, anchors: b.anchors }), code);
  });

  it('refuses a signed request that expired even if the record says otherwise', async () => {
    const b = buildIssuance({ expirationTime: 1_800_000_000n });
    await asyncRefusal(prepareHumanPassport(await requestInputs(), { reader: fakeReader(b), now: NOW, anchors: b.anchors }), 'HUMAN_PASSPORT_SCORE_EXPIRED');
  });

  it.each(["x'; DROP TABLE attestations;--", '<script>alert(1)</script>', '%_\\', '점수 🧑‍🚀\n\t'])('carries a hostile scope only as its hash: %j', async scope => {
    const b = buildIssuance();
    const ok = await prepareHumanPassport(await requestInputs({ scope }), { reader: fakeReader(b), now: NOW, anchors: b.anchors });
    expect(ok.minScoreUnits).toBe(200000);
  });
});

describe('formatHumanPassportInputs', () => {
  const NAMES = ['signal_hash', 'domain_separator', 'action_hash', 'signer_list_merkle_root', 'scope', 'nullifier', 'min_score', 'scorer_id', 'now',
    'user_address', 'user_signature', 'user_pubkey_x', 'user_pubkey_y', 'passport_domain_separator', 'schema_uid', 'expiration_time', 'revocable',
    'ref_uid', 'attestation_value', 'request_nonce', 'request_fee', 'score_data', 'score_data_len', 'issuer_signature', 'issuer_pubkey_x',
    'issuer_pubkey_y', 'issuer_merkle_proof', 'issuer_leaf_index', 'issuer_merkle_depth'];

  async function prepared() {
    const b = buildIssuance();
    const inputs = await requestInputs();
    const p = await prepareHumanPassport(inputs, { reader: fakeReader(b), now: NOW, anchors: b.anchors });
    return { inputs, p };
  }

  it('names exactly main()\'s parameters with the circuit\'s sizes', async () => {
    const { inputs, p } = await prepared();
    const out = formatHumanPassportInputs({
      signalHash: ethers.getBytes(inputs.signal_hash), scopeBytes: ethers.getBytes(inputs.scope_bytes), nullifierBytes: ethers.getBytes(inputs.nullifier),
      userAddress: inputs.user_address, userSignature: inputs.signature, userPubkeyX: inputs.user_pubkey_x, userPubkeyY: inputs.user_pubkey_y,
      minScoreUnits: p.minScoreUnits, now: p.now, issuance: p.issuance,
    });
    expect(Object.keys(out).sort()).toEqual([...NAMES].sort());
    expect((out.score_data as string[]).length).toBe(10240);
    expect(out.score_data_len).toBe(String(ethers.getBytes(p.issuance.request.data).length));
    expect((out.issuer_merkle_proof as string[][]).length).toBe(8);
    expect((out.domain_separator as string[]).every(x => x === '0x00')).toBe(true);
    expect(out.min_score).toBe('200000');
    expect(out.scorer_id).toBe('335');
  });

  it('zeroes signal_hash in action mode, refuses half an action, a zero threshold and now at expiry', async () => {
    const { inputs, p } = await prepared();
    const base = {
      signalHash: ethers.getBytes(inputs.signal_hash), scopeBytes: ethers.getBytes(inputs.scope_bytes), nullifierBytes: ethers.getBytes(inputs.nullifier),
      userAddress: inputs.user_address, userSignature: inputs.signature, userPubkeyX: inputs.user_pubkey_x, userPubkeyY: inputs.user_pubkey_y,
      minScoreUnits: p.minScoreUnits, now: p.now, issuance: p.issuance,
    };
    const action = formatHumanPassportInputs({ ...base, domainSeparator: '0x' + '11'.repeat(32), actionHash: '0x' + '22'.repeat(32) });
    expect((action.signal_hash as string[]).every(x => x === '0x00')).toBe(true);
    expect(() => formatHumanPassportInputs({ ...base, domainSeparator: '0x' + '11'.repeat(32) })).toThrow(/Half an action/);
    expect(() => formatHumanPassportInputs({ ...base, minScoreUnits: 0 })).toThrow(/min_score/);
    expect(() => formatHumanPassportInputs({ ...base, now: Number(p.issuance.request.expirationTime) })).toThrow(/expiry/);
  });
});
