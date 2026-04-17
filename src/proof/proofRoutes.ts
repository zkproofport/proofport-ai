import { Router, type Request, type Response } from 'express';
import type { RedisClient } from '../redis/client.js';
import type { Config } from '../config/index.js';
import type { TeeProvider } from '../tee/types.js';
import type { CircuitId } from '../config/circuits.js';
import { verifyPaymentOnChain } from './paymentVerifier.js';
import { BbProver } from '../prover/bbProver.js';
import { hexToBytes } from '../input/inputBuilder.js';
import type { CircuitParams } from '../input/inputBuilder.js';
import { buildGuide } from './guideBuilder.js';
import { getVerifierAddress } from '../config/deployments.js';
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
  // OIDC Domain
  'oidc_domain': 'oidc_domain_attestation',
  'oidc_domain_attestation': 'oidc_domain_attestation',
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
  const isOidc = circuitId === 'oidc_domain_attestation';

  // ── Build structured inputs for the prover ──
  // Server is a BLIND RELAY: validates minimally, passes inputs as-is to TEE/bbProver.
  // TEE/bbProver builds Prover.toml from these inputs.

  let proverInputs: Record<string, any>;
  const inputBuildStart = Date.now();

  if (isOidc) {
    // OIDC: pass OidcProvePayload { jwt, jwks, scope, provider } — TEE/bbProver validates JWT + builds circuit inputs
    const oidc = inputs as { jwt?: string; jwks?: unknown; scope?: string };
    if (!oidc.jwt || !oidc.jwks || !oidc.scope) {
      res.status(400).json({ error: 'INVALID_REQUEST', message: 'Missing required OIDC fields: jwt, jwks, scope' });
      return;
    }
    proverInputs = inputs;
  } else {
    // Coinbase: validate and convert to CircuitParams — TEE/bbProver calls toProverToml()
    const cb = inputs as import('./types.js').CoinbaseProveInputs;
    if (!cb.signal_hash || !cb.nullifier || !cb.scope_bytes || !cb.merkle_root || !cb.user_address) {
      res.status(400).json({ error: 'INVALID_REQUEST', message: 'Missing required derived fields: signal_hash, nullifier, scope_bytes, merkle_root, user_address' });
      return;
    }

    if (circuitId === 'coinbase_country_attestation') {
      if (!cb.country_list || cb.country_list.length === 0) {
        res.status(400).json({ error: 'INVALID_REQUEST', message: 'country_list required for country circuit' });
        return;
      }
      if (typeof cb.is_included !== 'boolean') {
        res.status(400).json({ error: 'INVALID_REQUEST', message: 'is_included required for country circuit' });
        return;
      }
    }

    const rawTxBytes = hexToBytes(cb.raw_transaction);
    proverInputs = {
      signalHash: ethers.getBytes(cb.signal_hash),
      merkleRoot: cb.merkle_root,
      scopeBytes: ethers.getBytes(cb.scope_bytes),
      nullifierBytes: ethers.getBytes(cb.nullifier),
      userAddress: cb.user_address,
      userSignature: cb.signature,
      userPubkeyX: cb.user_pubkey_x,
      userPubkeyY: cb.user_pubkey_y,
      rawTxBytes: Array.from(rawTxBytes),
      txLength: cb.tx_length,
      attesterPubkeyX: cb.coinbase_attester_pubkey_x,
      attesterPubkeyY: cb.coinbase_attester_pubkey_y,
      merkleProof: cb.merkle_proof,
      merkleLeafIndex: cb.leaf_index,
      merkleDepth: cb.depth,
      ...(circuitId === 'coinbase_country_attestation' && {
        countryList: cb.country_list,
        countryListLength: (cb.country_list || []).length,
        isIncluded: cb.is_included,
      }),
    } satisfies CircuitParams;
  }

  const inputBuildMs = Date.now() - inputBuildStart;

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
      proverInputs,
      requestId,
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
      circuitsDir: config.circuitsDir,
    });
    const bbResult = await bbProver.prove(circuitId, proverInputs);
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

  // Derive proofType from circuit + provider
  let proofType: string = ctx.circuitId === 'coinbase_attestation' ? 'kyc'
    : ctx.circuitId === 'coinbase_country_attestation' ? 'country'
    : 'google_login';
  if (ctx.circuitId === 'oidc_domain_attestation') {
    const oidcInputs = ctx.inputs as { provider?: string };
    if (oidcInputs.provider === 'google') proofType = 'google_workspace';
    else if (oidcInputs.provider === 'microsoft') proofType = 'microsoft_365';
  }

  // Build response
  const response: ProveResponse = {
    circuit: ctx.circuitId,
    proofType,
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

  const isTestnet = config.paymentMode === 'testnet' || config.chainRpcUrl.includes('sepolia');
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

      // Check nonce header presence to distinguish first request (402) from retry (proof submission)
      const paymentTxHeader = (req.headers['x-payment-tx'] as string) ?? '';
      const paymentNonceHeader = (req.headers['x-payment-nonce'] as string) ?? '';
      const hasNonceHeader = !!paymentNonceHeader;

      if (!hasNonceHeader) {
        // No payment header — return 402 challenge.
        // Always generate a real nonce (even when disabled) for replay protection.
        const nonce = ethers.hexlify(ethers.randomBytes(32));

        // Store nonce in Redis with 5-min TTL (replay protection)
        await deps.redis.set(`x402:nonce:${nonce}`, circuitId, 'EX', 300);

        const isDisabled = config.paymentMode === 'disabled';
        const paymentRequirements = {
          scheme: 'exact',
          network,
          maxAmountRequired: isDisabled ? '0' : String(paymentAmount),
          resource: `${config.a2aBaseUrl}/api/v1/prove`,
          description: isDisabled ? 'Payment disabled — free proof generation' : `ZK proof generation fee (${priceStr} USDC)`,
          mimeType: 'application/json',
          payTo: isDisabled ? '' : config.paymentPayTo,
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
          message: isDisabled
            ? 'Payment disabled — send nonce back with X-Payment-Nonce to proceed'
            : 'Send payment and retry with X-Payment-TX and X-Payment-Nonce headers',
          nonce,
          requiresPayment: !isDisabled,
          payment: paymentRequirements,
          facilitatorUrl: isDisabled ? null : config.x402FacilitatorUrl,
          teePublicKey,
        });
        return;
      }

      // Payment headers present — validate nonce (always, for replay protection)
      log.info({ action: 'prove.x402.start', circuit: circuitId, paymentMode: config.paymentMode }, 'x402 proof request');

      let paymentVerifyMs = 0;

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

      // For plaintext flow, inputs are required
      if (!body.encrypted_payload && !body.inputs) {
        res.status(400).json({ error: 'INVALID_REQUEST', message: 'Missing inputs (or use encrypted_payload for E2E flow)' });
        return;
      }

      // In nitro mode, require E2E encryption — plaintext inputs are rejected
      if (config.teeMode === 'nitro' && !body.encrypted_payload) {
        res.status(400).json({ error: 'PLAINTEXT_REJECTED', message: 'TEE mode requires E2E encrypted payload. Fetch TEE public key from 402 response and encrypt inputs before submitting.' });
        return;
      }

      // On-chain payment verification (skip when payment disabled)
      if (config.paymentMode !== 'disabled') {
        const paymentStart = Date.now();
        const paymentResult = await verifyPaymentOnChain({
          txHash: paymentTxHeader,
          expectedRecipient: config.paymentPayTo,
          expectedNonce: paymentNonceHeader,
          expectedMinAmount: BigInt(paymentAmount),
          rpcUrl: config.chainRpcUrl,
          network,
        });
        paymentVerifyMs = Date.now() - paymentStart;

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
      } else {
        log.info({ action: 'prove.payment_skipped', circuit: circuitId }, 'Payment disabled, skipping on-chain verification');
      }

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

        const e2eChainId = isTestnet ? 11155111 : 1;
        const e2eVerifierAddress = getVerifierAddress(circuitId, String(e2eChainId)) || null;

        const e2eProofType: string = circuitId === 'coinbase_attestation' ? 'kyc'
          : circuitId === 'coinbase_country_attestation' ? 'country'
          : 'google_login';

        const response: ProveResponse = {
          circuit: circuitId,
          proofType: e2eProofType,
          proof,
          publicInputs,
          proofWithInputs,
          attestation,
          timing: {
            totalMs: Date.now() - startTime,
            paymentVerifyMs,
            proveMs,
          },
          verification: e2eVerifierAddress ? {
            chainId: e2eChainId,
            verifierAddress: e2eVerifierAddress,
            rpcUrl: config.ethereumRpcUrl || config.chainRpcUrl,
          } : null,
        };

        res.json(response);
        return;
      }

      const chainId = isTestnet ? 11155111 : 1;
      const verifierAddress = getVerifierAddress(circuitId, String(chainId)) || null;

      // ── Plaintext flow: client provides structured inputs, server relays to TEE/bbProver ──
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
