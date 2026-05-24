#!/usr/bin/env bash
# stop-active-slot.sh — Stop the active blue-green slot container.
# Requires /opt/proofport-ai/active-slot to exist. No defaults.
set -euo pipefail

STATE_FILE=/opt/proofport-ai/active-slot
[[ -f "$STATE_FILE" ]] || { echo "ERROR: $STATE_FILE missing" >&2; exit 1; }

SLOT=$(tr -d '[:space:]' < "$STATE_FILE")
CONTAINER="proofport-ai-${SLOT}"

echo "Stopping active slot: ${SLOT} (container: ${CONTAINER})"
if docker ps -a --format '{{.Names}}' | grep -q "^${CONTAINER}$"; then
  docker stop "$CONTAINER" >/dev/null
  docker rm -f "$CONTAINER" >/dev/null
  echo "Stopped."
else
  echo "Container ${CONTAINER} not present — nothing to stop."
fi
