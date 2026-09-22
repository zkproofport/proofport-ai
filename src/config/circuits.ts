import { CIRCUIT_IDS } from './circuitIds.js';
import type { CircuitId } from './circuitIds.js';

/**
 * Re-exported so existing `import type { CircuitId } from './circuits.js'`
 * call sites keep working. The type is defined in `./circuitIds.js`, which is
 * where circuit identity lives.
 */
export type { CircuitId } from './circuitIds.js';

/**
 * Per-circuit metadata for the circuits this server can prove.
 *
 * Keyed by the canonical identifiers from `./circuitIds.js` and typed
 * `Record<CircuitId, …>`, so a provable circuit without an entry — or an entry
 * for an id that is no longer canonical — is a compile error.
 *
 * `id` is not a second declaration of the identifier: it repeats the key so
 * callers holding a value can read it back, and the key comes from
 * `CIRCUIT_IDS`.
 */
export const CIRCUITS: Record<CircuitId, {
  id: CircuitId;
  displayName: string;
  description: string;
  requiredInputs: string[];
  easSchemaId?: string;
  functionSelector?: string;
  inputType?: string;
}> = {
  [CIRCUIT_IDS.COINBASE_ATTESTATION]: {
    id: CIRCUIT_IDS.COINBASE_ATTESTATION,
    displayName: 'Coinbase KYC',
    description: 'Prove KYC attestation from Coinbase without revealing identity',
    requiredInputs: ['address', 'signature', 'scope'],
    easSchemaId: '0xf8b05c79f090979bf4a80270aba232dff11a10d9ca55c4f88de95317970f0de9',
    functionSelector: '0x56feed5e',
  },
  [CIRCUIT_IDS.COINBASE_COUNTRY_ATTESTATION]: {
    id: CIRCUIT_IDS.COINBASE_COUNTRY_ATTESTATION,
    displayName: 'Coinbase Country',
    description: 'Prove country of residence from Coinbase attestation',
    requiredInputs: ['address', 'signature', 'scope', 'countryList', 'isIncluded'],
    easSchemaId: '0x1801901fabd0e6189356b4fb52bb0ab855276d84f7ec140839fbd1f6801ca065',
    functionSelector: '0x0a225248',
  },
  [CIRCUIT_IDS.OIDC_DOMAIN_ATTESTATION]: {
    id: CIRCUIT_IDS.OIDC_DOMAIN_ATTESTATION,
    displayName: 'OIDC Domain',
    description: 'Prove email domain affiliation via OIDC JWT verification',
    requiredInputs: ['jwt', 'jwks', 'scope'],
    inputType: 'oidc',
  },
  [CIRCUIT_IDS.ARC_ELIGIBILITY]: {
    id: CIRCUIT_IDS.ARC_ELIGIBILITY,
    displayName: 'Arc Eligibility',
    description:
      'Prove a Coinbase KYC attestation, optionally binding the same wallet to one ' +
      'EIP-712 action. The wallet shows the person named fields instead of an ' +
      'opaque hash, and the verifying contract recomputes the same two hashes ' +
      'from the call it is about to run, so a proof made for one contract does ' +
      'not verify at another.',
    requiredInputs: ['address', 'signature', 'scope'],
    easSchemaId: '0xf8b05c79f090979bf4a80270aba232dff11a10d9ca55c4f88de95317970f0de9',
    functionSelector: '0x56feed5e',
  },
  [CIRCUIT_IDS.GIWA_ATTESTATION]: {
    id: CIRCUIT_IDS.GIWA_ATTESTATION,
    displayName: 'GIWA Attestation',
    description:
      'Prove a GIWA account attestation, optionally binding one EIP-712 ' +
      'action to the same wallet. The attestation comes from our attester on ' +
      'GIWA Sepolia rather than from Coinbase, and the verifier lives on that ' +
      'chain too.',
    requiredInputs: ['address', 'signature', 'scope'],
    functionSelector: '0x56feed5e',
  },

};
