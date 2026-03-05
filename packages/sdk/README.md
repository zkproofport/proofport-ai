# @zkproofport-ai/sdk

Client SDK for ZKProofport zero-knowledge proof generation on Base Mainnet.

## Overview

@zkproofport-ai/sdk is a TypeScript SDK for generating privacy-preserving zero-knowledge proofs using Coinbase KYC attestations. Generate a proof with a single function call, or fine-tune each step for custom workflows.

Proofs are generated in trusted execution environments (Nitro Enclaves) with cryptographic attestation. Payment is handled transparently via the x402 protocol using EIP-3009 (no user gas costs).

## Installation

```bash
npm install @zkproofport-ai/sdk ethers
```

## Prerequisites

Before using the SDK, you need:

1. **Coinbase account with KYC verification** — Complete identity verification on [Coinbase](https://www.coinbase.com/)
2. **Coinbase KYC EAS attestation on Base** — Obtain an attestation via [Coinbase Verifications](https://www.coinbase.com/onchain-verify). This creates an on-chain EAS attestation on Base linked to your wallet address.
3. **USDC balance on Base** — At least $0.10 per proof. Payment is gasless (EIP-3009 signature, facilitator pays gas).
4. **Attestation wallet private key** (required) — The private key of the wallet that holds the EAS attestation. This is always a raw private key because the attestation is tied to a specific address.

5. **Payment wallet** (optional) — Wallet with USDC balance for proof payment. Defaults to the attestation wallet. Choose one:

   - **Same as attestation wallet** — No additional setup. The attestation wallet must hold USDC.
   - **Separate private key** — A different wallet with USDC balance.
   - **CDP MPC wallet** — Coinbase Developer Platform managed wallet. Private keys never leave Coinbase's TEE. Get credentials at [CDP Portal](https://portal.cdp.coinbase.com). Requires additional install:
     ```bash
     npm install @coinbase/agentkit @coinbase/cdp-sdk
     ```
     | Credential | Required | Description |
     |------------|----------|-------------|
     | `CDP_API_KEY_ID` | Yes | CDP API key ID |
     | `CDP_API_KEY_SECRET` | Yes | CDP API key secret |
     | `CDP_WALLET_SECRET` | Yes | CDP wallet encryption secret |
     | `CDP_WALLET_ADDRESS` | No | Existing wallet address (creates new if omitted) |

## Quick Start

### Single Wallet (attestation + payment)

```typescript
import { generateProof, createConfig, fromPrivateKey, verifyProof } from '@zkproofport-ai/sdk';

const config = createConfig();
const signer = fromPrivateKey(process.env.PRIVATE_KEY);

const result = await generateProof(
  config,
  { attestation: signer },
  { circuit: 'coinbase_kyc', scope: 'my-app' }
);

const verification = await verifyProof(result);
console.log('Valid:', verification.valid);
```

### Separate Payment Wallet

```typescript
import { generateProof, createConfig, fromPrivateKey, verifyProof } from '@zkproofport-ai/sdk';

const config = createConfig();
const attestationSigner = fromPrivateKey(process.env.ATTESTATION_KEY);
const paymentSigner = fromPrivateKey(process.env.PAYMENT_KEY);

const result = await generateProof(
  config,
  { attestation: attestationSigner, payment: paymentSigner },
  { circuit: 'coinbase_kyc', scope: 'my-app' }
);

const verification = await verifyProof(result);
console.log('Valid:', verification.valid);
```

### With CDP Payment Wallet

```typescript
import { generateProof, createConfig, fromPrivateKey, CdpWalletSigner, verifyProof } from '@zkproofport-ai/sdk';

const config = createConfig();
const attestationSigner = fromPrivateKey(process.env.ATTESTATION_KEY);
const paymentSigner = await CdpWalletSigner.create({
  apiKeyId: process.env.CDP_API_KEY_ID,
  apiKeySecret: process.env.CDP_API_KEY_SECRET,
  walletSecret: process.env.CDP_WALLET_SECRET,
  address: process.env.CDP_WALLET_ADDRESS,
});

const result = await generateProof(
  config,
  { attestation: attestationSigner, payment: paymentSigner },
  { circuit: 'coinbase_kyc', scope: 'my-app' }
);

const verification = await verifyProof(result);
console.log('Valid:', verification.valid);
```

## Configuration

```typescript
import { createConfig } from '@zkproofport-ai/sdk';

// Mainnet (default) — production use
const config = createConfig();

// Custom server or RPC endpoints
const config = createConfig({
  baseUrl: 'https://ai.zkproofport.app',
  easRpcUrl: 'https://mainnet.base.org',
  easGraphqlUrl: 'https://base.easscan.org/graphql',
});
```

**Configuration fields:**

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `baseUrl` | string | `https://ai.zkproofport.app` | proofport-ai server URL |
| `easRpcUrl` | string | `https://mainnet.base.org` | Base Mainnet RPC for EAS attestation queries |
| `easGraphqlUrl` | string | `https://base.easscan.org/graphql` | EAS GraphQL endpoint for attestation schema queries |

## Proof Generation

### Single-Step Flow

The `generateProof()` function handles the entire proof generation pipeline: signing, attestation fetching, circuit input preparation, x402 payment, and proof generation.

```typescript
import { generateProof, createConfig, fromPrivateKey } from '@zkproofport-ai/sdk';
import type { StepResult } from '@zkproofport-ai/sdk';

const config = createConfig();
const attestationSigner = fromPrivateKey(process.env.ATTESTATION_KEY);
const paymentSigner = fromPrivateKey(process.env.PAYMENT_KEY); // optional

const result = await generateProof(
  config,
  {
    attestation: attestationSigner,
    payment: paymentSigner, // uses attestationSigner if not provided
  },
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
console.log('Payment TX:', result.paymentTxHash);

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
4. Request 402 payment challenge
5. Sign EIP-3009 TransferWithAuthorization
6. Submit payment via x402 facilitator
7. Generate proof in TEE with payment proof

**Result fields:**

| Field | Type | Description |
|-------|------|-------------|
| `proof` | string | 0x-prefixed proof hex |
| `publicInputs` | string | 0x-prefixed public inputs hex |
| `proofWithInputs` | string | Combined proof + public inputs |
| `paymentTxHash` | string | Transaction hash of x402 payment |
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
  requestChallenge,
  makePayment,
  submitProof,
  computeSignalHash,
  CIRCUIT_NAME_MAP,
  USDC_ADDRESSES,
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

// Step 3: Request payment challenge
const challenge = await requestChallenge(config, circuit, inputs);

// Step 4: Make payment via x402 facilitator
const provider = new ethers.JsonRpcProvider('https://mainnet.base.org');
const paymentWallet = new ethers.Wallet(process.env.PAYMENT_KEY, provider);
const paymentSigner = new EthersWalletSigner(paymentWallet);

const paymentTxHash = await makePayment(paymentSigner, {
  nonce: challenge.nonce,
  recipient: challenge.payment.payTo,
  amount: parseInt(challenge.payment.maxAmountRequired),
  asset: USDC_ADDRESSES['base'],
  network: challenge.payment.network,
  instruction: challenge.payment.description,
});

// Step 5: Submit proof with payment proof
const proofResponse = await submitProof(config, {
  circuit,
  inputs,
  paymentTxHash,
  paymentNonce: challenge.nonce,
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

## Types Reference

**Circuit Types:**

```typescript
type CircuitName = 'coinbase_kyc' | 'coinbase_country';
type CircuitId = 'coinbase_attestation' | 'coinbase_country_attestation';
```

**Configuration:**

```typescript
interface ClientConfig {
  baseUrl: string;
  easRpcUrl?: string;
  easGraphqlUrl?: string;
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
```

**Proof Parameters:**

```typescript
interface ProofParams {
  circuit: CircuitName;
  scope?: string; // defaults to 'proofport'
  countryList?: string[]; // for coinbase_country only
  isIncluded?: boolean; // for coinbase_country only
}
```

**Proof Result:**

```typescript
interface ProofResult {
  proof: string;
  publicInputs: string;
  proofWithInputs: string;
  paymentTxHash: string;
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
    paymentVerifyMs?: number;
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

## Payment

Payment is transparent to the application. When `generateProof()` runs, the user signs an EIP-3009 `TransferWithAuthorization` message (no gas cost). The signature is sent to the x402 facilitator, which completes the USDC transfer and proves payment to the server.

- Protocol: x402 (HTTP 402 Payment Required)
- Method: EIP-3009 `TransferWithAuthorization`
- Token: USDC on Base Mainnet
- Amount: $0.10 per proof
- Facilitator: https://www.x402.org/facilitator (pays gas)
- User cost: Only USDC, no ETH for gas

The payment transaction hash is included in `result.paymentTxHash` for settlement tracking.

## Error Handling

```typescript
import { generateProof, createConfig, fromPrivateKey } from '@zkproofport-ai/sdk';

try {
  const result = await generateProof(config, signers, params);
} catch (error) {
  if (error instanceof Error) {
    if (error.message.includes('402')) {
      console.error('Payment required or payment failed');
    } else if (error.message.includes('attestation')) {
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
| `402 Payment Required` | x402 payment failed or insufficient USDC | Ensure wallet has USDC balance, check x402 facilitator |
| `Sumcheck failed` | On-chain verification failed | Proof corrupted or verifier contract mismatch |
| `Transaction failed` | User rejected signature | Retry or check wallet |

## License

MIT
