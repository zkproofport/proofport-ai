import { describe, expect, it } from 'vitest';
import { RecordingRun, parseStakeAmount } from '../demo/staking-service/src/recording.js';

describe('recording a real agent run', () => {
  it('accepts only positive USDC amounts with at most six decimal places', () => {
    expect(parseStakeAmount('25')).toBe('25');
    expect(parseStakeAmount('0.001')).toBe('0.001');
    for (const value of ['0', '-1', 'NaN', '1e9', '0.0000001', '1;echo secret', '', '1000001']) {
      expect(() => parseStakeAmount(value)).toThrow();
    }
  });

  it('does not expose raw agent output or the credential wallet in the browser', () => {
    const run = new RecordingRun('25');
    run.observe('[4] Wallet A authorises 0x1111111111111111111111111111111111111111 to stake — A itself stays hidden');
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
