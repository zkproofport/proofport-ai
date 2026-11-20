#!/bin/bash
# Copy the circuit artifacts this server proves with from a circuits checkout
# into proofport-ai/circuits/, the directory the Dockerfile bakes, and write
# the two files the server checks at boot:
#   circuits/artifacts-meta.json    sha256 of every compiled JSON and vk
#   circuits/circuits-source.json   which circuits commit, and its toolchain
#
#   scripts/bake-circuits.sh <circuits checkout> pinned   # deploys (AWS workflow)
#   scripts/bake-circuits.sh <circuits checkout> local    # scripts/ai-dev.sh
#
# `pinned` refuses a checkout that is not exactly the pinned commit
# (src/config/circuitsPin.ts). `local` stamps a working tree as such; the
# server accepts that stamp only off mainnet. The GCP deploys do the same
# through scripts/prepare-build-context.mjs and the monorepo's
# scripts/deploy-ai-recording-gcp.mjs, which call the same
# scripts/circuits-source.ts.
#
# The circuit list comes from src/config/circuitIds.ts (print-circuit-dirs.ts),
# never a list written here: a hardcoded list made the local container
# crash-loop on 2026-09-09 when a circuit was added everywhere but here.
#
# Prerequisites: node with this repository's dependencies installed (tsx), jq,
# shasum.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AI_DIR="$(dirname "$SCRIPT_DIR")"
CHECKOUT="${1:-}"
MODE="${2:-}"
[ -n "$CHECKOUT" ] && [ -d "$CHECKOUT" ] || { echo "[ERROR] Usage: $(basename "$0") <circuits checkout> pinned|local" >&2; exit 1; }
case "$MODE" in
  pinned|local) ;;
  *) echo "[ERROR] Mode '$MODE'. Known: pinned, local" >&2; exit 1 ;;
esac
CHECKOUT="$(cd "$CHECKOUT" && pwd)"
DEST="$AI_DIR/circuits"

# Check the checkout before copying anything, so a refused checkout leaves the
# previous bake intact.
STAMP="$(cd "$AI_DIR" && npx tsx scripts/circuits-source.ts --checkout "$CHECKOUT" --mode "$MODE")"

CIRCUIT_LIST="$(cd "$AI_DIR" && npx tsx scripts/print-circuit-dirs.ts)"
[ -n "$CIRCUIT_LIST" ] || { echo "[ERROR] Could not read the circuit list from src/config/circuitIds.ts" >&2; exit 1; }

META="$DEST/artifacts-meta.json"
echo '{}' > "$META.tmp"
while read -r circuit package circuit_id; do
  [ -z "$circuit" ] && continue
  src="$CHECKOUT/$circuit/target"
  mkdir -p "$DEST/$circuit/target/vk"
  cp "$src/$package.json" "$DEST/$circuit/target/$package.json"
  cp "$src/vk/vk" "$DEST/$circuit/target/vk/vk"
  json_hash="$(shasum -a 256 "$DEST/$circuit/target/$package.json" | cut -d' ' -f1)"
  vk_hash="$(shasum -a 256 "$DEST/$circuit/target/vk/vk" | cut -d' ' -f1)"
  jq --arg id "$circuit_id" --arg j "$json_hash" --arg v "$vk_hash" \
    '.[$id] = {jsonHash: $j, vkHash: $v}' "$META.tmp" > "$META.tmp2" && mv "$META.tmp2" "$META.tmp"
  echo "  [OK] $circuit: $package.json, vk"
done <<< "$CIRCUIT_LIST"
mv "$META.tmp" "$META"
printf '%s\n' "$STAMP" > "$DEST/circuits-source.json"
echo "  [OK] baked $(jq 'length' "$META") circuits from circuits $(jq -r .commit "$DEST/circuits-source.json")$( [ "$(jq -r .worktree "$DEST/circuits-source.json")" = true ] && echo ' (working tree, local runs only)'), nargo $(jq -r .nargoVersion "$DEST/circuits-source.json") / bb $(jq -r .bbVersion "$DEST/circuits-source.json")"
