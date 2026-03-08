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
          memoToSign: memoToSign ? JSON.stringify(memoToSign).slice(0, 500) : null,
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
  // Use job.name first (confirmed available as string, e.g. "generateKycProof")
  // Fallback: try offeringName, then stringify requirement if it's an object
  const rawName = job.name || job.offeringName || (typeof job.requirement === 'string' ? job.requirement : JSON.stringify(job.requirement || ''));
  const jobName = String(rawName).toLowerCase();

  log.info({ action: 'virtuals.job.buildDeliverable', jobName, rawName: String(rawName).slice(0, 200) }, `Building deliverable for: ${jobName}`);

  // generateKycProof or generateCountryProof → return guide URL
  if (jobName.includes('kyc') || jobName.includes('proof') || jobName.includes('country')) {
    const circuitAlias = jobName.includes('country') ? 'coinbase_country' : 'coinbase_kyc';
    const guideUrl = `${config.a2aBaseUrl}/api/v1/guide/${circuitAlias}`;

    return {
      type: 'url',
      value: guideUrl,
    };
  }

  // getSupportedCircuits / getVerifierContracts → return guide URL
  if (jobName.includes('circuit') || jobName.includes('verifier') || jobName.includes('contract')) {
    return {
      type: 'url',
      value: `${config.a2aBaseUrl}/api/v1/guide/coinbase_kyc`,
    };
  }

  // Default: return MCP endpoint
  return {
    type: 'url',
    value: `${config.a2aBaseUrl}/mcp`,
  };
}
