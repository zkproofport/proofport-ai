/**
 * The mirrored action check answers exactly what the customer SDK's does.
 *
 * `@zkproofport-app/sdk` owns the rule for what a usable `arc_eligibility`
 * action is. This package keeps a copy, for the same reason it copies the
 * circuit ids: it is published and runs on every `npx zkproofport-mcp`, and
 * depending on the customer SDK drags qrcode and socket.io-client along.
 *
 * A copy is only acceptable while something proves it has not drifted. Two
 * validators disagreeing about what a dapp may send is worse than either rule
 * alone: the SDK accepts an action, the CLI refuses it, and nobody can say
 * which is right.
 */
import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';

import { validateTypedAction as mirrored } from '../packages/sdk/src/typedAction.js';

const GOOD = {
  domain: {
    name: 'MyVault',
    version: '1',
    chainId: 5042002,
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

/** Everything both validators must agree about. */
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
  ['a chainId that is a string', { ...GOOD, domain: { ...GOOD.domain, chainId: '5042002' } }],
  ['a verifyingContract that is not an address', { ...GOOD, domain: { ...GOOD.domain, verifyingContract: 'MyVault' } }],
  ['no types', drop('types')],
  ['no primaryType', drop('primaryType')],
  ['a primaryType naming no struct', { ...GOOD, primaryType: 'Withdraw' }],
  ['a struct with no fields', { ...GOOD, types: { Deposit: [] } }],
  ['no message', drop('message')],
  ['a message missing a declared field', { ...GOOD, message: { amount: '1000000' } }],
];

/**
 * The customer SDK's own validator, from the sibling checkout's build.
 *
 * Loaded from `dist` because that is what a consumer installs. When it is not
 * built the comparison cannot run, and the test says so rather than passing.
 */
async function customerValidator(): Promise<(v: unknown) => string | null> {
  const dir = path.resolve(__dirname, '../../proofport-app-sdk');
  for (const candidate of ['dist/typedAction.mjs', 'dist/typedAction.esm.js', 'dist/typedAction.js']) {
    const file = path.join(dir, candidate);
    if (existsSync(file)) {
      const mod = await import(pathToFileURL(file).href);
      return mod.validateTypedAction;
    }
  }
  throw new Error(
    `The customer SDK is not built at ${dir}/dist — run \`npm run build\` there. ` +
      'Without it this guard cannot compare the two validators, and the mirror is unchecked.',
  );
}

describe('the mirrored action check matches the customer SDK', () => {
  it.each(CASES)('agrees about %s', async (_name, value) => {
    const theirs = await customerValidator();
    const ours = mirrored(value);
    const expected = theirs(value);
    // Compared as exact strings: the message is what a dapp developer reads,
    // and "both rejected it" is not the same as "both said why the same way".
    expect(ours).toBe(expected);
  });

  it('accepts the good action and rejects every broken one', () => {
    expect(mirrored(GOOD)).toBeNull();
    for (const [name, value] of CASES.slice(1)) {
      expect(mirrored(value), `${name} should have been refused`).toBeTruthy();
    }
  });
});
