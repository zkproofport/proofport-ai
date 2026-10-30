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
 * coinbase_attestation is v2 (circuits coinbase-attestation-v2), deployed on
 * Base Sepolia, Base and Ethereum (circuits
 * deployments/<chain>/CoinbaseAttestationV2.json); core pins the same rows
 * since 0.4.0-beta.1, so it is held to core like every other circuit.
 *
 * `null` means NOT DEPLOYED on that chain, and is different from a missing
 * key, which would be a circuit somebody forgot. An empty string was used here
 * briefly and is worse than either: it looks like an address that failed to
 * load, and it satisfies a `string` type while failing every address check.
 */
export const FALLBACK_VERIFIERS: Record<string, Record<CircuitId, string | null>> = {
  '1': {
    // coinbase_attestation v2 (circuits deployments/1/CoinbaseAttestationV2.json).
    [CIRCUIT_IDS.COINBASE_ATTESTATION]: '0x0e458610BD79893a0855C8F90CEDed70cF7553b6',
    // coinbase_country_attestation v2 (circuits deployments/1/CoinbaseCountryAttestationV2.json).
    [CIRCUIT_IDS.COINBASE_COUNTRY_ATTESTATION]: '0xCD23a61D194D3B00906C49457774cB7E207ccC7B',
    // The provider-key statement circuit.
    [CIRCUIT_IDS.OIDC_DOMAIN_ATTESTATION]: '0xb07e18566Db63bb0b4cb72896699E94Faa078fcd',
    // Deployed on GIWA Sepolia (91342) and nowhere else.
    [CIRCUIT_IDS.GIWA_ATTESTATION]: null,
    // Not deployed on Ethereum mainnet yet; production verifies on Base.
    [CIRCUIT_IDS.HUMAN_PASSPORT_SCORE]: null,
  },
  '8453': {
    // coinbase_attestation v2 (circuits deployments/8453/CoinbaseAttestationV2.json).
    [CIRCUIT_IDS.COINBASE_ATTESTATION]: '0x6FC22d3576FB70457d1529B3F70f711A3cBA7A7F',
    // coinbase_country_attestation v2 (circuits deployments/8453/CoinbaseCountryAttestationV2.json).
    [CIRCUIT_IDS.COINBASE_COUNTRY_ATTESTATION]: '0x509DEE10cc1578361b450fED7475EA3BD69c6e8d',
    // The provider-key statement circuit.
    [CIRCUIT_IDS.OIDC_DOMAIN_ATTESTATION]: '0xF1AA88aD844bFd1dc552526a67f5980aAd4E7f35',
    // Deployed on GIWA Sepolia (91342) and nowhere else.
    [CIRCUIT_IDS.GIWA_ATTESTATION]: null,
    // circuits deployments/8453/HumanPassportScore.json.
    [CIRCUIT_IDS.HUMAN_PASSPORT_SCORE]: '0x2d055c42a2B0c1024aC4aa83b4995fc8fD45662e',
  },
  '11155111': {
    // coinbase_attestation v2: deployed on Base Sepolia, Base and Ethereum,
    // not on Ethereum Sepolia.
    [CIRCUIT_IDS.COINBASE_ATTESTATION]: null,
    // coinbase_country_attestation v2 (circuits deployments/11155111/CoinbaseCountryAttestationV2.json).
    [CIRCUIT_IDS.COINBASE_COUNTRY_ATTESTATION]: '0x99489796751B4939879dcAF5dB35eB4964c58F6c',
    // The provider-key statement circuit.
    [CIRCUIT_IDS.OIDC_DOMAIN_ATTESTATION]: '0x8E8F481D98149F13fB756Cab69376814fa854180',
    // Deployed on GIWA Sepolia (91342) and nowhere else.
    [CIRCUIT_IDS.GIWA_ATTESTATION]: null,
    // circuits deployments/11155111/HumanPassportScore.json.
    [CIRCUIT_IDS.HUMAN_PASSPORT_SCORE]: '0xc78585718Fd27D428d7A90970d09A2121BE36066',
  },
  // GIWA Sepolia. The only chain giwa_attestation is deployed on.
  '91342': {
    [CIRCUIT_IDS.COINBASE_ATTESTATION]: null,
    [CIRCUIT_IDS.COINBASE_COUNTRY_ATTESTATION]: null,
    [CIRCUIT_IDS.OIDC_DOMAIN_ATTESTATION]: null,
    [CIRCUIT_IDS.GIWA_ATTESTATION]: '0xF6Edb9d6114B2546B6E559997fdDE08CAeEA83b3',
    [CIRCUIT_IDS.HUMAN_PASSPORT_SCORE]: null,
  },
  '84532': {
    // coinbase_attestation v2 (circuits e498841).
    [CIRCUIT_IDS.COINBASE_ATTESTATION]: '0x1885aA2283DB21ad0fc63A2Df98efe92F31908E6',
    // coinbase_country_attestation v2 (circuits deployments/84532/CoinbaseCountryAttestationV2.json).
    [CIRCUIT_IDS.COINBASE_COUNTRY_ATTESTATION]: '0xC5363d7587bd580148373D0d8b7909Be423242CB',
    // The provider-key statement circuit.
    [CIRCUIT_IDS.OIDC_DOMAIN_ATTESTATION]: '0xeA5933ABc598401c89F63B3f13AE56A7E78984e8',
    // Deployed on GIWA Sepolia (91342) and nowhere else.
    [CIRCUIT_IDS.GIWA_ATTESTATION]: null,
    // circuits deployments/84532/HumanPassportScore.json.
    [CIRCUIT_IDS.HUMAN_PASSPORT_SCORE]: '0x39df92D9C603Fe6d229c7b00272A1E874a628acE',
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
