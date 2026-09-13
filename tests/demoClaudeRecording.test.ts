import { describe, expect, it } from 'vitest';
import { Wallet } from 'ethers';
import { RecordingRun, parseInstruction } from '../demo/staking-service/src/recording.ts';
import { ClaudeStreamDecoder, MAX_CLAUDE_STREAM_BYTES, claudeArguments, claudeEnvironment } from '../demo/staking-service/src/claudeSession.ts';
import { createRedactor } from '../demo/user-agent/src/privacy.ts';

const wallet = '0x' + '11'.repeat(20), txHash = '0x' + 'ab'.repeat(32);
const init = { type: 'system', subtype: 'init', model: 'claude-opus-test' };
const call = (id: string, tool: string, input: unknown = {}) => ({ type: 'assistant', message: { content: [{type: 'tool_use', id, name: `mcp__ledger_house__${tool}`, input}] } });
const result = (id: string, value: unknown, isError = false) => ({ type: 'user', message: { content: [{type: 'tool_result', tool_use_id: id, is_error: isError, content: [{type: 'text', text: JSON.stringify(value)}]}] } });
const stake = {ok: true, amount: '0.1', wallet, txHash, block: 123};
function run() { const value = new RecordingRun('0.1'); value.startClaude('Stake 0.1 USDC after checking the dApp.'); value.observeClaude(init); return value; }

describe('real Claude Code recording evidence', () => {
  it('publishes actual tool inputs/results and the actual initialized model, never narration or thinking', () => {
    const value = run();
    value.observeClaude({type: 'assistant', message: {content: [{type: 'text', text: 'private narration'}, {type: 'thinking', thinking: 'private chain of thought'}]}});
    value.observeClaude({type: 'result', result: 'private final answer', subtype: 'success'});
    value.observeClaude({type: 'stream_event', event: {delta: {thinking: 'private delta'}}});
    value.observeClaude(call('a', 'read_dapp', {amount: '0.1'}));
    expect(value.snapshot().steps.every(step => step.status === 'waiting')).toBe(true);
    value.observeClaude(result('a', {ok: true, step: 2, detail: 'Actual dApp response'}));
    expect(value.snapshot().agent).toEqual({provider: 'Claude Code', model: 'claude-opus-test'});
    expect(value.snapshot().instruction).toBe('Stake 0.1 USDC after checking the dApp.');
    expect(value.snapshot().terminal.lines.filter(line => line.kind === 'tool_call')[0].text).toContain('"amount":"0.1"');
    expect(value.snapshot().terminal.lines.filter(line => line.kind === 'tool_result')[0].text).toContain('Actual dApp response');
    expect(value.snapshot().steps[1].status).toBe('done');
    expect(JSON.stringify(value.snapshot())).not.toMatch(/private narration|private chain of thought|private final answer|private delta/);
  });

  it('redacts configured secrets and the derived KYC address from every snapshot field', () => {
    const key = '0x' + '42'.repeat(32), address = new Wallet(key).address;
    const value = new RecordingRun('0.1', createRedactor({ATTESTATION_KEY: key, OPENAI_API_KEY: 'never-share-this-key'}));
    value.startClaude(`Stake while keeping ${address} private.`);
    value.observeClaude(init);
    value.observeClaude(call('a', 'prepare_delegation', {note: key}));
    value.observeClaude(result('a', {ok: true, wallet: address, detail: 'never-share-this-key'}));
    const json = JSON.stringify(value.snapshot());
    expect(json).toContain('****');
    expect(json.toLowerCase()).not.toContain(address.toLowerCase());
    expect(json).not.toContain(key);
    expect(json).not.toContain('never-share-this-key');
  });

  it('requires correlated permitted tool responses, not legacy lines, orphan results, or assistant claims', () => {
    const value = run();
    value.observe(`[6] Staked 0.1 as ${wallet}; tx=${txHash}`);
    value.observeClaude(result('missing', stake));
    value.observeClaude(call('bad', 'unrelated_tool'));
    value.observeClaude(result('bad', stake));
    value.observeClaude({type: 'assistant', message: {content: [{type: 'tool_result', tool_use_id: 'fake', content: JSON.stringify(stake)}]}});
    value.finish(0);
    expect(value.snapshot().status).toBe('failed');
    expect(value.snapshot().txHash).toBeNull();
  });

  it.each([
    {ok: false}, {amount: '0.2'}, {wallet: 'invalid'}, {txHash: 'pending-challenge'},
    {block: 0}, {block: 1.5}, {chainId: 84532},
  ])('rejects invalid stake evidence %j', change => {
    const value = run(); value.observeClaude(call('s', 'stake')); value.observeClaude(result('s', {...stake, ...change})); value.finish(0);
    expect(value.snapshot().status).toBe('failed');
    expect(value.snapshot().steps[5].status).toBe('waiting');
  });

  it('does not advance failed tool results even when their JSON claims ok', () => {
    const value = run(); value.observeClaude(call('a', 'read_dapp')); value.observeClaude(result('a', {ok: true, step: 2}, true));
    expect(value.snapshot().steps.every(step => step.status === 'waiting')).toBe(true);
  });

  it('requires successful process exit after validated stake evidence', () => {
    const value = run(); value.observeClaude(call('s', 'stake')); value.observeClaude(result('s', stake));
    expect(value.snapshot().status).toBe('running'); value.finish(1);
    expect(value.snapshot().status).toBe('failed');
    const success = run(); success.observeClaude(call('s', 'stake')); success.observeClaude(result('s', {...stake, amount: '0.100000'})); success.finish(0);
    expect(success.snapshot().status).toBe('completed'); expect(success.snapshot().txHash).toBe(txHash);
    expect(success.snapshot().error).toBeNull();
    expect(success.snapshot().steps[0].status).toBe('waiting'); // No invented earlier tool evidence.
  });

  it('rejects a delegate that changes after preparation', () => {
    const value = run(); value.observeClaude(call('p', 'prepare_delegation')); value.observeClaude(result('p', {ok: true, wallet}));
    value.observeClaude(call('s', 'stake')); value.observeClaude(result('s', {...stake, wallet: '0x' + '22'.repeat(20)})); value.finish(0);
    expect(value.snapshot().status).toBe('failed');
  });

  it('requires explicit bounded instructions', () => {
    for (const instruction of [undefined, '', '  ', 'x'.repeat(2001), 1]) expect(() => parseInstruction(instruction)).toThrow();
    expect(parseInstruction('  Stake 0.1 USDC  ')).toBe('Stake 0.1 USDC');
  });
});

describe('Claude subprocess boundaries', () => {
  it('preserves chunked UTF-8 JSON and rejects malformed or oversized raw output', () => {
    const events: unknown[] = []; const decoder = new ClaudeStreamDecoder(event => events.push(event));
    const bytes = Buffer.from(JSON.stringify({type: 'system', text: '한글'}) + '\n' + JSON.stringify(init));
    for (const byte of bytes) decoder.push(Buffer.from([byte])); decoder.end();
    expect(events).toEqual([{type: 'system', text: '한글'}, init]);
    expect(() => new ClaudeStreamDecoder(() => {}).push('not json\n')).toThrow('invalid stream JSON');
    expect(() => new ClaudeStreamDecoder(() => {}).push(Buffer.alloc(MAX_CLAUDE_STREAM_BYTES + 1))).toThrow('4 MiB');
  });
  it('passes the instruction as an argument and limits tools without disabling Claude authentication', () => {
    const instruction = 'Stake 0.1; $(echo unsafe)';
    const args = claudeArguments(instruction, '/tmp/example/mcp.json', '0.1');
    expect(args.slice(0, 2)).toEqual(['-p', instruction]);
    expect(args[args.indexOf('--tools') + 1]).toBe('');
    expect(args[args.indexOf('--mcp-config') + 1]).toBe('/tmp/example/mcp.json');
    expect(args[args.indexOf('--allowedTools') + 1]).toBe('mcp__ledger_house__*');
    expect(args).toContain('--strict-mcp-config');
    const env = claudeEnvironment({HOME: '/tmp/home', PATH: '/bin', CLAUDE_CODE_OAUTH_TOKEN: 'auth', ATTESTATION_KEY: 'private', OPENAI_API_KEY: 'private', GEMINI_API_KEY: 'private', CIRCLE_API_KEY: 'private', NODE_OPTIONS: '--require unsafe'});
    expect(env).toEqual({HOME: '/tmp/home', PATH: '/bin', CLAUDE_CODE_OAUTH_TOKEN: 'auth'});
  });
});
