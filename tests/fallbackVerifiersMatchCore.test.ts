import { describe, expect, it } from 'vitest';
import { PINNED_VERIFIERS, sameAddress } from '@zkproofport-app/core';
import { FALLBACK_VERIFIERS } from '../src/config/contracts.js';
import { unpinnedVerifierReason } from '../src/config/deployments.js';
import { PROVABLE_CIRCUIT_IDS, type CircuitId } from '../src/config/circuitIds.js';

/**
 * Clients verify against @zkproofport-app/core's pinned table and refuse a
 * response naming any other verifier. A server advertising a different address
 * produces proofs its own SDK and MCP refuse. Ethereum Sepolia here was three
 * deployments behind core until 2026-10-27.
 */
/**
 * coinbase_attestation is served as v2 while core 0.3.0 pins v1's verifiers.
 * The exception is checked rather than skipped: v2's only deployment is Base
 * Sepolia, every other chain is null, and core must still pin something
 * other than v2 -- the day core pins v2, this fails and the exception goes.
 */
const COINBASE_V2: Record<string, string | null> = {
  '1': null, '8453': null, '11155111': null, '91342': null,
  '84532': '0x1885aA2283DB21ad0fc63A2Df98efe92F31908E6',
};

describe('coinbase_attestation v2 ahead of core', () => {
  for (const [chain, address] of Object.entries(COINBASE_V2)) {
    it(`chain ${chain}`, () => {
      expect(FALLBACK_VERIFIERS[chain].coinbase_attestation).toBe(address);
      const theirs = PINNED_VERIFIERS.coinbase_attestation?.[Number(chain)];
      if (address) expect(theirs && sameAddress(theirs.address, address), 'core now pins v2: remove this exception').toBeFalsy();
    });
  }
  it('covers every chain the fallback table has', () => {
    expect(Object.keys(COINBASE_V2).sort()).toEqual(Object.keys(FALLBACK_VERIFIERS).sort());
  });
});

describe('FALLBACK_VERIFIERS agrees with core PINNED_VERIFIERS', () => {
  for (const [chain, row] of Object.entries(FALLBACK_VERIFIERS)) {
    for (const circuit of PROVABLE_CIRCUIT_IDS.filter(c => c !== 'coinbase_attestation')) {
      it(`${circuit} on chain ${chain}`, () => {
        const ours = row[circuit];
        const theirs = PINNED_VERIFIERS[circuit]?.[Number(chain)];
        if (ours === null) {
          expect(theirs, `core pins ${circuit} on ${chain} but the server says it is not deployed`).toBeUndefined();
        } else {
          expect(theirs, `server has ${circuit} on ${chain}, core pins nothing there`).toBeDefined();
          expect(sameAddress(ours, theirs!.address), `${ours} vs core ${theirs!.address}`).toBe(true);
        }
      });
    }
  }
});

describe('unpinnedVerifierReason', () => {
  const pinned = PINNED_VERIFIERS.coinbase_attestation[84532].address;

  it('accepts the pinned address in any case', () => {
    expect(unpinnedVerifierReason('coinbase_attestation', 84532, pinned)).toBeNull();
    expect(unpinnedVerifierReason('coinbase_attestation', 84532, pinned.toUpperCase().replace('0X', '0x'))).toBeNull();
  });

  it('names both addresses when a synced deployment is not the pinned one', () => {
    const reason = unpinnedVerifierReason('coinbase_attestation', 84532, '0x00000000000000000000000000000000000000a1');
    expect(reason).toContain(pinned);
    expect(reason).toContain('0x00000000000000000000000000000000000000a1');
  });

  it('names the chain when core pins nothing there', () => {
    expect(unpinnedVerifierReason('giwa_attestation', 84532, pinned)).toContain('no giwa_attestation verifier on chain 84532');
  });

  it('refuses something that is not an address', () => {
    expect(unpinnedVerifierReason('coinbase_attestation' as CircuitId, 84532, '')).not.toBeNull();
  });
});
