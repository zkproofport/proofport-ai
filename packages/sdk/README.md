# @zkproofport-ai/sdk

Client SDK for ZKProofport zero-knowledge proofs, including experimental exact-action authorization on Arc Testnet.

The shared `hashTypedAction` helper is available from **SDK 0.2.12**. Arc/GIWA optional actions require **SDK 0.2.14 or later**; MCP stepwise input preparation requires **MCP 0.2.15 or later**. Release Please owns the versions. Confirm the resolved npm versions before using this path.

Human action approval requires SDK **0.3.0 or later** and a compatible AI service with the approval API enabled. For the CLI/MCP flow, use MCP **0.3.0 or later** as well. Earlier releases that support action hashing do not implement this approval lifecycle. Action requests now pause for human approval; handle `ActionApprovalRequiredError` and resume as shown below.

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

Use **SDK 0.2.14 or later** and **MCP 0.2.15 or later** for both Arc/GIWA signature modes, including stepwise preparation. Install from npm and check the resolved version. Release Please manages package versions and the release workflow publishes them; repository source changes alone do not update `@latest`.

## Prerequisites

**For Coinbase circuits** (`coinbase_kyc`, `coinbase_country`):

1. **Coinbase account with KYC verification** — Complete identity verification on [Coinbase](https://www.coinbase.com/)
2. **Coinbase KYC EAS attestation on Base** — Obtain an attestation via [Coinbase Verifications](https://www.coinbase.com/onchain-verify). This creates an on-chain EAS attestation on Base linked to your wallet address.
3. **Credential signer for proofs without an action** — A local signer for the wallet holding the EAS attestation. The CLI uses `ATTESTATION_KEY`; programmatic callers can supply a compatible `ProofportSigner`. An Arc/GIWA action instead requires the credential holder to connect a wallet and sign through the approval page. Keep key material outside model context.

**For OIDC circuits** (`oidc_domain`): No wallet or attestation needed — just a JWT `id_token` from your OIDC provider.

**For GIWA** (`giwa_attestation`): an attestation from GIWA's attester on **GIWA Sepolia**, and control of that wallet. Without an action, supply its local signer; with an action, the person connects that wallet on the approval page. The attestation must belong to the wallet signing the proof request on the chain the circuit reads.

**For the circuits that can bind an action** (`arc_eligibility`, `giwa_attestation`): the attestation above for whichever one you ask for. What differs is what the wallet signs, and the action is **optional** — see below.

**One wallet has a different nullifier per circuit, and for the circuits above it does not depend on what you signed.** `arc_eligibility` and `giwa_attestation` derive it from your address, the circuit's own identifier and the scope, so the same wallet in the same scope gives the same nullifier whether or not you bind an action. The Coinbase circuits derive theirs from the signed challenge instead. Nothing to configure — the SDK picks the rule the circuit expects, and refuses a circuit it has no rule for rather than guessing one. Requires **0.2.14 or later**; earlier versions sent the Coinbase rule for every circuit, which a GIWA proof rejects as a nullifier mismatch.

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
> Two circuits can bind an action, both on testnets and neither generally available:
>
> | Circuit | Chain | Verifier |
> |---|---|---|
> | `arc_eligibility` | Arc Testnet, 5042002 | `0x2aEB66292f631ceb6225ffA2439B1f2b4b15e44a` |
> | `giwa_attestation` | GIWA Sepolia, 91342 | `0x5Da234546874304F8c51BBEed00fC632938211c1` |
>
> The Ledger House EligibilityGate on Arc is `0xD0F3eE648386B59B484157332E736388Fcc41F47`. Public-input layouts and deployments may change; do not put either in front of real funds. Generally available: `coinbase_kyc`, `coinbase_country`, `oidc_domain`.
>
> **The action is optional on both.** Send one and the SDK pauses for a human to connect a wallet and sign the exact typed data. Send none and the supplied credential signer signs the request's signal hash as before. Supplying `ATTESTATION_KEY` does not bypass action approval.

### The problem it solves

The Coinbase KYC and country circuits have the wallet sign `signal_hash`, which is
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

Pass an `action` and a human wallet signs an [EIP-712](https://eips.ethereum.org/EIPS/eip-712)
typed structure through the AI service's approval page. You define the structure;
the SDK does not invent action fields. No proof challenge or payment starts while
approval is pending. The agent's payment wallet remains separately configured.

```typescript
import {
  ActionApprovalRequiredError, generateProof, getActionApprovalStatus,
  type ActionApproval, type ClientConfig, type PaymentWallet, type ProofParams,
} from '@zkproofport-ai/sdk';

const params: ProofParams = {
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
      message: { amount: '100000', nonce: '1', expiry: String(deadline) },
    },
};

// For a CLI or backend with an appropriate request lifetime. An MCP tool should
// return the URL promptly and resume in a later call instead of waiting here.
async function waitForHumanApproval(config: ClientConfig, approval: ActionApproval) {
  while (Date.now() < Date.parse(approval.expiresAt)) {
    const status = await getActionApprovalStatus(config, approval);
    if (status.status === 'approved') return;
    if (status.status !== 'pending') throw new Error(`Action approval is ${status.status}`);
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  throw new Error('Action approval expired');
}

async function generateWithHumanApproval(config: ClientConfig, payment: PaymentWallet, params: ProofParams) {
  try {
    return await generateProof(config, { payment }, params);
  } catch (error) {
    if (!(error instanceof ActionApprovalRequiredError)) throw error;
    const approval = error.approval;
    console.error('Review and sign:', approval.approvalUrl);
    await waitForHumanApproval(config, approval);
    // Consume once. Do not retry this call automatically after a failure.
    return generateProof(config, { payment }, { ...params, actionApproval: approval });
  }
}

const result = await generateWithHumanApproval(config, payment, params);
```

`ActionApprovalRequiredError` is a pause, not a failed proof. Its `.approval`
handle contains `{approvalId, approvalUrl, requesterToken, expiresAt}`. Keep
`requesterToken` in private application storage; only show the approval URL to
the person. Status replies contain no signature. `resolveActionApproval`
checks the original circuit, scope, full action and recovered signer before
preparing inputs. Rejected, expired and consumed sessions cannot proceed.

The session expires after ten minutes and can be consumed once. If a response
is lost after consumption, inspect the previous proof/payment outcome before
requesting fresh approval; never automatically pay again. Session expiry does
not expire the EIP-712 signature on chain. The relying contract must enforce
the action's own nonce and deadline. This flow supports EOA credential wallets;
contract-wallet signature verification is outside the current circuit.

Ask for `giwa_attestation` instead to use the credential wallet's GIWA Sepolia
attestation. The action domain names the relying contract's execution chain;
it is independent of the chain used for attestation lookup or proof payment.
The approval page asks the wallet to use the action's declared chain.

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

Both `arc_eligibility` and `giwa_attestation` accept an omitted action and retain their local `personal_sign` path. Coinbase circuits reject `action` and retain their existing signing path; OIDC rejects `action` and uses its JWT flow without wallet signing. For action proofs, the application must verify the exact target, operational wallet, amount, nonce and deadline as well as the proof.

## Arc Circle Agent Wallet path — EXPERIMENTAL

Use the existing Circle CLI login and selected Arc Agent Wallet; do not create or switch wallets as part of proof generation. Install the CLI if needed, then let the user complete any missing login locally. Credential holder A connects their wallet on the human approval page; this action flow does not load A's `ATTESTATION_KEY`. Keep credential data and Circle login secrets outside model context and ordinary logs.

```bash
npm install -g @circle-fin/cli
circle wallet list --chain ARC-TESTNET --type agent
# Set ARC_AGENT_WALLET to the user's existing, approved wallet B address.
circle gateway balance --address "$ARC_AGENT_WALLET" --chain ARC-TESTNET --output json
# Only when the user has approved this funding amount:
circle gateway deposit --amount 0.1 --address "$ARC_AGENT_WALLET" --chain ARC-TESTNET --method direct
```

For the live Gateway batched offer, SDK `signPayment` uses `@circle-fin/x402-batching` and the Circle CLI wallet adapter. It signs the Gateway authorization against the offer’s Gateway signing domain and spends the existing funded Gateway balance. The payment adapter uses the agent smart-wallet address for direct USDC payments (`arc-testnet`, verified through ERC-1271) and Circle's backing EOA for Gateway authorization (`arc-testnet-nano`). `wallet.address` is the on-chain owner; `wallet.gatewayAddress` identifies the separate Gateway depositor, and `signPayment` selects the correct owner for the chosen offer. The operational smart-wallet address remains Wallet B for the action and stake; do not substitute the backing EOA into the action's `delegate` field. `walletFromArcAgent({address: process.env.ARC_AGENT_WALLET, chain: 'ARC-TESTNET'})` and `walletFor('arc')` provide the same payment path.

After the user reviews the action and the live x402 offer, save those exact approved objects locally as `approved-action.json` and `approved-payment.json`:

```typescript
import { readFile } from 'node:fs/promises';
import {
  createConfig, verifyProof, walletFor,
  type ProofParams, type ApprovedPayment,
} from '@zkproofport-ai/sdk';

const config = createConfig({baseUrl: 'https://stg-ai.zkproofport.app'});
const action: NonNullable<ProofParams['action']> = JSON.parse(await readFile('approved-action.json', 'utf8'));
const approvedPayment: ApprovedPayment = JSON.parse(await readFile('approved-payment.json', 'utf8'));
// generateWithHumanApproval is the bounded catch/poll/resume helper above.
const result = await generateWithHumanApproval(config, await walletFor('arc'), {
  circuit: 'arc_eligibility', scope: 'ledger-house', action,
  payOn: 'arc-testnet-nano', maxPayment: '0.001', approvedPayment,
});
const verification = await verifyProof(result);
if (!verification.valid) throw new Error('Arc verifier rejected the proof');
```

`approvedPayment` pins the selected live offer's `network`, `scheme`, `amount`, `asset`, `payTo`, and signing domain `extra: {name, version, verifyingContract}`. For direct `exact` EIP-3009 payments (Base, Ethereum and Arc), set the approved `extra.verifyingContract` to the offer's `asset`: the standard offer may omit `extra.verifyingContract` because the token is the signing contract. For Circle Gateway (`GatewayWalletBatched`, version `1`), copy the required `extra.verifyingContract` from the offer; never substitute the token address. Missing or conflicting domain information and unsupported transfer methods such as Permit2 are rejected. `amount` is an integer string in USDC base units (`"1000"` is 0.001 USDC); `maxPayment` is a decimal USDC string (`"0.001"`). A changed fee, recipient, asset, network or signing domain is rejected before payment signing. Approve the actual offer; do not manufacture its recipient or domain from a documentation example.

### Action object: caller-owned types, keys and values

Both `generateProof`/`generate_proof` and Arc input preparation use this complete `TypedAction` shape:

| Field | Type | Meaning |
|---|---|---|
| `domain` | object | EIP-712 signing context; all four fields below are required. |
| `domain.name` | non-empty string | Application/domain name agreed with the verifier. |
| `domain.version` | non-empty string | Signing-domain version. |
| `domain.chainId` | integer number | Target chain ID, such as `5042002`. |
| `domain.verifyingContract` | string | 20-byte `0x` contract address bound by the signature. |
| `types` | object | Map from caller-chosen struct names to arrays of field declarations. Omit `EIP712Domain`; ethers derives it from `domain`. |
| `types[structName]` | array of objects | Ordered fields; each declaration has `name` and `type`. Include referenced nested structs. |
| `types[structName][i].name` | string | Caller-chosen message key. |
| `types[structName][i].type` | string | EIP-712 type: `address`, `bool`, `string`, `bytes`, fixed `bytes1`–`bytes32`, integer types such as `uint256`, arrays such as `string[]`, or another declared struct. |
| `primaryType` | non-empty string | The declared top-level struct; it must equal the single root inferred by the encoder. |
| `message` | object | Values matching the declared field types, including nested objects and arrays. |

No SDK action registry restricts business-specific struct names, field names or values. For example, `Instruction` can contain `terms: Terms` and `labels: string[]`, where `Terms` contains `quantity: uint256` and `memo: string`. The circuit binds their hashes; each relying application decides which structures it can execute. Declare every approval-critical field in `types`; the approval API rejects extra unsigned message keys. Invalid shape, missing declared fields (including nested structs/arrays), non-boolean `bool` values, malformed field declarations/encoded values, ambiguous roots and a mismatched `primaryType` are rejected before human signing. The API also bounds request size, nesting, array length and declaration count.

Use decimal **integer strings** for JSON integer message values, especially `uint256` (for example `"10000000"`); JSON cannot represent `bigint`, and large JavaScript numbers can lose precision. Addresses/bytes are `0x` strings, booleans remain JSON booleans, and nested values follow their declared types. `domain.chainId` remains an integer JSON number.

### Full 10-USDC Ledger House Gate action

This valid JSON shows the Gate's exact five-field schema. The example delegate is a public placeholder for Wallet B: replace it with the approved operational smart-wallet address, choose a future approved Unix-seconds deadline and a fresh nonce, then review the whole object. Never include the private credential-holder A's address or key in it.

```json
{
  "domain": {
    "name": "Ledger House Staking",
    "version": "1",
    "chainId": 5042002,
    "verifyingContract": "0xD0F3eE648386B59B484157332E736388Fcc41F47"
  },
  "types": {
    "CredentialDelegation": [
      { "name": "delegate", "type": "address" },
      { "name": "action", "type": "string" },
      { "name": "amount", "type": "uint256" },
      { "name": "expiresAt", "type": "uint256" },
      { "name": "nonce", "type": "string" }
    ]
  },
  "primaryType": "CredentialDelegation",
  "message": {
    "delegate": "0x0000000000000000000000000000000000000001",
    "action": "stake",
    "amount": "10000000",
    "expiresAt": "2000000000",
    "nonce": "replace-with-fresh-user-approved-nonce"
  }
}
```

`"10000000"` means **10 USDC** (6 decimals). The proof fee is separate: **0.001 USDC**, or `"1000"` base units. `delegate` and `CredentialDelegation` are established wire names for exact-action authorization: A authorizes this operation by B; B does not inherit A's identity or KYC credential. User approval covers the exact action and live proof-payment terms, followed by separate approval of the actual stake transaction.

The exported SDK `buildDelegationAction` helper is a legacy generic four-field schema (`delegate`, `action`, `expiresAt`, `nonce`). It **does not include `amount` and is not compatible with this staking Gate**. Its existing wire hash remains unchanged. Build the explicit five-field `TypedAction` above for the Gate; arbitrary custom actions remain valid SDK inputs but require a verifier that understands them.


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

For Arc/GIWA actions, obtain human approval before preparing inputs. `prepareInputs` needs the camelCase hashes to recover A's public key from the approved EIP-712 digest; it does not add those hashes to its returned object. Attach the snake_case fields for submission. `signal_hash` is still computed internally for nullifier derivation and is not the action signing message. Low-level witness APIs accept signatures but cannot establish who operated the signing wallet.

Prepared inputs are **private witness data**: they include A's public key, signature and attestation data. Keep them inside trusted local code and send them only to the chosen prover (encrypted when a supported TEE key is provided). Do not forward them to the dApp, model, UI or logs. The `generateProof` public result is the boundary for sharing a proof; step callbacks and `proofport://config` can contain sensitive signer data and must not be forwarded wholesale.

```typescript
import { readFile } from 'node:fs/promises';
import {
  createConfig, createActionApproval, resolveActionApproval, hashTypedAction, prepareInputs,
  requestChallenge, signPayment, submitProof, submitEncryptedProof,
  encryptForTee, walletFor, CIRCUIT_IDS,
  type TypedAction, type ApprovedPayment,
} from '@zkproofport-ai/sdk';

const config = createConfig({ baseUrl: 'https://stg-ai.zkproofport.app' });
const action: TypedAction = JSON.parse(await readFile('approved-action.json', 'utf8'));
const approvedPayment: ApprovedPayment = JSON.parse(await readFile('approved-payment.json', 'utf8'));
const scope = 'ledger-house';

// 1. Create an immutable request, then let the person connect and sign.
const { domainSeparator, actionHash } = hashTypedAction(action);
const request = { circuit: 'arc_eligibility' as const, scope, action };
const approval = await createActionApproval(config, request);
console.error('Review and sign:', approval.approvalUrl);
await waitForHumanApproval(config, approval); // bounded helper from the example above
const approved = await resolveActionApproval(config, request, approval);

// 2. The signature has been verified and consumed. Build the private witness.
const prepared = await prepareInputs(config, {
  circuitId: CIRCUIT_IDS.ARC_ELIGIBILITY,
  userAddress: approved.address, userSignature: approved.signature, scope,
  domainSeparator, actionHash,
});
const inputs = { ...prepared, domain_separator: domainSeparator, action_hash: actionHash };

// 3. Fetch a fresh nonce/offer/TEE key without sending the witness yet.
const challenge = await requestChallenge(config, 'arc_eligibility');
const paymentHeaders = challenge.requiresPayment
  ? (await signPayment(challenge, await walletFor('arc'), {
      network: 'arc-testnet-nano', maxPayment: '0.001', approvedPayment,
    })).headers
  : undefined;

// 4. Submit with the same nonce and approved payment; preserve TEE encryption.
const result = challenge.teePublicKey
  ? await submitEncryptedProof(config, {
      circuit: 'arc_eligibility', nonce: challenge.nonce, paymentHeaders,
      encryptedPayload: encryptForTee(
        JSON.stringify({ circuitId: CIRCUIT_IDS.ARC_ELIGIBILITY, inputs }),
        challenge.teePublicKey.publicKey,
      ),
    })
  : await submitProof(config, {
      circuit: 'arc_eligibility', inputs, nonce: challenge.nonce, paymentHeaders,
    });
// Share only the public result, verify it, then separately approve the stake.
```

`hashTypedAction(action)` returns `{domainSeparator: string, actionHash: string}` as 32-byte `0x` hashes. For Coinbase KYC/country, sign `computeSignalHash(address, scope, circuitId)` with `signMessage`, call `prepareInputs` without action hashes, then use the same challenge/payment/submission sequence. OIDC uses `prepareOidcPayload` and no attestation-wallet signature. The all-in-one `generateProof` already handles these distinctions.

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
type CircuitName = 'coinbase_kyc' | 'coinbase_country' | 'oidc_domain' | 'arc_eligibility' | 'giwa_attestation';
type CircuitId = 'coinbase_attestation' | 'coinbase_country_attestation' | 'oidc_domain_attestation' | 'arc_eligibility' | 'giwa_attestation';
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
  action?: { domain: { name: string; version: string; chainId: number; verifyingContract: string }; types: Record<string, Array<{name: string; type: string}>>; primaryType: string; message: Record<string, unknown> }; // optional for arc_eligibility and giwa_attestation
  actionApproval?: ActionApproval; // private handle; resume the original action after human approval
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


### Testing the published packages

From the `proofport-ai` repository root, use the isolated registry runner:

```bash
E2E_BASE_URL=https://stg-ai.zkproofport.app \
E2E_PAYMENT_NETWORK=base-sepolia \
npm run test:e2e:published -- --sdk-version 0.2.16 --mcp-version 0.2.16
```

It installs those exact npm versions outside the workspace, resolves SDK imports
and the MCP process to that installation, and removes it afterwards. The runner
also installs and verifies Circle CLI 1.1.4, automatically putting it on the test
subprocess PATH without changing the global installation. Optional CDP/x402 and
Circle developer wallet dependencies are installed at tested exact versions,
and their imports are verified before paid tests start. A normal
workspace test run exercises local packages and is not published-package evidence.
The full suite creates paid testnet proofs. It requires the attestation and payer
credentials loaded by `tests/setup.ts`; GIWA uses `GIWA_ATTESTATION_KEY`, and OIDC
uses `E2E_OIDC_JWT` or an authenticated gcloud account. The payment matrix checks
Base Sepolia, Arc immediate settlement, Ethereum Sepolia, and Arc Gateway nano
separately, so each needs a funded payer on its selected network. Optional
`E2E_PAYER_KEY_<NETWORK>` overrides use uppercase names with underscores, for
example `E2E_PAYER_KEY_ETHEREUM_SEPOLIA`. `E2E_ARC_AGENT_ADDRESS` selects an
existing Circle Agent Wallet for both Arc cases; the supported Circle CLI,
on-chain USDC for immediate settlement, and Gateway USDC for nano are required. The runner never deposits or transfers funds.

For a non-paying package/discovery check, append
`-t 'should list all 5 circuits'`. This checks discovery only, not proof generation.
