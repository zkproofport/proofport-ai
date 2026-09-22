import { describe, expect, it } from 'vitest';
import { CIRCUITS } from '../src/config/circuits.js';

describe('circuit discovery input requirements', () => {
  it.each(['arc_eligibility', 'giwa_attestation'] as const)('%s does not require optional action inputs', circuit => {
    expect(CIRCUITS[circuit].requiredInputs).not.toContain('domain_separator');
    expect(CIRCUITS[circuit].requiredInputs).not.toContain('action_hash');
    expect(CIRCUITS[circuit].description).toMatch(/optional/i);
  });
  it('OIDC advertises the JWKS required by the proving endpoint', () => {
    expect(CIRCUITS.oidc_domain_attestation.requiredInputs).toEqual(expect.arrayContaining(['jwt', 'jwks', 'scope']));
  });
});
