import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { parseUnits } from 'ethers';
import { getVerifierAddress } from '../src/config/deployments.js';
import { PROVABLE_CIRCUIT_IDS } from '../src/config/circuitIds.js';
import { buildPaymentRequirements, resolvePaymentNetworks } from '../src/payment/networks.js';

type Identity = { chainId: number; agentId: string; registry: string };
export type DeploymentExpectation = {
  environment: string; version: string; baseUrl: string; paymentNetworks: string; payTo: string; price: string; identities: Identity[];
};
type Json = Record<string, any>;
export type DeploymentSnapshot = {
  health: Json; identity: Json; registration: Json; card: Json;
  guides: Record<string, Json>;
  challenges: Record<string, { status: number; body: Json }>;
};
const sorted = (rows: unknown[]) => rows.map(row => JSON.stringify(row)).sort();

export function verificationChains(environment: string): Record<string, number> {
  const coreChains: Record<string, number> = { staging: 84532, production: 8453 };
  const core = coreChains[environment];
  if (!core) throw new Error(`Unknown deployment environment: ${environment}`);
  return { coinbase_attestation: core, coinbase_country_attestation: core, oidc_domain_attestation: core, arc_eligibility: 5042002, giwa_attestation: 91342 };
}

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
  const chains = verificationChains(expected.environment);
  for (const circuit of PROVABLE_CIRCUIT_IDS) {
    assert.ok(proofSkill?.description?.includes(circuit), `Missing advertised circuit: ${circuit}`);
    const verification = value.guides[circuit]?.constants?.verification;
    assert.ok(verification && Number.isSafeInteger(verification.chain_id) && verification.chain_id > 0, `Missing verification chain for ${circuit}`);
    assert.equal(verification.chain_id, chains[circuit], `Incorrect verification chain for ${circuit}`);
    const verifier = getVerifierAddress(circuit, String(chains[circuit]));
    assert.ok(verifier, `No configured verification contract for ${circuit}`);
    assert.equal(verification.verifier_address?.toLowerCase(), verifier.toLowerCase(), `Incorrect verification contract for ${circuit}`);
    let rpc: URL | undefined;
    try { rpc = new URL(verification.rpc_url); } catch { /* assertion below names the circuit */ }
    assert.ok(rpc && ['http:', 'https:'].includes(rpc.protocol), `Missing or invalid verification RPC for ${circuit}`);
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
  const guides: DeploymentSnapshot['guides'] = {};
  const challenges: DeploymentSnapshot['challenges'] = {};
  for (const circuit of PROVABLE_CIRCUIT_IDS) {
    guides[circuit] = await readJson(expected.baseUrl + '/api/v1/guide/' + circuit);
    const response = await fetch(expected.baseUrl + '/api/v1/prove', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ circuit, inputs: {} }), signal: AbortSignal.timeout(30000),
    });
    challenges[circuit] = { status: response.status, body: await response.json() };
  }
  validateDeploymentSnapshot(expected, { health, identity, registration, card, challenges, guides });
  console.log(JSON.stringify({ verified: true, url: expected.baseUrl, circuits: PROVABLE_CIRCUIT_IDS, paymentNetworks: expected.paymentNetworks, identities: expected.identities.map(({ chainId, agentId }) => ({ chainId, agentId })) }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const required = (name: string) => {
    const value = process.env[name];
    if (!value) throw new Error(`${name} is required`);
    return value;
  };
  const expected: DeploymentExpectation = {
    environment: required('TARGET_ENVIRONMENT'),
    version: createRequire(import.meta.url)('../package.json').version,
    baseUrl: required('VERIFY_SERVICE_URL').replace(/\/$/, ''),
    paymentNetworks: required('VERIFY_PAYMENT_NETWORKS'), payTo: required('VERIFY_PAYMENT_PAY_TO'),
    price: required('VERIFY_PAYMENT_PRICE'), identities: JSON.parse(required('VERIFY_IDENTITIES')),
  };
  await verifyDeployment(expected);
}
