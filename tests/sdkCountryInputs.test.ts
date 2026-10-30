/**
 * The AI SDK's prepareInputs refuses a country list the Country circuit would
 * refuse, before it signs anything, fetches an attestation or pays.
 *
 * Matrix: boundary 0 / 10 / 11 codes; hostile lowercase, 3 letters, Korean,
 * a number; empty list / missing is_included. Every refusal happens before
 * the attestation fetch (fetch is a spy that must not be called).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import { computeSignalHash, prepareInputs } from '../packages/sdk/src/inputs.js';

const config = { baseUrl: 'https://proof.example.com' } as never;
const base = {
  circuitId: 'coinbase_country_attestation' as const,
  userAddress: '0xD6C714247037E5201B7e3dEC97a3ab59a9d2F739',
  userSignature: '0x' + '11'.repeat(65),
  scope: 'proofport',
  isIncluded: true,
};

afterEach(() => vi.restoreAllMocks());

describe('prepareInputs for coinbase_country_attestation', () => {
  it.each([
    ['an empty list', { countryList: [] }, /countryList is required/],
    ['11 codes', { countryList: Array(11).fill('US') }, /at most 10/],
    ['lowercase', { countryList: ['kr'] }, /not an ISO 3166-1 alpha-2 code/],
    ['three letters', { countryList: ['KOR'] }, /not an ISO 3166-1 alpha-2 code/],
    ['Korean', { countryList: ['한국'] }, /not an ISO 3166-1 alpha-2 code/],
    ['a number', { countryList: [82 as unknown as string] }, /not an ISO 3166-1 alpha-2 code/],
    ['no is_included', { countryList: ['KR'], isIncluded: undefined }, /isIncluded is required/],
  ])('refuses %s before fetching anything', async (_name, extra, error) => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await expect(prepareInputs(config, { ...base, ...extra } as never)).rejects.toThrow(error);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('lets exactly 10 codes through to the attestation fetch', async () => {
    const wallet = ethers.Wallet.createRandom();
    const signal = computeSignalHash(wallet.address, 'proofport', 'coinbase_country_attestation');
    const signed = { userAddress: wallet.address, userSignature: await wallet.signMessage(signal) };
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network stopped by the test'));
    await expect(prepareInputs(config, { ...base, ...signed, countryList: ['KR', 'US', 'JP', 'DE', 'FR', 'GB', 'CA', 'AU', 'SG', 'NZ'] }))
      .rejects.toThrow(/network stopped by the test|attestation/i);
    expect(fetchSpy).toHaveBeenCalled();
  });
});
