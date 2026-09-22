/**
 * Which attester a circuit is checked against comes from one table per layer,
 * and an id the table does not hold is an error.
 *
 * The server and the AI SDK each carry their own copy — the SDK is published
 * and cannot import the server — so both are checked here, against the same
 * expectations. They were three separate two-branch tests before 2026-09-22:
 * which attester contract, which signer list, which lookup, each written as
 * "GIWA, else Coinbase". Nothing failed when a circuit was missed; the request
 * was simply validated against Coinbase's attester and proved against
 * Coinbase's four signers, and the proof came back wrong somewhere else.
 */
import { describe, it, expect } from 'vitest';
import { CIRCUIT_IDS } from '@zkproofport-app/sdk/circuits';
import { PROVABLE_CIRCUIT_IDS } from '../src/config/circuitIds.js';
import { ATTESTATION_SOURCES as SERVER_SOURCES } from '../src/config/contracts.js';
import {
  ATTESTATION_SOURCES as SDK_SOURCES,
  attestationSource,
  COINBASE_ATTESTER_CONTRACT,
  GIWA_ATTESTER_CONTRACT,
} from '../packages/sdk/src/constants.js';

describe('one table decides which attester a circuit is checked against', () => {
  it('covers every circuit this server can prove, in both copies', () => {
    for (const id of PROVABLE_CIRCUIT_IDS) {
      expect(Object.hasOwn(SERVER_SOURCES, id), `server table is missing ${id}`).toBe(true);
      expect(Object.hasOwn(SDK_SOURCES, id), `SDK table is missing ${id}`).toBe(true);
    }
  });

  it('agrees between the server and the SDK on the attester and its signers', () => {
    for (const id of PROVABLE_CIRCUIT_IDS) {
      const server = SERVER_SOURCES[id];
      const sdk = SDK_SOURCES[id];
      if (server === null || sdk === null) {
        expect(server, `${id}: one copy says it has no attestation and the other does not`).toBe(sdk);
        continue;
      }
      expect(sdk.contract, `${id}: attester contract`).toBe(server.contract);
      expect([...sdk.signers], `${id}: accepted signers`).toEqual([...server.signers]);
      expect(sdk.kind, `${id}: how the attestation is found`).toBe(server.kind);
    }
  });

  it('sends GIWA to our attester on GIWA Sepolia, not to Coinbase', () => {
    const giwa = attestationSource(CIRCUIT_IDS.GIWA_ATTESTATION);
    expect(giwa.contract).toBe(GIWA_ATTESTER_CONTRACT);
    expect(giwa.contract).not.toBe(COINBASE_ATTESTER_CONTRACT);
    expect(giwa.kind).toBe('giwa-sepolia');
  });

  it('refuses an id the table does not hold instead of answering Coinbase', () => {
    expect(() => attestationSource('nonexistent_circuit' as never))
      .toThrow(/Unknown circuit 'nonexistent_circuit'/);
  });

  it('says plainly that OIDC has no attestation to fetch', () => {
    expect(() => attestationSource(CIRCUIT_IDS.OIDC_DOMAIN_ATTESTATION))
      .toThrow(/no on-chain attestation/);
  });
});
