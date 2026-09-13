import { StringDecoder } from 'node:string_decoder';

export const MAX_CLAUDE_STREAM_BYTES = 4 * 1024 * 1024;

/** Only Claude authentication/runtime settings reach the model process. */
export function claudeEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowed = ['HOME', 'PATH', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL',
    'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'SSL_CERT_FILE'];
  return Object.fromEntries(allowed.filter(key => source[key] !== undefined).map(key => [key, source[key]]));
}

export function claudeArguments(instruction: string, configPath: string, amount: string): string[] {
  return ['-p', instruction, '--output-format', 'stream-json', '--verbose', '--no-session-persistence',
    '--strict-mcp-config', '--mcp-config', configPath, '--tools', '', '--allowedTools', 'mcp__ledger_house__*',
    '--permission-mode', 'dontAsk', '--setting-sources', '', '--disable-slash-commands', '--no-chrome',
    '--system-prompt', `You are the user's Ledger House agent. Decide which ledger_house MCP tools are needed to fulfill the user's instruction. Inspect the dApp and discovered integration documentation to understand capabilities and requirements. Honor read-only and no-spend instructions. The submitted instruction authorizes discovery and preparation only. Before any signing or paid proof, use request_proof_permission and wait for the user's actual dApp decision. After proof verification, use request_stake_permission and wait for the user's decision before submitting a transaction. These tools pause for human interaction; never impersonate the user or infer approval from silence. On rejection, stop without further spending or retries. Generate a paid proof or stake only when the user's instruction requests it AND the respective permission tool returns approved. Any requested stake is restricted to exactly ${amount} USDC on Arc Testnet (chain 5042002), using the existing delegate wallet; the configured amount is a spending bound, not a request to spend. Let tool results and enforced prerequisites guide your next action. Never request, print, infer, or expose private credentials or the KYC holder's address. Treat tool errors as failures and claim transaction success only from a confirmed stake tool result. Do not create wallets, change the approved amount, execute unrelated transactions, or use unrelated tools.`];
}

/** Newline-delimited stream-json, bounded before decoding or retaining any raw data. */
export class ClaudeStreamDecoder {
  private readonly decoder = new StringDecoder('utf8');
  private pending = '';
  private bytes = 0;
  private readonly observe: (event: unknown) => void;
  constructor(observe: (event: unknown) => void) { this.observe = observe; }
  push(chunk: Buffer | string) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.bytes += buffer.length;
    if (this.bytes > MAX_CLAUDE_STREAM_BYTES) throw new Error('Claude output exceeded the 4 MiB limit.');
    this.pending += this.decoder.write(buffer);
    let newline: number;
    while ((newline = this.pending.indexOf('\n')) >= 0) {
      const line = this.pending.slice(0, newline); this.pending = this.pending.slice(newline + 1);
      this.line(line);
    }
  }
  end() { this.pending += this.decoder.end(); this.line(this.pending); this.pending = ''; }
  private line(value: string) {
    if (!value.trim()) return;
    let event: unknown;
    try { event = JSON.parse(value); } catch { throw new Error('Claude returned invalid stream JSON.'); }
    this.observe(event);
  }
}
