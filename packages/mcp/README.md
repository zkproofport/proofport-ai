# @zkproofport-ai/mcp

Local MCP server and CLI for ZKProofport zero-knowledge proof generation. The package exposes actual `generate_proof` and `verify_proof` tools over stdio, backed by `@zkproofport-ai/sdk`.

## Install from npm

```bash
npm install -g @zkproofport-ai/mcp@latest
# Or install in an external application:
npm install @zkproofport-ai/mcp@latest @zkproofport-ai/sdk@latest ethers
```

The shared hashing helper and corrected Arc `prepare_inputs` behavior require SDK/MCP **0.2.12 or later**. Install from npm and check the resolved version. Release Please manages package versions and the release workflow publishes them; repository source changes alone do not update `@latest`.

For an MCP client, use the installed `zkproofport-mcp` executable or:

```json
{
  "mcpServers": {
    "zkproofport": {
      "command": "npx",
      "args": ["-y", "@zkproofport-ai/mcp@latest"]
    }
  }
}
```

Supply required environment variables through a trusted local process or secret store. A’s `ATTESTATION_KEY` belongs only in that local client environment; keep A’s key and address out of the dApp service, model, UI, logs, Git and npm packages. Do not paste private keys, login credentials or JWTs into model prompts, expose them in logs, or commit them in MCP configuration.

## Security and proving architecture

ZKProofport has a TEE-based proving architecture. Enclave encryption is conditional: when the selected endpoint supplies a supported attested TEE public key, the SDK encrypts circuit inputs with X25519 ECDH + AES-256-GCM and the host relays ciphertext. Nitro mode rejects plaintext inputs.

An endpoint without that key receives readable circuit inputs over HTTPS and provides no hardware-attestation guarantee. The current Arc staging demo uses that mode. A valid public proof and an enclave hardware attestation are separate evidence; only claim attested execution when the returned attestation has been validated. Private signing keys stay in the local signer or wallet provider, while the relying dApp receives the public proof rather than the credential-holder address.

Proof generation is paid when the endpoint's live x402 challenge requires payment. Do not assume every endpoint is free, or that every wallet supports every advertised chain or signing domain.

## Prerequisites

- Coinbase circuits, including experimental `arc_eligibility`, require a valid Coinbase KYC EAS attestation on Base and its local credential signer (`ATTESTATION_KEY`).
- Experimental `giwa_attestation` requires an attestation from GIWA's attester on **GIWA Sepolia**, not from Coinbase. `ATTESTATION_KEY` must be the wallet attested there; one wallet is rarely attested on both chains.
- OIDC proofs require an `id_token`; the CLI offers `--login-google`, `--login-google-workspace`, and `--login-microsoft-365` device login. Complete login locally.
- A paid endpoint requires an explicitly selected compatible payment wallet and the user's approval of the payment terms.
- Circle Agent Wallet payments require Circle CLI, its existing login, and the chosen wallet. Preserve that login and wallet; proof generation must not create, import, replace or switch them.

## Action-bound circuits — EXPERIMENTAL, testnet only

`arc_eligibility` and `giwa_attestation` each prove an attestation **and, when
you supply one, exact-action authorization** in the same proof: the credential
holder signs the exact EIP-712 action, so the person reads named fields instead
of an opaque hash and the verifying contract recomputes what they approved.

**The action is optional on both.** Send none and the wallet signs the
request's signal hash, exactly as `coinbase_kyc` does. The circuits branch on
this and refuse a request carrying both. Until 2026-09-22 `arc_eligibility`
required one and `giwa_attestation` could not take one at all.

They differ in what attests the wallet and where the verifier lives:

| Circuit | Attested by | Chain | Verifier |
|---|---|---|---|
| `arc_eligibility` | Coinbase KYC on Base | Arc Testnet, 5042002 | `0x2aEB66292f631ceb6225ffA2439B1f2b4b15e44a` |
| `giwa_attestation` | GIWA's attester on GIWA Sepolia | GIWA Sepolia, 91342 | `0x5Da234546874304F8c51BBEed00fC632938211c1` |

No mainnet support is implied for either.

| Contract | Arc Testnet address |
|---|---|
| Ledger House EligibilityGate | `0xD0F3eE648386B59B484157332E736388Fcc41F47` |

The layout and deployments may change. Discover the dApp's policy, prover endpoint and live payment offer before preparing an action. ERC-8004 identifies the prover; it grants no wallet spending permission.

### Existing Circle Agent Wallet and Gateway balance

```bash
# If Circle CLI is not installed:
npm install -g @circle-fin/cli

# Inspect the existing wallet and balance; do not create another wallet.
circle wallet list --chain ARC-TESTNET --type agent
circle gateway balance --address "$ARC_AGENT_WALLET" --chain ARC-TESTNET --output json

# Only after the user approves this funding amount:
circle gateway deposit --amount 0.1 --address "$ARC_AGENT_WALLET" --chain ARC-TESTNET --method direct
```

Set `ARC_AGENT_WALLET` to the existing, approved operational wallet address. `ARC_CLI_CHAIN` defaults to `ARC-TESTNET`. The `direct` Gateway deposit is an on-chain transaction requiring gas. Each subsequent nanopayment draws from the funded Gateway balance; a wallet USDC balance alone does not establish that a proof can be paid for.

**Tool limitation:** this package's `gateway_balance` and `deposit_to_gateway` tools currently require `PAYMENT_PRIVATE_KEY`. They do not accept `pay_with: "arc"` and do not operate the Circle Agent Wallet. Use Circle CLI directly for that wallet's balance and deposit. Do not import a key or create a substitute wallet to work around this boundary.

### Exact-action authorization and paid proof

Call `generate_proof` only after the user approves the exact action and live payment offer. Tool arguments use snake_case; the SDK equivalents are `payOn`, `maxPayment` and `approvedPayment`.

```typescript
const proof = await mcp.callTool({
  name: 'generate_proof',
  arguments: {
    circuit: 'arc_eligibility',
    scope: 'ledger-house',
    action: approvedAction,
    pay_with: 'arc',
    pay_on: 'arc-testnet-nano',
    max_payment: '0.001',
    approved_payment: approvedPayment,
  },
});
```

Here `approvedAction` and `approvedPayment` are the actual user-reviewed objects, not placeholders to synthesize from a guide. `pay_with: "arc"` calls `walletFor('arc')` / `walletFromArcAgent`, using Circle CLI's existing login. `pay_with: "circle"` is a different adapter for Circle developer-controlled wallets.

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

No SDK action registry restricts struct names, field names or business values. For example, `Instruction` can contain `terms: Terms` and `labels: string[]`, where `Terms` contains `quantity: uint256` and `memo: string`. The circuit binds their hashes; each relying application decides which structures it can execute. Declare every approval-critical field in `types`: extra message keys absent from the schema are not signed. Invalid shape, missing declared fields (including nested structs/arrays), non-boolean `bool` values, malformed field declarations/encoded values, ambiguous roots and a mismatched `primaryType` are rejected before local signing. Field names and type declarations must be non-empty strings.

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

Circle's backing EOA is used internally for Gateway payment signatures; the action's `delegate` remains the operational smart-wallet address.

`approvedPayment` pins these fields from the selected live x402 offer:

```typescript
interface ApprovedPayment {
  network: string;
  scheme: string;
  amount: string; // USDC base units: "1000" = 0.001 USDC
  asset: string;
  payTo: string;
  extra: { name: string; version: string; verifyingContract: string };
}
```

`max_payment` is decimal USDC, so `"0.001"` caps the proof fee at 0.001 USDC. The SDK rejects changes to fee, recipient, asset, network or Gateway signing domain before signing the actual challenge. A new nonce is not pinned as a payment term. If the service offers no compatible Arc nanopayment option, stop instead of falling back to another chain.

After proof generation, use `verify_proof`. Separately obtain approval for the staking transaction; the operational wallet then submits to EligibilityGate, which checks the proof, credential policy, exact actor/action, nonce and deadline atomically. Report success only after the actual receipt and position change are confirmed.

### Stepwise Arc flow in trusted local code

The corrected `prepare_inputs` path validates the complete action and encodes its values before asking local A to sign EIP-712. It passes both hashes into SDK key recovery and returns `domain_separator` and `action_hash` with the prepared witness. Missing or malformed Arc actions and actions supplied for Coinbase/OIDC are rejected before signing. Coinbase continues to sign `signal_hash`; OIDC uses the JWT path without wallet signing.

**Prepared inputs are private witness data**, including A's public key, signature and attestation data. Run this orchestration inside a trusted local MCP client; do not pass tool responses through model context, the dApp, UI or logs. Share the public `generate_proof` result instead. `proofport://config` also exposes A's address and stays local.

1. Obtain the action approval locally, then call `prepare_inputs` with `{circuit: "arc_eligibility", scope: "ledger-house", action: approvedAction}`. Preserve the entire result, including both snake_case hashes.
2. Call `request_challenge` with `{circuit: "arc_eligibility", inputs: {}}` to obtain a fresh nonce, actual payment offers and optional TEE key without sending the witness yet.
3. For an endpoint with payment disabled and no TEE key, call `submit_proof` with `{circuit: "arc_eligibility", inputs: preparedInputs, nonce: challenge.nonce}`. The nonce is required; omitting it only requests another challenge.
4. Verify the returned public proof with `verify_proof`, then obtain the separate stake approval and confirm the transaction receipt.

The MCP `submit_proof` tool currently accepts only `circuit`, `inputs` and `nonce`; it has no payment-header or encrypted-envelope argument. For a paid or encrypted flow, use all-in-one `generate_proof`, or the SDK stepwise API (`hashTypedAction` → local typed signature → `prepareInputs` with camelCase hashes → attach snake_case hashes → `requestChallenge` → `signPayment` with approved terms → `submitProof`/`submitEncryptedProof`). Do not assume this MCP stepwise tool automatically pays or encrypts. With Circle Agent Wallet, the SDK's `signPayment` uses `@circle-fin/x402-batching` for the live Gateway batched offer and signs through the Circle CLI adapter; it draws the 0.001-USDC proof fee from the existing funded Gateway balance.

### CLI path

```bash
export PROOFPORT_URL=https://stg-ai.zkproofport.app
# approved-action.json contains the exact approved EIP-712 object.
zkproofport-prove arc_eligibility --scope ledger-house \
  --action approved-action.json --pay-with arc --pay-on arc-testnet-nano --max-payment 0.001
```

The CLI loads `--action` from a JSON file and calls the local MCP server internally. The CLI `--max-payment` flag forwards the decimal fee cap as `max_payment`. For exact `approved_payment` offer pinning as well, use the MCP `generate_proof` call above or the SDK API; no `--approved-payment` CLI flag is documented. No local repository checkout is required once a compatible npm release is installed.

## Tools

| Tool | Purpose / boundary |
|---|---|
| `generate_proof` | Prepare inputs, select an approved payment path and generate a proof. Returns proof, public inputs, timing and verifier metadata; attestation is conditional. |
| `verify_proof` | Verify the actual proof on-chain; accepts `{result: <full proof result>}`. |
| `get_supported_circuits` | Discover circuits and verifier metadata. |
| `prepare_inputs` | Prepare circuit inputs with the configured credential signer. |
| `request_challenge` | Fetch a live challenge, payment offers and optional TEE key. |
| `submit_proof` | Submit prepared inputs and nonce; no payment headers or encrypted-envelope argument. |
| `gateway_balance` | Read Gateway balance using `PAYMENT_PRIVATE_KEY` only; returns USDC base units. |
| `deposit_to_gateway` | Fund Gateway using `PAYMENT_PRIVATE_KEY` only; on-chain and paid. |

### `generate_proof` parameters

| Parameter | Type | Requirement |
|---|---|---|
| `circuit` | string | `coinbase_kyc`, `coinbase_country`, `oidc_domain`, or experimental `arc_eligibility` / `giwa_attestation` |
| `scope` | string | Optional; default `proofport` |
| `action` | EIP-712 object | Optional for `arc_eligibility` and `giwa_attestation`; rejected for circuits that cannot prove one, rather than dropped |
| `pay_with` | `key` / `cdp` / `circle` / `arc` | Select the payment wallet explicitly; use `arc` for Circle Agent Wallet |
| `pay_on` | string | Select an actual offered route; `arc-testnet-nano` is the Arc Gateway path |
| `max_payment` | string | Maximum decimal USDC proof fee |
| `approved_payment` | object | Exact accepted offer fields shown above |
| `country_list` | string[] | Required for `coinbase_country` |
| `is_included` | boolean | Required for `coinbase_country` |
| `jwt` | string | Required for `oidc_domain`; provide securely outside model-visible prompts |
| `provider` | `google` / `microsoft` | OIDC provider; default `google` |

## Environment

| Variable | Purpose |
|---|---|
| `PROOFPORT_URL` | Selected prover endpoint; Arc staging uses `https://stg-ai.zkproofport.app` |
| `ATTESTATION_KEY` | Local credential-holder key for Coinbase circuits; keep secret |
| `ARC_AGENT_WALLET` | Existing Circle Agent Wallet address to use |
| `ARC_CLI_CHAIN` | Circle CLI chain; Arc testnet is `ARC-TESTNET` |
| `PAYMENT_PRIVATE_KEY` | Private-key payer and private-key-only Gateway tools |
| `CDP_API_KEY_ID`, `CDP_API_KEY_SECRET`, `CDP_WALLET_SECRET` | CDP adapter credentials |
| `CIRCLE_API_KEY`, `CIRCLE_ENTITY_SECRET`, `CIRCLE_WALLET_ID` | Developer-controlled Circle adapter credentials; not the Agent Wallet login |

`proofport://config` exposes configuration, including wallet addresses, so do not forward it wholesale into public logs or presentations.

## Other circuits and CLI options

```bash
zkproofport-prove coinbase_kyc --scope my-app
zkproofport-prove coinbase_country --countries US,KR --included true
zkproofport-prove --login-google-workspace --scope my-app
zkproofport-prove --login-microsoft-365 --scope my-app
```

Use `--silent` for raw result JSON. Paid endpoints still require a compatible approved payer. `--login-*` and `--jwt` are mutually exclusive. Proof generation time depends on the endpoint; elapsed time alone proves neither success nor enclave execution.

## Related

- [SDK README](../sdk/README.md) — programmatic payment, action and verification APIs
- [Project README](../../README.md) — service architecture and experimental Arc contracts
- [ZKProofport](https://zkproofport.app)

## License

MIT
