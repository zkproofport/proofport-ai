import { describe, expect, it } from 'vitest';
import { selectAgentDelegate } from '../demo/user-agent/src/wallet.js';

const connected = '0x1111111111111111111111111111111111111111';
const another = '0x2222222222222222222222222222222222222222';
describe('the connected agent wallet receives the delegation', () => {
  it('uses the single connected wallet without creating a new wallet', () => {
    expect(selectAgentDelegate([connected])).toBe(connected);
  });
  it('refuses to guess if multiple wallets are connected', () => {
    expect(() => selectAgentDelegate([connected, another])).toThrow(/ARC_AGENT_WALLET/);
    expect(selectAgentDelegate([connected, another], another)).toBe(another);
  });
  it('refuses an address that is not connected or is invalid', () => {
    expect(() => selectAgentDelegate([connected], another)).toThrow();
    expect(() => selectAgentDelegate([])).toThrow();
    expect(() => selectAgentDelegate(['undefined'])).toThrow();
  });
});
