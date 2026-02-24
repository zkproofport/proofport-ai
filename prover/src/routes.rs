use std::sync::Arc;

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;

use crate::circuit::CircuitRegistry;
use crate::prover::Prover;
use crate::types::{
    CircuitsResponse, ErrorResponse, HealthResponse, ProveRequest, ProveResponse, VerifyRequest,
    VerifyResponse,
};

/// Shared application state passed to all route handlers.
pub struct AppState {
    pub prover: Prover,
    pub circuits: Arc<CircuitRegistry>,
}

/// POST /prove — Generate a ZK proof.
///
/// Request body: ProveRequest { circuit_id, inputs (decimal strings), on_chain }
/// Response: ProveResponse { proof, public_inputs, proof_with_inputs } (all hex-encoded)
pub async fn prove_handler(
    State(state): State<Arc<AppState>>,
    Json(req): Json<ProveRequest>,
) -> impl IntoResponse {
    if req.circuit_id.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::to_value(ErrorResponse {
                error: "circuit_id is required".to_string(),
            })
            .unwrap()),
        );
    }

    if req.inputs.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::to_value(ErrorResponse {
                error: "inputs must not be empty".to_string(),
            })
            .unwrap()),
        );
    }

    match state.prover.prove(&req.circuit_id, req.inputs, req.on_chain).await {
        Ok(result) => (
            StatusCode::OK,
            Json(
                serde_json::to_value(ProveResponse {
                    proof: result.proof_hex,
                    public_inputs: result.public_inputs_hex,
                    proof_with_inputs: result.proof_with_inputs_hex,
                })
                .unwrap(),
            ),
        ),
        Err(e) => {
            let status = if e.contains("Circuit not found") {
                StatusCode::NOT_FOUND
            } else {
                StatusCode::INTERNAL_SERVER_ERROR
            };
            (
                status,
                Json(serde_json::to_value(ErrorResponse { error: e }).unwrap()),
            )
        }
    }
}

/// POST /verify — Verify a ZK proof locally.
///
/// Request body: VerifyRequest { circuitId, proof (byte array), onChain }
/// Response: VerifyResponse { isValid: bool }
pub async fn verify_handler(
    State(state): State<Arc<AppState>>,
    Json(req): Json<VerifyRequest>,
) -> impl IntoResponse {
    if req.circuit_id.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::to_value(ErrorResponse {
                error: "circuit_id is required".to_string(),
            })
            .unwrap()),
        );
    }

    if req.proof.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::to_value(ErrorResponse {
                error: "proof must not be empty".to_string(),
            })
            .unwrap()),
        );
    }

    match state.prover.verify(&req.circuit_id, req.proof, req.on_chain).await {
        Ok(is_valid) => (
            StatusCode::OK,
            Json(serde_json::to_value(VerifyResponse { is_valid }).unwrap()),
        ),
        Err(e) => {
            let status = if e.contains("Circuit not found") {
                StatusCode::NOT_FOUND
            } else {
                StatusCode::INTERNAL_SERVER_ERROR
            };
            (
                status,
                Json(serde_json::to_value(ErrorResponse { error: e }).unwrap()),
            )
        }
    }
}

/// GET /circuits — List all loaded circuit metadata.
///
/// Response: CircuitsResponse { circuits: [CircuitInfo, ...] }
pub async fn circuits_handler(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let circuits = state.circuits.list_circuits();
    (
        StatusCode::OK,
        Json(serde_json::to_value(CircuitsResponse { circuits }).unwrap()),
    )
}

/// GET /health — Health check endpoint.
///
/// Response: HealthResponse { status: "ok", circuits_loaded: N }
pub async fn health_handler(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    (
        StatusCode::OK,
        Json(
            serde_json::to_value(HealthResponse {
                status: "ok".to_string(),
                circuits_loaded: state.circuits.len(),
            })
            .unwrap(),
        ),
    )
}

/// Build the axum router with all routes.
pub fn build_router(state: Arc<AppState>) -> axum::Router {
    use axum::routing::{get, post};
    use tower_http::cors::{Any, CorsLayer};

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    axum::Router::new()
        .route("/prove", post(prove_handler))
        .route("/verify", post(verify_handler))
        .route("/circuits", get(circuits_handler))
        .route("/health", get(health_handler))
        .layer(cors)
        .with_state(state)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum_test::TestServer;

    fn create_test_app() -> TestServer {
        let circuits = CircuitRegistry::mock();
        let prover = Prover::new(circuits.clone());
        let state = Arc::new(AppState {
            prover,
            circuits,
        });
        let router = build_router(state);
        TestServer::new(router).unwrap()
    }

    // ──────────────────────────────────────────────
    // GET /health
    // ──────────────────────────────────────────────

    #[tokio::test]
    async fn test_health_returns_200() {
        let server = create_test_app();
        let response = server.get("/health").await;
        response.assert_status_ok();
    }

    #[tokio::test]
    async fn test_health_returns_ok_status() {
        let server = create_test_app();
        let response = server.get("/health").await;
        let body: serde_json::Value = response.json();
        assert_eq!(body["status"], "ok");
    }

    #[tokio::test]
    async fn test_health_returns_circuits_loaded() {
        let server = create_test_app();
        let response = server.get("/health").await;
        let body: serde_json::Value = response.json();
        assert_eq!(body["circuitsLoaded"], 2);
    }

    // ──────────────────────────────────────────────
    // GET /circuits
    // ──────────────────────────────────────────────

    #[tokio::test]
    async fn test_circuits_returns_200() {
        let server = create_test_app();
        let response = server.get("/circuits").await;
        response.assert_status_ok();
    }

    #[tokio::test]
    async fn test_circuits_returns_array() {
        let server = create_test_app();
        let response = server.get("/circuits").await;
        let body: serde_json::Value = response.json();
        assert!(body["circuits"].is_array());
    }

    #[tokio::test]
    async fn test_circuits_returns_both_circuits() {
        let server = create_test_app();
        let response = server.get("/circuits").await;
        let body: serde_json::Value = response.json();
        let circuits = body["circuits"].as_array().unwrap();
        assert_eq!(circuits.len(), 2);

        let ids: Vec<&str> = circuits
            .iter()
            .map(|c| c["id"].as_str().unwrap())
            .collect();
        assert!(ids.contains(&"coinbase_attestation"));
        assert!(ids.contains(&"coinbase_country_attestation"));
    }

    #[tokio::test]
    async fn test_circuits_has_required_fields() {
        let server = create_test_app();
        let response = server.get("/circuits").await;
        let body: serde_json::Value = response.json();
        let circuit = &body["circuits"][0];
        assert!(circuit["id"].is_string());
        assert!(circuit["displayName"].is_string());
        assert!(circuit["description"].is_string());
        assert!(circuit["requiredInputs"].is_array());
        assert!(circuit["inputCount"].is_number());
    }

    // ──────────────────────────────────────────────
    // POST /prove — validation
    // ──────────────────────────────────────────────

    #[tokio::test]
    async fn test_prove_empty_circuit_id_returns_400() {
        let server = create_test_app();
        let response = server
            .post("/prove")
            .json(&serde_json::json!({
                "circuitId": "",
                "inputs": ["1"],
                "onChain": true
            }))
            .await;
        response.assert_status(StatusCode::BAD_REQUEST);
        let body: serde_json::Value = response.json();
        assert!(body["error"].as_str().unwrap().contains("circuit_id"));
    }

    #[tokio::test]
    async fn test_prove_empty_inputs_returns_400() {
        let server = create_test_app();
        let response = server
            .post("/prove")
            .json(&serde_json::json!({
                "circuitId": "coinbase_attestation",
                "inputs": [],
                "onChain": true
            }))
            .await;
        response.assert_status(StatusCode::BAD_REQUEST);
        let body: serde_json::Value = response.json();
        assert!(body["error"].as_str().unwrap().contains("inputs"));
    }

    #[tokio::test]
    async fn test_prove_unknown_circuit_returns_404() {
        let server = create_test_app();
        let response = server
            .post("/prove")
            .json(&serde_json::json!({
                "circuitId": "nonexistent_circuit",
                "inputs": ["1", "2"],
                "onChain": true
            }))
            .await;
        // Mock registry has the circuit but noir_rs will fail on mock bytecode.
        // For a truly unknown circuit, we'd get 404.
        // With mock, "nonexistent_circuit" is not in the registry, so we get 404.
        response.assert_status(StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn test_prove_missing_on_chain_field_returns_422() {
        let server = create_test_app();
        let response = server
            .post("/prove")
            .json(&serde_json::json!({
                "circuitId": "coinbase_attestation",
                "inputs": ["1"]
            }))
            .await;
        // Missing required field `onChain` — axum returns 422 Unprocessable Entity
        response.assert_status(StatusCode::UNPROCESSABLE_ENTITY);
    }

    // ──────────────────────────────────────────────
    // POST /verify — validation
    // ──────────────────────────────────────────────

    #[tokio::test]
    async fn test_verify_empty_circuit_id_returns_400() {
        let server = create_test_app();
        let response = server
            .post("/verify")
            .json(&serde_json::json!({
                "circuitId": "",
                "proof": [1, 2, 3],
                "onChain": true
            }))
            .await;
        response.assert_status(StatusCode::BAD_REQUEST);
        let body: serde_json::Value = response.json();
        assert!(body["error"].as_str().unwrap().contains("circuit_id"));
    }

    #[tokio::test]
    async fn test_verify_empty_proof_returns_400() {
        let server = create_test_app();
        let response = server
            .post("/verify")
            .json(&serde_json::json!({
                "circuitId": "coinbase_attestation",
                "proof": [],
                "onChain": true
            }))
            .await;
        response.assert_status(StatusCode::BAD_REQUEST);
        let body: serde_json::Value = response.json();
        assert!(body["error"].as_str().unwrap().contains("proof"));
    }

    #[tokio::test]
    async fn test_verify_unknown_circuit_returns_404() {
        let server = create_test_app();
        let response = server
            .post("/verify")
            .json(&serde_json::json!({
                "circuitId": "nonexistent_circuit",
                "proof": [1, 2, 3],
                "onChain": true
            }))
            .await;
        response.assert_status(StatusCode::NOT_FOUND);
    }

    // ──────────────────────────────────────────────
    // 404 for unknown routes
    // ──────────────────────────────────────────────

    #[tokio::test]
    async fn test_unknown_route_returns_404() {
        let server = create_test_app();
        let response = server.get("/unknown").await;
        response.assert_status(StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn test_get_on_post_route_returns_405() {
        let server = create_test_app();
        let response = server.get("/prove").await;
        response.assert_status(StatusCode::METHOD_NOT_ALLOWED);
    }

    // ──────────────────────────────────────────────
    // Empty registry
    // ──────────────────────────────────────────────

    #[tokio::test]
    async fn test_health_with_empty_registry() {
        let circuits = CircuitRegistry::empty();
        let prover = Prover::new(circuits.clone());
        let state = Arc::new(AppState {
            prover,
            circuits,
        });
        let router = build_router(state);
        let server = TestServer::new(router).unwrap();

        let response = server.get("/health").await;
        response.assert_status_ok();
        let body: serde_json::Value = response.json();
        assert_eq!(body["status"], "ok");
        assert_eq!(body["circuitsLoaded"], 0);
    }

    #[tokio::test]
    async fn test_circuits_with_empty_registry() {
        let circuits = CircuitRegistry::empty();
        let prover = Prover::new(circuits.clone());
        let state = Arc::new(AppState {
            prover,
            circuits,
        });
        let router = build_router(state);
        let server = TestServer::new(router).unwrap();

        let response = server.get("/circuits").await;
        response.assert_status_ok();
        let body: serde_json::Value = response.json();
        assert_eq!(body["circuits"].as_array().unwrap().len(), 0);
    }
}
