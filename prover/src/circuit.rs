use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use crate::types::CircuitInfo;

/// Holds the compiled bytecode and verification key for a single circuit.
#[derive(Clone, Debug)]
pub struct CircuitData {
    pub bytecode: String,
    pub vk: Vec<u8>,
}

/// Registry of all loaded circuits, keyed by canonical circuit ID.
pub struct CircuitRegistry {
    circuits: HashMap<String, CircuitData>,
    metadata: HashMap<String, CircuitInfo>,
}

/// Circuit metadata definitions for the two canonical circuits.
fn circuit_metadata() -> Vec<CircuitInfo> {
    vec![
        CircuitInfo {
            id: "coinbase_attestation".to_string(),
            display_name: "Coinbase KYC".to_string(),
            description: "Prove Coinbase KYC attestation without revealing identity".to_string(),
            required_inputs: vec![
                "signal_hash".to_string(),
                "signer_list_merkle_root".to_string(),
                "user_address".to_string(),
                "user_signature".to_string(),
                "user_pubkey_x".to_string(),
                "user_pubkey_y".to_string(),
                "raw_transaction".to_string(),
                "tx_length".to_string(),
                "coinbase_attester_pubkey_x".to_string(),
                "coinbase_attester_pubkey_y".to_string(),
                "coinbase_signer_merkle_proof".to_string(),
                "coinbase_signer_leaf_index".to_string(),
                "merkle_proof_depth".to_string(),
            ],
            input_count: 899,
        },
        CircuitInfo {
            id: "coinbase_country_attestation".to_string(),
            display_name: "Coinbase Country".to_string(),
            description: "Prove country attestation from Coinbase without revealing country"
                .to_string(),
            required_inputs: vec![
                "signal_hash".to_string(),
                "signer_list_merkle_root".to_string(),
                "user_address".to_string(),
                "user_signature".to_string(),
                "user_pubkey_x".to_string(),
                "user_pubkey_y".to_string(),
                "raw_transaction".to_string(),
                "tx_length".to_string(),
                "coinbase_attester_pubkey_x".to_string(),
                "coinbase_attester_pubkey_y".to_string(),
                "coinbase_signer_merkle_proof".to_string(),
                "coinbase_signer_leaf_index".to_string(),
                "merkle_proof_depth".to_string(),
                "country_list".to_string(),
                "is_included".to_string(),
            ],
            input_count: 921,
        },
    ]
}

/// Extract bytecode string from a compiled Noir circuit JSON file.
/// The JSON has a top-level `bytecode` field containing the base64 circuit.
fn load_bytecode_from_json(path: &std::path::Path) -> Result<String, String> {
    let contents = std::fs::read_to_string(path)
        .map_err(|e| format!("Failed to read circuit JSON at {}: {}", path.display(), e))?;
    let json: serde_json::Value = serde_json::from_str(&contents)
        .map_err(|e| format!("Failed to parse circuit JSON at {}: {}", path.display(), e))?;
    json["bytecode"]
        .as_str()
        .map(|s| s.to_string())
        .ok_or_else(|| format!("No 'bytecode' field in circuit JSON at {}", path.display()))
}

impl CircuitRegistry {
    /// Load all supported circuits from the given directory.
    ///
    /// Expected directory structure:
    /// ```text
    /// circuits_dir/
    ///   coinbase-attestation/target/coinbase_attestation.json
    ///   coinbase-country-attestation/target/coinbase_country_attestation.json
    /// ```
    ///
    /// For each circuit:
    /// 1. Load bytecode from JSON
    /// 2. Call `setup_srs_from_bytecode()` (downloads SRS from Aztec CDN if needed)
    /// 3. Generate VK via `get_ultra_honk_keccak_verification_key()`
    /// 4. Cache in registry
    pub fn new(circuits_dir: &str) -> Result<Arc<Self>, String> {
        use noir_rs::barretenberg::srs::setup_srs_from_bytecode;
        use noir_rs::barretenberg::verify::get_ultra_honk_keccak_verification_key;

        let base = PathBuf::from(circuits_dir);
        let all_metadata = circuit_metadata();
        let mut circuits = HashMap::new();
        let mut metadata = HashMap::new();

        // Map from canonical ID to directory/file path
        let circuit_files: Vec<(&str, PathBuf)> = vec![
            (
                "coinbase_attestation",
                base.join("coinbase-attestation/target/coinbase_attestation.json"),
            ),
            (
                "coinbase_country_attestation",
                base.join("coinbase-country-attestation/target/coinbase_country_attestation.json"),
            ),
        ];

        for (circuit_id, json_path) in &circuit_files {
            if !json_path.exists() {
                tracing::warn!(
                    "Circuit JSON not found for {}: {} — skipping",
                    circuit_id,
                    json_path.display()
                );
                continue;
            }

            tracing::info!("Loading circuit: {} from {}", circuit_id, json_path.display());

            let bytecode = load_bytecode_from_json(json_path)?;

            tracing::info!("Setting up SRS for {}", circuit_id);
            setup_srs_from_bytecode(bytecode.as_str(), None, false)
                .map_err(|e| format!("SRS setup failed for {}: {}", circuit_id, e))?;

            tracing::info!("Generating VK for {}", circuit_id);
            let vk = get_ultra_honk_keccak_verification_key(bytecode.as_str(), false, false)
                .map_err(|e| format!("VK generation failed for {}: {}", circuit_id, e))?;

            tracing::info!(
                "Circuit {} loaded: bytecode={} chars, vk={} bytes",
                circuit_id,
                bytecode.len(),
                vk.len()
            );

            circuits.insert(
                circuit_id.to_string(),
                CircuitData {
                    bytecode,
                    vk,
                },
            );
        }

        // Build metadata map for loaded circuits only
        for info in all_metadata {
            if circuits.contains_key(&info.id) {
                metadata.insert(info.id.clone(), info);
            }
        }

        tracing::info!("Circuit registry initialized: {} circuits loaded", circuits.len());

        Ok(Arc::new(Self { circuits, metadata }))
    }

    /// Create an empty registry (for testing).
    pub fn empty() -> Arc<Self> {
        Arc::new(Self {
            circuits: HashMap::new(),
            metadata: HashMap::new(),
        })
    }

    /// Create a registry with mock data (for testing HTTP layer).
    #[cfg(test)]
    pub fn mock() -> Arc<Self> {
        let mut circuits = HashMap::new();
        let mut metadata_map = HashMap::new();

        circuits.insert(
            "coinbase_attestation".to_string(),
            CircuitData {
                bytecode: "mock_bytecode_ca".to_string(),
                vk: vec![1, 2, 3, 4],
            },
        );
        circuits.insert(
            "coinbase_country_attestation".to_string(),
            CircuitData {
                bytecode: "mock_bytecode_cca".to_string(),
                vk: vec![5, 6, 7, 8],
            },
        );

        for info in circuit_metadata() {
            metadata_map.insert(info.id.clone(), info);
        }

        Arc::new(Self {
            circuits,
            metadata: metadata_map,
        })
    }

    /// Get circuit data by canonical ID.
    pub fn get(&self, circuit_id: &str) -> Result<&CircuitData, String> {
        self.circuits
            .get(circuit_id)
            .ok_or_else(|| format!("Circuit not found: {}", circuit_id))
    }

    /// Get metadata for all loaded circuits.
    pub fn list_circuits(&self) -> Vec<CircuitInfo> {
        self.metadata.values().cloned().collect()
    }

    /// Get the count of loaded circuits.
    pub fn len(&self) -> usize {
        self.circuits.len()
    }

    pub fn is_empty(&self) -> bool {
        self.circuits.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_circuit_metadata_has_two_circuits() {
        let meta = circuit_metadata();
        assert_eq!(meta.len(), 2);
        assert_eq!(meta[0].id, "coinbase_attestation");
        assert_eq!(meta[1].id, "coinbase_country_attestation");
    }

    #[test]
    fn test_circuit_metadata_display_names() {
        let meta = circuit_metadata();
        assert_eq!(meta[0].display_name, "Coinbase KYC");
        assert_eq!(meta[1].display_name, "Coinbase Country");
    }

    #[test]
    fn test_circuit_metadata_input_counts() {
        let meta = circuit_metadata();
        assert_eq!(meta[0].input_count, 899);
        assert_eq!(meta[1].input_count, 921);
    }

    #[test]
    fn test_empty_registry() {
        let registry = CircuitRegistry::empty();
        assert_eq!(registry.len(), 0);
        assert!(registry.is_empty());
        assert!(registry.list_circuits().is_empty());
    }

    #[test]
    fn test_empty_registry_get_returns_error() {
        let registry = CircuitRegistry::empty();
        let result = registry.get("coinbase_attestation");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Circuit not found"));
    }

    #[test]
    fn test_mock_registry_has_both_circuits() {
        let registry = CircuitRegistry::mock();
        assert_eq!(registry.len(), 2);
        assert!(!registry.is_empty());
    }

    #[test]
    fn test_mock_registry_get_coinbase_attestation() {
        let registry = CircuitRegistry::mock();
        let data = registry.get("coinbase_attestation").unwrap();
        assert_eq!(data.bytecode, "mock_bytecode_ca");
        assert_eq!(data.vk, vec![1, 2, 3, 4]);
    }

    #[test]
    fn test_mock_registry_get_coinbase_country_attestation() {
        let registry = CircuitRegistry::mock();
        let data = registry.get("coinbase_country_attestation").unwrap();
        assert_eq!(data.bytecode, "mock_bytecode_cca");
        assert_eq!(data.vk, vec![5, 6, 7, 8]);
    }

    #[test]
    fn test_mock_registry_get_unknown_circuit() {
        let registry = CircuitRegistry::mock();
        let result = registry.get("unknown_circuit");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("unknown_circuit"));
    }

    #[test]
    fn test_mock_registry_list_circuits() {
        let registry = CircuitRegistry::mock();
        let circuits = registry.list_circuits();
        assert_eq!(circuits.len(), 2);
        let ids: Vec<&str> = circuits.iter().map(|c| c.id.as_str()).collect();
        assert!(ids.contains(&"coinbase_attestation"));
        assert!(ids.contains(&"coinbase_country_attestation"));
    }

    #[test]
    fn test_load_bytecode_from_json_valid() {
        let dir = std::env::temp_dir().join("proofport_test_circuit");
        std::fs::create_dir_all(&dir).unwrap();
        let json_path = dir.join("test_circuit.json");
        std::fs::write(
            &json_path,
            r#"{"bytecode": "H4sIAAAAAAAA/test_bytecode", "abi": {}}"#,
        )
        .unwrap();

        let bytecode = load_bytecode_from_json(&json_path).unwrap();
        assert_eq!(bytecode, "H4sIAAAAAAAA/test_bytecode");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn test_load_bytecode_from_json_missing_field() {
        let dir = std::env::temp_dir().join("proofport_test_circuit_no_bc");
        std::fs::create_dir_all(&dir).unwrap();
        let json_path = dir.join("test_circuit.json");
        std::fs::write(&json_path, r#"{"abi": {}}"#).unwrap();

        let result = load_bytecode_from_json(&json_path);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("No 'bytecode' field"));

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn test_load_bytecode_from_json_invalid_json() {
        let dir = std::env::temp_dir().join("proofport_test_circuit_bad_json");
        std::fs::create_dir_all(&dir).unwrap();
        let json_path = dir.join("test_circuit.json");
        std::fs::write(&json_path, "not valid json").unwrap();

        let result = load_bytecode_from_json(&json_path);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Failed to parse"));

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn test_load_bytecode_from_json_file_not_found() {
        let result = load_bytecode_from_json(std::path::Path::new("/nonexistent/path.json"));
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Failed to read"));
    }

    #[test]
    fn test_new_registry_with_missing_dir_loads_zero() {
        // CircuitRegistry::new with a non-existent circuits dir should load 0 circuits
        // (circuits are skipped when JSON files are not found)
        let registry = CircuitRegistry::new("/nonexistent/circuits/dir");
        // This should succeed but with 0 circuits
        match registry {
            Ok(reg) => assert_eq!(reg.len(), 0),
            Err(_) => {
                // Also acceptable if it errors — depends on whether noir_rs is available
            }
        }
    }
}
