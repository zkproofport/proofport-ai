/**
 * The EIP-712 action check the published client SDK exposes is core's.
 *
 * `@zkproofport-app/core/typedAction` owns the rule for what a usable EIP-712
 * action is. `@zkproofport-ai/sdk` used to keep a mirrored copy, held equal by
 * comparing it with the customer SDK's build; it now re-exports core's function
 * and `hashTypedAction` calls it, so there is one validator and nothing to
 * compare. What is checked here is that the wiring stays that way and that the
 * function still refuses every broken shape below.
 */
import { describe, it, expect } from 'vitest';

import { validateTypedAction as fromCore } from '@zkproofport-app/core/typedAction';
import { validateTypedAction as fromClientSdk, hashTypedAction } from '../packages/sdk/src/index.js';

const GOOD = {
  domain: {
    name: 'MyVault',
    version: '1',
    chainId: 91342,
    verifyingContract: '0x0000000000000000000000000000000000000000',
  },
  types: { Deposit: [{ name: 'amount', type: 'uint256' }, { name: 'nonce', type: 'uint256' }] },
  primaryType: 'Deposit',
  message: { amount: '1000000', nonce: '1' },
};

const drop = (path_: string) => {
  const copy = JSON.parse(JSON.stringify(GOOD));
  const parts = path_.split('.');
  let cur = copy;
  for (const p of parts.slice(0, -1)) cur = cur[p];
  delete cur[parts[parts.length - 1]];
  return copy;
};

/** A good action, then every way of breaking one. */
const CASES: Array<[string, unknown]> = [
  ['a complete action', GOOD],
  ['no action at all', undefined],
  ['null', null],
  ['a string', 'deposit 1 USDC'],
  ['an array', [GOOD]],
  ['no domain', drop('domain')],
  ['no domain.name', drop('domain.name')],
  ['no domain.version', drop('domain.version')],
  ['no domain.verifyingContract', drop('domain.verifyingContract')],
  ['no domain.chainId', drop('domain.chainId')],
  ['a chainId that is a string', { ...GOOD, domain: { ...GOOD.domain, chainId: '91342' } }],
  ['a verifyingContract that is not an address', { ...GOOD, domain: { ...GOOD.domain, verifyingContract: 'MyVault' } }],
  ['no types', drop('types')],
  ['no primaryType', drop('primaryType')],
  ['a primaryType naming no struct', { ...GOOD, primaryType: 'Withdraw' }],
  ['a struct with no fields', { ...GOOD, types: { Deposit: [] } }],
  ['no message', drop('message')],
  ['a message missing a declared field', { ...GOOD, message: { amount: '1000000' } }],
];

describe('the client SDK uses core\'s action check', () => {
  it('re-exports core\'s function rather than a copy', () => {
    expect(fromClientSdk).toBe(fromCore);
  });

  it('accepts the good action and rejects every broken one', () => {
    expect(fromClientSdk(GOOD)).toBeNull();
    for (const [name, value] of CASES.slice(1)) {
      expect(fromClientSdk(value), `${name} should have been refused`).toBeTruthy();
    }
  });

  it.each(CASES.slice(1))('hashTypedAction refuses %s with core\'s reason', (_name, value) => {
    expect(() => hashTypedAction(value as never)).toThrow(fromCore(value) as string);
  });
});
