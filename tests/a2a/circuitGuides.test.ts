import { describe, expect, it } from 'vitest';
import { buildGuide } from '../../src/proof/guideBuilder.js';
import { PROVABLE_CIRCUIT_IDS } from '../../src/config/circuitIds.js';
import { GIWA_ATTESTER_CONTRACT, GIWA_AUTHORIZED_SIGNERS } from '../../src/config/contracts.js';
import type { Config } from '../../src/config/index.js';
const config = {
  teeMode: 'local', teeAttestationEnabled: false, paymentNetworks: 'arc-testnet-nano', paymentMode: 'testnet',
  paymentProofPrice: '$0.001', paymentPayTo: '0x' + '12'.repeat(20), a2aBaseUrl: 'https://stg-ai.zkproofport.app',
  chainRpcUrl: 'https://sepolia.base.org', baseRpcUrl: 'https://mainnet.base.org', easGraphqlEndpoint: 'https://base.easscan.org/graphql',
  arcRpcUrl: 'https://rpc.testnet.arc.network', arcChainId: 5042002,
  giwaRpcUrl: 'https://sepolia-rpc.giwa.io', giwaExplorerUrl: 'https://sepolia-explorer.giwa.io',
} as Config;

describe('every generated guide matches its circuit and deployment', () => {
  it.each(PROVABLE_CIRCUIT_IDS)('%s reports actual encryption mode, canonical route, current payment configuration', circuit => {
    for (const teeMode of ['local', 'disabled', 'nitro'] as const) {
      const guide = buildGuide(circuit, { ...config, teeMode }) as any;
      expect(guide.circuit_id).toBe(circuit);
      expect(guide.e2e_encryption.enabled).toBe(teeMode === 'nitro');
      if (teeMode === 'nitro') {
        expect(guide.endpoints.prove.flow).toContain('encrypted_payload');
        expect(guide.endpoints.prove.flow).toContain('TEE public key');
      } else {
        expect(guide.endpoints.prove.flow).toContain('{circuit, inputs}');
        expect(guide.endpoints.prove.flow).not.toMatch(/encrypted_payload|TEE public key|encrypt inputs/);
      }
      expect(guide.endpoints.guide.url).toBe(`${config.a2aBaseUrl}/api/v1/guide/${circuit}`);
      expect(guide.constants.x402.chains).toHaveLength(1);
      expect(guide.constants.x402.chains[0]).toMatchObject({ network_name: 'arc-testnet-nano', settlement: 'gateway', eip712_domain: { name: 'GatewayWalletBatched' } });
      expect(JSON.stringify(guide)).not.toMatch(/PAYMENT_KEY|defaults to attestation signer/);
    }
  });

  it.each(['arc_eligibility', 'giwa_attestation'] as const)('%s describes both supported signature modes and stable wallet nullifiers', circuit => {
    const guide = buildGuide(circuit, config) as any;
    expect(guide.local_mcp_server.required_arguments).not.toContain('action');
    expect(guide.local_mcp_server.optional_arguments).toContain('action');
    expect(guide.action.required).toBe(false);
    expect(guide.formulas.identity_signature).toContain('personal_sign');
    expect(guide.formulas.signing_digest).toContain('0x1901');
    expect(guide.formulas.nullifier).toContain('circuitId');
    expect(guide.formulas.nullifier).not.toContain('signal_hash');
    expect(guide.sdk.identity_only).not.toContain('--action');
    expect(guide.sdk.action_bound).toContain('--action');
  });

  it('GIWA guide names the GIWA attester, verification chain and local SDK RPC inputs', () => {
    const guide = buildGuide('giwa_attestation', config) as any;
    expect(guide.constants.contracts.attester).toBe(GIWA_ATTESTER_CONTRACT);
    expect(guide.constants.authorized_signers).toEqual(GIWA_AUTHORIZED_SIGNERS);
    expect(guide.constants.verification).toMatchObject({ chain_id: 91342, rpc_url: config.giwaRpcUrl, verifier_address: expect.stringMatching(/^0x[0-9a-fA-F]{40}$/) });
    expect(guide.constants.attestation_source).toMatchObject({ chain_id: 91342, rpc_url: config.giwaRpcUrl, explorer_url: config.giwaExplorerUrl });
    expect(guide.sdk.quick_start).not.toContain('giwaRpcUrl:');
    expect(guide.local_mcp_server.credentials).toContain('built-in GIWA Sepolia RPC');
    expect(JSON.stringify(guide)).not.toMatch(/Coinbase KYC|coinbase_attester|base\.easscan/);
  });

  it('OIDC guide uses actual API payload fields and SDK orchestration', () => {
    const guide = buildGuide('oidc_domain_attestation', config) as any;
    expect(guide.input_schema.client_fields.map((field: { name: string }) => field.name)).toEqual(['jwt', 'jwks', 'scope', 'provider']);
    expect(guide.sdk.quick_start).toContain('generateProof');
    expect(guide.sdk.quick_start).not.toContain('scope_string');
    expect(guide.overview.how).not.toContain('Apple');
  });

  it('country examples supply required countryList and isIncluded', () => {
    const guide = buildGuide('coinbase_country_attestation', config) as any;
    expect(guide.sdk.quick_start).toContain('countryList');
    expect(guide.sdk.quick_start).toContain('isIncluded');
  });

  it('verification chain does not become mainnet merely because local payments are disabled', () => {
    const guide = buildGuide('coinbase_attestation', { ...config, paymentMode: 'disabled' }) as any;
    expect(guide.constants.verification.chain_id).toBe(84532);
    expect(guide.constants.payment.network).toBe('arc-testnet-nano');
  });
});

describe('Arc guide configuration validation', () => {
  it.each([undefined, 0, -1, 1.5, Number.NaN])('does not invent a chain when ARC_CHAIN_ID=%s', arcChainId => {
    expect(() => buildGuide('arc_eligibility', { ...config, arcChainId } as Config)).toThrow('Invalid verification chain for arc_eligibility');
  });
  it('does not borrow the testnet verifier for an unknown configured Arc chain', () => {
    expect(() => buildGuide('arc_eligibility', { ...config, arcChainId: 999 })).toThrow('No arc_eligibility verifier configured on chain 999');
  });
});
