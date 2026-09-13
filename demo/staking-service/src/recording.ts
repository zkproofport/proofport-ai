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
  private steps = labels.map((label, index) => ({ number: index + 1, label, status: 'waiting', detail: '', at: null as string | null }));
  readonly amount: string;

  constructor(amount: string) { this.amount = parseStakeAmount(amount); }

  observe(line: string) {
    if (this.status !== 'running') return;
    const match = /^\[([1-6])\] (.+)$/.exec(line.trim());
    if (!match) return;
    const n = Number(match[1]);
    const text = match[2];
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
      const address = /0x[0-9a-fA-F]{40}/.exec(text)?.[0];
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
  }

  finish(code: number | null, reason?: string) {
    if (this.status !== 'running') return;
    this.finishedAt = new Date().toISOString();
    this.status = code === 0 && this.sawResult ? 'completed' : 'failed';
    if (this.status === 'completed') this.steps.forEach(step => { step.status = 'done'; });
    else {
      this.error = reason ?? `Agent did not complete the flow (exit ${code ?? 'signal'}).`;
      this.steps.filter(step => step.status === 'active').forEach(step => { step.status = 'failed'; });
    }
  }

  snapshot() {
    return { id: this.id, amount: this.amount, startedAt: this.startedAt, finishedAt: this.finishedAt,
      status: this.status, wallet: this.wallet, txHash:this.txHash,agentId:this.agentId,proofFingerprint:this.proofFingerprint,error: this.error, steps: this.steps.map(step => ({ ...step })) };
  }
}
