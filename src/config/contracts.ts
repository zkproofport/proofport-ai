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
  [CIRCUIT_IDS.ARC_ELIGIBILITY]: {
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
 * `null` means NOT DEPLOYED on that chain, and is different from a missing
 * key, which would be a circuit somebody forgot. An empty string was used here
 * briefly and is worse than either: it looks like an address that failed to
 * load, and it satisfies a `string` type while failing every address check.
 */
export const FALLBACK_VERIFIERS: Record<string, Record<CircuitId, string | null>> = {
  '1': {
    [CIRCUIT_IDS.COINBASE_ATTESTATION]: '0xF3D5A09d2C85B28C52EF2905c1BE3a852b609D0C',
    [CIRCUIT_IDS.COINBASE_COUNTRY_ATTESTATION]: '0x78792554E1582cB49D858eACb5C3607B42d28224',
    // Deployed on Arc Testnet (5042002) and nowhere else -- see that entry
    // below. `null` here says this chain has no verifier for it, which is what
    // a caller needs to hear rather than an address that reverts.
    [CIRCUIT_IDS.ARC_ELIGIBILITY]: null,
    [CIRCUIT_IDS.OIDC_DOMAIN_ATTESTATION]: '0x440EaA25603eD5480caD0ee51d9808a1993eF267',
    // Deployed on GIWA Sepolia (91342) and nowhere else.
    [CIRCUIT_IDS.GIWA_ATTESTATION]: null,
  },
  '8453': {
    [CIRCUIT_IDS.COINBASE_ATTESTATION]: '0xF7dED73E7a7fc8fb030c35c5A88D40ABe6865382',
    [CIRCUIT_IDS.COINBASE_COUNTRY_ATTESTATION]: '0xF3D5A09d2C85B28C52EF2905c1BE3a852b609D0C',
    // Deployed on Arc Testnet (5042002) and nowhere else -- see that entry
    // below. `null` here says this chain has no verifier for it, which is what
    // a caller needs to hear rather than an address that reverts.
    [CIRCUIT_IDS.ARC_ELIGIBILITY]: null,
    [CIRCUIT_IDS.OIDC_DOMAIN_ATTESTATION]: '0x9677ba46ad226ce8b3c4517d9c0143e4d458beae',
    // Deployed on GIWA Sepolia (91342) and nowhere else.
    [CIRCUIT_IDS.GIWA_ATTESTATION]: null,
  },
  '11155111': {
    [CIRCUIT_IDS.COINBASE_ATTESTATION]: '0xCbC8E63fF92659E8B44cFF117D33005Bb669a018',
    [CIRCUIT_IDS.COINBASE_COUNTRY_ATTESTATION]: '0x6646d970499BBeD728636823A5A7e551E811b414',
    // Deployed on Arc Testnet (5042002) and nowhere else -- see that entry
    // below. `null` here says this chain has no verifier for it, which is what
    // a caller needs to hear rather than an address that reverts.
    [CIRCUIT_IDS.ARC_ELIGIBILITY]: null,
    [CIRCUIT_IDS.OIDC_DOMAIN_ATTESTATION]: '0x07121eb50b2Ebe1675E7Cb96c84B580A3fF6589e',
    // Deployed on GIWA Sepolia (91342) and nowhere else.
    [CIRCUIT_IDS.GIWA_ATTESTATION]: null,
  },
  // Arc Testnet. The only chain arc_eligibility is deployed on; the other
  // circuits have no verifier here, which is what `null` says.
  '5042002': {
    [CIRCUIT_IDS.COINBASE_ATTESTATION]: null,
    [CIRCUIT_IDS.COINBASE_COUNTRY_ATTESTATION]: null,
    [CIRCUIT_IDS.OIDC_DOMAIN_ATTESTATION]: null,
    [CIRCUIT_IDS.GIWA_ATTESTATION]: null,
    // Redeployed 2026-09-22 for the circuit that makes its EIP-712 action
    // optional. The previous contract is still live and still verifies the
    // OLD circuit, so a stale address here fails every new proof.
    [CIRCUIT_IDS.ARC_ELIGIBILITY]: '0x2aEB66292f631ceb6225ffA2439B1f2b4b15e44a',
  },
  // GIWA Sepolia. The only chain giwa_attestation is deployed on.
  '91342': {
    [CIRCUIT_IDS.COINBASE_ATTESTATION]: null,
    [CIRCUIT_IDS.COINBASE_COUNTRY_ATTESTATION]: null,
    [CIRCUIT_IDS.OIDC_DOMAIN_ATTESTATION]: null,
    [CIRCUIT_IDS.ARC_ELIGIBILITY]: null,
    [CIRCUIT_IDS.GIWA_ATTESTATION]: '0x5Da234546874304F8c51BBEed00fC632938211c1',
  },
  '84532': {
    [CIRCUIT_IDS.COINBASE_ATTESTATION]: '0x0036B61dBFaB8f3CfEEF77dD5D45F7EFBFE2035c',
    [CIRCUIT_IDS.COINBASE_COUNTRY_ATTESTATION]: '0xdEe363585926c3c28327Efd1eDd01cf4559738cf',
    // Deployed on Arc Testnet (5042002) and nowhere else -- see that entry
    // below. `null` here says this chain has no verifier for it, which is what
    // a caller needs to hear rather than an address that reverts.
    [CIRCUIT_IDS.ARC_ELIGIBILITY]: null,
    [CIRCUIT_IDS.OIDC_DOMAIN_ATTESTATION]: '0x27aFDEa349f247CF698F97FdFAb59E1BF8bD0550',
    // Deployed on GIWA Sepolia (91342) and nowhere else.
    [CIRCUIT_IDS.GIWA_ATTESTATION]: null,
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
