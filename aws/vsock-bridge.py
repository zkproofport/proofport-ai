#!/usr/bin/env python3
"""TCP-to-vsock bridge for Nitro Enclave.

Listens on TCP localhost:15000 and forwards each connection to the enclave
via AF_VSOCK at CID:PORT. This allows Docker containers (which cannot use
vsock directly) to communicate with the Nitro Enclave prover.

Configuration via environment variables:
  ENCLAVE_CID      — vsock context ID of the running enclave (default: 16)
  ENCLAVE_PORT     — vsock port the enclave listens on (default: 5000)
  BRIDGE_TCP_PORT  — TCP port to listen on (default: 15000)
"""
import socket
import threading
import sys
import os

AF_VSOCK = 40
TCP_PORT = int(os.environ.get('BRIDGE_TCP_PORT', '15000'))
VSOCK_CID = int(os.environ.get('ENCLAVE_CID', '16'))
VSOCK_PORT = int(os.environ.get('ENCLAVE_PORT', '5000'))


def bridge(tcp_conn, addr):
    """Bridge a single TCP connection to a vsock connection."""
    vs = None
    try:
        vs = socket.socket(AF_VSOCK, socket.SOCK_STREAM)
        vs.settimeout(30)
        vs.connect((VSOCK_CID, VSOCK_PORT))

        # Read full request from TCP
        data = b''
        tcp_conn.settimeout(5)
        while True:
            try:
                chunk = tcp_conn.recv(65536)
                if not chunk:
                    break
                data += chunk
            except socket.timeout:
                break

        # Forward to vsock
        vs.sendall(data)
        vs.shutdown(socket.SHUT_WR)

        # Read response from vsock, send back to TCP
        resp = b''
        while True:
            try:
                chunk = vs.recv(65536)
                if not chunk:
                    break
                resp += chunk
            except socket.timeout:
                break

        tcp_conn.sendall(resp)
    except Exception as e:
        print(f'Bridge error: {e}', file=sys.stderr, flush=True)
    finally:
        if vs:
            try:
                vs.close()
            except Exception:
                pass
        try:
            tcp_conn.close()
        except Exception:
            pass


def main():
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind(('127.0.0.1', TCP_PORT))
    server.listen(10)
    print(
        f'vsock-bridge: TCP :{TCP_PORT} -> vsock CID:{VSOCK_CID}:{VSOCK_PORT}',
        flush=True,
    )
    while True:
        conn, addr = server.accept()
        threading.Thread(target=bridge, args=(conn, addr), daemon=True).start()


if __name__ == '__main__':
    main()
