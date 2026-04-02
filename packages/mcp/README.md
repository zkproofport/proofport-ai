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
- Proof generation is **free** — no payment required

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
3. **Attestation wallet private key** (required) — The private key of the wallet that holds the EAS attestation. Set as `ATTESTATION_KEY` environment variable.

**For OIDC circuits (`oidc_domain`):**

1. **OIDC identity provider account** — Google, Google Workspace, or Microsoft 365 account. No Coinbase account or on-chain attestation needed.
2. **JWT id_token** — Either use `--login-google` / `--login-google-workspace` / `--login-microsoft-365` for automatic device flow login, or pass a pre-obtained `id_token` via `--jwt`.

## Quick Start

### CLI (Recommended)

The simplest way to generate a proof — one command from a terminal or any AI agent's shell. No MCP configuration needed.

> **For AI agents:** Install with `npm install -g @zkproofport-ai/mcp`, then run `zkproofport-prove` from anywhere. Ask the user for the `ATTESTATION_KEY` environment variable if not already set (required for Coinbase circuits). No MCP configuration needed.

#### Step 1: Install

```bash
npm install -g @zkproofport-ai/mcp
```

#### Step 2: Set environment variables

**For Coinbase circuits** (`coinbase_kyc`, `coinbase_country`):

```bash
export ATTESTATION_KEY=0x_YOUR_ATTESTATION_WALLET_PRIVATE_KEY
```

**For OIDC circuits** (`oidc_domain`): no environment variables needed — just use `--login-google`, `--login-google-workspace`, `--login-microsoft-365`, or `--jwt`.

#### Step 3: Run

```bash
# Coinbase KYC proof
zkproofport-prove coinbase_kyc --scope my-app

# Coinbase Country proof (prove wallet IS in US or KR)
zkproofport-prove coinbase_country --countries US,KR --included true

# OIDC domain proof (prove email domain affiliation using Google id_token)
zkproofport-prove oidc_domain --jwt <google-id-token> --scope my-app

# Google login (any Google account — device flow, no JWT needed)
zkproofport-prove --login-google --scope my-app

# Google Workspace login (proves organization membership)
zkproofport-prove --login-google-workspace --scope my-app

# Microsoft 365 login (proves organization membership)
zkproofport-prove --login-microsoft-365 --scope my-app

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
  "attestation": {
    "verification": { "valid": true, "... TEE attestation details" }
  },
  "timing": { "totalMs": 42150, "proofMs": 38200 }
}
```

| Field | Description |
|-------|-------------|
| `proof` | The ZK proof bytes (hex). Pass to `verify_proof` or on-chain verifier |
| `publicInputs` | Public inputs for the proof (hex) |
| `attestation.verification` | TEE attestation validity — confirms proof was generated inside a Nitro Enclave |
| `timing` | Performance metrics (total, proof generation) |

#### CLI Options

| Option | Default | Description |
|--------|---------|-------------|
| `[circuit]` | `coinbase_kyc` | Circuit to use: `coinbase_kyc`, `coinbase_country`, or `oidc_domain` |
| `--scope <scope>` | `proofport` | Scope string for nullifier derivation |
| `--jwt <token>` | -- | JWT id_token (required for `oidc_domain` unless using `--login-*`) |
| `--login-google` | -- | Login with any Google account via device flow (auto-obtains JWT) |
| `--login-google-workspace` | -- | Login with Google Workspace account via device flow (proves org membership) |
| `--login-microsoft-365` | -- | Login with Microsoft 365 account via device flow (proves org membership) |
| `--countries <codes>` | -- | Comma-separated ISO codes (required for `coinbase_country`) |
| `--included <true\|false>` | -- | Inclusion or exclusion proof (required for `coinbase_country`) |
| `--provider <provider>` | -- | OIDC provider: `google` or `microsoft` (used with `--jwt`) |
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
        "ATTESTATION_KEY": "0x_YOUR_ATTESTATION_WALLET_PRIVATE_KEY"
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
        "ATTESTATION_KEY": "0x_YOUR_ATTESTATION_WALLET_PRIVATE_KEY"
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
        "ATTESTATION_KEY": "0x_YOUR_ATTESTATION_WALLET_PRIVATE_KEY"
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

## Tools

### Simple Flow (Recommended)

Use `generate_proof` for the simplest path — it handles input preparation, payment, and proof generation in a single call.

#### `generate_proof`

All-in-one ZK proof generation. Prepares inputs and submits proof generation — all in one call.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `circuit` | `"coinbase_kyc"` \| `"coinbase_country"` \| `"oidc_domain"` | Yes | Which circuit to use |
| `scope` | string | No | Scope string for nullifier derivation. Default: `"proofport"` |
| `jwt` | string | For OIDC circuits | JWT id_token for OIDC circuits (e.g., Google id_token) |
| `country_list` | string[] | For country circuit | ISO 3166-1 alpha-2 country codes (e.g., `["US", "KR"]`) |
| `is_included` | boolean | For country circuit | `true` = prove country IS in list, `false` = prove NOT in list |

**Returns:** Proof bytes, public inputs, TEE attestation, timing info, and on-chain verifier details.

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
prepare_inputs → submit_proof → verify_proof
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

#### Step 2: `submit_proof`

Submit prepared inputs to generate the ZK proof. The TEE server runs the Noir circuit inside the enclave and returns the UltraHonk proof. This step takes 30-90 seconds.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `circuit` | `"coinbase_kyc"` \| `"coinbase_country"` \| `"oidc_domain"` | Yes | Which circuit to use |
| `inputs` | object \| string | Yes | Full inputs object from `prepare_inputs` |

#### Step 3: `verify_proof`

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

Proves email domain affiliation using an OIDC JWT id_token — without revealing the full email address. No Coinbase account or on-chain attestation needed. Supports Google, Google Workspace, and Microsoft 365.

#### Device Flow Login (Recommended for CLI)

The easiest way to generate OIDC proofs — no need to manually obtain a JWT:

```bash
# Any Google account (proves email domain, e.g., gmail.com)
zkproofport-prove --login-google --scope my-app

# Google Workspace (proves organization membership, e.g., company.com)
zkproofport-prove --login-google-workspace --scope my-app

# Microsoft 365 (proves organization membership, e.g., company.onmicrosoft.com)
zkproofport-prove --login-microsoft-365 --scope my-app
```

The CLI opens a device flow: visit a URL, enter a code, sign in with your account. The JWT is obtained automatically and used for proof generation.

> **Note:** `--login-*` and `--jwt` are mutually exclusive. Only one `--login-*` flag can be used at a time.

#### Manual JWT (MCP / Programmatic)

For MCP tool calls or programmatic usage, pass a pre-obtained JWT:

```
"Generate an oidc_domain proof with scope 'myapp:verify-domain'"
```

Required additional parameters:
- `jwt` — JWT id_token from your OIDC provider's authorization flow
- `provider` — (optional) `"google"` (default) or `"microsoft"`

**Google Workspace example:**

```json
{
  "circuit": "oidc_domain",
  "jwt": "<google-id-token>",
  "scope": "myapp:verify-domain"
}
```

**Microsoft 365 example:**

```json
{
  "circuit": "oidc_domain",
  "jwt": "<microsoft-id-token>",
  "provider": "microsoft",
  "scope": "myapp:verify-domain"
}
```

## Troubleshooting

### `ATTESTATION_KEY is required`

For Coinbase circuits (`coinbase_kyc`, `coinbase_country`), `ATTESTATION_KEY` must be set — it is the private key of the wallet holding the Coinbase EAS attestation on Base.

### `Attestation not found`

Your wallet does not have a valid Coinbase KYC attestation on Base. Complete verification at [Coinbase Verifications](https://www.coinbase.com/onchain-verify).

### Proof generation takes too long

Proof generation typically takes 30-90 seconds. This is normal — the Noir circuit is being executed inside a Nitro Enclave on the remote server.

## Related

- [`@zkproofport-ai/sdk`](https://www.npmjs.com/package/@zkproofport-ai/sdk) — TypeScript SDK for programmatic proof generation
- [ZKProofport](https://zkproofport.app) — Project homepage
- [Remote MCP](https://ai.zkproofport.app/mcp) — Remote MCP server (no local install, browser wallet signing)

## License

MIT
