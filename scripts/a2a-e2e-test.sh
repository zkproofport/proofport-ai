#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# A2A Docker Stack E2E Tests
# Runs automated HTTP tests against the live Docker stack (localhost:4002)
#
# Prerequisites:
#   ./scripts/a2a-test.sh   (start stack with Phoenix + a2a-ui)
#   OR
#   docker compose up --build -d   (start base stack only)
#
# Usage:
#   ./scripts/a2a-e2e-test.sh          # Run all tests
#   ./scripts/a2a-e2e-test.sh --quick  # Skip Phoenix trace check
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

BASE_URL="${A2A_BASE_URL:-http://localhost:4002}"
PHOENIX_URL="${PHOENIX_URL:-http://localhost:6006}"
QUICK_MODE=false

if [[ "${1:-}" == "--quick" ]]; then
  QUICK_MODE=true
fi

# ─── Helpers ─────────────────────────────────────────────────────────────────

PASS=0
FAIL=0
TOTAL=0

pass() {
  PASS=$((PASS + 1))
  TOTAL=$((TOTAL + 1))
  echo "  PASS: $1"
}

fail() {
  FAIL=$((FAIL + 1))
  TOTAL=$((TOTAL + 1))
  echo "  FAIL: $1"
  if [[ -n "${2:-}" ]]; then
    echo "        $2"
  fi
}

assert_status() {
  local actual="$1"
  local expected="$2"
  local name="$3"
  if [[ "$actual" == "$expected" ]]; then
    pass "$name"
  else
    fail "$name" "expected HTTP $expected, got $actual"
  fi
}

assert_json_field() {
  local json="$1"
  local field="$2"
  local expected="$3"
  local name="$4"
  local actual
  actual=$(echo "$json" | jq -r "$field" 2>/dev/null || echo "PARSE_ERROR")
  if [[ "$actual" == "$expected" ]]; then
    pass "$name"
  else
    fail "$name" "expected '$expected', got '$actual'"
  fi
}

assert_json_exists() {
  local json="$1"
  local field="$2"
  local name="$3"
  local actual
  actual=$(echo "$json" | jq -e "$field" >/dev/null 2>&1 && echo "exists" || echo "missing")
  if [[ "$actual" == "exists" ]]; then
    pass "$name"
  else
    fail "$name" "field $field not found"
  fi
}

# ─── Connectivity Check ─────────────────────────────────────────────────────

echo ""
echo "=== A2A Docker Stack E2E Tests ==="
echo "Target: $BASE_URL"
echo ""

echo "[1/6] Health Check"
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$BASE_URL/health" 2>/dev/null || echo "000")
if [[ "$HTTP_CODE" == "000" ]]; then
  echo "  FAIL: Cannot connect to $BASE_URL"
  echo "  Is the Docker stack running? Start with: ./scripts/a2a-test.sh"
  exit 1
fi
HEALTH=$(curl -s "$BASE_URL/health")
assert_status "$HTTP_CODE" "200" "GET /health returns 200"
assert_json_field "$HEALTH" '.status' 'healthy' "health status is 'healthy'"
assert_json_field "$HEALTH" '.service' 'proofport-ai' "service name is 'proofport-ai'"

# ─── A2A Agent Card at standard URL ──────────────────────────────────────────

echo ""
echo "[2/6] A2A Agent Card (/.well-known/agent.json)"
AGENT_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$BASE_URL/.well-known/agent.json")
AGENT=$(curl -s "$BASE_URL/.well-known/agent.json")
assert_status "$AGENT_CODE" "200" "GET /.well-known/agent.json returns 200"
assert_json_field "$AGENT" '.name' 'proveragent.eth' "agent name is 'proveragent.eth'"
assert_json_field "$AGENT" '.protocolVersion' '0.3.0' "protocol version is 0.3.0"
assert_json_field "$AGENT" '.preferredTransport' 'JSONRPC' "preferred transport is JSONRPC"
assert_json_exists "$AGENT" '.skills' "has skills array"
assert_json_exists "$AGENT" '.capabilities' "has capabilities object"

# ─── A2A Agent Card ──────────────────────────────────────────────────────────

echo ""
echo "[3/6] A2A Agent Card (/.well-known/agent-card.json)"
A2A_CARD_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$BASE_URL/.well-known/agent-card.json")
A2A_CARD=$(curl -s "$BASE_URL/.well-known/agent-card.json")
assert_status "$A2A_CARD_CODE" "200" "GET /.well-known/agent-card.json returns 200"
assert_json_field "$A2A_CARD" '.name' 'proveragent.eth' "A2A card name is 'proveragent.eth'"
assert_json_field "$A2A_CARD" '.protocolVersion' '0.3.0' "protocol version is 0.3.0"
assert_json_field "$A2A_CARD" '.preferredTransport' 'JSONRPC' "preferred transport is JSONRPC"
assert_json_exists "$A2A_CARD" '.skills' "has skills array"

SKILL_COUNT=$(echo "$A2A_CARD" | jq '.skills | length')
if [[ "$SKILL_COUNT" == "3" ]]; then
  pass "has exactly 3 skills"
else
  fail "has exactly 3 skills" "got $SKILL_COUNT"
fi

# Check each skill exists
for SKILL_ID in generate_proof verify_proof get_supported_circuits; do
  FOUND=$(echo "$A2A_CARD" | jq -r ".skills[] | select(.id == \"$SKILL_ID\") | .id" 2>/dev/null)
  if [[ "$FOUND" == "$SKILL_ID" ]]; then
    pass "skill '$SKILL_ID' present"
  else
    fail "skill '$SKILL_ID' present" "not found in skills array"
  fi
done

# ─── A2A message/send — Text inference (get_supported_circuits) ──────────────

echo ""
echo "[4/6] A2A message/send — Text: 'list supported circuits'"
MSG_SEND_RESP=$(curl -s -X POST "$BASE_URL/a2a" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "message/send",
    "params": {
      "message": {
        "role": "user",
        "parts": [{"kind": "text", "text": "list supported circuits"}]
      }
    }
  }')
assert_json_field "$MSG_SEND_RESP" '.jsonrpc' '2.0' "response is JSON-RPC 2.0"
assert_json_field "$MSG_SEND_RESP" '.id' '1' "response id matches request"

# Check for successful result (not error)
HAS_ERROR=$(echo "$MSG_SEND_RESP" | jq 'has("error")' 2>/dev/null || echo "true")
if [[ "$HAS_ERROR" == "false" ]]; then
  pass "no JSON-RPC error"
else
  ERROR_MSG=$(echo "$MSG_SEND_RESP" | jq -r '.error.message // "unknown"' 2>/dev/null)
  fail "no JSON-RPC error" "error: $ERROR_MSG"
fi

# Check task completed with artifacts
TASK_STATE=$(echo "$MSG_SEND_RESP" | jq -r '.result.status.state // empty' 2>/dev/null)
if [[ "$TASK_STATE" == "completed" ]]; then
  pass "task state is 'completed'"
else
  fail "task state is 'completed'" "got '$TASK_STATE'"
fi

ARTIFACT_COUNT=$(echo "$MSG_SEND_RESP" | jq '.result.artifacts | length' 2>/dev/null || echo "0")
if [[ "$ARTIFACT_COUNT" -gt 0 ]]; then
  pass "response contains artifacts ($ARTIFACT_COUNT)"
else
  fail "response contains artifacts" "got 0 artifacts"
fi

# ─── A2A message/send — DataPart (get_supported_circuits) ───────────────────

echo ""
echo "[5/6] A2A message/send — DataPart: skill='get_supported_circuits'"
DATA_SEND_RESP=$(curl -s -X POST "$BASE_URL/a2a" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 2,
    "method": "message/send",
    "params": {
      "message": {
        "role": "user",
        "parts": [{
          "kind": "data",
          "mimeType": "application/json",
          "data": {
            "skill": "get_supported_circuits",
            "chainId": "84532"
          }
        }]
      }
    }
  }')
assert_json_field "$DATA_SEND_RESP" '.jsonrpc' '2.0' "DataPart response is JSON-RPC 2.0"
assert_json_field "$DATA_SEND_RESP" '.id' '2' "DataPart response id matches"

DATA_HAS_ERROR=$(echo "$DATA_SEND_RESP" | jq 'has("error")' 2>/dev/null || echo "true")
if [[ "$DATA_HAS_ERROR" == "false" ]]; then
  pass "DataPart: no JSON-RPC error"
else
  ERROR_MSG=$(echo "$DATA_SEND_RESP" | jq -r '.error.message // "unknown"' 2>/dev/null)
  fail "DataPart: no JSON-RPC error" "error: $ERROR_MSG"
fi

DATA_TASK_STATE=$(echo "$DATA_SEND_RESP" | jq -r '.result.status.state // empty' 2>/dev/null)
if [[ "$DATA_TASK_STATE" == "completed" ]]; then
  pass "DataPart: task state is 'completed'"
else
  fail "DataPart: task state is 'completed'" "got '$DATA_TASK_STATE'"
fi

# Verify circuit data in artifact
CIRCUIT_IDS=$(echo "$DATA_SEND_RESP" | jq -r '.result.artifacts[0].parts[0].data.circuits[]?.id // empty' 2>/dev/null)
if echo "$CIRCUIT_IDS" | grep -q "coinbase_attestation"; then
  pass "DataPart: coinbase_attestation circuit present"
else
  fail "DataPart: coinbase_attestation circuit present" "not found in response"
fi

# ─── A2A Error Handling ──────────────────────────────────────────────────────

echo ""
echo "[5b] A2A Error Handling"

# Invalid method
ERR_METHOD=$(curl -s -X POST "$BASE_URL/a2a" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":3,"method":"invalid/method","params":{}}')
ERR_CODE=$(echo "$ERR_METHOD" | jq -r '.error.code // empty' 2>/dev/null)
if [[ "$ERR_CODE" == "-32601" ]]; then
  pass "invalid method returns -32601"
else
  fail "invalid method returns -32601" "got code '$ERR_CODE'"
fi

# Invalid skill
ERR_SKILL=$(curl -s -X POST "$BASE_URL/a2a" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":4,"method":"message/send","params":{"message":{"role":"user","parts":[{"kind":"data","mimeType":"application/json","data":{"skill":"nonexistent"}}]}}}')
ERR_SKILL_CODE=$(echo "$ERR_SKILL" | jq -r '.error.code // empty' 2>/dev/null)
if [[ "$ERR_SKILL_CODE" == "-32602" ]]; then
  pass "invalid skill returns -32602"
else
  fail "invalid skill returns -32602" "got code '$ERR_SKILL_CODE'"
fi

# Missing message
ERR_MSG=$(curl -s -X POST "$BASE_URL/a2a" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":5,"method":"message/send","params":{}}')
ERR_MSG_CODE=$(echo "$ERR_MSG" | jq -r '.error.code // empty' 2>/dev/null)
if [[ "$ERR_MSG_CODE" == "-32602" ]]; then
  pass "missing message returns -32602"
else
  fail "missing message returns -32602" "got code '$ERR_MSG_CODE'"
fi

# ─── Phoenix Trace Check (optional) ─────────────────────────────────────────

echo ""
if [[ "$QUICK_MODE" == "true" ]]; then
  echo "[6/6] Phoenix Trace Check — SKIPPED (--quick mode)"
else
  echo "[6/6] Phoenix Trace Check"
  PHOENIX_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$PHOENIX_URL/healthz" 2>/dev/null || echo "000")
  if [[ "$PHOENIX_CODE" == "200" ]]; then
    pass "Phoenix is reachable at $PHOENIX_URL"

    # Wait for traces to flush
    sleep 2

    # Check if any traces exist (Phoenix REST API)
    PROJECTS=$(curl -s "$PHOENIX_URL/v1/projects" 2>/dev/null || echo "{}")
    PROJECT_COUNT=$(echo "$PROJECTS" | jq '.data | length' 2>/dev/null || echo "0")
    if [[ "$PROJECT_COUNT" -gt 0 ]]; then
      pass "Phoenix has projects ($PROJECT_COUNT)"
    else
      fail "Phoenix has projects" "no projects found (traces may not have flushed yet)"
    fi
  else
    echo "  SKIP: Phoenix not reachable at $PHOENIX_URL (run with a2a-test.sh for full stack)"
  fi
fi

# ─── Summary ─────────────────────────────────────────────────────────────────

echo ""
echo "═══════════════════════════════════════"
echo "  Results: $PASS passed, $FAIL failed (total: $TOTAL)"
echo "═══════════════════════════════════════"
echo ""

if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
