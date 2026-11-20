import { CIRCUIT_IDS } from './circuitIds.js';
import type { CircuitId } from './circuitIds.js';

/**
 * Re-exported so existing `import type { CircuitId } from './contracts.js'`
 * call sites keep working. The type is defined in `./circuitIds.js`, which is
 * where circuit identity lives.
 */
export type { CircuitId } from './circuitIds.js';

export const COINBASE_ATTESTER_CONTRACT = '0x357458739F90461b99789350868CD7CF330Dd7EE';

export const AUTHORIZED_SIGNERS = [
  '0x952f32128AF084422539C4Ff96df5C525322E564',
  '0x8844591D47F17bcA6F5dF8f6B64F4a739F1C0080',
  '0x88fe64ea2e121f49bb77abea6c0a45e93638c3c5',
  '0x44ace9abb148e8412ac4492e9a1ae6bd88226803',
];

/** MockGiwaAttester on GIWA Sepolia -- ours, and the `to` of its attest tx. */
export const GIWA_ATTESTER_CONTRACT = '0x6646d970499BBeD728636823A5A7e551E811b414';

/** The one address that signs GIWA attest transactions. */
export const GIWA_AUTHORIZED_SIGNERS = ['0xEE099845CDfF93e73aDcBcB36A9B93578bcCed4b'];

/** GIWA Sepolia, where the GIWA attester and its verifier live. */
export const GIWA_CHAIN_ID = 91342;

/**
 * Where a circuit's on-chain attestation comes from, and who may have signed it.
 *
 * A table because the answer differs per circuit and the wrong one does not
 * misbehave visibly: reading a GIWA wallet's attestation from Coinbase's EAS
 * finds nothing and reads as "this wallet is not attested". `null` says the
 * circuit has no on-chain attestation at all -- OIDC's proof is the identity
 * token itself.
 */
export const ATTESTATION_SOURCES: Record<
  CircuitId,
  { kind: 'eas-base'; contract: string; signers: string[] }
  | { kind: 'giwa-sepolia'; contract: string; signers: string[]; chainId: number }
  | null
> = {
  [CIRCUIT_IDS.COINBASE_ATTESTATION]: {
    kind: 'eas-base',
    contract: COINBASE_ATTESTER_CONTRACT,
    signers: AUTHORIZED_SIGNERS,
  },
  [CIRCUIT_IDS.COINBASE_COUNTRY_ATTESTATION]: {
    kind: 'eas-base',
    contract: COINBASE_ATTESTER_CONTRACT,
    signers: AUTHORIZED_SIGNERS,
  },
  [CIRCUIT_IDS.GIWA_ATTESTATION]: {
    kind: 'giwa-sepolia',
    contract: GIWA_ATTESTER_CONTRACT,
    signers: GIWA_AUTHORIZED_SIGNERS,
    chainId: GIWA_CHAIN_ID,
  },
  // The signature is inside the OIDC identity token; there is no attestation
  // transaction to find.
  [CIRCUIT_IDS.OIDC_DOMAIN_ATTESTATION]: null,
  // Not a signed transaction from a known signer: the issuer's EIP-712
  // signature sits in the verifyAndAttest calldata, found and checked by
  // src/input/humanPassport.ts.
  [CIRCUIT_IDS.HUMAN_PASSPORT_SCORE]: null,
};

/**
 * Verifier addresses to use before `syncDeployments()` fetches the live ones.
 *
 * Keyed by chain id, then by canonical circuit id. The inner record is
 * `Record<CircuitId, string>`, so a chain missing a provable circuit — or
 * carrying an id that is no longer canonical — is a compile error rather than a
 * lookup that returns `undefined` at request time.
 */
/**
 * Must equal `PINNED_VERIFIERS` in @zkproofport-app/core, the table the AI SDK,
 * the MCP and every other published client verify against: a response naming
 * any other address is refused by them. tests/fallbackVerifiersMatchCore.test.ts
 * holds the two together. (Ethereum Sepolia was still on the pre-2026-10-22
 * deployments here until 2026-10-27; the live staging server had synced past it.)
 *
 * The rows are the bb 6.0.0 verifiers recorded at the pinned circuits commit
 * (src/config/circuitsPin.ts, broadcast/<script>/<chain>/run-latest.json),
 * which core 0.4.0-beta.9 pins: Base Sepolia, Ethereum Sepolia and GIWA
 * Sepolia. coinbase_attestation and coinbase_country_attestation are v2
 * (circuits coinbase-attestation-v2 / coinbase-country-attestation-v2).
 *
 * Ethereum (1) and Base (8453) are `null` for every circuit: their records at
 * the pinned commit still name the bb 4.2 verifiers, which refuse a bb 6.0.0
 * proof, and core lists them in AWAITING_REDEPLOY and pins nothing there. They
 * become addresses when the mainnet verifiers are redeployed, recorded in a
 * circuits commit this server pins, and pinned by a core release.
 *
 * `null` means NOT DEPLOYED on that chain, and is different from a missing
 * key, which would be a circuit somebody forgot. An empty string was used here
 * briefly and is worse than either: it looks like an address that failed to
 * load, and it satisfies a `string` type while failing every address check.
 */
export const FALLBACK_VERIFIERS: Record<string, Record<CircuitId, string | null>> = {
  // Ethereum and Base: awaiting the bb 6.0.0 redeploy (core AWAITING_REDEPLOY).
  '1': {
    [CIRCUIT_IDS.COINBASE_ATTESTATION]: null,
    [CIRCUIT_IDS.COINBASE_COUNTRY_ATTESTATION]: null,
    [CIRCUIT_IDS.OIDC_DOMAIN_ATTESTATION]: null,
    [CIRCUIT_IDS.GIWA_ATTESTATION]: null,
    [CIRCUIT_IDS.HUMAN_PASSPORT_SCORE]: null,
  },
  '8453': {
    [CIRCUIT_IDS.COINBASE_ATTESTATION]: null,
    [CIRCUIT_IDS.COINBASE_COUNTRY_ATTESTATION]: null,
    [CIRCUIT_IDS.OIDC_DOMAIN_ATTESTATION]: null,
    [CIRCUIT_IDS.GIWA_ATTESTATION]: null,
    [CIRCUIT_IDS.HUMAN_PASSPORT_SCORE]: null,
  },
  '11155111': {
    [CIRCUIT_IDS.COINBASE_ATTESTATION]: '0x42972771718ef5096f884Da45e53dD7fa54d4180',
    [CIRCUIT_IDS.COINBASE_COUNTRY_ATTESTATION]: '0xBcC01EfCE38CDa8f4fFED8Eb5260810545ab0206',
    [CIRCUIT_IDS.OIDC_DOMAIN_ATTESTATION]: '0x4253eef617eE2d1fc4E551f448FbfdaaaeB9FC90',
    // Deployed on GIWA Sepolia (91342) and nowhere else.
    [CIRCUIT_IDS.GIWA_ATTESTATION]: null,
    [CIRCUIT_IDS.HUMAN_PASSPORT_SCORE]: '0x9904a8d852dDEAbf7d9c8Cf7116609DA8e39c2EB',
  },
  // GIWA Sepolia. The only chain giwa_attestation is deployed on.
  '91342': {
    [CIRCUIT_IDS.COINBASE_ATTESTATION]: null,
    [CIRCUIT_IDS.COINBASE_COUNTRY_ATTESTATION]: null,
    [CIRCUIT_IDS.OIDC_DOMAIN_ATTESTATION]: null,
    [CIRCUIT_IDS.GIWA_ATTESTATION]: '0xA272056866453F0182426A29B9Ca6382d6C6a060',
    [CIRCUIT_IDS.HUMAN_PASSPORT_SCORE]: null,
  },
  '84532': {
    [CIRCUIT_IDS.COINBASE_ATTESTATION]: '0xe78fCDc7562ce3afCEadaF29f4b8B96DC997C01A',
    [CIRCUIT_IDS.COINBASE_COUNTRY_ATTESTATION]: '0xe88033179576869c8730160EcBfaa7e5b2c1A4a9',
    [CIRCUIT_IDS.OIDC_DOMAIN_ATTESTATION]: '0x14a2241B0A24679825BeFAaa562d4A204262D84f',
    // Deployed on GIWA Sepolia (91342) and nowhere else.
    [CIRCUIT_IDS.GIWA_ATTESTATION]: null,
    [CIRCUIT_IDS.HUMAN_PASSPORT_SCORE]: '0x223e372553739678365486a3Ded05310B5BCbc0C',
  },
};

export const ERC8004_ADDRESSES = {
  mainnet: {
    identity: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
    reputation: '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63',
    validation: '0x8004Cc8439f36fd5F9F049D9fF86523Df6dAAB58',
  },
  sepolia: {
    identity: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
    reputation: '0x8004B663056A597Dffe9eCcC1965A193B7388713',
    validation: '0x8004Cb1BF31DAf7788923b405b754f57acEB4272',
  },
};
