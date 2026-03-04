import type { CircuitId } from './types.js';

export const CIRCUITS: Record<CircuitId, {
  displayName: string;
  easSchemaId: string;
  functionSelector: string;
}> = {
  coinbase_attestation: {
    displayName: 'Coinbase KYC',
    easSchemaId: '0xf8b05c79f090979bf4a80270aba232dff11a10d9ca55c4f88de95317970f0de9',
    functionSelector: '0x56feed5e',
  },
  coinbase_country_attestation: {
    displayName: 'Coinbase Country',
    easSchemaId: '0x1801901fabd0e6189356b4fb52bb0ab855276d84f7ec140839fbd1f6801ca065',
    functionSelector: '0x0a225248',
  },
};

export const COINBASE_ATTESTER_CONTRACT = '0x357458739F90461b99789350868CD7CF330Dd7EE';

export const AUTHORIZED_SIGNERS = [
  '0x952f32128AF084422539C4Ff96df5C525322E564',
  '0x8844591D47F17bcA6F5dF8f6B64F4a739F1C0080',
  '0x88fe64ea2e121f49bb77abea6c0a45e93638c3c5',
  '0x44ace9abb148e8412ac4492e9a1ae6bd88226803',
];

export const VERIFIER_ADDRESSES: Record<string, Record<string, string>> = {
  '84532': {  // Base Sepolia
    coinbase_attestation: '0x0036B61dBFaB8f3CfEEF77dD5D45F7EFBFE2035c',
    coinbase_country_attestation: '0xdEe363585926c3c28327Efd1eDd01cf4559738cf',
  },
};

export const USDC_ADDRESSES = {
  'base-sepolia': '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  'base': '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
} as const;

export const DEFAULT_EAS_GRAPHQL = 'https://base.easscan.org/graphql';
export const DEFAULT_EAS_RPC = 'https://mainnet.base.org';
export const DEFAULT_PAYMENT_RPC: Record<string, string> = {
  'base-sepolia': 'https://sepolia.base.org',
  'base': 'https://mainnet.base.org',
};

export const RAW_TX_PADDED_LENGTH = 300;
export const MERKLE_PROOF_MAX_DEPTH = 8;
export const COUNTRY_LIST_MAX_LENGTH = 10;
