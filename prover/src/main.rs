mod circuit;
mod prover;
mod routes;
mod types;
mod verifier;
#[cfg(feature = "enclave")]
mod vsock;

use std::sync::Arc;

use crate::circuit::CircuitRegistry;
use crate::prover::Prover;
use crate::routes::{build_router, AppState};

#[tokio::main]
async fn main() {
    // Initialize tracing
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "proofport_prover=info".into()),
        )
        .init();

    // Check transport mode: "vsock" for Nitro Enclave, "tcp" (default) for HTTP
    let transport = std::env::var("TRANSPORT").unwrap_or_else(|_| "tcp".to_string());

    if transport == "vsock" {
        #[cfg(feature = "enclave")]
        {
            tracing::info!("Starting in vsock transport mode (Nitro Enclave)");
            vsock::run_vsock_server().unwrap_or_else(|e| {
                panic!("Vsock server failed: {}", e);
            });
            return;
        }
        #[cfg(not(feature = "enclave"))]
        panic!("Vsock transport requires the 'enclave' feature. Build with: cargo build --features enclave");
    }

    tracing::info!("Starting in TCP transport mode (HTTP)");

    // Determine circuits directory from env or default
    let circuits_dir = std::env::var("CIRCUITS_DIR").unwrap_or_else(|_| "./circuits".to_string());
    tracing::info!("Loading circuits from: {}", circuits_dir);

    // Load circuit registry (bytecode + VK for each circuit)
    let circuits = CircuitRegistry::new(&circuits_dir).unwrap_or_else(|e| {
        tracing::error!("Failed to initialize circuit registry: {}", e);
        tracing::warn!("Starting with empty circuit registry");
        CircuitRegistry::empty()
    });

    tracing::info!("Circuits loaded: {}", circuits.len());

    // Create prover with Mutex serialization
    let prover = Prover::new(circuits.clone());

    // Build application state
    let state = Arc::new(AppState { prover, circuits });

    // Build router
    let app = build_router(state);

    // Determine port from env or default
    let port = std::env::var("PORT").unwrap_or_else(|_| "4003".to_string());
    let addr = format!("0.0.0.0:{}", port);

    tracing::info!("Prover microservice listening on {}", addr);

    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .unwrap_or_else(|e| {
            panic!("Failed to bind to {}: {}", addr, e);
        });

    axum::serve(listener, app)
        .await
        .unwrap_or_else(|e| {
            panic!("Server error: {}", e);
        });
}
