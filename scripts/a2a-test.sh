#!/bin/bash
set -e

cd "$(dirname "$0")/.."

# Ensure .env.development exists
if [ ! -f .env.development ]; then
  echo "ERROR: .env.development not found."
  echo "Copy from .env.example and fill in required values:"
  echo "  cp .env.example .env.development"
  exit 1
fi

echo "Starting proofport-ai + Phoenix + a2a-ui..."
docker compose -f docker-compose.yml -f docker-compose.test.yml up --build -d

echo ""
echo "Waiting for services to become healthy..."
sleep 5

echo ""
echo "=== A2A Test Stack ==="
echo ""
echo "  proofport-ai:  http://localhost:4002"
echo "  Agent Card:    http://localhost:4002/.well-known/agent-card.json"
echo "  a2a-ui:        http://localhost:3001"
echo "  Phoenix UI:    http://localhost:6006"
echo ""
echo "Automated E2E test:"
echo "  npm run test:e2e"
echo ""
echo "Manual testing (a2a-ui):"
echo "  1. Open http://localhost:3001"
echo "  2. Click 'Add Agent' -> enter http://host.docker.internal:4002"
echo "     (or http://localhost:4002 if running outside Docker)"
echo "  3. Create a conversation and type: list supported circuits"
echo "  4. Check Phoenix traces at http://localhost:6006"
echo ""
