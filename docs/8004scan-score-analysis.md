# 8004scan Agent Score Analysis

## 1. Current Scores (2026-03-09, from API)

- **Agent**: `proveragent.base.eth` on [8004scan.io](https://8004scan.io)
- **Agent ID**: `8453:0x8004a169fb4a3325136eb29fa0ceb6d2e539a432:25331`
- **Owner/Wallet**: `0xc5B29033e63A986b601Fe430806A2C9735F2ea97`
- **Total Score**: 58.81 / 100 (Rank #3562, Chain Rank #1547)
- **Scoring Algorithm**: v5.1 (`v5_dimension_restructure`)
- **API**: `GET https://api.8004scan.io/api/v1/agents/8453/25331`

### Score Breakdown (5 Dimensions)

| Dimension | Score | Weight | Weighted | Details |
|-----------|-------|--------|----------|---------|
| Engagement | 12.64 | 30% | 3.79 | popularity=25.28, feedback=0, satisfaction=0 |
| Service | **0.0** | 25% | **0.0** | health_status=null, endpoint never checked |
| Publisher | 7.0 | 20% | 1.40 | wallet=1.0, validation_bonus=6.0, not certified |
| Compliance | 60.0 | 15% | 9.0 | metadata_completeness=60%, endpoint_verified=false |
| Momentum | 48.34 | 10% | 4.83 | freshness=86.69, activity=10.0 |

### Multipliers

| Multiplier | Value | Applied | Notes |
|-----------|-------|---------|-------|
| `completeness` | 1.0 | Yes | Tier: "complete" |
| `no_service` | 0.65 | **Yes** | 35% penalty because service health check never passed |

### Stats

| Metric | Value |
|--------|-------|
| Total Feedbacks | 0 |
| Total Validations | 0 (platform metric, not on-chain) |
| Total Chats | 0 |
| Total Messages | 0 |
| Total Stars | 1 |
| Total Watches | 0 |

---

## 2. Root Cause Analysis

### Service = 0 (Most Impactful Gap)

**Root cause**: A2A endpoint was registered as the discovery card URL (`/.well-known/agent-card.json`) instead of the JSON-RPC endpoint (`/a2a`). The 8004scan indexer probes the registered endpoint as an A2A server — the card URL does not respond to JSON-RPC calls.

Details from API:
- `has_a2a: true`, `has_mcp: true` — metadata lists both services
- `a2a_stats: {}`, `mcp_stats: {}` — probe returned nothing
- `a2a_quality: 0.0`, `mcp_quality: 0.0` — quality scores are 0
- `health_status: null` — health check has never run
- `endpoint_last_checked_at: null` — endpoint verification never triggered

**Fix applied (2026-03-09)**:
- Changed A2A service endpoint from `/.well-known/agent-card.json` to `/a2a` in `autoRegister.ts` and `agentCard.ts`
- Added `agentType: "service"` to on-chain metadata
- Deploy required to push metadata update on-chain

### Total Validations = 0

**Root cause**: 8004scan does NOT index on-chain ValidationRegistry contract events. Their `total_validations` metric is an internal platform feature (currently disabled). Our 6 on-chain validations at `0x8004Cc8439f36fd5F9F049D9fF86523Df6dAAB58` are not read by the indexer.

The `validation_bonus: 6.0` in Publisher score comes from 8004scan's internal platform data, not from our ValidationRegistry.

**Status**: Nothing to fix — platform limitation.

### Compliance = 60 (metadata_completeness)

- `parse_status: "success"`, `error_count: 0`, `warning_count: 0`
- `metadata_completeness_score: 60.0` — some expected fields missing
- `is_endpoint_verified: false` — domain verification not triggered

Missing/incomplete fields likely include: `agentType` (now added), endpoint verification, possibly IPFS/Arweave metadata URI.

### Engagement = 12.64

- `feedback_count: 0` — no 8004scan platform feedback
- `popularity_score: 25.28` — from 1 star and page views
- Self-feedback blocked by Reputation contract (correct behavior)

### Publisher = 7.0

- `wallet_score: 1.0` — owner wallet has minimal on-chain activity
- `is_certified: false` — no publisher certification
- Certification requires applying via `POST /api/v1/users/me/certifications/publisher/apply`

### Momentum = 48.34

- `freshness_score: 86.69` — agent is 3 days old, high freshness
- `activity_score: 10.0` — some recent activity
- Freshness decays over time without new on-chain activity

---

## 3. Action Items (Updated Priority)

| # | Action | Dimension | Expected Impact | Effort | Status |
|---|--------|-----------|----------------|--------|--------|
| 1 | Fix A2A endpoint to `/a2a` (not card URL) | Service | 0 -> 30-50+ | Low | DONE (2026-03-09) |
| 2 | Add `agentType: "service"` to metadata | Compliance | +5-10 | Low | DONE (2026-03-09) |
| 3 | Trigger endpoint verification on 8004scan | Service + Compliance | Service unlock + compliance boost | Low | TODO (manual API call) |
| 4 | Apply for publisher certification | Publisher | 7 -> 20-40 | Low | TODO (manual application) |
| 5 | Encourage 8004scan platform feedback | Engagement | 12 -> 30+ | Medium | TODO |
| 6 | Periodic metadata updates | Momentum | Maintain freshness | Low | TODO |
| 7 | SDK feedback flow for clients | Engagement | Long-term | High | Future |

### Action 3: Trigger Endpoint Verification

```bash
# Requires auth token from 8004scan
POST https://api.8004scan.io/api/v1/agents/verify-endpoint/8453/25331
```

This triggers 8004scan to:
1. Check `/.well-known/agent-registration.json` for domain-identity link
2. Probe MCP and A2A endpoints for health
3. Update `is_endpoint_verified` flag

### Action 4: Publisher Certification

```bash
POST https://api.8004scan.io/api/v1/users/me/certifications/publisher/apply
```

Certification tiers: COMMUNITY, VERIFIED, OFFICIAL. Each adds a `cert_bonus` to Publisher score.

---

## 4. On-Chain Validation Status

Despite 8004scan not indexing on-chain validations, our validations are correctly stored:

```
Total on-chain validations: 6
Validation 0-4: response=0, tag="" (failed attempts before ABI fix)
Validation 5: response=100, tag="tee-attestation" (SUCCESS)
Validator: 0xc5B29033e63A986b601Fe430806A2C9735F2ea97 (self-validation)
```

TEE badge is displayed on 8004scan profile.

---

## 5. API Endpoints

| Endpoint | Purpose |
|----------|---------|
| `GET /api/v1/agents/8453/25331` | Full agent detail + scores |
| `GET /api/v1/agents/scores/v5/8453/25331` | Score breakdown only |
| `GET /api/v1/agents/stats/8453/25331` | Stats (feedbacks, validations, stars) |
| `POST /api/v1/agents/verify-endpoint/8453/25331` | Trigger endpoint verification |
| `GET /openapi.json` | Full OpenAPI spec |

Base URL: `https://api.8004scan.io`

---

## 6. Contract Addresses

### Mainnet (Base, chainId 8453)

| Contract | Address |
|---------|------|
| Identity | `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` |
| Reputation | `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63` |
| Validation | `0x8004Cc8439f36fd5F9F049D9fF86523Df6dAAB58` |

### Sepolia (Base Sepolia, chainId 84532)

| Contract | Address |
|---------|------|
| Identity | `0x8004A818BFB912233c491871b3d84c89A494BD9e` |
| Reputation | `0x8004B663056A597Dffe9eCcC1965A193B7388713` |
| Validation | `0x8004Cb1BF31DAf7788923b405b754f57acEB4272` |

---

## 7. References

- [8004scan OpenAPI Spec](https://api.8004scan.io/openapi.json) — Full API spec (v0.4.41, built by Alt Research)
- [ERC-8004 Best Practices](https://github.com/erc-8004/best-practices) — Registration, Reputation guidelines
- [8004scan.io](https://8004scan.io) — Agent explorer platform
