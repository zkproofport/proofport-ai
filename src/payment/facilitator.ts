import { createPublicClient, http, type Address, type Hex } from 'viem';
import { z } from 'zod';
import { createLogger } from '../logger.js';
import type { PaymentNetwork } from './networks.js';
import type { SettleOutcome } from './settle.js';

const log = createLogger('Facilitator');
const hashPattern = /^0x[0-9a-fA-F]{64}$/;
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const offerSchema = z.object({ scheme: z.literal('exact'), network: z.string(), asset: address, payTo: address, amount: z.string().regex(/^\d+$/) });
const authorizationSchema = z.object({
  x402Version: z.literal(2), accepted: offerSchema,
  payload: z.object({
    signature: z.string().regex(/^0x[0-9a-fA-F]+$/),
    authorization: z.object({ from: address, to: address, value: z.string().regex(/^\d+$/), nonce: z.string().regex(hashPattern) }),
  }),
});

export class FacilitatorSettlementError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly reason: 'settle_failed' | 'settlement_pending' | 'settlement_unknown' = 'settle_failed',
    readonly txHash?: string,
  ) { super(message); }
}

function timeoutMs(): number {
  const value = Number(process.env.X402_FACILITATOR_TIMEOUT_MS ?? '15000');
  if (!Number.isInteger(value) || value <= 0 || value > 60000) {
    throw new Error('X402_FACILITATOR_TIMEOUT_MS must be an integer between 1 and 60000');
  }
  return value;
}

function providerUrl(value: string): string {
  const url = new URL(value);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) || url.username || url.password || url.search || url.hash) {
    throw new Error('Facilitator URL must use HTTPS without credentials, query or fragment (HTTP is allowed only on loopback)');
  }
  return url.href.replace(/\/+$/, '');
}

async function submit(url: string, requestBody: string, network: PaymentNetwork, timeout: number): Promise<string> {
  let response: Response;
  let text: string;
  try {
    response = await fetch(`${url}/settle`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: requestBody,
      signal: AbortSignal.timeout(timeout), redirect: 'error',
    });
    text = await response.text(); // The deadline also covers reading the body.
  } catch {
    throw new FacilitatorSettlementError(`facilitator ${url}: transport error or timeout on ${network.id}`, true);
  }
  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
  } catch { /* A malformed provider response is eligible for failover. */ }

  const transaction = body.transaction;
  const txHash = [body.txHash, typeof transaction === 'string' ? transaction : (transaction as { hash?: unknown } | null)?.hash]
    .find((candidate): candidate is string => typeof candidate === 'string' && hashPattern.test(candidate));
  // Do not reflect provider messages: some contain the complete signed authorization.
  const rawReason = body.errorReason ?? body.invalidReason;
  const reason = typeof rawReason === 'string' ? rawReason : undefined;
  if (reason === 'settlement_pending' || reason === 'duplicate_settlement') {
    throw new FacilitatorSettlementError(`facilitator ${url}: settlement pending on ${network.id}`, false, 'settlement_pending', txHash);
  }
  if (response.ok && (body.success === undefined || body.success === true) && !body.errorReason && !body.invalidReason && !body.error && txHash &&
      (body.network === undefined || body.network === network.caip2)) return txHash;
  if (txHash) {
    // A hash on an unsuccessful response may name a broadcast transaction.
    // Even authorizationState=false cannot exclude an unmined transaction.
    throw new FacilitatorSettlementError(`facilitator ${url}: transaction reported with unresolved settlement on ${network.id}`, false, 'settlement_unknown', txHash);
  }
  if (reason === 'invalid_exact_evm_nonce_already_used' || /authorization.*(?:already.*used|used or cancel|cancelled|canceled)/i.test(text)) {
    throw new FacilitatorSettlementError(`facilitator ${url}: authorization already used or canceled on ${network.id}; settlement outcome requires reconciliation`, false, 'settlement_unknown');
  }

  // Dexter wraps USDC reverts in HTTP 500. Status alone cannot distinguish
  // a provider outage from a payment that would fail with every provider.
  const paymentRejected = /transfer amount exceeds balance|insufficient[_ ]balance|invalid.*signature|signature.*invalid|authorization.*(?:expired|not.*valid|used|canceled)|valid_before|valid_after/i.test(text) ||
    !!reason?.startsWith('invalid_');
  const retryable = !paymentRejected && (response.status === 429 || response.status >= 500 || response.ok);
  // Only emit fixed classifications, never even a code-looking provider value.
  // A provider can echo a hex signature in errorReason as well as in its message.
  const detail = /transfer amount exceeds balance|insufficient[_ ]balance/i.test(text) ? 'insufficient_balance' :
    /invalid.*signature|signature.*invalid/i.test(text) ? 'invalid_signature' :
    paymentRejected ? 'payment_rejected' : 'invalid_settlement_response';
  throw new FacilitatorSettlementError(`facilitator ${url}: HTTP ${response.status} ${detail} on ${network.id}`, retryable);
}

/** Only resubmit an unchanged EIP-3009 authorization on its original chain. */
async function checkUnusedAuthorization(payload: unknown, requirements: unknown, network: PaymentNetwork): Promise<void> {
  const parsed = authorizationSchema.safeParse(payload);
  const offer = offerSchema.safeParse(requirements);
  if (!parsed.success || !offer.success) {
    throw new FacilitatorSettlementError('Failover requires an x402 v2 exact EIP-3009 authorization', false);
  }
  const { accepted, payload: { authorization } } = parsed.data;
  if (accepted.network !== network.caip2 || offer.data.network !== network.caip2 ||
      accepted.asset.toLowerCase() !== network.usdc.toLowerCase() || offer.data.asset.toLowerCase() !== network.usdc.toLowerCase() ||
      accepted.payTo.toLowerCase() !== offer.data.payTo.toLowerCase() || authorization.to.toLowerCase() !== offer.data.payTo.toLowerCase() ||
      BigInt(accepted.amount) !== BigInt(offer.data.amount) || BigInt(authorization.value) !== BigInt(offer.data.amount)) {
    throw new FacilitatorSettlementError('Failover authorization does not match the original network, asset, recipient and amount', false);
  }
  const client = createPublicClient({ transport: http(process.env[network.rpcEnv] || network.defaultRpc, { timeout: 5000, retryCount: 0 }) });
  let chainId: number;
  let used: boolean;
  try {
    chainId = await client.getChainId();
    if (chainId !== network.chainId) throw new Error('wrong chain');
    used = await client.readContract({
      address: network.usdc as Address,
      abi: [{ type: 'function', name: 'authorizationState', stateMutability: 'view', inputs: [{ name: 'authorizer', type: 'address' }, { name: 'nonce', type: 'bytes32' }], outputs: [{ name: 'used', type: 'bool' }] }],
      functionName: 'authorizationState', args: [authorization.from as Address, authorization.nonce as Hex],
    });
  } catch {
    throw new FacilitatorSettlementError(`Cannot check authorization state on chain ${network.chainId}; settlement outcome is unknown`, false, 'settlement_unknown');
  }
  if (used) {
    throw new FacilitatorSettlementError('Authorization already used or canceled; settlement outcome requires reconciliation, no backup submitted', false, 'settlement_unknown');
  }
}

export async function settleWithFacilitator(payload: unknown, requirements: unknown, network: PaymentNetwork): Promise<SettleOutcome> {
  if (!network.facilitatorUrl) throw new Error(`${network.id} has no facilitatorUrl`);
  const urls = [...new Set([network.facilitatorUrl, network.fallbackFacilitatorUrl].filter((url): url is string => !!url).map(providerUrl))];
  const timeout = timeoutMs();
  // Serialized once, so failover cannot change a nonce, signature or payment term.
  const requestBody = JSON.stringify({ x402Version: 2, paymentPayload: payload, paymentRequirements: requirements });
  const failures: string[] = [];
  for (let index = 0; index < urls.length; index++) {
    const url = urls[index];
    try {
      const txHash = await submit(url, requestBody, network, timeout);
      log.info({ action: 'payment.facilitator.settled', network: network.id, facilitatorUrl: url, fallback: index > 0, txHash }, 'Facilitator settled authorization');
      return { txHash, via: 'facilitator', facilitatorUrl: url };
    } catch (error) {
      if (!(error instanceof FacilitatorSettlementError)) throw error;
      failures.push(error.message);
      log.warn({ action: 'payment.facilitator.failed', network: network.id, facilitatorUrl: url, reason: error.reason, retryable: error.retryable, message: error.message }, 'Facilitator settlement failed');
      if (!error.retryable) throw error;
      if (index + 1 < urls.length) {
        await checkUnusedAuthorization(payload, requirements, network);
        log.warn({ action: 'payment.facilitator.fallback', network: network.id, from: url, to: urls[index + 1] }, 'Trying backup with the same authorization');
      }
    }
  }
  // A failed HTTP exchange is not proof that no transaction was broadcast.
  throw new FacilitatorSettlementError(failures.join('; '), false, 'settlement_unknown');
}
