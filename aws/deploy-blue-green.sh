#!/usr/bin/env bash
# deploy-blue-green.sh — Zero-downtime blue-green deployment for proofport-ai
#
# Slot layout:
#   blue  — app:4002, sign-page:3200, container: proofport-ai-blue
#   green — app:4003, sign-page:3201, container: proofport-ai-green
#
# State file: /opt/proofport-ai/active-slot ("blue" or "green")
# Default (file missing): "blue" → first deploy targets green
set -euo pipefail

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"
}

die() {
  log "ERROR: $*" >&2
  exit 1
}

# ---------------------------------------------------------------------------
# Slot resolution
# ---------------------------------------------------------------------------
STATE_FILE=/opt/proofport-ai/active-slot

if [[ -f "$STATE_FILE" ]]; then
  CURRENT_SLOT=$(cat "$STATE_FILE")
else
  log "State file not found — assuming first deploy, treating current as blue"
  CURRENT_SLOT=blue
fi

case "$CURRENT_SLOT" in
  blue)
    NEW_SLOT=green
    NEW_APP_PORT=4003
    NEW_SIGN_PORT=3201
    OLD_APP_PORT=4002
    OLD_SIGN_PORT=3200
    ;;
  green)
    NEW_SLOT=blue
    NEW_APP_PORT=4002
    NEW_SIGN_PORT=3200
    OLD_APP_PORT=4003
    OLD_SIGN_PORT=3201
    ;;
  *)
    die "Unexpected slot value in $STATE_FILE: '$CURRENT_SLOT'"
    ;;
esac

NEW_CONTAINER="proofport-ai-${NEW_SLOT}"
OLD_CONTAINER="proofport-ai-${CURRENT_SLOT}"

log "Current slot: ${CURRENT_SLOT} (app:${OLD_APP_PORT}, sign:${OLD_SIGN_PORT})"
log "Target slot:  ${NEW_SLOT}     (app:${NEW_APP_PORT}, sign:${NEW_SIGN_PORT})"

# ---------------------------------------------------------------------------
# Load env vars
# ---------------------------------------------------------------------------
ENV_FILE=/opt/proofport-ai/.env

[[ -f "$ENV_FILE" ]] || die "Env file not found: $ENV_FILE"

# Extract only the vars we need without polluting the environment wholesale
AI_IMAGE=$(grep '^AI_IMAGE=' "$ENV_FILE" | cut -d= -f2- | tr -d '"' | tr -d "'")
DEPLOY_ENV=$(grep '^DEPLOY_ENV=' "$ENV_FILE" | cut -d= -f2- | tr -d '"' | tr -d "'")

[[ -n "$AI_IMAGE" ]]   || die "AI_IMAGE not set in $ENV_FILE"
[[ -n "$DEPLOY_ENV" ]] || die "DEPLOY_ENV not set in $ENV_FILE"

log "Image:       $AI_IMAGE"
log "Deploy env:  $DEPLOY_ENV"

# ---------------------------------------------------------------------------
# ECR login + pull
# ---------------------------------------------------------------------------
log "Logging in to ECR..."
/usr/local/bin/ecr-login.sh

log "Pulling image: $AI_IMAGE"
docker pull "$AI_IMAGE"

# ---------------------------------------------------------------------------
# Remove stale container on new slot (if any)
# ---------------------------------------------------------------------------
log "Removing any stale container: $NEW_CONTAINER"
docker stop "$NEW_CONTAINER" 2>/dev/null || true
docker rm -f "$NEW_CONTAINER" 2>/dev/null || true

# ---------------------------------------------------------------------------
# Start new container
# ---------------------------------------------------------------------------
log "Starting container $NEW_CONTAINER on app:${NEW_APP_PORT} sign:${NEW_SIGN_PORT}..."

docker run -d \
  --name "$NEW_CONTAINER" \
  --network host \
  --device /dev/vsock \
  --security-opt seccomp=unconfined \
  --env-file "$ENV_FILE" \
  --log-driver=awslogs \
  --log-opt awslogs-region=ap-northeast-2 \
  --log-opt "awslogs-group=/proofport-ai/${DEPLOY_ENV}" \
  --log-opt "awslogs-stream=proofport-ai-${NEW_SLOT}" \
  --log-opt awslogs-create-group=true \
  -v /opt/proofport-ai/circuits:/app/circuits \
  -v /opt/proofport-ai/logs:/app/logs \
  "$AI_IMAGE" \
  sh -c "HOSTNAME=0.0.0.0 PORT=${NEW_SIGN_PORT} node /app/sign-page/server.js & PORT=${NEW_APP_PORT} node dist/index.js"

# ---------------------------------------------------------------------------
# Health check — new container must pass before traffic switches
# ---------------------------------------------------------------------------
log "Waiting for $NEW_CONTAINER to become healthy (max 120s)..."

MAX_RETRIES=24
RETRY_INTERVAL=5
healthy=false

for ((i=1; i<=MAX_RETRIES; i++)); do
  app_status=$(curl -s -o /dev/null -w "%{http_code}" \
    "http://localhost:${NEW_APP_PORT}/health" 2>/dev/null || echo "000")

  sign_status=$(curl -s -o /dev/null -w "%{http_code}" \
    "http://localhost:${NEW_SIGN_PORT}/" 2>/dev/null || echo "000")

  log "Health check ${i}/${MAX_RETRIES} — app:${app_status} sign:${sign_status}"

  if [[ "$app_status" == "200" && "$sign_status" != "000" ]]; then
    healthy=true
    break
  fi

  sleep "$RETRY_INTERVAL"
done

if [[ "$healthy" != "true" ]]; then
  log "Health check failed after $((MAX_RETRIES * RETRY_INTERVAL))s — rolling back"
  docker stop "$NEW_CONTAINER" 2>/dev/null || true
  docker rm -f "$NEW_CONTAINER" 2>/dev/null || true
  log "Rollback complete — old container $OLD_CONTAINER is still running"
  exit 1
fi

log "Container $NEW_CONTAINER is healthy"

# ---------------------------------------------------------------------------
# Read CADDY_DOMAIN from systemd drop-in
# ---------------------------------------------------------------------------
CADDY_ENV_CONF=/etc/systemd/system/caddy.service.d/env.conf
if [[ -f "$CADDY_ENV_CONF" ]]; then
  CADDY_DOMAIN=$(grep '^Environment=.*CADDY_DOMAIN=' "$CADDY_ENV_CONF" \
    | sed 's/.*CADDY_DOMAIN=//' | tr -d '"' | tr -d "'" | tr -d ' ')
fi

[[ -n "${CADDY_DOMAIN:-}" ]] || die "CADDY_DOMAIN not found in $CADDY_ENV_CONF — run ec2-setup.sh first"

# Export so caddy reload subprocess can resolve {$CADDY_DOMAIN} in the Caddyfile
export CADDY_DOMAIN

# ---------------------------------------------------------------------------
# Generate Caddyfile with updated port numbers
# ---------------------------------------------------------------------------
CADDYFILE=/etc/caddy/Caddyfile
log "Generating new Caddyfile (app:${NEW_APP_PORT}, sign:${NEW_SIGN_PORT})..."

cat > "$CADDYFILE" <<CADDYFILE_EOF
# Caddyfile — Caddy reverse proxy for proofport-ai on EC2
#
# SSL: Caddy serves HTTPS :443 with a self-signed (internal) certificate.
# Cloudflare connects in "Full" SSL mode — it accepts self-signed origin certs.
# HTTP :80 is kept for local health checks and as fallback.
#
# Traffic flow:
#   Client → Cloudflare (HTTPS/443) → EC2 :443 (HTTPS, self-signed) → app containers
#   Local  → EC2 :80 (HTTP) → app containers (health checks)
#
# Active slot: ${NEW_SLOT}
# Routing:
#   /sign/*   → sign-page Next.js (port ${NEW_SIGN_PORT})  — wallet signing UI
#   /_next/*  → sign-page Next.js (port ${NEW_SIGN_PORT})  — static assets (optimization)
#   /*        → proofport-ai Node.js (port ${NEW_APP_PORT}) — MCP/A2A/REST API
#
# Ports:
#   ${NEW_APP_PORT} — Main app: MCP, A2A, REST API, health check, payment endpoints
#   ${NEW_SIGN_PORT} — sign-page: Next.js static signing UI (/sign/*, /pay/*)

{
  # Admin API on loopback only (for health checks and config reload)
  admin localhost:2019

  # Cloudflare trusted IP ranges for X-Forwarded-For / X-Real-IP
  # Caddy trusts these headers only from Cloudflare's egress IPs.
  # Ref: https://www.cloudflare.com/ips-v4 / https://www.cloudflare.com/ips-v6
  servers {
    trusted_proxies static \
      103.21.244.0/22 \
      103.22.200.0/22 \
      103.31.4.0/22 \
      104.16.0.0/13 \
      104.24.0.0/14 \
      108.162.192.0/18 \
      131.0.72.0/22 \
      141.101.64.0/18 \
      162.158.0.0/15 \
      172.64.0.0/13 \
      173.245.48.0/20 \
      188.114.96.0/20 \
      190.93.240.0/20 \
      197.234.240.0/22 \
      198.41.128.0/17 \
      2400:cb00::/32 \
      2606:4700::/32 \
      2803:f800::/32 \
      2405:b500::/32 \
      2405:8100::/32 \
      2a06:98c0::/29 \
      2c0f:f248::/32
  }

  # Structured JSON logging for CloudWatch integration
  log {
    output stdout
    format json
    level INFO
  }
}

# HTTPS listener — Cloudflare connects here in Full SSL mode
# Uses Caddy's internal (self-signed) certificate — Full mode accepts this.
# {$CADDY_DOMAIN} is set via systemd Environment= (e.g. stg-ai.zkproofport.app)
{\$CADDY_DOMAIN} {
  tls internal

  # ---------------------------------------------------------------------------
  # sign-page routing — Next.js wallet signing UI
  #
  # Routes:
  #   /sign/:requestId   — attestation signing page (EIP-712 typed data)
  #   /pay/:requestId    — x402 payment signing page (EIP-3009 transfer auth)
  #   /s/:requestId      — short alias for /sign/:requestId
  # ---------------------------------------------------------------------------
  handle /sign/* {
    reverse_proxy localhost:${NEW_SIGN_PORT} {
      header_up X-Real-IP {remote_host}
      header_up X-Forwarded-For {remote_host}
      header_up X-Forwarded-Proto {scheme}
    }
  }

  handle /pay/* {
    reverse_proxy localhost:${NEW_SIGN_PORT} {
      header_up X-Real-IP {remote_host}
      header_up X-Forwarded-For {remote_host}
      header_up X-Forwarded-Proto {scheme}
    }
  }

  handle /s/* {
    reverse_proxy localhost:${NEW_SIGN_PORT} {
      header_up X-Real-IP {remote_host}
      header_up X-Forwarded-For {remote_host}
      header_up X-Forwarded-Proto {scheme}
    }
  }

  # Next.js static assets — direct to sign-page (avoids Express proxy hop)
  handle /_next/* {
    reverse_proxy localhost:${NEW_SIGN_PORT} {
      header_up X-Real-IP {remote_host}
      header_up X-Forwarded-For {remote_host}
      header_up X-Forwarded-Proto {scheme}
    }
  }

  # ---------------------------------------------------------------------------
  # Default — all other traffic goes to the main app (MCP/A2A/REST)
  #
  # Includes:
  #   /mcp                  — MCP StreamableHTTP endpoint
  #   /a2a                  — A2A JSON-RPC endpoint
  #   /events               — SSE streaming
  #   /.well-known/*        — Agent card, MCP discovery, OASF
  #   /api/*                — REST API (payment callbacks, status)
  #   /rpc                  — A2A JSON-RPC alias
  # ---------------------------------------------------------------------------
  handle {
    reverse_proxy localhost:${NEW_APP_PORT} {
      header_up X-Real-IP {remote_host}
      header_up X-Forwarded-For {remote_host}
      header_up X-Forwarded-Proto {scheme}

      # Increase timeouts for ZK proof generation (can take several minutes)
      transport http {
        read_timeout  600s
        write_timeout 600s
      }
    }
  }

  # Access log for debugging
  log {
    output stdout
    format json
    level INFO
  }
}

# HTTP listener — kept for local health checks (curl http://localhost/health)
:80 {
  handle /sign/* {
    reverse_proxy localhost:${NEW_SIGN_PORT} {
      header_up X-Real-IP {remote_host}
      header_up X-Forwarded-For {remote_host}
      header_up X-Forwarded-Proto {scheme}
    }
  }

  handle /pay/* {
    reverse_proxy localhost:${NEW_SIGN_PORT} {
      header_up X-Real-IP {remote_host}
      header_up X-Forwarded-For {remote_host}
      header_up X-Forwarded-Proto {scheme}
    }
  }

  handle /s/* {
    reverse_proxy localhost:${NEW_SIGN_PORT} {
      header_up X-Real-IP {remote_host}
      header_up X-Forwarded-For {remote_host}
      header_up X-Forwarded-Proto {scheme}
    }
  }

  handle /_next/* {
    reverse_proxy localhost:${NEW_SIGN_PORT} {
      header_up X-Real-IP {remote_host}
      header_up X-Forwarded-For {remote_host}
      header_up X-Forwarded-Proto {scheme}
    }
  }

  handle {
    reverse_proxy localhost:${NEW_APP_PORT} {
      header_up X-Real-IP {remote_host}
      header_up X-Forwarded-For {remote_host}
      header_up X-Forwarded-Proto {scheme}

      transport http {
        read_timeout  600s
        write_timeout 600s
      }
    }
  }

  log {
    output stdout
    format json
    level INFO
  }
}
CADDYFILE_EOF

# ---------------------------------------------------------------------------
# Reload Caddy — traffic now flows to new slot
# ---------------------------------------------------------------------------
log "Reloading Caddy config..."

if ! caddy reload --config "$CADDYFILE" --adapter caddyfile; then
  log "Caddy reload failed — rolling back"
  docker stop "$NEW_CONTAINER" 2>/dev/null || true
  docker rm -f "$NEW_CONTAINER" 2>/dev/null || true
  log "Rollback complete — old container $OLD_CONTAINER is still running"
  exit 1
fi

log "Caddy reloaded — traffic is now routed to $NEW_SLOT (app:${NEW_APP_PORT}, sign:${NEW_SIGN_PORT})"

# ---------------------------------------------------------------------------
# Drain in-flight requests on old slot
#
# ZK proof generation can take up to 600s. We wait up to 660s (600s timeout
# + 60s buffer) for active connections on the old app port to clear before
# stopping the old container.
# ---------------------------------------------------------------------------
if docker ps --format '{{.Names}}' | grep -q "^${OLD_CONTAINER}$"; then
  log "Draining in-flight requests on old slot $CURRENT_SLOT (port ${OLD_APP_PORT})..."

  DRAIN_MAX=660
  DRAIN_INTERVAL=10
  elapsed=0

  while (( elapsed < DRAIN_MAX )); do
    conn_count=$(ss -tn state established "( sport = :${OLD_APP_PORT} )" 2>/dev/null | grep -c ESTAB || true)
    if [[ "$conn_count" -eq 0 ]]; then
      log "No active connections on port ${OLD_APP_PORT} — drain complete"
      break
    fi
    log "Draining: ${conn_count} active connection(s) on port ${OLD_APP_PORT} (${elapsed}s elapsed, max ${DRAIN_MAX}s)"
    sleep "$DRAIN_INTERVAL"
    elapsed=$(( elapsed + DRAIN_INTERVAL ))
  done

  if (( elapsed >= DRAIN_MAX )); then
    log "Drain timeout reached (${DRAIN_MAX}s) — forcing old container stop"
  fi

  # Stop and remove old container
  log "Stopping old container: $OLD_CONTAINER"
  docker stop "$OLD_CONTAINER" 2>/dev/null || true
  docker rm -f "$OLD_CONTAINER" 2>/dev/null || true
  log "Old container $OLD_CONTAINER removed"
else
  log "Old container $OLD_CONTAINER was not running — nothing to drain"
fi

# ---------------------------------------------------------------------------
# Legacy cleanup — one-time migration from non-blue-green deployment
# Removes the legacy "proofport-ai" container if it still exists.
# Silently ignored if already gone.
# ---------------------------------------------------------------------------
if docker ps -a --format '{{.Names}}' | grep -q '^proofport-ai$'; then
  log "Removing legacy container: proofport-ai (one-time migration)"
  docker stop proofport-ai 2>/dev/null || true
  docker rm proofport-ai 2>/dev/null || true
fi

# ---------------------------------------------------------------------------
# Persist new slot state
# ---------------------------------------------------------------------------
echo "$NEW_SLOT" > "$STATE_FILE"
log "State file updated: $STATE_FILE → $NEW_SLOT"

# ---------------------------------------------------------------------------
# Summary banner
# ---------------------------------------------------------------------------
echo ""
echo "============================================================"
echo "  Blue-green deployment complete"
echo "  Active slot : ${NEW_SLOT}"
echo "  App port    : ${NEW_APP_PORT}  (MCP / A2A / REST)"
echo "  Sign port   : ${NEW_SIGN_PORT}  (Next.js signing UI)"
echo "  Container   : ${NEW_CONTAINER}"
echo "  Image       : ${AI_IMAGE}"
echo "============================================================"
