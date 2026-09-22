#!/bin/bash
set -euo pipefail

# ─── E2E Test Runner ─────────────────────────────────────────────────────
# Runs the E2E suite against a container, in two phases:
#
#   free  — PAYMENT_MODE=disabled, every suite except the paying one
#   paid  — PAYMENT_MODE=testnet,  the paying one (spends testnet USDC)
#
# Locally the server runs on this Mac against the pinned native bb
# (~/.bb/bb, arm64, the same build that produced the committed verification
# keys). That is the accurate prover and it needs no image.
#
# --container runs it in the image instead, which must be on an x86_64 daemon --
# scripts/lib/dev-docker.sh selects one. The image's bb is a Linux x86 binary;
# on an arm64 daemon it runs through a loader that gets the field arithmetic
# wrong and aborts on every call, including --version.
#
# Locally only the free phase runs. Paying is exercised against staging, where
# the wallets, the settler key and the facilitator are the ones customers meet;
# a local container settles with the same code but proves nothing about them,
# and it spends real testnet USDC to do it.
#
# Both phases name the URL and the payment mode they measured, because a green
# line that does not say where it came from is the failure this repo keeps
# hitting: every earlier local run of this script was aimed at deployed
# staging, since .env.test sets E2E_BASE_URL and nothing here overrode it.
#
# Usage:
#   ./scripts/run-e2e.sh                     # server on this Mac, native bb, free phase
#   ./scripts/run-e2e.sh --container         # in the container instead (x86_64 daemon)
#   ./scripts/run-e2e.sh --build             # rebuild the image first
#   ./scripts/run-e2e.sh --with-payment      # also pay locally (spends testnet USDC)
#   ./scripts/run-e2e.sh --only sdk-client   # one suite (substring of the file name)
#   E2E_BASE_URL=https://stg-ai.zkproofport.app ./scripts/run-e2e.sh --remote
#
# --remote leaves the deployment alone: no container is started and no payment
# mode is switched, because neither is ours to change on a deployed service.
# ──────────────────────────────────────────────────────────────────────────

cd "$(dirname "$0")/.."

BUILD_FLAG=""
REMOTE=false
CONTAINER=false
ONLY=""
# Paying is off locally and on against a deployment; --with-payment / --skip-payment override.
WANT_PAYMENT=""

while [ $# -gt 0 ]; do
  case "$1" in
    --build) BUILD_FLAG="--build" ;;
    --skip-payment) WANT_PAYMENT=false ;;
    --with-payment) WANT_PAYMENT=true ;;
    --remote) REMOTE=true ;;
    --container) CONTAINER=true ;;
    --only) shift; ONLY="${1:?--only needs a suite name}" ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
  shift
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

if [ -z "$WANT_PAYMENT" ]; then
  WANT_PAYMENT=$REMOTE
fi

# --remote with no URL would quietly measure localhost, which is the exact
# mistake this script was rewritten to stop making.
if [ "$REMOTE" = true ] && [ -z "${E2E_BASE_URL:-}" ]; then
  err "--remote needs E2E_BASE_URL. Example:"
  echo "        E2E_BASE_URL=https://stg-ai.zkproofport.app $0 --remote"
  exit 1
fi

# Same Docker target as ai-dev.sh, chosen for this process only.
#
# These were plain `docker compose`, which uses whatever context is current.
# On a machine with two Colima VMs that is how an E2E run talks to a daemon the
# stack is not on -- containers "missing", logs empty, and a failure that reads
# like a broken service. Teammates on Docker Desktop or plain Linux Docker are
# left exactly as configured.
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
if [ "$REMOTE" = false ] && [ -f "$REPO_ROOT/scripts/lib/dev-docker.sh" ]; then
  # shellcheck source=/dev/null
  source "$REPO_ROOT/scripts/lib/dev-docker.sh"
  # Only the containerized prover needs an x86_64 daemon. The native path uses
  # Docker for Redis alone, which runs anywhere.
  if [ "$CONTAINER" = true ]; then
    dev_docker_init x86_64 || exit 1
  else
    dev_docker_init || exit 1
  fi
  docker() { command docker "${DEV_DOCKER_ARGS[@]}" "$@"; }
fi

COMPOSE_FREE="docker compose -f docker-compose.yml -f docker-compose.e2e-free.yml"
COMPOSE_PAYMENT="docker compose -f docker-compose.yml -f docker-compose.e2e-payment.yml"

# ─── Which suites run in which phase ─────────────────────────────────────
# Derived from the directory, never a hand-kept list: this script spent months
# pointing at tests/e2e/x402-e2e.test.ts and tests/e2e/a2a-llm-inference.test.ts
# after both were deleted, so its paid phase could only ever report FAILED.
PAID_SUITE="tests/e2e/payment.test.ts"
FREE_SUITES=()
while IFS= read -r f; do
  [ "$f" = "$PAID_SUITE" ] && continue
  [ -n "$ONLY" ] && [[ "$f" != *"$ONLY"* ]] && continue
  FREE_SUITES+=("$f")
done < <(ls tests/e2e/*.test.ts)

if [ -n "$ONLY" ] && [ ${#FREE_SUITES[@]} -eq 0 ] && [[ "$PAID_SUITE" != *"$ONLY"* ]]; then
  err "--only '$ONLY' matches no file in tests/e2e/"
  ls tests/e2e/*.test.ts
  exit 1
fi

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

# ─── Wait for the service to answer, in the mode this phase asked for ────
MAX_WAIT=90
wait_for_mode() {
  local want="$1" waited=0 health=""
  log "Waiting for $BASE_URL/health to report paymentMode=$want ..."
  while true; do
    health=$(curl -sf "$BASE_URL/health" 2>/dev/null || echo "")
    if echo "$health" | grep -q "\"paymentMode\":\"$want\""; then
      ok "Service up at $BASE_URL, paymentMode=$want (${waited}s)"
      return 0
    fi
    if [ $waited -ge $MAX_WAIT ]; then
      err "No paymentMode=$want at $BASE_URL after ${MAX_WAIT}s"
      echo "last /health: ${health:-<no answer>}"
      [ "$REMOTE" = false ] && $COMPOSE_FREE logs ai --tail 30
      return 1
    fi
    sleep 2
    waited=$((waited + 2))
  done
}

# The prover is an x86-64 binary. Ask it its version before running a suite
# that expects proofs: under the arm64 VM's user-mode emulation it does not
# refuse to start, it aborts mid-arithmetic, and every proof test then fails
# with a bb assertion that reads like a broken circuit.
check_prover() {
  local out
  if out=$(docker exec proofport-ai /usr/local/bin/bb-wrapper --version 2>&1); then
    ok "Prover runs here: bb ${out}"
    return 0
  fi
  err "The prover cannot run in this container — every proof test below would fail:"
  echo "$out" | sed 's/^/        /'
  echo "        This is the Docker target's architecture, not the circuits."
  echo "        Run the stack on an x86_64 daemon (scripts/ai-dev.sh selects one)."
  return 1
}

run_suites() {
  local mode="$1"; shift
  [ $# -eq 0 ] && { warn "no suites to run in the $mode phase"; return 0; }
  log "Running against $BASE_URL with payment $mode:"
  printf '         %s\n' "$@"
  E2E_BASE_URL="$BASE_URL" npx vitest run --project e2e "$@" --reporter=verbose 2>&1
}

# ─── The server on this Mac, against the native prover ───────────────────
#
# Every value below is here because leaving it out stopped this dead once. The
# reasons are in .claude/agents/ai-dev.md under "Proving on the Mac".
MAC_SERVER_PID=""
stop_mac_server() {
  [ -n "$MAC_SERVER_PID" ] && kill "$MAC_SERVER_PID" 2>/dev/null
  MAC_SERVER_PID=""
}
trap stop_mac_server EXIT

start_mac_server() {
  local bb="${BB_PATH:-$HOME/.bb/bb}"
  if [ ! -x "$bb" ]; then
    err "No prover at $bb. Build it: ../scripts/build-bb-native.sh"
    return 1
  fi
  local version
  version="$("$bb" --version 2>&1 | tail -1)"
  ok "Prover: $bb — $version"

  # Redis, and nothing else, from the stack. It publishes 6380.
  $COMPOSE_FREE up -d redis 2>&1 | tail -2
  # Free the port in case a container is serving.
  $COMPOSE_FREE stop ai >/dev/null 2>&1 || true

  # `. .env.development` expands $0 inside PAYMENT_PROOF_PRICE='$0.10' to this
  # script's own name, which reaches the server as an unparseable price.
  set -a
  # shellcheck source=/dev/null
  . ./.env.development
  set +a
  PAYMENT_PROOF_PRICE='$0.10'
  PAYMENT_MODE=disabled
  BB_PATH="$bb"
  CIRCUITS_DIR="$PWD/circuits"
  REDIS_URL="${MAC_REDIS_URL:-redis://localhost:6380}"
  # docker-compose supplies these two; .env.development does not.
  A2A_BASE_URL="http://localhost:4002"
  SIGN_PAGE_URL="http://localhost:4002/sign"
  export PAYMENT_PROOF_PRICE PAYMENT_MODE BB_PATH CIRCUITS_DIR REDIS_URL A2A_BASE_URL SIGN_PAGE_URL

  MAC_SERVER_LOG="${TMPDIR:-/tmp}/proofport-ai-mac-server.log"
  log "Starting the server on this Mac, log: $MAC_SERVER_LOG"
  npx tsx src/index.ts > "$MAC_SERVER_LOG" 2>&1 &
  MAC_SERVER_PID=$!
  return 0
}

# ─── Phase 1: payment disabled ───────────────────────────────────────────

if [ "$REMOTE" = false ] && [ "$CONTAINER" = false ]; then
  start_mac_server || exit 1
  wait_for_mode disabled || { err "server log:"; tail -40 "$MAC_SERVER_LOG"; exit 1; }
elif [ "$REMOTE" = true ]; then
  warn "--remote: not starting a container and not switching payment mode"
  log "Measuring whatever $BASE_URL is already serving"
  curl -sf "$BASE_URL/health" | head -c 300; echo
else
  log "Starting containers with payment disabled..."
  if [ -n "$BUILD_FLAG" ]; then
    log "Rebuilding image (--build)..."
    $COMPOSE_FREE up --build -d 2>&1 | tail -5
  else
    $COMPOSE_FREE up -d 2>&1 | tail -5
  fi
  wait_for_mode disabled || exit 1
  check_prover || exit 1
fi

FREE_RESULT=0
run_suites disabled "${FREE_SUITES[@]}" || FREE_RESULT=$?
[ $FREE_RESULT -eq 0 ] && ok "Free-tier suites passed" || err "Free-tier suites FAILED (exit $FREE_RESULT)"

# ─── Phase 2: payment on ─────────────────────────────────────────────────

PAYMENT_RESULT=0
PAYMENT_RAN=false

if [ "$WANT_PAYMENT" != true ]; then
  warn "Paying suite not run: local runs do not spend. Pay on staging, or pass --with-payment"
elif [ -n "$ONLY" ] && [[ "$PAID_SUITE" != *"$ONLY"* ]]; then
  warn "Skipping the paying suite (--only '$ONLY' does not match it)"
elif [ "$REMOTE" = true ]; then
  PAYMENT_RAN=true
  run_suites "as the deployment has it" "$PAID_SUITE" || PAYMENT_RESULT=$?
elif [ "$CONTAINER" = false ]; then
  warn "Paying suite not run: the server on this Mac is started with payment off"
else
  log "Switching to PAYMENT_MODE=testnet (no rebuild)..."
  $COMPOSE_PAYMENT up -d ai 2>&1 | tail -3
  if wait_for_mode testnet; then
    PAYMENT_RAN=true
    run_suites testnet "$PAID_SUITE" || PAYMENT_RESULT=$?
  else
    PAYMENT_RESULT=1
  fi

  log "Switching back to payment disabled..."
  $COMPOSE_FREE up -d ai 2>&1 | tail -3
fi

[ "$PAYMENT_RAN" = true ] && { [ $PAYMENT_RESULT -eq 0 ] && ok "Paying suite passed" || err "Paying suite FAILED (exit $PAYMENT_RESULT)"; }

# ─── Summary ──────────────────────────────────────────────────────────────

echo ""
echo "════════════════════════════════════════════"
echo -e " ${CYAN}E2E Test Summary${NC}"
echo "════════════════════════════════════════════"
echo " measured against: $BASE_URL"
[ $FREE_RESULT -eq 0 ] && ok "Free tier (payment disabled), ${#FREE_SUITES[@]} files: PASSED" \
                       || err "Free tier (payment disabled), ${#FREE_SUITES[@]} files: FAILED"
if [ "$PAYMENT_RAN" = true ]; then
  [ $PAYMENT_RESULT -eq 0 ] && ok "Paying suite: PASSED" || err "Paying suite: FAILED"
else
  warn "Paying suite: SKIPPED (nothing spent)"
fi
echo "════════════════════════════════════════════"

EXIT_CODE=0
[ $FREE_RESULT -ne 0 ] && EXIT_CODE=1
[ $PAYMENT_RESULT -ne 0 ] && EXIT_CODE=1
exit $EXIT_CODE
