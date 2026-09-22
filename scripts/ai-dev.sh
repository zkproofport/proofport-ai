#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AI_DIR="$(dirname "$SCRIPT_DIR")"

# WHICH DOCKER VM THIS STACK RUNS ON.
#
# `docker` with no --context uses the CURRENT context, which is not "default":
# it is whatever `docker context use` last selected, and on this machine that
# was `colima-realrep` -- an x86_64 Colima VM kept for another project. This
# script inherited it and built the image under emulation, where `npm ci` alone
# ran for twenty minutes. Measured 2026-09-22.
#
# The shared library selects Colima's aarch64 default VM for the length of this
# process only, exactly as the root dev scripts do, and never touches the
# user's global context. Non-Colima setups (Desktop, plain Linux, remote) are
# left alone.
REPO_ROOT="$(cd "$AI_DIR/.." && pwd)"
if [ -f "$REPO_ROOT/scripts/lib/dev-docker.sh" ]; then
  # shellcheck source=/dev/null
  source "$REPO_ROOT/scripts/lib/dev-docker.sh"
  dev_docker_init x86_64 || exit 1
  docker() { command docker "${DEV_DOCKER_ARGS[@]}" "$@"; }
fi

# Start with payment switched ON, so the paid path can be exercised locally.
#
# Without this the service runs PAYMENT_MODE=disabled and every request is
# free, which means the payment tests all skip -- and a payment suite that
# skips reports green for the case nobody ran. Layering the override here
# rather than typing the two -f flags by hand keeps the whole invocation in the
# repository, including the check below that the settler key is present.
WITH_PAYMENT=0
for arg in "$@"; do
  case "$arg" in
    --payment) WITH_PAYMENT=1 ;;
    -h|--help)
      echo "Usage: $(basename "$0") [--payment]"
      echo ""
      echo "  --payment   Start with x402 payment ON (\$0.01), offering Base Sepolia,"
      echo "              Arc testnet and Ethereum Sepolia. Requires"
      echo "              PROVER_PRIVATE_KEY: no public facilitator settles"
      echo "              Arc or Ethereum, so this service submits the buyer's signed"
      echo "              authorization itself. PAYMENT_PAY_TO must be this wallet."
      exit 0 ;;
  esac
done

COMPOSE_FILES=(-f docker-compose.yml)
if [ "$WITH_PAYMENT" = "1" ]; then
  if [ -z "${PROVER_PRIVATE_KEY:-}" ]; then
    echo "[ERROR] --payment needs PROVER_PRIVATE_KEY."
    echo ""
    echo "  It is the wallet that submits a buyer's signed authorization on the"
    echo "  chains no public x402 facilitator settles (Arc, Ethereum). The buyer"
    echo "  signs and pays no gas; this wallet pays it."
    echo ""
    echo "  It needs USDC on Arc testnet, which is also Arc's gas asset:"
    echo "  faucet.circle.com gives 20 USDC every 2 hours, no account needed."
    exit 1
  fi
  if [ -z "${PAYMENT_PAY_TO:-}" ]; then
    echo "[ERROR] --payment needs PAYMENT_PAY_TO set to the PROVER_PRIVATE_KEY wallet address."
    exit 1
  fi
  COMPOSE_FILES+=(-f docker-compose.e2e-payment.yml)
  echo "[*] Payment ON — \$0.01, chains: base-sepolia, arc-testnet, ethereum-sepolia"
fi

echo "=========================================="
echo "  proofport-ai Local Development Environment"
echo "=========================================="
echo ""

# Pre-flight checks
if ! command -v docker &> /dev/null; then
  echo "[ERROR] Docker is not installed. Please install Docker Desktop."
  exit 1
fi

if ! docker info &> /dev/null 2>&1; then
  echo "[ERROR] Docker daemon is not running. Please start Docker Desktop."
  exit 1
fi

if ! command -v docker compose &> /dev/null && ! docker compose version &> /dev/null 2>&1; then
  echo "[ERROR] Docker Compose is not available."
  exit 1
fi

echo "[OK] Docker is running"

# Auto-detect host LAN IP for physical device / mobile testing
# docker-compose.yml uses ${HOST_IP:-localhost} for all IP-dependent values
HOST_IP=$(ipconfig getifaddr en0 2>/dev/null)
if [ -z "$HOST_IP" ]; then
  HOST_IP=$(ifconfig 2>/dev/null | grep 'inet ' | grep -v '127.0.0.1' | head -1 | awk '{print $2}')
fi
if [ -z "$HOST_IP" ]; then
  HOST_IP="localhost"
  echo "[!] Could not detect network IP, using localhost"
  echo "    (Physical device testing will not work)"
else
  echo "[OK] Host IP: $HOST_IP"
fi
export HOST_IP
echo ""
echo "[OK] A2A_BASE_URL=http://${HOST_IP}:4002"
echo "[OK] NEXT_PUBLIC_API_BASE_URL=http://${HOST_IP}:4002"

# Copy compiled circuit artifacts from parent repo
#
# The circuit list comes from src/config/circuitIds.ts, not from a list written
# here. It WAS written here -- three directory names, hardcoded -- and on
# 2026-09-09 that made the container crash-loop: arc_eligibility had been added
# to the server's own map and not to this script, so three circuits were copied,
# four were needed, and the server tried to download the fourth from a branch it
# had not been pushed to. A hardcoded list of circuits fails every time a
# circuit is added.
echo ""
echo "[*] Copying circuit artifacts from parent repo..."
PARENT_CIRCUITS="$(dirname "$AI_DIR")/circuits"
if [ -d "$PARENT_CIRCUITS" ]; then
  CIRCUIT_LIST=$(cd "$AI_DIR" && npx tsx scripts/print-circuit-dirs.ts 2>/dev/null)
  if [ -z "$CIRCUIT_LIST" ]; then
    echo "  [ERROR] Could not read the circuit list from src/config/circuitIds.ts."
    echo "          Not falling back to a hardcoded list: that is what broke this before."
    exit 1
  fi

  MISSING=0
  while read -r circuit package; do
    [ -z "$circuit" ] && continue
    TARGET="$AI_DIR/circuits/${circuit}/target"
    VK_TARGET="$TARGET/vk"
    SRC="$PARENT_CIRCUITS/${circuit}/target"
    if [ -d "$SRC" ] && [ -f "$SRC/${package}.json" ]; then
      mkdir -p "$VK_TARGET"
      cp "$SRC/${package}.json" "$TARGET/" && echo "  [OK] ${circuit}: ${package}.json"
      if [ -f "$SRC/vk/vk" ]; then
        cp "$SRC/vk/vk" "$VK_TARGET/" && echo "  [OK] ${circuit}: vk"
      else
        echo "  [!] ${circuit}: no vk at $SRC/vk/vk"
        MISSING=1
      fi
    else
      echo "  [!] ${circuit}: ${package}.json not built at $SRC"
      echo "      Build it:  cd ../circuits && ./scripts/build.sh ${circuit}"
      MISSING=1
    fi
  done <<< "$CIRCUIT_LIST"

  if [ "$MISSING" = "1" ]; then
    echo ""
    echo "  [ERROR] Some circuits have no local artifacts."
    echo ""
    echo "  The server downloads what it cannot find locally, from the circuits repo's"
    echo "  main branch -- so a circuit that exists only in your working tree makes it"
    echo "  crash on boot with a 404. Build the missing ones, or push the circuit."
    exit 1
  fi
else
  echo "  [!] Parent circuits repo not found at $PARENT_CIRCUITS (skipping artifact copy)"
fi

# Build and start
echo ""
echo "[*] Building and starting services..."
cd "$AI_DIR"
docker compose "${COMPOSE_FILES[@]}" up --build -d

echo ""
echo "[*] Waiting for services to be healthy..."
sleep 5

# Health check.
#
# Waits, then FAILS. The previous version asked once, said "still starting" on
# any answer it did not like, and carried on to print "Services Running" with a
# list of URLs -- over a container that had already exited. This repository has
# been bitten by that exact shape before: scripts/mopro_build.sh printed "Build
# complete!" over a failed build for months.
#
# A container that crashes on boot is the common case here, because the
# service refuses to start when a required variable is missing -- which is
# deliberate, and useless if the script reports success anyway.
echo -n "  [..] AI Server "
HEALTHY=0
for _ in $(seq 1 30); do
  if curl -sf http://localhost:4002/health > /dev/null 2>&1; then
    HEALTHY=1
    break
  fi
  echo -n "."
  sleep 2
done
echo ""

if [ "$HEALTHY" != "1" ]; then
  echo "  [FAIL] AI Server did not become healthy within 60s."
  echo ""
  echo "  Last 40 lines of its log:"
  echo "  ------------------------------------------"
  docker compose "${COMPOSE_FILES[@]}" logs --tail=40 ai 2>&1 | sed 's/^/  /'
  echo "  ------------------------------------------"
  exit 1
fi

echo "  [OK] AI Server"
echo "       $(curl -s http://localhost:4002/health)"

echo ""
echo "=========================================="
echo "  Services Running"
echo "=========================================="
echo ""
echo "  Service          URL"
echo "  -------          ---"
echo "  AI Server        http://${HOST_IP}:4002"
echo "  Health           http://${HOST_IP}:4002/health"
echo "  MCP Endpoint     http://${HOST_IP}:4002/mcp"
echo "  Sign Page        http://${HOST_IP}:4002/s/{requestId}"
echo "  Payment Page     http://${HOST_IP}:4002/pay/{requestId}"
echo "  Redis            localhost:6380"
echo ""
echo "=========================================="
echo "  Useful Commands"
echo "=========================================="
echo ""
echo "  View logs:       cd proofport-ai && docker compose logs -f ai"
echo "  With payment:    ./scripts/ai-dev.sh --payment   (needs PROVER_PRIVATE_KEY)"
echo "  Stop:            cd proofport-ai && docker compose down"
echo "  Reset:           cd proofport-ai && docker compose down -v"
echo ""
