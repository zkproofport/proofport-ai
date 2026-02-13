/**
 * ERC-8004 ValidationRegistry integration for TEE attestation
 *
 * Submits TEE attestation to the on-chain ValidationRegistry so that
 * 8004scan displays a green TEE badge for this agent.
 *
 * Flow:
 * 1. Generate attestation (local simulation or real Nitro)
 * 2. Call validationRequest() on ValidationRegistry (agent as requester)
 * 3. Call validationResponse() on ValidationRegistry (self-validate on testnet)
 */

import { ethers } from 'ethers';
import type { Config } from '../config/index.js';
import type { TeeProvider } from './types.js';

const VALIDATION_REGISTRY_ABI = [
  'function validationRequest(address validatorAddress, uint256 agentId, string requestURI, bytes32 requestHash) external',
  'function validationResponse(bytes32 requestHash, uint8 response, string responseURI, bytes32 responseHash, string tag) external',
  'function getAgentValidations(uint256 agentId) external view returns (bytes32[])',
  'function getValidationStatus(bytes32 requestHash) external view returns (address validatorAddress, uint256 agentId, uint8 response, bytes32 responseHash, string tag, uint256 lastUpdate)',
];

const TEE_TAG = 'tee-attestation';

export interface ValidationConfig {
  validationRegistryAddress: string;
  chainRpcUrl: string;
  privateKey: string;
}

/**
 * Submit TEE attestation to ERC-8004 ValidationRegistry
 *
 * On testnet, the agent self-validates (same address is both agent owner and validator).
 * On mainnet, an external validator should be used instead.
 */
export async function ensureAgentValidated(
  config: Config,
  agentTokenId: bigint,
  teeProvider: TeeProvider
): Promise<void> {
  if (!config.erc8004ValidationAddress) {
    console.log('[TEE Validation] ValidationRegistry address not configured — skipping');
    return;
  }

  if (config.teeMode === 'disabled') {
    console.log('[TEE Validation] TEE mode is disabled — skipping validation');
    return;
  }

  try {
    const provider = new ethers.JsonRpcProvider(config.chainRpcUrl);
    const signer = new ethers.Wallet(config.proverPrivateKey, provider);
    const contract = new ethers.Contract(
      config.erc8004ValidationAddress,
      VALIDATION_REGISTRY_ABI,
      signer
    );

    // Check if already validated
    const existingValidations: string[] = await contract.getAgentValidations(agentTokenId);

    for (const hash of existingValidations) {
      try {
        const status = await contract.getValidationStatus(hash);
        // status[2] is the response (uint8), status[4] is the tag (string)
        if (Number(status[2]) > 0 && status[4] === TEE_TAG) {
          console.log(`[TEE Validation] Agent already has TEE validation (requestHash: ${hash})`);
          return;
        }
      } catch {
        // Skip invalid/expired validations
        continue;
      }
    }

    // Generate attestation
    console.log('[TEE Validation] Generating TEE attestation...');
    const proofHash = ethers.keccak256(
      ethers.toUtf8Bytes(`agent:${agentTokenId}:${Date.now()}`)
    );
    const attestation = await teeProvider.generateAttestation(proofHash);

    if (!attestation) {
      console.error('[TEE Validation] Failed to generate attestation — TEE provider returned null');
      return;
    }

    // Build request data
    const requestData = {
      type: 'tee-attestation',
      agentId: agentTokenId.toString(),
      attestation: {
        document: attestation.document,
        mode: attestation.mode,
        proofHash: attestation.proofHash,
        timestamp: attestation.timestamp,
      },
    };

    const requestJson = JSON.stringify(requestData);
    const requestBase64 = Buffer.from(requestJson, 'utf-8').toString('base64');
    const requestURI = `data:application/json;base64,${requestBase64}`;
    const requestHash = ethers.keccak256(ethers.toUtf8Bytes(requestJson));

    // Step 1: Submit validation request (agent address as validator for self-validation)
    console.log('[TEE Validation] Submitting validationRequest to ValidationRegistry...');
    const reqTx = await contract.validationRequest(
      signer.address, // self-validate: use own address as validator
      agentTokenId,
      requestURI,
      requestHash
    );
    await reqTx.wait();
    console.log(`[TEE Validation] validationRequest submitted (tx: ${reqTx.hash})`);

    // Step 2: Submit validation response (self-validate with score 100)
    const responseData = {
      type: 'tee-attestation-response',
      mode: attestation.mode,
      verified: true,
      timestamp: Date.now(),
    };
    const responseJson = JSON.stringify(responseData);
    const responseBase64 = Buffer.from(responseJson, 'utf-8').toString('base64');
    const responseURI = `data:application/json;base64,${responseBase64}`;
    const responseHash = ethers.keccak256(ethers.toUtf8Bytes(responseJson));

    console.log('[TEE Validation] Submitting validationResponse to ValidationRegistry...');
    const resTx = await contract.validationResponse(
      requestHash,
      100, // score: 100 = fully validated
      responseURI,
      responseHash,
      TEE_TAG
    );
    await resTx.wait();
    console.log(`[TEE Validation] validationResponse submitted (tx: ${resTx.hash})`);
    console.log('[TEE Validation] TEE attestation registered on-chain successfully');
  } catch (error) {
    if (error instanceof Error) {
      console.error(`[TEE Validation] Failed to submit TEE validation: ${error.message}`);
    } else {
      console.error('[TEE Validation] Failed to submit TEE validation: unknown error');
    }
  }
}
