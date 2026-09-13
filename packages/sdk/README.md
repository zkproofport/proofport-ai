# @zkproofport-ai/sdk

Client SDK for ZKProofport zero-knowledge proofs, including experimental exact-action authorization on Arc Testnet.

## Overview

@zkproofport-ai/sdk is a TypeScript SDK for generating privacy-preserving zero-knowledge proofs using Coinbase KYC attestations and OIDC JWT tokens. Generate a proof with a single function call, or fine-tune each step for custom workflows.

ZKProofport has a TEE-based proving architecture. Enclave encryption and hardware attestation depend on the selected endpoint and its returned evidence; see the security requirements below.

## Paying for a proof

A service tells you what it charges. Ask for a proof and the answer is either
the proof or a `402` listing the chains it takes USDC on — you pick one.

For supported x402 offers, the payer signs an authorization and the payment rail settles it. Arc Gateway nanopayments spend an already funded Gateway balance; its initial deposit is an on-chain transaction requiring gas. A USDC wallet balance alone is insufficient for nanopayments. Wallet, chain and signing-domain compatibility must match the actual offer.

Supported payment-wallet adapters:

```ts
import {
  generateProof,
  walletFromPrivateKey,   // a raw key
  walletFromCdp,          // a Coinbase CDP server wallet
  walletFromCircle,      // a Circle developer-controlled wallet
  walletFromArcAgent,    // an existing Circle Agent Wallet through Circle CLI
  walletFor,            // walletFor('arc') selects the same adapter from environment
} from '@zkproofport-ai/sdk';

const proof = await generateProof(
  config,
  {
    attestation: signer,                                  // proves who you are
    payment: await walletFromPrivateKey(process.env.PAYMENT_KEY!), // pays
  },
  { circuit: 'coinbase_kyc' },
);
```

The two wallets are separate on purpose. The attestation wallet is fixed — it
is the one your KYC attestation is bound to. The paying wallet is whichever one
holds USDC.

To choose a chain rather than take the first offered, pass `payOn` with a name
from the service's own list:

```ts
const offers = paymentOffers(await requestChallenge(config, 'coinbase_kyc'));
// offers: [{ networkName, amount, asset, payTo }, ...]

await generateProof(config, { attestation: signer, payment }, {
  circuit: 'coinbase_kyc',
  payOn: offers[0].networkName,
});
```

Naming a chain the service does not offer is an error listing what it does. It
never quietly pays on a different one.

From the command line:

```bash
zkproofport-prove coinbase_kyc --pay-with circle --pay-on <chain>
zkproofport-prove coinbase_kyc --pay-with cdp
```

`--pay-with cdp` needs `CDP_API_KEY_ID`, `CDP_API_KEY_SECRET` and
`CDP_WALLET_SECRET`; `--pay-with circle` needs `CIRCLE_API_KEY`,
`CIRCLE_ENTITY_SECRET` and `CIRCLE_WALLET_ID`; `--pay-with key` needs
`PAYMENT_PRIVATE_KEY`. For the existing Circle Agent Wallet, explicitly select `--pay-with arc`; Circle CLI owns the login, and `ARC_AGENT_WALLET` selects its wallet. With exactly one key/CDP/developer-controlled wallet configured you can omit
the flag. With more than one, naming it is required — a wallet is money, and
guessing which account it leaves is not a default worth having.

## Encryption and attestation

When the selected endpoint supplies a supported attested `teePublicKey`, the SDK encrypts inputs with X25519 ECDH + AES-256-GCM. The host relays ciphertext to the enclave; Nitro mode rejects plaintext inputs. Validate the returned attestation against the required trust policy.

An endpoint without that key receives readable circuit inputs over HTTPS and provides no hardware-attestation guarantee. The current Arc staging demo uses that mode. HTTPS transport encryption does not make the prover a blind relay. A valid public proof can hide the credential-holder address from the relying dApp without establishing enclave execution. Only claim hardware-attested proving when the actual attestation supports it.

## Installation

```bash
npm install @zkproofport-ai/sdk@latest ethers
```

Arc support described here requires SDK/MCP **0.2.11 or later**. Install from npm and check the resolved version. Release Please manages package versions and the release workflow publishes them; repository source changes alone do not update `@latest`.

## Prerequisites

**For Coinbase circuits** (`coinbase_kyc`, `coinbase_country`):

1. **Coinbase account with KYC verification** — Complete identity verification on [Coinbase](https://www.coinbase.com/)
2. **Coinbase KYC EAS attestation on Base** — Obtain an attestation via [Coinbase Verifications](https://www.coinbase.com/onchain-verify). This creates an on-chain EAS attestation on Base linked to your wallet address.
3. **Credential signer** (required) — A local signer for the wallet holding the EAS attestation. The CLI uses `ATTESTATION_KEY`; programmatic callers can supply a compatible `ProofportSigner`. Keep key material outside model context.

**For OIDC circuits** (`oidc_domain`): No wallet or attestation needed — just a JWT `id_token` from your OIDC provider.

**For the action-bound circuit** (`arc_eligibility`): the same Coinbase KYC attestation as above. What differs is what the wallet signs — see below.

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


## Binding a proof to one action (experimental, testnet only)

> **Experimental. Testnet only.**
>
> `arc_eligibility` is deployed experimentally on **Arc Testnet, chain 5042002**, not mainnet. The verifier is `0xCbC8E63fF92659E8B44cFF117D33005Bb669a018`; the Ledger House EligibilityGate is `0xD0F3eE648386B59B484157332E736388Fcc41F47`. Its public-input layout and deployment may change. Do not put it in front of real funds. The circuits that are generally available are
> `coinbase_kyc`, `coinbase_country` and `oidc_domain`.

### The problem it solves

Every other circuit here has the wallet sign `signal_hash`, which is
`keccak256(address, scope, circuitId)`. That value is the same for a given
wallet and scope no matter what the proof is later used for, so:

- **It commits to no action.** A proof produced to deposit into one vault
  verifies just as well at a different vault, for a different amount, from a
  different caller, with no deadline. A verifier that checks
  `msg.sender == expectedCaller` gains nothing if the proof never committed to
  that caller.
- **The person signing cannot read what they approve.** `personal_sign` over 32
  opaque bytes shows a hex string. That is tolerable while a proof only asserts
  "this wallet is KYC'd"; it is not once an agent moves money with it.

### What changes

Pass an `action` and the wallet signs an [EIP-712](https://eips.ethereum.org/EIPS/eip-712)
typed structure instead. You define the structure — this SDK keeps no registry
of action shapes and never invents one.

```typescript
const result = await generateProof(
  config,
  { attestation: attestationSigner },
  {
    circuit: 'arc_eligibility',
    scope: 'my-app',
    action: {
      domain: {
        name: 'MyVault',
        version: '1',
        chainId: 5042002,
        verifyingContract: vaultAddress,   // binds the signature to ONE contract
      },
      types: {
        Deposit: [
          { name: 'amount', type: 'uint256' },
          { name: 'nonce', type: 'uint256' },
          { name: 'expiry', type: 'uint64' },
        ],
      },
      primaryType: 'Deposit',
      message: { amount: 100_000n, nonce: 1n, expiry: deadline },
    },
  },
);
```

The wallet renders `amount`, `nonce` and `expiry` by name for the person to
read. Two 32-byte hashes reach the circuit — the EIP-712 domain separator and
the hash of the action — and the circuit proves the KYC'd key signed them. It
never learns what the action was, so nothing about vaults or USDC is baked into
it: a grant of authority or an agreement in prose works the same way.

```typescript
// Free-form text is a valid shape.
types: { Agreement: [{ name: 'terms', type: 'string' }] },
primaryType: 'Agreement',
message: { terms: 'Deposit 0.1 USDC into the KYC-gated vault' },
```

A contract cannot enforce prose, though. To check an amount on-chain, the
amount has to be its own field.

### What your verifier does

It recomputes both hashes from the call it is about to run and refuses a
mismatch:

```solidity
bytes32 domainSeparator = _domainSeparatorV4();          // this contract, this chain
bytes32 actionHash = keccak256(abi.encode(
    DEPOSIT_TYPEHASH, amount, nonce, uint64(expiry)
));
require(publicInputs.domainSeparator == domainSeparator, "wrong contract");
require(publicInputs.actionHash == actionHash, "wrong action");
```

Public inputs arrive in this order — read off the compiled ABI, 192 fields of
one byte each:

| Field | Byte range |
|---|---|
| `signal_hash` | 0–31 |
| `domain_separator` | 32–63 |
| `action_hash` | 64–95 |
| `signer_list_merkle_root` | 96–127 |
| `scope` | 128–159 |
| `nullifier` | 160–191 |

`signal_hash` is still present, and nobody signs it: the nullifier derives from
it, exactly as on the other Coinbase circuits. Deriving the nullifier from the
signed action instead would give a different nullifier per action and destroy
the one-per-person property it exists for.

### Omitting `action`

`arc_eligibility` requires `action`; omitting it is rejected. Other circuits reject `action` and retain their existing `personal_sign` flow. The application must verify the exact target, operational wallet, amount, nonce and deadline as well as the proof.

## Arc Circle Agent Wallet path — EXPERIMENTAL

Use the existing Circle CLI login and selected Arc Agent Wallet; do not create or switch wallets as part of proof generation. Install the CLI if needed, then let the user complete any missing login locally. Keep `ATTESTATION_KEY` and login secrets outside prompts, model context, logs and committed configuration.

```bash
npm install -g @circle-fin/cli
circle wallet list --chain ARC-TESTNET --type agent
# Set ARC_AGENT_WALLET to the user's existing, approved wallet B address.
circle gateway balance --address "$ARC_AGENT_WALLET" --chain ARC-TESTNET --output json
# Only when the user has approved this funding amount:
circle gateway deposit --amount 0.1 --address "$ARC_AGENT_WALLET" --chain ARC-TESTNET --method direct
```

The payment adapter resolves Circle's backing EOA for Gateway authorization. The operational smart-wallet address remains Wallet B for the action and stake; do not substitute the backing EOA into the action's `delegate` field. `walletFromArcAgent({address: process.env.ARC_AGENT_WALLET, chain: 'ARC-TESTNET'})` and `walletFor('arc')` provide the same payment path.

After the user reviews the action and the live x402 offer, save those exact approved objects locally as `approved-action.json` and `approved-payment.json`:

```typescript
import { readFile } from 'node:fs/promises';
import {
  createConfig, fromPrivateKey, generateProof, verifyProof, walletFor,
  type ProofParams, type ApprovedPayment,
} from '@zkproofport-ai/sdk';

const config = createConfig({baseUrl: 'https://stg-ai.zkproofport.app'});
const action: NonNullable<ProofParams['action']> = JSON.parse(await readFile('approved-action.json', 'utf8'));
const approvedPayment: ApprovedPayment = JSON.parse(await readFile('approved-payment.json', 'utf8'));
const result = await generateProof(config, {
  attestation: fromPrivateKey(process.env.ATTESTATION_KEY!), // local credential holder A
  payment: await walletFor('arc'),                         // existing Circle wallet B
}, {
  circuit: 'arc_eligibility', scope: 'ledger-house', action,
  payOn: 'arc-testnet-nano', maxPayment: '0.001', approvedPayment,
});
const verification = await verifyProof(result);
if (!verification.valid) throw new Error('Arc verifier rejected the proof');
```

`approvedPayment` must pin the live offer's `network`, `scheme`, `amount`, `asset`, `payTo`, and `extra: {name, version, verifyingContract}`. `amount` is an integer string in USDC base units (`"1000"` is 0.001 USDC); `maxPayment` is a decimal USDC string (`"0.001"`). A changed fee, recipient, asset, network or Gateway signing domain is rejected before payment signing. Approve the actual offer; do not manufacture its recipient or domain from a documentation example.

For the deployed Ledger House gate, use the dApp's exact EIP-712 shape: domain `Ledger House Staking`, version `1`, chain `5042002`, and the gate address above. Its `CredentialDelegation` type contains `delegate: address`, `action: string`, `amount: uint256`, `expiresAt: uint256`, `nonce: string`; the message uses Wallet B, `"stake"`, `"100000"` for 0.1 USDC, and the approved deadline and fresh nonce. **Exact-action authorization** is the user-facing term; existing wire keys and `CredentialDelegation` are unchanged.

Generating and verifying a proof does not submit a stake. After a separate stake approval, the operational wallet calls the dApp gate, which verifies the proof and enforces its policy, exact action, unused nonce and deadline atomically. Check the receipt before reporting a position change.

The MCP `gateway_balance` and `deposit_to_gateway` helpers currently require `PAYMENT_PRIVATE_KEY`; they do not operate the Circle Agent Wallet. Use the Circle CLI commands above for that wallet. SDK `gatewayBalance` / `ensureGatewayBalance` likewise accept the private-key `NanopaymentWallet` shape. This path documents the supported Arc Testnet offer, not a guarantee for every wallet on every chain.

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
5. Generate the proof on the configured prover (enclave-encrypted only for the supported Nitro deployment)

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
type CircuitName = 'coinbase_kyc' | 'coinbase_country' | 'oidc_domain' | 'arc_eligibility';
type CircuitId = 'coinbase_attestation' | 'coinbase_country_attestation' | 'oidc_domain_attestation' | 'arc_eligibility';
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
  action?: { domain: { name: string; version: string; chainId: number; verifyingContract: string }; types: Record<string, Array<{name: string; type: string}>>; primaryType: string; message: Record<string, unknown> }; // required only for arc_eligibility
  payOn?: string;
  maxPayment?: string; // decimal USDC
  approvedPayment?: ApprovedPayment;
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
