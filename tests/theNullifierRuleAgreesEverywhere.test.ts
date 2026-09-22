/**
 * The nullifier a circuit expects is derived the same way in every copy, and
 * the circuits that can bind an action do not derive it from `signal_hash`.
 *
 * Three places compute it — the circuit itself, the server's input builder,
 * and the published AI SDK, which cannot import the server. The two TypeScript
 * copies are compared here directly. When they disagree the proof fails with
 * "Nullifier mismatch", which names neither of them; that is exactly how the
 * GIWA E2E failed on 2026-09-22, because the SDK still used the old formula
 * after the circuits changed.
 *
 * The property underneath: for a circuit that can carry an action, the
 * nullifier must NOT move when `signal_hash` moves. It is zero in action mode
 * and unconstrained otherwise, so a nullifier taken from it would give one
 * wallet a fresh identity per request — which is the thing a nullifier exists
 * to prevent.
 */
import { describe, it, expect } from 'vitest';
import { ethers } from 'ethers';
import { CIRCUIT_IDS, circuitActionBinding } from '@zkproofport-app/sdk/circuits';
import { PROVABLE_CIRCUIT_IDS } from '../src/config/circuitIds.js';
import { nullifierForCircuit as serverNullifier } from '../src/input/inputBuilder.js';
import { nullifierForCircuit as sdkNullifier } from '../packages/sdk/src/inputs.js';

const WALLET = '0xD6C714247037E5201B7e3dEC97a3ab59a9d2F739';
const SCOPE = ethers.getBytes(ethers.keccak256(ethers.toUtf8Bytes('test:nullifier-rule')));
const SIGNAL = ethers.getBytes(ethers.keccak256(ethers.toUtf8Bytes('one signal')));
const OTHER_SIGNAL = ethers.getBytes(ethers.keccak256(ethers.toUtf8Bytes('another signal')));

const WITH_ATTESTATION = PROVABLE_CIRCUIT_IDS.filter(
  (id) => id !== CIRCUIT_IDS.OIDC_DOMAIN_ATTESTATION,
);

describe('the nullifier rule agrees everywhere', () => {
  it.each(WITH_ATTESTATION)('server and SDK compute the same nullifier for %s', (id) => {
    expect(ethers.hexlify(sdkNullifier(id, WALLET, SIGNAL, SCOPE)))
      .toBe(ethers.hexlify(serverNullifier(id, WALLET, SIGNAL, SCOPE)));
  });

  it.each(WITH_ATTESTATION)('%s: one wallet and scope give one nullifier', (id) => {
    const again = sdkNullifier(id, WALLET, SIGNAL, SCOPE);
    expect(ethers.hexlify(again)).toBe(ethers.hexlify(sdkNullifier(id, WALLET, SIGNAL, SCOPE)));
  });

  it.each(WITH_ATTESTATION)(
    '%s: an action-carrying circuit ignores signal_hash, one that cannot carry an action does not',
    (id) => {
      const a = ethers.hexlify(sdkNullifier(id, WALLET, SIGNAL, SCOPE));
      const b = ethers.hexlify(sdkNullifier(id, WALLET, OTHER_SIGNAL, SCOPE));
      if (circuitActionBinding(id) === 'none') {
        expect(a).not.toBe(b);
      } else {
        expect(a).toBe(b);
      }
    },
  );

  it('separates wallets and scopes', () => {
    const other = '0x5A3E649208Ae15ec52496c1Ae23b2Ff89Ac02f0c';
    const otherScope = ethers.getBytes(ethers.keccak256(ethers.toUtf8Bytes('test:other-scope')));
    const base = ethers.hexlify(sdkNullifier(CIRCUIT_IDS.GIWA_ATTESTATION, WALLET, SIGNAL, SCOPE));
    expect(ethers.hexlify(sdkNullifier(CIRCUIT_IDS.GIWA_ATTESTATION, other, SIGNAL, SCOPE))).not.toBe(base);
    expect(ethers.hexlify(sdkNullifier(CIRCUIT_IDS.GIWA_ATTESTATION, WALLET, SIGNAL, otherScope))).not.toBe(base);
  });

  it('refuses a circuit it has no rule for, rather than picking one', () => {
    expect(() => sdkNullifier('nonexistent_circuit' as never, WALLET, SIGNAL, SCOPE))
      .toThrow(/No nullifier rule/);
    expect(() => serverNullifier('nonexistent_circuit', WALLET, SIGNAL, SCOPE))
      .toThrow(/No nullifier rule/);
  });

  it('says OIDC builds its nullifier from the identity token', () => {
    expect(() => sdkNullifier(CIRCUIT_IDS.OIDC_DOMAIN_ATTESTATION, WALLET, SIGNAL, SCOPE))
      .toThrow(/identity token/);
  });
});
