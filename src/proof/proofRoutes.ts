import { Router, type Request, type Response } from 'express';
import { circuitActionBinding } from '@zkproofport-app/sdk/circuits';
import type { RedisClient } from '../redis/client.js';
import type { Config } from '../config/index.js';
import type { TeeProvider } from '../tee/types.js';
import { PROVABLE_CIRCUIT_IDS, CIRCUIT_IDS } from '../config/circuitIds.js';
import type { CircuitId } from '../config/circuitIds.js';
import { verifyPaymentOnChain } from './paymentVerifier.js';
import { settlePayment } from '../payment/settle.js';
import { buildPaymentRequirements } from '../payment/networks.js';
import { resolvePaymentNetworks } from '../payment/networks.js';
import { isTestnet as isTestnetConfig } from '../config/index.js';
import { BbProver } from '../prover/bbProver.js';
import { hexToBytes } from '../input/inputBuilder.js';
import type { CircuitParams } from '../input/inputBuilder.js';
import { buildGuide } from './guideBuilder.js';
import { getVerifierAddress } from '../config/deployments.js';
import { GIWA_CHAIN_ID } from '../config/contracts.js';
import { ethers } from 'ethers';
import { createLogger } from '../logger.js';
import { parseAttestationDocument, verifyAttestationDocument } from '../tee/attestation.js';
import { isBatchPayment } from '@circle-fin/x402-batching';
import type {
  ProveRequest,
  ProveResponse,
} from './types.js';

const log = createLogger('ProofRoutes');

// Map client-friendly circuit names to canonical IDs.
// The canonical ids come from config/circuitIds.ts; only the friendly aliases
// on the left are this route's own vocabulary.
/**
 * Friendly names a caller may send instead of a canonical id.
 *
 * Only the aliases live here. Every canonical id this server can prove is
 * accepted automatically below, which is the part that used to be typed out:
 * the map listed four circuits by hand, its key type is `string` so nothing
 * checked it, and `giwa_attestation` became provable while this table quietly
 * answered "Unknown circuit". Measured 2026-09-22, against a server that had
 * the circuit, its artifacts and its verifier.
 */
const CIRCUIT_ALIASES: Record<string, CircuitId> = {
  coinbase_kyc: CIRCUIT_IDS.COINBASE_ATTESTATION,
  coinbase_country: CIRCUIT_IDS.COINBASE_COUNTRY_ATTESTATION,
  oidc_domain: CIRCUIT_IDS.OIDC_DOMAIN_ATTESTATION,
};

const CIRCUIT_MAP: Record<string, CircuitId> = {
  ...CIRCUIT_ALIASES,
  ...Object.fromEntries(PROVABLE_CIRCUIT_IDS.map((id) => [id, id])),
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
  verification: ProveResponse['verification'];
}

/**
 * Choose the chain, the verifier deployed on it, and an RPC that serves THAT
 * chain — as one set.
 *
 * These used to be picked separately, and the answer was a response no client
 * could act on: chainId 11155111 with the Ethereum Sepolia verifier, and
 * `rpcUrl` pointing at Base Sepolia. A client did as it was told, called the
 * Ethereum address over the Base RPC, and hit a different contract that happens
 * to sit at the same address — deterministic deployment gives one deployer the
 * same address on every chain. It reverted with a custom error, and every
 * on-chain verification in the E2E suite failed with "expected false to be
 * true". Measured 2026-09-05: the same proof verifies `true` on Ethereum
 * Sepolia with the Ethereum verifier, and `true` on Base Sepolia with the Base
 * verifier. Only the mixed pair fails.
 *
 * `chainRpcUrl` is the Base RPC throughout this file — the payment verifier
 * below reads it as 'base' / 'base-sepolia'. So Ethereum needs its own RPC, and
 * when none is configured this returns the Base pairing rather than quietly
 * lending Ethereum the Base URL.
 */
export function chooseVerificationTarget(
  config: Config,
  circuitId: CircuitId,
  testnet: boolean,
): ProveResponse['verification'] {
  const dedicated: Partial<Record<CircuitId, { chainId: number; rpcUrl: string }>> = {
    [CIRCUIT_IDS.ARC_ELIGIBILITY]: { chainId: config.arcChainId, rpcUrl: config.arcRpcUrl },
    [CIRCUIT_IDS.GIWA_ATTESTATION]: { chainId: GIWA_CHAIN_ID, rpcUrl: config.giwaRpcUrl },
  };
  const target = dedicated[circuitId];
  if (target) {
    if (!target.rpcUrl) return null;
    if (!Number.isSafeInteger(target.chainId) || target.chainId <= 0) throw new Error(`Invalid verification chain for ${circuitId}`);
    const verifierAddress = getVerifierAddress(circuitId, String(target.chainId));
    if (!verifierAddress) throw new Error(`No ${circuitId} verifier configured on chain ${target.chainId}`);
    return { ...target, verifierAddress };
  }
  if (config.ethereumRpcUrl) {
    const chainId = testnet ? 11155111 : 1;
    const verifierAddress = getVerifierAddress(circuitId, String(chainId));
    if (verifierAddress) {
      return { chainId, verifierAddress, rpcUrl: config.ethereumRpcUrl };
    }
  }

  const chainId = testnet ? 84532 : 8453;
  const verifierAddress = getVerifierAddress(circuitId, String(chainId));
  return verifierAddress
    ? { chainId, verifierAddress, rpcUrl: config.chainRpcUrl }
    : null;
}

function proofTypeForCircuit(circuitId: CircuitId, provider?: string): string {
  const types: Record<CircuitId, string> = {
    [CIRCUIT_IDS.COINBASE_ATTESTATION]: 'kyc',
    [CIRCUIT_IDS.COINBASE_COUNTRY_ATTESTATION]: 'country',
    [CIRCUIT_IDS.ARC_ELIGIBILITY]: 'arc_eligibility',
    [CIRCUIT_IDS.GIWA_ATTESTATION]: 'giwa_attestation',
    [CIRCUIT_IDS.OIDC_DOMAIN_ATTESTATION]: 'google_login',
  };
  const type = types[circuitId];
  if (!type) throw new Error(`Unknown proof type for circuit ${circuitId}`);
  if (circuitId === CIRCUIT_IDS.OIDC_DOMAIN_ATTESTATION && provider) {
    const providers: Record<string, string> = { google: 'google_workspace', microsoft: 'microsoft_365' };
    if (!providers[provider]) throw new Error(`Unknown OIDC provider ${provider}`);
    return providers[provider];
  }
  return type;
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
  const isOidc = circuitId === CIRCUIT_IDS.OIDC_DOMAIN_ATTESTATION;

  // ── Build structured inputs for the prover ──
  // Server is a BLIND RELAY: validates minimally, passes inputs as-is to TEE/bbProver.
  // TEE/bbProver builds Prover.toml from these inputs.

  let proverInputs: Record<string, any>;
  const inputBuildStart = Date.now();

  const actionInputs = inputs as { domain_separator?: unknown; action_hash?: unknown };
  const hasDomain = actionInputs.domain_separator !== undefined;
  const hasAction = actionInputs.action_hash !== undefined;
  if (hasDomain !== hasAction) {
    res.status(400).json({ error: 'INVALID_REQUEST', message: 'Send both domain_separator and action_hash, or neither for an identity-only proof.' });
    return;
  }
  if (hasDomain && hasAction) {
    if (circuitActionBinding(circuitId) === 'none') {
      res.status(400).json({ error: 'INVALID_REQUEST', message: `${circuitId} does not support action binding.` });
      return;
    }
    if (![actionInputs.domain_separator, actionInputs.action_hash].every(value => typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value))) {
      res.status(400).json({ error: 'INVALID_REQUEST', message: 'domain_separator and action_hash must each be a 0x-prefixed 32-byte hash.' });
      return;
    }
  }
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


    if (circuitId === CIRCUIT_IDS.COINBASE_COUNTRY_ATTESTATION) {
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
      ...(circuitId === CIRCUIT_IDS.COINBASE_COUNTRY_ATTESTATION && {
        countryList: cb.country_list,
        countryListLength: (cb.country_list || []).length,
        isIncluded: cb.is_included,
      }),
      // Whenever the caller sent them, not only for one circuit: the action
      // is optional on both circuits that can carry one, and naming a circuit
      // here is how the next one gets forgotten.
      ...(cb.domain_separator && cb.action_hash
        ? { domainSeparator: cb.domain_separator, actionHash: cb.action_hash }
        : {}),
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

  const proofType = proofTypeForCircuit(ctx.circuitId, (ctx.inputs as { provider?: string }).provider);

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
    verification: ctx.verification,
  };

  res.json(response);
}

export function createProofRoutes(deps: ProofRoutesDeps): Router {
  const router = Router();
  const { config } = deps;

  // The chains this deployment takes payment on, named explicitly. What was
  // here before -- `isTestnet ? 'base-sepolia' : 'base'` -- turned every
  // unrecognised configuration into Base mainnet without saying so: it would
  // quote a Base price, publish a Base asset address and verify against Base
  // for a service pointed somewhere else entirely.
  //
  // A list, not one chain, because x402 sends payment options as a list and
  // Circle's Discovery API reads it to say which networks a service accepts.
  const paymentNetworks = resolvePaymentNetworks(config.paymentNetworks);

  // Which chain the PROOF is verified on, which is a different question from
  // which chain the payment arrives on. Kept on the deployment's own chain
  // setting rather than derived from the payment networks: a service that
  // takes Arc USDC still verifies its proofs wherever its verifier contracts
  // are deployed.
  const isTestnet = isTestnetConfig(config);
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
      // Whether this request carries a payment at all.
      //
      // It used to be "does it have our own X-Payment-Nonce header", which no
      // standard client sends. Circle's CLI signs a correct authorization,
      // sends it as `PAYMENT-SIGNATURE` exactly as x402 says to, and got a
      // second 402 back — the money had moved and the service asked to be paid
      // again. The nonce is ours and stays optional; a signed authorization is
      // a payment whether or not it is accompanied by one.
      // A signed EIP-3009 authorization. The buyer signs and this service
      // submits, so the buyer needs no gas on the chain it pays on -- which is
      // the only way to be paid on Arc or Ethereum, where no public
      // facilitator will submit on a buyer's behalf.
      //
      // `PAYMENT-SIGNATURE` is x402 v2's header name, and it pairs with the
      // `PAYMENT-REQUIRED` header this route already sets on its 402. It is
      // NOT `X-Payment`: that was v1, and reading only the v1 name means every
      // payment from a v2 client arrives looking like no payment at all. Both
      // are read so a v1 client still works.
      //
      // `X-Payment-TX` also remains: a buyer that would rather send its own
      // transaction and hand over the hash still can.
      const paymentAuthHeader =
        ((req.headers['payment-signature'] ?? req.headers['x-payment']) as string) ?? '';

      const hasPayment = !!paymentNonceHeader || !!paymentAuthHeader || !!paymentTxHeader;

      if (!hasPayment) {
        // No payment header — return 402 challenge.
        // Always generate a real nonce (even when disabled) for replay protection.
        const nonce = ethers.hexlify(ethers.randomBytes(32));

        // Store nonce in Redis with 5-min TTL (replay protection)
        await deps.redis.set(`x402:nonce:${nonce}`, circuitId, 'EX', 300);

        const isDisabled = config.paymentMode === 'disabled';

        // One requirement per chain, in the order PAYMENT_NETWORKS names them.
        // Built by the shared helper so the copy rebuilt at settle time is
        // byte-identical -- see buildPaymentRequirements for why that matters.
        const accepts = buildPaymentRequirements({
          networks: paymentNetworks,
          price: priceStr,
          payTo: config.paymentPayTo,
          resource: `${config.a2aBaseUrl}/api/v1/prove`,
          nonce,
          disabled: isDisabled,
          parseUnits: (v, d) => ethers.parseUnits(v, d),
        });

        // `payment` stays a single object for callers written against the old
        // shape; `accepts` is the full list. Removing the singular field would
        // break every existing client for no gain.
        const paymentRequirements = accepts[0];

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

        // The whole offer, not the first option.
        //
        // This header carried `accepts[0]` alone until 2026-09-13, so a client
        // that reads the header — Circle's CLI does — saw one chain and took
        // it, or refused with "No supported payment method found" when that
        // one chain was not one it could pay on. The shape below is what
        // Circle's own starter kit sends and what its CLI reads.
        res.setHeader(
          'PAYMENT-REQUIRED',
          Buffer.from(
            JSON.stringify({
              x402Version: 2,
              resource: {
                url: `${config.a2aBaseUrl}/api/v1/prove`,
                description: `ZK proof generation fee`,
                mimeType: 'application/json',
              },
              accepts,
            }),
          ).toString('base64'),
        );
        res.status(402).json({
          error: 'PAYMENT_REQUIRED',
          message: isDisabled
            ? 'Payment disabled — send nonce back with X-Payment-Nonce to proceed'
            : 'Sign one of the options in `accepts` and retry with the PAYMENT-SIGNATURE and ' +
              'X-Payment-Nonce headers. You sign only — no transaction, no gas. If you would ' +
              'rather submit your own transaction, send X-Payment-TX and X-Payment-Network instead.',
          nonce,
          requiresPayment: !isDisabled,
          payment: paymentRequirements,
          accepts,
          // Which chain settles how, rather than one global facilitator URL.
          // The single field said "use this facilitator" -- true for Base,
          // false for Arc and both Ethereum chains, where no public
          // facilitator serves and this service settles. An agent following
          // it would POST to a facilitator that refuses the chain.
          settlement: isDisabled
            ? null
            : paymentNetworks.map((net) => ({
                network: net.caip2,
                networkName: net.id,
                settledBy: net.settlement === 'facilitator' ? net.facilitatorUrl : 'this service',
                buyerNeedsGas: false,
              })),
          teePublicKey,
        });
        return;
      }

      // Payment headers present — validate nonce (always, for replay protection)
      log.info({ action: 'prove.x402.start', circuit: circuitId, paymentMode: config.paymentMode }, 'x402 proof request');

      let paymentVerifyMs = 0;

      // Our nonce ties a payment to the challenge that offered it, and it is
      // checked when present.
      //
      // Required when the buyer submitted its own transaction: a transaction
      // hash proves money moved and nothing else, so without the nonce there
      // is no link between that payment and this request, and the same hash
      // would buy proofs forever.
      //
      // Optional when the buyer signed an authorization instead, because the
      // authorization itself carries a nonce that Gateway and the USDC
      // contract each refuse to spend twice. Requiring ours as well shut out
      // every standard x402 client — Circle's own CLI signs correctly, gets a
      // second 402, and its money has already moved.
      if (paymentTxHeader && !paymentNonceHeader) {
        res.status(400).json({ error: 'MISSING_NONCE', message: 'X-Payment-Nonce header required with X-Payment-TX' });
        return;
      }

      if (paymentNonceHeader) {
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

        // Which chain the buyer paid on.
        //
        // A signed authorization ALREADY says: the payload carries the CAIP-2
        // network it was signed for, and the signature covers that chain's id
        // through the EIP-712 domain. So the payload is the authority and the
        // header is not consulted at all on that path. Reading a header
        // instead would give two sources for one fact, and the disagreement
        // would resolve as a signature verified against the wrong chain --
        // failing as "invalid signature", which reads like the buyer's fault.
        //
        // The header stays for the X-Payment-TX path, where a buyer submitted
        // its own transaction and nothing in the request says which chain it
        // is on.
        let decoded: ({ paymentPayload?: unknown } & Record<string, unknown>) | undefined;
        if (paymentAuthHeader) {
          try {
            decoded = JSON.parse(Buffer.from(paymentAuthHeader, 'base64').toString('utf8'));
          } catch {
            res.status(402).json({
              error: 'PAYMENT_INVALID',
              reason: 'malformed_payment_header',
              message: 'PAYMENT-SIGNATURE must be base64-encoded JSON (the x402 payment payload)',
            });
            return;
          }
        }
        // An x402 v2 payload echoes the requirement it was signed against as
        // `accepted`, and that is where the chain is named:
        //
        //   { x402Version: 2,
        //     payload:  { authorization: {...}, signature: "0x..." },
        //     accepted: { scheme, network: "eip155:5042002", amount, asset, ... } }
        //
        // The echo is NOT trusted for anything but choosing which chain to look
        // at: the requirement used for settling is rebuilt below from this
        // service's own price and payTo, so a buyer that echoes a smaller
        // amount fails signature verification rather than paying less. The
        // older `network` and `paymentPayload.network` spellings are read too,
        // for a v1 client.
        const signedFor = decoded
          ? String(
              (decoded.accepted as { network?: string } | undefined)?.network ??
                (decoded.network as string | undefined) ??
                (decoded.paymentPayload as { network?: string } | undefined)?.network ??
                '',
            )
          : '';

        // Which offer was paid, not merely which chain.
        //
        // Arc appears twice — once settled on chain per payment, once batched
        // through Circle Gateway — and both carry the same CAIP-2 id, because
        // they ARE the same chain. Matching on the id alone picks whichever
        // was listed first, so a buyer who chose nanopayments had the payment
        // settled the expensive way and the failure named the wrong chain.
        //
        // The payload says which it is: a batched authorization is signed
        // against Gateway's wallet contract, and Circle's own `isBatchPayment`
        // reads that out of it.
        const paidBatched = isBatchPayment(
          ((decoded?.accepted ?? decoded?.paymentRequirements ?? {}) as { extra?: Record<string, unknown> }),
        );
        const matchesChain = (n: (typeof paymentNetworks)[number]) =>
          n.caip2 === signedFor || n.id === signedFor;
        const payNet = signedFor
          ? paymentNetworks.find((n) => matchesChain(n) && (n.settlement === 'gateway') === paidBatched)
            ?? paymentNetworks.find(matchesChain)
          : paymentNetworks.find((n) => n.id === String(req.headers['x-payment-network'] ?? ''));

        if (!payNet) {
          const named = signedFor || String(req.headers['x-payment-network'] ?? '(none given)');
          res.status(402).json({
            error: 'PAYMENT_INVALID',
            reason: 'unsupported_network',
            message:
              `This service does not take payment on '${named}'. ` +
              `Accepted: ${paymentNetworks.map((n) => `${n.id} (${n.caip2})`).join(', ')}`,
          });
          return;
        }

        // A signed authorization has to become a transaction before it can be
        // verified. Settling and verifying stay separate on purpose: the hash
        // that comes back from settlement is then checked on chain by exactly
        // the same code that checks a buyer-submitted hash, so a facilitator
        // that reports a transaction it did not land is caught the same way a
        // buyer who does would be.
        let paymentTxToVerify = paymentTxHeader;
        if (decoded) {
          const offer = buildPaymentRequirements({
            networks: [payNet],
            price: priceStr,
            payTo: config.paymentPayTo,
            resource: `${config.a2aBaseUrl}/api/v1/prove`,
            nonce: paymentNonceHeader,
            parseUnits: (v, d) => ethers.parseUnits(v, d),
          })[0];
          try {
            const settled = await settlePayment({
              payload: decoded.paymentPayload ?? decoded,
              requirements: offer,
              network: payNet,
              networks: paymentNetworks,
            });
            paymentTxToVerify = settled.txHash;
            log.info(
              { action: 'prove.x402.settled', network: payNet.id, via: settled.via, txHash: settled.txHash },
              'x402 authorization settled',
            );
          } catch (e) {
            log.warn({ action: 'prove.x402.settle_failed', network: payNet.id, err: e }, 'x402 settle failed');
            res.status(402).json({
              error: 'PAYMENT_INVALID',
              reason: 'settle_failed',
              message: (e as Error).message,
            });
            return;
          }
        }

        if (!paymentTxToVerify) {
          res.status(402).json({
            error: 'PAYMENT_INVALID',
            reason: 'no_payment',
            message: 'Send either X-Payment (a signed authorization) or X-Payment-TX (a transaction hash)',
          });
          return;
        }

        // A batched payment has nothing on chain to look up yet.
        //
        // Circle Gateway verifies the authorization off chain, in under a
        // second, and settles it later alongside thousands of others. What it
        // hands back is a batch id, not a transaction hash — and asking an RPC
        // about it produces "Invalid params", which reads as a broken payment
        // rather than as the wrong question. Gateway's own verification is the
        // check here, and it already passed to get this far.
        if (payNet.settlement === 'gateway') {
          log.info(
            { action: 'prove.x402.gateway_batched', batch: paymentTxToVerify, network: payNet.id },
            'Payment accepted by Circle Gateway; it settles in a batch',
          );
          paymentVerifyMs = Date.now() - paymentStart;
        } else {

        const payRpc = process.env[payNet.rpcEnv] || payNet.defaultRpc;
        const paymentResult = await verifyPaymentOnChain({
          txHash: paymentTxToVerify,
          expectedRecipient: config.paymentPayTo,
          expectedNonce: paymentNonceHeader,
          expectedMinAmount: ethers.parseUnits(priceStr, payNet.decimals),
          rpcUrl: payRpc,
          network: payNet.id,
          // True when we just settled the buyer's authorization ourselves.
          settledByUs: !!decoded,
        });
        paymentVerifyMs = Date.now() - paymentStart;

        if (!paymentResult.valid) {
          log.warn({ action: 'prove.x402.payment_invalid', reason: paymentResult.reason, txHash: paymentTxToVerify }, 'x402 payment invalid');
          res.status(402).json({
            error: 'PAYMENT_INVALID',
            reason: paymentResult.reason,
            message: paymentResult.error,
          });
          return;
        }

        log.info({ action: 'prove.x402.payment_verified', txHash: paymentTxToVerify, paymentVerifyMs }, 'x402 payment verified');
        }
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

        const e2eProofType = proofTypeForCircuit(circuitId);

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
          verification: chooseVerificationTarget(config, circuitId, isTestnet),
        };

        res.json(response);
        return;
      }

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
          verification: chooseVerificationTarget(config, circuitId, isTestnet),
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
