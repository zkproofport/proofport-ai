# ERC-8004 Best Practices Gap Analysis

Comparison of our implementation against [ERC-8004 Best Practices](https://github.com/erc-8004/best-practices).

Last updated: 2026-03-09

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
| A2A | PASS | `{base}/a2a` (JSON-RPC endpoint), version `0.3.0`, skills: `prove`, `get_supported_circuits`, `get_guide` |
| web | PASS | `{websiteUrl}` |
| agentWallet (on-chain) | PASS | Auto-set to token owner address on registration |
| agentWallet (off-chain) | PASS | CAIP-10 format in `services` array |
| ENS | PASS | `proveragent.base.eth` transferred to agent wallet |
| DID | PASS | `did:web:{hostname}` — `/.well-known/did.json` endpoint |

### agentWallet Details

The ERC-8004 spec auto-sets `agentWallet` to the token owner's address on registration. The `setAgentWallet()` function is only needed to **change** it to a different address (requires EIP-712 or ERC-1271 signature verification, 5-minute deadline). On token transfer, it resets to zero address.

**On-chain status**: Already set to our prover wallet address (`0x5A3E649208Ae15ec52496c1Ae23b2Ff89Ac02f0c`) automatically.

**Off-chain GAP**: The `services` array in tokenURI metadata should include an `agentWallet` entry in CAIP-10 format:

```json
{ "name": "agentWallet", "endpoint": "eip155:8453:0x5A3E649208Ae15ec52496c1Ae23b2Ff89Ac02f0c" }
```

**Fix**: Add `agentWallet` entry to `services` array in `autoRegister.ts`.

**Impact**: Low effort. Enables on-chain wallet resolution for agent-to-agent payments.

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

---

## Rule 4: On-Chain Registration Confirmation (Required)

| Field | Status | Details |
|-------|--------|---------|
| `registrations` array | PASS | Contains `agentRegistry` (EIP-155 format) + `agentId` |
| `type` field | PASS | `https://eips.ethereum.org/EIPS/eip-8004#registration-v1` |
| `agent-registration.json` | PASS | `/.well-known/agent-registration.json` endpoint |

### Domain Verification (Optional)

The best practice **optionally** recommends publishing a registration file at:

```
https://{endpoint-domain}/.well-known/agent-registration.json
```

This provides a bidirectional link between the on-chain identity and the service endpoint.

**Fix**: Add endpoint in `agentCard.ts`:

```typescript
app.get('/.well-known/agent-registration.json', (req, res) => {
  res.json({
    agentId: tokenId.toString(),
    agentRegistry: `eip155:${chainId}:${identityContractAddress}`
  });
});
```

**Impact**: Low effort. Adds trust signal for 8004scan, though not strictly required.

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
| `is_endpoint_verified` | GAP | `false` — 8004scan has never verified endpoints |
| `endpoint_last_checked_at` | GAP | `null` — health check never triggered |
| A2A endpoint URL | FIXED | Changed from card URL (`/.well-known/agent-card.json`) to RPC endpoint (`/a2a`) — 2026-03-09 |

**Root cause of Service=0**: 8004scan probes the registered A2A endpoint as a JSON-RPC server. The card URL does not respond to RPC calls, so `a2a_quality=0`. Additionally, endpoint verification has never been triggered (`POST /api/v1/agents/verify-endpoint/8453/25331` requires auth).

**Note**: 8004scan applies a `no_service` penalty multiplier of 0.65 (35% reduction) to the total score when service health check has not passed.

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
| Independent validator | GAP | Self-validation (agent is both requester and validator) |
| On-chain validation count | PASS | 6 validations on-chain (validation #5: response=100, tag=tee-attestation) |

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
| 1 | Fix A2A service endpoint to `/a2a` (was card URL) | 5 min | DONE (2026-03-09) |
| 2 | Add `agentType: "service"` to on-chain metadata | 5 min | DONE (2026-03-09) |
| 3 | Trigger endpoint verification on 8004scan | Manual | TODO (needs auth token) |
| 4 | Apply for publisher certification on 8004scan | Manual | TODO |

### P1 — Quick Wins (completed)

| # | Item | Effort | Status |
|---|------|--------|--------|
| 5 | Add `active: true` to metadata | 5 min | DONE (2026-03-09) |
| 6 | Add `agentWallet` to off-chain `services` array (CAIP-10 format) | 10 min | DONE (2026-03-09) |
| 7 | Add `/.well-known/agent-registration.json` endpoint | 15 min | DONE (2026-03-09) |
| 8 | Add `/.well-known/did.json` endpoint | 15 min | DONE (2026-03-09) |
| 9 | Add OASF `domains` and `skills` to metadata | 30 min | DONE (2026-03-09) |

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
