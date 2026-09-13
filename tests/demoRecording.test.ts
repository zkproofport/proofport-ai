import { describe, expect, it } from 'vitest';
import { RecordingRun, parseStakeAmount } from '../demo/staking-service/src/recording.js';

describe('recording a real agent run', () => {
  it('streams real CLI milestones while masking credentials and rejecting raw diagnostics', () => {
    const run = new RecordingRun('0.1');
    run.startCli('http://localhost:4102');
    run.observe('[1] Told to stake 0.1 at http://localhost:4102');
    run.observe('[demo-cli] prove_spawn');
    run.observe('[demo-cli] mcp_connected');
    run.observe('[demo-cli] mcp_generate_proof');
    run.observe('[demo-cli] mcp_connected private-value-never-publish');
    run.observe('ATTESTATION_KEY=private-value-never-publish');
    const terminal = run.snapshot().terminal;
    expect(terminal.command).toContain('--amount 0.1 --pay-on arc-testnet-nano --pay-with arc');
    expect(terminal.lines.some(line => line.text.includes('prove.js arc_eligibility'))).toBe(true);
    expect(terminal.lines.some(line => line.text.includes('generate_proof'))).toBe(true);
    expect(JSON.stringify(terminal)).toContain('****');
    expect(JSON.stringify(terminal)).not.toContain('private-value-never-publish');
    expect(run.snapshot().status).toBe('running');
    expect(terminal.lines.some(line => line.text.includes('Proof generated'))).toBe(false);
  });
  it('accepts only positive USDC amounts with at most six decimal places', () => {
    expect(parseStakeAmount('25')).toBe('25');
    expect(parseStakeAmount('0.001')).toBe('0.001');
    for (const value of ['0', '-1', 'NaN', '1e9', '0.0000001', '1;echo secret', '', '1000001']) {
      expect(() => parseStakeAmount(value)).toThrow();
    }
  });

  it('does not expose raw agent output or the credential wallet in the browser', () => {
    const run = new RecordingRun('25');
    run.observe('[4] Wallet A authorises 0x1111111111111111111111111111111111111111 to stake 25 USDC; amount and expiry are bound');
    run.observe('[4] Credential diagnostic for A: 0x2222222222222222222222222222222222222222');
    run.observe('Wallet A (the KYC): 0x2222222222222222222222222222222222222222 ← never sent');
    run.observe('ATTESTATION_KEY=not-for-the-browser');
    const json = JSON.stringify(run.snapshot());
    expect(json).toContain('0x1111111111111111111111111111111111111111');
    expect(json).not.toContain('0x2222222222222222222222222222222222222222');
    expect(json).not.toContain('ATTESTATION_KEY');
  });

  it('reports failure when the process fails, even after printing a success line', () => {
    const run = new RecordingRun('25');
    run.observe('[6] Staked 25 as 0x1111111111111111111111111111111111111111; tx=0x' + 'ab'.repeat(32));
    expect(run.snapshot().status).toBe('running');
    run.finish(1);
    expect(run.snapshot().status).toBe('failed');
  });

  it('does not claim success for an empty successful process', () => {
    const run = new RecordingRun('25');
    run.finish(0);
    expect(run.snapshot().status).toBe('failed');
  });

  it('refuses an off-chain success line without a transaction hash', () => {
    const run = new RecordingRun('1');
    run.observe('[6] Staked 1 as 0x1111111111111111111111111111111111111111');
    run.finish(0);
    expect(run.snapshot().status).toBe('failed');
    expect(run.snapshot().txHash).toBeNull();
  });

  it('finishes only when the agent reports a result and exits successfully', () => {
    const run = new RecordingRun('25');
    run.observe('[2] Ledger House wants a Coinbase KYC proof (arc_eligibility)');
    run.observe('[6] Staked 25 as 0x1111111111111111111111111111111111111111; tx=0x' + 'ab'.repeat(32));
    run.finish(0);
    expect(run.snapshot().status).toBe('completed');
    expect(run.snapshot().wallet).toBe('0x1111111111111111111111111111111111111111');
  });
});
