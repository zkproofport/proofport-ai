import { randomUUID } from 'node:crypto';

export function parseStakeAmount(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{1,7}(\.\d{1,6})?$/.test(value)) {
    throw new Error('Enter a positive USDC amount with up to six decimal places.');
  }
  const amount = Number(value);
  if (amount <= 0 || amount > 1_000_000) throw new Error('Amount must be above 0 and at most 1,000,000 USDC.');
  return value;
}

export function parseInstruction(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 2000) {
    throw new Error('Enter an instruction of 1 to 2,000 characters.');
  }
  return value.trim();
}

export const CLAUDE_TOOLS = new Set(['read_dapp', 'discover_prover', 'read_prover_guide', 'connect_prover_mcp',
  'prepare_delegation', 'generate_proof', 'verify_proof_on_arc', 'stake'].map(name => `mcp__ledger_house__${name}`));
type PublicToolResult = Record<string, unknown>;
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function amountUnits(value: string) {
  const [whole, fraction = ''] = parseStakeAmount(value).split('.');
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
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
  private terminalLines: { at: string; text: string; kind: 'command' | 'output' | 'system' | 'tool_call' | 'tool_result' }[] = [];
  private claude = false;
  private model: string | null = null;
  private instruction: string | null = null;
  private pendingTools = new Map<string, string>();
  private steps = labels.map((label, index) => ({ number: index + 1, label, status: 'waiting', detail: '', at: null as string | null }));
  readonly amount: string;
  private readonly redact: (text: string) => string;

  constructor(amount: string, redact: (text: string) => string = text => text) {
    this.amount = parseStakeAmount(amount); this.redact = redact;
  }

  private terminal(text: string, kind: 'command' | 'output' | 'system' | 'tool_call' | 'tool_result' = 'output') {
    this.terminalLines.push({ at: new Date().toISOString(), text: this.redact(text).slice(0, 16384), kind });
    if (this.terminalLines.length > 128) this.terminalLines.shift();
  }

  startClaude(instruction: string) {
    this.claude = true;
    this.instruction = this.redact(parseInstruction(instruction));
    this.command = `claude -p ${JSON.stringify(this.instruction)}`;
    this.terminal(this.command, 'command');
  }

  observeClaude(event: unknown) {
    if (!this.claude || this.status !== 'running' || !record(event)) return;
    if (event.type === 'system' && event.subtype === 'init') {
      if (typeof event.model === 'string' && /^[a-zA-Z0-9._:/-]{1,128}$/.test(event.model)) this.model = this.redact(event.model);
      return;
    }
    if (event.type !== 'assistant' && event.type !== 'user') return;
    if (event.parent_tool_use_id) return; // No subagent reasoning or nested conversations.
    if (!record(event.message) || !Array.isArray(event.message.content)) return;
    for (const block of event.message.content) {
      if (!record(block)) continue;
      if (event.type === 'assistant' && block.type === 'tool_use') {
        if (typeof block.id !== 'string' || typeof block.name !== 'string' || !CLAUDE_TOOLS.has(block.name)
          || this.pendingTools.has(block.id) || !record(block.input)) continue;
        this.pendingTools.set(block.id, block.name);
        this.terminal(`${block.name} ${JSON.stringify(block.input)}`, 'tool_call');
      }
      if (event.type === 'user' && block.type === 'tool_result') {
        if (typeof block.tool_use_id !== 'string') continue;
        const name = this.pendingTools.get(block.tool_use_id);
        if (!name) continue;
        this.pendingTools.delete(block.tool_use_id);
        const raw = typeof block.content === 'string' ? block.content : Array.isArray(block.content)
          ? block.content.filter(part => record(part) && part.type === 'text' && typeof part.text === 'string').map(part => part.text).join('\n') : '';
        let result: unknown;
        try { result = JSON.parse(raw); } catch { this.terminal(`${name} returned a non-JSON tool result.`, 'tool_result'); continue; }
        if (!record(result)) continue;
        this.terminal(`${name} ${JSON.stringify(result)}`, 'tool_result');
        if (block.is_error === true || result.ok !== true) continue;
        this.acceptToolResult(name, result);
      }
    }
  }

  private acceptToolResult(name: string, result: PublicToolResult) {
    const mark = (number: number, detail: string) => {
      const step = this.steps[number - 1];
      step.status = 'done'; step.detail = this.redact(detail); step.at = new Date().toISOString();
    };
    if (name === 'mcp__ledger_house__read_dapp') {
      mark(1, this.instruction ?? 'Instruction received');
      mark(2, 'Coinbase KYC · arc_eligibility');
    }
    if (name === 'mcp__ledger_house__discover_prover') {
      if (typeof result.agentId !== 'string' && typeof result.agentId !== 'number') return;
      const id = String(result.agentId);
      if (!/^\d+$/.test(id)) return;
      this.agentId = id; mark(3, `Arc ERC-8004 agent #${id} · registered GCP endpoint`);
    }
    if (name === 'mcp__ledger_house__prepare_delegation') {
      if (typeof result.wallet !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(result.wallet)) return;
      this.wallet = result.wallet; mark(4, 'Delegate, amount, action and expiry prepared; KYC signing occurs in proof generation');
    }
    if (name === 'mcp__ledger_house__generate_proof') {
      if (typeof result.fingerprint !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(result.fingerprint)) return;
      this.proofFingerprint = result.fingerprint; mark(5, 'Paid GCP response received · proof generated');
    }
    if (name === 'mcp__ledger_house__stake') {
      if (typeof result.txHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(result.txHash)
        || typeof result.wallet !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(result.wallet)
        || typeof result.block !== 'number' || !Number.isSafeInteger(result.block) || result.block <= 0
        || typeof result.amount !== 'string' || (result.chainId !== undefined && result.chainId !== 5042002)) return;
      try { if (amountUnits(result.amount) !== amountUnits(this.amount)) return; } catch { return; }
      if (this.wallet && this.wallet.toLowerCase() !== result.wallet.toLowerCase()) return;
      this.wallet = result.wallet; this.txHash = result.txHash; this.sawResult = true;
      mark(6, 'Arc transaction confirmed · USDC deposited in the staking gate');
    }
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
    if (this.claude || this.status !== 'running') return;
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
    this.status = code === 0 && this.sawResult && (!this.claude || this.model !== null) ? 'completed' : 'failed';
    this.terminal(this.status === 'completed' ? 'Agent exited 0. Proof accepted and Arc stake confirmed.' : 'Agent stopped before confirmed completion. Check the local operator terminal.', 'system');
    if (this.status === 'completed') {
      if (!this.claude) this.steps.forEach(step => { step.status = 'done'; });
    } else {
      this.error = this.redact(reason ?? `Agent did not complete the flow (exit ${code ?? 'signal'}).`);
      this.steps.filter(step => step.status === 'active').forEach(step => { step.status = 'failed'; });
    }
  }

  snapshot() {
    const snapshot = { id: this.id, amount: this.amount, instruction: this.instruction, agent: this.claude ? {provider: 'Claude Code', model: this.model} : null, startedAt: this.startedAt, finishedAt: this.finishedAt,
      status: this.status, wallet: this.wallet, txHash:this.txHash,agentId:this.agentId,proofFingerprint:this.proofFingerprint,error: this.error, steps: this.steps.map(step => ({ ...step })),
      terminal: { command: this.command, lines: this.terminalLines.map(line => ({ ...line })) } };
    return JSON.parse(this.redact(JSON.stringify(snapshot))) as typeof snapshot;
  }
}
