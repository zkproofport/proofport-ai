#!/usr/bin/env bash
# boot-active-slot.sh — Start the last-active blue-green slot on EC2 boot.
#
# Required: /opt/proofport-ai/active-slot exists (written by deploy-blue-green.sh)
#           /opt/proofport-ai/.env contains AI_IMAGE, DEPLOY_ENV, AWS_REGION, ECR_REGISTRY
# Errors immediately if anything is missing. No defaults, no silent skips.
set -euo pipefail

APP_DIR="/opt/proofport-ai"
STATE_FILE="${APP_DIR}/active-slot"
ENV_FILE="${APP_DIR}/.env"

die() { echo "ERROR: $*" >&2; exit 1; }

[[ -f "$STATE_FILE" ]] || die "$STATE_FILE missing — run a deploy first (deploy-blue-green.sh)"
[[ -f "$ENV_FILE" ]]   || die "$ENV_FILE missing — run a deploy first"

SLOT=$(tr -d '[:space:]' < "$STATE_FILE")
CONTAINER="proofport-ai-${SLOT}"

case "$SLOT" in
  blue)  APP_PORT=4002 ;;
  green) APP_PORT=4003 ;;
  *)     die "Unexpected slot value in $STATE_FILE: '$SLOT'" ;;
esac

# Extract required env vars from .env. Empty value → die.
AI_IMAGE=$(grep '^AI_IMAGE=' "$ENV_FILE" | cut -d= -f2- | tr -d '"' | tr -d "'")
DEPLOY_ENV=$(grep '^DEPLOY_ENV=' "$ENV_FILE" | cut -d= -f2- | tr -d '"' | tr -d "'")
AWS_REGION=$(grep '^AWS_REGION=' "$ENV_FILE" | cut -d= -f2- | tr -d '"' | tr -d "'")
ECR_REGISTRY=$(grep '^ECR_REGISTRY=' "$ENV_FILE" | cut -d= -f2- | tr -d '"' | tr -d "'")

[[ -n "$AI_IMAGE" ]]     || die "AI_IMAGE not set in $ENV_FILE"
[[ -n "$DEPLOY_ENV" ]]   || die "DEPLOY_ENV not set in $ENV_FILE"
[[ -n "$AWS_REGION" ]]   || die "AWS_REGION not set in $ENV_FILE"
[[ -n "$ECR_REGISTRY" ]] || die "ECR_REGISTRY not set in $ENV_FILE"

# Export for ecr-login.sh.
export AWS_REGION ECR_REGISTRY

echo "Booting slot ${SLOT} (app=${APP_PORT})"
echo "Image:  $AI_IMAGE"
echo "Region: $AWS_REGION"

# ECR login + pull
/usr/local/bin/ecr-login.sh
docker pull "$AI_IMAGE"

# Remove old container if present (explicit check — no `|| true`).
if docker ps -a --format '{{.Names}}' | grep -q "^${CONTAINER}$"; then
  docker rm -f "$CONTAINER"
fi

docker run -d \
  --name "$CONTAINER" \
  --restart unless-stopped \
  --network host \
  --device /dev/vsock \
  --security-opt seccomp=unconfined \
  --env-file "$ENV_FILE" \
  --log-driver=awslogs \
  --log-opt awslogs-region="$AWS_REGION" \
  --log-opt awslogs-group="/proofport-ai/${DEPLOY_ENV}" \
  --log-opt awslogs-stream="proofport-ai-${SLOT}" \
  --log-opt awslogs-create-group=true \
  -v "$APP_DIR/circuits:/app/circuits" \
  -v "$APP_DIR/logs:/app/logs" \
  "$AI_IMAGE" \
  sh -c "PORT=${APP_PORT} node dist/index.js"

echo "Container '$CONTAINER' started (app=$APP_PORT)"
