#!/usr/bin/env bash
# verify-ec2-autostart.sh — Verify all proofport-ai services are properly
# configured for automatic startup on EC2 reboot.
#
# Usage: ssh ec2-user@<ip> 'bash -s' < aws/verify-ec2-autostart.sh
#   or:  scp to server and run locally
#
# This script is READ-ONLY — it checks state but does not modify anything.

set +e  # Don't exit on errors — we check exit codes manually

PASS=0
FAIL=0
WARN=0

pass() { echo "  ✓ $1"; ((PASS++)); }
fail() { echo "  ✗ $1"; ((FAIL++)); }
warn() { echo "  △ $1"; ((WARN++)); }

echo "=== proofport-ai EC2 Autostart Verification ==="
echo ""

# 1. Docker daemon enabled
echo "[1] Docker daemon"
if systemctl is-enabled docker &>/dev/null; then
  pass "docker.service enabled"
else
  fail "docker.service NOT enabled"
fi
if systemctl is-active docker &>/dev/null; then
  pass "docker.service active"
else
  fail "docker.service NOT active"
fi

# 2. Nitro Enclaves allocator
echo "[2] Nitro Enclaves allocator"
if systemctl is-enabled nitro-enclaves-allocator &>/dev/null; then
  pass "nitro-enclaves-allocator.service enabled"
else
  fail "nitro-enclaves-allocator.service NOT enabled"
fi
if systemctl is-active nitro-enclaves-allocator &>/dev/null; then
  pass "nitro-enclaves-allocator.service active"
else
  fail "nitro-enclaves-allocator.service NOT active"
fi

# 3. Caddy reverse proxy
echo "[3] Caddy reverse proxy"
if systemctl is-enabled caddy &>/dev/null; then
  pass "caddy.service enabled"
else
  fail "caddy.service NOT enabled"
fi
if systemctl is-active caddy &>/dev/null; then
  pass "caddy.service active"
else
  fail "caddy.service NOT active"
fi

# 4. App + Enclave + vsock-bridge systemd services
echo "[4] Systemd service chain"
for svc in proofport-ai proofport-ai-enclave vsock-bridge; do
  if systemctl is-enabled "$svc" &>/dev/null; then
    pass "${svc}.service enabled"
  else
    fail "${svc}.service NOT enabled — won't auto-start on reboot"
  fi
done

# 5. Docker containers running
echo "[5] Docker containers"
if docker ps --format '{{.Names}}' 2>/dev/null | grep -q 'proofport-ai-'; then
  CONTAINER=$(docker ps --format '{{.Names}}' | grep 'proofport-ai-' | grep -v redis | head -1)
  pass "App container running: ${CONTAINER}"
else
  fail "No proofport-ai app container running"
fi

if docker ps --format '{{.Names}}' 2>/dev/null | grep -q 'proofport-redis'; then
  pass "Redis container running"
else
  fail "Redis container NOT running"
fi

# Check restart policies
for c in $(docker ps -a --format '{{.Names}}' 2>/dev/null | grep -E 'proofport-ai-|proofport-redis'); do
  POLICY=$(docker inspect --format '{{.HostConfig.RestartPolicy.Name}}' "$c" 2>/dev/null)
  if [[ "$POLICY" == "always" || "$POLICY" == "unless-stopped" ]]; then
    pass "Container ${c} restart policy: ${POLICY}"
  else
    fail "Container ${c} restart policy: ${POLICY} (should be always or unless-stopped)"
  fi
done

# 6. Nitro Enclave
echo "[6] Nitro Enclave"
if [ -f /opt/proofport-ai/enclave.eif ]; then
  pass "Enclave image (EIF) exists"
else
  fail "Enclave image (EIF) NOT found at /opt/proofport-ai/enclave.eif"
fi

ENCLAVES=$(nitro-cli describe-enclaves 2>/dev/null || echo "[]")
if echo "$ENCLAVES" | python3 -c "import sys,json; encs=json.load(sys.stdin); sys.exit(0 if len(encs)>0 else 1)" 2>/dev/null; then
  pass "Nitro Enclave running"
  echo "$ENCLAVES" | python3 -c "
import sys, json
encs = json.load(sys.stdin)
for e in encs:
  print(f'    EnclaveID: {e.get(\"EnclaveID\",\"?\")}, State: {e.get(\"State\",\"?\")}, CID: {e.get(\"EnclaveCID\",\"?\")}')
"
else
  fail "Nitro Enclave NOT running"
fi

# 7. vsock-bridge
echo "[7] vsock-bridge"
if pgrep -f vsock-bridge.py &>/dev/null; then
  pass "vsock-bridge process running"
else
  fail "vsock-bridge process NOT running"
fi

# 8. Health check
echo "[8] Health check"
HEALTH=$(curl -s --max-time 5 http://localhost:4002/health 2>/dev/null || echo "FAILED")
if echo "$HEALTH" | python3 -c "import sys,json; d=json.load(sys.stdin); sys.exit(0 if d.get('status')=='healthy' else 1)" 2>/dev/null; then
  pass "Health endpoint: healthy"
  TEE_MODE=$(echo "$HEALTH" | python3 -c "import sys,json; print(json.load(sys.stdin).get('tee',{}).get('mode','?'))" 2>/dev/null)
  echo "    TEE mode: ${TEE_MODE}"
else
  fail "Health endpoint: unhealthy or unreachable"
fi

# 9. External endpoint
echo "[9] External endpoint"
DOMAIN=$(grep CADDY_DOMAIN /etc/systemd/system/caddy.service.d/env.conf 2>/dev/null | cut -d= -f2 | tr -d '"' | tr -d "'" || echo "")
if [ -n "$DOMAIN" ]; then
  EXT_HEALTH=$(curl -s --max-time 10 "https://${DOMAIN}/health" 2>/dev/null || echo "FAILED")
  if echo "$EXT_HEALTH" | grep -q '"healthy"' 2>/dev/null; then
    pass "External endpoint (${DOMAIN}): healthy"
  else
    warn "External endpoint (${DOMAIN}): unreachable (may need DNS/Cloudflare)"
  fi
else
  warn "CADDY_DOMAIN not found — skipping external check"
fi

# 10. Active slot state file
echo "[10] State files"
if [ -f /opt/proofport-ai/active-slot ]; then
  SLOT=$(cat /opt/proofport-ai/active-slot)
  pass "active-slot: ${SLOT}"
else
  fail "active-slot file missing"
fi

if [ -f /opt/proofport-ai/.env ]; then
  pass ".env file exists"
  # Check for placeholder values
  if grep -q 'REPLACE_ME' /opt/proofport-ai/.env; then
    fail ".env contains REPLACE_ME placeholders"
  else
    pass ".env has no REPLACE_ME placeholders"
  fi
else
  fail ".env file missing"
fi

# Summary
echo ""
echo "=== Summary ==="
echo "  Passed: ${PASS}"
echo "  Failed: ${FAIL}"
echo "  Warnings: ${WARN}"
echo ""

if [ $FAIL -eq 0 ]; then
  echo "  ✓ All checks passed. System is ready for reboot."
else
  echo "  ✗ ${FAIL} check(s) failed. Fix before relying on auto-restart."
fi

exit $FAIL
