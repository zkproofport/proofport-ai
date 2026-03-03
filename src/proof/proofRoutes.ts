import { Router, type Request, type Response } from 'express';
import type { RedisClient } from '../redis/client.js';
import type { Config } from '../config/index.js';
import type { TeeProvider } from '../tee/types.js';
import type { CircuitId } from '../config/circuits.js';
import { ProofSessionManager } from './sessionManager.js';
import { verifyPaymentOnChain } from './paymentVerifier.js';
import { toProverToml } from '../prover/tomlBuilder.js';
import { BbProver } from '../prover/bbProver.js';
import { hexToBytes } from '../input/inputBuilder.js';
import type { CircuitParams } from '../input/inputBuilder.js';
import { buildGuide } from './guideBuilder.js';
import { ethers } from 'ethers';
import { createLogger } from '../logger.js';
import { parseAttestationDocument, verifyAttestationDocument } from '../tee/attestation.js';
import type {
  ProofSessionRequest,
  ProofSessionResponse,
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

export function createProofRoutes(deps: ProofRoutesDeps): Router {
  const router = Router();
  const sessionManager = new ProofSessionManager(deps.redis);
  const { config } = deps;

  const isTestnet = config.paymentMode === 'testnet';
  const network: 'base-sepolia' | 'base' = isTestnet ? 'base-sepolia' : 'base';
  const usdcAddress = isTestnet
    ? '0x036CbD53842c5426634e7929541eC2318f3dCF7e'
    : '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
  const priceStr = (config.paymentProofPrice || '$0.10').replace('$', '');
  const paymentAmount = Math.round(parseFloat(priceStr) * 1_000_000);

  // POST /proof/request -- Create proof session
  router.post('/proof/request', async (req: Request, res: Response) => {
    try {
      const body = req.body as ProofSessionRequest;

      if (!body.circuit) {
        res.status(400).json({ error: 'INVALID_REQUEST', message: 'Missing circuit' });
        return;
      }

      const circuitId = CIRCUIT_MAP[body.circuit];
      if (!circuitId) {
        res.status(400).json({ error: 'INVALID_CIRCUIT', message: `Unknown circuit: ${body.circuit}. Valid: ${Object.keys(CIRCUIT_MAP).join(', ')}` });
        return;
      }

      const session = await sessionManager.createSession({ circuit: circuitId });

      const response: ProofSessionResponse = {
        session_id: session.session_id,
        payment: {
          nonce: session.payment_nonce,
          recipient: config.paymentPayTo,
          amount: paymentAmount,
          asset: usdcAddress,
          network,
          instruction: `Sign EIP-3009 TransferWithAuthorization for ${priceStr} USDC to ${config.paymentPayTo} using nonce ${session.payment_nonce}. Settle via x402 facilitator (https://www.x402.org/facilitator/settle). Submit the resulting tx hash to POST /api/v1/prove.`,
        },
        tee_endpoint: `${config.a2aBaseUrl}/api/v1/prove`,
        expires_at: session.expires_at,
        guide_url: `${config.a2aBaseUrl}/api/v1/guide/${body.circuit}`,
      };

      res.status(402).json(response);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      log.error({ action: 'proof.request.error', err: error }, 'Failed to create proof session');
      res.status(500).json({ error: 'INTERNAL_ERROR', message });
    }
  });

  // POST /prove -- Atomic: verify payment + generate proof
  router.post('/prove', async (req: Request, res: Response) => {
    const startTime = Date.now();
    try {
      const body = req.body as ProveRequest;

      // Validate request
      if (!body.session_id) {
        res.status(400).json({ error: 'INVALID_REQUEST', message: 'Missing session_id' });
        return;
      }
      if (!body.payment_tx_hash) {
        res.status(400).json({ error: 'INVALID_REQUEST', message: 'Missing payment_tx_hash' });
        return;
      }
      if (!body.inputs) {
        res.status(400).json({ error: 'INVALID_REQUEST', message: 'Missing inputs' });
        return;
      }

      // Get session
      const session = await sessionManager.getSession(body.session_id);
      if (!session) {
        res.status(404).json({ error: 'SESSION_NOT_FOUND', message: 'Session not found or expired' });
        return;
      }
      if (session.status !== 'PAYMENT_PENDING') {
        res.status(400).json({ error: 'SESSION_INVALID', message: `Session status is ${session.status}, expected PAYMENT_PENDING` });
        return;
      }

      // Verify payment on-chain
      const paymentStart = Date.now();
      const paymentResult = await verifyPaymentOnChain({
        txHash: body.payment_tx_hash,
        expectedRecipient: config.paymentPayTo,
        expectedNonce: session.payment_nonce,
        expectedMinAmount: BigInt(paymentAmount),
        rpcUrl: config.chainRpcUrl,
        network,
      });
      const paymentVerifyMs = Date.now() - paymentStart;

      if (!paymentResult.valid) {
        res.status(402).json({
          error: 'PAYMENT_INVALID',
          reason: paymentResult.reason,
          message: paymentResult.error,
        });
        return;
      }

      // Update session
      await sessionManager.updateSession(body.session_id, {
        status: 'PROVING',
        payment_tx_hash: body.payment_tx_hash,
      });

      // Build CircuitParams from client inputs
      const inputBuildStart = Date.now();
      const { inputs } = body;

      // Validate new required client-computed fields
      if (!inputs.signal_hash || !inputs.nullifier || !inputs.scope_bytes || !inputs.merkle_root || !inputs.user_address) {
        res.status(400).json({ error: 'INVALID_REQUEST', message: 'Missing required derived fields: signal_hash, nullifier, scope_bytes, merkle_root, user_address' });
        return;
      }

      // Country circuit validation (moved from proof_request to here)
      if (session.circuit === 'coinbase_country_attestation') {
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
        ...(session.circuit === 'coinbase_country_attestation' && {
          countryList: inputs.country_list,
          countryListLength: (inputs.country_list || []).length,
          isIncluded: inputs.is_included,
        }),
      };

      const inputBuildMs = Date.now() - inputBuildStart;

      // Build proverToml
      const proverToml = toProverToml(session.circuit, circuitParams);

      // Generate proof via TEE or BbProver
      const proveStart = Date.now();
      let proof: string;
      let publicInputs: string;
      let proofWithInputs: string;
      let attestationDoc: string | undefined;

      const teeMode = config.teeMode || 'disabled';

      if (teeMode === 'nitro' && deps.teeProvider) {
        const vsockResponse = await deps.teeProvider.prove(
          session.circuit,
          [],
          body.session_id,
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
        const bbResult = await bbProver.prove(session.circuit, circuitParams);
        proof = bbResult.proof;
        publicInputs = bbResult.publicInputs;
        proofWithInputs = bbResult.proofWithInputs;
      }

      const proveMs = Date.now() - proveStart;

      // Update session to completed
      await sessionManager.updateSession(body.session_id, { status: 'COMPLETED' });

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
      };

      res.json(response);
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
