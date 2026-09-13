# Ledger House: an actual agent inside an Arc dApp

The user enters a staking instruction in the dApp. An authenticated Claude Code
session selects tools, reads the provider's installation guide, installs the trusted
SDK/MCP packages from npm, connects the installed MCP and reads its schemas,
waits for the user's action/payment approval, obtains a real proof, verifies it
on Arc, and waits for the final staking approval. The UI displays actual inputs,
tool calls and responses. It does not display private reasoning or replay a script.
`user-agent/src/stake.ts` is a separate legacy rehearsal runner; Ask agent does not call it.

## Run and film

Use Node 22.18+, existing Claude Code and Circle CLI logins, and the private
`.env.development` / `.env.test` files. First confirm that Release Please has published the Arc-enabled npm versions pinned by `demo/runtime/package-lock.json` (0.2.11 or newer). Do not report installation or the new recording as complete while publication is pending. From `proofport-ai`:

```bash
npm ci
npm ci --prefix demo/runtime --workspaces=false
RECORDING_PORT=4115 bash demo/record.sh
```

The `demo/runtime` npm install bootstraps the server and wallet observation. It is separate from the fresh per-run prover installation selected by the agent after reading the guide. Both use published npm packages; neither imports local workspace `packages/*/dist` output.

Open **http://localhost:4115**. Keep any existing CLI/server running; choose another
unused port for a clean session. The remote prover is **staging** at
`https://stg-ai.zkproofport.app`.

For the next recording, start with an empty instruction and zero events, then enter the complete prompt below. This is the proposed fresh-install prompt, not evidence of a completed new run. The textarea must expand so every sentence is visible.

> Stake 0.1 USDC with my Agent Wallet. Find a registered ZKProofport prover in the dApp Agent Marketplace and verify its ERC-8004 identity. Read its installation instructions, install the published SDK and MCP packages from npm, then connect and read the MCP tools. Ask me to approve the exact-action authorization and proof fee, then ask me again before submitting the verified stake.

Set amount `0.1`, click **Ask agent**, review and approve **Authorize this action +
proof fee**, then review **Confirm the verified stake**. Capture the actual
Gateway payment, proof result, verification checks, position update and **View on
Arc Explorer**. The presentation ends at Explorer; it does not include the internal
candidate-address audit.

The [Korean team guide](https://github.com/zkproofport/proofport-app-dev/blob/main/docs/ops/ai-usage.md)
provides the full filming procedure. No separate prove CLI command is needed:
this run invokes the actual prover MCP tool.

## Wallets and protocol boundaries

- **Private Wallet A** has the Coinbase KYC credential and signs authorization for
  this exact action. Its address and key are masked as `****` in the dApp/model.
- **Wallet B** is the existing **Circle Agent Wallet**. Its direct Coinbase KYC
  query returned `NOT FOUND` in the historical run; show the current observed result. It pays the proof fee and executes the stake.
- The credential is not transferred to B. One `arc_eligibility` proof combines
  Coinbase KYC and the same holder's EIP-712 action signature. The gate checks B,
  policy, target/domain, stake amount, nonce and deadline before transfer.
- **Discovery** uses the dApp's provider catalog, reading live published
  registration IDs; **ERC-8004 identity** is independently checked through current
  Arc registry ownership and metadata. This is not a search of an external Arc
  marketplace. Registration identity does not grant spending authority.
- **Circle Gateway nanopayment** is real: `pay_with: arc`,
  `pay_on: arc-testnet-nano`, proof fee **0.001 USDC**. The proof fee and **0.1 USDC**
  staking deposit are separate. SDK signing checks the exact approved payment
  terms before signing the final challenge.

## Actual MCP path

```text
Claude Code
  → ledger_house dApp authorization/execution adapter
  → discovered usage guide → real npm installation
  → @zkproofport-ai/mcp (handshake: zkproofport-mcp)
  → staging prover
```

The native `mcp__ledger_house__*` names are preserved. The **INNER PROVER MCP**
panel separately shows the actual server handshake, `tools/call generate_proof`,
and returned proof sizes. These are nested protocol observations, not invented
additional model tool choices. Only public, whitelisted facts reach the page.

The model selects among **11 allowed tools** under fixed dApp policy. The
published guide and tools/list schemas are returned to the model before it selects
`generate_proof`. Some preparation calls are batched; the recording does not claim
that every call was selected in a separate post-guide reasoning turn. After reading the guide, the model selects `install_prover_mcp`, which queries npm registry `latest` independently for `@zkproofport-ai/sdk` and `@zkproofport-ai/mcp`. Each must be a stable version at least 0.2.11; they need not have equal version numbers. The helper installs each resolved version exactly into a fresh private temporary directory with:

```text
--save-exact --registry=https://registry.npmjs.org --ignore-scripts
--no-audit --no-fund --workspaces=false
```

The npm process receives an isolated environment without wallet keys, login credentials or npm tokens. The helper checks exit status, installed versions, registry lock provenance and shared SDK resolution. Only after success can `connect_prover_mcp` connect the newly installed executable and retrieve the handshake and `tools/list`. Remote guide text cannot select arbitrary executables; no workspace fallback is allowed.

```text
read_dapp, discover_prover, read_prover_guide, install_prover_mcp,
connect_prover_mcp, prepare_delegation, request_proof_permission,
generate_proof, verify_proof_on_arc, request_stake_permission, stake
```

The native `prepare_delegation` wire name remains; its UI meaning is exact-action authorization. Installation evidence is distinct from connection, proof-generation and staking evidence.

User decisions are bound to the run, amount, chain, wallet, target, complete action,
nonce/deadline, and payment terms or proof fingerprint. The model has no decision
tool or browser access. Read-only requests do not grant spending approval. Private
A's KYC must be confirmed before the proof approval request; unknown query results
are never labeled as absence or valid KYC. Optional balance observations cannot
turn a confirmed paid proof or stake into a request to repeat spending.

## Historical presentation execution — 2026-09-13 16:05–16:07 KST

This is the earlier execution, before the new agent-selected fresh npm installation workflow. It is not evidence that the new workflow or recording has completed.

- Actual proof approval **16:05:52 KST**, proof returned **16:06:24**.
- Arc preflight verified **16:06:26**, stake approved **16:06:35**.
- Successful stake result **16:07:14**, block **61860540**.
- Gateway **2.984 → 2.983**, Wallet B **0.3 → 0.2**, position **1.7 → 1.8 USDC**.
- One paid proof and one staking call. Initial read-only RPC errors were retried
  by the model and recovered before payment; raw evidence preserves them.

[Earlier 78-second presentation video](https://github.com/zkproofport/proofport-app-dev/blob/main/videos/arc-recording/ledger-house-cli-walkthrough.mp4)
· [public execution evidence](artifacts/presentation-verification.json)
· [public proof](artifacts/presentation-proof.json)
· [Arc transaction](https://testnet.arcscan.app/tx/0x40d05805e2179291d0e24ff8c19f1bf190d240ac1d17b9360598d32dfd05c268).

The linked historical video used actual browser captures with waiting-time cuts and crop/zoom. The next recording has not yet been completed and will follow the fixed-frame requirements below. Hiding A's literal address is not an
unlinkability guarantee: the existing public nullifier supports checking a known
candidate. That internal [security audit](audit/README.md) remains separate from
this presentation.

## Next recording: fixed frame and event-based cuts

Keep the complete browser frame fixed: **no zoom, pan or moving crop**. Show the whole instruction. Highlight important regions with an **amber outside border and black underlay**, without covering text or changing the UI palette. Include marketplace identity, guide reading, real npm installation, MCP connection/tools list, both approvals, x402 payment, proof verification, position change and Explorer.

Trim waiting only at actual tool-call/result and approval/payment/receipt boundaries. Preserve the execution order and do not fabricate logs, status, results or cursor movement. Replace the historical timestamps, balances and links only after a fresh execution and recording provide actual evidence.
