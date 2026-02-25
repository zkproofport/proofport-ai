#!/usr/bin/env bash
# ec2-setup.sh — Bootstrap a fresh EC2 instance for proofport-ai with Nitro Enclave
#
# Usage: Run manually as root on a fresh Amazon Linux 2023 instance:
#   sudo bash ec2-setup.sh
#
# Or attach as EC2 user data (runs once on first boot).
#
# Target: Amazon Linux 2023 (uses dnf, not yum)
# Minimum: c6i.xlarge (4 vCPU, 8 GB) — 2 vCPU + 4 GB reserved for enclave
#
# What this script does:
#   1. Installs Docker, Docker Compose, AWS CLI, Nitro Enclaves CLI, Caddy
#   2. Configures enclave resource allocation (2 vCPU, 4 GB hugepages)
#   3. Creates /opt/proofport-ai/ directory structure
#   4. Installs all systemd services (app, redis, enclave, vsock-bridge, caddy)
#   5. Installs vsock-bridge.py (TCP-to-vsock proxy for Docker↔Enclave)
#   6. Installs ecr-login.sh helper
#   7. Creates placeholder .env (operator MUST fill in secrets before use)
#   8. Starts Redis and Caddy (app + enclave started after .env is populated)
#
# After running this script:
#   1. Populate /opt/proofport-ai/.env with real values (or run deploy-ai-aws.yml)
#   2. Copy circuit artifacts to /opt/proofport-ai/circuits/
#   3. Build enclave Docker image + EIF (./build-enclave.sh)
#   4. Start services: systemctl start proofport-ai proofport-ai-enclave vsock-bridge
#
# Architecture:
#   Parent instance: Docker (Node.js app:4002 + sign-page:3200) + Redis:6379 + Caddy:443/80
#   Nitro Enclave:   Prover (bb + nargo + circuits) via vsock CID 16, port 5000
#   vsock-bridge:    TCP:15000 ↔ vsock CID:5000 (Docker container can't use vsock directly)
#   Cloudflare:      DNS + SSL proxy (Full mode, self-signed origin cert via Caddy)

set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
APP_DIR="/opt/proofport-ai"
ECR_REGION="ap-northeast-2"
ECR_ACCOUNT_ID="006600133037"
ECR_REGISTRY="${ECR_ACCOUNT_ID}.dkr.ecr.${ECR_REGION}.amazonaws.com"
AI_IMAGE="${ECR_REGISTRY}/proofport-ai:latest"

# Nitro Enclave resource allocation
ENCLAVE_VCPUS=2
ENCLAVE_MEMORY_MB=4096
ENCLAVE_CID=16

# ---------------------------------------------------------------------------
# Logging helpers
# ---------------------------------------------------------------------------
log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }
err() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] ERROR: $*" >&2; }

# ---------------------------------------------------------------------------
# 1. System update + base packages
# ---------------------------------------------------------------------------
log "Step 1/11: Updating system packages..."
dnf update -y
dnf install -y \
  curl \
  wget \
  git \
  jq \
  tar \
  unzip \
  htop \
  lsof \
  net-tools \
  python3

# ---------------------------------------------------------------------------
# 2. Install AWS CLI v2 (needed for ecr-login.sh)
# ---------------------------------------------------------------------------
log "Step 2/11: Installing AWS CLI v2..."
if command -v aws &>/dev/null; then
  log "AWS CLI already installed: $(aws --version)"
else
  curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o /tmp/awscliv2.zip
  unzip -qo /tmp/awscliv2.zip -d /tmp/
  /tmp/aws/install
  rm -rf /tmp/aws /tmp/awscliv2.zip
  log "AWS CLI installed: $(aws --version)"
fi

# ---------------------------------------------------------------------------
# 3. Install Docker
# ---------------------------------------------------------------------------
log "Step 3/11: Installing Docker..."
dnf install -y docker

# Install docker compose plugin (v2)
mkdir -p /usr/local/lib/docker/cli-plugins
COMPOSE_VERSION="v2.24.6"
curl -SL "https://github.com/docker/compose/releases/download/${COMPOSE_VERSION}/docker-compose-linux-x86_64" \
  -o /usr/local/lib/docker/cli-plugins/docker-compose
chmod +x /usr/local/lib/docker/cli-plugins/docker-compose

# Enable and start Docker
systemctl enable docker
systemctl start docker

# Add ec2-user to docker group so it can run docker without sudo
usermod -aG docker ec2-user

log "Docker installed: $(docker --version)"
log "Docker Compose installed: $(docker compose version)"

# ---------------------------------------------------------------------------
# 4. Install AWS Nitro Enclaves CLI
# ---------------------------------------------------------------------------
log "Step 4/11: Installing AWS Nitro Enclaves CLI..."

dnf install -y aws-nitro-enclaves-cli aws-nitro-enclaves-cli-devel

# Add ec2-user to ne group (required for nitro-cli)
usermod -aG ne ec2-user

log "Nitro CLI installed: $(nitro-cli --version 2>/dev/null || echo 'version check pending reboot')"

# ---------------------------------------------------------------------------
# 5. Configure Nitro Enclave allocator + hugepages
# ---------------------------------------------------------------------------
log "Step 5/11: Configuring Nitro Enclave allocator (${ENCLAVE_VCPUS} vCPUs, ${ENCLAVE_MEMORY_MB}MB)..."

cat > /etc/nitro_enclaves/allocator.yaml <<EOF
---
# Nitro Enclave resource allocation
# These resources are reserved exclusively for the enclave.
# The parent instance must have at least (enclave vCPUs + 2) total vCPUs.
memory_mib: ${ENCLAVE_MEMORY_MB}
cpu_count: ${ENCLAVE_VCPUS}
EOF

# Enable and start the allocator service
systemctl enable nitro-enclaves-allocator
systemctl start nitro-enclaves-allocator

# Persist hugepages across reboots via sysctl
cat > /etc/sysctl.d/99-nitro-hugepages.conf <<EOF
# Hugepages for Nitro Enclave (${ENCLAVE_MEMORY_MB}MB = $((ENCLAVE_MEMORY_MB / 2)) pages * 2MB)
vm.nr_hugepages = $((ENCLAVE_MEMORY_MB / 2))
EOF

sysctl -p /etc/sysctl.d/99-nitro-hugepages.conf

log "Nitro Enclave allocator configured and started."

# ---------------------------------------------------------------------------
# 6. Install Caddy (reverse proxy)
# ---------------------------------------------------------------------------
log "Step 6/11: Installing Caddy..."

dnf install -y yum-utils
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/setup.rpm.sh' | bash
dnf install -y caddy

systemctl enable caddy

log "Caddy installed: $(caddy version)"

# ---------------------------------------------------------------------------
# 7. Create application directory structure
# ---------------------------------------------------------------------------
log "Step 7/11: Creating application directory structure at ${APP_DIR}..."

mkdir -p "${APP_DIR}"/{circuits,redis-data,logs,enclave}
mkdir -p "${APP_DIR}/circuits/coinbase-attestation/target"
mkdir -p "${APP_DIR}/circuits/coinbase-country-attestation/target"
mkdir -p /etc/caddy

# Set ownership so ec2-user can manage files
chown -R ec2-user:ec2-user "${APP_DIR}"

# Redis data dir must be owned by redis user (UID 999) inside the container
chown -R 999:999 "${APP_DIR}/redis-data"

# Placeholder .env — deploy-ai-aws.yml overwrites this with real values.
# If setting up manually, replace ALL placeholder values before starting services.
cat > "${APP_DIR}/.env" <<'ENVEOF'
# proofport-ai environment — REPLACE ALL PLACEHOLDER VALUES BEFORE USE
# This file is overwritten by deploy-ai-aws.yml on each deployment.
# Never commit this file to git.

# Server
PORT=4002
NODE_ENV=production

# TEE — Nitro Enclave
TEE_MODE=nitro
ENCLAVE_CID=16
ENCLAVE_PORT=5000
ENCLAVE_BRIDGE_PORT=15000
TEE_ATTESTATION=true

# Redis (local container on EC2)
REDIS_URL=redis://localhost:6379

# Blockchain
BASE_RPC_URL=REPLACE_ME
EAS_GRAPHQL_ENDPOINT=https://base.easscan.org/graphql
CHAIN_RPC_URL=REPLACE_ME
NULLIFIER_REGISTRY_ADDRESS=REPLACE_ME
PROVER_PRIVATE_KEY=REPLACE_ME

# Payment
PAYMENT_MODE=testnet
PAYMENT_PAY_TO=REPLACE_ME
PAYMENT_FACILITATOR_URL=https://www.x402.org/facilitator
PAYMENT_PROOF_PRICE=$0.10

# A2A / Signing
A2A_BASE_URL=REPLACE_ME
SIGN_PAGE_URL=REPLACE_ME
SIGNING_TTL_SECONDS=300

# WalletConnect
WALLETCONNECT_PROJECT_ID=REPLACE_ME

# Tool paths (set by Dockerfile — do not change)
BB_PATH=/usr/local/bin/bb-wrapper
NARGO_PATH=/usr/local/bin/nargo
CIRCUITS_DIR=/app/circuits

# ERC-8004 Identity
ERC8004_IDENTITY_ADDRESS=REPLACE_ME
ERC8004_REPUTATION_ADDRESS=REPLACE_ME
ERC8004_VALIDATION_ADDRESS=REPLACE_ME

# LLM keys
OPENAI_API_KEY=REPLACE_ME
GEMINI_API_KEY=REPLACE_ME

# ECR image reference (read by systemd proofport-ai.service)
ECR_REGISTRY=REPLACE_ME
AI_IMAGE=REPLACE_ME
ENVEOF

chmod 600 "${APP_DIR}/.env"
chown ec2-user:ec2-user "${APP_DIR}/.env"

log "App directory structure created."

# ---------------------------------------------------------------------------
# 8. Configure ECR authentication
# ---------------------------------------------------------------------------
log "Step 8/11: Configuring ECR authentication..."

cat > /usr/local/bin/ecr-login.sh <<EOF
#!/usr/bin/env bash
set -euo pipefail
aws ecr get-login-password --region ${ECR_REGION} | \\
  docker login --username AWS --password-stdin ${ECR_REGISTRY}
EOF
chmod +x /usr/local/bin/ecr-login.sh

# Run initial ECR login (will fail gracefully if IAM role / creds not yet configured)
/usr/local/bin/ecr-login.sh || log "WARNING: ECR login failed — ensure IAM role or AWS credentials are configured."

# ---------------------------------------------------------------------------
# 9. Install vsock-bridge (TCP-to-vsock proxy)
# ---------------------------------------------------------------------------
log "Step 9/11: Installing vsock-bridge..."

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

cp "${SCRIPT_DIR}/vsock-bridge.py" "${APP_DIR}/vsock-bridge.py"
chmod +x "${APP_DIR}/vsock-bridge.py"
chown ec2-user:ec2-user "${APP_DIR}/vsock-bridge.py"

log "vsock-bridge.py installed to ${APP_DIR}/"

# ---------------------------------------------------------------------------
# 10. Install systemd services
# ---------------------------------------------------------------------------
log "Step 10/11: Installing systemd service units..."

# Core services
cp "${SCRIPT_DIR}/systemd/proofport-ai-redis.service"   /etc/systemd/system/
cp "${SCRIPT_DIR}/systemd/proofport-ai.service"          /etc/systemd/system/
cp "${SCRIPT_DIR}/systemd/proofport-ai-enclave.service"  /etc/systemd/system/
cp "${SCRIPT_DIR}/systemd/vsock-bridge.service"          /etc/systemd/system/

# Caddy configuration
cp "${SCRIPT_DIR}/Caddyfile" /etc/caddy/Caddyfile

# Caddy systemd drop-in for CADDY_DOMAIN environment variable
mkdir -p /etc/systemd/system/caddy.service.d/
cp "${SCRIPT_DIR}/systemd/caddy-env.conf" /etc/systemd/system/caddy.service.d/env.conf

systemctl daemon-reload

# Enable all services (start order handled by After= in unit files)
systemctl enable proofport-ai-redis
systemctl enable proofport-ai
systemctl enable proofport-ai-enclave
systemctl enable vsock-bridge

log "Systemd services installed and enabled."

# ---------------------------------------------------------------------------
# 11. Start basic services
# ---------------------------------------------------------------------------
log "Step 11/11: Starting basic services..."

# Start Redis (always needed)
systemctl start proofport-ai-redis
log "Redis started."

# Start Caddy (reverse proxy — works even before app is running)
systemctl start caddy
log "Caddy started."

# Note: proofport-ai and enclave services are NOT started here because:
# - .env has placeholder values (deploy-ai-aws.yml populates them)
# - Circuit artifacts must be copied first
# - Enclave EIF must be built first
#
# After populating .env and building the enclave:
#   sudo systemctl start proofport-ai
#   sudo systemctl start proofport-ai-enclave
#   sudo systemctl start vsock-bridge

# ---------------------------------------------------------------------------
# Final status
# ---------------------------------------------------------------------------
log ""
log "============================================================"
log "  proofport-ai EC2 setup complete"
log "============================================================"
log ""
log "  App directory:   ${APP_DIR}"
log "  Enclave CID:     ${ENCLAVE_CID}"
log "  Enclave vCPUs:   ${ENCLAVE_VCPUS}"
log "  Enclave memory:  ${ENCLAVE_MEMORY_MB}MB"
log ""
log "  Next steps:"
log "  1. Run deploy-ai-aws.yml to populate .env and deploy the app"
log "     OR manually edit ${APP_DIR}/.env with real values"
log "  2. Copy circuit artifacts to ${APP_DIR}/circuits/"
log "  3. Build enclave: ./build-enclave.sh"
log "  4. Start all services:"
log "       sudo systemctl start proofport-ai"
log "       sudo systemctl start proofport-ai-enclave"
log "       sudo systemctl start vsock-bridge"
log ""
log "  Service status:"
systemctl is-active proofport-ai-redis && log "    Redis:        running" || log "    Redis:        stopped"
systemctl is-active proofport-ai       && log "    App:          running" || log "    App:          stopped"
systemctl is-active caddy              && log "    Caddy:        running" || log "    Caddy:        stopped"
systemctl is-active vsock-bridge       && log "    vsock-bridge: running" || log "    vsock-bridge: stopped"
log ""
