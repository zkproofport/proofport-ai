#!/bin/bash
# `docker compose` for this stack, on the right Docker target.
#
# WHY IT EXISTS. The lifecycle skills (/ai-stop, /ai-logs, /ai-status,
# /ai-reset) called `docker compose` directly, which uses the CURRENT Docker
# context -- not necessarily the one `ai-dev.sh` started the stack on. On a
# machine with two Colima VMs that means stopping a stack that is running
# somewhere else, or reading logs from a daemon that has never heard of it.
# Measured 2026-09-22: the current context was an x86_64 Colima profile kept
# for another project, while the stack ran on the aarch64 default VM.
#
# Teammates on Docker Desktop, plain Linux Docker, or a remote daemon are left
# exactly as they are: the shared library only pins a context when the
# effective connection is Colima, and it pins it for this process only.
#
#   scripts/ai-compose.sh ps
#   scripts/ai-compose.sh logs -f ai
#   scripts/ai-compose.sh down
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AI_DIR="$(dirname "$SCRIPT_DIR")"
REPO_ROOT="$(cd "$AI_DIR/.." && pwd)"

if [ -f "$REPO_ROOT/scripts/lib/dev-docker.sh" ]; then
  # shellcheck source=/dev/null
  source "$REPO_ROOT/scripts/lib/dev-docker.sh"
  dev_docker_init x86_64 >/dev/null || dev_docker_init x86_64   # print the error, then fail
  docker() { command docker "${DEV_DOCKER_ARGS[@]}" "$@"; }
fi

cd "$AI_DIR"
docker compose "$@"
