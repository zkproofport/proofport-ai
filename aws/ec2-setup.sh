#!/usr/bin/env bash
# ec2-setup.sh — EC2 user data / initial setup script for proofport-ai on Amazon Linux 2023
#
# Usage: Attach as EC2 user data (runs once on first boot), or run manually as root.
# Target: Amazon Linux 2023 (uses dnf, not yum)
# Purpose: Install Docker, Nitro Enclave CLI, Caddy, configure app directories,
#          allocate enclave resources, and enable all services.
#
# Architecture:
#   - Parent instance: Docker (Node.js app + sign-page) + Redis + Caddy
#   - Nitro Enclave: Prover (bb CLI + circuits) via vsock CID 16
#   - Cloudflare: SSL termination in proxy mode (Full SSL)

set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
APP_DIR="/opt/proofport-ai"
ECR_REGION="ap-northeast-2"          # Update to your ECR region
ECR_ACCOUNT_ID="YOUR_AWS_ACCOUNT_ID" # Update with your AWS account ID
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
# 1. System update
# ---------------------------------------------------------------------------
log "Updating system packages..."
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
  net-tools

# ---------------------------------------------------------------------------
# 2. Install Docker
# ---------------------------------------------------------------------------
log "Installing Docker..."
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
# 3. Install AWS Nitro Enclaves CLI
# ---------------------------------------------------------------------------
log "Installing AWS Nitro Enclaves CLI..."

# Install nitro-enclaves-cli from Amazon Linux 2023 repo
dnf install -y aws-nitro-enclaves-cli aws-nitro-enclaves-cli-devel

# Add ec2-user to ne group (required for nitro-cli)
usermod -aG ne ec2-user

log "Nitro CLI installed: $(nitro-cli --version 2>/dev/null || echo 'version check pending reboot')"

# ---------------------------------------------------------------------------
# 4. Configure Nitro Enclave allocator
# ---------------------------------------------------------------------------
log "Configuring Nitro Enclave allocator (${ENCLAVE_VCPUS} vCPUs, ${ENCLAVE_MEMORY_MB}MB)..."

# Write allocator config
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

log "Nitro Enclave allocator configured and started."

# ---------------------------------------------------------------------------
# 5. Configure hugepages for enclave memory
# ---------------------------------------------------------------------------
log "Configuring hugepages for enclave memory..."

# The nitro-enclaves-allocator service manages hugepage allocation automatically
# based on the memory_mib setting in /etc/nitro_enclaves/allocator.yaml.
# No manual sysctl configuration is needed on Amazon Linux 2023.
cat > /etc/sysctl.d/99-nitro-hugepages.conf <<EOF
# Hugepages for Nitro Enclave (${ENCLAVE_MEMORY_MB}MB = $((ENCLAVE_MEMORY_MB / 2)) pages * 2MB)
vm.nr_hugepages = $((ENCLAVE_MEMORY_MB / 2))
EOF

sysctl -p /etc/sysctl.d/99-nitro-hugepages.conf

# ---------------------------------------------------------------------------
# 6. Install Caddy (reverse proxy)
# ---------------------------------------------------------------------------
log "Installing Caddy..."

# Import Caddy GPG key and repo for Amazon Linux 2023
dnf install -y yum-utils
# Caddy provides an RPM repo compatible with RHEL/Amazon Linux
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/setup.rpm.sh' | bash
dnf install -y caddy

# Enable Caddy service (config applied after app setup)
systemctl enable caddy

log "Caddy installed: $(caddy version)"

# ---------------------------------------------------------------------------
# 7. Create application directory structure
# ---------------------------------------------------------------------------
log "Creating application directory structure at ${APP_DIR}..."

mkdir -p "${APP_DIR}"/{circuits,redis-data,logs,enclave}
mkdir -p "${APP_DIR}/circuits/coinbase-attestation/target"
mkdir -p "${APP_DIR}/circuits/coinbase-country-attestation/target"
mkdir -p /etc/caddy

# Set ownership so ec2-user can manage files
chown -R ec2-user:ec2-user "${APP_DIR}"

# Placeholder .env — operator MUST replace with real values before starting services
cat > "${APP_DIR}/.env" <<'EOF'
# proofport-ai environment — REPLACE ALL PLACEHOLDER VALUES BEFORE USE
# Never commit this file to git.

# Server
PORT=4002
NODE_ENV=production

# TEE Mode — MUST be 'nitro' on EC2 Nitro Enclave instances
TEE_MODE=nitro
ENCLAVE_CID=16
ENCLAVE_PORT=5000
TEE_ATTESTATION=true

# Redis (local container)
REDIS_URL=redis://localhost:6379

# Blockchain — REPLACE with real values
BASE_RPC_URL=REPLACE_WITH_BASE_MAINNET_RPC
CHAIN_RPC_URL=REPLACE_WITH_BASE_MAINNET_RPC
EAS_GRAPHQL_ENDPOINT=https://base.easscan.org/graphql
NULLIFIER_REGISTRY_ADDRESS=REPLACE_WITH_DEPLOYED_ADDRESS
PROVER_PRIVATE_KEY=REPLACE_WITH_PROVER_WALLET_PRIVATE_KEY

# Payment
PAYMENT_MODE=mainnet

# Signing (Privy — optional phase 1)
PRIVY_APP_ID=REPLACE_IF_USING_PRIVY
PRIVY_API_SECRET=REPLACE_IF_USING_PRIVY

# ECR image (used by systemd service)
ECR_REGISTRY=YOUR_AWS_ACCOUNT_ID.dkr.ecr.ap-northeast-2.amazonaws.com
AI_IMAGE=YOUR_AWS_ACCOUNT_ID.dkr.ecr.ap-northeast-2.amazonaws.com/proofport-ai:latest
EOF

chmod 600 "${APP_DIR}/.env"
chown ec2-user:ec2-user "${APP_DIR}/.env"

log "App directory structure created."

# ---------------------------------------------------------------------------
# 8. Configure ECR authentication (via instance IAM role)
# ---------------------------------------------------------------------------
log "Configuring ECR authentication..."

# Create a helper script that refreshes ECR credentials.
# The EC2 instance must have an IAM role with ecr:GetAuthorizationToken
# and ecr:BatchGetImage permissions.
cat > /usr/local/bin/ecr-login.sh <<EOF
#!/usr/bin/env bash
set -euo pipefail
# Authenticate Docker to ECR using the instance's IAM role credentials
aws ecr get-login-password --region ${ECR_REGION} | \\
  docker login --username AWS --password-stdin ${ECR_REGISTRY}
EOF
chmod +x /usr/local/bin/ecr-login.sh

# Run initial ECR login (will fail gracefully if IAM role not yet attached)
/usr/local/bin/ecr-login.sh || log "WARNING: ECR login failed — ensure IAM role is attached."

# ---------------------------------------------------------------------------
# 9. Install systemd services
# ---------------------------------------------------------------------------
log "Installing systemd service units..."

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Copy service files to systemd directory
cp "${SCRIPT_DIR}/systemd/proofport-ai-redis.service"   /etc/systemd/system/
cp "${SCRIPT_DIR}/systemd/proofport-ai.service"          /etc/systemd/system/
cp "${SCRIPT_DIR}/systemd/proofport-ai-enclave.service"  /etc/systemd/system/

# Install Caddyfile
cp "${SCRIPT_DIR}/Caddyfile" /etc/caddy/Caddyfile

systemctl daemon-reload

# Enable all services (start order handled by After= in unit files)
systemctl enable proofport-ai-redis
systemctl enable proofport-ai
systemctl enable proofport-ai-enclave

log "Systemd services installed and enabled."

# ---------------------------------------------------------------------------
# 10. Start services
# ---------------------------------------------------------------------------
log "Starting services..."

systemctl start proofport-ai-redis
log "Redis started."

# Pull the latest app image before starting the main service
/usr/local/bin/ecr-login.sh && docker pull "${AI_IMAGE}" || \
  log "WARNING: Could not pull AI image — update .env and start manually."

systemctl start proofport-ai
log "proofport-ai app started."

# Caddy starts after the app is running
systemctl start caddy
log "Caddy started."

# Note: proofport-ai-enclave requires the EIF file to exist.
# Build the enclave image first (see README), then:
#   systemctl start proofport-ai-enclave

# ---------------------------------------------------------------------------
# 11. Final status
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
log "  IMPORTANT — Before starting services:"
log "  1. Edit ${APP_DIR}/.env and replace ALL placeholder values"
log "  2. Copy circuit artifacts to ${APP_DIR}/circuits/"
log "  3. Build enclave EIF: nitro-cli build-enclave --docker-uri <img> --output-file ${APP_DIR}/enclave.eif"
log "  4. Start enclave: systemctl start proofport-ai-enclave"
log ""
log "  Service status:"
systemctl is-active proofport-ai-redis && log "  Redis:   running" || log "  Redis:   stopped"
systemctl is-active proofport-ai       && log "  App:     running" || log "  App:     stopped"
systemctl is-active caddy              && log "  Caddy:   running" || log "  Caddy:   stopped"
log ""
