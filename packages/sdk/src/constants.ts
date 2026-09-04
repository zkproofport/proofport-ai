import { CIRCUIT_IDS } from './circuits.js';
import type { CircuitId } from './types.js';

/**
 * Per-circuit metadata. Keyed by the canonical identifiers from `./circuits.js`
 * and typed `Record<CircuitId, …>`, so adding a provable circuit without an
 * entry — or keeping an entry for one that no longer exists — is a compile error.
 */
export const CIRCUITS: Record<CircuitId, {
  displayName: string;
  easSchemaId?: string;
  functionSelector?: string;
  inputType?: string;
}> = {
  [CIRCUIT_IDS.COINBASE_ATTESTATION]: {
    displayName: 'Coinbase KYC',
    easSchemaId: '0xf8b05c79f090979bf4a80270aba232dff11a10d9ca55c4f88de95317970f0de9',
    functionSelector: '0x56feed5e',
  },
  [CIRCUIT_IDS.COINBASE_COUNTRY_ATTESTATION]: {
    displayName: 'Coinbase Country',
    easSchemaId: '0x1801901fabd0e6189356b4fb52bb0ab855276d84f7ec140839fbd1f6801ca065',
    functionSelector: '0x0a225248',
  },
  [CIRCUIT_IDS.OIDC_DOMAIN_ATTESTATION]: {
    displayName: 'OIDC Domain',
    inputType: 'oidc',
  },
};

export const COINBASE_ATTESTER_CONTRACT = '0x357458739F90461b99789350868CD7CF330Dd7EE';

export const AUTHORIZED_SIGNERS = [
  '0x952f32128AF084422539C4Ff96df5C525322E564',
  '0x8844591D47F17bcA6F5dF8f6B64F4a739F1C0080',
  '0x88fe64ea2e121f49bb77abea6c0a45e93638c3c5',
  '0x44ace9abb148e8412ac4492e9a1ae6bd88226803',
];

export const DEFAULT_EAS_GRAPHQL = 'https://base.easscan.org/graphql';
// Use drpc.org instead of mainnet.base.org: the latter prunes transactions
// older than ~30 days, so eth_getTransactionByHash returns null for any
// attestation made earlier (mainnet.base.org returned null for txs from 2025).
// drpc.org retains full history at no cost and no API key.
export const DEFAULT_EAS_RPC = 'https://base.drpc.org';

export const RAW_TX_PADDED_LENGTH = 300;
export const MERKLE_PROOF_MAX_DEPTH = 8;
export const COUNTRY_LIST_MAX_LENGTH = 10;
