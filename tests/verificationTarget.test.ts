/**
 * The verification block a client receives must name a chain, a verifier
 * deployed on that chain, and an RPC that serves that chain — all three
 * agreeing.
 *
 * Found 2026-09-05 running the E2E suite against the GCP staging deployment.
 * The server answered with chainId 11155111 (Ethereum Sepolia) and the Ethereum
 * Sepolia verifier, and `rpcUrl: https://sepolia.base.org` — Base Sepolia,
 * chain 84532. A client did exactly as told and called the Ethereum address
 * over the Base RPC. Deterministic deployment puts one deployer's contracts at
 * the same address on every chain, so the call reached a real but different
 * contract and reverted with a custom error. Every on-chain verification in
 * the suite failed as "expected false to be true", which names nothing.
 *
 * Measured against staging the same night: the identical proof verifies true
 * on Ethereum Sepolia with the Ethereum verifier, and true on Base Sepolia
 * with the Base verifier. The proof was never the problem — only the mixed
 * pair. `scripts/probe-onchain-verify.mjs` reproduces that measurement.
 *
 * The chain each RPC serves is checked here as a property, not one case at a
 * time, because the bug was not a wrong constant. It was two correct constants
 * chosen independently.
 */
import { describe, it, expect } from 'vitest';
import { chooseVerificationTarget } from '../src/proof/proofRoutes.js';
import { CIRCUIT_IDS } from '../src/config/circuitIds.js';
import type { Config } from '../src/config/index.js';

const BASE_SEPOLIA = 'https://sepolia.base.org';
const BASE_MAINNET = 'https://mainnet.base.org';
const ETHEREUM_SEPOLIA = 'https://ethereum-sepolia-rpc.publicnode.com';
const ETHEREUM_MAINNET = 'https://ethereum-rpc.publicnode.com';

/** Which chain each RPC actually answers for. */
const CHAIN_OF_RPC: Record<string, number> = {
  [BASE_SEPOLIA]: 84532,
  [BASE_MAINNET]: 8453,
  [ETHEREUM_SEPOLIA]: 11155111,
  [ETHEREUM_MAINNET]: 1,
};

function configWith(chainRpcUrl: string, ethereumRpcUrl: string): Config {
  return { chainRpcUrl, ethereumRpcUrl } as unknown as Config;
}

const CIRCUITS = [
  CIRCUIT_IDS.COINBASE_ATTESTATION,
  CIRCUIT_IDS.COINBASE_COUNTRY_ATTESTATION,
  CIRCUIT_IDS.OIDC_DOMAIN_ATTESTATION,
];

describe('the verification block never mixes one chain with another chain rpc', () => {
  const environments = [
    { name: 'testnet, Ethereum rpc configured', testnet: true, chain: BASE_SEPOLIA, eth: ETHEREUM_SEPOLIA },
    { name: 'testnet, no Ethereum rpc', testnet: true, chain: BASE_SEPOLIA, eth: '' },
    { name: 'mainnet, Ethereum rpc configured', testnet: false, chain: BASE_MAINNET, eth: ETHEREUM_MAINNET },
    { name: 'mainnet, no Ethereum rpc', testnet: false, chain: BASE_MAINNET, eth: '' },
  ];

  for (const env of environments) {
    for (const circuit of CIRCUITS) {
      it(`${env.name} — ${circuit}: the rpc serves the chain that is named`, () => {
        const target = chooseVerificationTarget(configWith(env.chain, env.eth), circuit, env.testnet);
        expect(target).not.toBeNull();
        expect(CHAIN_OF_RPC[target!.rpcUrl]).toBe(target!.chainId);
      });
    }
  }
});

describe('which chain gets chosen', () => {
  it('prefers Ethereum when an Ethereum rpc is configured', () => {
    const target = chooseVerificationTarget(
      configWith(BASE_SEPOLIA, ETHEREUM_SEPOLIA),
      CIRCUIT_IDS.COINBASE_ATTESTATION,
      true,
    );
    expect(target!.chainId).toBe(11155111);
    expect(target!.rpcUrl).toBe(ETHEREUM_SEPOLIA);
  });

  it('falls back to Base rather than lending Ethereum the Base rpc', () => {
    // This is the whole defect in one case: with no Ethereum rpc configured,
    // the old code kept chainId 11155111 and reached for chainRpcUrl.
    const target = chooseVerificationTarget(
      configWith(BASE_SEPOLIA, ''),
      CIRCUIT_IDS.COINBASE_ATTESTATION,
      true,
    );
    expect(target!.chainId).toBe(84532);
    expect(target!.rpcUrl).toBe(BASE_SEPOLIA);
  });

  it('uses mainnet chain ids when not on testnet', () => {
    expect(
      chooseVerificationTarget(configWith(BASE_MAINNET, ETHEREUM_MAINNET), CIRCUIT_IDS.COINBASE_ATTESTATION, false)!
        .chainId,
    ).toBe(1);
    expect(
      chooseVerificationTarget(configWith(BASE_MAINNET, ''), CIRCUIT_IDS.COINBASE_ATTESTATION, false)!.chainId,
    ).toBe(8453);
  });

  it('returns a verifier address that is a real address, not an empty string', () => {
    for (const circuit of CIRCUITS) {
      const target = chooseVerificationTarget(configWith(BASE_SEPOLIA, ETHEREUM_SEPOLIA), circuit, true);
      expect(target!.verifierAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
    }
  });
});
