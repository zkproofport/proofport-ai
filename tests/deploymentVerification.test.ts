import { describe, expect, it } from 'vitest';
import { validateDeploymentSnapshot } from '../scripts/verify-deployment.js';
import { PROVABLE_CIRCUIT_IDS } from '../src/config/circuitIds.js';
import { buildPaymentRequirements, resolvePaymentNetworks } from '../src/payment/networks.js';
import { parseUnits } from 'ethers';

const registry = '0x8004A818BFB912233c491871b3d84c89A494BD9e';
const expected = {
  version: '0.2.9',
  baseUrl: 'https://stg-ai.zkproofport.app',
  paymentNetworks: 'base-sepolia,arc-testnet,ethereum-sepolia,arc-testnet-nano',
  payTo: '0x5A3E649208Ae15ec52496c1Ae23b2Ff89Ac02f0c',
  price: '$0.001',
  identities: [{ chainId: 84532, agentId: '592', registry }, { chainId: 11155111, agentId: '3288', registry }, { chainId: 5042002, agentId: '894776', registry }],
};
function snapshot() {
  const offers = buildPaymentRequirements({ networks: resolvePaymentNetworks(expected.paymentNetworks), price: '0.001', payTo: expected.payTo, resource: expected.baseUrl + '/api/v1/prove', nonce: '0x' + '11'.repeat(32), parseUnits });
  return {
    health: { version: expected.version, status: 'healthy', paymentRequired: true, paymentNetworks: expected.paymentNetworks },
    identity: { status: 'ready', registrations: expected.identities.map(({ chainId, agentId }) => ({ chainId, agentId })) },
    registration: { registrations: expected.identities.map(({ chainId, agentId, registry }) => ({ agentId: Number(agentId), agentRegistry: `eip155:${chainId}:${registry}` })) },
    card: { version: expected.version, url: expected.baseUrl + '/a2a', skills: [{ id: 'prove', description: PROVABLE_CIRCUIT_IDS.join(', ') }] },
    challenges: Object.fromEntries(PROVABLE_CIRCUIT_IDS.map(id => [id, { status: 402, body: { requiresPayment: true, accepts: structuredClone(offers) } }])),
  };
}
describe('deployment verifies the entire configured service', () => {
  it('rejects an old server package or stale advertised agent version', () => {
    for (const field of ['health', 'card'] as const) {
      const value = snapshot();
      value[field].version = '0.0.1';
      expect(() => validateDeploymentSnapshot(expected, value)).toThrow(/version/i);
    }
  });
  it('accepts all configured identities, circuits and four distinct payment methods', () => {
    expect(() => validateDeploymentSnapshot(expected, snapshot())).not.toThrow();
  });
  it.each([84532, 11155111, 5042002])('rejects missing identity %s even when status says ready', chainId => {
    const value = snapshot();
    value.identity.registrations = value.identity.registrations.filter(row => row.chainId !== chainId);
    expect(() => validateDeploymentSnapshot(expected, value)).toThrow(/identit/i);
  });
  it('rejects an incorrect registry or token in the public document', () => {
    const value = snapshot();
    value.registration.registrations[0].agentId = 999;
    expect(() => validateDeploymentSnapshot(expected, value)).toThrow(/registration/i);
  });
  it.each(PROVABLE_CIRCUIT_IDS)('requires every payment method for %s', circuit => {
    const value = snapshot();
    value.challenges[circuit].body.accepts.pop();
    expect(() => validateDeploymentSnapshot(expected, value)).toThrow(/payment/i);
  });
  it('distinguishes ordinary Arc payments from Arc nanopayments on the same chain', () => {
    const value = snapshot();
    const rows = value.challenges.giwa_attestation.body.accepts;
    rows[3] = structuredClone(rows[1]);
    expect(() => validateDeploymentSnapshot(expected, value)).toThrow(/payment/i);
  });
  it('rejects a wrong recipient or amount before asking anyone to pay', () => {
    for (const field of ['payTo', 'amount']) {
      const value = snapshot();
      (value.challenges.coinbase_attestation.body.accepts[0] as any)[field] = '0';
      expect(() => validateDeploymentSnapshot(expected, value)).toThrow(/payment/i);
    }
  });
  it('rejects an unadvertised circuit and a different environment URL', () => {
    const value = snapshot();
    value.card.skills[0].description = 'arc_eligibility';
    expect(() => validateDeploymentSnapshot(expected, value)).toThrow(/circuit/i);
    const wrongUrl = snapshot();
    wrongUrl.card.url = 'https://ai.zkproofport.app/a2a';
    expect(() => validateDeploymentSnapshot(expected, wrongUrl)).toThrow(/URL/);
  });
  it('does not accept testnet registrations when production identities are expected', () => {
    const production = { ...expected, identities: [{ chainId: 1, agentId: '31921', registry: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432' }, { chainId: 8453, agentId: '25331', registry: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432' }] };
    expect(() => validateDeploymentSnapshot(production, snapshot())).toThrow(/identit/i);
  });
});
