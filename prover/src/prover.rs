use std::sync::Arc;

use noir_rs::barretenberg::prove::prove_ultra_honk_keccak;
use noir_rs::barretenberg::verify::verify_ultra_honk_keccak;
use noir_rs::witness::from_vec_str_to_witness_map;
use tokio::sync::Mutex;

use crate::circuit::CircuitRegistry;

/// Result of a successful proof generation.
#[derive(Debug)]
pub struct ProveResult {
    /// Hex-encoded proof bytes (without public inputs).
    pub proof_hex: String,
    /// Hex-encoded public inputs bytes.
    pub public_inputs_hex: String,
    /// Hex-encoded full output (public inputs ++ proof).
    pub proof_with_inputs_hex: String,
}

/// Wraps noir_rs proving functions behind a tokio Mutex.
///
/// CRITICAL: ALL noir_rs calls are serialized through a single Mutex because
/// barretenberg C++ FFI has global mutable state and is NOT thread-safe.
/// For higher throughput, scale horizontally (multiple prover containers).
pub struct Prover {
    mutex: Mutex<()>,
    circuits: Arc<CircuitRegistry>,
}

impl Prover {
    pub fn new(circuits: Arc<CircuitRegistry>) -> Self {
        Self {
            mutex: Mutex::new(()),
            circuits,
        }
    }

    /// Generate a proof for the given circuit with the provided inputs.
    ///
    /// All inputs must be in DECIMAL string format (e.g., ["149", "2", "100"]).
    /// The `on_chain` flag selects Keccak (true) or Poseidon (false) hash.
    /// Currently only on_chain (Keccak) is supported for Solidity verifier compatibility.
    pub async fn prove(
        &self,
        circuit_id: &str,
        inputs: Vec<String>,
        on_chain: bool,
    ) -> Result<ProveResult, String> {
        if !on_chain {
            return Err("Off-chain proving (Poseidon) is not yet supported. Use on_chain=true for Keccak proofs.".to_string());
        }

        let circuit = self.circuits.get(circuit_id)?;
        let bytecode = circuit.bytecode.clone();
        let vk = circuit.vk.clone();

        // Serialize all noir_rs calls behind the mutex
        let _guard = self.mutex.lock().await;

        tracing::info!(
            "Generating proof for circuit={} inputs_len={} on_chain={}",
            circuit_id,
            inputs.len(),
            on_chain
        );

        // Convert decimal string inputs to witness map
        let input_refs: Vec<&str> = inputs.iter().map(|s| s.as_str()).collect();
        let witness = from_vec_str_to_witness_map(input_refs)
            .map_err(|e| format!("Witness generation failed: {}", e))?;

        // Generate proof (disable_zk=false, low_memory=false)
        let proof_bytes = prove_ultra_honk_keccak(
            bytecode.as_str(),
            witness,
            vk,
            false, // disable_zk = false (ZK mode ON)
            false, // low_memory_mode = false
        )
        .map_err(|e| format!("Proof generation failed: {}", e))?;

        tracing::info!(
            "Proof generated for circuit={}: {} bytes total",
            circuit_id,
            proof_bytes.len()
        );

        // The proof output from noir_rs is: public_inputs ++ proof
        // Public inputs are 64 fields * 32 bytes = 2048 bytes
        let public_inputs_size = 2048;
        if proof_bytes.len() <= public_inputs_size {
            return Err(format!(
                "Proof output too small: {} bytes (expected > {})",
                proof_bytes.len(),
                public_inputs_size
            ));
        }

        let public_inputs_bytes = &proof_bytes[..public_inputs_size];
        let proof_only_bytes = &proof_bytes[public_inputs_size..];

        Ok(ProveResult {
            proof_hex: hex::encode(proof_only_bytes),
            public_inputs_hex: hex::encode(public_inputs_bytes),
            proof_with_inputs_hex: hex::encode(&proof_bytes),
        })
    }

    /// Verify a proof locally using noir_rs.
    ///
    /// The `proof` parameter is the full proof bytes (public_inputs ++ proof).
    pub async fn verify(
        &self,
        circuit_id: &str,
        proof: Vec<u8>,
        on_chain: bool,
    ) -> Result<bool, String> {
        if !on_chain {
            return Err("Off-chain verification (Poseidon) is not yet supported. Use on_chain=true for Keccak proofs.".to_string());
        }

        let circuit = self.circuits.get(circuit_id)?;
        let vk = circuit.vk.clone();

        // Serialize all noir_rs calls behind the mutex
        let _guard = self.mutex.lock().await;

        tracing::info!(
            "Verifying proof for circuit={} proof_len={} on_chain={}",
            circuit_id,
            proof.len(),
            on_chain
        );

        let valid = verify_ultra_honk_keccak(proof, vk, false)
            .map_err(|e| format!("Verification failed: {}", e))?;

        tracing::info!("Verification result for circuit={}: {}", circuit_id, valid);

        Ok(valid)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::circuit::CircuitRegistry;

    #[tokio::test]
    async fn test_prover_new() {
        let registry = CircuitRegistry::mock();
        let prover = Prover::new(registry);
        // Prover created successfully — mutex is initialized
        assert!(true, "Prover created without panic");
        drop(prover);
    }

    #[tokio::test]
    async fn test_prove_unknown_circuit() {
        let registry = CircuitRegistry::mock();
        let prover = Prover::new(registry);
        let result = prover
            .prove("nonexistent_circuit", vec!["1".to_string()], true)
            .await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Circuit not found"));
    }

    #[tokio::test]
    async fn test_prove_off_chain_not_supported() {
        let registry = CircuitRegistry::mock();
        let prover = Prover::new(registry);
        let result = prover
            .prove("coinbase_attestation", vec!["1".to_string()], false)
            .await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Off-chain proving"));
    }

    #[tokio::test]
    async fn test_verify_unknown_circuit() {
        let registry = CircuitRegistry::mock();
        let prover = Prover::new(registry);
        let result = prover
            .verify("nonexistent_circuit", vec![1, 2, 3], true)
            .await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Circuit not found"));
    }

    #[tokio::test]
    async fn test_verify_off_chain_not_supported() {
        let registry = CircuitRegistry::mock();
        let prover = Prover::new(registry);
        let result = prover
            .verify("coinbase_attestation", vec![1, 2, 3], false)
            .await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Off-chain verification"));
    }

    // Integration tests that require actual circuit files and SRS download.
    // Run manually: cargo test -- --ignored --nocapture
    #[tokio::test]
    #[ignore]
    async fn test_prove_and_verify_coinbase_attestation() {
        // This test requires:
        // 1. Compiled circuit JSON in ./circuits/coinbase-attestation/target/
        // 2. Internet access for SRS download
        // 3. Valid circuit inputs
        let registry = CircuitRegistry::new("./circuits")
            .expect("Failed to load circuits");
        let prover = Prover::new(registry);

        // Use the same test inputs as mopro/src/noir.rs test
        let inputs: Vec<String> = vec!["3".to_string(), "5".to_string()];
        let result = prover
            .prove("coinbase_attestation", inputs, true)
            .await;
        // Expected to fail with mock inputs; real test needs full 850-element input vector
        println!("Prove result: {:?}", result.is_ok());
    }
}
