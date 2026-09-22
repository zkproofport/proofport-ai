import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseUnits } from 'ethers';
import { buildPaymentRequirements, getPaymentNetwork } from '../../src/payment/networks.js';

const { run } = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('node:child_process', () => ({
  execFile: Object.assign(vi.fn(), { [Symbol.for('nodejs.util.promisify.custom')]: run }),
}));
import { walletFromArcAgent } from '../../packages/sdk/src/arcWallet.js';
import { signPayment } from '../../packages/sdk/src/payment.js';
const agent = '0x1111111111111111111111111111111111111111';
const backer = '0x2222222222222222222222222222222222222222';
const signature = `0x${'ab'.repeat(64)}1b`;

beforeEach(() => {
  run.mockReset();
  run.mockImplementation(async (_file: string, args: string[]) => ({ stdout: JSON.stringify({
    data: args[0] === 'gateway' ? { backingEOA: backer } : { signature },
  }) }));
});

describe('Circle agent wallet payment identities', () => {
  it.each([
    ['arc-testnet', agent],
    ['arc-testnet-nano', backer],
  ])('%s uses its own authorization owner', async (networkId, payer) => {
    const wallet = await walletFromArcAgent({ address: agent });
    const net = getPaymentNetwork(networkId)!;
    const accepts = buildPaymentRequirements({ networks: [net], price: '0.01', payTo: '0x3333333333333333333333333333333333333333', resource: 'https://example.invalid/prove', nonce: `0x${'11'.repeat(32)}`, parseUnits });
    const paid = await signPayment({ accepts }, wallet, { network: networkId });
    const args = run.mock.calls.find(([, args]) => args[0] === 'wallet')![1] as string[];
    const typed = JSON.parse(args[3]);
    expect(typed.message.from.toLowerCase()).toBe(payer);
    expect(paid.payer.toLowerCase()).toBe(payer);
    // Circle still selects the same operational wallet for either signature.
    expect(args).toEqual(expect.arrayContaining(['--address', agent]));
    expect(typed.types.EIP712Domain).toContainEqual({ name: 'verifyingContract', type: 'address' });
    expect(wallet.address).toBe(agent);
    expect(wallet.gatewayAddress).toBe(backer);
  });

  it('does not mutate a shared wallet when direct and Gateway signing run together', async () => {
    const wallet = await walletFromArcAgent({ address: agent });
    await Promise.all(['arc-testnet', 'arc-testnet-nano'].map(async networkId => {
      const accepts = buildPaymentRequirements({ networks: [getPaymentNetwork(networkId)!], price: '0.01', payTo: '0x3333333333333333333333333333333333333333', resource: 'https://example.invalid/prove', nonce: `0x${'22'.repeat(32)}`, parseUnits });
      const paid = await signPayment({ accepts }, wallet, { network: networkId });
      expect(paid.payer.toLowerCase()).toBe(networkId.endsWith('-nano') ? backer : agent);
    }));
    expect(wallet.address).toBe(agent);
  });
});
