/**
 * Does the server's Human Passport lookup work on every chain, against the
 * live chains -- without a scored wallet's key?
 *
 * For each chain in HUMAN_PASSPORT_SOURCES, from one real issuance transaction:
 *   1. read its calldata through the server's reader (the chain's RPC) and take
 *      the recipient from the verifyAndAttest call;
 *   2. ask the chain's index (EAS GraphQL) for that
 *      wallet's newest live scoreV2 attestation, exactly as the route does;
 *   3. read that attestation on the chain's EAS contract and check attester,
 *      schema and recipient as the route does;
 *   4. extract and check the issuance against the PRODUCTION issuer list
 *      (core's leaves and root), as the route does.
 * The wallet signature step is the only part not exercised.
 *
 *   npx tsx scripts/check-human-passport-chains.ts [--write-fixtures <file>] <chainId>:<txHash> ...
 *
 * Needs BASE_RPC_URL for Base (read from the environment). Network only, no keys.
 * With --write-fixtures, writes each checked issuance (public on-chain data) as
 * a test fixture.
 */
import { writeFileSync } from 'node:fs';
import { humanPassportChain } from '@zkproofport-app/core/circuits';
import {
  chainHumanPassportReader,
  findVerifyAndAttestCalls,
  humanPassportSource,
  issuanceFromCalldata,
} from '../src/input/humanPassport.js';

const args = process.argv.slice(2);
let fixturesOut: string | undefined;
const pairs: string[] = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--write-fixtures') fixturesOut = args[++i];
  else pairs.push(args[i]);
}
if (pairs.length === 0) throw new Error('usage: check-human-passport-chains.ts [--write-fixtures <file>] <chainId>:<txHash> ...');
const baseRpc = process.env.BASE_RPC_URL;
if (!baseRpc) throw new Error('BASE_RPC_URL is required');
const reader = chainHumanPassportReader(baseRpc, 30_000);
const now = Math.floor(Date.now() / 1000);
const fixtures: unknown[] = [];
let failed = 0;

for (const pair of pairs) {
  const [idText, tx] = pair.split(':');
  const chain = humanPassportChain(Number(idText));
  const source = humanPassportSource(chain.chainId);
  try {
    const seed = await reader.calldata(chain, tx);
    const calls = findVerifyAndAttestCalls(seed);
    if (calls.length === 0) throw new Error(`${tx} holds no verifyAndAttest call`);
    const wallet = calls[0].requests[0].entries[0].recipient;
    const latest = await reader.latest(chain, wallet, now);
    if (!latest) throw new Error(`the ${source.index.kind} index has no live score for ${wallet}`);
    const a = await reader.onChain(chain, latest.uid);
    const same = (x: string, y: string) => x.toLowerCase() === y.toLowerCase();
    if (!same(a.schema, chain.schema) || !same(a.recipient, wallet) || !same(a.attester, source.attester)) {
      throw new Error(`EAS record ${latest.uid}: schema ${a.schema}, recipient ${a.recipient}, attester ${a.attester}`);
    }
    if (a.revocationTime !== 0n || a.expirationTime <= BigInt(now)) throw new Error(`EAS record ${latest.uid} is not live`);
    const calldata = latest.txid.toLowerCase() === tx.toLowerCase() ? seed : await reader.calldata(chain, latest.txid);
    const i = issuanceFromCalldata({ calldata, txHash: latest.txid, attestationUid: latest.uid, wallet, attestationData: a.data, chainId: chain.chainId });
    console.log(`ok   ${chain.name} (${chain.chainId}) via ${source.index.kind}: uid ${latest.uid} tx ${latest.txid} leaf ${i.leafIndex} depth ${i.merkleDepth} scorer ${i.scorerId} score ${i.score} data ${(a.data.length - 2) / 2} bytes`);
    fixtures.push({ chainId: chain.chainId, uid: latest.uid, recipient: wallet, txid: latest.txid, data: a.data, input: calldata });
  } catch (e) {
    failed++;
    console.log(`FAIL ${chain.name} (${chain.chainId}) ${tx}: ${(e as Error).message}`);
  }
}
if (fixturesOut && failed === 0) {
  writeFileSync(fixturesOut, JSON.stringify({
    note: `Real Human Passport scoreV2 issuances, one per chain (public on-chain data), read ${new Date().toISOString().slice(0, 10)} by scripts/check-human-passport-chains.ts: uid and data from each chain's EAS contract, input = the recording transaction's calldata.`,
    issuances: fixtures,
  }, null, 1) + '\n');
  console.log(`wrote ${fixturesOut}`);
}
process.exitCode = failed ? 1 : 0;
