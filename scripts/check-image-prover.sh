#!/bin/bash
# Does the image's bb produce proofs the committed verification keys accept?
#
# For every circuit the server proves (src/config/circuitIds.ts) this:
#   1. makes a fresh witness from the circuit's Prover.toml (local, not
#      committed) with the pinned nargo, in a temporary copy of the committed
#      circuits tree (nargo execute rewrites target/, and has no option to
#      write elsewhere);
#   2. checks that the copy compiled to the same bytecode as the committed
#      artifact -- otherwise the witness would not belong to it;
#   3. runs `bb prove` and `bb verify` inside the built image exactly as
#      src/prover/bbProver.ts calls them (committed json, -k committed vk,
#      -t evm);
#   4. does the same with the Mac's pinned native bb and compares proof sizes.
#      A different bb can share the key and differ only in proof size (see
#      CLAUDE.md, Tool Version Lock), so a verified proof alone is not enough.
#
# Which tree: the COMMITTED one by default. CIRCUITS_TREE=worktree checks the
# circuits working tree instead (tracked and untracked, not ignored) -- for a
# toolchain move whose rebuilt artifacts are not committed yet. Either way the
# artifacts proved against are the ones in that tree, saved before
# `nargo execute` touches the copy; until 2026-11-17 the script proved against
# the working tree's target/ while compiling HEAD's source, which mixes two
# trees whenever the circuits checkout is dirty.
#
# Saved witness_*.gz files in the circuits repo are not used: they are
# untracked and several are older than the circuit they sit next to (on
# 2026-11-10 coinbase-attestation-v2's held 352031 values for a circuit that
# needs 396646).
#
# It needs no server, no Redis and no cloud credentials, so it answers "is the
# prover in this image right" on its own -- the question that mattered when
# the image switched to a bb built for its own architecture (2026-11-10).
#
# Prerequisites: the image built (scripts/ai-dev.sh builds it); the parent
# circuits repo next to this one; nargo and bb at the versions in
# circuits/toolchain.env, installed into their versioned folders by
# circuits/scripts/install-toolchain.sh (resolved through
# circuits/scripts/lib/toolchain.sh, never from PATH); jq.
#
#   ./scripts/check-image-prover.sh                 # image proofport-ai-ai:latest
#   CIRCUITS_TREE=worktree ./scripts/check-image-prover.sh
#   WITNESS_DIR=<dir> ./scripts/check-image-prover.sh
#
# WITNESS_DIR: a circuit whose inputs need the server's Cloud KMS statement
# (coinbase-attestation-v2, oidc-domain-attestation) has no Prover.toml that
# stays valid -- the statement is signed per request. Give it a witness built
# by the server's own input code instead, as <WITNESS_DIR>/<circuit dir>.gz:
#   npx tsx scripts/check-coinbase-inputs.ts <coinbase_attestation_v2.json> --save <d>
#   npx tsx scripts/check-oidc-inputs.ts <oidc_domain_attestation.json> --prove <bb> --save <d>
# each write <d>/witness.gz for the artifact they were given. A witness found
# there is used in place of Prover.toml; it must come from the same artifact
# being checked, which is the tree's own target/<package>.json.
#   IMAGE=some/other:tag ./scripts/check-image-prover.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AI_DIR="$(dirname "$SCRIPT_DIR")"
REPO_ROOT="$(cd "$AI_DIR/.." && pwd)"
CIRCUITS="$REPO_ROOT/circuits"
IMAGE="${IMAGE:-proofport-ai-ai:latest}"
CIRCUITS_TREE="${CIRCUITS_TREE:-committed}"
case "$CIRCUITS_TREE" in
  committed|worktree) ;;
  *) echo "[ERROR] CIRCUITS_TREE='$CIRCUITS_TREE'. Known: committed, worktree"; exit 1 ;;
esac

if [ -f "$REPO_ROOT/scripts/lib/dev-docker.sh" ]; then
  # shellcheck source=/dev/null
  source "$REPO_ROOT/scripts/lib/dev-docker.sh"
  dev_docker_init || exit 1
  docker() { command docker "${DEV_DOCKER_ARGS[@]}" "$@"; }
fi

[ -d "$CIRCUITS/.git" ] || [ -f "$CIRCUITS/.git" ] || { echo "[ERROR] No circuits repo at $CIRCUITS"; exit 1; }
docker image inspect "$IMAGE" >/dev/null 2>&1 || { echo "[ERROR] No image $IMAGE. Build it: ./scripts/ai-dev.sh"; exit 1; }
command -v jq >/dev/null 2>&1 || { echo "[ERROR] jq not found"; exit 1; }

# The pinned pair from their versioned folders; refuses a wrong version.
# shellcheck source=/dev/null
source "$CIRCUITS/scripts/lib/toolchain.sh"
NATIVE_BB="${NATIVE_BB:-$BB_BIN}"
echo "[*] nargo: $NARGO_BIN ($("$NARGO_BIN" --version | sed -n 's/^nargo version = //p')); pinned: $NARGO_VERSION"
image_bb="$(docker run --rm --entrypoint /usr/local/bin/bb-wrapper "$IMAGE" --version)"
native_bb="$("$NATIVE_BB" --version)"
echo "[*] Image: $IMAGE ($(docker image inspect "$IMAGE" --format '{{.Architecture}}')), bb $image_bb"
echo "[*] Native bb: $NATIVE_BB, $native_bb; pinned: $BB_VERSION"
[ "$image_bb" = "$BB_VERSION" ] || { echo "[FAIL] the image's bb is not the pinned $BB_VERSION"; exit 1; }
[ "$native_bb" = "$BB_VERSION" ] || { echo "[ERROR] the native bb is not the pinned $BB_VERSION; it cannot be the reference"; exit 1; }

if [ "$CIRCUITS_TREE" = committed ] && [ -n "$(git -C "$CIRCUITS" status --porcelain)" ]; then
  echo "[!] The circuits working tree has changes; this checks the COMMITTED tree ($(git -C "$CIRCUITS" rev-parse --short HEAD))."
  echo "    CIRCUITS_TREE=worktree checks the working tree instead."
fi

CIRCUIT_LIST="$(cd "$AI_DIR" && npx tsx scripts/print-circuit-dirs.ts)"
[ -n "$CIRCUIT_LIST" ] || { echo "[ERROR] Could not read the circuit list from src/config/circuitIds.ts"; exit 1; }

# Under $HOME, not $TMPDIR: Colima shares only the home directory with its VM,
# so a witness mounted from /var/folders reaches the container as an empty
# file and bb answers "Invalid gzip data".
mkdir -p "$HOME/.cache/proofport-ai"
CRS_CACHE="$HOME/.cache/proofport-ai/bb-crs"
mkdir -p "$CRS_CACHE"
BB_TIMEOUT="${BB_TIMEOUT:-600}"
WORK="$(mktemp -d "$HOME/.cache/proofport-ai/check-image-prover.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
if [ "$CIRCUITS_TREE" = committed ]; then
  echo "[*] Copying the committed circuits tree (without SRS files) to $WORK"
  git -C "$CIRCUITS" archive HEAD -- . ':(exclude)*.srs' ':(exclude)*.srs.part*' | tar -x -C "$WORK"
else
  echo "[*] Copying the circuits WORKING tree at $(git -C "$CIRCUITS" rev-parse --short HEAD) plus changes (without SRS files) to $WORK"
  # Tracked files still present plus untracked ones that are not ignored.
  (cd "$CIRCUITS" && git ls-files -z --cached --others --exclude-standard -- . ':(exclude)*.srs' ':(exclude)*.srs.part*' \
    | while IFS= read -r -d '' f; do [ -f "$f" ] && printf '%s\0' "$f"; done \
    | tar -c --null -T - -f -) | tar -x -C "$WORK"
fi

PASSED=0 FAILED=0 NO_INPUTS=0
while read -r dir package _circuit_id; do
  [ -z "$dir" ] && continue
  src="$WORK/$dir"
  # The artifacts of the tree being checked, saved before nargo execute
  # rewrites target/ in the copy.
  committed="$WORK/$dir.artifacts"
  if [ ! -f "$src/target/$package.json" ] || [ ! -f "$src/target/vk/vk" ]; then
    echo "  [FAIL] $dir: the $CIRCUITS_TREE tree has no target/$package.json and target/vk/vk"
    FAILED=$((FAILED + 1))
    continue
  fi
  mkdir -p "$committed/vk"
  cp "$src/target/$package.json" "$committed/"
  cp "$src/target/vk/vk" "$committed/vk/vk"
  given_witness="${WITNESS_DIR:+$WITNESS_DIR/$dir.gz}"
  if [ -n "$given_witness" ] && [ -f "$given_witness" ]; then
    witness="$WORK/$dir.given.gz"
    cp "$given_witness" "$witness"
    echo "  [..] $dir: witness from $given_witness (not from Prover.toml)"
  # Prover.toml is not committed (it holds a real attestation's inputs), so it
  # comes from the working tree.
  elif [ ! -f "$CIRCUITS/$dir/Prover.toml" ]; then
    echo "  [--] $dir: no Prover.toml in $CIRCUITS/$dir, not checked"
    NO_INPUTS=$((NO_INPUTS + 1))
    continue
  else
    cp "$CIRCUITS/$dir/Prover.toml" "$src/Prover.toml"
    if ! (cd "$src" && "$NARGO_BIN" execute image-check > "$WORK/$dir.nargo.log" 2>&1); then
      echo "  [FAIL] $dir: nargo execute failed on its own Prover.toml:"
      sed 's/^/         /' "$WORK/$dir.nargo.log"
      FAILED=$((FAILED + 1))
      continue
    fi
    if [ "$(jq -r .bytecode "$src/target/$package.json")" != "$(jq -r .bytecode "$committed/$package.json")" ]; then
      echo "  [FAIL] $dir: the $CIRCUITS_TREE $package.json does not match its $CIRCUITS_TREE source"
      FAILED=$((FAILED + 1))
      continue
    fi
    witness="$src/target/image-check.gz"
  fi

  start=$(date +%s)
  # bb downloads its reference string (the public setup points) on first use,
  # into ~/.bb-crs. The cache below keeps it between runs, and `timeout` turns
  # a stalled download into a failure: on 2026-11-10 one sat on an idle socket
  # for ten minutes with nothing written.
  if ! image_size="$(docker run --rm --entrypoint bash \
      -v "$committed:/t:ro" -v "$witness:/w.gz:ro" -v "$CRS_CACHE:/root/.bb-crs" "$IMAGE" -c "
      set -e; mkdir -p /tmp/p
      timeout $BB_TIMEOUT /usr/local/bin/bb-wrapper prove -b /t/$package.json -w /w.gz -k /t/vk/vk -o /tmp/p -t evm >/dev/null
      timeout $BB_TIMEOUT /usr/local/bin/bb-wrapper verify -p /tmp/p/proof -i /tmp/p/public_inputs -k /t/vk/vk -t evm >/dev/null
      wc -c < /tmp/p/proof" 2>"$WORK/$dir.image.log")"; then
    echo "  [FAIL] $dir: the image's bb did not prove and verify:"
    sed 's/^/         /' "$WORK/$dir.image.log"
    FAILED=$((FAILED + 1))
    continue
  fi
  image_secs=$(( $(date +%s) - start ))
  image_size="$(echo "$image_size" | tr -d ' ')"

  mkdir -p "$WORK/$dir.native"
  start=$(date +%s)
  if ! "$NATIVE_BB" prove -b "$committed/$package.json" -w "$witness" -k "$committed/vk/vk" -o "$WORK/$dir.native" -t evm >"$WORK/$dir.native.log" 2>&1 \
     || ! "$NATIVE_BB" verify -p "$WORK/$dir.native/proof" -i "$WORK/$dir.native/public_inputs" -k "$committed/vk/vk" -t evm >>"$WORK/$dir.native.log" 2>&1; then
    echo "  [FAIL] $dir: the native bb did not prove and verify, so there is no reference:"
    sed 's/^/         /' "$WORK/$dir.native.log"
    FAILED=$((FAILED + 1))
    continue
  fi
  native_secs=$(( $(date +%s) - start ))
  native_size="$(wc -c < "$WORK/$dir.native/proof" | tr -d ' ')"

  if [ "$image_size" = "$native_size" ]; then
    echo "  [OK] $dir: image bb proved and verified in ${image_secs}s, $image_size bytes; native bb ${native_secs}s, $native_size bytes"
    PASSED=$((PASSED + 1))
  else
    echo "  [FAIL] $dir: both verified, but the image's proof is $image_size bytes and the native one $native_size -- not the same bb"
    FAILED=$((FAILED + 1))
  fi
done <<< "$CIRCUIT_LIST"

echo "[*] proved and verified: $PASSED, failed: $FAILED, no Prover.toml: $NO_INPUTS"
[ "$FAILED" -eq 0 ] && [ "$PASSED" -gt 0 ]
