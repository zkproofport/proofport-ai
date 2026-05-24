#!/usr/bin/env bash
# ecr-login.sh — Authenticate Docker to AWS ECR.
#
# Requires AWS_REGION and ECR_REGISTRY env vars (typically loaded from
# /opt/proofport-ai/.env via systemd EnvironmentFile or `source`).
# Errors immediately if either is missing. No fallback values.
set -euo pipefail

: "${AWS_REGION:?AWS_REGION env var required}"
: "${ECR_REGISTRY:?ECR_REGISTRY env var required}"

aws ecr get-login-password --region "$AWS_REGION" | \
  docker login --username AWS --password-stdin "$ECR_REGISTRY"
