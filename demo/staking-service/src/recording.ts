import { randomUUID } from 'node:crypto';

export function parseStakeAmount(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{1,7}(\.\d{1,6})?$/.test(value)) {
    throw new Error('Enter a positive USDC amount with up to six decimal places.');
  }
  const amount = Number(value);
  if (amount <= 0 || amount > 1_000_000) throw new Error('Amount must be above 0 and at most 1,000,000 USDC.');
  return value;
}

const labels = ['Instruction received', 'Credential required', 'Prover discovered', 'Delegation prepared', 'Payment & proof', 'On-chain stake'];

/** Only recognised, public facts cross from the credential process into the page. */
export class RecordingRun {
  readonly id = randomUUID();
  readonly startedAt = new Date().toISOString();
  private status: 'running' | 'completed' | 'failed' = 'running';
  private finishedAt: string | null = null;
  private wallet: string | null = null;
  private txHash: string | null = null;
  private agentId: string | null = null;
  private proofFingerprint: string | null = null;
  private sawResult = false;
  private error: string | null = null;
  private command: string | null = null;
  private terminalLines: { at: string; text: string; kind: 'command' | 'output' | 'system' }[] = [];
  private steps = labels.map((label, index) => ({ number: index + 1, label, status: 'waiting', detail: '', at: null as string | null }));
  readonly amount: string;

  constructor(amount: string) { this.amount = parseStakeAmount(amount); }

  private terminal(text: string, kind: 'command' | 'output' | 'system' = 'output') {
    this.terminalLines.push({ at: new Date().toISOString(), text, kind });
    if (this.terminalLines.length > 128) this.terminalLines.shift();
  }

  startCli(service: string) {
    const url = new URL(service);
    if (url.protocol !== 'http:' || url.hostname !== 'localhost' || url.pathname !== '/' || url.search || url.hash) throw new Error('Expected the local recording service.');
    this.command = `node demo/user-agent/src/stake.ts --service ${url.origin} --amount ${this.amount} --pay-on arc-testnet-nano --pay-with arc`;
    this.terminal(this.command, 'command');
    this.terminal('KYC wallet A: **** | ATTESTATION_KEY: ****', 'system');
    this.terminal('Payment route: Circle Agent Wallet / Arc Gateway. Private credentials stay local.', 'system');
  }

  observe(line: string) {
    if (this.status !== 'running') return;
    // Only exact, opt-in lifecycle events are accepted from the prover process.
    const trace = /^\[demo-cli\] (prove_spawn|mcp_start|mcp_connected|mcp_generate_proof|mcp_result)$/.exec(line.trim());
    if (trace) {
      const messages: Record<string, string> = {
        prove_spawn: 'node packages/mcp/dist/prove.js arc_eligibility --action **** --scope ledger-house --pay-on arc-testnet-nano --pay-with arc --silent',
        mcp_start: 'node packages/mcp/dist/index.js  # local MCP server / stdio',
        mcp_connected: 'MCP connection established over stdio.',
        mcp_generate_proof: 'MCP call: generate_proof → GCP staging (arc_eligibility, arc-testnet-nano, arc)',
        mcp_result: 'MCP generate_proof returned a successful response.',
      };
      this.terminal(messages[trace[1]], trace[1] === 'prove_spawn' || trace[1] === 'mcp_start' ? 'command' : 'output');
      return;
    }
    const match = /^\[([1-6])\] (.+)$/.exec(line.trim());
    if (!match) return;
    const n = Number(match[1]);
    const text = match[2];
    const delegate = n === 4 ? /^Wallet A authorises (0x[0-9a-fA-F]{40}) to stake (\d+(?:\.\d{1,6})?) USDC; amount and expiry are bound$/.exec(text) : null;
    if (n === 4 && (!delegate || delegate[2] !== this.amount)) return;
    const step = this.steps[n - 1];
    step.at = new Date().toISOString();
    step.status = 'active';
    for (const previous of this.steps.slice(0, n - 1)) if (previous.status === 'active') previous.status = 'done';
    if (n === 1) step.detail = `Stake ${this.amount} USDC at Ledger House`;
    if (n === 2) step.detail = 'Coinbase KYC · arc_eligibility';
    if (n === 3) {
      this.agentId=/Registry agent (\d+)/.exec(text)?.[1] ?? null;
      step.detail = this.agentId ? `Arc ERC-8004 agent #${this.agentId} · registered GCP endpoint` : 'Searching the Arc ERC-8004 registry';
    }
    if (n === 4) {
      const address = delegate?.[1];
      if (address) this.wallet = address;
      step.detail = 'KYC holder signs the delegate, amount, action and expiry';
    }
    if (n === 5) {
      step.detail = text.startsWith('Proof in hand:') ? 'Paid GCP response received · proof generated' : 'Circle Agent Wallet · Arc Gateway nanopayment';
      const fingerprint=/fingerprint=(0x[0-9a-fA-F]{64})/.exec(text)?.[1];
      if(fingerprint)this.proofFingerprint=fingerprint;
    }
    if (n === 6) step.detail='Circle Agent Wallet authorises USDC and calls the staking gate';
    if (n === 6 && /^Staked /.test(text)) {
      const address = /0x[0-9a-fA-F]{40}/.exec(text)?.[0];
      const txHash=/tx=(0x[0-9a-fA-F]{64})/.exec(text)?.[1];
      if (!address || !txHash) return;
      this.wallet = address;
      this.txHash=txHash;
      this.sawResult = true;
      step.detail = 'Arc transaction confirmed · USDC deposited in the staking gate';
    }
    this.terminal(`[${n}/6] ${step.detail}`);
    if (n === 3 && this.agentId) this.terminal(`Registry agent: ${this.agentId} | https://stg-ai.zkproofport.app`, 'system');
    if (n === 4 && this.wallet) this.terminal(`Delegate B: ${this.wallet} | Credential signer A: ****`, 'system');
    if (n === 5 && this.proofFingerprint) this.terminal(`Public proof fingerprint: ${this.proofFingerprint}`, 'system');
    if (n === 6 && this.txHash) this.terminal(`Transaction: ${this.txHash}`, 'system');
  }

  finish(code: number | null, reason?: string) {
    if (this.status !== 'running') return;
    this.finishedAt = new Date().toISOString();
    this.status = code === 0 && this.sawResult ? 'completed' : 'failed';
    this.terminal(this.status === 'completed' ? 'Agent exited 0. Proof accepted and Arc stake confirmed.' : 'Agent stopped before confirmed completion. Check the local operator terminal.', 'system');
    if (this.status === 'completed') this.steps.forEach(step => { step.status = 'done'; });
    else {
      this.error = reason ?? `Agent did not complete the flow (exit ${code ?? 'signal'}).`;
      this.steps.filter(step => step.status === 'active').forEach(step => { step.status = 'failed'; });
    }
  }

  snapshot() {
    return { id: this.id, amount: this.amount, startedAt: this.startedAt, finishedAt: this.finishedAt,
      status: this.status, wallet: this.wallet, txHash:this.txHash,agentId:this.agentId,proofFingerprint:this.proofFingerprint,error: this.error, steps: this.steps.map(step => ({ ...step })),
      terminal: { command: this.command, lines: this.terminalLines.map(line => ({ ...line })) } };
  }
}
