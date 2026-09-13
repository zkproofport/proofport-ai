# Ledger House: an actual agent inside an Arc dApp

The user enters a staking instruction in the dApp. An authenticated Claude Code
session selects tools, reads the provider's published guide and MCP schemas,
waits for the user's action/payment approval, obtains a real proof, verifies it
on Arc, and waits for the final staking approval. The UI displays actual inputs,
tool calls and responses. It does not display private reasoning or replay a script.
`user-agent/src/stake.ts` is a separate legacy rehearsal runner; Ask agent does not call it.

## Run and film

Use Node 22.18+, existing Claude Code and Circle CLI logins, and the private
`.env.development` / `.env.test` files. From `proofport-ai`:

```bash
npm ci
npm run build --workspace @zkproofport-ai/sdk
npm run build --workspace @zkproofport-ai/mcp
RECORDING_PORT=4114 bash demo/record.sh
```

Open **http://localhost:4114**. Keep any existing CLI/server running; choose another
unused port for a clean session. The remote prover is **GCP staging** at
`https://stg-ai.zkproofport.app`.

Start recording with an empty instruction and zero events, then enter:

> Stake 0.1 USDC with my Agent Wallet. Find a registered prover and read its
> instructions. Ask me to approve the exact-action authorization and proof fee,
> then ask me again before submitting the verified stake.

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
  query returns `NOT FOUND`; it pays the proof fee and executes the stake.
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
- **This execution uses GCP Cloud Run.** `tee.mode: local` names the in-process GCP
  prover; hardware attestation is disabled for this execution. Coinbase KYC
  attestation is still queried and validated. AWS Nitro Enclave is a separate
  implementation, not the runtime that generated this recorded proof.

## Actual MCP path

```text
Claude Code
  → ledger_house dApp authorization/execution adapter
  → proofport-ai/packages/mcp (handshake: zkproofport-mcp)
  → GCP staging prover
```

The native `mcp__ledger_house__*` names are preserved. The **INNER PROVER MCP**
panel separately shows the actual server handshake, `tools/call generate_proof`,
and returned proof sizes. These are nested protocol observations, not invented
additional model tool choices. Only public, whitelisted facts reach the page.

The model selects among ten local capabilities under fixed dApp policy. The
published guide and tools/list schemas are returned to the model before it selects
`generate_proof`. Some preparation calls are batched; the recording does not claim
that every call was selected in a separate post-guide reasoning turn. Remote
instructions cannot install arbitrary executables.

User decisions are bound to the run, amount, chain, wallet, target, complete action,
nonce/deadline, and payment terms or proof fingerprint. The model has no decision
tool or browser access. Read-only requests do not grant spending approval. Private
A's KYC must be confirmed before the proof approval request; unknown query results
are never labeled as absence or valid KYC. Optional balance observations cannot
turn a confirmed paid proof or stake into a request to repeat spending.

## Fresh presentation execution — 2026-09-13

- Actual proof approval **16:05:52 KST**, proof returned **16:06:24**.
- Arc preflight verified **16:06:26**, stake approved **16:06:35**.
- Successful stake result **16:07:14**, block **61860540**.
- Gateway **2.984 → 2.983**, Wallet B **0.3 → 0.2**, position **1.7 → 1.8 USDC**.
- One paid proof and one staking call. Initial read-only RPC errors were retried
  by the model and recovered before payment; raw evidence preserves them.

[78-second presentation video](https://github.com/zkproofport/proofport-app-dev/blob/main/videos/arc-recording/ledger-house-cli-walkthrough.mp4)
· [public execution evidence](artifacts/presentation-verification.json)
· [public proof](artifacts/presentation-proof.json)
· [Arc transaction](https://testnet.arcscan.app/tx/0x40d05805e2179291d0e24ff8c19f1bf190d240ac1d17b9360598d32dfd05c268).

The video uses fresh browser captures with waiting-time cuts and restrained crop/
zoom; no generated logs or cursor movement. Hiding A's literal address is not an
unlinkability guarantee: the existing public nullifier supports checking a known
candidate. That internal [security audit](audit/README.md) remains separate from
this presentation.
