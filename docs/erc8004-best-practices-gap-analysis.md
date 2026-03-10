# ERC-8004 Best Practices Gap Analysis

Comparison of our implementation against [ERC-8004 Best Practices](https://github.com/erc-8004/best-practices).

Last updated: 2026-03-10

---

## Current 8004scan Score (2026-03-10)

**Total: 58.87** | Rank: #3678 (global), #1552 (Base chain) | Completeness: `complete`

| Dimension | Score | Weight | Weighted | Key Factor |
|-----------|-------|--------|----------|------------|
| Service | 0.0 | 25% | 0.0 | Health check never ran yet — domain verification passed but health batch pending |
| Engagement | 14.17 | 30% | 4.25 | 0 user feedback, popularity 28.35 |
| Publisher | 7.33 | 20% | 1.47 | wallet 1.33, validation_bonus 6.0, not certified |
| Compliance | 60.0 | 15% | 9.00 | metadata_completeness 60.0, `is_endpoint_verified: False` in scoring (cached before verification passed) |
| Momentum | 46.33 | 10% | 4.63 | 4 days old, freshness boost 82.66, activity 10.0 |

**Multipliers**: `no_service` penalty applied (0.65x) — still active in current score (score was last calculated at 12:15 UTC, before domain verification passed at 14:10 UTC). `completeness` = 1.0x (complete tier).

**Note**: Domain verification passed 2026-03-10 14:10 UTC but score not recalculated yet. Next scoring batch will reflect `is_endpoint_verified: True` and potentially lift `no_service` penalty if health checks pass.

**Biggest improvement lever**: Service dimension (25% weight, currently 0). After health check batch runs:
1. A2A: 8004scan GETs `/.well-known/agent-card.json` → counts skills → `a2a_quality` populated (top agents get 89-100)
2. MCP: 8004scan sends MCP protocol to `/mcp` → counts tools → `mcp_quality` populated (top agents get 73-97)
3. `no_service` penalty (0.65x) lifted → estimated 35%+ score increase
4. Compliance boost from `is_endpoint_verified: True` already queued for next batch

---

## Rule 1: Name, Image, Description (Required)

| Field | Status | Current Value |
|-------|--------|---------------|
| `name` | PASS | `proveragent.base.eth` |
| `image` | PASS | `{a2aBaseUrl}/icon.png` |
| `description` | PASS | `Autonomous ZK proof generation. ERC-8004 identity. x402 payments. Powered by ZKProofport` |

All three required fields are present and stored on-chain via `data:application/json;base64` tokenURI.

---

## Rule 2: Service Advertisement (Required)

| Service Type | Status | Details |
|-------------|--------|---------|
| MCP | PASS | `{base}/mcp`, version `2025-11-25`, tools: `prove`, `get_supported_circuits`, `get_guide` |
| A2A | PASS | `{base}/.well-known/agent-card.json` (discovery per IA024), version `0.3.0`, skills: `prove`, `get_supported_circuits`, `get_guide`. RPC at `/a2a` |
| web | PASS | `{websiteUrl}` |
| agentWallet (on-chain) | PASS | Auto-set to token owner address on registration |
| agentWallet (off-chain) | PASS | CAIP-10 format in `services` array |
| ENS | PASS | `proveragent.base.eth` transferred to agent wallet |
| DID | PASS | `did:web:{hostname}` — `/.well-known/did.json` endpoint |

### agentWallet Details

The ERC-8004 spec auto-sets `agentWallet` to the token owner's address on registration. The `setAgentWallet()` function is only needed to **change** it to a different address (requires EIP-712 or ERC-1271 signature verification, 5-minute deadline). On token transfer, it resets to zero address.

**On-chain status**: Set to prover wallet address (`0xc5B29033e63A986b601Fe430806A2C9735F2ea97`) automatically.

**Off-chain status**: CAIP-10 entry present in `services` array: `eip155:8453:0xc5B29033e63A986b601Fe430806A2C9735F2ea97`. Fixed 2026-03-09.

---

## Rule 3: Capability Classification — OASF (Recommended)

| Field | Status | Current | Expected |
|-------|--------|---------|----------|
| OASF Domains | PASS | Custom `categories`: `privacy`, `security`, `verification`, `identity` | OASF v0.8.0 taxonomy identifiers |
| OASF Skills | PASS | Custom `capabilities`: `proof_generation`, `proof_verification`, etc. | OASF v0.8.0 skill identifiers |

### OASF Taxonomy

The [Open Agentic Schema Framework v0.8.0](https://schema.oasf.outshift.com/0.8.0) defines standardized skills and domains for agent classification. 8004scan and ecosystem tools use OASF for agent search and categorization.

**Recommended OASF mappings for our agent:**

Domains:
- `technology/blockchain_and_web3`
- `technology/cybersecurity`
- `trust_and_safety/identity_verification`

Skills:
- `security_privacy/encryption_and_data_protection`
- `security_privacy/threat_detection_and_analysis`
- `advanced_reasoning_planning/hypothesis_generation`

**Fix**: Add `domains` and `skills` fields with OASF identifiers to both on-chain metadata (`autoRegister.ts`) and discovery documents (`agentCard.ts`). Keep existing `categories` and `capabilities` for backward compatibility.

**Impact**: Low effort, high visibility. Enables proper categorization in 8004scan and agent directories.

**Note**: 8004scan issues IA027/IA028 warnings for our OASF categories but these do NOT affect scoring. Captain Dackie (service_score: 100) has 10 similar OASF warnings. These are informational only.

---

## Rule 4: On-Chain Registration Confirmation (Required)

| Field | Status | Details |
|-------|--------|---------|
| `registrations` array | PASS | Contains `agentRegistry` (EIP-155 format) + `agentId` |
| `type` field | PASS | `https://eips.ethereum.org/EIPS/eip-8004#registration-v1` |
| `agent-registration.json` | PASS | `/.well-known/agent-registration.json` endpoint |

### Domain Verification (Optional)

Published at `/.well-known/agent-registration.json` with `agentId: 25331` and `agentRegistry: eip155:8453:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`. Fixed 2026-03-09.

**8004scan verify-endpoint API**: `POST /api/v1/agents/verify-endpoint/8453/25331` checks this file for matching registration info. No auth required (per OpenAPI spec). Rate limit: 1 hour cooldown.

---

## Production-Readiness Signals

| Field | Status | Details |
|-------|--------|---------|
| `x402Support` | PASS | `true` (mainnet USDC on Base) |
| `active` (off-chain) | PASS | `"active": true` in tokenURI metadata |
| `active` (on-chain) | PASS | `setMetadata("active", "true")` — on-chain value `0x74727565` (UTF-8 "true") |

Fixed 2026-03-09. Both off-chain (tokenURI) and on-chain (`setMetadata`) active flags are set to `true`. 8004scan WA080 warning resolved.

### agentType

| Field | Status | Details |
|-------|--------|---------|
| `agentType` | PASS | `"service"` — added to on-chain metadata (2026-03-09) |

### 8004scan Endpoint Verification

| Field | Status | Details |
|-------|--------|---------|
| `is_endpoint_verified` | PASS | `true` since 2026-03-10T14:10:49Z |
| `endpoint_last_checked_at` | PASS | `2026-03-10T14:10:49Z` |
| A2A endpoint URL | PASS | `/.well-known/agent-card.json` (card discovery URL per IA024) — 8004scan warns IA024 if `/a2a` RPC URL used directly |
| `agent-registration.json` format | DONE | Was flat object `{agentId, agentRegistry}`, spec requires `{registrations: [{agentId, agentRegistry}]}` — deployed and verified working |
| MCP service field name | DONE | `tools` → `mcpTools` per best practices — deployed |
| A2A service field name | DONE | `skills` → `a2aSkills` per best practices — deployed |
| OASF service entry | DONE | Added as separate service entry (best practices pattern, e.g. Captain Dackie) — deployed |
| `health_status` | PENDING | `None` — health check batch hasn't included our agent yet. Endpoints confirmed working: A2A (3 skills, version 1.0.0), MCP (initialize success, tools+prompts capabilities) |

**Root cause of original verification failure**: `endpoint_verification_error: "zkproofport.com: HTTP 404; ai.zkproofport.app: No matching registration"`.

Two issues (both resolved):
1. **`zkproofport.com: HTTP 404`** — 8004scan checks ALL service endpoint domains for `agent-registration.json`. Our `web` service pointed to `zkproofport.com` which didn't have this file. Fixed by updating `web` service URL to `ai.zkproofport.app` (deployed 2026-03-10, commit 2adedc5).
2. **`ai.zkproofport.app: No matching registration`** — Our `agent-registration.json` returned a flat object `{agentId, agentRegistry}` but the ERC-8004 spec requires `{registrations: [{agentId, agentRegistry}]}`. Format mismatch caused "No matching registration". Fixed in `agentCard.ts` (deployed 2026-03-10, commit 5168438).

**How 8004scan health checks work** (from top-5 agent analysis):
- **A2A**: GETs the registered endpoint URL (`.well-known/agent-card.json`), parses as A2A AgentCard, counts skills. Top agents: quality 89-100.
- **MCP**: Sends MCP protocol requests (`initialize`, `tools/list`) to the registered MCP URL. Counts `tools_count`, `prompts_count`, `has_name`. Top agents: quality 73-97.
- Health checks run as a batch (all top agents checked at same timestamp). Agents are included in batches after `verify-endpoint` is triggered.
- `is_endpoint_verified` (domain verification via `.well-known/agent-registration.json`) is separate from health check results — agents can have health checks without passing domain verification (e.g. Captain Dackie has no `agent-registration.json` at all, yet is healthy).
- **8004scan health check batch timing**: Captain Dackie (rank #1 Base) `health_checked_at: 2026-03-10T13:41:48Z`. Our agent was verified at 14:10 — health check batch may include us in next cycle.

**Timeline**:
- 2026-03-09: `verify-endpoint` first triggered. Verification ran but failed with format mismatch.
- 2026-03-10 ~13:00: `registrations` array fix + `mcpTools`/`a2aSkills` + OASF deployed (commit 5168438).
- 2026-03-10 14:10: Domain verification passed (`is_endpoint_verified: True`).
- 2026-03-10 14:21: `web` endpoint changed to `ai.zkproofport.app` deployed (commit 2adedc5).
- Health check: Pending — awaiting 8004scan batch cycle.

**Note**: 8004scan applies a `no_service` penalty multiplier of 0.65 (35% reduction) to the total score when health checks haven't passed.

---

## Reputation Best Practices

| Practice | Status | Details |
|----------|--------|---------|
| Read feedback (`getSummary`, `readFeedback`, `readAllFeedback`) | PASS | `reputation.ts` — read-only queries implemented |
| Write feedback (`giveFeedback`) | GAP | `handleProofCompleted()` is a no-op placeholder |
| Revoke feedback (`revokeFeedback`) | N/A | No feedback submitted yet |
| Append response (`appendResponse`) | N/A | Agent can respond to received feedback |
| Reliability signal publishing | GAP | No periodic uptime/latency/success-rate signals |
| Revenue signal tracking | GAP | Not implemented |
| Trusted reviewer filtering | N/A | Aggregation is off-chain (8004scan handles this) |

### Feedback Writing

The ERC-8004 Reputation Registry blocks self-feedback (`feedbackSubmitter` cannot be the agent owner/operator). This means we cannot programmatically record proof completion feedback from our own agent.

**Options**:
1. **Client-side feedback**: After successful proof generation, return a feedback prompt URL that the client can use to submit feedback from their own address
2. **External oracle**: Deploy a separate "feedback oracle" service at a different address that monitors proof completions
3. **Leave to 8004scan**: Users rate agents directly on 8004scan (current approach)

### Reliability Signals

Best practice recommends trusted providers publish standardized probes:

| Signal | Tag1 | Tag2 | Value Range |
|--------|------|------|-------------|
| Reachability | `reachability` | `day`/`week`/`month` | 0-100 |
| Uptime | `uptime` | `day`/`week`/`month` | 0-100 (%) |
| Success rate | `successRate` | `day`/`week`/`month` | 0-100 (%) |
| Latency | `latency` | `day`/`week`/`month` | milliseconds |

**Fix (future)**: Create a scheduled worker that calculates metrics from Redis/logs and publishes via the Reputation Registry.

**Impact**: High effort. Requires new infrastructure (metrics collection + publishing worker).

### Revenue Signals

Best practice recommends facilitators publish cumulative revenue totals. Since revenue is not directly computable on-chain universally, this requires a facilitator role.

**Impact**: High effort. Requires x402 facilitator integration for revenue tracking.

---

## Validation Registry

| Practice | Status | Details |
|----------|--------|---------|
| TEE validation submission | PASS | Nitro Attestation → `validationRequest` + `validationResponse` on-chain |
| Response score | PASS | Score `100` (passed) |
| Validation tag | PASS | `tee-attestation` (string type, not bytes32) |
| Attestation retry on failure | PASS | `validationSubmitter.ts` retries up to 3x with backoff on null attestation (fixed 2026-03-09) |
| Independent validator | GAP | Self-validation (agent is both requester and validator) |
| On-chain validation count | PASS | 7+ validations on-chain (latest: tx `0x9003509f...`, response=100, tag=tee-attestation) |

### 8004scan Does NOT Index On-Chain Validations

**Critical finding (2026-03-09)**: 8004scan's `total_validations` metric is an **internal platform feature**, not sourced from on-chain ValidationRegistry events. The 8004scan API note states: "validation system is disabled until the official spec is finalized."

Our 6 on-chain validations at `0x8004Cc8439f36fd5F9F049D9fF86523Df6dAAB58` are correctly stored but invisible to 8004scan scoring. The `validation_bonus: 6.0` in Publisher score comes from 8004scan's internal data.

### Self-Validation Limitation

Currently, `validationSubmitter.ts` uses the agent's own address (`0xc5B29033e63A986b601Fe430806A2C9735F2ea97`) as both requester and validator. TEE attestation provides hardware-level trust (Nitro NSM cryptographic signature).

**Options**:
1. Deploy a standalone TEE verification service at a different address
2. Partner with a third-party validator service
3. Accept current self-validation (TEE hardware guarantee is credible)

**Impact**: Low priority — 8004scan does not currently index on-chain validations regardless.

---

## ERC-8128 Agent Authentication

| Practice | Status | Details |
|----------|--------|---------|
| Signature verification | PASS | `X-Agent-Signature` + `X-Agent-Address` headers verified via EIP-191 |
| On-chain identity lookup | PASS | `balanceOf` + `tokenOfOwnerByIndex` on Identity contract |
| Enforcement | PASSIVE | Never blocks requests; enriches `req.agentIdentity` for logging |

Current implementation is informational only. If access control is needed in the future, add a gate that checks `req.agentIdentity.registeredOnChain`.

---

## Technical Spec Compliance

### Identity Registry

| Function | Status | Notes |
|----------|--------|-------|
| `register(string)` | PASS | Used for initial registration |
| `register(string, MetadataEntry[])` | NOT USED | Could set `active` during registration in a single TX |
| `register()` | NOT USED | Registers without URI |
| `setAgentURI()` | PASS | Metadata URI updates |
| `tokenURI()` | PASS | Read metadata |
| `setMetadata()` | PASS | On-chain key-value metadata (active flag) |
| `getMetadata()` | PASS | Read on-chain key-value metadata |
| `setAgentWallet()` | N/A | Auto-set to owner on registration. Only needed to change wallet |
| `getAgentWallet()` | NOT USED | Could verify wallet is correctly set |
| `unsetAgentWallet()` | N/A | Not needed unless wallet needs clearing |
| `balanceOf()` / `ownerOf()` | PASS | ERC-721 queries |
| `tokenOfOwnerByIndex()` | PASS | ERC-721 Enumerable |

### Reputation Registry

| Function | Status | Notes |
|----------|--------|-------|
| `giveFeedback()` | GAP | ABI defined in `reputation.ts`, not called (self-feedback blocked) |
| `revokeFeedback()` | N/A | No feedback submitted |
| `appendResponse()` | N/A | Agent response to feedback |
| `getSummary()` | PASS | Read-only queries |
| `readFeedback()` | PASS | Read-only queries |
| `readAllFeedback()` | NOT USED | Batch read available |
| `getClients()` | NOT USED | List feedback providers |
| `getLastIndex()` | NOT USED | Get latest feedback index |

### Validation Registry

| Function | Status | Notes |
|----------|--------|-------|
| `validationRequest()` | PASS | TEE attestation submission |
| `validationResponse()` | PASS | Validation response recording |
| `getValidationStatus()` | PASS | Read validation result |
| `getAgentValidations()` | PASS | List agent validations |
| `getSummary()` | NOT USED | Aggregate validation scores |
| `getValidatorRequests()` | NOT USED | List validator's requests |

---

## Action Items (Priority Order)

### P0 — 8004scan Score Impact (highest ROI)

| # | Item | Effort | Status |
|---|------|--------|--------|
| 1 | Fix `agent-registration.json` format (wrap in `registrations` array) | 5 min | DONE (deployed 2026-03-10, verified working) |
| 2 | A2A endpoint uses `/.well-known/agent-card.json` per IA024 | — | PASS (IA024 requires card URL, not RPC URL) |
| 3 | Add `agentType: "service"` to on-chain metadata | 5 min | DONE (2026-03-09) |
| 4 | Use best-practices field names: `mcpTools`, `a2aSkills` | 5 min | DONE (deployed 2026-03-10) |
| 5 | Add OASF as separate service entry (best practices pattern) | 5 min | DONE (deployed 2026-03-10) |
| 6 | Deploy + re-trigger endpoint verification on 8004scan | Manual | DONE — domain verification passed (2026-03-10 14:10 UTC). Health check batch pending. |
| 7 | Apply for publisher certification on 8004scan | Manual | TODO |
| 8 | Wait for 8004scan health check batch to run | Passive | WAITING — health checks run on 8004scan's internal schedule |

### P1 — Quick Wins (completed)

| # | Item | Effort | Status |
|---|------|--------|--------|
| 8 | Add `active: true` to metadata | 5 min | DONE (2026-03-09) |
| 9 | Add `agentWallet` to off-chain `services` array (CAIP-10 format) | 10 min | DONE (2026-03-09) |
| 10 | Add `/.well-known/agent-registration.json` endpoint | 15 min | DONE (2026-03-09) |
| 11 | Add `/.well-known/did.json` endpoint | 15 min | DONE (2026-03-09) |
| 12 | Add OASF `domains` and `skills` to metadata | 30 min | DONE (2026-03-09) |

### P2 — Medium Effort

| # | Item | Effort | Notes |
|---|------|--------|-------|
| 10 | Use `register(string, MetadataEntry[])` overload for atomic registration + active flag | 1-2 hrs | Optimization: single TX instead of two |
| 11 | Add `getAgentWallet()` verification to startup health check | 30 min | Verify on-chain wallet is correctly set |
| 12 | Encourage 8004scan platform feedback/stars | Ongoing | Drives Engagement score (30% weight) |

### P3 — High Effort (future roadmap)

| # | Item | Effort | Notes |
|---|------|--------|-------|
| 13 | Reliability signal publishing (cron job) | 1-2 days | New worker service, metrics collection |
| 14 | Independent TEE validator service | 2-3 days | Low priority — 8004scan doesn't index on-chain validations |
| 15 | Client-facing feedback prompt after proof completion | 1 day | Return feedback URL to clients |
| 16 | Revenue signal tracking via x402 facilitator | 1-2 days | Requires facilitator integration |

---

## References

- [ERC-8004 Best Practices README](https://github.com/erc-8004/best-practices/blob/main/README.md)
- [Registration Best Practices](https://github.com/erc-8004/best-practices/blob/main/Registration.md) — Four Golden Rules
- [Reputation Best Practices](https://github.com/erc-8004/best-practices/blob/main/Reputation.md) — Feedback and signal publishing
- [ERC-8004 Technical Spec (Draft)](https://github.com/erc-8004/best-practices/blob/main/src/ERC8004SPEC.md)
- [8004scan OpenAPI Spec](https://api.8004scan.io/openapi.json) — Full API (v0.4.41, by Alt Research)
- [8004scan Score API](https://api.8004scan.io/api/v1/agents/scores/v5/8453/25331) — Live score for our agent
- [OASF v0.8.0 Schema](https://schema.oasf.outshift.com/0.8.0) — Agent capability taxonomy
- [OASF GitHub](https://github.com/agntcy/oasf/tree/v0.8.0)
- [8004scan](https://8004scan.io) — Agent explorer and metadata validator
