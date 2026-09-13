# @zkproofport-ai/mcp

Local MCP server and CLI for ZKProofport zero-knowledge proof generation. The package exposes actual `generate_proof` and `verify_proof` tools over stdio, backed by `@zkproofport-ai/sdk`.

## Install from npm

```bash
npm install -g @zkproofport-ai/mcp@latest
# Or install in an external application:
npm install @zkproofport-ai/mcp@latest @zkproofport-ai/sdk@latest ethers
```

Arc support described here requires SDK/MCP **0.2.11 or later**. Install from npm and check the resolved version. Release Please manages package versions and the release workflow publishes them; repository source changes alone do not update `@latest`.

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

Supply required environment variables through a trusted local process or secret store. Do not paste private keys, login credentials or JWTs into model prompts, expose them in logs, or commit them in MCP configuration.

## Security and proving architecture

ZKProofport has a TEE-based proving architecture. Enclave encryption is conditional: when the selected endpoint supplies a supported attested TEE public key, the SDK encrypts circuit inputs with X25519 ECDH + AES-256-GCM and the host relays ciphertext. Nitro mode rejects plaintext inputs.

An endpoint without that key receives readable circuit inputs over HTTPS and provides no hardware-attestation guarantee. The current Arc staging demo uses that mode. A valid public proof and an enclave hardware attestation are separate evidence; only claim attested execution when the returned attestation has been validated. Private signing keys stay in the local signer or wallet provider, while the relying dApp receives the public proof rather than the credential-holder address.

Proof generation is paid when the endpoint's live x402 challenge requires payment. Do not assume every endpoint is free, or that every wallet supports every advertised chain or signing domain.

## Prerequisites

- Coinbase circuits, including experimental `arc_eligibility`, require a valid Coinbase KYC EAS attestation on Base and its local credential signer (`ATTESTATION_KEY`).
- OIDC proofs require an `id_token`; the CLI offers `--login-google`, `--login-google-workspace`, and `--login-microsoft-365` device login. Complete login locally.
- A paid endpoint requires an explicitly selected compatible payment wallet and the user's approval of the payment terms.
- Circle Agent Wallet payments require Circle CLI, its existing login, and the chosen wallet. Preserve that login and wallet; proof generation must not create, import, replace or switch them.

## Arc Testnet — EXPERIMENTAL

`arc_eligibility` proves Coinbase KYC **and exact-action authorization** in one proof. The credential holder signs the exact EIP-712 action authorizing an operational wallet. It is experimental on **Arc Testnet, chain 5042002**, with no mainnet support implied.

| Contract | Arc Testnet address |
|---|---|
| Eligibility verifier | `0xCbC8E63fF92659E8B44cFF117D33005Bb669a018` |
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

For Ledger House, `approvedAction` contains:

- `domain`: `{name: "Ledger House Staking", version: "1", chainId: 5042002, verifyingContract: "0xD0F3eE648386B59B484157332E736388Fcc41F47"}`.
- `types.CredentialDelegation`: `delegate: address`, `action: string`, `amount: uint256`, `expiresAt: uint256`, and `nonce: string`, in that order.
- `primaryType`: `"CredentialDelegation"`.
- `message`: the approved operational wallet in `delegate`, `action: "stake"`, `amount: "100000"` for 0.1 USDC, and the approved Unix-seconds deadline and fresh nonce.

The user-facing term is **exact-action authorization**. Existing `CredentialDelegation`, `delegate`, and other wire names stay unchanged. Circle's backing EOA is used internally for Gateway payment signatures; the action's `delegate` remains the operational smart-wallet address.

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
| `submit_proof` | Submit prepared inputs with the challenge/payment data required by the endpoint. |
| `gateway_balance` | Read Gateway balance using `PAYMENT_PRIVATE_KEY` only; returns USDC base units. |
| `deposit_to_gateway` | Fund Gateway using `PAYMENT_PRIVATE_KEY` only; on-chain and paid. |

### `generate_proof` parameters

| Parameter | Type | Requirement |
|---|---|---|
| `circuit` | string | `coinbase_kyc`, `coinbase_country`, `oidc_domain`, or experimental `arc_eligibility` |
| `scope` | string | Optional; default `proofport` |
| `action` | EIP-712 object | Required for `arc_eligibility`, rejected for other circuits |
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
