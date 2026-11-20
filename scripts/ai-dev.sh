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
# The shared library selects Colima's default VM for the length of this
# process only, exactly as the root dev scripts do, and never touches the
# user's global context. The image carries a bb built for its own
# architecture (see the Dockerfile), so the arm64 default VM proves natively. Non-Colima setups (Desktop, plain Linux, remote) are
# left alone.
REPO_ROOT="$(cd "$AI_DIR/.." && pwd)"
if [ -f "$REPO_ROOT/scripts/lib/dev-docker.sh" ]; then
  # shellcheck source=/dev/null
  source "$REPO_ROOT/scripts/lib/dev-docker.sh"
  dev_docker_init || exit 1
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
      echo "  --payment   Start with x402 payment ON (\$0.01), offering Base Sepolia"
      echo "              and Ethereum Sepolia. Requires"
      echo "              PROVER_PRIVATE_KEY: no public facilitator settles"
      echo "              Ethereum, so this service submits the buyer's signed"
      echo "              authorization itself. PAYMENT_PAY_TO must be this wallet."
      exit 0 ;;
  esac
done

COMPOSE_FILES=(-f docker-compose.yml -f docker-compose.kms.yml)
if [ "$WITH_PAYMENT" = "1" ]; then
  if [ -z "${PROVER_PRIVATE_KEY:-}" ]; then
    echo "[ERROR] --payment needs PROVER_PRIVATE_KEY."
    echo ""
    echo "  It is the wallet that submits a buyer's signed authorization on the"
    echo "  chains no public x402 facilitator settles (Ethereum). The buyer"
    echo "  signs and pays no gas; this wallet pays it, so it needs Sepolia ETH."
    exit 1
  fi
  if [ -z "${PAYMENT_PAY_TO:-}" ]; then
    echo "[ERROR] --payment needs PAYMENT_PAY_TO set to the PROVER_PRIVATE_KEY wallet address."
    exit 1
  fi
  COMPOSE_FILES+=(-f docker-compose.e2e-payment.yml)
  echo "[*] Payment ON — \$0.01, chains: base-sepolia, ethereum-sepolia"
else
  # .env.development sets PAYMENT_MODE=testnet, so "off" has to be said here.
  # Until 2026-11-11 it was not: the stack started with testnet payment and the
  # file's placeholder wallet, and the startup check that the settling wallet
  # is the payee refused to start the server at all.
  COMPOSE_FILES+=(-f docker-compose.e2e-free.yml)
  echo "[*] Payment OFF (run with --payment to switch it on)"
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

# Copy compiled circuit artifacts from the parent repo's circuits checkout,
# with their hashes and the stamp naming the circuits commit and toolchain
# (scripts/bake-circuits.sh). The server checks both at boot and never
# downloads circuits.
#
# `local`: a checkout that is exactly the pinned commit
# (src/config/circuitsPin.ts) is stamped as such; anything else -- uncommitted
# artifacts during a toolchain move, another commit -- is stamped as a working
# tree, which the server accepts only off mainnet. The image's bb is read from
# the same stamp (Dockerfile), so it always matches the artifacts.
echo ""
echo "[*] Copying circuit artifacts from parent repo..."
PARENT_CIRCUITS="$(dirname "$AI_DIR")/circuits"
if [ ! -d "$PARENT_CIRCUITS" ]; then
  echo "  [ERROR] No circuits checkout at $PARENT_CIRCUITS. The server has no other source of circuits."
  exit 1
fi
if ! "$AI_DIR/scripts/bake-circuits.sh" "$PARENT_CIRCUITS" local; then
  echo ""
  echo "  [ERROR] Could not bake the circuit artifacts. Build a missing circuit with:"
  echo "          cd ../circuits && ./scripts/build.sh <circuit-dir>"
  exit 1
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
