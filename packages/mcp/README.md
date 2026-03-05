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

1. **Coinbase account with KYC verification** — Complete identity verification on [Coinbase](https://www.coinbase.com/)
2. **Coinbase KYC attestation on Base** — Obtain an on-chain EAS attestation via [Coinbase Verifications](https://www.coinbase.com/onchain-verify)
3. **USDC on Base** — At least $0.10 per proof (gasless — you only sign, facilitator pays gas)
4. **Private key** of the wallet holding the attestation

## Quick Start

### Claude Desktop

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

### Claude Code

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

### Cursor

Add to `.cursor/mcp.json`:

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

### Windsurf

Add to `~/.codeium/windsurf/mcp_config.json`:

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

Once configured, ask your AI agent:

> "Generate a Coinbase KYC proof for my wallet"

The agent will use `generate_proof` and handle everything automatically.

### Run Manually

You can also install and run the MCP server directly:

```bash
mkdir mcp-test && cd mcp-test
npm init -y
npm install @zkproofport-ai/mcp
```

```bash
ATTESTATION_KEY=0x... npx zkproofport-mcp
```

The server starts on stdio and waits for MCP JSON-RPC messages.

### Programmatic Usage

Use the MCP client SDK to call tools from code:

```bash
npm install @zkproofport-ai/mcp @modelcontextprotocol/sdk
```

```javascript
// test-prove.mjs
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({
  command: 'node',
  args: ['node_modules/@zkproofport-ai/mcp/dist/index.js'],
  env: { ...process.env, ATTESTATION_KEY: '0x...' },
});

const client = new Client({ name: 'my-agent', version: '1.0.0' });
await client.connect(transport);

// Generate a proof (30-90 seconds)
const result = await client.callTool({
  name: 'generate_proof',
  arguments: { circuit: 'coinbase_kyc', scope: 'my-app' },
});

console.log(JSON.stringify(result, null, 2));
await client.close();
```

```bash
node test-prove.mjs
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ATTESTATION_KEY` | **Yes** | Private key of wallet with Coinbase EAS KYC attestation on Base |
| `PAYMENT_KEY` | No | Private key of separate wallet with USDC balance. Defaults to `ATTESTATION_KEY` |
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
| `circuit` | `"coinbase_kyc"` \| `"coinbase_country"` | Yes | Which circuit to use |
| `scope` | string | No | Scope string for nullifier derivation. Default: `"proofport"` |
| `country_list` | string[] | For country circuit | ISO 3166-1 alpha-2 country codes (e.g., `["US", "KR"]`) |
| `is_included` | boolean | For country circuit | `true` = prove country IS in list, `false` = prove NOT in list |

**Returns:** Proof bytes, public inputs, payment transaction hash, TEE attestation, timing info, and on-chain verifier details.

#### `get_supported_circuits`

List all supported ZK circuits with verifier contract addresses and authorized signers. No parameters required. Call this first to discover available circuits.

#### `verify_proof`

Verify a ZK proof on-chain against the deployed Solidity verifier contract.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `proof` | string | Yes | `0x`-prefixed proof hex from generate_proof response |
| `public_inputs` | string | Yes | `0x`-prefixed public inputs hex from generate_proof response |
| `verifier_address` | string | Yes | Verifier contract address from response `verification` field |
| `chain_id` | number | Yes | Chain ID from response `verification` field (e.g., `84532` for Base Sepolia) |
| `rpc_url` | string | Yes | RPC URL from response `verification` field |

### Step-by-Step Flow

For fine-grained control, debugging, or custom workflows, use individual tools:

```
prepare_inputs → request_challenge → make_payment → submit_proof → verify_proof
```

#### Step 1: `prepare_inputs`

Prepare all circuit inputs: compute signal hash, sign with attestation wallet, fetch EAS attestation, build Merkle proof.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `circuit` | `"coinbase_kyc"` \| `"coinbase_country"` | Yes | Which circuit to use |
| `scope` | string | No | Scope string. Default: `"proofport"` |
| `country_list` | string[] | For country circuit | ISO 3166-1 alpha-2 country codes |
| `is_included` | boolean | For country circuit | Inclusion (`true`) or exclusion (`false`) proof |

#### Step 2: `request_challenge`

Request a 402 payment challenge from the server.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `circuit` | `"coinbase_kyc"` \| `"coinbase_country"` | Yes | Which circuit to use |
| `inputs` | object \| string | Yes | Full inputs object from `prepare_inputs` |

**Returns:** Payment nonce, recipient address, amount, asset, network — everything needed for `make_payment`.

#### Step 3: `make_payment`

Send USDC payment via the x402 facilitator. Uses the payment wallet (or attestation wallet as fallback).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `nonce` | string | Yes | Payment nonce from `request_challenge` response |
| `recipient` | string | Yes | Payment recipient address from `request_challenge` response |
| `amount` | number | Yes | Amount in USDC base units (e.g., `100000` = $0.10) |
| `asset` | string | Yes | USDC contract address for the target network |
| `network` | `"base-sepolia"` \| `"base"` | Yes | Target network |
| `instruction` | string | Yes | Human-readable payment instruction from `request_challenge` response |

**Returns:** Transaction hash of the USDC payment.

#### Step 4: `submit_proof`

Submit prepared inputs with payment proof to generate the ZK proof. The TEE server verifies payment on-chain, runs the Noir circuit inside the enclave, and returns the UltraHonk proof. This step takes 30-90 seconds.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `circuit` | `"coinbase_kyc"` \| `"coinbase_country"` | Yes | Which circuit to use |
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

## Payment

Each proof costs **$0.10 USDC** on Base.

Payment is **gasless** for the user:
1. The MCP server signs an EIP-3009 `TransferWithAuthorization` message (no gas cost)
2. The signature is sent to the [x402 facilitator](https://www.x402.org), which settles the USDC transfer on-chain (facilitator pays gas)
3. The ZKProofport server verifies payment on-chain before generating the proof

The payment transaction hash is included in every proof response for settlement tracking.

## CDP Wallet Payment

Instead of providing a raw `PAYMENT_KEY`, you can use a [Coinbase Developer Platform](https://portal.cdp.coinbase.com) MPC wallet. Private keys never leave Coinbase's TEE infrastructure.

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

> **Note:** `ATTESTATION_KEY` is always a raw private key because the EAS attestation is tied to a specific wallet address. CDP wallets are only for payment.

## Troubleshooting

### `ATTESTATION_KEY is required`

The `ATTESTATION_KEY` environment variable must be set. It should be the private key (with `0x` prefix) of the wallet that holds the Coinbase KYC EAS attestation on Base.

### `Attestation not found`

Your wallet does not have a valid Coinbase KYC attestation on Base. Complete verification at [Coinbase Verifications](https://www.coinbase.com/onchain-verify).

### `402 Payment Required` / `Insufficient USDC`

The payment wallet does not have enough USDC on Base. You need at least $0.10 per proof. If using a separate payment wallet (`PAYMENT_KEY`), ensure that wallet has the USDC balance.

### `Transaction failed` from x402 facilitator

The EIP-3009 domain name differs by network — Base Mainnet uses `"USD Coin"` while Base Sepolia uses `"USDC"`. The SDK handles this automatically. If you see this error, ensure you're using the latest version:

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
