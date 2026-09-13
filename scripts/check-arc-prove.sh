#!/usr/bin/env bash
# Ask for an arc_eligibility proof through MCP, and say how far it got.
#
# Every stage before `bb prove` is checkable on any machine: the wallet signs
# the EIP-712 action, the inputs are built, the service answers 402, the payment
# is signed and settled, and the circuit is executed -- which is where a wrong
# public key or a mismatched action hash is caught. `bb prove` itself needs an
# x86 host; on an Apple Silicon Mac it aborts before it starts. See the local
# proving section of .claude/agents/ai-dev.md.
#
# Written 2026-09-12 after this sequence was typed by hand and the knowledge
# would otherwise have died with the session. What it caught on the first run:
# the action hashes were being attached AFTER the inputs were built, so the
# public key was recovered from `signal_hash` and the circuit refused the proof
# with "User pubkey does not match address".
#
#   PROOFPORT_URL=http://localhost:4002 ./scripts/check-arc-prove.sh
#   PROOFPORT_URL=http://localhost:4002 ./scripts/check-arc-prove.sh --pay-on arc-testnet

set -uo pipefail

REPO=$(git rev-parse --show-superproject-working-tree)
REPO=${REPO:-$(git rev-parse --show-toplevel)}
AI="$REPO/proofport-ai"

if [ -z "${PROOFPORT_URL:-}" ]; then
  echo "[ERROR] PROOFPORT_URL is required. There is no default here on purpose:"
  echo "        the client's own default is https://ai.zkproofport.app, so an"
  echo "        unset or misspelled variable quietly measures production."
  echo "        Local: PROOFPORT_URL=http://localhost:4002"
  exit 1
fi

if [ -z "${ATTESTATION_KEY:-}" ]; then
  if [ -f "$AI/.env.test" ]; then
    set -a; . "$AI/.env.test"; set +a
    echo "[*] ATTESTATION_KEY read from .env.test"
  else
    echo "[ERROR] ATTESTATION_KEY is required: the wallet that holds the Coinbase"
    echo "        KYC attestation signs the action."
    exit 1
  fi
fi

PROVE="$AI/packages/mcp/dist/prove.js"
if [ ! -f "$PROVE" ]; then
  echo "[*] Building the MCP package..."
  (cd "$AI/packages/sdk" && npm run build) || exit 1
  (cd "$AI/packages/mcp" && npm run build) || exit 1
fi

echo "[*] Server: $PROOFPORT_URL"
MODE=$(curl -sf -m 10 "$PROOFPORT_URL/health" | python3 -c 'import sys,json; print(json.load(sys.stdin)["tee"]["mode"])' 2>/dev/null)
if [ -z "$MODE" ]; then
  echo "[ERROR] $PROOFPORT_URL/health did not answer. Start it with scripts/ai-dev.sh."
  exit 1
fi
echo "[*] TEE mode: $MODE"
if [ "$MODE" = "disabled" ]; then
  echo "[ERROR] TEE_MODE=disabled refuses every proof request. Set TEE_MODE=local"
  echo "        in .env.development and restart."
  exit 1
fi

LOG=$(mktemp)
node "$PROVE" arc_eligibility \
  --action "$AI/scripts/arc-action.sample.json" \
  --scope "arc-check-$(date +%s)" "$@" 2>&1 | tee "$LOG"
echo ""

# The exit code is the LAST command's -- `tee` -- so the verdict is read from
# what the run printed, not from `$?`.
if grep -q '"proof"' "$LOG"; then
  echo "[OK] A proof came back. Every stage passed."
  rm -f "$LOG"; exit 0
fi
if grep -q 'multiplicative_constant' "$LOG"; then
  echo "[..] Everything up to bb passed: the action was signed, the inputs were"
  echo "     built, payment settled, and the circuit executed."
  echo "[!]  bb prove cannot run on this host (x86 binary, arm64 machine)."
  echo "     Run it on x86 -- CI or the AWS instance -- to check the proof itself."
  rm -f "$LOG"; exit 0
fi
if grep -q 'PAYMENT_SETTLER_PRIVATE_KEY' "$LOG"; then
  echo "[!] Paying on Arc needs PAYMENT_SETTLER_PRIVATE_KEY: no public facilitator"
  echo "    settles Arc, so the service submits the authorization itself and needs"
  echo "    a wallet holding USDC on Arc Testnet (which is also its gas asset)."
  rm -f "$LOG"; exit 1
fi
if grep -q 'User pubkey does not match address' "$LOG"; then
  echo "[!] The circuit refused the recovered public key. The message is wrong, not"
  echo "    the address: arc_eligibility signs an EIP-712 digest, and recovering"
  echo "    against signal_hash yields a key belonging to nobody."
  rm -f "$LOG"; exit 1
fi
echo "[!] Stopped for a reason this script does not recognise -- read the output above."
rm -f "$LOG"; exit 1
