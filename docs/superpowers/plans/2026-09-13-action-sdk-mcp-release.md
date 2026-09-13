# Action SDK/MCP release implementation plan

> **For agentic workers:** Execute inline using superpowers:executing-plans with the existing session preserved.

**Goal:** Publish documented action authorization consistently through SDK and both MCP proof paths, then verify the released packages in the actual dApp.

**Architecture:** User-owned EIP-712 domain/types/primaryType/message are hashed before signing. SDK supplies shared action hashing to MCP; the deployed Gate retains its exact stake policy. Private A configuration stays in the local client.

**Tech Stack:** TypeScript, ethers, MCP stdio, Vitest, Playwright, Release Please, npm trusted publishing, Circle Agent Wallet, Arc Testnet.

**Spec:** User instructions in this session: update SDK/MCP action documentation, inspect omissions, release via workflows, use raised npm versions and verify the real demo; no video.

## Global constraints

- Preserve existing CLI/server sessions; use a fresh unused dApp port.
- Stake 10 USDC; proof fee 0.001 USDC; actual browser approvals.
- SDK types, keys and values remain caller-owned; Gate execution schema is explicit.
- Keep A's address/key out of the service, model, UI, Git and npm package contents.
- Release Please owns versions; SDK must be available on npm before MCP.

### Task 1: Complete action signing and documentation

**Files:** `packages/sdk/src/action.ts`, `flow.ts`, `index.ts`, `types.ts`, SDK README/package metadata; MCP `src/tools.ts`, README/package metadata; `tests/theCircuitDecidesTheSignature.test.ts`, `packages/mcp/tests/tools.test.ts`.

- [x] Add failing SDK cases for invalid shape/root primary type and action on OIDC before any signature.
- [x] Add failing MCP prepare cases for exact typed signature and both hashes, omitted action and wrong circuit; retain Coinbase/OIDC behavior.
- [x] Add shared `hashTypedAction(action)` returning `{domainSeparator,actionHash}` after shape/ethers encoding/root validation, and use it before signing in SDK/MCP.
- [x] Document every action field, JSON numeric strings, arbitrary custom/nested types, full 10-USDC Gate example, user approvals, payment caps, and stepwise signing. Correct stale comments and package metadata.
- [x] Run SDK/MCP typechecks/builds, focused tests, published-file dry-run inspection and independent review.

### Task 2: Release and install consumer packages

**Files:** Release Please-managed manifests/changelogs/locks; `demo/runtime/package.json` and lock; demo unit install/version cases and guides.

- [ ] Commit scoped SDK/MCP fixes and the completed dApp user-action changes; push main without staging old video files/artifacts.
- [ ] Inspect Release Please PR, validate package/manifest/dependency versions and merge after required CI passes.
- [ ] Observe existing SDK and MCP publish workflows; verify registry version, dependency and README content.
- [ ] Update demo consumer pins using npm install exact versions; install fresh packages, verify actual handshake/types/schema and runtime provenance.

### Task 3: Verify and publish actual demo evidence

**Files:** `tests/e2e/dapp-action.test.ts`, `demo/artifacts/user-action-e2e.json`, `demo/README.md`, parent `docs/ops/ai-usage.md` and AI gitlink.

- [ ] Verify adequate wallet/Gateway funds and clean public-service configuration.
- [ ] Execute actual dApp action input, both approvals, discovered guide/npm install/MCP call, proof verification and one 10-USDC stake using newly released packages.
- [ ] Recheck tampering, expiry and replay by eth_call; custom action fixture must fail KYC without payment.
- [ ] Update sanitized evidence/docs with observation times, new versions and actual transaction. Commit/push AI and parent references, report URLs and test results.
