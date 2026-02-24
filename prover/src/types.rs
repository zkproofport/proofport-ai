use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProveRequest {
    pub circuit_id: String,
    pub inputs: Vec<String>,
    pub on_chain: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProveResponse {
    pub proof: String,
    pub public_inputs: String,
    pub proof_with_inputs: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifyRequest {
    pub circuit_id: String,
    pub proof: Vec<u8>,
    pub on_chain: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifyResponse {
    pub is_valid: bool,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CircuitInfo {
    pub id: String,
    pub display_name: String,
    pub description: String,
    pub required_inputs: Vec<String>,
    pub input_count: usize,
}

#[derive(Debug, Serialize)]
pub struct CircuitsResponse {
    pub circuits: Vec<CircuitInfo>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthResponse {
    pub status: String,
    pub circuits_loaded: usize,
}

#[derive(Debug, Serialize)]
pub struct ErrorResponse {
    pub error: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_prove_request_deserialize() {
        let json = r#"{
            "circuitId": "coinbase_attestation",
            "inputs": ["149", "2", "100"],
            "onChain": true
        }"#;
        let req: ProveRequest = serde_json::from_str(json).unwrap();
        assert_eq!(req.circuit_id, "coinbase_attestation");
        assert_eq!(req.inputs, vec!["149", "2", "100"]);
        assert!(req.on_chain);
    }

    #[test]
    fn test_prove_request_deserialize_off_chain() {
        let json = r#"{
            "circuitId": "coinbase_country_attestation",
            "inputs": ["1", "2"],
            "onChain": false
        }"#;
        let req: ProveRequest = serde_json::from_str(json).unwrap();
        assert_eq!(req.circuit_id, "coinbase_country_attestation");
        assert!(!req.on_chain);
    }

    #[test]
    fn test_prove_request_missing_field() {
        let json = r#"{"circuitId": "coinbase_attestation", "inputs": ["1"]}"#;
        let result: Result<ProveRequest, _> = serde_json::from_str(json);
        assert!(result.is_err());
    }

    #[test]
    fn test_prove_response_serialize() {
        let resp = ProveResponse {
            proof: "deadbeef".to_string(),
            public_inputs: "cafebabe".to_string(),
            proof_with_inputs: "deadbeefcafebabe".to_string(),
        };
        let json = serde_json::to_value(&resp).unwrap();
        assert_eq!(json["proof"], "deadbeef");
        assert_eq!(json["publicInputs"], "cafebabe");
        assert_eq!(json["proofWithInputs"], "deadbeefcafebabe");
    }

    #[test]
    fn test_verify_request_deserialize() {
        let json = r#"{
            "circuitId": "coinbase_attestation",
            "proof": [1, 2, 3, 4],
            "onChain": true
        }"#;
        let req: VerifyRequest = serde_json::from_str(json).unwrap();
        assert_eq!(req.circuit_id, "coinbase_attestation");
        assert_eq!(req.proof, vec![1, 2, 3, 4]);
        assert!(req.on_chain);
    }

    #[test]
    fn test_verify_response_serialize() {
        let resp = VerifyResponse { is_valid: true };
        let json = serde_json::to_value(&resp).unwrap();
        assert_eq!(json["isValid"], true);

        let resp = VerifyResponse { is_valid: false };
        let json = serde_json::to_value(&resp).unwrap();
        assert_eq!(json["isValid"], false);
    }

    #[test]
    fn test_circuit_info_serialize() {
        let info = CircuitInfo {
            id: "coinbase_attestation".to_string(),
            display_name: "Coinbase KYC".to_string(),
            description: "Verify Coinbase KYC attestation".to_string(),
            required_inputs: vec!["signal_hash".to_string(), "user_address".to_string()],
            input_count: 899,
        };
        let json = serde_json::to_value(&info).unwrap();
        assert_eq!(json["id"], "coinbase_attestation");
        assert_eq!(json["displayName"], "Coinbase KYC");
        assert_eq!(json["inputCount"], 899);
    }

    #[test]
    fn test_circuits_response_serialize() {
        let resp = CircuitsResponse {
            circuits: vec![
                CircuitInfo {
                    id: "coinbase_attestation".to_string(),
                    display_name: "Coinbase KYC".to_string(),
                    description: "Verify Coinbase KYC attestation".to_string(),
                    required_inputs: vec![],
                    input_count: 899,
                },
            ],
        };
        let json = serde_json::to_value(&resp).unwrap();
        assert!(json["circuits"].is_array());
        assert_eq!(json["circuits"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn test_health_response_serialize() {
        let resp = HealthResponse {
            status: "ok".to_string(),
            circuits_loaded: 2,
        };
        let json = serde_json::to_value(&resp).unwrap();
        assert_eq!(json["status"], "ok");
        assert_eq!(json["circuitsLoaded"], 2);
    }

    #[test]
    fn test_error_response_serialize() {
        let resp = ErrorResponse {
            error: "Circuit not found: unknown_circuit".to_string(),
        };
        let json = serde_json::to_value(&resp).unwrap();
        assert_eq!(json["error"], "Circuit not found: unknown_circuit");
    }

    #[test]
    fn test_prove_request_empty_inputs() {
        let json = r#"{
            "circuitId": "coinbase_attestation",
            "inputs": [],
            "onChain": true
        }"#;
        let req: ProveRequest = serde_json::from_str(json).unwrap();
        assert!(req.inputs.is_empty());
    }

    #[test]
    fn test_prove_request_decimal_inputs() {
        let json = r#"{
            "circuitId": "coinbase_attestation",
            "inputs": ["149", "0", "255", "128"],
            "onChain": true
        }"#;
        let req: ProveRequest = serde_json::from_str(json).unwrap();
        assert_eq!(req.inputs[0], "149");
        assert_eq!(req.inputs[3], "128");
    }
}
