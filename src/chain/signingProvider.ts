import { ethers } from 'ethers';

/**
 * A JSON-RPC provider for a wallet that sends transactions: one request per
 * HTTP call, never a batch.
 *
 * ethers batches concurrent calls, so a send goes out as
 * `[eth_blockNumber, eth_sendRawTransaction]`. The Tenderly gateway that serves
 * Base Mainnet in production answers that batch with HTTP 429 "rate limit
 * exceeded" every time -- reads batched together are fine -- and ethers treats
 * a 429 as throttling and retries until its own timeout. On 2026-10-13 that
 * hung the Base ERC-8004 metadata update for 120 s on two deploys in a row
 * while the same transaction, sent alone, was answered in 0.3 s.
 */
export function signingProvider(rpcUrl: string, options: ethers.JsonRpcApiProviderOptions = {}): ethers.JsonRpcProvider {
  return new ethers.JsonRpcProvider(rpcUrl, undefined, { ...options, batchMaxCount: 1 });
}
