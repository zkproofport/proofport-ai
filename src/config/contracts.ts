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

/**
 * Verifier addresses to use before `syncDeployments()` fetches the live ones.
 *
 * Keyed by chain id, then by canonical circuit id. The inner record is
 * `Record<CircuitId, string>`, so a chain missing a provable circuit — or
 * carrying an id that is no longer canonical — is a compile error rather than a
 * lookup that returns `undefined` at request time.
 */
export const FALLBACK_VERIFIERS: Record<string, Record<CircuitId, string>> = {
  '1': {
    [CIRCUIT_IDS.COINBASE_ATTESTATION]: '0xF3D5A09d2C85B28C52EF2905c1BE3a852b609D0C',
    [CIRCUIT_IDS.COINBASE_COUNTRY_ATTESTATION]: '0x78792554E1582cB49D858eACb5C3607B42d28224',
    [CIRCUIT_IDS.OIDC_DOMAIN_ATTESTATION]: '0x440EaA25603eD5480caD0ee51d9808a1993eF267',
  },
  '8453': {
    [CIRCUIT_IDS.COINBASE_ATTESTATION]: '0xF7dED73E7a7fc8fb030c35c5A88D40ABe6865382',
    [CIRCUIT_IDS.COINBASE_COUNTRY_ATTESTATION]: '0xF3D5A09d2C85B28C52EF2905c1BE3a852b609D0C',
    [CIRCUIT_IDS.OIDC_DOMAIN_ATTESTATION]: '0x9677ba46ad226ce8b3c4517d9c0143e4d458beae',
  },
  '11155111': {
    [CIRCUIT_IDS.COINBASE_ATTESTATION]: '0xCbC8E63fF92659E8B44cFF117D33005Bb669a018',
    [CIRCUIT_IDS.COINBASE_COUNTRY_ATTESTATION]: '0x6646d970499BBeD728636823A5A7e551E811b414',
    [CIRCUIT_IDS.OIDC_DOMAIN_ATTESTATION]: '0x07121eb50b2Ebe1675E7Cb96c84B580A3fF6589e',
  },
  '84532': {
    [CIRCUIT_IDS.COINBASE_ATTESTATION]: '0x0036B61dBFaB8f3CfEEF77dD5D45F7EFBFE2035c',
    [CIRCUIT_IDS.COINBASE_COUNTRY_ATTESTATION]: '0xdEe363585926c3c28327Efd1eDd01cf4559738cf',
    [CIRCUIT_IDS.OIDC_DOMAIN_ATTESTATION]: '0x27aFDEa349f247CF698F97FdFAb59E1BF8bD0550',
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
