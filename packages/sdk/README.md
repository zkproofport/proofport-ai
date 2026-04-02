# @zkproofport-ai/sdk

Client SDK for ZKProofport zero-knowledge proof generation on Base Mainnet.

## Overview

@zkproofport-ai/sdk is a TypeScript SDK for generating privacy-preserving zero-knowledge proofs using Coinbase KYC attestations and OIDC JWT tokens. Generate a proof with a single function call, or fine-tune each step for custom workflows.

Proofs are generated in trusted execution environments (Nitro Enclaves) with cryptographic attestation. Proof generation is **free** — no payment required.

## E2E Encryption (TEE Blind Relay)

All proof inputs are **end-to-end encrypted** using X25519 ECDH + AES-256-GCM. The ZKProofport server acts as a **blind relay** — it cannot read your inputs, even during proof generation. Only the TEE (AWS Nitro Enclave) can decrypt.

**How it works:**

1. `generateProof()` contacts the server to obtain the TEE public key
2. The response includes `teePublicKey` — the TEE's attested X25519 public key (cryptographically bound to the Nitro Enclave via COSE Sign1 attestation)
3. The SDK generates an ephemeral X25519 keypair, performs ECDH key agreement, and encrypts all circuit inputs with AES-256-GCM
4. The encrypted payload is sent to the server, which relays it blindly to the TEE
5. The TEE decrypts, generates the ZK proof, and returns it

**This is fully automatic.** `generateProof()` detects `teePublicKey` in the 402 response and applies E2E encryption when available. No additional configuration or code changes needed.

- **TEE enabled (production):** Inputs are E2E encrypted. Server rejects plaintext (`PLAINTEXT_REJECTED`).
- **TEE disabled (local dev):** Inputs are sent in plaintext. No encryption overhead.

## Installation

```bash
npm install @zkproofport-ai/sdk ethers
```

## Prerequisites

**For Coinbase circuits** (`coinbase_kyc`, `coinbase_country`):

1. **Coinbase account with KYC verification** — Complete identity verification on [Coinbase](https://www.coinbase.com/)
2. **Coinbase KYC EAS attestation on Base** — Obtain an attestation via [Coinbase Verifications](https://www.coinbase.com/onchain-verify). This creates an on-chain EAS attestation on Base linked to your wallet address.
3. **Attestation wallet private key** (required) — The private key of the wallet that holds the EAS attestation. This is always a raw private key because the attestation is tied to a specific address.

**For OIDC circuits** (`oidc_domain`): No wallet or attestation needed — just a JWT `id_token` from your OIDC provider.

## Quick Start

```typescript
import { generateProof, createConfig, fromPrivateKey, verifyProof } from '@zkproofport-ai/sdk';

const config = createConfig();
const attestationSigner = fromPrivateKey(process.env.ATTESTATION_KEY);

const result = await generateProof(
  config,
  { attestation: attestationSigner },
  { circuit: 'coinbase_kyc', scope: 'my-app' }
);

const verification = await verifyProof(result);
console.log('Valid:', verification.valid);
```

## Configuration

```typescript
import { createConfig } from '@zkproofport-ai/sdk';

// Default — production use
const config = createConfig();

// Custom server URL
const config = createConfig({
  baseUrl: 'https://your-custom-server.example.com',
});
```

**Configuration fields:**

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `baseUrl` | string | `https://ai.zkproofport.app` | proofport-ai server URL |

## Proof Generation

### Single-Step Flow

The `generateProof()` function handles the entire proof generation pipeline: signing, attestation fetching, circuit input preparation, and proof generation.

```typescript
import { generateProof, createConfig, fromPrivateKey } from '@zkproofport-ai/sdk';
import type { StepResult } from '@zkproofport-ai/sdk';

const config = createConfig();
const attestationSigner = fromPrivateKey(process.env.ATTESTATION_KEY);

const result = await generateProof(
  config,
  { attestation: attestationSigner },
  {
    circuit: 'coinbase_kyc',
    scope: 'my-application',
    // Optional: for country circuit
    // countryList: ['US', 'KR'],
    // isIncluded: true, // true = inclusion list, false = exclusion
  },
  {
    onStep: (step: StepResult) => {
      console.log(`[${step.step}] ${step.name} (${step.durationMs}ms)`);
    },
  }
);

console.log('Proof generated in', result.timing.totalMs, 'ms');
console.log('Proof:', result.proof);
console.log('Public inputs:', result.publicInputs);

// Attestation present if TEE mode enabled on server
if (result.attestation) {
  console.log('TEE document:', result.attestation.document);
  console.log('Verification:', result.attestation.verification);
}
```

**Proof generation flow:**
1. Sign signal hash with attestation signer
2. Fetch Coinbase KYC attestation from EAS
3. Build circuit inputs (Merkle tree, hashes)
4. **Auto-detect E2E encryption** — if `teePublicKey` is present in server response, encrypt inputs with X25519 ECDH + AES-256-GCM
5. Generate proof in TEE (encrypted inputs if TEE enabled)

**Result fields:**

| Field | Type | Description |
|-------|------|-------------|
| `proof` | string | 0x-prefixed proof hex |
| `publicInputs` | string | 0x-prefixed public inputs hex |
| `proofWithInputs` | string | Combined proof + public inputs |
| `attestation` | object | TEE attestation (document, proof_hash, verification) or null |
| `timing` | object | Execution times per step |
| `verification` | object | On-chain verifier info (chainId, address, rpcUrl) |

## On-Chain Verification

### Automatic Verification

```typescript
import { verifyProof } from '@zkproofport-ai/sdk';

const verification = await verifyProof(result);

if (verification.valid) {
  console.log('Proof is valid on-chain');
} else {
  console.log('Proof verification failed:', verification.error);
}
```

## Step-by-Step API

For advanced workflows or debugging, use individual step functions instead of `generateProof()`.

```typescript
import {
  prepareInputs,
  submitProof,
  computeSignalHash,
  CIRCUIT_NAME_MAP,
  EthersWalletSigner,
  createConfig,
} from '@zkproofport-ai/sdk';
import { ethers } from 'ethers';

const config = createConfig();
const circuit = 'coinbase_kyc';
const circuitId = CIRCUIT_NAME_MAP[circuit];
const scope = 'my-app';

// Step 1: Sign signal hash
const attestationWallet = new ethers.Wallet(process.env.ATTESTATION_KEY);
const signalHash = computeSignalHash(attestationWallet.address, scope, circuitId);
const signalHashBytes = ethers.getBytes(ethers.hexlify(signalHash));
const signature = await attestationWallet.signMessage(signalHashBytes);

// Step 2: Prepare circuit inputs
const inputs = await prepareInputs(config, {
  circuitId,
  userAddress: attestationWallet.address,
  userSignature: signature,
  scope,
});

// Step 3: Submit proof
const proofResponse = await submitProof(config, {
  circuit,
  inputs,
});

console.log('Proof:', proofResponse.proof);
console.log('Public inputs:', proofResponse.publicInputs);
```

## Circuits

### Coinbase KYC

Proves wallet holder passed Coinbase Know-Your-Customer verification.

```typescript
const result = await generateProof(config, signers, {
  circuit: 'coinbase_kyc',
  scope: 'my-app', // any string; used to prevent proof replay
});
```

### Coinbase Country

Proves wallet holder's country is (or is not) in a specified list.

```typescript
const result = await generateProof(config, signers, {
  circuit: 'coinbase_country',
  countryList: ['US', 'KR'],
  isIncluded: true, // true = prove in list, false = prove not in list
  scope: 'my-app',
});
```

### OIDC Domain

Proves email domain affiliation using an OIDC JWT token (e.g., Google, Microsoft). No EAS attestation, Coinbase account, or wallet required — only a JWT `id_token`.

#### Google Workspace

```typescript
import { createConfig, generateProof } from '@zkproofport-ai/sdk';

const config = createConfig();

const result = await generateProof(
  config,
  {},
  {
    circuit: 'oidc_domain',
    jwt: googleIdToken, // JWT id_token from Google OAuth
    scope: 'myapp:verify-domain',
  },
);
```

#### Microsoft 365

```typescript
import { createConfig, generateProof } from '@zkproofport-ai/sdk';

const config = createConfig();

const result = await generateProof(
  config,
  {},
  {
    circuit: 'oidc_domain',
    jwt: microsoftIdToken, // JWT id_token from Microsoft OAuth
    provider: 'microsoft',
    scope: 'myapp:verify-domain',
  },
);
```

> **Note:** For OIDC circuits, no wallet or private key is needed — just a JWT `id_token` from your OIDC provider.

## Extracting Data from Proofs

For OIDC domain proofs, use helper functions to extract the domain and nullifier from public inputs:

```typescript
import { generateProof, createConfig, extractDomainFromPublicInputs, extractNullifierFromPublicInputs } from '@zkproofport-ai/sdk';

const config = createConfig();

const result = await generateProof(
  config,
  {},
  {
    circuit: 'oidc_domain',
    jwt: googleIdToken,
    scope: 'myapp:verify-domain',
  },
);

// Extract domain and nullifier from proof
const domain = extractDomainFromPublicInputs(result.publicInputs);
const nullifier = extractNullifierFromPublicInputs(result.publicInputs);

console.log('Verified domain:', domain);
console.log('Nullifier:', nullifier);
```

**Public Input Layout (oidc_domain_attestation):**

The proof contains 148 public input fields (32 bytes each):

| Fields | Description |
|--------|-------------|
| 0-17 | RSA pubkey modulus limbs (18 x u128) |
| 18-81 | Domain storage (BoundedVec<u8, 64>) |
| 82 | Domain length |
| 83-114 | Scope (32 bytes) |
| 115-146 | Nullifier (32 bytes) |
| 147 | Provider identifier (u8) |

**Functions:**

- `extractDomainFromPublicInputs(publicInputs: string): string | null` — Extracts the email domain (e.g., "google.com") from public inputs. Returns null if extraction fails.
- `extractNullifierFromPublicInputs(publicInputs: string): string | null` — Extracts the 32-byte nullifier as a 0x-prefixed hex string. Returns null if extraction fails.

## Types Reference

**Circuit Types:**

```typescript
type CircuitName = 'coinbase_kyc' | 'coinbase_country' | 'oidc_domain';
type CircuitId = 'coinbase_attestation' | 'coinbase_country_attestation' | 'oidc_domain_attestation';
```

**Configuration:**

```typescript
interface ClientConfig {
  baseUrl: string;
}
```

**Signer:**

```typescript
interface ProofportSigner {
  getAddress(): string | Promise<string>;
  signMessage(message: Uint8Array): Promise<string>;
  signTypedData(domain: {...}, types: {...}, message: {...}): Promise<string>;
  sendTransaction(tx: {...}): Promise<{ hash: string; wait(): Promise<{...}> }>;
}

// Create signer from ethers private key
function fromPrivateKey(key: string, provider?: ethers.Provider): ProofportSigner;

// Create signer from ethers Wallet
function fromSigner(signer: ethers.Signer): ProofportSigner;
```

**Proof Parameters:**

```typescript
interface ProofParams {
  circuit: CircuitName;
  scope?: string; // defaults to 'proofport'
  countryList?: string[]; // for coinbase_country only
  isIncluded?: boolean; // for coinbase_country only
  jwt?: string; // JWT id_token for OIDC circuits (required for oidc_domain)
  provider?: 'google' | 'microsoft'; // OIDC provider (default: 'google')
}
```

**Proof Result:**

```typescript
interface ProofResult {
  proof: string;
  publicInputs: string;
  proofWithInputs: string;
  attestation: {
    document: string;
    proof_hash: string;
    verification: {
      rootCaValid: boolean;
      chainValid: boolean;
      signatureValid: boolean;
      pcrs: Record<number, string>;
    };
  } | null;
  timing: {
    totalMs: number;

    inputBuildMs?: number;
    proveMs?: number;
  };
  verification: {
    chainId: number;
    verifierAddress: string;
    rpcUrl: string;
  } | null;
}
```

**OIDC Inputs:**

```typescript
interface OidcProveInputs {
  jwt: string;
  scope_string: string;
}
```

**Callbacks:**

```typescript
interface FlowCallbacks {
  onStep?: (step: StepResult) => void;
}

interface StepResult {
  step: number;
  name: string;
  data: unknown;
  durationMs: number;
}
```

## Error Handling

```typescript
import { generateProof, createConfig, fromPrivateKey } from '@zkproofport-ai/sdk';

try {
  const result = await generateProof(config, signers, params);
} catch (error) {
  if (error instanceof Error) {
    if (error.message.includes('attestation')) {
      console.error('Attestation not found or invalid');
    } else if (error.message.includes('Sumcheck')) {
      console.error('Proof verification failed on-chain');
    } else {
      console.error('Proof generation failed:', error.message);
    }
  }
}
```

Common errors:

| Error | Cause | Solution |
|-------|-------|----------|
| `Attestation not found` | Wallet has no Coinbase KYC attestation | Verify attestation on Base Mainnet via EAS |
| `Sumcheck failed` | On-chain verification failed | Proof corrupted or verifier contract mismatch |

## License

MIT
