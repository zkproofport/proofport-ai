/**
 * Full ZK Proof Generation Flow
 *
 * Usage:
 *   ATTESTATION_KEY=0x... PAYMENT_KEY=0x... SERVER_URL=https://stg-ai.zkproofport.app npx tsx examples/full-flow.ts
 *
 * Environment variables:
 *   ATTESTATION_KEY  - Private key of wallet with Coinbase KYC attestation (required)
 *   PAYMENT_KEY      - Private key of wallet with USDC balance (optional, defaults to ATTESTATION_KEY)
 *   SERVER_URL       - proofport-ai server URL (default: https://stg-ai.zkproofport.app)
 *   CIRCUIT          - Circuit name: coinbase_kyc | coinbase_country (default: coinbase_kyc)
 *   SCOPE            - Scope string (default: proofport)
 */
import { generateProof, verifyProof, CIRCUIT_NAME_MAP, fromPrivateKey } from '../src/index.js';
import type { ClientConfig, CircuitName, StepResult } from '../src/index.js';

async function main() {
  const attestationKey = process.env.ATTESTATION_KEY;
  if (!attestationKey) {
    console.error('Error: ATTESTATION_KEY environment variable is required');
    console.error('Usage: ATTESTATION_KEY=0x... npx tsx examples/full-flow.ts');
    process.exit(1);
  }

  const config: ClientConfig = {
    baseUrl: process.env.SERVER_URL || 'https://stg-ai.zkproofport.app',
  };

  const attestationSigner = fromPrivateKey(attestationKey);
  const paymentSigner = process.env.PAYMENT_KEY
    ? fromPrivateKey(process.env.PAYMENT_KEY)
    : undefined;

  const circuit = (process.env.CIRCUIT || 'coinbase_kyc') as CircuitName;
  const scope = process.env.SCOPE || 'proofport';

  console.log('=== ZKProofport Proof Generation ===');
  console.log(`Server:  ${config.baseUrl}`);
  console.log(`Circuit: ${circuit}`);
  console.log(`Scope:   ${scope}`);
  console.log('');

  try {
    const result = await generateProof(
      config,
      { attestation: attestationSigner, payment: paymentSigner },
      { circuit, scope },
      {
        onStep: (step: StepResult) => {
          console.log(`[Step ${step.step}] ${step.name} (${step.durationMs}ms)`);
        },
      },
    );

    console.log('');
    console.log('=== Proof Generated ===');
    console.log(`Payment:  ${result.paymentTxHash}`);
    console.log(`Proof:    ${result.proof}`);
    console.log(`Inputs:   ${result.publicInputs}`);
    console.log(`TEE:      ${result.attestation ? 'Yes' : 'No'}`);
    console.log(`Total:    ${result.timing.totalMs}ms`);

    // Optional: verify on-chain
    const circuitId = CIRCUIT_NAME_MAP[circuit];
    console.log('');
    console.log('Verifying on-chain...');
    const verification = await verifyProof(config, circuitId, result.proof, result.publicInputs);
    console.log(`On-chain: ${verification.valid ? 'VALID' : `INVALID - ${verification.error}`}`);

  } catch (error) {
    console.error('Failed:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

main();
