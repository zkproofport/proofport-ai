#!/usr/bin/env bash
# stop-active-slot.sh — Stop the active blue-green slot container
set -euo pipefail

SLOT=$(cat /opt/proofport-ai/active-slot 2>/dev/null | tr -d '[:space:]' || echo "blue")
CONTAINER="proofport-ai-${SLOT}"

echo "Stopping active slot: ${SLOT} (container: ${CONTAINER})"
docker stop "${CONTAINER}" 2>/dev/null || true
docker rm -f "${CONTAINER}" 2>/dev/null || true
echo "Stopped."
