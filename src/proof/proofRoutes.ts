import { Router, type Request, type Response } from 'express';
import type { RedisClient } from '../redis/client.js';
import type { Config } from '../config/index.js';
import type { TeeProvider } from '../tee/types.js';
import type { CircuitId } from '../config/circuits.js';
import { verifyPaymentOnChain } from './paymentVerifier.js';
import { toProverToml } from '../prover/tomlBuilder.js';
import { BbProver } from '../prover/bbProver.js';
import { hexToBytes } from '../input/inputBuilder.js';
import type { CircuitParams } from '../input/inputBuilder.js';
import { buildGuide } from './guideBuilder.js';
import { VERIFIER_ADDRESSES } from '../config/contracts.js';
import { ethers } from 'ethers';
import { createLogger } from '../logger.js';
import { parseAttestationDocument, verifyAttestationDocument } from '../tee/attestation.js';
import type {
  ProveRequest,
  ProveResponse,
} from './types.js';

const log = createLogger('ProofRoutes');

// Map client-friendly circuit names to canonical IDs
const CIRCUIT_MAP: Record<string, CircuitId> = {
  'coinbase_kyc': 'coinbase_attestation',
  'coinbase_country': 'coinbase_country_attestation',
  // Also accept canonical IDs directly
  'coinbase_attestation': 'coinbase_attestation',
  'coinbase_country_attestation': 'coinbase_country_attestation',
};

export interface ProofRoutesDeps {
  redis: RedisClient;
  config: Config;
  teeProvider?: TeeProvider;
}

/** Shared context for proof generation */
interface ProveContext {
  circuitId: CircuitId;
  inputs: NonNullable<ProveRequest['inputs']>;
  paymentTxHash: string;
  paymentVerifyMs: number;
  startTime: number;
  requestId: string;
  chainId: number;
  verifierAddress: string | null;
  chainRpcUrl: string;
}

/**
 * Core proof generation logic shared between session-based and x402 single-step flows.
 * Validates inputs, builds circuit params, runs prover, and sends the response.
 */
async function generateProofFromInputs(
  ctx: ProveContext,
  deps: ProofRoutesDeps,
  config: Config,
  res: Response,
): Promise<void> {
  const { circuitId, inputs, paymentVerifyMs, startTime, requestId } = ctx;

  // Validate required client-computed fields
  if (!inputs.signal_hash || !inputs.nullifier || !inputs.scope_bytes || !inputs.merkle_root || !inputs.user_address) {
    res.status(400).json({ error: 'INVALID_REQUEST', message: 'Missing required derived fields: signal_hash, nullifier, scope_bytes, merkle_root, user_address' });
    return;
  }

  // Country circuit validation
  if (circuitId === 'coinbase_country_attestation') {
    if (!inputs.country_list || inputs.country_list.length === 0) {
      res.status(400).json({ error: 'INVALID_REQUEST', message: 'country_list required for country circuit' });
      return;
    }
    if (typeof inputs.is_included !== 'boolean') {
      res.status(400).json({ error: 'INVALID_REQUEST', message: 'is_included required for country circuit' });
      return;
    }
  }

  // ALL values come from client -- server does ZERO computation
  const inputBuildStart = Date.now();
  const rawTxBytes = hexToBytes(inputs.raw_transaction);

  const circuitParams: CircuitParams = {
    signalHash: ethers.getBytes(inputs.signal_hash),
    merkleRoot: inputs.merkle_root,
    scopeBytes: ethers.getBytes(inputs.scope_bytes),
    nullifierBytes: ethers.getBytes(inputs.nullifier),
    userAddress: inputs.user_address,
    userSignature: inputs.signature,
    userPubkeyX: inputs.user_pubkey_x,
    userPubkeyY: inputs.user_pubkey_y,
    rawTxBytes: Array.from(rawTxBytes),
    txLength: inputs.tx_length,
    attesterPubkeyX: inputs.coinbase_attester_pubkey_x,
    attesterPubkeyY: inputs.coinbase_attester_pubkey_y,
    merkleProof: inputs.merkle_proof,
    merkleLeafIndex: inputs.leaf_index,
    merkleDepth: inputs.depth,
    ...(circuitId === 'coinbase_country_attestation' && {
      countryList: inputs.country_list,
      countryListLength: (inputs.country_list || []).length,
      isIncluded: inputs.is_included,
    }),
  };

  const inputBuildMs = Date.now() - inputBuildStart;

  // Build proverToml
  const proverToml = toProverToml(circuitId, circuitParams);

  // Generate proof via TEE or BbProver
  const proveStart = Date.now();
  let proof: string;
  let publicInputs: string;
  let proofWithInputs: string;
  let attestationDoc: string | undefined;

  const teeMode = config.teeMode || 'disabled';

  log.info({ action: 'prove.generate.start', requestId, circuit: circuitId, teeMode, encrypted: false }, 'Proof generation started (plaintext)');

  if (teeMode === 'nitro' && deps.teeProvider) {
    const vsockResponse = await deps.teeProvider.prove(
      circuitId,
      [],
      requestId,
      proverToml,
    );

    if (vsockResponse.type === 'error') {
      throw new Error(`TEE proof generation failed: ${vsockResponse.error}`);
    }

    proof = vsockResponse.proof || '';
    publicInputs = Array.isArray(vsockResponse.publicInputs) ? vsockResponse.publicInputs[0] || '' : '';
    proofWithInputs = proof + (publicInputs.startsWith('0x') ? publicInputs.slice(2) : publicInputs);
    attestationDoc = vsockResponse.attestationDocument;
  } else {
    const bbProver = new BbProver({
      bbPath: config.bbPath,
      nargoPath: config.nargoPath,
      circuitsDir: config.circuitsDir,
    });
    const bbResult = await bbProver.prove(circuitId, circuitParams);
    proof = bbResult.proof;
    publicInputs = bbResult.publicInputs;
    proofWithInputs = bbResult.proofWithInputs;
  }

  const proveMs = Date.now() - proveStart;
  log.info({ action: 'prove.generate.complete', requestId, circuit: circuitId, teeMode, encrypted: false, proveMs, proofSize: proof.length }, 'Proof generation complete (plaintext)');

  // Build attestation info
  let attestation: ProveResponse['attestation'] = null;
  if (attestationDoc) {
    try {
      const parsedDoc = parseAttestationDocument(attestationDoc);
      const verification = await verifyAttestationDocument(parsedDoc);
      attestation = {
        document: attestationDoc,
        proof_hash: ethers.keccak256(proof),
        verification: {
          rootCaValid: verification.rootCaValid ?? false,
          chainValid: verification.chainValid ?? false,
          signatureValid: verification.signatureValid ?? false,
          pcrs: Object.fromEntries(
            Array.from(parsedDoc.pcrs.entries()).map(([k, v]) => [k, ethers.hexlify(v)])
          ),
        },
      };
    } catch (e: unknown) {
      log.warn({ action: 'prove.attestation.parse_error', err: e }, 'Failed to parse attestation');
    }
  }

  // Build response
  const response: ProveResponse = {
    proof,
    publicInputs,
    proofWithInputs,
    attestation,
    timing: {
      totalMs: Date.now() - startTime,
      paymentVerifyMs,
      inputBuildMs,
      proveMs,
    },
    verification: ctx.verifierAddress ? {
      chainId: ctx.chainId,
      verifierAddress: ctx.verifierAddress,
      rpcUrl: ctx.chainRpcUrl,
    } : null,
  };

  res.json(response);
}

export function createProofRoutes(deps: ProofRoutesDeps): Router {
  const router = Router();
  const { config } = deps;

  const isTestnet = config.paymentMode === 'testnet';
  const network: 'base-sepolia' | 'base' = isTestnet ? 'base-sepolia' : 'base';
  const usdcAddress = isTestnet
    ? '0x036CbD53842c5426634e7929541eC2318f3dCF7e'
    : '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
  const priceStr = (config.paymentProofPrice || '$0.10').replace('$', '');
  const paymentAmount = Math.round(parseFloat(priceStr) * 1_000_000);

  // POST /prove -- Atomic: verify payment + generate proof (x402 single-step flow)
  // Body: circuit + inputs. Payment via X-Payment-TX / X-Payment-Nonce headers.
  // No session_id or payment_tx_hash in body.
  router.post('/prove', async (req: Request, res: Response) => {
    const startTime = Date.now();
    try {
      const body = req.body as ProveRequest;

      // Log verified agent identity if present
      if (req.agentIdentity?.verified) {
        log.info({
          action: 'prove.agent_verified',
          agent: req.agentIdentity.address,
          tokenId: req.agentIdentity.tokenId?.toString(),
          registeredOnChain: req.agentIdentity.registeredOnChain,
        }, 'Verified agent requesting proof');
      }

      // Determine circuit from body
      const circuitName = body.circuit;
      if (!circuitName) {
        res.status(400).json({ error: 'INVALID_REQUEST', message: 'circuit is required' });
        return;
      }
      const circuitId = CIRCUIT_MAP[circuitName];
      if (!circuitId) {
        res.status(400).json({ error: 'INVALID_CIRCUIT', message: `Unknown circuit: ${circuitName}. Valid: ${Object.keys(CIRCUIT_MAP).join(', ')}` });
        return;
      }

      // Check for payment in header
      const paymentTxHeader = (req.headers['x-payment-tx'] as string) || '';
      const paymentNonceHeader = (req.headers['x-payment-nonce'] as string) || '';

      if (!paymentTxHeader) {
        // No payment yet — return 402 with payment requirements
        const nonce = ethers.hexlify(ethers.randomBytes(32));

        // Store nonce in Redis with 5-min TTL (replay protection)
        await deps.redis.set(`x402:nonce:${nonce}`, circuitId, 'EX', 300);

        const paymentRequirements = {
          scheme: 'exact',
          network,
          maxAmountRequired: String(paymentAmount),
          resource: `${config.a2aBaseUrl}/api/v1/prove`,
          description: `ZK proof generation fee (${priceStr} USDC)`,
          mimeType: 'application/json',
          payTo: config.paymentPayTo,
          asset: usdcAddress,
          extra: {
            name: network === 'base-sepolia' ? 'USDC' : 'USD Coin',
            version: '2',
            nonce,
          },
        };

        // Fetch TEE public key for E2E encryption (if TEE is available)
        let teePublicKey: { publicKey: string; keyId: string; attestationDocument: string | null } | null = null;
        if (deps.teeProvider && config.teeMode === 'nitro') {
          try {
            const teeKeyInfo = await deps.teeProvider.getTeePublicKey();
            if (teeKeyInfo) {
              teePublicKey = {
                publicKey: teeKeyInfo.publicKey,
                keyId: teeKeyInfo.keyId,
                attestationDocument: teeKeyInfo.attestationDocument || null,
              };
            }
          } catch (e) {
            log.warn({ action: 'prove.tee_key.error', err: e }, 'Failed to fetch TEE public key for 402 response');
          }
        }

        res.setHeader('PAYMENT-REQUIRED', Buffer.from(JSON.stringify(paymentRequirements)).toString('base64'));
        res.status(402).json({
          error: 'PAYMENT_REQUIRED',
          message: 'Send payment and retry with X-Payment-TX and X-Payment-Nonce headers',
          nonce,
          payment: paymentRequirements,
          teePublicKey,
        });
        return;
      }

      // For plaintext flow, inputs are required (only checked when payment header present)
      if (!body.encrypted_payload && !body.inputs) {
        res.status(400).json({ error: 'INVALID_REQUEST', message: 'Missing inputs (or use encrypted_payload for E2E flow)' });
        return;
      }

      // In nitro mode, require E2E encryption — plaintext inputs are rejected
      if (config.teeMode === 'nitro' && !body.encrypted_payload) {
        res.status(400).json({ error: 'PLAINTEXT_REJECTED', message: 'TEE mode requires E2E encrypted payload. Fetch TEE public key from 402 response and encrypt inputs before submitting.' });
        return;
      }

      // Has payment header — validate nonce, verify payment, generate proof
      log.info({ action: 'prove.x402.start', circuit: circuitId }, 'x402 proof request');

      if (!paymentNonceHeader) {
        res.status(400).json({ error: 'MISSING_NONCE', message: 'X-Payment-Nonce header required with X-Payment-TX' });
        return;
      }

      // Atomically read and consume nonce (GETDEL prevents TOCTOU race)
      const storedCircuit = await deps.redis.getdel(`x402:nonce:${paymentNonceHeader}`);
      if (!storedCircuit) {
        res.status(400).json({ error: 'INVALID_NONCE', message: 'Nonce not found or expired. Request a new 402 challenge.' });
        return;
      }

      // Verify nonce was issued for the same circuit
      if (storedCircuit !== circuitId) {
        res.status(400).json({ error: 'NONCE_CIRCUIT_MISMATCH', message: `Nonce was issued for ${storedCircuit}, not ${circuitId}` });
        return;
      }

      const paymentStart = Date.now();
      const paymentResult = await verifyPaymentOnChain({
        txHash: paymentTxHeader,
        expectedRecipient: config.paymentPayTo,
        expectedNonce: paymentNonceHeader,
        expectedMinAmount: BigInt(paymentAmount),
        rpcUrl: config.chainRpcUrl,
        network,
      });
      const paymentVerifyMs = Date.now() - paymentStart;

      if (!paymentResult.valid) {
        log.warn({ action: 'prove.x402.payment_invalid', reason: paymentResult.reason, txHash: paymentTxHeader }, 'x402 payment invalid');
        res.status(402).json({
          error: 'PAYMENT_INVALID',
          reason: paymentResult.reason,
          message: paymentResult.error,
        });
        return;
      }

      log.info({ action: 'prove.x402.payment_verified', txHash: paymentTxHeader, paymentVerifyMs }, 'x402 payment verified');

      const requestId = `x402-${ethers.hexlify(ethers.randomBytes(8)).slice(2)}`;

      // Check for E2E encrypted payload — server acts as blind relay
      if (body.encrypted_payload) {
        log.info({ action: 'prove.generate.start', requestId, circuit: circuitId, teeMode: config.teeMode, encrypted: true, keyId: body.encrypted_payload.keyId }, 'Proof generation started (E2E encrypted)');

        if (!deps.teeProvider || config.teeMode !== 'nitro') {
          res.status(400).json({ error: 'E2E_REQUIRES_TEE', message: 'E2E encrypted proofs require TEE mode (nitro)' });
          return;
        }

        const proveStart = Date.now();
        const vsockResponse = await deps.teeProvider.proveEncrypted(body.encrypted_payload, requestId);

        if (vsockResponse.type === 'error') {
          // Handle key rotation
          if (vsockResponse.error?.includes('Key ID mismatch')) {
            res.status(409).json({ error: 'KEY_ROTATED', message: 'TEE key has rotated. Fetch new public key from GET /api/v1/tee/public-key and re-encrypt.' });
            return;
          }
          throw new Error(`TEE proof generation failed: ${vsockResponse.error}`);
        }

        const proof = vsockResponse.proof || '';
        const publicInputs = Array.isArray(vsockResponse.publicInputs) ? vsockResponse.publicInputs[0] || '' : '';
        const proofWithInputs = proof + (publicInputs.startsWith('0x') ? publicInputs.slice(2) : publicInputs);
        const attestationDoc = vsockResponse.attestationDocument;
        const proveMs = Date.now() - proveStart;
        log.info({ action: 'prove.generate.complete', requestId, circuit: circuitId, teeMode: config.teeMode, encrypted: true, proveMs, proofSize: proof.length }, 'Proof generation complete (E2E encrypted)');

        // Build attestation info
        let attestation: ProveResponse['attestation'] = null;
        if (attestationDoc) {
          try {
            const parsedDoc = parseAttestationDocument(attestationDoc);
            const verification = await verifyAttestationDocument(parsedDoc);
            attestation = {
              document: attestationDoc,
              proof_hash: ethers.keccak256(proof),
              verification: {
                rootCaValid: verification.rootCaValid ?? false,
                chainValid: verification.chainValid ?? false,
                signatureValid: verification.signatureValid ?? false,
                pcrs: Object.fromEntries(
                  Array.from(parsedDoc.pcrs.entries()).map(([k, v]) => [k, ethers.hexlify(v)])
                ),
              },
            };
          } catch (e: unknown) {
            log.warn({ action: 'prove.attestation.parse_error', err: e }, 'Failed to parse attestation');
          }
        }

        const response: ProveResponse = {
          proof,
          publicInputs,
          proofWithInputs,
          attestation,
          timing: {
            totalMs: Date.now() - startTime,
            paymentVerifyMs,
            proveMs,
          },
          verification: null,  // E2E mode: server doesn't know the circuit, can't provide verifier address
        };

        res.json(response);
        return;
      }

      const chainId = isTestnet ? 84532 : 8453;
      const verifierAddress = VERIFIER_ADDRESSES[String(chainId)]?.[circuitId] || null;
      await generateProofFromInputs(
        {
          circuitId,
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
          inputs: body.inputs!, // guarded above: non-encrypted path requires inputs
          paymentTxHash: paymentTxHeader,
          paymentVerifyMs,
          startTime,
          requestId,
          chainId,
          verifierAddress,
          chainRpcUrl: config.chainRpcUrl,
        },
        deps,
        config,
        res,
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      log.error({ action: 'prove.error', err: error }, 'Proof generation failed');
      res.status(500).json({
        error: 'PROVE_FAILED',
        message,
        stage: message.includes('nargo') ? 'nargo' : message.includes('bb') ? 'bb' : 'validation',
      });
    }
  });

  // GET /guide/:circuit -- Comprehensive guide for client AI agents
  router.get('/guide/:circuit', (req: Request, res: Response) => {
    const circuit = req.params.circuit;
    const circuitId = CIRCUIT_MAP[circuit];
    if (!circuitId) {
      res.status(404).json({ error: 'UNKNOWN_CIRCUIT', message: `Unknown circuit: ${circuit}. Valid: ${Object.keys(CIRCUIT_MAP).join(', ')}` });
      return;
    }
    const guide = buildGuide(circuitId, config);
    res.json(guide);
  });

  return router;
}
