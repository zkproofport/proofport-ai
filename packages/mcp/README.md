# @zkproofport-ai/mcp

Local MCP server and CLI for ZKProofport zero-knowledge proof generation. The package exposes actual `generate_proof` and `verify_proof` tools over stdio, backed by `@zkproofport-ai/sdk`.

## Install from npm

```bash
npm install -g @zkproofport-ai/mcp@latest
# Or install in an external application:
npm install @zkproofport-ai/mcp@latest @zkproofport-ai/sdk@latest ethers
```

The shared hashing helper requires SDK/MCP **0.2.12 or later**. Optional actions for both Arc and GIWA in the step-by-step `prepare_inputs` tool require **MCP 0.2.15 or later**, with **SDK 0.2.14 or later**. MCP 0.2.14 supports these modes through `generate_proof`, but its `prepare_inputs` still rejects GIWA actions and fails for Arc without an action. Install from npm and check the resolved version. Release Please manages package versions and the release workflow publishes them; repository source changes alone do not update `@latest`.

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

- Coinbase circuits, require a valid Coinbase KYC EAS attestation on Base and its local credential signer (`ATTESTATION_KEY`). Arc without an action also uses that key; Arc with an action uses the human wallet approval below.
- Experimental `giwa_attestation` requires an attestation from GIWA's attester on **GIWA Sepolia**, not from Coinbase. Without an action, `ATTESTATION_KEY` must be the wallet attested there. With an action, the human connects that attested wallet on the approval page; the CLI does not need its key. One wallet is rarely attested on both chains.
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

### Human approval for actions

Human action approval requires MCP **0.3.0 or later**, its compatible SDK **0.3.0 or later**, and an AI service with the approval API enabled. Upgrade the CLI/MCP package to use this flow.

When `action` is present, `generate_proof` returns `awaiting_approval`, an `approval_url`, `approval_id`, and `expires_at`. Show the URL to the person. They review the request's circuit, scope, exact EIP-712 domain, type and message fields, connect their credential wallet, and explicitly sign. Browser extensions and WalletConnect-compatible EVM wallets are supported; WalletConnect requires server configuration. It is a ZKProofport approval-page URL, not a MetaMask-specific address.

The AI queries `get_action_approval` with the ID. Once approved, repeat the original `generate_proof` call with exactly the same arguments plus `approval_id`. Changed action, circuit, scope or payment terms are rejected. The requester secret is stored in owner-only local files and never returned in the MCP result. `ATTESTATION_KEY` never signs this action. Ordinary no-action proofs and the proof-payment wallet continue to use their existing behavior.

Approval expires after ten minutes and can be consumed once. Rejection, expiry or an already-consumed request stops the flow. A network error after consumption must be investigated before retrying; the client does not create a replacement authorization or repeat payment automatically. The current proof circuits recover an EOA signature; smart-contract credential wallets are not supported by this flow. The relying dApp must enforce its own action nonce and deadline; the approval page's expiry does not add a deadline to the signed message.

The CLI prints the URL to stderr, waits for approval, and resumes automatically. This prompt is also printed in `--silent` mode; stdout remains the final proof JSON. Ctrl+C stops waiting and closes the MCP process.

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

With `pay_with: "arc"`, `pay_on: "arc-testnet"` pays directly from the agent smart wallet (ERC-1271), while `pay_on: "arc-testnet-nano"` uses its backing EOA and Gateway deposit. The SDK selects the authorization owner from the chosen offer; the action's `delegate` remains the operational smart-wallet address.

`approvedPayment` pins these fields from the selected live x402 offer and its actual signing domain:

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

For direct `exact` EIP-3009 payments on Base, Ethereum or Arc, set approved `extra.verifyingContract` to the offer's `asset` (the USDC token); a standard direct offer does not need an `extra.verifyingContract` field. For Circle Gateway (`GatewayWalletBatched`, version `1`), use the offer's required `extra.verifyingContract`, not `asset`. Missing or conflicting domain information and unsupported transfer methods such as Permit2 are rejected before signing.

`max_payment` is decimal USDC, so `"0.001"` caps the proof fee at 0.001 USDC. The SDK rejects changes to fee, recipient, asset, network or signing domain before signing the actual challenge. A new nonce is not pinned as a payment term. If the service offers no compatible Arc nanopayment option, stop instead of falling back to another chain.

After proof generation, use `verify_proof`. Separately obtain approval for the staking transaction; the operational wallet then submits to EligibilityGate, which checks the proof, credential policy, exact actor/action, nonce and deadline atomically. Report success only after the actual receipt and position change are confirmed.

### Stepwise Arc flow in trusted local code

`prepare_inputs` with an action follows the same human-approval pause and resume. After approval, it returns `prepared_inputs_id`, `circuit`, `domain_separator` and `action_hash`. The raw signature and witness stay in owner-only local storage. The handle expires after ten minutes and can be submitted once.

1. Call `prepare_inputs` with the action, share the returned approval URL, and wait using `get_action_approval`.
2. Repeat `prepare_inputs` with unchanged arguments and `approval_id`.
3. Call `request_challenge` with the same circuit and `inputs: {}`.
4. For a free, non-encrypted endpoint, call `submit_proof` with the circuit, returned `prepared_inputs_id` and challenge `nonce`.
5. Verify the public result using `verify_proof`.

Without an action, the existing credential-key / OIDC path and raw private-witness result remain unchanged. Handle such witnesses only in trusted local code, never model context, dApp UI or logs. `proofport://config` also exposes the local credential address and must stay private.

`submit_proof` accepts either `inputs` or `prepared_inputs_id`, never both. It does not sign proof payments or encrypt inputs. For paid or encrypted flows use `generate_proof`, or the SDK's full flow. Human action approval and approval of the proof-payment terms are separate.

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
| `prepare_inputs` | Prepare ordinary inputs, or request human approval and return a private action witness handle. |
| `get_action_approval` | Read approval status without starting a proof or payment. |
| `request_challenge` | Fetch a live challenge, payment offers and optional TEE key. |
| `submit_proof` | Submit prepared inputs and nonce; no payment headers or encrypted-envelope argument. |
| `gateway_balance` | Read Gateway balance using `PAYMENT_PRIVATE_KEY` only; returns USDC base units. |
| `deposit_to_gateway` | Fund Gateway using `PAYMENT_PRIVATE_KEY` only; on-chain and paid. |

### `generate_proof` parameters

| Parameter | Type | Requirement |
|---|---|---|
| `circuit` | string | `coinbase_kyc`, `coinbase_country`, `oidc_domain`, or experimental `arc_eligibility` / `giwa_attestation` |
| `scope` | string | Optional; default `proofport` |
| `approval_id` | string | Resume an approved request with all original arguments unchanged |
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
| `ATTESTATION_KEY` | Local credential key for no-action EAS proofs; not needed for human-approved actions |
| `ZKPROOFPORT_APPROVAL_DIR` | Private local continuation storage; defaults to `~/.config/zkproofport/approvals` (directory 0700, files 0600) |
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
