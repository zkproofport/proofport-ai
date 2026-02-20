import type { RedisClient } from '../redis/client.js';
import type { TaskStore } from '../a2a/taskStore.js';
import type { TaskEventEmitter } from '../a2a/streaming.js';
import type { LLMProvider } from './llmProvider.js';
import type { RateLimiter } from '../redis/rateLimiter.js';
import type { ProofCache } from '../redis/proofCache.js';
import type { TeeProvider } from '../tee/types.js';
import {
  handleRequestSigning,
  handleCheckStatus,
  handleRequestPayment,
  handleGenerateProof,
  handleVerifyProof,
  handleGetSupportedCircuits,
  type SkillDeps,
} from '../skills/skillHandler.js';

export interface ChatHandlerDeps {
  redis: RedisClient;
  taskStore: TaskStore;
  taskEventEmitter: TaskEventEmitter;
  a2aBaseUrl: string;
  llmProvider: LLMProvider;
  // Fields for skillHandler:
  signPageUrl: string;
  signingTtlSeconds: number;
  paymentMode: 'disabled' | 'testnet' | 'mainnet';
  paymentProofPrice: string;
  easGraphqlEndpoint: string;
  rpcUrls: string[];
  bbPath: string;
  nargoPath: string;
  circuitsDir: string;
  chainRpcUrl: string;
  rateLimiter?: RateLimiter;
  proofCache?: ProofCache;
  teeProvider?: TeeProvider;
  teeMode: string;
}

function buildSkillDeps(deps: ChatHandlerDeps): SkillDeps {
  return {
    redis: deps.redis,
    signPageUrl: deps.signPageUrl,
    signingTtlSeconds: deps.signingTtlSeconds,
    paymentMode: deps.paymentMode,
    paymentProofPrice: deps.paymentProofPrice,
    easGraphqlEndpoint: deps.easGraphqlEndpoint,
    rpcUrls: deps.rpcUrls,
    bbPath: deps.bbPath,
    nargoPath: deps.nargoPath,
    circuitsDir: deps.circuitsDir,
    chainRpcUrl: deps.chainRpcUrl,
    rateLimiter: deps.rateLimiter,
    proofCache: deps.proofCache,
    teeProvider: deps.teeProvider,
    teeMode: deps.teeMode,
  };
}

export async function executeSkill(
  skillName: string,
  args: Record<string, unknown>,
  deps: ChatHandlerDeps,
): Promise<unknown> {
  const skillDeps = buildSkillDeps(deps);

  if (skillName === 'get_supported_circuits') {
    return handleGetSupportedCircuits({ chainId: args.chainId as string | undefined });
  }

  if (skillName === 'request_signing') {
    return handleRequestSigning({
      circuitId: args.circuitId as string,
      scope: args.scope as string,
      countryList: args.countryList as string[] | undefined,
      isIncluded: args.isIncluded as boolean | undefined,
    }, skillDeps);
  }

  if (skillName === 'check_status') {
    return handleCheckStatus({
      requestId: args.requestId as string,
    }, skillDeps);
  }

  if (skillName === 'request_payment') {
    return handleRequestPayment({
      requestId: args.requestId as string,
    }, skillDeps);
  }

  if (skillName === 'generate_proof') {
    const result = await handleGenerateProof({
      requestId: args.requestId as string | undefined,
      address: args.address as string | undefined,
      signature: args.signature as string | undefined,
      scope: args.scope as string | undefined,
      circuitId: args.circuitId as string | undefined,
      countryList: args.countryList as string[] | undefined,
      isIncluded: args.isIncluded as boolean | undefined,
    }, skillDeps);

    // Add payment receipt URL if we have a tx hash
    if (result.paymentTxHash) {
      (result as unknown as Record<string, unknown>).paymentReceiptUrl =
        `https://sepolia.basescan.org/tx/${result.paymentTxHash}`;
    }

    return result;
  }

  if (skillName === 'verify_proof') {
    return handleVerifyProof({
      circuitId: args.circuitId as string,
      proof: args.proof as string,
      publicInputs: args.publicInputs as string | string[],
      chainId: args.chainId as string | undefined,
    }, skillDeps);
  }

  throw new Error(`Unknown skill: ${skillName}`);
}
