#!/usr/bin/env bash
# launch-instance.sh — Launch a proofport-ai EC2 instance (staging or production) on AWS.
#
# Idempotent helper that:
#   1. Resolves the commit SHA of aws/ec2-setup.sh on origin/main (no CDN race)
#   2. Builds a user-data wrapper that exports ECR_REGION/ECR_ACCOUNT_ID then runs
#      ec2-setup.sh from that exact SHA via raw.githubusercontent.com
#   3. Calls `aws ec2 run-instances` with all the right knobs (Nitro Enclave,
#      gp3 100 GB, instance profile, key pair, SG, subnet, tags)
#   4. Allocates an EIP and associates it
#   5. Prints out the values needed for GitHub secrets (instance ID, EIP)
#
# Required env / args (positional):
#   $1  ENV        staging | production
#   $2  AWS_PROFILE   e.g. masselabs-proofport
#
# Hard-coded for the Masse Labs Inc. corporate account in us-east-1:
#   - VPC / Subnet / Security Group / Key Pair / IAM instance profile
#   - ECR account 889629667719
#
# Usage:
#   ./launch-instance.sh staging masselabs-proofport
#   ./launch-instance.sh production masselabs-proofport
#
# No SSH. No manual steps. cloud-init runs ec2-setup.sh once on first boot.
# If it fails, terminate + investigate via /var/log/cloud-init-output.log (via SSM
# Session Manager — no key needed) and re-launch. Do NOT patch in place.

set -euo pipefail

ENV="${1:?usage: $0 <staging|production> <aws_profile>}"
PROFILE="${2:?usage: $0 <staging|production> <aws_profile>}"
REGION="us-east-1"
ACCOUNT_ID="889629667719"

# Per-environment knobs
case "$ENV" in
  staging)
    KEY_NAME="proofport-ai-stg"
    SG_ID="sg-04a39a35572b4c372"
    NAME_TAG="proofport-ai-staging"
    EIP_NAME="proofport-ai-staging"
    INSTANCE_TYPE="c6i.2xlarge"
    ;;
  production)
    KEY_NAME="proofport-ai-prod"
    SG_ID="sg-008fce9e70a571259"
    NAME_TAG="proofport-ai-production"
    EIP_NAME="proofport-ai-production"
    INSTANCE_TYPE="c6i.2xlarge"
    ;;
  *)
    echo "ERROR: ENV must be staging or production" >&2
    exit 1
    ;;
esac

SUBNET_ID="subnet-0da2cf0d6a6c505cd"   # us-east-1a public
INSTANCE_PROFILE="proofport-ai-ec2"
ROOT_VOL_GB="100"

# ---------------------------------------------------------------------------
# 1. Resolve commit SHA on origin/main (pin user-data to this exact ref)
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

git fetch origin main --quiet
SHA="$(git rev-parse origin/main)"

# Sanity-check that the pinned ref includes the --allowerasing fix.
REMOTE_URL="https://raw.githubusercontent.com/zkproofport/proofport-ai/${SHA}/aws/ec2-setup.sh"
if ! curl -fsSL "$REMOTE_URL" | grep -q 'allowerasing'; then
  echo "ERROR: ${REMOTE_URL} does not contain --allowerasing fix. Aborting." >&2
  echo "       Push the fix to origin/main and retry." >&2
  exit 1
fi
echo "Pinned to SHA: $SHA"

# ---------------------------------------------------------------------------
# 2. Build user-data — clones the repo at the pinned SHA so ec2-setup.sh has
#    its sibling files (systemd/*.service, Caddyfile, vsock-bridge.py, etc.)
# ---------------------------------------------------------------------------
USER_DATA=$(cat <<EOF
#!/bin/bash
set -euxo pipefail
export ECR_REGION="$REGION"
export ECR_ACCOUNT_ID="$ACCOUNT_ID"

mkdir -p /var/log/proofport-ai-bootstrap
exec > >(tee -a /var/log/proofport-ai-bootstrap/user-data.log) 2>&1

echo "[\$(date)] proofport-ai bootstrap starting (env=$ENV, sha=$SHA)..."
sleep 5  # let cloud-init network settle

# Install git (curl already preinstalled in AL2023 base image).
dnf install -y --allowerasing git

# Clone the repo pinned to the launch-time SHA. Full clone (not --depth=1)
# because git server-side does not allow fetching arbitrary SHAs.
mkdir -p /opt/setup
chown ec2-user:ec2-user /opt/setup
cd /opt/setup
sudo -u ec2-user git clone https://github.com/zkproofport/proofport-ai.git
sudo -u ec2-user git -C proofport-ai checkout "$SHA"

# Run ec2-setup.sh from inside proofport-ai/aws/ so SCRIPT_DIR resolves to the
# directory that holds its sibling files (Caddyfile, systemd/*.service, etc.)
cd proofport-ai/aws
bash ec2-setup.sh

echo "[\$(date)] bootstrap finished OK"
EOF
)

# ---------------------------------------------------------------------------
# 3. Resolve latest AL2023 AMI in this region
# ---------------------------------------------------------------------------
AMI_ID=$(aws ssm get-parameter \
  --profile "$PROFILE" --region "$REGION" \
  --name /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64 \
  --query 'Parameter.Value' --output text)
echo "AMI: $AMI_ID"

# ---------------------------------------------------------------------------
# 4. Launch instance
# ---------------------------------------------------------------------------
INSTANCE_JSON=$(aws ec2 run-instances \
  --profile "$PROFILE" --region "$REGION" \
  --image-id "$AMI_ID" \
  --instance-type "$INSTANCE_TYPE" \
  --key-name "$KEY_NAME" \
  --subnet-id "$SUBNET_ID" \
  --security-group-ids "$SG_ID" \
  --iam-instance-profile "Name=$INSTANCE_PROFILE" \
  --enclave-options Enabled=true \
  --block-device-mappings "[{\"DeviceName\":\"/dev/xvda\",\"Ebs\":{\"VolumeSize\":$ROOT_VOL_GB,\"VolumeType\":\"gp3\",\"DeleteOnTermination\":true}}]" \
  --user-data "$USER_DATA" \
  --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$NAME_TAG},{Key=Environment,Value=$ENV},{Key=Project,Value=proofport-ai}]" \
  --metadata-options 'HttpTokens=required,HttpPutResponseHopLimit=2' \
  --output json)
INSTANCE_ID=$(echo "$INSTANCE_JSON" | jq -r '.Instances[0].InstanceId')
echo "Launched instance: $INSTANCE_ID"

# ---------------------------------------------------------------------------
# 5. Wait running, allocate + associate EIP
# ---------------------------------------------------------------------------
aws ec2 wait instance-running \
  --profile "$PROFILE" --region "$REGION" \
  --instance-ids "$INSTANCE_ID"

ALLOC_JSON=$(aws ec2 allocate-address \
  --profile "$PROFILE" --region "$REGION" \
  --domain vpc \
  --tag-specifications "ResourceType=elastic-ip,Tags=[{Key=Name,Value=$EIP_NAME}]" \
  --output json)
ALLOC_ID=$(echo "$ALLOC_JSON" | jq -r '.AllocationId')
EIP=$(echo "$ALLOC_JSON" | jq -r '.PublicIp')

aws ec2 associate-address \
  --profile "$PROFILE" --region "$REGION" \
  --instance-id "$INSTANCE_ID" \
  --allocation-id "$ALLOC_ID" >/dev/null

# ---------------------------------------------------------------------------
# 6. Report — what to put into GitHub secrets
# ---------------------------------------------------------------------------
cat <<RESULT

================================================================================
proofport-ai ${ENV} EC2 launched.
================================================================================

  Instance ID:  $INSTANCE_ID
  EIP:          $EIP   (allocation $ALLOC_ID)
  Type:         $INSTANCE_TYPE  (Nitro Enclave enabled)
  AMI:          $AMI_ID  (AL2023)
  Bootstrap:    cloud-init is now running ec2-setup.sh from SHA $SHA
                Watch:  aws ec2 get-console-output --instance-id $INSTANCE_ID
                        --profile $PROFILE --region $REGION --latest
                        --output text | tail -100

  GitHub secrets to set on zkproofport/proofport-app-dev:
    $( [[ "$ENV" == "staging" ]] && echo "STAGING_EC2_INSTANCE_ID" || echo "PRODUCTION_EC2_INSTANCE_ID" )  = $INSTANCE_ID
    $( [[ "$ENV" == "staging" ]] && echo "STAGING_EC2_HOST" || echo "PRODUCTION_EC2_HOST" )        = $EIP

  cloud-init takes ~5-7 min. After it finishes:
    1. Populate /opt/proofport-ai/.env (PROVER_PRIVATE_KEY, OPENAI_API_KEY, etc.)
    2. gh workflow run deploy-ai-aws.yml -f environment=$ENV -f deploy_enclave=true

  DO NOT SSH in to fix bootstrap. If it fails:
    - Read /var/log/cloud-init-output.log via SSM Session Manager
    - Fix ec2-setup.sh in git, push, terminate this instance, re-run launch-instance.sh
================================================================================
RESULT
