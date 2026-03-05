import { ethers } from 'ethers';
import type {
  ClientConfig,
  CircuitId,
  ProofParams,
  ProofResult,
  StepResult,
  PaymentInfo,
} from './types.js';
import { CIRCUIT_NAME_MAP } from './types.js';
import { requestChallenge } from './session.js';
import { prepareInputs, computeSignalHash } from './inputs.js';
import { makePayment } from './payment.js';
import { submitProof, submitEncryptedProof } from './prove.js';
import type { ProofportSigner } from './signer.js';
import { USDC_ADDRESSES } from './constants.js';
import { encryptForTee } from './tee.js';
import { buildProverToml } from './toml.js';

export interface FlowCallbacks {
  onStep?: (step: StepResult) => void;
}

/**
 * Generate a ZK proof end-to-end using x402 single-step flow.
 *
 * Automatically detects E2E encryption: if the server returns a TEE public key
 * in the 402 challenge response (TEE mode = nitro), inputs are encrypted with
 * the TEE's attested X25519 public key. Otherwise (TEE disabled), inputs are
 * sent in plaintext.
 *
 * @param config - Server URL and RPC endpoints
 * @param signers - ProofportSigner for attestation (required) and payment (optional, defaults to attestation)
 * @param params - Circuit name, scope, and optional country params
 * @param callbacks - Optional callbacks for step progress
 * @returns ProofResult with proof, publicInputs, payment info
 */
export async function generateProof(
  config: ClientConfig,
  signers: { attestation: ProofportSigner; payment?: ProofportSigner },
  params: ProofParams,
  callbacks?: FlowCallbacks,
): Promise<ProofResult> {
  const circuitId: CircuitId = CIRCUIT_NAME_MAP[params.circuit];
  const scope = params.scope || 'proofport';
  const paymentSigner = signers.payment || signers.attestation;

  const steps: StepResult[] = [];
  function recordStep<T>(step: number, name: string, data: T, startTime: number): T {
    const result: StepResult<T> = { step, name, data, durationMs: Date.now() - startTime };
    steps.push(result);
    callbacks?.onStep?.(result);
    return data;
  }

  // Step 1: Sign signal hash
  let t = Date.now();
  const attestationAddress = await signers.attestation.getAddress();
  const signalHash = computeSignalHash(attestationAddress, scope, circuitId);
  const signalHashHex = ethers.hexlify(signalHash);
  const signature = await signers.attestation.signMessage(signalHash);
  recordStep(1, 'Sign Signal Hash', { signalHash: signalHashHex, signature }, t);

  // Step 2: Prepare inputs + build proverToml locally
  t = Date.now();
  const inputs = await prepareInputs(config, {
    circuitId,
    userAddress: attestationAddress,
    userSignature: signature,
    scope,
    countryList: params.countryList,
    isIncluded: params.isIncluded,
  });
  const proverToml = buildProverToml(circuitId, inputs);
  recordStep(2, 'Prepare Inputs', { inputFields: Object.keys(inputs).length, tomlLength: proverToml.length }, t);

  // Step 3: Request 402 challenge (without inputs — server only needs circuit)
  t = Date.now();
  const challenge = await requestChallenge(config, params.circuit);
  const isE2E = !!challenge.teePublicKey;
  recordStep(3, 'Request Challenge', { nonce: challenge.nonce, e2e: isE2E, keyId: challenge.teePublicKey?.keyId ?? null }, t);

  // Step 4: Make payment
  t = Date.now();
  const network = challenge.payment.network as string;
  const paymentInfo: PaymentInfo = {
    nonce: challenge.nonce,
    recipient: challenge.payment.payTo,
    amount: parseInt(challenge.payment.maxAmountRequired),
    asset: USDC_ADDRESSES[network as keyof typeof USDC_ADDRESSES],
    network: challenge.payment.network,
    instruction: challenge.payment.description,
  };
  const paymentTxHash = await makePayment(paymentSigner, paymentInfo, config.facilitatorUrl || challenge.facilitatorUrl);
  recordStep(4, 'Make Payment', { txHash: paymentTxHash }, t);

  // Step 5: Submit proof (encrypted or plaintext based on TEE availability)
  t = Date.now();
  let proveResponse;

  if (isE2E) {
    // E2E path: encrypt inputs with TEE's attested public key
    const encryptedPayload = encryptForTee(
      JSON.stringify({ circuitId, proverToml }),
      challenge.teePublicKey!.publicKey,
    );
    proveResponse = await submitEncryptedProof(config, {
      circuit: params.circuit,
      encryptedPayload,
      paymentTxHash,
      paymentNonce: challenge.nonce,
    });
    recordStep(5, 'Generate Proof (E2E Encrypted)', proveResponse, t);
  } else {
    // Standard path: send plaintext inputs (TEE disabled / local dev)
    proveResponse = await submitProof(config, {
      circuit: params.circuit,
      inputs,
      paymentTxHash,
      paymentNonce: challenge.nonce,
    });
    recordStep(5, 'Generate Proof', proveResponse, t);
  }

  return {
    proof: proveResponse.proof,
    publicInputs: proveResponse.publicInputs,
    proofWithInputs: proveResponse.proofWithInputs,
    paymentTxHash,
    attestation: proveResponse.attestation,
    timing: proveResponse.timing,
    verification: proveResponse.verification,
  };
}
