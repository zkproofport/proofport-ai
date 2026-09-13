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
import { signPayment } from './payment.js';
import { prepareInputs, computeSignalHash } from './inputs.js';
import { prepareOidcPayload } from './oidc-inputs.js';
import type { OidcProvePayload } from './oidc-inputs.js';
import { submitProof, submitEncryptedProof } from './prove.js';
import type { ProofportSigner } from './signer.js';
import type { PaymentWallet } from './types.js';
import { CIRCUITS } from './constants.js';
import { CIRCUIT_IDS } from './circuits.js';
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
  signers: {
    attestation: ProofportSigner;
    /**
     * The wallet that pays, when the service charges. A different wallet from
     * `attestation` and deliberately so: the attestation wallet is fixed by
     * the EAS attestation bound to it, while the paying wallet is whichever
     * one holds USDC. Forcing them to be the same would mean the wallet that
     * passed KYC also has to be funded on the paying chain.
     *
     * Omitting it is fine against a service with payment disabled. Against one
     * that charges, the 402 is returned as an error naming the chains offered,
     * rather than a proof request that hangs.
     */
    payment?: PaymentWallet;
  },
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
  let domainSeparator: string | undefined;
  let actionHash: string | undefined;

  if (!isOidc) {
    // The circuit decides the signature, and a mismatch is refused here.
    //
    // This used to be "typed data if an action was passed, personal_sign
    // otherwise", with the circuit id carried along beside it. That reads as
    // two paths and is really four, two of which are silently wrong:
    // `arc_eligibility` with no action signed `signal_hash` and produced a
    // proof whose domain and action hashes are absent, and a Coinbase circuit
    // with an action signed typed data the circuit cannot verify. The mobile
    // app had the same defect in its KYC hook and it produced proofs from the
    // wrong circuit for a day.
    if (circuitId === CIRCUIT_IDS.ARC_ELIGIBILITY && !params.action) {
      throw new Error(
        `${CIRCUIT_IDS.ARC_ELIGIBILITY} proves that a wallet authorised ONE EIP-712 action, and no action was given. ` +
          `Its domain separator and action hash are public inputs, so there is nothing to prove without one. ` +
          `Pass \`action\`, or ask for ${CIRCUIT_IDS.COINBASE_ATTESTATION}.`,
      );
    }
    if (params.action && circuitId !== CIRCUIT_IDS.ARC_ELIGIBILITY) {
      throw new Error(
        `An action was given but '${circuitId}' was requested, and only ${CIRCUIT_IDS.ARC_ELIGIBILITY} carries one. ` +
          `Signing typed data for '${circuitId}' yields a signature that circuit cannot verify. ` +
          `Ask for ${CIRCUIT_IDS.ARC_ELIGIBILITY}, or drop the action.`,
      );
    }

    // Step 1: Sign.
    //
    // `signal_hash` is computed either way, because the nullifier derives from
    // it and must stay one value per wallet per scope no matter how many
    // actions that wallet authorizes.
    //
    // Without an action the wallet signs `signal_hash` through personal_sign,
    // which shows the person a hex string. With one it signs the typed
    // structure, which the wallet renders as named fields, and the verifying
    // contract can recompute.
    let t = Date.now();
    const attestationAddress = await signers.attestation.getAddress();
    const signalHash = computeSignalHash(attestationAddress, scope, circuitId);
    const signalHashHex = ethers.hexlify(signalHash);

    let signature: string;
    if (params.action) {
      const { domain, types, message } = params.action;
      signature = await signers.attestation.signTypedData(domain, types, message);
      domainSeparator = ethers.TypedDataEncoder.hashDomain(domain);
      actionHash = ethers.TypedDataEncoder.hashStruct(params.action.primaryType, types, message);
      recordStep(1, 'Sign Typed Action', {
        signalHash: signalHashHex,
        domainSeparator,
        actionHash,
        primaryType: params.action.primaryType,
        verifyingContract: domain.verifyingContract,
        signature,
      }, t);
    } else {
      signature = await signers.attestation.signMessage(signalHash);
      recordStep(1, 'Sign Signal Hash', { signalHash: signalHashHex, signature }, t);
    }

    // Step 2: Prepare inputs
    t = Date.now();
    // The action hashes go IN, not on afterwards: the public key is recovered
    // inside, and for an action-bound circuit it must be recovered from the
    // EIP-712 digest. Attaching them to the result left the key recovered from
    // `signal_hash`, and the circuit refused the proof with "User pubkey does
    // not match address" — which reads as a wrong wallet, not a wrong message.
    easInputs = await prepareInputs(config, {
      circuitId,
      userAddress: attestationAddress,
      userSignature: signature,
      scope,
      countryList: params.countryList,
      isIncluded: params.isIncluded,
      domainSeparator,
      actionHash,
    });
    if (domainSeparator && actionHash) {
      easInputs = { ...easInputs, domain_separator: domainSeparator, action_hash: actionHash };
    }
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

  // Step 3b: Pay, if the service charges.
  //
  // The buyer signs an EIP-3009 authorization and the service settles it, so
  // no gas and no native balance are needed on the paying chain -- which is
  // what makes paying on Arc possible at all, since no public facilitator
  // settles Arc and the buyer cannot rely on one.
  let paymentHeaders: Record<string, string> | undefined;
  if (challenge.requiresPayment) {
    if (!signers.payment) {
      const offered = (challenge.accepts ?? [])
        .map((a) => (a as { networkName?: string; network?: string }).networkName ?? (a as { network?: string }).network)
        .filter(Boolean)
        .join(', ');
      throw new Error(
        `${config.baseUrl} charges for proofs and no payment wallet was given. ` +
        `Pass signers.payment (see walletFromPrivateKey / walletFromCdp / walletFromCircle). ` +
        `Chains offered: ${offered || 'none named'}`,
      );
    }
    t = Date.now();
    const paid = await signPayment(challenge as never, signers.payment, { network: params.payOn, maxPayment:params.maxPayment, approvedPayment:params.approvedPayment });
    paymentHeaders = paid.headers;
    recordStep(3.5, 'Sign Payment', { paidOn: paid.paidOn, amount: paid.amount, payer: paid.payer }, t);
  }

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
      paymentHeaders,
    });
    recordStep(4, 'Generate Proof (E2E Encrypted)', proveResponse, t);
  } else if (isOidc) {
    // OIDC plaintext path: send payload (JWT + JWKS) — server relays to prover, prover validates + builds inputs
    proveResponse = await submitProof(config, {
      circuit: params.circuit,
      inputs: oidcPayload! as unknown as Record<string, unknown>,
      nonce: challenge.nonce,
      paymentHeaders,
    });
    recordStep(4, 'Generate Proof (OIDC)', proveResponse, t);
  } else {
    // Coinbase plaintext path: send pre-computed inputs (TEE disabled / local dev)
    proveResponse = await submitProof(config, {
      circuit: params.circuit,
      inputs: easInputs!,
      nonce: challenge.nonce,
      paymentHeaders,
    });
    recordStep(4, 'Generate Proof', proveResponse, t);
  }

  return {
    circuit: proveResponse.circuit,
    proofType: proveResponse.proofType,
    proof: proveResponse.proof,
    publicInputs: proveResponse.publicInputs,
    proofWithInputs: proveResponse.proofWithInputs,
    attestation: proveResponse.attestation,
    timing: proveResponse.timing,
    verification: proveResponse.verification,
  };
}
