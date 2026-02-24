#!/usr/bin/env bash
# build-enclave.sh — Build the Nitro Enclave EIF from Dockerfile.enclave
#
# Prerequisites (on the EC2 instance):
#   - Docker installed and running
#   - nitro-cli installed: amazon-linux-extras install aws-nitro-enclaves-cli
#   - Circuit artifacts compiled: circuits/*/target/*.json + vk
#
# Usage:
#   ./build-enclave.sh                    # Build enclave EIF with circuit artifacts
#   ./build-enclave.sh --skip-circuits    # Skip circuit copy (use existing aws/circuits/)
#   ./build-enclave.sh --output /path/to/enclave.eif
#
# Output:
#   /opt/proofport-ai/enclave.eif         # Default output path
#   PCR0, PCR1, PCR2 values printed to stdout (record these for attestation verification)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
AI_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# ─────────────────────────────────────────────────────────────
# Defaults
# ─────────────────────────────────────────────────────────────

OUTPUT_EIF="/opt/proofport-ai/enclave.eif"
SKIP_CIRCUITS=false
DOCKER_IMAGE="proofport-ai-enclave:latest"
BUILD_CONTEXT="$SCRIPT_DIR"

# ─────────────────────────────────────────────────────────────
# Argument parsing
# ─────────────────────────────────────────────────────────────

while [[ $# -gt 0 ]]; do
    case "$1" in
        --skip-circuits)
            SKIP_CIRCUITS=true
            shift
            ;;
        --output)
            OUTPUT_EIF="$2"
            shift 2
            ;;
        --image)
            DOCKER_IMAGE="$2"
            shift 2
            ;;
        --help|-h)
            sed -n '2,20p' "$0" | sed 's/^# //'
            exit 0
            ;;
        *)
            echo "Unknown argument: $1" >&2
            exit 1
            ;;
    esac
done

# ─────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────

log() { echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] $*"; }
die() { echo "ERROR: $*" >&2; exit 1; }

# ─────────────────────────────────────────────────────────────
# Prerequisite checks
# ─────────────────────────────────────────────────────────────

log "Checking prerequisites..."

command -v docker >/dev/null 2>&1 || die "Docker is not installed or not in PATH"
command -v nitro-cli >/dev/null 2>&1 || die "nitro-cli is not installed. Run: amazon-linux-extras install aws-nitro-enclaves-cli"

docker info >/dev/null 2>&1 || die "Docker daemon is not running"

# ─────────────────────────────────────────────────────────────
# Copy circuit artifacts into build context
# ─────────────────────────────────────────────────────────────

CIRCUITS_DEST="$SCRIPT_DIR/circuits"

if [[ "$SKIP_CIRCUITS" == "false" ]]; then
    log "Copying circuit artifacts into build context..."
    mkdir -p "$CIRCUITS_DEST"

    CIRCUITS_SRC="$REPO_ROOT/circuits"
    AI_CIRCUITS_SRC="$AI_ROOT/circuits"

    # Prefer proofport-ai/circuits/ (pre-copied), fall back to parent circuits/
    if [[ -d "$AI_CIRCUITS_SRC" ]]; then
        CIRCUITS_FROM="$AI_CIRCUITS_SRC"
        log "Using circuit artifacts from proofport-ai/circuits/"
    elif [[ -d "$CIRCUITS_SRC" ]]; then
        CIRCUITS_FROM="$CIRCUITS_SRC"
        log "Using circuit artifacts from circuits/ (parent repo)"
    else
        die "No circuit artifacts found. Expected: $AI_CIRCUITS_SRC or $CIRCUITS_SRC"
    fi

    # Copy each circuit's target directory
    REQUIRED_CIRCUITS=(
        "coinbase-attestation"
        "coinbase-country-attestation"
    )

    for circuit_dir in "${REQUIRED_CIRCUITS[@]}"; do
        SRC_TARGET="$CIRCUITS_FROM/$circuit_dir/target"
        DEST_TARGET="$CIRCUITS_DEST/$circuit_dir/target"

        if [[ ! -d "$SRC_TARGET" ]]; then
            die "Circuit artifacts missing: $SRC_TARGET — compile circuits first with /build-circuit"
        fi

        # Check for required artifacts
        CIRCUIT_NAME="${circuit_dir//-/_}"
        BYTECODE="$SRC_TARGET/${CIRCUIT_NAME}.json"
        VK="$SRC_TARGET/vk"

        [[ -f "$BYTECODE" ]] || die "Bytecode missing: $BYTECODE"
        [[ -f "$VK" ]] || die "VK missing: $VK"

        mkdir -p "$DEST_TARGET"
        cp "$BYTECODE" "$DEST_TARGET/"
        cp "$VK" "$DEST_TARGET/"
        log "Copied $circuit_dir artifacts (bytecode + vk)"
    done

    log "Circuit artifacts ready in $CIRCUITS_DEST"
else
    log "Skipping circuit copy (--skip-circuits)"
    if [[ ! -d "$CIRCUITS_DEST" ]]; then
        die "No circuits/ directory in build context. Remove --skip-circuits or run without it first."
    fi
fi

# ─────────────────────────────────────────────────────────────
# Build Docker image for enclave
# ─────────────────────────────────────────────────────────────

log "Building enclave Docker image: $DOCKER_IMAGE"
docker build \
    --platform linux/amd64 \
    -f "$SCRIPT_DIR/Dockerfile.enclave" \
    -t "$DOCKER_IMAGE" \
    "$BUILD_CONTEXT"

log "Docker image built successfully: $DOCKER_IMAGE"

# ─────────────────────────────────────────────────────────────
# Build Nitro Enclave Image File (EIF)
# ─────────────────────────────────────────────────────────────

OUTPUT_DIR="$(dirname "$OUTPUT_EIF")"
mkdir -p "$OUTPUT_DIR"

log "Building Nitro Enclave EIF: $OUTPUT_EIF"
BUILD_OUTPUT="$(
    nitro-cli build-enclave \
        --docker-uri "$DOCKER_IMAGE" \
        --output-file "$OUTPUT_EIF" \
        2>&1
)"

echo "$BUILD_OUTPUT"

# ─────────────────────────────────────────────────────────────
# Extract and display PCR values
# ─────────────────────────────────────────────────────────────

log "Enclave EIF built successfully: $OUTPUT_EIF"
echo ""
echo "══════════════════════════════════════════════════════════"
echo "  ENCLAVE PCR VALUES — Record these for attestation!"
echo "══════════════════════════════════════════════════════════"

# nitro-cli build-enclave outputs PCR values as JSON in its output
if echo "$BUILD_OUTPUT" | grep -q '"PCR0"'; then
    echo "$BUILD_OUTPUT" | grep -E '"PCR[0-9]"' | while IFS= read -r line; do
        echo "  $line"
    done
else
    # Try nitro-cli describe-eif for PCR values
    log "Extracting PCR values via nitro-cli describe-eif..."
    nitro-cli describe-eif --eif-path "$OUTPUT_EIF" 2>/dev/null || true
fi

echo ""
echo "Store these PCR values in:"
echo "  proofport-ai/.env.staging    (TEE_EXPECTED_PCR0=...)"
echo "  proofport-ai/.env.production (TEE_EXPECTED_PCR0=...)"
echo ""
echo "EIF file: $OUTPUT_EIF"
echo "EIF size: $(du -sh "$OUTPUT_EIF" | cut -f1)"
echo "══════════════════════════════════════════════════════════"

# ─────────────────────────────────────────────────────────────
# Cleanup build context circuits (avoid committing large artifacts)
# ─────────────────────────────────────────────────────────────

if [[ "$SKIP_CIRCUITS" == "false" ]]; then
    log "Cleaning up build context circuits/ (artifacts are in the EIF, not needed here)"
    rm -rf "$CIRCUITS_DEST"
fi

log "Done."
