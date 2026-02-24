// Verifier module — wraps the prover's verify method.
//
// This module exists as a separate conceptual boundary. In the current
// implementation, verification is handled by Prover::verify() which uses
// noir_rs verify_ultra_honk_keccak behind the same Mutex.
//
// Future extension: add on-chain verification via ethers-rs if needed,
// or separate the verify path to allow concurrent verification while
// keeping proof generation serialized.
//
// For now, all verification goes through Prover::verify().
