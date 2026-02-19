#!/bin/bash
set -euo pipefail

# ─── E2E Test Runner ─────────────────────────────────────────────────────
# Automates the full E2E test lifecycle:
#   1. Build & start containers (if needed)
#   2. Wait for healthy
#   3. Run endpoint E2E tests (PAYMENT_MODE=disabled)
#   4. Switch to PAYMENT_MODE=testnet (no rebuild, env override only)
#   5. Run x402 payment E2E tests
#   6. Switch back to normal mode
#   7. Report results
#
# Usage:
#   ./scripts/run-e2e.sh              # Run all E2E tests
#   ./scripts/run-e2e.sh --build      # Rebuild image before testing
#   ./scripts/run-e2e.sh --skip-payment  # Skip x402 payment tests
# ──────────────────────────────────────────────────────────────────────────

cd "$(dirname "$0")/.."

BUILD_FLAG=""
SKIP_PAYMENT=false

for arg in "$@"; do
  case "$arg" in
    --build) BUILD_FLAG="--build" ;;
    --skip-payment) SKIP_PAYMENT=true ;;
    *) echo "Unknown arg: $arg"; exit 1 ;;
  esac
done

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
NC='\033[0m'

log() { echo -e "${CYAN}[E2E]${NC} $1"; }
ok()  { echo -e "${GREEN}[OK]${NC} $1"; }
err() { echo -e "${RED}[FAIL]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }

BASE_URL="${E2E_BASE_URL:-http://localhost:4002}"
COMPOSE_BASE="docker compose -f docker-compose.yml"
COMPOSE_PAYMENT="docker compose -f docker-compose.yml -f docker-compose.e2e-payment.yml"

# ─── Load attestation wallet keys from .env.development (if present) ────
if [ -f .env.development ]; then
  while IFS='=' read -r key value; do
    case "$key" in
      E2E_ATTESTATION_WALLET_KEY|E2E_ATTESTATION_WALLET_ADDRESS)
        export "$key=$value"
        ;;
    esac
  done < <(grep -E '^E2E_' .env.development)
fi

if [ -n "${E2E_ATTESTATION_WALLET_KEY:-}" ]; then
  log "Attestation wallet loaded — proof generation tests will run"
else
  warn "No E2E_ATTESTATION_WALLET_KEY — proof generation tests will be SKIPPED"
fi

# ─── Step 1: Start containers ────────────────────────────────────────────

log "Starting containers..."
if [ -n "$BUILD_FLAG" ]; then
  log "Rebuilding image (--build)..."
  $COMPOSE_BASE up --build -d 2>&1 | tail -5
else
  $COMPOSE_BASE up -d 2>&1 | tail -5
fi

# ─── Step 2: Wait for healthy ────────────────────────────────────────────

log "Waiting for $BASE_URL/health ..."
MAX_WAIT=60
WAITED=0
while true; do
  if curl -sf "$BASE_URL/health" > /dev/null 2>&1; then
    ok "Container healthy (${WAITED}s)"
    break
  fi
  if [ $WAITED -ge $MAX_WAIT ]; then
    err "Container not healthy after ${MAX_WAIT}s"
    docker compose logs ai --tail 30
    exit 1
  fi
  sleep 2
  WAITED=$((WAITED + 2))
done

# ─── Step 3: Run endpoint E2E tests ──────────────────────────────────────

log "Running endpoint E2E tests (PAYMENT_MODE=disabled)..."
ENDPOINT_RESULT=0
E2E_BASE_URL="$BASE_URL" npx vitest run tests/e2e/endpoints.test.ts --reporter=verbose 2>&1 || ENDPOINT_RESULT=$?

if [ $ENDPOINT_RESULT -ne 0 ]; then
  err "Endpoint E2E tests FAILED (exit code: $ENDPOINT_RESULT)"
else
  ok "Endpoint E2E tests passed"
fi

# ─── Step 4: Switch to PAYMENT_MODE=testnet ───────────────────────────────

PAYMENT_RESULT=0

if [ "$SKIP_PAYMENT" = true ]; then
  warn "Skipping x402 payment tests (--skip-payment)"
else
  log "Switching to PAYMENT_MODE=testnet (no rebuild)..."
  $COMPOSE_PAYMENT up -d ai 2>&1 | tail -3

  # Wait for healthy after restart
  log "Waiting for container restart..."
  sleep 3
  WAITED=0
  while true; do
    HEALTH=$(curl -sf "$BASE_URL/health" 2>/dev/null || echo "")
    if echo "$HEALTH" | grep -q '"paymentMode":"testnet"'; then
      ok "Container restarted with PAYMENT_MODE=testnet (${WAITED}s)"
      break
    fi
    if [ $WAITED -ge $MAX_WAIT ]; then
      err "Container failed to restart with testnet mode after ${MAX_WAIT}s"
      docker compose logs ai --tail 30
      exit 1
    fi
    sleep 2
    WAITED=$((WAITED + 2))
  done

  # Run payment E2E tests
  log "Running x402 payment E2E tests..."
  E2E_BASE_URL="$BASE_URL" npx vitest run tests/e2e/x402-e2e.test.ts --reporter=verbose 2>&1 || PAYMENT_RESULT=$?

  if [ $PAYMENT_RESULT -ne 0 ]; then
    err "x402 payment E2E tests FAILED (exit code: $PAYMENT_RESULT)"
  else
    ok "x402 payment E2E tests passed"
  fi

  # Switch back to normal mode
  log "Switching back to PAYMENT_MODE=disabled..."
  $COMPOSE_BASE up -d ai 2>&1 | tail -3
  sleep 3
fi

# ─── Step 5: Run LLM inference tests (if GEMINI_API_KEY set) ─────────────

LLM_RESULT=0
if [ -n "${GEMINI_API_KEY:-}" ]; then
  log "Running LLM inference tests (real Gemini API)..."
  npx vitest run tests/e2e/a2a-llm-inference.test.ts --reporter=verbose 2>&1 || LLM_RESULT=$?

  if [ $LLM_RESULT -ne 0 ]; then
    err "LLM inference tests FAILED"
  else
    ok "LLM inference tests passed"
  fi
else
  warn "Skipping LLM inference tests (GEMINI_API_KEY not set)"
fi

# ─── Summary ──────────────────────────────────────────────────────────────

echo ""
echo "════════════════════════════════════════════"
echo -e " ${CYAN}E2E Test Summary${NC}"
echo "════════════════════════════════════════════"
[ $ENDPOINT_RESULT -eq 0 ] && ok "Endpoint tests: PASSED" || err "Endpoint tests: FAILED"
if [ "$SKIP_PAYMENT" = true ]; then
  warn "Payment tests: SKIPPED"
else
  [ $PAYMENT_RESULT -eq 0 ] && ok "Payment tests: PASSED" || err "Payment tests: FAILED"
fi
if [ -n "${GEMINI_API_KEY:-}" ]; then
  [ $LLM_RESULT -eq 0 ] && ok "LLM inference: PASSED" || err "LLM inference: FAILED"
else
  warn "LLM inference: SKIPPED (no GEMINI_API_KEY)"
fi
echo "════════════════════════════════════════════"

# Exit with failure if any test failed
EXIT_CODE=0
[ $ENDPOINT_RESULT -ne 0 ] && EXIT_CODE=1
[ $PAYMENT_RESULT -ne 0 ] && EXIT_CODE=1
[ $LLM_RESULT -ne 0 ] && EXIT_CODE=1
exit $EXIT_CODE
