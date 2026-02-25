#!/usr/bin/env python3
"""
Vsock server for AWS Nitro Enclave.

Listens on AF_VSOCK port 5000, accepts JSON requests from the parent EC2 instance,
and executes ZK proof operations using bb CLI and nargo.

Request/Response protocol matches EnclaveClient.ts (src/tee/enclaveClient.ts):
  VsockRequest  = { type, circuitId?, inputs?, requestId }
  VsockResponse = { type, requestId, proof?, publicInputs?, attestationDocument?, error? }

Supported request types:
  health      → { type: "health", requestId }
  prove       → { type: "prove", circuitId, inputs, requestId }
  attestation → { type: "attestation", requestId, proofHash?, metadata? }

Circuit layout (baked into image by Dockerfile.enclave):
  /app/circuits/coinbase-attestation/target/coinbase_attestation.json
  /app/circuits/coinbase-attestation/target/vk/vk
  /app/circuits/coinbase-country-attestation/target/coinbase_country_attestation.json
  /app/circuits/coinbase-country-attestation/target/vk/vk

Proof pipeline per request:
  1. Write decimal inputs to Prover.toml in a temp circuit dir
  2. Run `nargo execute` to generate witness (target/<name>.gz)
  3. Run `bb prove -b <bytecode> -w <witness> -o <proof> -k <vk>`
  4. Read proof bytes, hex-encode them
  5. Optionally request NSM attestation with proof hash as user_data
  6. Return JSON response over vsock socket

Logging: stderr only (no file I/O in enclave — no persistent disk).
Timeout: 120 seconds per proof request.
"""

import json
import os
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time
import traceback

# ─────────────────────────────────────────────────────────────
# Constants
# ─────────────────────────────────────────────────────────────

VSOCK_PORT = 5000
VSOCK_CID_ANY = 0xFFFFFFFF  # VMADDR_CID_ANY — accept connections from any CID

CIRCUIT_BASE_DIR = "/app/circuits"

# Canonical circuit ID → directory and artifact filenames
CIRCUITS = {
    "coinbase_attestation": {
        "dir": "coinbase-attestation",
        "bytecode": "coinbase_attestation.json",
        "vk": "vk/vk",
    },
    "coinbase_country_attestation": {
        "dir": "coinbase-country-attestation",
        "bytecode": "coinbase_country_attestation.json",
        "vk": "vk/vk",
    },
}

PROVE_TIMEOUT_SECONDS = 120
HEALTH_RESPONSE = {"type": "health", "status": "ok"}


# ─────────────────────────────────────────────────────────────
# Logging (stderr only — no files in enclave)
# ─────────────────────────────────────────────────────────────

def log(level: str, msg: str, **kwargs) -> None:
    entry = {"time": time.time(), "level": level, "msg": msg}
    entry.update(kwargs)
    print(json.dumps(entry), file=sys.stderr, flush=True)


def log_info(msg: str, **kwargs) -> None:
    log("info", msg, **kwargs)


def log_error(msg: str, **kwargs) -> None:
    log("error", msg, **kwargs)


# ─────────────────────────────────────────────────────────────
# NSM attestation (AWS Nitro Security Module)
# ─────────────────────────────────────────────────────────────

# NSM ioctl constant: _IOWR(0x0A, 0, 32) where 32 = sizeof(nsm_raw)
# = (3 << 30) | (32 << 16) | (0x0A << 8) | 0 = 0xC0200A00
NSM_IOCTL_CMD = 0xC0200A00
NSM_DEVICE = "/dev/nsm"
NSM_RESPONSE_BUF_SIZE = 16384  # 16KB — attestation docs are typically ~3-5KB


def get_nsm_attestation(user_data: bytes = b"", nonce: bytes = b"") -> bytes | None:
    """
    Request attestation document from AWS NSM device (/dev/nsm).

    The NSM device is a miscdevice exposed by the Nitro hypervisor inside enclaves.
    Communication uses ioctl with CBOR-encoded request/response and the nsm_raw struct:

        struct nsm_raw {        // total 32 bytes on x86_64
            __u64 request;      // pointer to CBOR request buffer
            __u32 request_len;
            __u32 _pad0;
            __u64 response;     // pointer to CBOR response buffer
            __u32 response_len; // in: buffer size, out: actual response size
            __u32 _pad1;
        };

    Returns raw COSE_Sign1 attestation document bytes, or None if NSM unavailable.
    """
    if not os.path.exists(NSM_DEVICE):
        log_info("NSM device not available — skipping attestation")
        return None

    try:
        import cbor2
        import ctypes
        import fcntl

        # Build CBOR attestation request
        # NSM expects: {"Attestation": {"user_data": <bstr|null>, "nonce": <bstr|null>, "public_key": null}}
        request_payload = {
            "Attestation": {
                "user_data": user_data if user_data else None,
                "nonce": nonce if nonce else None,
                "public_key": None,
            }
        }
        cbor_request = cbor2.dumps(request_payload)

        # Allocate request and response buffers (must stay alive during ioctl)
        req_buf = ctypes.create_string_buffer(cbor_request, len(cbor_request))
        resp_buf = ctypes.create_string_buffer(NSM_RESPONSE_BUF_SIZE)

        # Pack nsm_raw struct: [u64 req_ptr, u32 req_len, u32 pad, u64 resp_ptr, u32 resp_len, u32 pad]
        msg = bytearray(struct.pack(
            "QIIQII",
            ctypes.addressof(req_buf),
            len(cbor_request),
            0,
            ctypes.addressof(resp_buf),
            NSM_RESPONSE_BUF_SIZE,
            0,
        ))

        fd = os.open(NSM_DEVICE, os.O_RDWR)
        try:
            fcntl.ioctl(fd, NSM_IOCTL_CMD, msg)
        finally:
            os.close(fd)

        # Read actual response length from the updated struct (offset 24 = response_len field)
        actual_len = struct.unpack_from("I", msg, 24)[0]
        if actual_len == 0:
            log_error("NSM ioctl returned 0-length response")
            return None

        response_cbor = resp_buf.raw[:actual_len]
        response = cbor2.loads(response_cbor)

        # Success: {"Attestation": {"document": <bstr>}}
        if "Attestation" in response:
            att = response["Attestation"]
            if "document" in att:
                doc_bytes = att["document"]
                log_info("NSM attestation obtained", doc_bytes=len(doc_bytes))
                return doc_bytes

        # Error: {"Error": {"Type": "..."}}
        if "Error" in response:
            log_error("NSM returned error", error=str(response["Error"]))
            return None

        log_error("Unexpected NSM response", keys=list(response.keys()))
        return None

    except ImportError:
        log_error("cbor2 not installed — cannot request NSM attestation. Install: pip install cbor2")
        return None
    except Exception as e:
        log_error("NSM attestation failed", error=str(e), traceback=traceback.format_exc())
        return None


# ─────────────────────────────────────────────────────────────
# Proof generation
# ─────────────────────────────────────────────────────────────

def get_circuit_paths(circuit_id: str) -> dict:
    """
    Resolve circuit artifact paths from canonical circuit ID.
    Raises ValueError for unknown circuit IDs.
    """
    if circuit_id not in CIRCUITS:
        raise ValueError(
            f"Unknown circuitId '{circuit_id}'. "
            f"Supported: {', '.join(CIRCUITS.keys())}"
        )
    meta = CIRCUITS[circuit_id]
    base = os.path.join(CIRCUIT_BASE_DIR, meta["dir"])
    return {
        "dir": base,
        "bytecode": os.path.join(base, "target", meta["bytecode"]),
        "vk": os.path.join(base, "target", meta["vk"]),
    }


def write_prover_toml(inputs: list, workdir: str) -> str:
    """
    Write Prover.toml with decimal string inputs for nargo execute.
    Each input becomes: input_N = "value"
    Returns path to Prover.toml.
    """
    lines = []
    for i, val in enumerate(inputs):
        lines.append(f'input_{i} = "{val}"')

    toml_path = os.path.join(workdir, "Prover.toml")
    with open(toml_path, "w") as f:
        f.write("\n".join(lines) + "\n")
    return toml_path


def generate_proof(circuit_id: str, inputs: list, request_id: str, prover_toml: str | None = None) -> dict:
    """
    Full proof pipeline:
      1. Resolve circuit artifacts
      2. Write Prover.toml with inputs
      3. Run nargo execute to generate witness
      4. Run bb prove to generate proof
      5. Optionally get NSM attestation
      6. Return proof hex + public inputs

    Returns dict with keys: proof, publicInputs, attestationDocument (optional)
    Raises RuntimeError on any step failure.
    """
    paths = get_circuit_paths(circuit_id)
    bytecode_path = paths["bytecode"]
    vk_path = paths["vk"]
    circuit_dir = paths["dir"]

    # Verify circuit artifacts exist
    for label, path in [("bytecode", bytecode_path), ("vk", vk_path)]:
        if not os.path.exists(path):
            raise RuntimeError(f"Circuit artifact missing: {label} at {path}")

    with tempfile.TemporaryDirectory(prefix=f"proof-{request_id}-", dir=CIRCUIT_BASE_DIR) as workdir:
        log_info("Starting proof generation", request_id=request_id, circuit_id=circuit_id)

        # Step 1: Write Prover.toml
        if prover_toml:
            # Use pre-built Prover.toml content from the caller (proper field names)
            toml_path = os.path.join(workdir, "Prover.toml")
            with open(toml_path, "w") as f:
                f.write(prover_toml)
            log_info("Prover.toml written from proverToml field", bytes=len(prover_toml))
        else:
            # Fallback: generic input_N format
            write_prover_toml(inputs, workdir)
            log_info("Prover.toml written from inputs array", input_count=len(inputs))

        # Step 2: Copy Nargo.toml and src/ so nargo execute works in tmpdir
        # nargo execute requires a complete package — copy from circuit dir
        nargo_toml_src = os.path.join(circuit_dir, "Nargo.toml")
        src_dir_src = os.path.join(circuit_dir, "src")
        target_dir_src = os.path.join(circuit_dir, "target")

        import shutil
        if os.path.exists(nargo_toml_src):
            shutil.copy2(nargo_toml_src, os.path.join(workdir, "Nargo.toml"))
        if os.path.exists(src_dir_src):
            shutil.copytree(src_dir_src, os.path.join(workdir, "src"))
        if os.path.exists(target_dir_src):
            shutil.copytree(target_dir_src, os.path.join(workdir, "target"))

        # Step 3: Run nargo execute to generate witness
        # Output: workdir/target/<circuit_name>.gz (witness file)
        nargo_cmd = [
            "nargo", "execute",
            "--program-dir", workdir,
        ]
        log_info("Running nargo execute", cmd=" ".join(nargo_cmd))
        nargo_result = subprocess.run(
            nargo_cmd,
            capture_output=True,
            text=True,
            timeout=PROVE_TIMEOUT_SECONDS,
            cwd=workdir,
        )
        if nargo_result.returncode != 0:
            log_error(
                "nargo execute failed",
                returncode=nargo_result.returncode,
                stdout=nargo_result.stdout,
                stderr=nargo_result.stderr,
            )
            raise RuntimeError(
                f"nargo execute failed (exit {nargo_result.returncode}): "
                f"{nargo_result.stderr}"
            )
        log_info("nargo execute succeeded", stdout=nargo_result.stdout)

        # Locate witness file (target/<circuit_name>.gz)
        circuit_name = circuit_id  # canonical ID matches Nargo.toml name field
        witness_path = os.path.join(workdir, "target", f"{circuit_name}.gz")
        if not os.path.exists(witness_path):
            # nargo may also output as witness.gz
            alt_witness = os.path.join(workdir, "target", "witness.gz")
            if os.path.exists(alt_witness):
                witness_path = alt_witness
            else:
                raise RuntimeError(
                    f"Witness file not found after nargo execute. "
                    f"Expected: {witness_path}"
                )
        log_info("Witness file located", path=witness_path)

        # Step 4: Run bb prove
        # Flags MUST match bbProver.ts (src/prover/bbProver.ts) — keep in sync!
        # --oracle_hash keccak is required for Solidity verifier compatibility
        proof_output = os.path.join(workdir, "proof")
        bb_cmd = [
            "bb", "prove",
            "-b", bytecode_path,
            "-w", witness_path,
            "-o", proof_output,
            "-k", vk_path,
            "--oracle_hash", "keccak",
        ]
        log_info("Running bb prove", cmd=" ".join(bb_cmd))
        bb_result = subprocess.run(
            bb_cmd,
            capture_output=True,
            text=True,
            timeout=PROVE_TIMEOUT_SECONDS,
            env={**os.environ, "HOME": "/root"},
        )
        if bb_result.returncode != 0:
            log_error(
                "bb prove failed",
                returncode=bb_result.returncode,
                stdout=bb_result.stdout,
                stderr=bb_result.stderr,
            )
            raise RuntimeError(
                f"bb prove failed (exit {bb_result.returncode}): "
                f"{bb_result.stderr}"
            )
        log_info("bb prove succeeded")

        # Step 5: Read proof bytes
        # bb prove outputs to a directory: <proof_output>/proof
        proof_file = proof_output
        if os.path.isdir(proof_output):
            proof_file = os.path.join(proof_output, "proof")
        if not os.path.exists(proof_file):
            raise RuntimeError(f"bb prove did not produce output at {proof_file}")

        with open(proof_file, "rb") as f:
            proof_bytes = f.read()
        proof_hex = "0x" + proof_bytes.hex()
        log_info("Proof read", proof_bytes=len(proof_bytes))

        # Step 6: Extract public inputs from bb output
        # bb prove -o <dir> writes: <dir>/proof and <dir>/public_inputs
        public_inputs = []
        public_inputs_path = os.path.join(proof_output, "public_inputs")
        if os.path.exists(public_inputs_path):
            with open(public_inputs_path, "rb") as f:
                pi_bytes = f.read()
            public_inputs = ["0x" + pi_bytes.hex()]
            log_info("Public inputs read", bytes=len(pi_bytes))
        else:
            log_info("No public_inputs file — returning empty publicInputs array")

        # Step 7: NSM attestation (if available)
        attestation_b64 = None
        try:
            import hashlib
            proof_hash = hashlib.sha256(proof_bytes).digest()
            nsm_doc = get_nsm_attestation(user_data=proof_hash)
            if nsm_doc:
                import base64
                attestation_b64 = base64.b64encode(nsm_doc).decode("ascii")
                log_info("NSM attestation obtained", doc_bytes=len(nsm_doc))
        except Exception as e:
            log_error("NSM attestation failed (non-fatal)", error=str(e))

        result = {
            "proof": proof_hex,
            "publicInputs": public_inputs,
        }
        if attestation_b64:
            result["attestationDocument"] = attestation_b64

        return result


# ─────────────────────────────────────────────────────────────
# Request handling
# ─────────────────────────────────────────────────────────────

def handle_health(request: dict) -> dict:
    return {
        "type": "health",
        "requestId": request.get("requestId", ""),
        "status": "ok",
    }


def handle_prove(request: dict) -> dict:
    circuit_id = request.get("circuitId")
    inputs = request.get("inputs")
    prover_toml = request.get("proverToml")
    request_id = request.get("requestId", "")

    if not circuit_id:
        return {"type": "error", "requestId": request_id, "error": "Missing circuitId"}
    if not prover_toml and (not inputs or not isinstance(inputs, list)):
        return {"type": "error", "requestId": request_id, "error": "Missing proverToml or inputs"}

    try:
        result = generate_proof(circuit_id, inputs or [], request_id, prover_toml=prover_toml)
        response = {
            "type": "proof",
            "requestId": request_id,
            "proof": result["proof"],
            "publicInputs": result["publicInputs"],
        }
        if "attestationDocument" in result:
            response["attestationDocument"] = result["attestationDocument"]
        return response
    except ValueError as e:
        return {"type": "error", "requestId": request_id, "error": str(e)}
    except subprocess.TimeoutExpired:
        return {"type": "error", "requestId": request_id, "error": f"Proof generation timed out after {PROVE_TIMEOUT_SECONDS}s"}
    except RuntimeError as e:
        return {"type": "error", "requestId": request_id, "error": str(e)}
    except Exception as e:
        log_error("Unexpected error in handle_prove", error=str(e), traceback=traceback.format_exc())
        return {"type": "error", "requestId": request_id, "error": f"Internal error: {str(e)}"}


def handle_attestation(request: dict) -> dict:
    """
    Standalone attestation request — returns NSM document without proof generation.
    """
    request_id = request.get("requestId", "")
    proof_hash_hex = request.get("proofHash", "")

    try:
        user_data = bytes.fromhex(proof_hash_hex.lstrip("0x")) if proof_hash_hex else b""
        nsm_doc = get_nsm_attestation(user_data=user_data)
        if nsm_doc:
            import base64
            return {
                "type": "attestation",
                "requestId": request_id,
                "attestationDocument": base64.b64encode(nsm_doc).decode("ascii"),
            }
        else:
            return {
                "type": "error",
                "requestId": request_id,
                "error": "NSM device not available",
            }
    except Exception as e:
        return {"type": "error", "requestId": request_id, "error": str(e)}


def dispatch(request: dict) -> dict:
    req_type = request.get("type")
    if req_type == "health":
        return handle_health(request)
    elif req_type == "prove":
        return handle_prove(request)
    elif req_type == "attestation":
        return handle_attestation(request)
    else:
        return {
            "type": "error",
            "requestId": request.get("requestId", ""),
            "error": f"Unknown request type: '{req_type}'",
        }


# ─────────────────────────────────────────────────────────────
# Vsock server
# ─────────────────────────────────────────────────────────────

def handle_connection(conn: socket.socket, addr) -> None:
    """Handle a single vsock connection synchronously."""
    log_info("Connection accepted", addr=str(addr))
    try:
        # Read all data until EOF
        chunks = []
        conn.settimeout(5.0)
        try:
            while True:
                chunk = conn.recv(65536)
                if not chunk:
                    break
                chunks.append(chunk)
        except socket.timeout:
            pass  # No more data
        except Exception as e:
            log_error("Error reading from socket", error=str(e))

        raw = b"".join(chunks)
        if not raw:
            log_error("Empty request received")
            return

        log_info("Received request", bytes=len(raw))

        try:
            request = json.loads(raw.decode("utf-8"))
        except json.JSONDecodeError as e:
            log_error("Invalid JSON in request", error=str(e))
            error_response = {"type": "error", "requestId": "", "error": f"Invalid JSON: {e}"}
            conn.sendall(json.dumps(error_response).encode("utf-8"))
            return

        log_info("Dispatching request", type=request.get("type"), request_id=request.get("requestId"))
        response = dispatch(request)
        log_info("Sending response", type=response.get("type"), request_id=response.get("requestId"))

        conn.sendall(json.dumps(response).encode("utf-8"))

    except Exception as e:
        log_error("Unhandled error in connection handler", error=str(e), traceback=traceback.format_exc())
        try:
            error_response = {"type": "error", "requestId": "", "error": f"Server error: {str(e)}"}
            conn.sendall(json.dumps(error_response).encode("utf-8"))
        except Exception:
            pass
    finally:
        try:
            conn.close()
        except Exception:
            pass
        log_info("Connection closed")


def run_server() -> None:
    """
    Main vsock server loop.
    Listens on AF_VSOCK port VSOCK_PORT, handles connections in threads.
    """
    # AF_VSOCK = 40 on Linux
    AF_VSOCK = 40
    VMADDR_CID_ANY = 0xFFFFFFFF

    log_info("Starting enclave vsock server", port=VSOCK_PORT)

    try:
        server = socket.socket(AF_VSOCK, socket.SOCK_STREAM)
    except OSError as e:
        log_error(
            "Failed to create vsock socket. "
            "AF_VSOCK may not be supported in this environment.",
            error=str(e),
        )
        # In non-enclave environments (local testing), fall back to TCP
        log_info("Falling back to TCP socket for local testing on port 15000")
        run_tcp_fallback()
        return

    try:
        server.bind((VMADDR_CID_ANY, VSOCK_PORT))
        server.listen(5)
        log_info("Vsock server listening", cid="VMADDR_CID_ANY", port=VSOCK_PORT)

        while True:
            try:
                conn, addr = server.accept()
                t = threading.Thread(
                    target=handle_connection,
                    args=(conn, addr),
                    daemon=True,
                )
                t.start()
            except KeyboardInterrupt:
                log_info("Server interrupted, shutting down")
                break
            except Exception as e:
                log_error("Error accepting connection", error=str(e))

    finally:
        server.close()


def run_tcp_fallback() -> None:
    """
    TCP fallback for local testing (not in enclave).
    Listens on 127.0.0.1:15000 with the same JSON protocol.
    """
    TCP_PORT = 15000
    log_info("TCP fallback server starting", host="127.0.0.1", port=TCP_PORT)

    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind(("127.0.0.1", TCP_PORT))
    server.listen(5)
    log_info("TCP fallback server listening", port=TCP_PORT)

    while True:
        try:
            conn, addr = server.accept()
            t = threading.Thread(
                target=handle_connection,
                args=(conn, addr),
                daemon=True,
            )
            t.start()
        except KeyboardInterrupt:
            log_info("TCP fallback server shutting down")
            break
        except Exception as e:
            log_error("TCP accept error", error=str(e))

    server.close()


# ─────────────────────────────────────────────────────────────
# Entry point
# ─────────────────────────────────────────────────────────────

if __name__ == "__main__":
    log_info("Enclave server starting", python_version=sys.version)
    log_info("Circuit base dir", path=CIRCUIT_BASE_DIR)
    log_info("Available circuits", circuits=list(CIRCUITS.keys()))

    # Verify circuit artifacts at startup
    for circuit_id, meta in CIRCUITS.items():
        base = os.path.join(CIRCUIT_BASE_DIR, meta["dir"])
        bytecode = os.path.join(base, "target", meta["bytecode"])
        vk = os.path.join(base, "target", meta["vk"])
        if os.path.exists(bytecode) and os.path.exists(vk):
            log_info("Circuit artifacts OK", circuit_id=circuit_id)
        else:
            log_error(
                "Circuit artifacts MISSING — proof requests for this circuit will fail",
                circuit_id=circuit_id,
                bytecode_exists=os.path.exists(bytecode),
                vk_exists=os.path.exists(vk),
            )

    run_server()
