#!/usr/bin/env python3
"""Vsock-to-TCP bridge inside Nitro Enclave.

Listens on AF_VSOCK port 5000 (CID_ANY) and forwards each connection
to the Node.js enclave server on TCP localhost:15000.

This bridge is needed because Node.js net module does not support
AF_VSOCK natively. The Node.js server listens on TCP:15000, and this
Python bridge accepts vsock connections from the host-side bridge.

Flow: Host TCP:15000 → Host vsock-bridge → vsock CID:16:5000
      → [this bridge] → TCP localhost:15000 (Node.js)

IMPORTANT: Data is read from vsock FIRST, then forwarded to TCP.
This avoids race conditions where the vsock FIN arrives before
the bridge can read the data.
"""
import socket
import threading
import sys

AF_VSOCK = 40
VMADDR_CID_ANY = 0xFFFFFFFF
VSOCK_PORT = 5000
NODE_TCP_PORT = 15000


def bridge(vsock_conn):
    """Bridge a single vsock connection to the Node.js TCP server."""
    tcp = None
    try:
        # Step 1: Read ALL data from vsock FIRST (before connecting to TCP).
        # The host-side bridge sends data then shutdown(SHUT_WR), so we
        # must read everything before the FIN closes the read side.
        data = b''
        vsock_conn.settimeout(10)
        while True:
            try:
                chunk = vsock_conn.recv(65536)
                if not chunk:
                    break
                data += chunk
            except socket.timeout:
                break

        if not data:
            print('Enclave bridge: empty request from vsock (0 bytes)', file=sys.stderr, flush=True)
            return

        print(f'Enclave bridge: received {len(data)} bytes from vsock', file=sys.stderr, flush=True)

        # Step 2: Connect to Node.js and forward the request
        tcp = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        tcp.settimeout(120)
        tcp.connect(('127.0.0.1', NODE_TCP_PORT))
        tcp.sendall(data)
        tcp.shutdown(socket.SHUT_WR)

        # Step 3: Read response from Node.js
        resp = b''
        while True:
            try:
                chunk = tcp.recv(65536)
                if not chunk:
                    break
                resp += chunk
            except socket.timeout:
                break

        print(f'Enclave bridge: sending {len(resp)} bytes back to vsock', file=sys.stderr, flush=True)

        # Step 4: Send response back to vsock
        if resp:
            vsock_conn.sendall(resp)
    except Exception as e:
        print(f'Enclave bridge error: {e}', file=sys.stderr, flush=True)
    finally:
        if tcp:
            try:
                tcp.close()
            except Exception:
                pass
        try:
            vsock_conn.close()
        except Exception:
            pass


def main():
    server = socket.socket(AF_VSOCK, socket.SOCK_STREAM)
    server.bind((VMADDR_CID_ANY, VSOCK_PORT))
    server.listen(10)
    print(
        f'enclave-vsock-bridge: vsock:{VSOCK_PORT} -> TCP localhost:{NODE_TCP_PORT}',
        file=sys.stderr,
        flush=True,
    )
    while True:
        conn, _ = server.accept()
        threading.Thread(target=bridge, args=(conn,), daemon=True).start()


if __name__ == '__main__':
    main()
