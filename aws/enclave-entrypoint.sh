#!/bin/bash
# Enclave entrypoint: starts Node.js server + vsock-to-TCP bridge
#
# 1. Node.js enclave server listens on TCP localhost:15000
# 2. Python vsock bridge listens on AF_VSOCK port 5000, forwards to TCP:15000
#
# Both must run concurrently. If either exits, the enclave should stop.

set -e

# Nitro Enclaves don't auto-configure the loopback interface.
# Without this, 127.0.0.1 is unreachable → "Network is unreachable" errors.
echo "[entrypoint] Bringing up loopback interface..." >&2
ip addr add 127.0.0.1/8 dev lo 2>/dev/null || true
ip link set lo up 2>/dev/null || true

echo "[entrypoint] Starting Node.js enclave server on TCP:15000..." >&2
node /app/enclave-server.bundle.js &
NODE_PID=$!

# Wait for Node.js server to be ready
for i in $(seq 1 30); do
    if python3 -c "
import socket, sys
s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
s.settimeout(1)
try:
    s.connect(('127.0.0.1', 15000))
    s.close()
    sys.exit(0)
except Exception:
    sys.exit(1)
" 2>/dev/null; then
        echo "[entrypoint] Node.js server ready on TCP:15000" >&2
        break
    fi
    sleep 0.5
done

echo "[entrypoint] Starting vsock-to-TCP bridge (vsock:5000 -> TCP:15000)..." >&2
python3 /app/aws/enclave-vsock-bridge.py &
BRIDGE_PID=$!

echo "[entrypoint] Enclave ready. Node PID=$NODE_PID, Bridge PID=$BRIDGE_PID" >&2

# Wait for either process to exit
wait -n $NODE_PID $BRIDGE_PID
EXIT_CODE=$?
echo "[entrypoint] Process exited with code $EXIT_CODE. Shutting down." >&2
kill $NODE_PID $BRIDGE_PID 2>/dev/null || true
exit $EXIT_CODE
