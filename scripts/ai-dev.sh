#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AI_DIR="$(dirname "$SCRIPT_DIR")"

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
echo "[OK] SIGN_PAGE_URL=http://${HOST_IP}:4002"
echo "[OK] A2A_BASE_URL=http://${HOST_IP}:4002"
echo "[OK] NEXT_PUBLIC_API_BASE_URL=http://${HOST_IP}:4002"

# Build and start
echo ""
echo "[*] Building and starting services..."
cd "$AI_DIR"
docker compose up --build -d

echo ""
echo "[*] Waiting for services to be healthy..."
sleep 5

# Health check
if curl -sf http://localhost:4002/health > /dev/null 2>&1; then
  echo "  [OK] AI Server"
else
  echo "  [..] AI Server (still starting — check logs if it doesn't come up)"
fi

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
echo "  Stop:            cd proofport-ai && docker compose down"
echo "  Reset:           cd proofport-ai && docker compose down -v"
echo ""
