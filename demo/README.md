# Ledger House: actual agent execution inside a dApp

The dApp accepts a natural-language instruction and starts an isolated,
authenticated **Claude Code** session. The model selects actual MCP tool calls
based on the user's instruction, the staking service policy, the discovered
prover's documentation, and tool responses. The page shows submitted input,
the model reported by the session, and actual tool calls/results. Private
reasoning, credentials and the KYC holder's address are not displayed.

**`user-agent/src/stake.ts` is an older deterministic standalone rehearsal
runner. The dApp's Ask agent button does not execute it.**

## Run and film the actual dApp

Use Node 22.18+, existing Claude Code and Circle CLI logins, and the existing
`.env.development` / `.env.test`. Prepare the local packages if necessary:

```bash
npm ci
npm run build --workspace @zkproofport-ai/sdk
npm run build --workspace @zkproofport-ai/mcp
RECORDING_PORT=4111 bash demo/record.sh
```

Open **http://localhost:4111**. If that page is already running, keep its process
and use the existing page. The prover is GCP staging at
`https://stg-ai.zkproofport.app`; the dApp runs locally.

Start recording before entering an instruction in **Your instruction**:

> Stake 0.1 USDC in Ledger House with my Agent Wallet. Find a registered prover
> on Arc, read its instructions, and obtain the KYC and delegation proof this
> dApp requires. Verify the proof on-chain before staking.

Set **Requested staking amount** to `0.1`, then click **Ask agent** once.
The instruction authorizes discovery and preparation only. Approve the actual
**KYC delegation & 0.001 USDC proof payment** request in the dApp, then after
verification separately confirm the **0.1 USDC stake**. The real MCP tool waits
for each decision; Reject stops the corresponding action.

Film both permission dialogs and user clicks, the user input, **LIVE AGENT / Agent tools & results**, verification and
receipt, the increased on-chain position, and **Compare configured address**.
Expand tool responses to inspect the fetched documents, MCP schema, selected
proof arguments, verifier response and transaction hash.

The [Korean team filming guide](https://github.com/zkproofport/proofport-app-dev/blob/main/docs/ops/ai-usage.md)
contains the full step-by-step procedure.

## Actual execution path

- [`recordingRoutes.ts`](staking-service/src/recordingRoutes.ts) receives
  `{instruction, amount}` and spawns `claude`, with a restricted local MCP config.
- [`claudeSession.ts`](staking-service/src/claudeSession.ts) supplies the user
  instruction and authority bounds. It does not select or replay tool calls.
- [`dapp-mcp.ts`](user-agent/src/dapp-mcp.ts) implements the real capabilities:
  service access challenge, ERC-8004 discovery, HTTPS guide retrieval, local
  prover MCP connection and `tools/list`, delegation preparation,
  `generate_proof`, Arc verifier `eth_call`, and Circle Agent Wallet staking.
- [`recording.ts`](staking-service/src/recording.ts) displays correlated native
  Claude `tool_use` / `tool_result` events. It excludes model reasoning and
  accepts completion only from a successful staking result and process exit.

The model chooses tool calls. The executor enforces trusted deployment,
approved amount, document/connection prerequisites, proof binding and
verification, and protection against duplicate paid attempts. A read-only
instruction can finish without buying a proof or staking.

ERC-8004 discovers the prover's **identity and endpoint**. Spending authority
comes from the KYC wallet A's EIP-712 delegation to the existing Agent Wallet B.
`arc_eligibility` proves **Coinbase KYC and that same holder's signed delegation
in one circuit**. The gate binds the delegate, amount, scope, signer root,
expiry and nonce, and verifies the proof again when staking.

Proof fees use `pay_with: arc` and `pay_on: arc-testnet-nano`: Circle Agent
Wallet signing and Gateway settlement. The 0.001 USDC proof fee and 0.1 USDC
on-chain staking deposit are separate operations. GCP runs in local prover
mode and does not advertise hardware TEE attestation.

## Recorded real execution

The latest interactive run began at **2026-09-13 14:27:49 KST**. The user
approved proof/delegation at **14:28:30** and the verified stake at **14:29:38**.
The new transaction completed at **14:29:56**, session exit at **14:30:01**.
Claude selected ten tools, including two blocking permission requests. Gateway
changed 2.985 → 2.984 USDC, wallet 0.4 → 0.3, position 1.6 → 1.7. A separate
real rejection run produced no proof/payment/stake and no balance changes.

- [Interactive video, 3m14s](https://github.com/zkproofport/proofport-app-dev/blob/main/videos/arc-recording/ledger-house-cli-walkthrough.mp4)
- [Actual approval and transaction evidence](artifacts/interactive-verification.json)
- [Actual rejection evidence](artifacts/interactive-rejection-verification.json)
- [Public proof](artifacts/interactive-proof.json)
- [New transaction](https://testnet.arcscan.app/tx/0x16eea46e81a904ba4f7504542264da65b3a462f16d8121919e38bfcaba0815e8)

Exact approved payment terms are passed through MCP into SDK payment signing.
If the final challenge changes amount, recipient, asset, chain or signing domain,
the SDK refuses to sign. The model has no approval decision tool or browser access.

The public nullifier supports checking a known candidate address. Hiding A in
the interface is not an unlinkability guarantee; see the [audit guide](audit/README.md).
Earlier deterministic CLI evidence remains in `artifacts/filmed-cli-*` as
history, separate from the actual model-driven `agent-dapp-*` recording.
