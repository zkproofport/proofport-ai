import { ethers } from 'ethers';
import type {
  ClientConfig,
  CircuitId,
  ProofParams,
  ProofResult,
  StepResult,
} from './types.js';
import { CIRCUIT_NAME_MAP } from './types.js';
import { requestChallenge } from './session.js';
import { prepareInputs, computeSignalHash } from './inputs.js';
import { prepareOidcPayload } from './oidc-inputs.js';
import type { OidcProvePayload } from './oidc-inputs.js';
import { submitProof, submitEncryptedProof } from './prove.js';
import type { ProofportSigner } from './signer.js';
import { CIRCUITS } from './constants.js';
import { encryptForTee } from './tee.js';

export interface FlowCallbacks {
  onStep?: (step: StepResult) => void;
}

/**
 * Generate a ZK proof end-to-end.
 *
 * Automatically detects E2E encryption: if the server returns a TEE public key
 * in the challenge response (TEE mode = nitro), inputs are encrypted with
 * the TEE's attested X25519 public key. Otherwise (TEE disabled), inputs are
 * sent in plaintext.
 *
 * @param config - Server URL
 * @param signers - ProofportSigner for attestation (required)
 * @param params - Circuit name, scope, and optional country params
 * @param callbacks - Optional callbacks for step progress
 * @returns ProofResult with proof, publicInputs, and attestation info
 */
export async function generateProof(
  config: ClientConfig,
  signers: { attestation: ProofportSigner },
  params: ProofParams,
  callbacks?: FlowCallbacks,
): Promise<ProofResult> {
  const circuitId: CircuitId = CIRCUIT_NAME_MAP[params.circuit];
  const scope = params.scope || 'proofport';
  const isOidc = CIRCUITS[circuitId]?.inputType === 'oidc';

  const steps: StepResult[] = [];
  function recordStep<T>(step: number, name: string, data: T, startTime: number): T {
    const result: StepResult<T> = { step, name, data, durationMs: Date.now() - startTime };
    steps.push(result);
    callbacks?.onStep?.(result);
    return data;
  }

  // Steps 1-2: EAS attestation path (skipped for OIDC circuits)
  let easInputs: Awaited<ReturnType<typeof prepareInputs>> | undefined;
  let oidcPayload: OidcProvePayload | undefined;

  if (!isOidc) {
    // Step 1: Sign signal hash
    let t = Date.now();
    const attestationAddress = await signers.attestation.getAddress();
    const signalHash = computeSignalHash(attestationAddress, scope, circuitId);
    const signalHashHex = ethers.hexlify(signalHash);
    const signature = await signers.attestation.signMessage(signalHash);
    recordStep(1, 'Sign Signal Hash', { signalHash: signalHashHex, signature }, t);

    // Step 2: Prepare inputs
    t = Date.now();
    easInputs = await prepareInputs(config, {
      circuitId,
      userAddress: attestationAddress,
      userSignature: signature,
      scope,
      countryList: params.countryList,
      isIncluded: params.isIncluded,
    });
    recordStep(2, 'Prepare Inputs', { inputFields: Object.keys(easInputs).length }, t);
  } else {
    // OIDC path: no EAS attestation, prepare inputs locally from JWT (JWT never leaves client)
    recordStep(1, 'Sign Signal Hash', { skipped: true, reason: 'oidc' }, Date.now());

    // Step 2: Prepare OIDC payload (fetch JWKS, send raw JWT to TEE for validation)
    const t2 = Date.now();
    if (!params.jwt) {
      throw new Error('jwt is required for OIDC circuits');
    }
    oidcPayload = await prepareOidcPayload({ jwt: params.jwt, scope, provider: params.provider });
    recordStep(2, 'Prepare Inputs (OIDC)', { payloadFields: Object.keys(oidcPayload).length }, t2);
  }

  // Step 3: Request challenge (server returns nonce + TEE key if available)
  let t = Date.now();
  const challenge = await requestChallenge(config, params.circuit);
  const isE2E = !!challenge.teePublicKey;
  recordStep(3, 'Request Challenge', { nonce: challenge.nonce, e2e: isE2E, keyId: challenge.teePublicKey?.keyId ?? null }, t);

  // Step 4: Submit proof (encrypted or plaintext based on TEE availability)
  t = Date.now();
  let proveResponse;

  if (isE2E) {
    // E2E path: encrypt structured inputs with TEE's attested public key
    const inputsToEncrypt = isOidc ? oidcPayload : easInputs;
    const encryptedPayload = encryptForTee(
      JSON.stringify({ circuitId, inputs: inputsToEncrypt }),
      challenge.teePublicKey!.publicKey,
    );
    proveResponse = await submitEncryptedProof(config, {
      circuit: params.circuit,
      encryptedPayload,
      nonce: challenge.nonce,
    });
    recordStep(4, 'Generate Proof (E2E Encrypted)', proveResponse, t);
  } else if (isOidc) {
    // OIDC plaintext path: send payload (JWT + JWKS) — server relays to prover, prover validates + builds inputs
    proveResponse = await submitProof(config, {
      circuit: params.circuit,
      inputs: oidcPayload! as unknown as Record<string, unknown>,
      nonce: challenge.nonce,
    });
    recordStep(4, 'Generate Proof (OIDC)', proveResponse, t);
  } else {
    // Coinbase plaintext path: send pre-computed inputs (TEE disabled / local dev)
    proveResponse = await submitProof(config, {
      circuit: params.circuit,
      inputs: easInputs!,
      nonce: challenge.nonce,
    });
    recordStep(4, 'Generate Proof', proveResponse, t);
  }

  return {
    proof: proveResponse.proof,
    publicInputs: proveResponse.publicInputs,
    proofWithInputs: proveResponse.proofWithInputs,
    attestation: proveResponse.attestation,
    timing: proveResponse.timing,
    verification: proveResponse.verification,
  };
}
