/**
 * skillHandler.ts — Unified canonical logic for all 6 agent skills.
 *
 * This is the SINGLE SOURCE OF TRUTH for all tool/skill logic in proofport-ai.
 * All 4 protocol adapters call into these functions:
 *   - chat/chatHandler.ts  (LLM tool calls)
 *   - mcp/server.ts        (MCP tool calls)
 *   - a2a/taskWorker.ts    (A2A task processing)
 *   - api/restRoutes.ts    (REST API)
 *
 * Rules:
 *   - NO hardcoded fallbacks or default values for required params
 *   - NO log truncation (log full values)
 *   - All errors are descriptive with guidance for the caller
 *   - Redis key prefix: "signing:" (backward compatible)
 */

import { randomUUID } from 'crypto';
import { ethers } from 'ethers';
import { createLogger } from '../logger.js';

const log = createLogger('Skill');
import { CIRCUITS, type CircuitId } from '../config/circuits.js';
import { VERIFIER_ADDRESSES } from '../config/contracts.js';
import type { ProofRequestRecord } from '../signing/types.js';
import type { RedisClient } from '../redis/client.js';
import type { RateLimiter } from '../redis/rateLimiter.js';
import type { ProofCache } from '../redis/proofCache.js';
import type { TeeProvider } from '../tee/types.js';
import { BbProver } from '../prover/bbProver.js';
import { computeCircuitParams } from '../input/inputBuilder.js';
import { toProverToml } from '../prover/tomlBuilder.js';
import { storeProofResult, getProofResult } from '../redis/proofResultStore.js';

// ─── Dependencies ─────────────────────────────────────────────────────────────

/** Shared dependencies injected into all skill handlers. */
export interface SkillDeps {
  redis: RedisClient;
  /** Base URL for sign/pay pages (e.g., "https://ai.zkproofport.app" or "http://localhost:4002") */
  signPageUrl: string;
  /** TTL for signing session records in seconds (e.g., 300) */
  signingTtlSeconds: number;
  /** Payment mode: disabled skips payment, testnet/mainnet require it */
  paymentMode: 'disabled' | 'testnet' | 'mainnet';
  /** Human-readable proof price (e.g., "$0.10") */
  paymentProofPrice: string;
  /** EAS GraphQL endpoint for attestation fetching */
  easGraphqlEndpoint: string;
  /** RPC URLs for Base chain (attestation TX fetching) */
  rpcUrls: string[];
  /** Path to bb binary */
  bbPath: string;
  /** Path to nargo binary */
  nargoPath: string;
  /** Path to compiled circuit artifacts directory */
  circuitsDir: string;
  /** RPC URL for on-chain verification (verifier contract calls) */
  chainRpcUrl: string;
  /** Optional rate limiter (per-address) */
  rateLimiter?: RateLimiter;
  /** Optional proof cache */
  proofCache?: ProofCache;
  /** Optional TEE provider for enclave-based proof generation */
  teeProvider?: TeeProvider;
  /** TEE mode: 'disabled' | 'local' | 'nitro' */
  teeMode: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function signingKey(requestId: string): string {
  return `signing:${requestId}`;
}

async function getRecord(
  redis: RedisClient,
  requestId: string,
): Promise<ProofRequestRecord | null> {
  const data = await redis.get(signingKey(requestId));
  if (!data) return null;
  return JSON.parse(data) as ProofRequestRecord;
}

async function saveRecord(
  redis: RedisClient,
  record: ProofRequestRecord,
  ttlSeconds: number,
): Promise<void> {
  await redis.set(signingKey(record.id), JSON.stringify(record), 'EX', ttlSeconds);
}

/**
 * Normalize publicInputs from a single hex string to an array of 32-byte chunks.
 * If already an array, returns as-is.
 */
function normalizePublicInputs(raw: string | string[]): string[] {
  if (Array.isArray(raw)) return raw;
  const hex = raw.startsWith('0x') ? raw.slice(2) : raw;
  const chunks: string[] = [];
  for (let i = 0; i < hex.length; i += 64) {
    chunks.push('0x' + hex.slice(i, i + 64).padEnd(64, '0'));
  }
  return chunks;
}

/**
 * Build a Basescan transaction URL based on payment mode.
 * testnet → sepolia.basescan.org, mainnet → basescan.org
 */
function getBasescanTxUrl(paymentMode: string, txHash: string): string {
  return paymentMode === 'mainnet'
    ? `https://basescan.org/tx/${txHash}`
    : `https://sepolia.basescan.org/tx/${txHash}`;
}

/**
 * Build a Basescan address URL based on chain ID.
 * 8453 (Base) → basescan.org, default (84532 Base Sepolia) → sepolia.basescan.org
 */
function getBasescanAddressUrl(chainId: string, address: string): string {
  return chainId === '8453'
    ? `https://basescan.org/address/${address}`
    : `https://sepolia.basescan.org/address/${address}`;
}

// ─── Skill 1: request_signing ─────────────────────────────────────────────────

/** Parameters for requesting a new signing session. */
export interface RequestSigningParams {
  circuitId: string;
  scope: string;
  countryList?: string[];
  isIncluded?: boolean;
}

/** Result of creating a signing session. */
export interface RequestSigningResult {
  requestId: string;
  signingUrl: string;
  expiresAt: string;
  circuitId: string;
  scope: string;
}

/**
 * Create a new proof signing session.
 *
 * Validates circuit parameters, stores a ProofRequestRecord in Redis,
 * and returns a signing URL for the user to connect their wallet.
 *
 * @throws Error if circuitId is unknown, scope is empty, or country fields
 *         are missing for coinbase_country_attestation
 */
export async function handleRequestSigning(
  params: RequestSigningParams,
  deps: SkillDeps,
): Promise<RequestSigningResult> {
  const { circuitId, scope, countryList, isIncluded } = params;

  // Validate circuitId
  if (!circuitId) {
    throw new Error('circuitId is required. Use get_supported_circuits to see available circuits.');
  }
  if (!(circuitId in CIRCUITS)) {
    throw new Error(
      `Unknown circuit: "${circuitId}". Supported circuits: ${Object.keys(CIRCUITS).join(', ')}. Use get_supported_circuits for details.`,
    );
  }

  // Validate scope
  if (!scope || scope.trim().length === 0) {
    throw new Error('scope is required and must be a non-empty string. It defines the privacy domain for nullifier computation.');
  }

  // Validate country-specific fields
  if (circuitId === 'coinbase_country_attestation') {
    if (!countryList || countryList.length === 0) {
      throw new Error(
        'countryList is required for coinbase_country_attestation and must be a non-empty array of 2-letter country codes (e.g., ["US", "CA"]).',
      );
    }
    if (typeof isIncluded !== 'boolean') {
      throw new Error(
        'isIncluded is required for coinbase_country_attestation and must be a boolean. true = prove membership in countryList, false = prove exclusion.',
      );
    }
  }

  // Validate signPageUrl
  if (!deps.signPageUrl) {
    throw new Error('Web signing not configured. Set SIGN_PAGE_URL environment variable.');
  }

  const requestId = randomUUID();
  const expiresAt = new Date(Date.now() + deps.signingTtlSeconds * 1000).toISOString();

  const record: ProofRequestRecord = {
    id: requestId,
    scope,
    circuitId,
    status: 'pending',
    createdAt: new Date().toISOString(),
    expiresAt,
    ...(countryList !== undefined && { countryList }),
    ...(isIncluded !== undefined && { isIncluded }),
  };

  await deps.redis.set(
    signingKey(requestId),
    JSON.stringify(record),
    'EX',
    deps.signingTtlSeconds,
  );

  const signingUrl = deps.signPageUrl.replace(/\/$/, '') + '/s/' + requestId;

  log.info({ requestId, circuitId, scope, expiresAt }, 'Created signing session');

  return {
    requestId,
    signingUrl,
    expiresAt,
    circuitId,
    scope,
  };
}

// ─── Skill 2: check_status ───────────────────────────────────────────────────

/** Parameters for checking signing/payment status. */
export interface CheckStatusParams {
  requestId: string;
}

/** Result of a status check. */
export interface CheckStatusResult {
  requestId: string;
  phase: 'signing' | 'payment' | 'ready' | 'expired';
  signing: {
    status: 'pending' | 'completed';
    address?: string;
  };
  payment: {
    status: 'not_required' | 'pending' | 'completed';
    paymentUrl?: string;
    txHash?: string;
    paymentReceiptUrl?: string;
  };
  circuitId?: string;
  verifierAddress?: string;
  verifierExplorerUrl?: string;
  expiresAt: string;
}

/**
 * Check the current status of a signing/payment session.
 *
 * Returns the phase (signing -> payment -> ready) and details about
 * signing and payment sub-states.
 *
 * @throws Error if requestId is empty or the session is not found/expired
 */
export async function handleCheckStatus(
  params: CheckStatusParams,
  deps: SkillDeps,
): Promise<CheckStatusResult> {
  const { requestId } = params;

  if (!requestId || requestId.trim().length === 0) {
    throw new Error('requestId is required. Provide the requestId from request_signing.');
  }

  const record = await getRecord(deps.redis, requestId);

  if (!record) {
    throw new Error(
      'Request not found or expired. Create a new request with request_signing.',
    );
  }

  // Check wall-clock expiry
  if (new Date(record.expiresAt) < new Date()) {
    return {
      requestId,
      phase: 'expired',
      signing: { status: record.status === 'completed' ? 'completed' : 'pending' },
      payment: { status: 'not_required' },
      expiresAt: record.expiresAt,
    };
  }

  // Compute signing status
  const signingStatus: CheckStatusResult['signing'] =
    record.status === 'completed'
      ? { status: 'completed', address: record.address }
      : { status: 'pending' };

  // Compute payment status
  let paymentStatus: CheckStatusResult['payment'];
  if (deps.paymentMode === 'disabled') {
    paymentStatus = { status: 'not_required' };
  } else if (record.paymentStatus === 'completed') {
    paymentStatus = {
      status: 'completed',
      txHash: record.paymentTxHash,
      ...(record.paymentTxHash && { paymentReceiptUrl: getBasescanTxUrl(deps.paymentMode, record.paymentTxHash) }),
    };
  } else {
    paymentStatus = {
      status: 'pending',
      paymentUrl: deps.signPageUrl.replace(/\/$/, '') + '/pay/' + requestId,
    };
  }

  // Compute phase
  let phase: CheckStatusResult['phase'];
  if (record.status !== 'completed') {
    phase = 'signing';
  } else if (deps.paymentMode !== 'disabled' && record.paymentStatus !== 'completed') {
    phase = 'payment';
  } else {
    phase = 'ready';
  }

  // Include verifier info when phase is ready
  let verifierInfo: { circuitId: string; verifierAddress: string; verifierExplorerUrl: string } | undefined;
  if (phase === 'ready') {
    const defaultChainId = '84532';
    const addr = VERIFIER_ADDRESSES[defaultChainId]?.[record.circuitId];
    if (addr) {
      verifierInfo = {
        circuitId: record.circuitId,
        verifierAddress: addr,
        verifierExplorerUrl: getBasescanAddressUrl(defaultChainId, addr),
      };
    }
  }

  return {
    requestId,
    phase,
    signing: signingStatus,
    payment: paymentStatus,
    ...(verifierInfo && verifierInfo),
    expiresAt: record.expiresAt,
  };
}

// ─── Skill 3: request_payment ────────────────────────────────────────────────

/** Parameters for requesting payment. */
export interface RequestPaymentParams {
  requestId: string;
}

/** Result of a payment request. */
export interface RequestPaymentResult {
  requestId: string;
  paymentUrl: string;
  amount: string;
  currency: string;
  network: string;
}

/**
 * Initiate USDC payment for a proof generation session.
 *
 * Requires signing to be completed first. Returns a payment URL where the user
 * can sign an EIP-712 TransferWithAuthorization (no gas needed).
 *
 * @throws Error if payment is disabled, signing is not complete, or payment already done
 */
export async function handleRequestPayment(
  params: RequestPaymentParams,
  deps: SkillDeps,
): Promise<RequestPaymentResult> {
  const { requestId } = params;

  if (!requestId || requestId.trim().length === 0) {
    throw new Error('requestId is required. Provide the requestId from request_signing.');
  }

  const key = signingKey(requestId);
  const record = await getRecord(deps.redis, requestId);

  if (!record) {
    throw new Error(
      'Request not found or expired. Create a new request with request_signing.',
    );
  }

  if (deps.paymentMode === 'disabled') {
    throw new Error(
      'Payment is not required (payment mode is disabled). Proceed directly to generate_proof.',
    );
  }

  if (record.status !== 'completed') {
    throw new Error(
      `Signing must be completed before requesting payment. Current signing status: ${record.status}. Ask the user to complete signing first.`,
    );
  }

  if (record.paymentStatus === 'completed') {
    throw new Error(
      'Payment already completed. Proceed to generate_proof.',
    );
  }

  // Set payment status to pending if not already set (idempotent)
  if (!record.paymentStatus) {
    record.paymentStatus = 'pending';
    const ttl = await deps.redis.ttl(key);
    await saveRecord(deps.redis, record, ttl > 0 ? ttl : deps.signingTtlSeconds);
  }

  const paymentUrl = deps.signPageUrl.replace(/\/$/, '') + '/pay/' + requestId;
  const network = deps.paymentMode === 'testnet' ? 'Base Sepolia' : 'Base';

  log.info({ requestId, network, amount: deps.paymentProofPrice }, 'Payment initiated');

  return {
    requestId,
    paymentUrl,
    amount: deps.paymentProofPrice,
    currency: 'USDC',
    network,
  };
}

// ─── Skill 4: generate_proof ─────────────────────────────────────────────────

/** Parameters for proof generation (two modes: session or direct). */
export interface GenerateProofParams {
  /** Session flow: requestId from a completed signing+payment session. */
  requestId?: string;
  /** Direct flow: wallet address. */
  address?: string;
  /** Direct flow: wallet signature. */
  signature?: string;
  /** Direct flow: scope string. */
  scope?: string;
  /** Direct flow: circuit identifier. */
  circuitId?: string;
  /** Country list for coinbase_country_attestation. */
  countryList?: string[];
  /** Inclusion flag for coinbase_country_attestation. */
  isIncluded?: boolean;
}

/** Result of proof generation. */
export interface GenerateProofResult {
  proof: string;
  publicInputs: string;
  nullifier: string;
  signalHash: string;
  proofId: string;
  verifyUrl: string;
  cached?: boolean;
  attestation?: Record<string, unknown>;
  attestationUrl?: string;
  paymentTxHash?: string;
  paymentReceiptUrl?: string;
  verifierAddress?: string;
  verifierExplorerUrl?: string;
}

/**
 * Generate a zero-knowledge proof.
 *
 * Two modes:
 *   Mode A (session): Provide requestId from a completed request_signing session.
 *     The address, signature, scope, circuitId, and country fields are extracted
 *     from the Redis record. The signing record is consumed (one-time use).
 *
 *   Mode B (direct): Provide address, signature, scope, and circuitId directly.
 *     Only available when payment is disabled.
 *
 * @throws Error if inputs are missing, signing/payment not complete, rate limited, etc.
 */
export async function handleGenerateProof(
  params: GenerateProofParams,
  deps: SkillDeps,
): Promise<GenerateProofResult> {
  let resolvedAddress: string;
  let resolvedSignature: string;
  let resolvedScope: string;
  let resolvedCircuitId: string;
  let resolvedCountryList: string[] | undefined;
  let resolvedIsIncluded: boolean | undefined;
  let paymentTxHash: string | undefined;

  if (params.requestId) {
    // ── Mode A: Session flow ──────────────────────────────────────────────
    const key = signingKey(params.requestId);
    const record = await getRecord(deps.redis, params.requestId);

    if (!record) {
      throw new Error(
        'Request not found or expired. Create a new request with request_signing.',
      );
    }

    if (record.status !== 'completed') {
      throw new Error(
        `Signing not yet completed. Use check_status to verify, then ask user to sign at the signing URL. Current status: ${record.status}`,
      );
    }

    if (deps.paymentMode !== 'disabled' && record.paymentStatus !== 'completed') {
      throw new Error(
        'Payment not yet completed. Use request_payment to get the payment URL.',
      );
    }

    if (!record.address) {
      throw new Error('Signing record is missing address. The user may not have completed wallet connection.');
    }
    if (!record.signature) {
      throw new Error('Signing record is missing signature. The user may not have completed the signing step.');
    }

    resolvedAddress = record.address;
    resolvedSignature = record.signature;
    resolvedScope = record.scope;
    resolvedCircuitId = record.circuitId;
    resolvedCountryList = record.countryList;
    resolvedIsIncluded = record.isIncluded;
    paymentTxHash = record.paymentTxHash;

    // Extend TTL so user can retry if proof generation fails
    await deps.redis.expire(key, deps.signingTtlSeconds);
  } else {
    // ── Mode B: Direct flow ───────────────────────────────────────────────
    if (!params.address || !params.signature) {
      throw new Error(
        'Either provide requestId (from request_signing), or both address and signature for direct proof generation.',
      );
    }
    if (!params.scope) {
      throw new Error('scope is required for direct proof generation.');
    }
    if (!params.circuitId) {
      throw new Error('circuitId is required for direct proof generation.');
    }

    resolvedAddress = params.address;
    resolvedSignature = params.signature;
    resolvedScope = params.scope;
    resolvedCircuitId = params.circuitId;
    resolvedCountryList = params.countryList;
    resolvedIsIncluded = params.isIncluded;
  }

  // Validate circuitId
  if (!(resolvedCircuitId in CIRCUITS)) {
    throw new Error(
      `Unknown circuit: "${resolvedCircuitId}". Supported circuits: ${Object.keys(CIRCUITS).join(', ')}`,
    );
  }

  // Validate country fields for country circuit
  if (resolvedCircuitId === 'coinbase_country_attestation') {
    if (!resolvedCountryList || resolvedCountryList.length === 0) {
      throw new Error(
        'countryList is required for coinbase_country_attestation and must be a non-empty array of 2-letter country codes.',
      );
    }
    if (typeof resolvedIsIncluded !== 'boolean') {
      throw new Error(
        'isIncluded is required for coinbase_country_attestation and must be a boolean.',
      );
    }
  }

  // Rate limit check
  if (deps.rateLimiter) {
    const result = await deps.rateLimiter.check(resolvedAddress);
    if (!result.allowed) {
      throw new Error(`Rate limit exceeded. Retry after ${result.retryAfter} seconds.`);
    }
  }

  // Cache check
  if (deps.proofCache) {
    const cached = await deps.proofCache.get(resolvedCircuitId, {
      address: resolvedAddress,
      scope: resolvedScope,
      countryList: resolvedCountryList,
      isIncluded: resolvedIsIncluded,
    });
    if (cached) {
      log.info({ circuitId: resolvedCircuitId, address: resolvedAddress, hasAttestation: !!cached.attestation }, 'CACHE HIT — returning cached proof');

      const proofId = await storeProofResult(deps.redis, {
        proof: cached.proof,
        publicInputs: cached.publicInputs,
        circuitId: resolvedCircuitId,
        nullifier: cached.nullifier,
        signalHash: cached.signalHash,
        ...(cached.attestation && {
          attestation: {
            document: cached.attestation.document,
            mode: cached.attestation.mode,
            proofHash: cached.attestation.proofHash,
            timestamp: cached.attestation.timestamp,
          },
        }),
      });

      log.info({ proofId, hasAttestation: !!cached.attestation }, 'Cached proof stored to Redis');

      const defaultChainId = '84532';
      const cachedVerifierAddress = VERIFIER_ADDRESSES[defaultChainId]?.[resolvedCircuitId];

      const baseUrl = deps.signPageUrl.replace(/\/$/, '');
      return {
        proof: cached.proof,
        publicInputs: cached.publicInputs,
        nullifier: cached.nullifier,
        signalHash: cached.signalHash,
        proofId,
        verifyUrl: baseUrl + '/v/' + proofId,
        cached: true,
        ...(cached.attestation && { attestation: cached.attestation, attestationUrl: baseUrl + '/a/' + proofId }),
        ...(paymentTxHash && { paymentTxHash, paymentReceiptUrl: getBasescanTxUrl(deps.paymentMode, paymentTxHash) }),
        ...(cachedVerifierAddress && { verifierAddress: cachedVerifierAddress, verifierExplorerUrl: getBasescanAddressUrl(defaultChainId, cachedVerifierAddress) }),
      };
    }
  }

  log.info({ circuitId: resolvedCircuitId, address: resolvedAddress, scope: resolvedScope, teeMode: deps.teeMode }, 'Starting proof generation');

  // Compute circuit params (fetches attestation from chain, builds Merkle tree, etc.)
  const circuitParams = await computeCircuitParams(
    {
      address: resolvedAddress,
      signature: resolvedSignature,
      scope: resolvedScope,
      circuitId: resolvedCircuitId as CircuitId,
      countryList: resolvedCountryList,
      isIncluded: resolvedIsIncluded,
    },
    deps.easGraphqlEndpoint,
    deps.rpcUrls,
  );

  // Generate proof (TEE enclave or bb CLI)
  let proofResult: { proof: string; publicInputs: string; proofWithInputs: string };
  let teeAttestation: { document: string; mode: 'nitro'; proofHash: string; timestamp: number } | undefined;

  log.info({ teeMode: deps.teeMode, hasTeeProvider: !!deps.teeProvider, willUseTee: !!(deps.teeProvider && deps.teeMode === 'nitro') }, 'TEE routing decision');

  if (deps.teeProvider && deps.teeMode === 'nitro') {
    // TEE Enclave path (AWS Nitro) — send proverToml for bb CLI proving
    // Retry on connection failures (enclave may be restarting during deployment)
    const proverToml = toProverToml(
      resolvedCircuitId as 'coinbase_attestation' | 'coinbase_country_attestation',
      circuitParams
    );

    const TEE_MAX_RETRIES = 5;
    const TEE_RETRY_BASE_MS = 3000;
    let teeResponse: Awaited<ReturnType<typeof deps.teeProvider.prove>> | undefined;

    for (let attempt = 1; attempt <= TEE_MAX_RETRIES; attempt++) {
      try {
        teeResponse = await deps.teeProvider.prove(resolvedCircuitId, [], randomUUID(), proverToml);
        break; // success
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        const isConnectionError = errMsg.includes('ECONNREFUSED') || errMsg.includes('ECONNRESET') || errMsg.includes('Connection timeout') || errMsg.includes('Empty response');
        if (!isConnectionError || attempt === TEE_MAX_RETRIES) {
          throw new Error(`TEE enclave unreachable after ${attempt} attempt(s): ${errMsg}`);
        }
        const delay = TEE_RETRY_BASE_MS * attempt;
        log.warn({ attempt, maxRetries: TEE_MAX_RETRIES, delay, error: errMsg }, 'TEE enclave connection failed, retrying...');
        await new Promise(r => setTimeout(r, delay));
      }
    }

    if (!teeResponse) {
      throw new Error('TEE enclave unreachable: no response after retries');
    }

    log.info({ responseType: teeResponse.type, hasProof: !!teeResponse.proof, hasAttestation: !!teeResponse.attestationDocument, requestId: teeResponse.requestId }, 'TEE enclave response received');

    if (teeResponse.type === 'error') {
      throw new Error(teeResponse.error || 'TEE proof generation failed');
    }
    if (teeResponse.type !== 'proof' || !teeResponse.proof) {
      throw new Error('Invalid TEE response: expected type "proof" with proof data');
    }

    const rawPi = teeResponse.publicInputs;
    let piHex: string;
    if (rawPi && rawPi.length > 0) {
      if (rawPi.length === 1) {
        piHex = rawPi[0];
      } else {
        piHex = '0x' + rawPi.map(s => s.startsWith('0x') ? s.slice(2) : s).join('');
      }
    } else {
      piHex = '0x';
    }

    proofResult = {
      proof: teeResponse.proof,
      publicInputs: piHex,
      proofWithInputs: teeResponse.proof + piHex.slice(2),
    };

    // Use attestation from prove response (NSM attestation already included)
    if (teeResponse.attestationDocument) {
      teeAttestation = {
        document: teeResponse.attestationDocument,
        mode: 'nitro' as const,
        proofHash: ethers.keccak256(ethers.getBytes(teeResponse.proof)),
        timestamp: Date.now(),
      };
    }
  } else {
    // bb CLI path (local prover)
    log.info({ teeMode: deps.teeMode, circuitId: resolvedCircuitId }, 'Using bb CLI path (NOT TEE enclave)');
    const bbProver = new BbProver({
      bbPath: deps.bbPath,
      nargoPath: deps.nargoPath,
      circuitsDir: deps.circuitsDir,
    });
    proofResult = await bbProver.prove(resolvedCircuitId, circuitParams);
    log.info({ circuitId: resolvedCircuitId }, 'bb CLI proof generation complete');
  }

  // Convert computed values to hex
  const nullifier = ethers.hexlify(circuitParams.nullifierBytes);
  const signalHash = ethers.hexlify(circuitParams.signalHash);

  // Use TEE attestation from prove response, or generate separately for non-TEE paths
  let attestation: Record<string, unknown> | undefined;
  if (teeAttestation) {
    attestation = teeAttestation as unknown as Record<string, unknown>;
  } else if (deps.teeProvider && deps.teeMode !== 'disabled') {
    try {
      const proofBytes = ethers.getBytes(proofResult.proof);
      const proofHash = ethers.keccak256(proofBytes);
      const att = await deps.teeProvider.generateAttestation(proofHash, {
        circuitId: resolvedCircuitId,
        scope: resolvedScope,
      });
      if (att) attestation = att as unknown as Record<string, unknown>;
    } catch (error) {
      log.error({ err: error }, 'Failed to generate TEE attestation');
    }
  }

  // Cache the result (including attestation so cache hits preserve TEE evidence)
  const cacheableResult = {
    proof: proofResult.proof,
    publicInputs: proofResult.publicInputs,
    nullifier,
    signalHash,
    ...(attestation && {
      attestation: {
        document: (attestation as any).document,
        mode: (attestation as any).mode,
        proofHash: (attestation as any).proofHash,
        timestamp: (attestation as any).timestamp,
      },
    }),
  };

  if (deps.proofCache) {
    await deps.proofCache.set(
      resolvedCircuitId,
      {
        address: resolvedAddress,
        scope: resolvedScope,
        countryList: resolvedCountryList,
        isIncluded: resolvedIsIncluded,
      },
      cacheableResult,
    );
    log.info({ circuitId: resolvedCircuitId, address: resolvedAddress, hasAttestation: !!attestation }, 'Proof cached');
  }

  // Store result for later retrieval/verification
  const proofId = await storeProofResult(deps.redis, {
    proof: proofResult.proof,
    publicInputs: proofResult.publicInputs,
    circuitId: resolvedCircuitId,
    nullifier,
    signalHash,
    ...(attestation && {
      attestation: {
        document: (attestation as any).document,
        mode: (attestation as any).mode,
        proofHash: (attestation as any).proofHash,
        timestamp: (attestation as any).timestamp,
      },
    }),
  });

  const baseUrl = deps.signPageUrl.replace(/\/$/, '');
  const verifyUrl = baseUrl + '/v/' + proofId;

  log.info({ proofId, circuitId: resolvedCircuitId, nullifier, signalHash, hasAttestation: !!attestation }, 'Proof generated');

  // Consume the signing record only after successful proof generation
  // (if proof fails, record stays so user can retry without re-signing/re-paying)
  if (params.requestId) {
    await deps.redis.del(signingKey(params.requestId));
  }

  const defaultChainId = '84532';
  const resolvedVerifierAddress = VERIFIER_ADDRESSES[defaultChainId]?.[resolvedCircuitId];

  return {
    proof: proofResult.proof,
    publicInputs: proofResult.publicInputs,
    nullifier,
    signalHash,
    proofId,
    verifyUrl,
    ...(attestation && { attestation, attestationUrl: baseUrl + '/a/' + proofId }),
    ...(paymentTxHash && { paymentTxHash, paymentReceiptUrl: getBasescanTxUrl(deps.paymentMode, paymentTxHash) }),
    ...(resolvedVerifierAddress && { verifierAddress: resolvedVerifierAddress, verifierExplorerUrl: getBasescanAddressUrl(defaultChainId, resolvedVerifierAddress) }),
  };
}

// ─── Skill 5: verify_proof ───────────────────────────────────────────────────

/** Parameters for on-chain proof verification. */
export interface VerifyProofParams {
  proofId?: string;
  circuitId?: string;
  proof?: string;
  publicInputs?: string | string[];
  chainId?: string;
}

/** Result of on-chain proof verification. */
export interface VerifyProofResult {
  valid: boolean;
  circuitId: string;
  verifierAddress: string;
  chainId: string;
  verifierExplorerUrl?: string;
  error?: string;
}

/** Minimal verifier ABI — only the verify function. */
const VERIFIER_ABI = [
  'function verify(bytes calldata _proof, bytes32[] calldata _publicInputs) external view returns (bool)',
];

/**
 * Verify a ZK proof on-chain via the deployed verifier contract.
 *
 * Accepts publicInputs as either a concatenated hex string (split into 32-byte chunks)
 * or as a pre-split string array.
 *
 * @throws Error if required params are missing or circuitId/chainId has no verifier
 */
export async function handleVerifyProof(
  params: VerifyProofParams,
  deps: SkillDeps,
): Promise<VerifyProofResult> {
  let circuitId = params.circuitId;
  let proof = params.proof;
  let publicInputs = params.publicInputs;

  // If proofId is provided, look up stored proof data from Redis
  if (params.proofId) {
    const stored = await getProofResult(deps.redis, params.proofId);
    if (!stored) {
      throw new Error(
        `Proof not found for proofId "${params.proofId}". The proof may have expired (24h TTL). Generate a new proof with generate_proof.`,
      );
    }
    proof = stored.proof;
    publicInputs = stored.publicInputs;
    circuitId = stored.circuitId;
  }

  // Validate required params
  if (!circuitId) {
    throw new Error('circuitId is required. Use get_supported_circuits to see available circuits.');
  }
  if (!proof) {
    throw new Error('proof is required. Provide the hex-encoded proof from generate_proof.');
  }
  if (publicInputs === undefined || publicInputs === null) {
    throw new Error('publicInputs is required. Provide the hex-encoded public inputs from generate_proof.');
  }

  // Validate circuitId
  if (!(circuitId in CIRCUITS)) {
    throw new Error(
      `Unknown circuit: "${circuitId}". Supported circuits: ${Object.keys(CIRCUITS).join(', ')}`,
    );
  }

  // Resolve chainId (default to Base Sepolia)
  const chainId = params.chainId || '84532';

  // Look up verifier address
  const chainVerifiers = VERIFIER_ADDRESSES[chainId];
  if (!chainVerifiers || !chainVerifiers[circuitId]) {
    throw new Error(
      `No verifier deployed for circuit "${circuitId}" on chain "${chainId}". Check VERIFIER_ADDRESSES configuration.`,
    );
  }
  const verifierAddress = chainVerifiers[circuitId];

  // Normalize publicInputs to array of 32-byte hex chunks
  const publicInputsArray = normalizePublicInputs(publicInputs);

  // Create provider and contract
  const provider = new ethers.JsonRpcProvider(deps.chainRpcUrl);
  const verifierContract = new ethers.Contract(verifierAddress, VERIFIER_ABI, provider);

  log.info({ circuitId, chainId, verifierAddress, publicInputsCount: publicInputsArray.length }, 'Verifying proof on-chain');

  try {
    const isValid: boolean = await verifierContract.verify(proof, publicInputsArray);

    return {
      valid: isValid,
      circuitId,
      verifierAddress,
      chainId,
      verifierExplorerUrl: getBasescanAddressUrl(chainId, verifierAddress),
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    log.error({ detail: message }, 'Proof verification contract call reverted');

    return {
      valid: false,
      circuitId,
      verifierAddress,
      chainId,
      verifierExplorerUrl: getBasescanAddressUrl(chainId, verifierAddress),
      error: message,
    };
  }
}

// ─── Skill 6: get_supported_circuits ─────────────────────────────────────────

/** Parameters for listing supported circuits (all optional). */
export interface GetSupportedCircuitsParams {
  chainId?: string;
}

/** A single circuit entry in the response. */
export interface CircuitInfo {
  id: string;
  displayName: string;
  description: string;
  requiredInputs: readonly string[];
  verifierAddress?: string;
}

/** Result of listing supported circuits. */
export interface GetSupportedCircuitsResult {
  circuits: CircuitInfo[];
  chainId: string;
}

/**
 * Return metadata for all supported circuits, including verifier addresses
 * for the specified chain.
 */
export function handleGetSupportedCircuits(
  params: GetSupportedCircuitsParams,
): GetSupportedCircuitsResult {
  const chainId = params.chainId || '84532';
  const chainVerifiers = VERIFIER_ADDRESSES[chainId] || {};

  const circuits: CircuitInfo[] = Object.values(CIRCUITS).map(circuit => ({
    id: circuit.id,
    displayName: circuit.displayName,
    description: circuit.description,
    requiredInputs: circuit.requiredInputs,
    ...(chainVerifiers[circuit.id] && { verifierAddress: chainVerifiers[circuit.id] }),
  }));

  return { circuits, chainId };
}
