#!/usr/bin/env bash
# boot-active-slot.sh — Start the last-active blue-green slot on EC2 boot
set -euo pipefail

APP_DIR="/opt/proofport-ai"
STATE_FILE="${APP_DIR}/active-slot"
ENV_FILE="${APP_DIR}/.env"

# Read active slot (default: blue for first boot)
SLOT=$(cat "${STATE_FILE}" 2>/dev/null | tr -d '[:space:]' || echo "blue")
CONTAINER="proofport-ai-${SLOT}"

if [[ "${SLOT}" == "blue" ]]; then
  APP_PORT=4002
else
  APP_PORT=4003
fi

# Load image reference from .env
source <(grep '^AI_IMAGE=' "${ENV_FILE}")
source <(grep '^DEPLOY_ENV=' "${ENV_FILE}")

if [[ -z "${AI_IMAGE:-}" ]]; then
  echo "ERROR: AI_IMAGE not found in ${ENV_FILE}"
  exit 1
fi

echo "Booting slot ${SLOT} (app=${APP_PORT})"
echo "Image: ${AI_IMAGE}"

# ECR login + pull
/usr/local/bin/ecr-login.sh
docker pull "${AI_IMAGE}"

# Clean up any existing container with same name
docker rm -f "${CONTAINER}" 2>/dev/null || true

# Start container
docker run -d \
  --name "${CONTAINER}" \
  --network host \
  --device /dev/vsock \
  --security-opt seccomp=unconfined \
  --env-file "${ENV_FILE}" \
  --log-driver=awslogs \
  --log-opt awslogs-region=ap-northeast-2 \
  --log-opt awslogs-group=/proofport-ai/${DEPLOY_ENV:-stg-ai} \
  --log-opt awslogs-stream=proofport-ai-${SLOT} \
  --log-opt awslogs-create-group=true \
  -v /opt/proofport-ai/circuits:/app/circuits \
  -v /opt/proofport-ai/logs:/app/logs \
  "${AI_IMAGE}" \
  sh -c "PORT=${APP_PORT} node dist/index.js"

echo "Container '${CONTAINER}' started (app=${APP_PORT})"
