//! Vsock transport module for AWS Nitro Enclave communication.
//!
//! This module implements a synchronous vsock listener that receives JSON requests
//! from the Node.js parent application via AF_VSOCK, runs nargo/bb CLI to generate
//! proofs, and returns JSON responses.
//!
//! Each vsock connection handles exactly ONE request-response pair, then closes.
//! The protocol matches the Node.js `enclaveClient.ts` VsockRequest/VsockResponse types.

use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use vsock::{VsockListener, VMADDR_CID_ANY};

// ─────────────────────────────────────────────
// Protocol types (match Node.js tee/types.ts)
// ─────────────────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VsockRequest {
    #[serde(rename = "type")]
    request_type: String,
    circuit_id: Option<String>,
    prover_toml: Option<String>,
    request_id: String,
    proof_hash: Option<String>,
    #[allow(dead_code)] // Part of the vsock protocol, reserved for future use
    metadata: Option<serde_json::Value>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct VsockResponse {
    #[serde(rename = "type")]
    response_type: String,
    request_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    proof: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    public_inputs: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    attestation_document: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

// ─────────────────────────────────────────────
// Configuration from environment
// ─────────────────────────────────────────────

struct VsockConfig {
    port: u32,
    circuits_dir: PathBuf,
    nargo_path: String,
    bb_path: String,
}

impl VsockConfig {
    fn from_env() -> Self {
        let port: u32 = std::env::var("VSOCK_PORT")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(5000);

        let circuits_dir = PathBuf::from(
            std::env::var("CIRCUITS_DIR").unwrap_or_else(|_| "/app/circuits".to_string()),
        );

        let nargo_path = std::env::var("NARGO_PATH").unwrap_or_else(|_| "nargo".to_string());
        let bb_path = std::env::var("BB_PATH").unwrap_or_else(|_| "bb".to_string());

        Self {
            port,
            circuits_dir,
            nargo_path,
            bb_path,
        }
    }
}

// ─────────────────────────────────────────────
// Response constructors
// ─────────────────────────────────────────────

fn error_response(request_id: &str, error: String) -> VsockResponse {
    VsockResponse {
        response_type: "error".to_string(),
        request_id: request_id.to_string(),
        proof: None,
        public_inputs: None,
        attestation_document: None,
        error: Some(error),
    }
}

fn health_response(request_id: &str) -> VsockResponse {
    VsockResponse {
        response_type: "health".to_string(),
        request_id: request_id.to_string(),
        proof: None,
        public_inputs: None,
        attestation_document: None,
        error: None,
    }
}

fn proof_response(
    request_id: &str,
    proof: String,
    public_inputs: Vec<String>,
    attestation_document: Option<String>,
) -> VsockResponse {
    VsockResponse {
        response_type: "proof".to_string(),
        request_id: request_id.to_string(),
        proof: Some(proof),
        public_inputs: Some(public_inputs),
        attestation_document,
        error: None,
    }
}

// ─────────────────────────────────────────────
// Prove handler (bb CLI approach)
// ─────────────────────────────────────────────

fn handle_prove(
    request: &VsockRequest,
    config: &VsockConfig,
) -> VsockResponse {
    let circuit_id = match &request.circuit_id {
        Some(id) if !id.is_empty() => id,
        _ => return error_response(&request.request_id, "circuitId is required".to_string()),
    };

    let prover_toml = match &request.prover_toml {
        Some(toml) if !toml.is_empty() => toml,
        _ => return error_response(&request.request_id, "proverToml is required".to_string()),
    };

    // Locate circuit artifacts directory
    let circuit_dir = config.circuits_dir.join(circuit_id);
    if !circuit_dir.exists() {
        return error_response(
            &request.request_id,
            format!("Circuit directory not found: {}", circuit_dir.display()),
        );
    }

    // Verify required artifacts exist
    let bytecode_path = circuit_dir
        .join("target")
        .join(format!("{}.json", circuit_id));
    let vk_path = circuit_dir.join("target").join("vk").join("vk");
    let nargo_toml_path = circuit_dir.join("Nargo.toml");

    if !bytecode_path.exists() {
        return error_response(
            &request.request_id,
            format!("Circuit bytecode not found: {}", bytecode_path.display()),
        );
    }
    if !vk_path.exists() {
        return error_response(
            &request.request_id,
            format!("Verification key not found: {}", vk_path.display()),
        );
    }
    if !nargo_toml_path.exists() {
        return error_response(
            &request.request_id,
            format!("Nargo.toml not found: {}", nargo_toml_path.display()),
        );
    }

    // Create temp work directory (copy circuit dir so concurrent requests don't interfere)
    let work_dir = match create_work_dir(&circuit_dir, circuit_id) {
        Ok(dir) => dir,
        Err(e) => return error_response(&request.request_id, format!("Failed to create work dir: {}", e)),
    };

    tracing::info!(
        "Prove request: circuit={} requestId={} workDir={}",
        circuit_id,
        request.request_id,
        work_dir.display()
    );

    // Write Prover.toml
    let prover_toml_path = work_dir.join("Prover.toml");
    if let Err(e) = fs::write(&prover_toml_path, prover_toml) {
        cleanup_work_dir(&work_dir);
        return error_response(
            &request.request_id,
            format!("Failed to write Prover.toml: {}", e),
        );
    }

    // Step 1: nargo execute witness
    tracing::info!("Running nargo execute for circuit={}", circuit_id);
    let nargo_result = run_command_with_timeout(
        &config.nargo_path,
        &["execute", "witness"],
        &work_dir,
        Duration::from_secs(120),
    );

    if let Err(e) = nargo_result {
        tracing::error!("nargo execute failed: {}", e);
        cleanup_work_dir(&work_dir);
        return error_response(
            &request.request_id,
            format!("nargo execute failed: {}", e),
        );
    }

    // Move witness to proof directory
    let witness_src = work_dir.join("target").join("witness.gz");
    let proof_dir = work_dir.join("target").join("proof");
    if let Err(e) = fs::create_dir_all(&proof_dir) {
        cleanup_work_dir(&work_dir);
        return error_response(
            &request.request_id,
            format!("Failed to create proof dir: {}", e),
        );
    }
    let witness_dst = proof_dir.join("witness.gz");
    if let Err(e) = fs::rename(&witness_src, &witness_dst) {
        cleanup_work_dir(&work_dir);
        return error_response(
            &request.request_id,
            format!("Failed to move witness: {}", e),
        );
    }

    // Step 2: bb prove
    let bytecode_rel = format!("target/{}.json", circuit_id);
    let vk_rel = "target/vk/vk";
    let witness_rel = "target/proof/witness.gz";
    let output_rel = "target/proof";

    tracing::info!("Running bb prove for circuit={}", circuit_id);
    let bb_prove_result = run_command_with_timeout(
        &config.bb_path,
        &[
            "prove",
            "-b", &bytecode_rel,
            "-w", witness_rel,
            "-k", vk_rel,
            "-o", output_rel,
            "--oracle_hash", "keccak",
        ],
        &work_dir,
        Duration::from_secs(120),
    );

    if let Err(e) = bb_prove_result {
        tracing::error!("bb prove failed: {}", e);
        cleanup_work_dir(&work_dir);
        return error_response(
            &request.request_id,
            format!("bb prove failed: {}", e),
        );
    }

    // Step 3: bb verify (verify before returning)
    let proof_file = proof_dir.join("proof");
    let public_inputs_file = proof_dir.join("public_inputs");

    tracing::info!("Running bb verify for circuit={}", circuit_id);
    let bb_verify_result = run_command_with_timeout(
        &config.bb_path,
        &[
            "verify",
            "-p", "target/proof/proof",
            "-i", "target/proof/public_inputs",
            "-k", vk_rel,
            "--oracle_hash", "keccak",
        ],
        &work_dir,
        Duration::from_secs(120),
    );

    if let Err(e) = bb_verify_result {
        tracing::error!("bb verify failed: {}", e);
        cleanup_work_dir(&work_dir);
        return error_response(
            &request.request_id,
            format!("bb verify failed (proof invalid): {}", e),
        );
    }

    // Step 4: Read proof and public inputs, hex-encode
    let proof_bytes = match fs::read(&proof_file) {
        Ok(bytes) => bytes,
        Err(e) => {
            cleanup_work_dir(&work_dir);
            return error_response(
                &request.request_id,
                format!("Failed to read proof file: {}", e),
            );
        }
    };

    let public_inputs_bytes = match fs::read(&public_inputs_file) {
        Ok(bytes) => bytes,
        Err(e) => {
            cleanup_work_dir(&work_dir);
            return error_response(
                &request.request_id,
                format!("Failed to read public_inputs file: {}", e),
            );
        }
    };

    let proof_hex = format!("0x{}", hex::encode(&proof_bytes));
    let public_inputs_hex = format!("0x{}", hex::encode(&public_inputs_bytes));

    tracing::info!(
        "Proof generated: circuit={} proof_bytes={} public_inputs_bytes={}",
        circuit_id,
        proof_bytes.len(),
        public_inputs_bytes.len()
    );

    // Generate attestation if on Nitro hardware
    let attestation_doc = generate_attestation_if_available(&proof_bytes);

    // Cleanup
    cleanup_work_dir(&work_dir);

    proof_response(
        &request.request_id,
        proof_hex,
        vec![public_inputs_hex],
        attestation_doc,
    )
}

// ─────────────────────────────────────────────
// Attestation handler
// ─────────────────────────────────────────────

fn handle_attestation(request: &VsockRequest) -> VsockResponse {
    let proof_hash = match &request.proof_hash {
        Some(hash) if !hash.is_empty() => hash.clone(),
        _ => return error_response(&request.request_id, "proofHash is required for attestation".to_string()),
    };

    match generate_attestation_with_user_data(proof_hash.as_bytes()) {
        Some(doc) => VsockResponse {
            response_type: "proof".to_string(),
            request_id: request.request_id.clone(),
            proof: None,
            public_inputs: None,
            attestation_document: Some(doc),
            error: None,
        },
        None => error_response(
            &request.request_id,
            "Attestation not available (NSM device not found)".to_string(),
        ),
    }
}

// ─────────────────────────────────────────────
// NSM attestation helpers
// ─────────────────────────────────────────────

/// Generate attestation document using NSM device if available (after proof generation).
fn generate_attestation_if_available(proof_bytes: &[u8]) -> Option<String> {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};

    // Create a hash of the proof as user_data
    let mut hasher = DefaultHasher::new();
    proof_bytes.hash(&mut hasher);
    let hash_bytes = hasher.finish().to_be_bytes();

    generate_attestation_with_user_data(&hash_bytes)
}

/// Request attestation document from NSM device with arbitrary user_data.
fn generate_attestation_with_user_data(user_data: &[u8]) -> Option<String> {
    #[cfg(feature = "enclave")]
    {
        use aws_nitro_enclaves_nsm_api::api::{Request, Response};
        use aws_nitro_enclaves_nsm_api::driver;

        match driver::nsm_init() {
            fd if fd >= 0 => {
                let request = Request::Attestation {
                    user_data: Some(user_data.to_vec().into()),
                    nonce: None,
                    public_key: None,
                };

                match driver::nsm_process_request(fd, request) {
                    Response::Attestation { document } => {
                        driver::nsm_exit(fd);
                        use base64::Engine;
                        Some(base64::engine::general_purpose::STANDARD.encode(&document))
                    }
                    other => {
                        tracing::error!("NSM attestation failed: {:?}", other);
                        driver::nsm_exit(fd);
                        None
                    }
                }
            }
            _ => {
                tracing::warn!("NSM device not available (not running in Nitro Enclave)");
                None
            }
        }
    }

    #[cfg(not(feature = "enclave"))]
    {
        let _ = user_data;
        None
    }
}

// ─────────────────────────────────────────────
// Work directory management
// ─────────────────────────────────────────────

fn create_work_dir(circuit_dir: &Path, circuit_id: &str) -> Result<PathBuf, String> {
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();

    let work_dir = std::env::temp_dir().join(format!("proofport-{}_{}", circuit_id, timestamp));

    // Copy the entire circuit directory to the work dir
    copy_dir_recursive(circuit_dir, &work_dir)
        .map_err(|e| format!("Failed to copy circuit dir: {}", e))?;

    Ok(work_dir)
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let entry_path = entry.path();
        let dest_path = dst.join(entry.file_name());

        if entry_path.is_dir() {
            copy_dir_recursive(&entry_path, &dest_path)?;
        } else {
            fs::copy(&entry_path, &dest_path)?;
        }
    }
    Ok(())
}

fn cleanup_work_dir(work_dir: &Path) {
    if let Err(e) = fs::remove_dir_all(work_dir) {
        tracing::warn!("Failed to clean up work dir {}: {}", work_dir.display(), e);
    }
}

// ─────────────────────────────────────────────
// Command execution with timeout
// ─────────────────────────────────────────────

fn run_command_with_timeout(
    program: &str,
    args: &[&str],
    cwd: &Path,
    timeout: Duration,
) -> Result<String, String> {
    let mut child = Command::new(program)
        .args(args)
        .current_dir(cwd)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to spawn {}: {}", program, e))?;

    // Wait with timeout using a polling approach (std::process doesn't have native timeout)
    let start = std::time::Instant::now();
    let poll_interval = Duration::from_millis(100);

    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let stdout = {
                    let mut buf = String::new();
                    if let Some(mut out) = child.stdout.take() {
                        out.read_to_string(&mut buf).ok();
                    }
                    buf
                };
                let stderr = {
                    let mut buf = String::new();
                    if let Some(mut err) = child.stderr.take() {
                        err.read_to_string(&mut buf).ok();
                    }
                    buf
                };

                if status.success() {
                    if !stdout.is_empty() {
                        tracing::info!("{} stdout: {}", program, stdout);
                    }
                    return Ok(stdout);
                } else {
                    return Err(format!(
                        "{} exited with status {}: {}",
                        program,
                        status,
                        if stderr.is_empty() { &stdout } else { &stderr }
                    ));
                }
            }
            Ok(None) => {
                // Still running
                if start.elapsed() > timeout {
                    child.kill().ok();
                    return Err(format!(
                        "{} timed out after {}s",
                        program,
                        timeout.as_secs()
                    ));
                }
                std::thread::sleep(poll_interval);
            }
            Err(e) => {
                return Err(format!("Failed to wait for {}: {}", program, e));
            }
        }
    }
}

// ─────────────────────────────────────────────
// Main vsock server loop
// ─────────────────────────────────────────────

/// Run the vsock server. This function blocks indefinitely, handling one
/// connection at a time. Each connection processes a single request-response pair.
pub fn run_vsock_server() -> Result<(), String> {
    let config = VsockConfig::from_env();

    tracing::info!(
        "Starting vsock server on port {} (circuits_dir={}, nargo={}, bb={})",
        config.port,
        config.circuits_dir.display(),
        config.nargo_path,
        config.bb_path
    );

    // Validate circuits directory exists
    if !config.circuits_dir.exists() {
        return Err(format!(
            "Circuits directory does not exist: {}",
            config.circuits_dir.display()
        ));
    }

    let listener = VsockListener::bind_with_cid_port(VMADDR_CID_ANY, config.port)
        .map_err(|e| format!("Failed to bind vsock listener on port {}: {}", config.port, e))?;

    tracing::info!("Vsock server listening on port {}", config.port);

    for conn in listener.incoming() {
        match conn {
            Ok(mut stream) => {
                tracing::info!("Accepted vsock connection");

                // Read the entire request (connections are one-shot)
                let mut request_data = Vec::new();
                if let Err(e) = stream.read_to_end(&mut request_data) {
                    tracing::error!("Failed to read from vsock connection: {}", e);
                    continue;
                }

                let request_str = match String::from_utf8(request_data) {
                    Ok(s) => s,
                    Err(e) => {
                        tracing::error!("Invalid UTF-8 in vsock request: {}", e);
                        // Try to send error response
                        let resp = error_response("unknown", "Invalid UTF-8 in request".to_string());
                        let _ = write_response(&mut stream, &resp);
                        continue;
                    }
                };

                tracing::info!("Received vsock request: {} bytes", request_str.len());

                let request: VsockRequest = match serde_json::from_str(&request_str) {
                    Ok(r) => r,
                    Err(e) => {
                        tracing::error!("Failed to parse vsock request: {}", e);
                        let resp = error_response("unknown", format!("Invalid request JSON: {}", e));
                        let _ = write_response(&mut stream, &resp);
                        continue;
                    }
                };

                let response = handle_request(&request, &config);

                if let Err(e) = write_response(&mut stream, &response) {
                    tracing::error!("Failed to write vsock response: {}", e);
                }
            }
            Err(e) => {
                tracing::error!("Failed to accept vsock connection: {}", e);
            }
        }
    }

    Ok(())
}

fn handle_request(request: &VsockRequest, config: &VsockConfig) -> VsockResponse {
    match request.request_type.as_str() {
        "health" => {
            tracing::info!("Health check request: requestId={}", request.request_id);
            health_response(&request.request_id)
        }
        "prove" => handle_prove(request, config),
        "attestation" => handle_attestation(request),
        other => {
            tracing::warn!("Unknown request type: {}", other);
            error_response(
                &request.request_id,
                format!("Unknown request type: {}", other),
            )
        }
    }
}

fn write_response<W: Write>(writer: &mut W, response: &VsockResponse) -> Result<(), String> {
    let json = serde_json::to_vec(response)
        .map_err(|e| format!("Failed to serialize response: {}", e))?;
    writer
        .write_all(&json)
        .map_err(|e| format!("Failed to write response: {}", e))?;
    writer
        .flush()
        .map_err(|e| format!("Failed to flush response: {}", e))?;
    Ok(())
}

// ─────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_vsock_request_deserialize_prove() {
        let json = r#"{
            "type": "prove",
            "circuitId": "coinbase_attestation",
            "proverToml": "signal_hash = [0x01]\n",
            "requestId": "test-123"
        }"#;
        let req: VsockRequest = serde_json::from_str(json).unwrap();
        assert_eq!(req.request_type, "prove");
        assert_eq!(req.circuit_id.as_deref(), Some("coinbase_attestation"));
        assert_eq!(req.prover_toml.as_deref(), Some("signal_hash = [0x01]\n"));
        assert_eq!(req.request_id, "test-123");
        assert!(req.proof_hash.is_none());
        assert!(req.metadata.is_none());
    }

    #[test]
    fn test_vsock_request_deserialize_health() {
        let json = r#"{
            "type": "health",
            "requestId": "health-456"
        }"#;
        let req: VsockRequest = serde_json::from_str(json).unwrap();
        assert_eq!(req.request_type, "health");
        assert_eq!(req.request_id, "health-456");
        assert!(req.circuit_id.is_none());
        assert!(req.prover_toml.is_none());
    }

    #[test]
    fn test_vsock_request_deserialize_attestation() {
        let json = r#"{
            "type": "attestation",
            "requestId": "att-789",
            "proofHash": "0xdeadbeef",
            "metadata": {"key": "value"}
        }"#;
        let req: VsockRequest = serde_json::from_str(json).unwrap();
        assert_eq!(req.request_type, "attestation");
        assert_eq!(req.request_id, "att-789");
        assert_eq!(req.proof_hash.as_deref(), Some("0xdeadbeef"));
        assert!(req.metadata.is_some());
    }

    #[test]
    fn test_vsock_response_serialize_proof() {
        let resp = proof_response(
            "test-123",
            "0xdeadbeef".to_string(),
            vec!["0xcafebabe".to_string()],
            None,
        );
        let json = serde_json::to_value(&resp).unwrap();
        assert_eq!(json["type"], "proof");
        assert_eq!(json["requestId"], "test-123");
        assert_eq!(json["proof"], "0xdeadbeef");
        assert_eq!(json["publicInputs"][0], "0xcafebabe");
        assert!(json.get("attestationDocument").is_none());
        assert!(json.get("error").is_none());
    }

    #[test]
    fn test_vsock_response_serialize_error() {
        let resp = error_response("test-456", "Something went wrong".to_string());
        let json = serde_json::to_value(&resp).unwrap();
        assert_eq!(json["type"], "error");
        assert_eq!(json["requestId"], "test-456");
        assert_eq!(json["error"], "Something went wrong");
        assert!(json.get("proof").is_none());
        assert!(json.get("publicInputs").is_none());
    }

    #[test]
    fn test_vsock_response_serialize_health() {
        let resp = health_response("health-789");
        let json = serde_json::to_value(&resp).unwrap();
        assert_eq!(json["type"], "health");
        assert_eq!(json["requestId"], "health-789");
        assert!(json.get("proof").is_none());
        assert!(json.get("error").is_none());
    }

    #[test]
    fn test_vsock_response_serialize_with_attestation() {
        let resp = proof_response(
            "test-att",
            "0xproof".to_string(),
            vec!["0xinputs".to_string()],
            Some("base64attestation".to_string()),
        );
        let json = serde_json::to_value(&resp).unwrap();
        assert_eq!(json["attestationDocument"], "base64attestation");
    }

    #[test]
    fn test_handle_prove_missing_circuit_id() {
        let config = VsockConfig {
            port: 5000,
            circuits_dir: PathBuf::from("/tmp/nonexistent"),
            nargo_path: "nargo".to_string(),
            bb_path: "bb".to_string(),
        };
        let request = VsockRequest {
            request_type: "prove".to_string(),
            circuit_id: None,
            prover_toml: Some("content".to_string()),
            request_id: "test-1".to_string(),
            proof_hash: None,
            metadata: None,
        };
        let resp = handle_prove(&request, &config);
        assert_eq!(resp.response_type, "error");
        assert!(resp.error.as_ref().unwrap().contains("circuitId"));
    }

    #[test]
    fn test_handle_prove_missing_prover_toml() {
        let config = VsockConfig {
            port: 5000,
            circuits_dir: PathBuf::from("/tmp/nonexistent"),
            nargo_path: "nargo".to_string(),
            bb_path: "bb".to_string(),
        };
        let request = VsockRequest {
            request_type: "prove".to_string(),
            circuit_id: Some("coinbase_attestation".to_string()),
            prover_toml: None,
            request_id: "test-2".to_string(),
            proof_hash: None,
            metadata: None,
        };
        let resp = handle_prove(&request, &config);
        assert_eq!(resp.response_type, "error");
        assert!(resp.error.as_ref().unwrap().contains("proverToml"));
    }

    #[test]
    fn test_handle_prove_circuit_dir_not_found() {
        let config = VsockConfig {
            port: 5000,
            circuits_dir: PathBuf::from("/tmp/nonexistent_circuits_dir"),
            nargo_path: "nargo".to_string(),
            bb_path: "bb".to_string(),
        };
        let request = VsockRequest {
            request_type: "prove".to_string(),
            circuit_id: Some("coinbase_attestation".to_string()),
            prover_toml: Some("signal_hash = [0x01]".to_string()),
            request_id: "test-3".to_string(),
            proof_hash: None,
            metadata: None,
        };
        let resp = handle_prove(&request, &config);
        assert_eq!(resp.response_type, "error");
        assert!(resp.error.as_ref().unwrap().contains("Circuit directory not found"));
    }

    #[test]
    fn test_handle_request_health() {
        let config = VsockConfig {
            port: 5000,
            circuits_dir: PathBuf::from("/tmp"),
            nargo_path: "nargo".to_string(),
            bb_path: "bb".to_string(),
        };
        let request = VsockRequest {
            request_type: "health".to_string(),
            circuit_id: None,
            prover_toml: None,
            request_id: "health-test".to_string(),
            proof_hash: None,
            metadata: None,
        };
        let resp = handle_request(&request, &config);
        assert_eq!(resp.response_type, "health");
        assert_eq!(resp.request_id, "health-test");
    }

    #[test]
    fn test_handle_request_unknown_type() {
        let config = VsockConfig {
            port: 5000,
            circuits_dir: PathBuf::from("/tmp"),
            nargo_path: "nargo".to_string(),
            bb_path: "bb".to_string(),
        };
        let request = VsockRequest {
            request_type: "unknown".to_string(),
            circuit_id: None,
            prover_toml: None,
            request_id: "unknown-test".to_string(),
            proof_hash: None,
            metadata: None,
        };
        let resp = handle_request(&request, &config);
        assert_eq!(resp.response_type, "error");
        assert!(resp.error.as_ref().unwrap().contains("Unknown request type"));
    }

    #[test]
    fn test_handle_attestation_missing_proof_hash() {
        let request = VsockRequest {
            request_type: "attestation".to_string(),
            circuit_id: None,
            prover_toml: None,
            request_id: "att-test".to_string(),
            proof_hash: None,
            metadata: None,
        };
        let resp = handle_attestation(&request);
        assert_eq!(resp.response_type, "error");
        assert!(resp.error.as_ref().unwrap().contains("proofHash"));
    }

    #[test]
    fn test_write_response_to_vec() {
        let resp = health_response("wr-test");
        let mut buf = Vec::new();
        write_response(&mut buf, &resp).unwrap();
        let parsed: serde_json::Value = serde_json::from_slice(&buf).unwrap();
        assert_eq!(parsed["type"], "health");
        assert_eq!(parsed["requestId"], "wr-test");
    }

    #[test]
    fn test_copy_dir_recursive() {
        let src = std::env::temp_dir().join("proofport_copy_test_src");
        let dst = std::env::temp_dir().join("proofport_copy_test_dst");

        // Cleanup from previous runs
        let _ = fs::remove_dir_all(&src);
        let _ = fs::remove_dir_all(&dst);

        // Create source structure
        fs::create_dir_all(src.join("sub")).unwrap();
        fs::write(src.join("file.txt"), "hello").unwrap();
        fs::write(src.join("sub").join("nested.txt"), "world").unwrap();

        copy_dir_recursive(&src, &dst).unwrap();

        assert!(dst.join("file.txt").exists());
        assert!(dst.join("sub").join("nested.txt").exists());
        assert_eq!(fs::read_to_string(dst.join("file.txt")).unwrap(), "hello");
        assert_eq!(
            fs::read_to_string(dst.join("sub").join("nested.txt")).unwrap(),
            "world"
        );

        // Cleanup
        let _ = fs::remove_dir_all(&src);
        let _ = fs::remove_dir_all(&dst);
    }

    #[test]
    fn test_vsock_config_defaults() {
        // Clear relevant env vars to test defaults
        std::env::remove_var("VSOCK_PORT");
        std::env::remove_var("CIRCUITS_DIR");
        std::env::remove_var("NARGO_PATH");
        std::env::remove_var("BB_PATH");

        let config = VsockConfig::from_env();
        assert_eq!(config.port, 5000);
        assert_eq!(config.circuits_dir, PathBuf::from("/app/circuits"));
        assert_eq!(config.nargo_path, "nargo");
        assert_eq!(config.bb_path, "bb");
    }
}
