# @zkproofport-ai/mcp

Local MCP server for zero-knowledge proof generation via ZKProofport.

## Overview

`@zkproofport-ai/mcp` is a [Model Context Protocol](https://modelcontextprotocol.io/) server that runs locally and gives AI agents (Claude, Cursor, Windsurf, etc.) the ability to generate privacy-preserving zero-knowledge proofs.

**How it works:**

```
AI Agent ←→ Local MCP Server ──[E2E encrypted]──→ ZKProofport Server ──→ Nitro Enclave
              (your machine)                        (blind relay)         (decrypts & proves)
```

- Your private key **never leaves your machine** — only cryptographic signatures are sent to the server
- **All proof inputs are E2E encrypted** — X25519 ECDH + AES-256-GCM encryption ensures the server cannot read your inputs (blind relay)
- Proofs are generated inside AWS Nitro Enclaves (trusted execution environment) with cryptographic attestation
- Payment is gasless — you sign an EIP-3009 authorization, the x402 facilitator pays gas

## E2E Encryption (Blind Relay)

All proof inputs are **end-to-end encrypted** before leaving your machine. The ZKProofport server acts as a **blind relay** — it forwards encrypted data to the TEE (AWS Nitro Enclave) without being able to read it.

**Encryption is fully automatic:**
- `generate_proof` tool auto-detects TEE availability from the server's 402 response
- When TEE is available, inputs are encrypted with the enclave's attested X25519 public key (verified via AWS Nitro COSE Sign1 attestation)
- The encryption uses X25519 ECDH key agreement + AES-256-GCM (ECIES pattern)
- In production, the server **rejects plaintext inputs** (`PLAINTEXT_REJECTED`) — E2E encryption is enforced

No configuration needed. The MCP server handles encryption transparently.

## Prerequisites

**For Coinbase circuits (`coinbase_kyc`, `coinbase_country`):**

1. **Coinbase account with KYC verification** — Complete identity verification on [Coinbase](https://www.coinbase.com/)
2. **Coinbase KYC EAS attestation on Base** — Obtain an on-chain attestation via [Coinbase Verifications](https://www.coinbase.com/onchain-verify). This creates an EAS attestation on Base linked to your wallet address.
3. **USDC balance on Base** — At least $0.10 per proof. Payment is gasless (EIP-3009 signature, facilitator pays gas).
4. **Attestation wallet private key** (required) — The private key of the wallet that holds the EAS attestation. Set as `ATTESTATION_KEY` environment variable.

**For OIDC circuits (`oidc_domain`):**

1. **OIDC identity provider account** — Any OIDC-compatible provider (e.g., Google account). No Coinbase account or on-chain attestation needed.
2. **JWT id_token** — Obtain an `id_token` from your OIDC provider's authorization flow. Pass it as the `jwt` parameter.
3. **USDC balance on Base** — At least $0.10 per proof. Payment is gasless (EIP-3009 signature, facilitator pays gas).
4. **Payment wallet private key** (required) — The private key of the wallet with USDC balance. Set as `PAYMENT_KEY` (or `ATTESTATION_KEY` as fallback).

**Payment wallet options (all circuits):**

Choose how to supply the USDC payment wallet:

- **Same as attestation wallet** — No additional setup. The attestation wallet must hold USDC.
  > ⚠️ **Privacy risk:** Using the attestation wallet for payment exposes your KYC-verified wallet address on-chain in the payment transaction, linking your identity to on-chain activity. Use a separate payment wallet for privacy.
- **Separate private key** — Set `PAYMENT_KEY` environment variable with a different wallet's private key.
- **CDP MPC wallet** — Coinbase Developer Platform managed wallet. Private keys never leave Coinbase's TEE. Get credentials at [CDP Portal](https://portal.cdp.coinbase.com).

  | Credential | Env Variable | Required | Description |
  |------------|-------------|----------|-------------|
  | API Key ID | `CDP_API_KEY_ID` | Yes | CDP API key ID |
  | API Key Secret | `CDP_API_KEY_SECRET` | Yes | CDP API key secret |
  | Wallet Secret | `CDP_WALLET_SECRET` | Yes | CDP wallet encryption secret |
  | Wallet Address | `CDP_WALLET_ADDRESS` | No | Existing wallet address (creates new if omitted) |

## Quick Start

### CLI (Recommended)

The simplest way to generate a proof — one command from a terminal or any AI agent's shell. No MCP configuration needed.

> **For AI agents:** Install with `npm install -g @zkproofport-ai/mcp`, then run `zkproofport-prove` from anywhere. Ask the user for `ATTESTATION_KEY` and `PAYMENT_KEY` environment variables if not already set. No MCP configuration needed.

#### Step 1: Install

```bash
npm install -g @zkproofport-ai/mcp
```

#### Step 2: Set environment variables

Choose one of the three payment options:

**Option A: Separate payment wallet (Recommended)**

```bash
export ATTESTATION_KEY=0x_YOUR_ATTESTATION_WALLET_PRIVATE_KEY
export PAYMENT_KEY=0x_YOUR_PAYMENT_WALLET_PRIVATE_KEY
```

**Option B: CDP MPC wallet**

Uses a [Coinbase Developer Platform](https://portal.cdp.coinbase.com) managed wallet for payment. Private keys never leave Coinbase's TEE infrastructure.

```bash
export ATTESTATION_KEY=0x_YOUR_ATTESTATION_WALLET_PRIVATE_KEY
export CDP_API_KEY_ID=your-cdp-api-key-id
export CDP_API_KEY_SECRET=your-cdp-api-key-secret
export CDP_WALLET_SECRET=your-cdp-wallet-secret
export CDP_WALLET_ADDRESS=0x_YOUR_CDP_WALLET_ADDRESS  # optional, creates new if omitted
```

**Option C: Same wallet (NOT recommended — privacy risk)**

```bash
export ATTESTATION_KEY=0x_YOUR_ATTESTATION_WALLET_PRIVATE_KEY
# No PAYMENT_KEY — attestation wallet pays (AVOID THIS)
```

> **WARNING: Privacy risk.** Using the attestation wallet for payment exposes your KYC-verified wallet address on-chain in the payment transaction, **directly linking your real-world identity to on-chain activity**. This defeats the purpose of zero-knowledge proofs. Always use a separate payment wallet (Option A or B).

#### Step 3: Run

```bash
# Coinbase KYC proof
zkproofport-prove coinbase_kyc --scope my-app

# Coinbase Country proof (prove wallet IS in US or KR)
zkproofport-prove coinbase_country --countries US,KR --included true

# OIDC domain proof (prove email domain affiliation using Google id_token)
zkproofport-prove oidc_domain --jwt <google-id-token> --scope my-app

# Silent mode — capture result as variable
PROOF_RESULT=$(zkproofport-prove coinbase_kyc --scope my-app --silent)
```

The CLI spawns the MCP server internally, calls `generate_proof`, prints the result as JSON to stdout, and exits. Proof generation takes 30-90 seconds.

#### Step 4: Result

The CLI outputs a JSON object with these key fields:

```json
{
  "proof": "0x28a3c1...",
  "publicInputs": "0x00000001...",
  "paymentTxHash": "0x9f2e7a...",
  "attestation": {
    "verification": { "valid": true, "... TEE attestation details" }
  },
  "timing": { "totalMs": 42150, "proofMs": 38200, "paymentMs": 3100 }
}
```

| Field | Description |
|-------|-------------|
| `proof` | The ZK proof bytes (hex). Pass to `verify_proof` or on-chain verifier |
| `publicInputs` | Public inputs for the proof (hex) |
| `paymentTxHash` | USDC payment transaction hash. Check on [BaseScan](https://basescan.org) |
| `attestation.verification` | TEE attestation validity — confirms proof was generated inside a Nitro Enclave |
| `timing` | Performance metrics (total, proof generation, payment) |

#### CLI Options

| Option | Default | Description |
|--------|---------|-------------|
| `[circuit]` | `coinbase_kyc` | Circuit to use: `coinbase_kyc`, `coinbase_country`, or `oidc_domain` |
| `--scope <scope>` | `proofport` | Scope string for nullifier derivation |
| `--jwt <token>` | -- | JWT id_token (required for `oidc_domain`) |
| `--countries <codes>` | -- | Comma-separated ISO codes (required for `coinbase_country`) |
| `--included <true\|false>` | -- | Inclusion or exclusion proof (required for `coinbase_country`) |
| `--silent` | -- | Suppress all logs, output only raw proof JSON to stdout |

#### Silent Mode

Use `--silent` to suppress all log output and print only the raw proof JSON to stdout. This makes it easy to capture the result in a shell variable:

```bash
PROOF_RESULT=$(zkproofport-prove coinbase_kyc --scope my-app --silent)
```

Without `--silent`, the CLI prints progress logs (payment, proof generation steps) to stderr and the full proof JSON to stdout. With `--silent`, only the proof JSON is written to stdout — no logs.

---

### MCP Integration (Agent-to-Agent)

Use MCP configuration when integrating ZKProofport as a **persistent tool** in an agent platform that supports the Model Context Protocol. This is for agent-to-agent workflows where your AI agent needs ZK proof generation as an always-available capability.

> **When to use MCP vs CLI:**
> - **CLI** — One-off proof generation, scripts, CI/CD, any AI agent with shell access
> - **MCP** — Agent platforms that natively support MCP tools (e.g., Claude Desktop as a chatbot)

<details>
<summary>Claude Desktop</summary>

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "zkproofport": {
      "command": "npx",
      "args": ["-y", "@zkproofport-ai/mcp"],
      "env": {
        "ATTESTATION_KEY": "0x_YOUR_ATTESTATION_WALLET_PRIVATE_KEY",
        "PAYMENT_KEY": "0x_YOUR_PAYMENT_WALLET_PRIVATE_KEY"
      }
    }
  }
}
```
</details>

<details>
<summary>Claude Code</summary>

Add to `.mcp.json` in your project root:

```json
{
  "mcpServers": {
    "zkproofport": {
      "command": "npx",
      "args": ["-y", "@zkproofport-ai/mcp"],
      "env": {
        "ATTESTATION_KEY": "0x_YOUR_ATTESTATION_WALLET_PRIVATE_KEY",
        "PAYMENT_KEY": "0x_YOUR_PAYMENT_WALLET_PRIVATE_KEY"
      }
    }
  }
}
```
</details>

<details>
<summary>Cursor / Windsurf / Other MCP Clients</summary>

Add to your MCP configuration file (`.cursor/mcp.json`, `~/.codeium/windsurf/mcp_config.json`, etc.):

```json
{
  "mcpServers": {
    "zkproofport": {
      "command": "npx",
      "args": ["-y", "@zkproofport-ai/mcp"],
      "env": {
        "ATTESTATION_KEY": "0x_YOUR_ATTESTATION_WALLET_PRIVATE_KEY",
        "PAYMENT_KEY": "0x_YOUR_PAYMENT_WALLET_PRIVATE_KEY"
      }
    }
  }
}
```
</details>

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ATTESTATION_KEY` | Coinbase circuits | Private key of wallet with Coinbase EAS KYC attestation on Base |
| `PAYMENT_KEY` | OIDC circuits | Private key of wallet with USDC balance. For Coinbase circuits, defaults to `ATTESTATION_KEY` |
| `CDP_API_KEY_ID` | No | Coinbase Developer Platform API key ID (see [CDP Wallet](#cdp-wallet-payment)) |
| `CDP_API_KEY_SECRET` | No | CDP API key secret |
| `CDP_WALLET_SECRET` | No | CDP wallet encryption secret |
| `CDP_WALLET_ADDRESS` | No | Existing CDP wallet address (creates new wallet if omitted) |

## Tools

### Simple Flow (Recommended)

Use `generate_proof` for the simplest path — it handles input preparation, payment, and proof generation in a single call.

#### `generate_proof`

All-in-one ZK proof generation. Prepares inputs, requests payment challenge, pays via x402 facilitator, and submits proof generation — all in one call.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `circuit` | `"coinbase_kyc"` \| `"coinbase_country"` \| `"oidc_domain"` | Yes | Which circuit to use |
| `scope` | string | No | Scope string for nullifier derivation. Default: `"proofport"` |
| `jwt` | string | For OIDC circuits | JWT id_token for OIDC circuits (e.g., Google id_token) |
| `country_list` | string[] | For country circuit | ISO 3166-1 alpha-2 country codes (e.g., `["US", "KR"]`) |
| `is_included` | boolean | For country circuit | `true` = prove country IS in list, `false` = prove NOT in list |

**Returns:** Proof bytes, public inputs, payment transaction hash, TEE attestation, timing info, and on-chain verifier details.

#### `get_supported_circuits`

List all supported ZK circuits with verifier contract addresses and authorized signers. No parameters required. Call this first to discover available circuits.

#### `verify_proof`

Verify a ZK proof on-chain against the deployed Solidity verifier contract. Pass the full `generate_proof` result directly — no need to extract individual fields.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `result` | object | Yes | Full result object from `generate_proof` — pass it directly |

### Step-by-Step Flow

For fine-grained control, debugging, or custom workflows, use individual tools:

```
prepare_inputs → request_challenge → make_payment → submit_proof → verify_proof
```

#### Step 1: `prepare_inputs`

Prepare all circuit inputs: compute signal hash, sign with attestation wallet, fetch EAS attestation, build Merkle proof.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `circuit` | `"coinbase_kyc"` \| `"coinbase_country"` \| `"oidc_domain"` | Yes | Which circuit to use |
| `scope` | string | No | Scope string. Default: `"proofport"` |
| `jwt` | string | For OIDC circuits | JWT id_token for OIDC circuits (e.g., Google id_token) |
| `country_list` | string[] | For country circuit | ISO 3166-1 alpha-2 country codes |
| `is_included` | boolean | For country circuit | Inclusion (`true`) or exclusion (`false`) proof |

#### Step 2: `request_challenge`

Request a 402 payment challenge from the server.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `circuit` | `"coinbase_kyc"` \| `"coinbase_country"` \| `"oidc_domain"` | Yes | Which circuit to use |
| `inputs` | object \| string | Yes | Full inputs object from `prepare_inputs` |

**Returns:** Payment nonce, recipient address, amount, asset, network — everything needed for `make_payment`.

#### Step 3: `make_payment`

Send USDC payment via the x402 facilitator. Uses the payment wallet (or attestation wallet as fallback).

All parameters are automatically provided by the `request_challenge` response. Pass them as-is.

**Returns:** Transaction hash of the USDC payment.

#### Step 4: `submit_proof`

Submit prepared inputs with payment proof to generate the ZK proof. The TEE server verifies payment on-chain, runs the Noir circuit inside the enclave, and returns the UltraHonk proof. This step takes 30-90 seconds.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `circuit` | `"coinbase_kyc"` \| `"coinbase_country"` \| `"oidc_domain"` | Yes | Which circuit to use |
| `inputs` | object \| string | Yes | Full inputs object from `prepare_inputs` |
| `payment_tx_hash` | string | Yes | `0x`-prefixed transaction hash from `make_payment` |
| `payment_nonce` | string | Yes | `0x`-prefixed nonce from `request_challenge` response |

#### Step 5: `verify_proof`

Same as described in the simple flow above. Verify the proof on-chain against the deployed Solidity verifier.

## Resource

### `proofport://config`

Read-only resource exposing the current MCP server configuration: wallet addresses and supported circuits.

## Circuits

### Coinbase KYC (`coinbase_kyc`)

Proves the wallet holder passed Coinbase Know-Your-Customer verification without revealing any personal information.

```
"Generate a coinbase_kyc proof with scope 'my-app'"
```

### Coinbase Country (`coinbase_country`)

Proves the wallet holder's verified country is (or is not) in a specified list — without revealing which country.

```
"Generate a coinbase_country proof. Country list: US, KR. Prove inclusion."
```

Required additional parameters:
- `country_list` — ISO 3166-1 alpha-2 codes (e.g., `["US", "KR", "JP"]`)
- `is_included` — `true` to prove the country IS in the list, `false` to prove it is NOT

### OIDC Domain (`oidc_domain`)

Proves email domain affiliation using an OIDC JWT id_token — without revealing the full email address. No Coinbase account or on-chain attestation needed. Works with any OIDC-compatible identity provider (e.g., Google).

```
"Generate an oidc_domain proof with scope 'myapp:verify-domain'"
```

Required additional parameter:
- `jwt` — JWT id_token from your OIDC provider's authorization flow (e.g., Google id_token)

**Using the `generate_proof` MCP tool:**

```json
{
  "circuit": "oidc_domain",
  "jwt": "<google-id-token>",
  "scope": "myapp:verify-domain"
}
```

## Payment

Each proof costs **$0.10 USDC** on Base.

Payment is **gasless** for the user:
1. The MCP server signs an EIP-3009 `TransferWithAuthorization` message (no gas cost)
2. The signature is sent to the [x402 facilitator](https://www.x402.org), which settles the USDC transfer on-chain (facilitator pays gas)
3. The ZKProofport server verifies payment on-chain before generating the proof

The payment transaction hash is included in every proof response for settlement tracking.

## CDP Wallet Payment

Instead of providing a raw `PAYMENT_KEY`, you can use a [Coinbase Developer Platform](https://portal.cdp.coinbase.com) MPC wallet. Private keys never leave Coinbase's TEE infrastructure.

### CLI (environment variables)

```bash
export ATTESTATION_KEY=0x_YOUR_ATTESTATION_WALLET_PRIVATE_KEY
export CDP_API_KEY_ID=your-cdp-api-key-id
export CDP_API_KEY_SECRET=your-cdp-api-key-secret
export CDP_WALLET_SECRET=your-cdp-wallet-secret
export CDP_WALLET_ADDRESS=0x_YOUR_CDP_WALLET_ADDRESS  # optional, creates new if omitted

zkproofport-prove coinbase_kyc --scope my-app
```

### MCP config

```json
{
  "mcpServers": {
    "zkproofport": {
      "command": "npx",
      "args": ["-y", "@zkproofport-ai/mcp"],
      "env": {
        "ATTESTATION_KEY": "0x_YOUR_ATTESTATION_WALLET_PRIVATE_KEY",
        "CDP_API_KEY_ID": "your-cdp-api-key-id",
        "CDP_API_KEY_SECRET": "your-cdp-api-key-secret",
        "CDP_WALLET_SECRET": "your-cdp-wallet-secret",
        "CDP_WALLET_ADDRESS": "0x_YOUR_CDP_WALLET_ADDRESS"
      }
    }
  }
}
```

When CDP credentials are provided, the MCP server uses the CDP MPC wallet for payment and the raw `ATTESTATION_KEY` for attestation signing. If no CDP credentials are set, the attestation wallet is used for both.

> **Note:** For Coinbase circuits, `ATTESTATION_KEY` is always a raw private key because the EAS attestation is tied to a specific wallet address. CDP wallets are only for payment. For OIDC circuits, `ATTESTATION_KEY` is not needed — only `PAYMENT_KEY` or CDP credentials.

## Troubleshooting

### `At least one key is required`

For Coinbase circuits (`coinbase_kyc`, `coinbase_country`), `ATTESTATION_KEY` is required. For OIDC circuits (`oidc_domain`), only `PAYMENT_KEY` is needed — no attestation key required. At least one of the two must be set.

### `Attestation not found`

Your wallet does not have a valid Coinbase KYC attestation on Base. Complete verification at [Coinbase Verifications](https://www.coinbase.com/onchain-verify).

### `402 Payment Required` / `Insufficient USDC`

The payment wallet does not have enough USDC on Base. You need at least $0.10 per proof. If using a separate payment wallet (`PAYMENT_KEY`), ensure that wallet has the USDC balance.

### `Transaction failed` from x402 facilitator

The SDK handles EIP-3009 domain names automatically. If you see this error, ensure you're using the latest version:

```bash
npx -y @zkproofport-ai/mcp@latest
```

### Proof generation takes too long

Proof generation typically takes 30-90 seconds. This is normal — the Noir circuit is being executed inside a Nitro Enclave on the remote server.

### CDP wallet errors

All three CDP credentials (`CDP_API_KEY_ID`, `CDP_API_KEY_SECRET`, `CDP_WALLET_SECRET`) must be provided together. Get credentials at [CDP Portal](https://portal.cdp.coinbase.com). If `CDP_WALLET_ADDRESS` is omitted, a new wallet is created automatically.

## Related

- [`@zkproofport-ai/sdk`](https://www.npmjs.com/package/@zkproofport-ai/sdk) — TypeScript SDK for programmatic proof generation
- [ZKProofport](https://zkproofport.app) — Project homepage
- [Remote MCP](https://ai.zkproofport.app/mcp) — Remote MCP server (no local install, browser wallet signing)

## License

MIT
