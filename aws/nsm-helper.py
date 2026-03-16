#!/usr/bin/env python3
"""
Minimal NSM (Nitro Security Module) driver for /dev/nsm ioctl.

This is the ONLY remaining Python in the enclave — it exists because
Node.js cannot perform the /dev/nsm ioctl natively (requires ctypes + fcntl).

Usage:
  python3 nsm-helper.py --user-data <hex> [--public-key <hex>]

Output:
  Base64-encoded COSE_Sign1 attestation document on stdout.
  Exit code 0 on success, 1 on failure.
"""

import argparse
import base64
import os
import struct
import sys

NSM_DEVICE = "/dev/nsm"
NSM_IOCTL_CMD = 0xC0200A00  # _IOWR(0x0A, 0, 32)
NSM_RESPONSE_BUF_SIZE = 16384

def get_attestation(user_data: bytes, public_key: bytes | None) -> bytes:
    import cbor2
    import ctypes
    import fcntl

    request_payload = {
        "Attestation": {
            "user_data": user_data if user_data else None,
            "nonce": None,
            "public_key": public_key,
        }
    }
    cbor_request = cbor2.dumps(request_payload)

    req_buf = ctypes.create_string_buffer(cbor_request, len(cbor_request))
    resp_buf = ctypes.create_string_buffer(NSM_RESPONSE_BUF_SIZE)

    msg = bytearray(struct.pack(
        "QIIQII",
        ctypes.addressof(req_buf), len(cbor_request), 0,
        ctypes.addressof(resp_buf), NSM_RESPONSE_BUF_SIZE, 0,
    ))

    fd = os.open(NSM_DEVICE, os.O_RDWR)
    try:
        fcntl.ioctl(fd, NSM_IOCTL_CMD, msg)
    finally:
        os.close(fd)

    actual_len = struct.unpack_from("I", msg, 24)[0]
    if actual_len == 0:
        raise RuntimeError("NSM ioctl returned 0-length response")

    response = cbor2.loads(resp_buf.raw[:actual_len])

    if "Attestation" in response and "document" in response["Attestation"]:
        return response["Attestation"]["document"]

    if "Error" in response:
        raise RuntimeError(f"NSM error: {response['Error']}")

    raise RuntimeError(f"Unexpected NSM response keys: {list(response.keys())}")

def main() -> None:
    parser = argparse.ArgumentParser(description="NSM attestation helper")
    parser.add_argument("--user-data", required=True, help="Hex-encoded user data")
    parser.add_argument("--public-key", default="", help="Hex-encoded public key (optional)")
    args = parser.parse_args()

    user_data = bytes.fromhex(args.user_data) if args.user_data else b""
    public_key = bytes.fromhex(args.public_key) if args.public_key else None

    doc = get_attestation(user_data, public_key)
    sys.stdout.write(base64.b64encode(doc).decode("ascii"))

if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)
