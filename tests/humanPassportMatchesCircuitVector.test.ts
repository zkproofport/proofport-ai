/**
 * The server's human_passport_score inputs, flattened in main()'s order, equal
 * the vector the circuit ACCEPTED in circuits' acceptance run
 * (tests/fixtures/humanPassportAcceptedVector.json, written by circuits
 * scripts/human-passport/export-app-vector.js from Prover.toml, action mode).
 *
 * The fixture's issuer is a test key (the eight production leaves plus a test
 * leaf, index 8, depth 4),
 * so this checks the FORMATTER -- every field, its size, its order and its
 * encoding -- not the production anchors; those are checked against real
 * issuances in humanPassport.test.ts. Regenerate the fixture whenever the
 * circuit's inputs change:
 *   node circuits/scripts/human-passport/export-app-vector.js proofport-ai/tests/fixtures/humanPassportAcceptedVector.json
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ethers } from 'ethers';
import { formatHumanPassportInputs } from '../src/prover/inputFormatter.js';

const V = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'humanPassportAcceptedVector.json'), 'utf8'));

/** human-passport-score/src/main.nr parameter order. */
const MAIN_ORDER = [
  'signal_hash', 'domain_separator', 'action_hash', 'signer_list_merkle_root', 'oprf_key_hash', 'domain', 'scope', 'nullifier', 'min_score', 'scorer_id', 'now',
  'user_address', 'user_signature', 'user_pubkey_x', 'user_pubkey_y', 'passport_domain_separator', 'schema_uid', 'expiration_time',
  'revocable', 'ref_uid', 'attestation_value', 'request_nonce', 'request_fee', 'score_data', 'score_data_len', 'issuer_signature',
  'issuer_pubkey_x', 'issuer_pubkey_y', 'issuer_merkle_proof', 'issuer_leaf_index', 'issuer_merkle_depth',
  'oprf_public_key_x', 'oprf_public_key_y', 'oprf_beta', 'oprf_dlog_e', 'oprf_dlog_s', 'oprf_response_x', 'oprf_response_y',
];

function flatten(named: Record<string, unknown>): string[] {
  const out: string[] = [];
  const push = (x: unknown) => {
    if (Array.isArray(x)) { x.forEach(push); return; }
    if (typeof x === 'boolean') { out.push(x ? '1' : '0'); return; }
    out.push(BigInt(x as string).toString());
  };
  for (const name of MAIN_ORDER) {
    if (!(name in named)) throw new Error(`formatter produced no ${name}`);
    push(named[name]);
  }
  return out;
}

describe('server inputs equal the circuit-accepted vector', () => {
  it('flattens to exactly expectedFlat (11,111 values, OPRF nullifier layout)', () => {
    // The circuit's OPRF answer under ITS fixture key (circuits
    // scripts/oprf-nullifier/oprf.js), not the staging pin: this checks the
    // formatter, not the key-hash pin (serverOprfInputs.test.ts does that).
    const o = V.oprf;
    const oprf = {
      oprf_key_hash: o.keyHash, domain: o.domain, scope: o.scope, nullifier: V.expectedNullifier,
      oprf_public_key_x: o.publicKey.x, oprf_public_key_y: o.publicKey.y, oprf_beta: o.beta,
      oprf_dlog_e: o.dlogE, oprf_dlog_s: o.dlogS, oprf_response_x: o.response.x, oprf_response_y: o.response.y,
    };
    const pub = ethers.getBytes(V.userPubkey);
    const ipub = ethers.getBytes(V.issuerPubkey);
    const named = formatHumanPassportInputs({
      signalHash: new Uint8Array(32).fill(9), // action mode: must come out as zeros
      domainSeparator: V.action.domainSeparator,
      actionHash: V.action.actionHash,
      oprf,
      userAddress: V.userAddress,
      userSignature: V.userSignatureRS + '1b',
      userPubkeyX: ethers.hexlify(pub.slice(1, 33)),
      userPubkeyY: ethers.hexlify(pub.slice(33, 65)),
      minScoreUnits: V.minScoreUnits,
      now: V.now,
      issuance: {
        chainId: 8453, txHash: V.sourceIssuanceTx, attestationUid: '0x' + '00'.repeat(32), verifier: '0x' + '00'.repeat(20),
        domainSeparator: V.issuance.domainSeparator,
        request: {
          schema: V.issuance.schema, recipient: V.issuance.recipient, expirationTime: BigInt(V.issuance.expirationTime),
          revocable: V.issuance.revocable, refUID: V.issuance.refUID, data: V.issuance.data,
          value: BigInt(V.issuance.value), nonce: BigInt(V.issuance.nonce), fee: BigInt(V.issuance.fee),
        },
        issuerSignature: V.issuance.issuerSignatureRS,
        issuerPubkeyX: ethers.hexlify(ipub.slice(1, 33)),
        issuerPubkeyY: ethers.hexlify(ipub.slice(33, 65)),
        merkleRoot: V.signerListMerkleRoot,
        merkleProof: V.issuerMerkleProof,
        leafIndex: V.issuerLeafIndex,
        merkleDepth: V.issuerMerkleDepth,
        score: 0, scorerId: V.scorerId,
      },
    });
    const flat = flatten(named);
    expect(flat).toHaveLength(11111);
    const firstDiff = flat.findIndex((x, i) => x !== V.expectedFlat[i]);
    expect(firstDiff).toBe(-1);
  });
});
