/** Real Arc contract integration using the local paid prover. This is not the GCP end-to-end demo. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'dotenv';
import { ethers, buildStakeDelegation, STAKING_ABI, ARC_CHAIN_ID } from './shared/flow.ts';
import { loadDemoConfig } from './shared/config.ts';
import { executeFromAgentWallet } from './shared/circleExecution.ts';
import { stakeFromReceipt } from './shared/receipt.ts';
import { normalizeArcPublicInputs, extractArcPublicMetadata } from './audit/address-audit.ts';

const exec = promisify(execFile);
const WALLET = '0x06Ad6B4EEbcD486bE53d8a9dC760a67A5Bdf3F64';
const PROVER = 'http://localhost:4002';
const ARTIFACT = 'demo/artifacts/onchain-verification.json';
const PROOF_ARTIFACT = 'demo/artifacts/onchain-verification-proof.json';
let stage = 'configuration';
const evidence: Record<string, unknown> = {
  kind: 'local-prover-real-arc-contract-integration',
  proverUrl: PROVER,
  gcpEndToEnd: false,
  wallet: WALLET,
  startedAt: new Date().toISOString(),
  amount: '1',
};
function save() {
  mkdirSync('demo/artifacts', { recursive: true });
  writeFileSync(ARTIFACT, `${JSON.stringify(evidence, null, 2)}\n`);
}
function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function progress(value: string) {
  stage = value;
  console.log(`[contract-integration] ${value}`);
}

async function main() {
  // Parse, never shell-source, credentials. Values never enter output or argv.
  for (const file of ['.env.development', '.env.test']) Object.assign(process.env, parse(readFileSync(file)));
  for (const key of ['CDP_API_KEY_ID', 'CDP_API_KEY_SECRET', 'CDP_WALLET_SECRET', 'ARC_WALLET_DEBUG']) delete process.env[key];
  check(process.env.ATTESTATION_KEY, 'Attestation credential is unavailable.');
  process.env.ARC_AGENT_WALLET = WALLET;
  process.env.CIRCLE_ACCEPT_TERMS = '1';
  process.env.PROOFPORT_URL = PROVER;
  const config = loadDemoConfig();
  const provider = new ethers.JsonRpcProvider(config.rpcUrl);
  check(Number((await provider.getNetwork()).chainId) === ARC_CHAIN_ID, 'Wrong RPC chain.');
  const gate = new ethers.Contract(config.gate, STAKING_ABI, provider);
  const token = new ethers.Contract(config.usdc, [
    'function balanceOf(address) view returns(uint256)',
    'function allowance(address,address) view returns(uint256)',
  ], provider);
  const verifier = new ethers.Contract(config.verifier, ['function verify(bytes,bytes32[]) view returns(bool)'], provider);
  check(ethers.getAddress(await gate.verifier()) === ethers.getAddress(config.verifier), 'Wrong live verifier.');
  const amount = 1_000_000n;
  const beforeStake = await gate.balances(WALLET) as bigint;
  const beforeCustody = await token.balanceOf(config.gate) as bigint;
  const beforeWallet = await token.balanceOf(WALLET) as bigint;
  check(beforeWallet > amount, 'Insufficient USDC for the stake and gas.');
  const latest = await provider.getBlock('latest');
  check(latest, 'Latest block unavailable.');
  const action = buildStakeDelegation({ gate: config.gate, delegate: WALLET, amount: '1',
    expiresAt: latest.timestamp + 3600, nonce: ethers.hexlify(ethers.randomBytes(16)) });
  evidence.chainId = ARC_CHAIN_ID;
  evidence.gate = config.gate;
  evidence.before = { stakeUnits: beforeStake.toString(), custodyUnits: beforeCustody.toString(), walletUnits: beforeWallet.toString() };
  save();
  const scratch = mkdtempSync(join(tmpdir(), 'proofport-contract-check-'));
  let mustWithdraw = false;
  try {
    progress('buying action-bound proof from the local prover using Circle nanopayment');
    const actionFile = join(scratch, 'action.json');
    writeFileSync(actionFile, JSON.stringify(action), { mode: 0o600 });
    let result;
    try {
      const { stdout } = await exec(process.execPath, ['packages/mcp/dist/prove.js', 'arc_eligibility',
        '--action', actionFile, '--scope', 'ledger-house', '--pay-on', 'arc-testnet-nano', '--pay-with', 'arc', '--silent'],
      { env: process.env, maxBuffer: 4 * 1024 * 1024, timeout: 180000 });
      result = JSON.parse(stdout) as { proof?: string; publicInputs?: string | string[]; circuit?: string };
    } catch {
      // Prover stderr can name the private credential holder; never forward it.
      throw new Error('The local paid prover failed; private diagnostics suppressed.');
    }
    check(typeof result.proof === 'string' && result.publicInputs, 'No proof returned.');
    const words = normalizeArcPublicInputs(result.publicInputs);
    const metadata = extractArcPublicMetadata(words);
    const packed = ethers.hexlify(ethers.concat(words));
    check(metadata.actionHash === ethers.TypedDataEncoder.hashStruct('CredentialDelegation', action.types, action.message), 'Proof action mismatch.');
    check(metadata.domainSeparator === ethers.TypedDataEncoder.hashDomain(action.domain), 'Proof domain mismatch.');
    check(await gate.domainSeparator() === metadata.domainSeparator, 'Live domain mismatch.');
    check(await verifier.verify(result.proof, words), 'Actual Arc verifier rejected proof.');
    writeFileSync(PROOF_ARTIFACT, `${JSON.stringify({ circuitId: 'arc_eligibility', proof: result.proof, publicInputs: words,
      proverUrl: PROVER, gcpEndToEnd: false, delegation: action }, null, 2)}\n`);
    evidence.publicProofFile = PROOF_ARTIFACT;
    evidence.publicInputsFingerprint = metadata.publicInputsFingerprint;
    evidence.actionHash = metadata.actionHash;
    evidence.realVerifierAccepted = true;
    save();
    const params = [amount, result.proof, packed, action.message.expiresAt, action.message.nonce] as const;
    const selectors = { ActionMismatch: ethers.id('ActionMismatch()').slice(0, 10), DelegationUsed: ethers.id('DelegationUsed()').slice(0, 10) };
    async function rejectStatic(name: keyof typeof selectors, args: readonly unknown[], from: string) {
      try { await gate.stakePacked.staticCall(...args, { from }); }
      catch (error) {
        const data = (error as { data?: string }).data;
        check(typeof data === 'string' && data.slice(0, 10) === selectors[name], `Unexpected rejection for ${name}.`);
        return name;
      }
      throw new Error(`Expected ${name} rejection.`);
    }
    progress('checking wrong amount and caller against the deployed contract');
    evidence.wrongAmount = await rejectStatic('ActionMismatch', [amount + 1n, ...params.slice(1)], WALLET);
    evidence.wrongCaller = await rejectStatic('ActionMismatch', params, '0x0000000000000000000000000000000000000001');
    const call = (contract: string, signature: string, args: string[]) => executeFromAgentWallet({
      wallet: WALLET, contract, signature, args, provider, rpcUrl: config.rpcUrl,
    });
    if ((await token.allowance(WALLET, config.gate) as bigint) < amount) {
      progress('approving exactly one USDC using the connected Circle wallet');
      const approval = await call(config.usdc, 'approve(address,uint256)', [config.gate, amount.toString()]);
      evidence.approval = { txHash: approval.hash, blockNumber: approval.blockNumber };
      save();
    }
    progress('staking one USDC on Arc Testnet');
    const receipt = await call(config.gate, 'stakePacked(uint256,bytes,bytes,uint256,string)',
      [amount.toString(), result.proof, packed, String(action.message.expiresAt), action.message.nonce]);
    mustWithdraw = true;
    evidence.stake = stakeFromReceipt(receipt, config.gate);
    save();
    const event = evidence.stake as ReturnType<typeof stakeFromReceipt>;
    check(event.wallet === WALLET && event.amount === '1.0' && event.actionHash === metadata.actionHash, 'Stake event mismatch.');
    check(await gate.balances(WALLET) === beforeStake + amount, 'Stake balance mismatch.');
    check(await token.balanceOf(config.gate) === beforeCustody + amount, 'USDC custody mismatch.');
    evidence.afterStake = { stakeUnits: (await gate.balances(WALLET)).toString(), custodyUnits: (await token.balanceOf(config.gate)).toString() };
    evidence.replay = await rejectStatic('DelegationUsed', params, WALLET);
    save();
    progress('withdrawing the same one USDC to restore the demo funds');
    const withdrawal = await call(config.gate, 'withdraw(uint256)', [amount.toString()]);
    mustWithdraw = false;
    evidence.withdrawal = { txHash: withdrawal.hash, blockNumber: withdrawal.blockNumber };
    check(await gate.balances(WALLET) === beforeStake, 'Withdrawal did not restore position.');
    check(await token.balanceOf(config.gate) === beforeCustody, 'Withdrawal did not restore custody.');
    evidence.replayAfterWithdrawal = await rejectStatic('DelegationUsed', params, WALLET);
    evidence.afterWithdrawal = { stakeUnits: (await gate.balances(WALLET)).toString(), custodyUnits: (await token.balanceOf(config.gate)).toString(),
      walletUnits: (await token.balanceOf(WALLET)).toString() };
    evidence.status = 'passed';
    evidence.finishedAt = new Date().toISOString();
    save();
    console.log(JSON.stringify({ status: evidence.status, proverUrl: PROVER, gcpEndToEnd: false,
      approval: evidence.approval, stake: evidence.stake, withdrawal: evidence.withdrawal,
      wrongAmount: evidence.wrongAmount, wrongCaller: evidence.wrongCaller, replay: evidence.replay,
      replayAfterWithdrawal: evidence.replayAfterWithdrawal, afterWithdrawal: evidence.afterWithdrawal }, null, 2));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
    if (mustWithdraw) {
      // A post-receipt assertion failure must not strand the authorized test deposit.
      progress('recovering the completed test deposit after validation failure');
      const recovery = await executeFromAgentWallet({ wallet: WALLET, contract: config.gate, signature: 'withdraw(uint256)',
        args: [amount.toString()], provider, rpcUrl: config.rpcUrl });
      evidence.recoveryWithdrawal = { txHash: recovery.hash, blockNumber: recovery.blockNumber };
      save();
    }
    provider.destroy();
  }
}

main().catch(() => {
  evidence.status = 'failed';
  evidence.failedStage = stage;
  save();
  console.error(`Contract integration failed at: ${stage}. Credential/proof diagnostics suppressed; public evidence: ${ARTIFACT}`);
  process.exitCode = 1;
});
