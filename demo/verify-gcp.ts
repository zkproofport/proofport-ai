/**
 * Real GCP / Circle / Arc verification. Run from proofport-ai after demo/record.sh.
 * `node demo/verify-gcp.ts --preflight` only reads balances/discovery and requests an unpaid 402.
 * `node demo/verify-gcp.ts --run` buys one proof and leaves 1 USDC staked for the recording.
 * The recording server alone loads the KYC credential. This process never reads .env files.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, writeFileSync } from 'node:fs';
import { listArcAgentWallets } from '@zkproofport-ai/sdk';
import { selectAgentDelegate } from './user-agent/src/wallet.ts';
import { loadDemoConfig } from './shared/config.ts';
import { ethers, ARC_CHAIN_ID, STAKING_ABI } from './shared/flow.ts';
import { stakeFromReceipt } from './shared/receipt.ts';
import { normalizeArcPublicInputs, extractArcPublicMetadata, candidateMatchesProof } from './audit/address-audit.ts';

const SERVICE = 'http://localhost:4100';
const ARTIFACT = 'demo/artifacts/gcp-verification.json';
const PROOF_ARTIFACT = 'demo/artifacts/gcp-verification-proof.json';
let artifact = ARTIFACT;
const GATEWAY = '0x0077777d7EBA4688BDeF3E311b846F25870A19B9';
const exec = promisify(execFile);
const now = () => new Date().toISOString();
const evidence: Record<string, unknown> = { kind: 'gcp-paid-arc-staking-e2e', gcpEndToEnd: false,
  startedAt: now(), workflowRun: 'https://github.com/zkproofport/proofport-app-dev/actions/runs/34736913413' };
let stage = 'arguments';
let provider: ethers.JsonRpcProvider | undefined;
class VerificationError extends Error {}
function check(value: unknown, message: string): asserts value { if (!value) throw new VerificationError(message); }
function progress(value: string) { stage = value; console.log(`[${now()}] ${value}`); }
function save() {
  mkdirSync('demo/artifacts', { recursive: true });
  writeFileSync(artifact, `${JSON.stringify(evidence, null, 2)}\n`);
}
async function json<T>(url: string, body?: unknown, expectedStatus = 200): Promise<T> {
  const response = await fetch(url, { signal: AbortSignal.timeout(30000), redirect: 'error',
    ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
  check(response.status === expectedStatus, 'Unexpected HTTP status.');
  return await response.json() as T;
}
interface Agent { agentId: string; registry: string; owner: string; endpoint: string; name: string }
interface Run { id: string; status: string; wallet: string | null; txHash: string | null; agentId: string | null;
  proofFingerprint: string | null; steps: { number: number; status: string }[] }
interface Offer { network: string; amount: string; payTo: string; asset: string; extra?: { name?: string; version?: string; verifyingContract?: string } }

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') {
    console.log('Usage: node demo/verify-gcp.ts --preflight | --run\nStart demo/record.sh first. Set ARC_AGENT_WALLET only when multiple Circle wallets exist.\n--run buys one 0.001 USDC proof and leaves 1 USDC staked; never retries a paid request.\nEvidence: demo/artifacts/gcp-verification{,-proof}.json. No KYC environment files are read.');
    return;
  }
  check(args.length === 1 && ['--preflight', '--run'].includes(args[0]), 'Use --help, --preflight or --run.');
  const paid = args[0] === '--run';
  if (!paid) artifact = 'demo/artifacts/gcp-preflight.json';
  const config = loadDemoConfig();
  const origin = new URL(config.discovery.allowedOrigin);
  check(origin.protocol === 'https:' && origin.hostname === 'stg-ai.zkproofport.app', 'Expected the staging GCP origin.');
  progress('checking staging health and Arc identity readiness');
  const health = await json<{ status: string; paymentMode: string; paymentRequired: boolean; paymentNetworks: string; tee: { mode: string; attestationEnabled: boolean } }>(`${origin.origin}/health`);
  check(health.status === 'healthy' && health.paymentMode === 'testnet' && health.paymentRequired === true &&
    health.paymentNetworks.split(',').includes('arc-testnet-nano'), 'GCP is not ready for paid Arc Testnet nanopayments.');
  const identity = await json<{ status: string; registrations: { chainId: number; agentId: string }[] }>(`${origin.origin}/identity/status`);
  check(identity.status === 'ready', 'GCP registry initialization is not ready.');
  const manifest = await json<{ chain: unknown }>(`${SERVICE}/.well-known/service.json`);
  check(JSON.stringify(manifest.chain) === JSON.stringify(config), 'Recording server deployment differs from trusted config.');
  const marketplace = await json<{ chainId: number; registry: string; agents: Agent[] }>(`${SERVICE}/marketplace/agents`);
  check(marketplace.chainId === ARC_CHAIN_ID && marketplace.agents.length === 1, 'Expected one discovered Arc prover.');
  const agent = marketplace.agents[0];
  check(ethers.getAddress(marketplace.registry) === ethers.getAddress(config.discovery.registry) &&
    ethers.getAddress(agent.registry) === ethers.getAddress(config.discovery.registry) &&
    ethers.getAddress(agent.owner) === ethers.getAddress(config.discovery.owner) &&
    agent.endpoint === `${origin.origin}/api/v1/prove`, 'Discovery does not match trusted GCP registry settings.');
  check(identity.registrations.some(row => row.chainId === ARC_CHAIN_ID && row.agentId === agent.agentId), 'Discovered agent is absent from GCP readiness.');
  progress('checking the unpaid 402 Gateway offer');
  const challenge = await json<{ requiresPayment: boolean; accepts: Offer[] }>(agent.endpoint, { circuit: 'arc_eligibility', inputs: {} }, 402);
  const offers = challenge.accepts.filter(offer => offer.network === `eip155:${ARC_CHAIN_ID}` && offer.extra?.name === 'GatewayWalletBatched');
  check(challenge.requiresPayment === true && offers.length === 1, 'Expected one Arc Gateway payment offer.');
  const offer = offers[0];
  check(offer.amount === '1000' && ethers.getAddress(offer.payTo) === ethers.getAddress(config.discovery.owner) &&
    ethers.getAddress(offer.asset) === ethers.getAddress(config.usdc) && offer.extra?.version === '1' &&
    ethers.getAddress(offer.extra.verifyingContract!) === ethers.getAddress(GATEWAY), 'Unexpected nanopayment price, payee or Gateway metadata.');
  progress('reading the connected Circle wallet and balances');
  const wallet = selectAgentDelegate(await listArcAgentWallets('ARC-TESTNET'), process.env.ARC_AGENT_WALLET);
  provider = new ethers.JsonRpcProvider(config.rpcUrl);
  check(Number((await provider.getNetwork()).chainId) === ARC_CHAIN_ID, 'RPC is not Arc Testnet.');
  const gate = new ethers.Contract(config.gate, STAKING_ABI, provider);
  const token = new ethers.Contract(config.usdc, ['function balanceOf(address) view returns(uint256)'], provider);
  check(ethers.getAddress(await gate.verifier()) === ethers.getAddress(config.verifier), 'Live gate verifier differs from trusted config.');
  async function balances() {
    // Raw CLI output includes the backing EOA and must never enter evidence or logs.
    const { stdout } = await exec('circle', ['gateway', 'balance', '--address', wallet, '--chain', 'ARC-TESTNET', '--output', 'json'],
      { env: { ...process.env, CIRCLE_ACCEPT_TERMS: '1' }, timeout: 45000, maxBuffer: 1024 * 1024 });
    const data = (JSON.parse(stdout) as { data?: { total?: string; token?: string; address?: string } }).data;
    check(data?.token === 'USDC' && typeof data.total === 'string' && ethers.getAddress(data.address!) === wallet, 'Unexpected Circle balance response.');
    return { observedAt: now(), gatewayUnits: ethers.parseUnits(data.total, 6).toString(),
      walletUnits: String(await token.balanceOf(wallet)), positionUnits: String(await gate.balances(wallet)), custodyUnits: String(await token.balanceOf(config.gate)) };
  }
  const before = await balances();
  check(BigInt(before.gatewayUnits) >= 1000n && BigInt(before.walletUnits) >= 1_000_000n, 'Insufficient Gateway or wallet USDC.');
  Object.assign(evidence, { proverUrl: origin.origin, chainId: ARC_CHAIN_ID, gate: config.gate, verifier: config.verifier,
    wallet, health: { observedAt: now(), paymentMode: health.paymentMode, paymentRequired: health.paymentRequired,
      paymentNetworks: health.paymentNetworks, tee: health.tee }, registry: agent, payment: offer, before });
  if (!paid) { evidence.status = 'preflight-passed'; save(); console.log(`Preflight passed: ${artifact}`); return; }
  const previous = await json<{ run: Run | null }>(`${SERVICE}/demo/state`);
  check(previous.run?.status !== 'running', 'A recording run is already active.');
  evidence.status = 'running'; save();
  progress('starting exactly one paid GCP proof and 1 USDC Arc stake');
  const started = await json<{ runId: string }>(`${SERVICE}/demo/run`, { amount: '1', instruction: 'Stake 1 USDC in Ledger House. Discover the registered prover, read its guide, obtain a KYC and delegation proof using Arc nanopayments, verify it on Arc, then stake.' }, 202);
  check(typeof started.runId === 'string' && started.runId.length > 0, 'Missing recording run ID.');
  evidence.runId = started.runId; save();
  const deadline = Date.now() + 480000;
  let run: Run | undefined;
  let lastStep = '';
  while (Date.now() < deadline) {
    const state = await json<{ run: Run | null }>(`${SERVICE}/demo/state`);
    check(state.run?.id === started.runId, 'Recording run changed while verifying.');
    run = state.run;
    const publicStep = run.steps.map(step => `${step.number}:${step.status}`).join(' ');
    if (publicStep !== lastStep) { progress(`recording stages ${publicStep}`); lastStep = publicStep; }
    if (run.status !== 'running') break;
    await new Promise(resolve => setTimeout(resolve, 3000));
  }
  check(run?.status === 'completed' && run.txHash && ethers.getAddress(run.wallet!) === wallet && run.agentId === agent.agentId,
    'The paid recording did not complete with the selected wallet and registry agent.');
  progress('verifying the Arc receipt and public proof');
  const receipt = await provider.getTransactionReceipt(run.txHash);
  check(receipt, 'Confirmed Arc receipt is unavailable.');
  const stake = stakeFromReceipt(receipt, config.gate);
  check(stake.wallet === wallet && stake.amount === '1.0', 'Receipt differs from the requested stake.');
  evidence.stake = stake; save();
  const proof = await json<{ circuitId: string; proof: string; publicInputs: unknown }>(`${SERVICE}/demo/proof`);
  check(proof.circuitId === 'arc_eligibility' && /^0x(?:[0-9a-fA-F]{2})+$/.test(proof.proof), 'Missing Arc proof.');
  const words = normalizeArcPublicInputs(proof.publicInputs);
  const metadata = extractArcPublicMetadata(words);
  check(metadata.publicInputsFingerprint === run.proofFingerprint && metadata.actionHash === stake.actionHash.toLowerCase(), 'Public proof does not match this run and receipt.');
  check(metadata.domainSeparator === await gate.domainSeparator() && metadata.signerRoot === await gate.trustedSignerRoot(), 'Proof domain or signer root differs from the live gate.');
  const audit = await json<{ matches: boolean; proofVerified: boolean; fingerprint: string; explanation: string }>(`${SERVICE}/demo/audit`, { fromEnvironment: true });
  check(audit.matches === true && audit.proofVerified === true && audit.fingerprint === metadata.publicInputsFingerprint, 'Configured candidate or live verifier check failed.');
  const wrongCandidateMatches = candidateMatchesProof(words, '0x0000000000000000000000000000000000000001');
  check(wrongCandidateMatches === false, 'Wrong candidate unexpectedly matched.');
  writeFileSync(PROOF_ARTIFACT, `${JSON.stringify({ circuitId: proof.circuitId, proof: proof.proof, publicInputs: words,
    observedAt: now(), proverUrl: origin.origin, gcpEndToEnd: true, runId: run.id }, null, 2)}\n`);
  Object.assign(evidence, { publicProofFile: PROOF_ARTIFACT, proofMetadata: metadata,
    audit: { observedAt: now(), configuredCandidateMatches: true, wrongCandidateMatches, realVerifierAccepted: true, explanation: audit.explanation } });
  save();
  progress('checking exact Gateway, wallet, position and custody deltas');
  const after = await balances();
  evidence.after = after; save();
  check(BigInt(before.gatewayUnits) - BigInt(after.gatewayUnits) === 1000n, 'Gateway decrease was not exactly 0.001 USDC.');
  check(BigInt(before.walletUnits) - BigInt(after.walletUnits) === 1_000_000n, 'Wallet decrease was not exactly 1 USDC.');
  check(BigInt(after.positionUnits) - BigInt(before.positionUnits) === 1_000_000n &&
    BigInt(after.custodyUnits) - BigInt(before.custodyUnits) === 1_000_000n, 'Position or custody did not increase by 1 USDC.');
  Object.assign(evidence, { status: 'passed', gcpEndToEnd: true, finishedAt: now(), withdrawalPerformed: false });
  save();
  console.log(`Verified paid GCP E2E; 1 USDC remains staked. Public evidence: ${ARTIFACT}`);
}

main().catch(error => {
  // HTTP/RPC/CLI errors can contain credential details. Only controlled stage names cross this boundary.
  const reason = error instanceof VerificationError ? error.message : 'External request failed; private diagnostics suppressed.';
  Object.assign(evidence, { status: 'failed', failedStage: stage, reason, finishedAt: now() });
  if (stage !== 'arguments') save();
  console.error(`GCP verification failed at ${stage}: ${reason} Public evidence: ${artifact}. Do not repeat a paid run without checking its transaction and balances.`);
  process.exitCode = 1;
}).finally(() => provider?.destroy());
