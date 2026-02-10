export const CIRCUITS = {
  coinbase_attestation: {
    id: 'coinbase_attestation',
    displayName: 'Coinbase KYC',
    description: 'Prove KYC attestation from Coinbase without revealing identity',
    requiredInputs: ['address', 'signature', 'scope'],
    easSchemaId: '0xf8b05c79f090979bf4a80270aba232dff11a10d9ca55c4f88de95317970f0de9',
    functionSelector: '0x56feed5e',
  },
  coinbase_country_attestation: {
    id: 'coinbase_country_attestation',
    displayName: 'Coinbase Country',
    description: 'Prove country of residence from Coinbase attestation',
    requiredInputs: ['address', 'signature', 'scope', 'countryList', 'isIncluded'],
    easSchemaId: '0x1801901fabd0e6189356b4fb52bb0ab855276d84f7ec140839fbd1f6801ca065',
    functionSelector: '0x0a225248',
  },
} as const;

export type CircuitId = keyof typeof CIRCUITS;
