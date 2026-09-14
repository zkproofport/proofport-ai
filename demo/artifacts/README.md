# Demo execution evidence

`user-action-e2e.json` records the latest real SDK/MCP 0.2.12 action-input E2E (2026-09-13 18:25–18:26 KST). It includes the submitted action, approvals, protocol results and successful 10-USDC Arc stake.

The `npm-presentation-*` records belong to the earlier 0.2.11 execution used in the published 80-second video. Other previously committed JSON records are historical observations, not fixtures to replay as a live agent. Their timestamps, versions, amounts and failure/rejection states must not be presented as the latest run.

`demo/.npm-presentation-verify.mjs` preserves the verification helper used for the published recording. From the `proofport-ai` root it can be invoked with `node --import tsx demo/.npm-presentation-verify.mjs`. It reads the original local environment files, queries the configured Arc RPC and overwrites `npm-presentation-verification.json` with a new observation. It does not buy a proof or stake. It is not the current demo launch or E2E entry point; those commands are in [the demo guide](../README.md).

Superseded untracked rehearsal snapshots and one-off helpers were removed during cleanup. Previously committed public proof and verification evidence remains available. Private environment files and witness data must never be committed.
