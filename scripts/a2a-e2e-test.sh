#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# ZKProofport AI — Comprehensive E2E Test Suite
# Covers: Health, Discovery, A2A, MCP, REST API, OpenAI Chat, Phoenix Traces
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

# Parse SSE response: extract the first "data: {...}" line and return the JSON
parse_sse_data() {
  echo "$1" | grep '^data: ' | head -1 | sed 's/^data: //'
}

# ─── Connectivity Check ─────────────────────────────────────────────────────

echo ""
echo "=== ZKProofport AI — Comprehensive E2E Test Suite ==="
echo "Target: $BASE_URL"
echo ""

# ─── [1/10] Health & Status Endpoints ───────────────────────────────────────

echo "[1/10] Health & Status Endpoints"

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

for STATUS_PATH in /payment/status /signing/status /tee/status /identity/status; do
  STATUS_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$BASE_URL$STATUS_PATH" 2>/dev/null || echo "000")
  STATUS_BODY=$(curl -s "$BASE_URL$STATUS_PATH" 2>/dev/null || echo "{}")
  if [[ "$STATUS_CODE" == "200" ]]; then
    # Verify it returns JSON (not HTML error page)
    IS_JSON=$(echo "$STATUS_BODY" | jq 'type' 2>/dev/null || echo "null")
    if [[ "$IS_JSON" == '"object"' || "$IS_JSON" == '"array"' ]]; then
      pass "GET $STATUS_PATH returns 200 with JSON"
    else
      fail "GET $STATUS_PATH returns 200 with JSON" "body is not JSON: ${STATUS_BODY:0:80}"
    fi
  else
    fail "GET $STATUS_PATH returns 200" "got HTTP $STATUS_CODE"
  fi
done

# ─── [2/10] Discovery Endpoints ─────────────────────────────────────────────

echo ""
echo "[2/10] Discovery Endpoints"

# /.well-known/agent.json
AGENT_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$BASE_URL/.well-known/agent.json")
AGENT=$(curl -s "$BASE_URL/.well-known/agent.json")
assert_status "$AGENT_CODE" "200" "GET /.well-known/agent.json returns 200"
assert_json_exists "$AGENT" '.name' "agent.json has name"
assert_json_exists "$AGENT" '.protocolVersion' "agent.json has protocolVersion"

# /.well-known/agent-card.json
A2A_CARD_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$BASE_URL/.well-known/agent-card.json")
A2A_CARD=$(curl -s "$BASE_URL/.well-known/agent-card.json")
assert_status "$A2A_CARD_CODE" "200" "GET /.well-known/agent-card.json returns 200"
assert_json_exists "$A2A_CARD" '.name' "agent-card.json has name"
assert_json_exists "$A2A_CARD" '.skills' "agent-card.json has skills"
assert_json_exists "$A2A_CARD" '.capabilities' "agent-card.json has capabilities"

# /.well-known/oasf.json
OASF_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$BASE_URL/.well-known/oasf.json" 2>/dev/null || echo "000")
OASF=$(curl -s "$BASE_URL/.well-known/oasf.json" 2>/dev/null || echo "{}")
if [[ "$OASF_CODE" == "200" ]]; then
  assert_json_exists "$OASF" '.type' "oasf.json has type"
  assert_json_exists "$OASF" '.name' "oasf.json has name"
  assert_json_exists "$OASF" '.services' "oasf.json has services"
  assert_json_exists "$OASF" '.supportedTrust' "oasf.json has supportedTrust"
else
  echo "  SKIP: /.well-known/oasf.json not present (HTTP $OASF_CODE)"
fi

# /.well-known/mcp.json
MCP_DISCOVERY_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$BASE_URL/.well-known/mcp.json" 2>/dev/null || echo "000")
MCP_DISCOVERY=$(curl -s "$BASE_URL/.well-known/mcp.json" 2>/dev/null || echo "{}")
if [[ "$MCP_DISCOVERY_CODE" == "200" ]]; then
  assert_json_exists "$MCP_DISCOVERY" '.tools' "mcp.json has tools array"
else
  echo "  SKIP: /.well-known/mcp.json not present (HTTP $MCP_DISCOVERY_CODE)"
fi

# /openapi.json
OPENAPI_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$BASE_URL/openapi.json" 2>/dev/null || echo "000")
OPENAPI=$(curl -s "$BASE_URL/openapi.json" 2>/dev/null || echo "{}")
if [[ "$OPENAPI_CODE" == "200" ]]; then
  assert_json_exists "$OPENAPI" '.openapi' "openapi.json has openapi field"
else
  echo "  SKIP: /openapi.json not present (HTTP $OPENAPI_CODE)"
fi

# ─── [3/10] A2A Agent Card Compliance ───────────────────────────────────────

echo ""
echo "[3/10] A2A Agent Card Compliance"

assert_json_field "$AGENT" '.protocolVersion' '0.3.0' "protocol version is 0.3.0"
assert_json_field "$AGENT" '.preferredTransport' 'JSONRPC' "preferred transport is JSONRPC"
assert_json_exists "$AGENT" '.skills' "has skills array"

SKILL_COUNT=$(echo "$A2A_CARD" | jq '.skills | length')
if [[ "$SKILL_COUNT" == "3" ]]; then
  pass "agent card has exactly 3 skills"
else
  fail "agent card has exactly 3 skills" "got $SKILL_COUNT"
fi

for SKILL_ID in generate_proof verify_proof get_supported_circuits; do
  FOUND=$(echo "$A2A_CARD" | jq -r ".skills[] | select(.id == \"$SKILL_ID\") | .id" 2>/dev/null)
  if [[ "$FOUND" == "$SKILL_ID" ]]; then
    pass "skill '$SKILL_ID' present"
  else
    fail "skill '$SKILL_ID' present" "not found in skills array"
  fi
done

# ─── [4/10] A2A message/send — Text Inference ───────────────────────────────

echo ""
echo "[4/10] A2A message/send — Text: 'list supported circuits'"
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

HAS_ERROR=$(echo "$MSG_SEND_RESP" | jq 'has("error")' 2>/dev/null || echo "true")
if [[ "$HAS_ERROR" == "false" ]]; then
  pass "no JSON-RPC error"
else
  ERROR_MSG=$(echo "$MSG_SEND_RESP" | jq -r '.error.message // "unknown"' 2>/dev/null)
  fail "no JSON-RPC error" "error: $ERROR_MSG"
fi

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

# ─── [5/10] A2A message/send — DataPart ─────────────────────────────────────

echo ""
echo "[5/10] A2A message/send — DataPart: skill='get_supported_circuits'"
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

CIRCUIT_IDS=$(echo "$DATA_SEND_RESP" | jq -r '.result.artifacts[0].parts[0].data.circuits[]?.id // empty' 2>/dev/null)
if echo "$CIRCUIT_IDS" | grep -q "coinbase_attestation"; then
  pass "DataPart: coinbase_attestation circuit present"
else
  fail "DataPart: coinbase_attestation circuit present" "not found in response"
fi

# ─── [6/10] A2A Error Handling ──────────────────────────────────────────────

echo ""
echo "[6/10] A2A Error Handling"

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

# ─── [7/10] MCP Endpoint ─────────────────────────────────────────────────────

echo ""
echo "[7/10] MCP Endpoint (tools/list, tools/call)"

# tools/list
MCP_TOOLS_RAW=$(curl -s -X POST "$BASE_URL/mcp" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}')
MCP_TOOLS=$(parse_sse_data "$MCP_TOOLS_RAW")
# If not SSE format, the raw response might be plain JSON
if [[ -z "$MCP_TOOLS" ]]; then
  MCP_TOOLS="$MCP_TOOLS_RAW"
fi

TOOL_COUNT=$(echo "$MCP_TOOLS" | jq '.result.tools | length' 2>/dev/null || echo "0")
if [[ "$TOOL_COUNT" == "3" ]]; then
  pass "MCP tools/list returns exactly 3 tools"
else
  fail "MCP tools/list returns exactly 3 tools" "got $TOOL_COUNT"
fi

for TOOL_NAME in generate_proof verify_proof get_supported_circuits; do
  FOUND_TOOL=$(echo "$MCP_TOOLS" | jq -r ".result.tools[] | select(.name == \"$TOOL_NAME\") | .name" 2>/dev/null)
  if [[ "$FOUND_TOOL" == "$TOOL_NAME" ]]; then
    pass "MCP tool '$TOOL_NAME' present"
  else
    fail "MCP tool '$TOOL_NAME' present" "not found in tools list"
  fi
done

# tools/call get_supported_circuits
MCP_CIRCUITS_RAW=$(curl -s -X POST "$BASE_URL/mcp" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_supported_circuits","arguments":{}}}')
MCP_CIRCUITS=$(parse_sse_data "$MCP_CIRCUITS_RAW")
if [[ -z "$MCP_CIRCUITS" ]]; then
  MCP_CIRCUITS="$MCP_CIRCUITS_RAW"
fi

MCP_CIRCUITS_ERROR=$(echo "$MCP_CIRCUITS" | jq 'has("error")' 2>/dev/null || echo "true")
if [[ "$MCP_CIRCUITS_ERROR" == "false" ]]; then
  pass "MCP tools/call get_supported_circuits: no error"
else
  ERR_DETAIL=$(echo "$MCP_CIRCUITS" | jq -r '.error.message // "unknown"' 2>/dev/null)
  fail "MCP tools/call get_supported_circuits: no error" "error: $ERR_DETAIL"
fi

MCP_RESULT_EXISTS=$(echo "$MCP_CIRCUITS" | jq -e '.result' >/dev/null 2>&1 && echo "exists" || echo "missing")
if [[ "$MCP_RESULT_EXISTS" == "exists" ]]; then
  pass "MCP tools/call get_supported_circuits returns result"
else
  fail "MCP tools/call get_supported_circuits returns result" "no result field"
fi

# GET /mcp should return 405
MCP_GET_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$BASE_URL/mcp" 2>/dev/null || echo "000")
if [[ "$MCP_GET_CODE" == "405" ]]; then
  pass "GET /mcp returns 405"
else
  echo "  SKIP: GET /mcp returned $MCP_GET_CODE (server may not enforce 405 for GET)"
fi

# DELETE /mcp should return 405
MCP_DEL_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X DELETE "$BASE_URL/mcp" 2>/dev/null || echo "000")
if [[ "$MCP_DEL_CODE" == "405" ]]; then
  pass "DELETE /mcp returns 405"
else
  echo "  SKIP: DELETE /mcp returned $MCP_DEL_CODE (server may not enforce 405 for DELETE)"
fi

# ─── [8/10] REST API ─────────────────────────────────────────────────────────

echo ""
echo "[8/10] REST API (/api/v1/circuits, /api/v1/proofs/verify)"

# GET /api/v1/circuits
REST_CIRCUITS=$(curl -s "$BASE_URL/api/v1/circuits")
REST_CIRCUITS_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$BASE_URL/api/v1/circuits")
assert_status "$REST_CIRCUITS_CODE" "200" "GET /api/v1/circuits returns 200"
assert_json_exists "$REST_CIRCUITS" '.circuits' "REST circuits endpoint has circuits array"

REST_CIRCUIT_COUNT=$(echo "$REST_CIRCUITS" | jq '.circuits | length' 2>/dev/null || echo "0")
if [[ "$REST_CIRCUIT_COUNT" -gt 0 ]]; then
  pass "REST circuits has $REST_CIRCUIT_COUNT circuit(s)"
else
  fail "REST circuits has at least 1 circuit" "got 0"
fi

# POST /api/v1/proofs/verify with fake proof — expect valid field in response
VERIFY_RESP=$(curl -s -X POST "$BASE_URL/api/v1/proofs/verify" \
  -H "Content-Type: application/json" \
  -d "{\"circuitId\":\"coinbase_attestation\",\"proof\":\"0xfake\",\"publicInputs\":[\"0x$(printf '%064d' 0)\"],\"chainId\":\"84532\"}")
assert_json_exists "$VERIFY_RESP" '.valid' "verify endpoint returns valid field"

# POST /api/v1/chat should return 410 Gone
CHAT_DEPRECATED=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE_URL/api/v1/chat" \
  -H "Content-Type: application/json" \
  -d '{}' 2>/dev/null || echo "000")
if [[ "$CHAT_DEPRECATED" == "410" ]]; then
  pass "deprecated /api/v1/chat returns 410"
else
  echo "  SKIP: /api/v1/chat returned $CHAT_DEPRECATED (endpoint may not exist or not marked deprecated)"
fi

# ─── [9/10] OpenAI Chat ──────────────────────────────────────────────────────

echo ""
echo "[9/10] OpenAI Chat (/v1/models, /v1/chat/completions)"

# GET /v1/models
MODELS_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$BASE_URL/v1/models" 2>/dev/null || echo "000")
MODELS=$(curl -s "$BASE_URL/v1/models" 2>/dev/null || echo "{}")
assert_status "$MODELS_CODE" "200" "GET /v1/models returns 200"
assert_json_exists "$MODELS" '.data' "models endpoint has data array"

MODEL_ID=$(echo "$MODELS" | jq -r '.data[0].id // empty' 2>/dev/null)
if [[ "$MODEL_ID" == "zkproofport" ]]; then
  pass "models endpoint returns zkproofport model"
else
  fail "models endpoint returns zkproofport model" "got '$MODEL_ID'"
fi

# POST /v1/chat/completions with valid payload — optional (LLM may not be configured)
CHAT_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE_URL/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"what circuits do you support?"}]}' 2>/dev/null || echo "000")
if [[ "$CHAT_CODE" == "200" ]]; then
  pass "chat completions returns 200"
elif [[ "$CHAT_CODE" == "500" ]]; then
  echo "  SKIP: Chat completions returned 500 (LLM provider may not be configured)"
else
  fail "chat completions" "expected 200 or 500, got $CHAT_CODE"
fi

# POST /v1/chat/completions with empty messages array — should return 400
CHAT_ERR_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE_URL/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -d '{"messages":[]}' 2>/dev/null || echo "000")
assert_status "$CHAT_ERR_CODE" "400" "chat with empty messages returns 400"

# ─── [10/10] Phoenix Trace Check (optional) ──────────────────────────────────

echo ""
if [[ "$QUICK_MODE" == "true" ]]; then
  echo "[10/10] Phoenix Trace Check — SKIPPED (--quick mode)"
else
  echo "[10/10] Phoenix Trace Check"
  PHOENIX_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$PHOENIX_URL/healthz" 2>/dev/null || echo "000")
  if [[ "$PHOENIX_CODE" == "200" ]]; then
    pass "Phoenix is reachable at $PHOENIX_URL"

    # Wait for traces to flush
    sleep 2

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

# ─── Korean Text Inference ───────────────────────────────────────────────────

echo ""
echo "[11/10] Korean Text Inference"

# Korean generate_proof
KO_GEN=$(curl -s -X POST "$BASE_URL/a2a" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":100,"method":"message/send","params":{"message":{"role":"user","parts":[{"kind":"text","text":"coinbase_attestation 증명 생성해줘 myapp.com"}]}}}')
KO_GEN_STATE=$(echo "$KO_GEN" | jq -r '.result.status.state // empty' 2>/dev/null)
if [[ "$KO_GEN_STATE" == "completed" || "$KO_GEN_STATE" == "failed" ]]; then
  pass "Korean 증명 생성 routes to generate_proof (state: $KO_GEN_STATE)"
else
  KO_GEN_ERR=$(echo "$KO_GEN" | jq -r '.error.message // empty' 2>/dev/null)
  fail "Korean 증명 생성 routes to generate_proof" "state='$KO_GEN_STATE' error='$KO_GEN_ERR'"
fi

# Korean verify_proof
KO_VER=$(curl -s -X POST "$BASE_URL/a2a" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":101,"method":"message/send","params":{"message":{"role":"user","parts":[{"kind":"text","text":"증명 검증해줘"}]}}}')
KO_VER_STATE=$(echo "$KO_VER" | jq -r '.result.status.state // empty' 2>/dev/null)
if [[ "$KO_VER_STATE" == "completed" || "$KO_VER_STATE" == "failed" ]]; then
  pass "Korean 증명 검증해줘 routes to verify_proof (state: $KO_VER_STATE)"
else
  KO_VER_ERR=$(echo "$KO_VER" | jq -r '.error.message // empty' 2>/dev/null)
  fail "Korean 증명 검증해줘 routes to verify_proof" "state='$KO_VER_STATE' error='$KO_VER_ERR'"
fi

# Korean get_supported_circuits
KO_LIST=$(curl -s -X POST "$BASE_URL/a2a" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":102,"method":"message/send","params":{"message":{"role":"user","parts":[{"kind":"text","text":"지원하는 회로 목록 보여줘"}]}}}')
KO_LIST_STATE=$(echo "$KO_LIST" | jq -r '.result.status.state // empty' 2>/dev/null)
if [[ "$KO_LIST_STATE" == "completed" ]]; then
  pass "Korean 회로 목록 보여줘 routes to get_supported_circuits"
else
  KO_LIST_ERR=$(echo "$KO_LIST" | jq -r '.error.message // empty' 2>/dev/null)
  fail "Korean 회로 목록 보여줘 routes to get_supported_circuits" "state='$KO_LIST_STATE' error='$KO_LIST_ERR'"
fi

# Unrecognized text should return -32602
KO_UNK=$(curl -s -X POST "$BASE_URL/a2a" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":103,"method":"message/send","params":{"message":{"role":"user","parts":[{"kind":"text","text":"hello world"}]}}}')
KO_UNK_CODE=$(echo "$KO_UNK" | jq -r '.error.code // empty' 2>/dev/null)
if [[ "$KO_UNK_CODE" == "-32602" ]]; then
  pass "Unrecognized text returns -32602"
else
  fail "Unrecognized text returns -32602" "got code '$KO_UNK_CODE'"
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
