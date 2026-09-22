import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { parseUnits } from 'ethers';
import { PROVABLE_CIRCUIT_IDS } from '../src/config/circuitIds.js';
import { buildPaymentRequirements, resolvePaymentNetworks } from '../src/payment/networks.js';

type Identity = { chainId: number; agentId: string; registry: string };
export type DeploymentExpectation = {
  version: string; baseUrl: string; paymentNetworks: string; payTo: string; price: string; identities: Identity[];
};
type Json = Record<string, any>;
export type DeploymentSnapshot = {
  health: Json; identity: Json; registration: Json; card: Json;
  challenges: Record<string, { status: number; body: Json }>;
};
const sorted = (rows: unknown[]) => rows.map(row => JSON.stringify(row)).sort();

export function validateDeploymentSnapshot(expected: DeploymentExpectation, value: DeploymentSnapshot): void {
  assert.equal(value.health.version, expected.version, 'Deployed server package version differs');
  assert.equal(value.card.version, expected.version, 'Advertised agent version differs');
  assert.equal(value.health.status, 'healthy', 'Service health is not healthy');
  assert.equal(value.health.paymentRequired, true, 'Deployed service must require payment');
  assert.deepEqual(resolvePaymentNetworks(value.health.paymentNetworks).map(n => n.id).sort(), resolvePaymentNetworks(expected.paymentNetworks).map(n => n.id).sort(), 'Configured payment networks differ');
  assert.ok(expected.identities.length > 0, 'Expected identities must not be empty');
  assert.equal(value.identity.status, 'ready', 'All configured identities must be ready');
  assert.deepEqual(sorted(value.identity.registrations.map((r: Json) => [r.chainId, String(r.agentId)])), sorted(expected.identities.map(r => [r.chainId, r.agentId])), 'Missing or unexpected identities');
  assert.deepEqual(sorted(value.registration.registrations.map((r: Json) => [r.agentRegistry.toLowerCase(), String(r.agentId)])), sorted(expected.identities.map(r => [`eip155:${r.chainId}:${r.registry.toLowerCase()}`, r.agentId])), 'Public registration document differs');
  assert.equal(value.card.url, `${expected.baseUrl}/a2a`, 'Agent URL belongs to a different environment');
  const proofSkill = value.card.skills?.find((s: Json) => s.id === 'prove');
  const offers = buildPaymentRequirements({ networks: resolvePaymentNetworks(expected.paymentNetworks), price: expected.price.replace(/^\$/, ''), payTo: expected.payTo, resource: `${expected.baseUrl}/api/v1/prove`, nonce: '0x' + '00'.repeat(32), parseUnits });
  // Arc exact and Arc Gateway share a chain ID. Compare their signing domains
  // too, otherwise replacing one with a duplicate of the other passes.
  const paymentShape = (r: Json) => [r.scheme, r.network, r.asset.toLowerCase(), r.payTo.toLowerCase(), r.amount, r.extra?.name, r.extra?.version, r.extra?.verifyingContract?.toLowerCase() ?? null];
  for (const circuit of PROVABLE_CIRCUIT_IDS) {
    assert.ok(proofSkill?.description?.includes(circuit), `Missing advertised circuit: ${circuit}`);
    const challenge = value.challenges[circuit];
    assert.equal(challenge?.status, 402, `Circuit ${circuit} did not return a payment challenge`);
    assert.equal(challenge.body.requiresPayment, true, `Circuit ${circuit} bypassed payment`);
    assert.deepEqual(sorted(challenge.body.accepts.map(paymentShape)), sorted(offers.map(paymentShape)), `Incomplete or incorrect payment offers for ${circuit}`);
  }
}

async function readJson(url: string): Promise<Json> {
  const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`${new URL(url).pathname}: HTTP ${response.status}`);
  return response.json();
}

export async function verifyDeployment(expected: DeploymentExpectation): Promise<void> {
  const [health, identity, registration, card] = await Promise.all([
    '/health', '/identity/status', '/.well-known/agent-registration.json', '/.well-known/agent-card.json',
  ].map(path => readJson(expected.baseUrl + path)));
  const challenges: DeploymentSnapshot['challenges'] = {};
  for (const circuit of PROVABLE_CIRCUIT_IDS) {
    const response = await fetch(expected.baseUrl + '/api/v1/prove', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ circuit, inputs: {} }), signal: AbortSignal.timeout(30000),
    });
    challenges[circuit] = { status: response.status, body: await response.json() };
  }
  validateDeploymentSnapshot(expected, { health, identity, registration, card, challenges });
  console.log(JSON.stringify({ verified: true, url: expected.baseUrl, circuits: PROVABLE_CIRCUIT_IDS, paymentNetworks: expected.paymentNetworks, identities: expected.identities.map(({ chainId, agentId }) => ({ chainId, agentId })) }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const required = (name: string) => {
    const value = process.env[name];
    if (!value) throw new Error(`${name} is required`);
    return value;
  };
  const expected: DeploymentExpectation = {
    version: createRequire(import.meta.url)('../package.json').version,
    baseUrl: required('VERIFY_SERVICE_URL').replace(/\/$/, ''),
    paymentNetworks: required('VERIFY_PAYMENT_NETWORKS'), payTo: required('VERIFY_PAYMENT_PAY_TO'),
    price: required('VERIFY_PAYMENT_PRICE'), identities: JSON.parse(required('VERIFY_IDENTITIES')),
  };
  await verifyDeployment(expected);
}
