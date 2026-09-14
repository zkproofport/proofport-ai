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
`.env.development` / `.env.test` files. First confirm that Release Please has published the Arc-enabled npm versions pinned by `demo/runtime/package-lock.json` (0.2.12 or newer). Confirm publication before installing or reporting live verification. From `proofport-ai`:

```bash
npm ci
npm ci --prefix demo/runtime --workspaces=false
RECORDING_PORT=4119 bash demo/record.sh
```

The `demo/runtime` npm install bootstraps the server and wallet observation. It is separate from the fresh per-run prover installation selected by the agent after reading the guide. Both use published npm packages; neither imports local workspace `packages/*/dist` output.

Open **http://localhost:4119**. Keep any existing CLI/server running; choose another
unused port for a clean session. The remote prover is **staging** at
`https://stg-ai.zkproofport.app`.

Match the submitted presentation's **10 USDC** action. Start with an empty instruction and zero events, then enter the complete prompt below. The latest live E2E used it on **2026-09-13 18:25–18:26 KST**, with the final sentence preserving the user-submitted action. The textarea expands so every sentence is visible.

> Stake 10 USDC with my Agent Wallet. Find a registered ZKProofport prover in the dApp Agent Marketplace and verify its ERC-8004 identity. Read its installation instructions, install the published SDK and MCP packages from npm, then connect and read the MCP tools. Ask me to approve the exact-action authorization and proof fee, then ask me again before submitting the verified stake. Use the EIP-712 action I submitted unchanged.

Set amount `10`. Open **Exact action · review or edit EIP-712** and review or edit
the complete `action` JSON before submitting. Its `domain`, `types`, `primaryType`
and `message` travel unchanged through the user approval, actual prover MCP call
and SDK EIP-712 signature. Wallet A's address/key never belongs in this JSON.
For this deployed vault the action schema must match its contract; the SDK/MCP
also support arbitrary valid EIP-712 struct names, keys, types and nested values.
Click **Ask agent**, review and approve **Authorize this action +
proof fee**, then review **Confirm the verified stake**. Capture the actual
Gateway payment, proof result, verification checks, position update and **View on
Arc Explorer**. The presentation ends at Explorer; it does not include the internal
candidate-address audit.

### Test the user-supplied action without recording

The verified run is completed on **4119**. For another fresh E2E in this workspace, start a new local dApp on an unused port (for example **4120**); keep existing sessions running:

```bash
RECORDING_PORT=4120 bash demo/record.sh
```

The launcher passes only runtime/Claude login settings and public Wallet B
configuration to the service. Do **not** start it with private `--env-file` files.
Only the local MCP client reads `.env.development` / `.env.test`; the service
refuses startup with `ATTESTATION_KEY` or the private credential wallet address.

Run the focused unit tests and the opt-in live browser E2E (Google Chrome required):

```bash
npx vitest run --project unit tests/demoUserAction.test.ts tests/demoClaudeRoutes.test.ts tests/dappAgent.test.ts tests/dappPolicy.test.ts
ARC_DAPP_LIVE_E2E=1 ARC_DAPP_URL=http://localhost:4120 npm run test:demo:e2e
```

The live test operates the real form and both approval buttons, uses actual
Claude/npm MCP/SDK and the staging prover, buys **one 0.001 USDC proof** and stakes
**10 USDC once**. It requires an empty run and sufficient Wallet B/Gateway balances.
There are no automatic paid retries. Without `ARC_DAPP_LIVE_E2E=1`, live tests skip.
The submitted user nonce/deadline must equal the approval and actual MCP arguments;
the proof hash must equal the deployed Gate's hash. Altered amount, actor, nonce,
domain, deadline and replay are rejected by real `eth_call`. A separate custom-type
MCP test signs custom fields with an ephemeral non-KYC fixture through both `generate_proof` and `prepare_inputs`, and confirms KYC refusal before payment.

After a successful run, recheck its proof and rejected mutations without another
purchase or stake. Use the port containing that completed run (the execution
below is completed on 4119):

```bash
ARC_DAPP_LIVE_E2E=1 ARC_DAPP_REUSE_COMPLETED=1 ARC_DAPP_URL=http://localhost:4119 npm run test:demo:e2e
```

Real successful execution using npm **SDK 0.2.12 / MCP 0.2.12** on **2026-09-13 18:25–18:26 KST**, balances observed **18:26:44 KST**:
position **21.8 → 31.8 USDC**, Gateway **2.981 → 2.980 USDC**;
[Arc transaction](https://testnet.arcscan.app/tx/0x7692f7a4efb45daa590637362bbc3f0e7f40e9525bf5f3ba63f5d5ddc4bb453b).
All **4 live E2E tests**, **1,049 root unit tests** and **41 MCP unit tests** passed. No new video was recorded for this verification.
Public evidence: [`artifacts/user-action-e2e.json`](artifacts/user-action-e2e.json).

The [Korean team guide](https://github.com/zkproofport/proofport-app-dev/blob/main/docs/ops/ai-usage.md)
provides the full execution, verification and optional filming procedure. No separate prove CLI command is needed:
this run invokes the actual prover MCP tool.

## Wallets and protocol boundaries

- **Private Wallet A** has the Coinbase KYC credential and signs authorization for
  this exact action. Its address and key are masked as `****` in the dApp/model.
- **Wallet B** is the existing **Circle Agent Wallet**. Its direct Coinbase KYC
  query returned `NOT FOUND` in the latest live E2E (**18:25–18:26 KST**). It pays the proof fee and executes the stake.
- The credential is not transferred to B. One `arc_eligibility` proof combines
  Coinbase KYC and the same holder's EIP-712 action signature. The gate checks B,
  policy, target/domain, stake amount, nonce and deadline before transfer.
- **Discovery** uses the dApp's provider catalog, reading live published
  registration IDs; **ERC-8004 identity** is independently checked through current
  Arc registry ownership and metadata. This is not a search of an external Arc
  marketplace. Registration identity does not grant spending authority.
- **Circle Gateway nanopayment** is real: `pay_with: arc`,
  `pay_on: arc-testnet-nano`, proof fee **0.001 USDC**. The proof fee and **10 USDC**
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
that every call was selected in a separate post-guide reasoning turn. After reading the guide, the model selects `install_prover_mcp`, which queries npm registry `latest` independently for `@zkproofport-ai/sdk` and `@zkproofport-ai/mcp`. Each must be a stable version at least 0.2.12; they need not have equal version numbers. The helper installs each resolved version exactly into a fresh private temporary directory with:

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

## Earlier recorded npm execution — 2026-09-13 17:01–17:06 KST

- Provider discovery **17:01:45**, guide returned **17:01:48**, model-selected installation **17:01:49**.
- Fresh npm installation completed **17:02:02**, installed **SDK 0.2.11 / MCP 0.2.11** handshake and schemas returned **17:02:04**.
- Actual browser proof/action approval **17:02:26**, proof call **17:02:29**, proof returned **17:02:59**: **16,256 bytes / 192 public inputs**.
- Arc preflight verified **17:03:02**, actual browser stake approval **17:04:57**.
- Successful **10 USDC** stake result **17:05:16**, block **61867367**.
- Gateway **2.983 → 2.982**, Wallet B **20.2 → 10.2**, position and vault custody **1.8 → 11.8 USDC**, balances observed **17:05:53 KST**.
- Exactly one paid proof and one staking call, both after their browser approvals; receipt, event action binding and live verifier rechecked successfully.

The published video records the earlier **0.2.11** execution above. The current **0.2.12** action-input E2E was verified separately without a new recording. See the [parent video index](https://github.com/zkproofport/proofport-app-dev/blob/main/videos/arc-recording/README.md) for the final MP4, edit metadata and version distinction.

[Presentation video](https://github.com/zkproofport/proofport-app-dev/blob/main/videos/arc-recording/ledger-house-cli-walkthrough.mp4)
· [public execution evidence](artifacts/npm-presentation-verification.json)
· [public proof](artifacts/npm-presentation-proof.json)
· [Arc transaction](https://testnet.arcscan.app/tx/0x89b76904344e4930871230300ec0a982a503989a82774e1f7c112c0b958f9010).

Earlier **0.1 USDC** rehearsal evidence remains in `artifacts/presentation-verification.json`; it is separate from this **10 USDC** recording. Hiding A's literal address is not an
unlinkability guarantee: the existing public nullifier supports checking a known
candidate. That internal [security audit](audit/README.md) remains separate from
this presentation.

## Recording: fixed frame and event-based cuts

Keep the complete browser frame fixed: **no zoom, pan or moving crop**. Show the whole instruction. Highlight important regions with an **amber outside border and black underlay**, without covering text or changing the UI palette. Include marketplace identity, guide reading, real npm installation, MCP connection/tools list, both approvals, x402 payment, proof verification, position change and Explorer.

Trim waiting only at actual tool-call/result and approval/payment/receipt boundaries. Preserve the execution order and do not fabricate logs, status, results or cursor movement. The raw capture records actual dApp input, both browser approvals, model-selected tools, npm installation, MCP calls, verification, confirmed stake and real Explorer pages.
