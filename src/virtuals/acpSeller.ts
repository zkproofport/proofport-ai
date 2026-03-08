/**
 * Virtuals Protocol ACP Seller
 *
 * 5th protocol adapter for proofport-ai.
 * Listens for incoming ACP jobs and delegates to existing skill handlers.
 *
 * Job flow:
 *   1. ACP buyer requests job → onNewTask(phase=REQUEST)
 *   2. Seller accepts + creates requirement → buyer pays via ACP
 *   3. Payment confirmed → onNewTask(phase=TRANSACTION)
 *   4. Seller executes skill → job.deliver(deliverable)
 *
 * Skills:
 *   - generateKycProof / generateCountryProof → returns x402 endpoint guide
 *   - verifyProofOnChain → returns verifier contract info
 *   - getSupportedCircuits → returns circuit list directly
 */

import { createLogger } from '../logger.js';
import type { Config } from '../config/index.js';
import { handleGetSupportedCircuits } from '../skills/skillHandler.js';
import { buildGuide } from '../proof/guideBuilder.js';

const log = createLogger('VirtualsACP');

/** Start the ACP Seller listener if Virtuals is enabled. */
export async function startAcpSeller(config: Config): Promise<void> {
  if (!config.virtualsEnabled) {
    log.info({ action: 'virtuals.disabled' }, 'Virtuals ACP disabled');
    return;
  }

  if (!config.virtualsWalletPk || !config.virtualsEntityId || !config.virtualsAgentWallet) {
    log.warn({ action: 'virtuals.missing_config' }, 'Virtuals ACP enabled but missing VIRTUALS_WALLET_PK, VIRTUALS_ENTITY_ID, or VIRTUALS_AGENT_WALLET');
    return;
  }

  try {
    // Dynamic import to avoid loading ACP SDK when disabled
    const acpModule = await import('@virtuals-protocol/acp-node');
    // Handle CJS/ESM interop: default export may be nested
    const AcpClient = acpModule.default?.default ?? acpModule.default ?? acpModule;
    const { AcpContractClientV2 } = acpModule;

    const contractClient = await AcpContractClientV2.build(
      config.virtualsWalletPk as `0x${string}`,
      config.virtualsEntityId,
      config.virtualsAgentWallet as `0x${string}`,
    );

    const client = new AcpClient({
      acpContractClient: contractClient,

      onNewTask: async (job: any, memoToSign?: any) => {
        const jobId = job.id;
        const phase = job.phase;
        const nextPhase = memoToSign?.nextPhase;

        log.info({
          action: 'virtuals.job.received',
          jobId,
          phase,
          phaseType: typeof phase,
          nextPhase,
          nextPhaseType: typeof nextPhase,
          jobName: job.name,
          requirement: typeof job.requirement === 'string' ? job.requirement?.slice(0, 200) : JSON.stringify(job.requirement)?.slice(0, 200),
        }, `ACP job received: #${jobId} (phase=${phase}, nextPhase=${nextPhase})`);

        try {
          // Phase 1: REQUEST(0) → Accept and create requirement
          // AcpJobPhases: REQUEST=0, NEGOTIATION=1, TRANSACTION=2, EVALUATION=3
          if (phase === 0 && nextPhase === 1) {
            log.info({ action: 'virtuals.job.accepting', jobId }, `Accepting ACP job #${jobId}`);
            await job.accept('ProverAgent can fulfill this ZK proof request');
            await job.createRequirement(
              `Job #${jobId} accepted. After ACP payment, you will receive the x402 proof endpoint and guide. ` +
              `Proof generation requires an additional x402 micropayment (${config.paymentProofPrice} USDC) ` +
              `at the REST endpoint.`
            );
            log.info({ action: 'virtuals.job.accepted', jobId }, `ACP job #${jobId} accepted`);
            return;
          }

          // Phase 2: TRANSACTION(2) → Execute skill and deliver
          if (phase === 2 && nextPhase === 3) {
            log.info({ action: 'virtuals.job.executing', jobId }, `Executing ACP job #${jobId}`);

            const deliverable = buildJobDeliverable(job, config);

            log.info({ action: 'virtuals.job.delivering', jobId, type: deliverable.type }, `Delivering ACP job #${jobId}`);
            await job.deliver(deliverable);
            log.info({ action: 'virtuals.job.delivered', jobId }, `ACP job #${jobId} delivered`);
            return;
          }

          log.info({ action: 'virtuals.job.unhandled', jobId, phase, nextPhase }, `Unhandled ACP job phase combination: phase=${phase} nextPhase=${nextPhase}`);
        } catch (err) {
          log.error({ action: 'virtuals.job.error', jobId, err }, `ACP job #${jobId} failed`);
          try {
            await job.reject(`Error processing job: ${err instanceof Error ? err.message : 'Unknown error'}`);
          } catch (rejectErr) {
            log.error({ action: 'virtuals.job.reject_failed', jobId, err: rejectErr }, `Failed to reject ACP job #${jobId}`);
          }
        }
      },
    });

    log.info({
      action: 'virtuals.started',
      entityId: config.virtualsEntityId,
      agentWallet: config.virtualsAgentWallet,
    }, 'Virtuals ACP Seller started — listening for jobs');

  } catch (err) {
    log.error({ action: 'virtuals.start_failed', err }, 'Failed to start Virtuals ACP Seller');
    // Don't crash the server — ACP is optional
  }
}

/**
 * Build the deliverable payload based on the job's offering/requirement.
 * Maps ACP job names to existing proofport-ai skills.
 */
function buildJobDeliverable(job: any, config: Config): { type: string; value: string } {
  // Try to determine the skill from the job offering name or requirement text
  const jobName = (job.offeringName || job.requirement || '').toLowerCase();

  // generateKycProof or generateCountryProof → return x402 endpoint guide
  if (jobName.includes('kyc') || jobName.includes('proof') || jobName.includes('country')) {
    const circuitAlias = jobName.includes('country') ? 'coinbase_country' : 'coinbase_kyc';
    const circuitIdMap: Record<string, string> = {
      coinbase_kyc: 'coinbase_attestation',
      coinbase_country: 'coinbase_country_attestation',
    };
    const circuitId = circuitIdMap[circuitAlias] || circuitAlias;

    const guide = buildGuide(circuitId as any, config);

    return {
      type: 'url',
      value: JSON.stringify({
        message: `ZK proof generation is available via x402 micropayment flow at the endpoint below. ` +
                 `Send POST with {circuit, inputs} → receive 402 with nonce → pay USDC → retry with X-Payment-TX and X-Payment-Nonce headers.`,
        endpoint: `${config.a2aBaseUrl}/api/v1/prove`,
        method: 'POST',
        circuit: circuitAlias,
        price: config.paymentProofPrice,
        guide_url: `${config.a2aBaseUrl}/api/v1/guide/${circuitAlias}`,
        guide,
      }),
    };
  }

  // getSupportedCircuits / getVerifierContracts → return data directly
  if (jobName.includes('circuit') || jobName.includes('verifier') || jobName.includes('contract')) {
    const result = handleGetSupportedCircuits({}, config.paymentMode);
    return {
      type: 'url',
      value: JSON.stringify({
        ...result,
        circuits: result.circuits.map(c => ({
          ...c,
          guide_url: `${config.a2aBaseUrl}/api/v1/guide/${c.id}`,
        })),
      }),
    };
  }

  // Default: return agent capabilities overview
  return {
    type: 'url',
    value: JSON.stringify({
      agent: 'ProverAgent',
      description: 'Privacy-first ZK proof generation agent on Base',
      capabilities: [
        { skill: 'generateKycProof', endpoint: `${config.a2aBaseUrl}/api/v1/prove`, circuit: 'coinbase_kyc' },
        { skill: 'generateCountryProof', endpoint: `${config.a2aBaseUrl}/api/v1/prove`, circuit: 'coinbase_country' },
        { skill: 'getSupportedCircuits', endpoint: `${config.a2aBaseUrl}/api/v1/guide/coinbase_kyc` },
      ],
      mcp: `${config.a2aBaseUrl}/mcp`,
      sdk: 'https://www.npmjs.com/package/@zkproofport-ai/sdk',
    }),
  };
}
