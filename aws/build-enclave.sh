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
# Copy circuit packages into build context
# nargo execute needs: Nargo.toml + src/ + target/ for each circuit,
# plus all library dependencies (coinbase-libs, keccak256) with local paths.
# The enclave has NO network, so git dependencies must be resolved here.
# ─────────────────────────────────────────────────────────────

CIRCUITS_DEST="$SCRIPT_DIR/circuits"
KECCAK256_GIT="https://github.com/noir-lang/keccak256"
KECCAK256_TAG="v0.1.1"

if [[ "$SKIP_CIRCUITS" == "false" ]]; then
    log "Preparing circuit packages for enclave build context..."
    rm -rf "$CIRCUITS_DEST"
    mkdir -p "$CIRCUITS_DEST"

    CIRCUITS_SRC="$REPO_ROOT/circuits"
    AI_CIRCUITS_SRC="$AI_ROOT/circuits"

    # Prefer proofport-ai/circuits/ (pre-copied), fall back to parent circuits/
    if [[ -d "$AI_CIRCUITS_SRC" ]]; then
        CIRCUITS_FROM="$AI_CIRCUITS_SRC"
        log "Using circuit source from proofport-ai/circuits/"
    elif [[ -d "$CIRCUITS_SRC" ]]; then
        CIRCUITS_FROM="$CIRCUITS_SRC"
        log "Using circuit source from circuits/ (parent repo)"
    else
        die "No circuit source found. Expected: $AI_CIRCUITS_SRC or $CIRCUITS_SRC"
    fi

    # ── Copy main circuit packages (Nargo.toml + src/ + target/) ──
    REQUIRED_CIRCUITS=(
        "coinbase-attestation"
        "coinbase-country-attestation"
    )

    for circuit_dir in "${REQUIRED_CIRCUITS[@]}"; do
        SRC="$CIRCUITS_FROM/$circuit_dir"
        DEST="$CIRCUITS_DEST/$circuit_dir"

        [[ -d "$SRC" ]] || die "Circuit package missing: $SRC"
        [[ -d "$SRC/target" ]] || die "Circuit not compiled: $SRC/target — compile first with /build-circuit"
        [[ -f "$SRC/Nargo.toml" ]] || die "Nargo.toml missing: $SRC/Nargo.toml"
        [[ -d "$SRC/src" ]] || die "Source missing: $SRC/src"

        CIRCUIT_NAME="${circuit_dir//-/_}"
        BYTECODE="$SRC/target/${CIRCUIT_NAME}.json"
        VK_DIR="$SRC/target/vk"
        VK_FILE="$SRC/target/vk/vk"

        [[ -f "$BYTECODE" ]] || die "Bytecode missing: $BYTECODE"
        [[ -d "$VK_DIR" ]] || die "VK directory missing: $VK_DIR"
        [[ -f "$VK_FILE" ]] || die "VK file missing: $VK_FILE"

        mkdir -p "$DEST/target"
        cp "$SRC/Nargo.toml" "$DEST/"
        cp -r "$SRC/src" "$DEST/"
        cp "$BYTECODE" "$DEST/target/"
        cp -r "$VK_DIR" "$DEST/target/"
        log "Copied $circuit_dir package (Nargo.toml + src/ + target/)"
    done

    # ── Copy coinbase-libs library (local dependency) ──
    LIBS_SRC="$CIRCUITS_FROM/coinbase-libs"
    LIBS_DEST="$CIRCUITS_DEST/coinbase-libs"
    if [[ -d "$LIBS_SRC" ]]; then
        mkdir -p "$LIBS_DEST"
        cp "$LIBS_SRC/Nargo.toml" "$LIBS_DEST/"
        cp -r "$LIBS_SRC/src" "$LIBS_DEST/"
        log "Copied coinbase-libs library"
    else
        die "coinbase-libs missing: $LIBS_SRC"
    fi

    # ── Clone keccak256 library (git dependency → local) ──
    KECCAK_DEST="$CIRCUITS_DEST/keccak256"
    log "Cloning keccak256 $KECCAK256_TAG from GitHub..."
    if command -v git >/dev/null 2>&1; then
        git clone --depth 1 --branch "$KECCAK256_TAG" "$KECCAK256_GIT" "$KECCAK_DEST" 2>&1
        rm -rf "$KECCAK_DEST/.git"
        log "Cloned keccak256 $KECCAK256_TAG"
    else
        die "git is required to clone keccak256. Install git or provide keccak256/ in the build context."
    fi

    # ── Patch all Nargo.toml: replace git keccak256 with local path ──
    log "Patching Nargo.toml files to use local keccak256 path..."
    for toml_file in "$CIRCUITS_DEST"/*/Nargo.toml; do
        if grep -q 'git = "https://github.com/noir-lang/keccak256"' "$toml_file" 2>/dev/null; then
            sed -i 's|keccak256 = { tag = "[^"]*", git = "https://github.com/noir-lang/keccak256" }|keccak256 = { path = "../keccak256" }|g' "$toml_file"
            log "Patched: $toml_file"
        fi
    done

    log "Circuit packages ready in $CIRCUITS_DEST"
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
