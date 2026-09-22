/**
 * Finding a wallet's GIWA attestation, which is not an EAS lookup.
 *
 * Coinbase's attestations are indexed by EAS on Base and read with a GraphQL
 * query. GIWA's attester is ours -- `MockGiwaAttester` on GIWA Sepolia -- and
 * nothing indexes it, so the transaction is found by reading the attester's own
 * call list. Asking Coinbase's EAS for a GIWA wallet does not error: it returns
 * nothing, which reads as "this wallet is not attested".
 *
 * The explorer is Blockscout, whose account API answers the attester's
 * transaction list in one call. An RPC block scan is the fallback, bounded
 * because a full-chain scan is not something a request should wait on.
 */
import { ethers } from 'ethers';
import { GIWA_ATTESTER_CONTRACT } from '../config/contracts.js';
import { GIWA_AUTHORIZED_SIGNERS } from '../config/contracts.js';
import { reconstructRawTransaction } from './attestationFetcher.js';

/** `attestAccount(address)` -- the same selector the Coinbase attester uses. */
const ATTEST_ACCOUNT_SELECTOR = '0x56feed5e';

export interface GiwaAttestationTx {
  txHash: string;
  rawTransaction: string;
  attestedAddress: string;
}

/** The attested address in an `attestAccount(address)` call, or null. */
function attestedAddressOf(input: string): string | null {
  if (!input || !input.toLowerCase().startsWith(ATTEST_ACCOUNT_SELECTOR)) return null;
  // selector (10 chars incl. 0x) + a 32-byte word whose last 20 bytes are the
  // address.
  if (input.length < 10 + 64) return null;
  try {
    return ethers.getAddress('0x' + input.slice(34, 74));
  } catch {
    return null;
  }
}

async function jsonRpc(rpcUrl: string, method: string, params: unknown[]): Promise<unknown> {
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!response.ok) {
    throw new Error(`GIWA RPC ${method} failed: HTTP ${response.status}`);
  }
  const body = (await response.json()) as { result?: unknown; error?: { message: string } };
  if (body.error) throw new Error(`GIWA RPC ${method} failed: ${body.error.message}`);
  return body.result;
}

/** The attester's transactions, newest first, from the Blockscout account API. */
async function attesterCalls(explorerUrl: string, attester: string): Promise<Array<{ hash: string; to: string | null; input: string }>> {
  const url =
    `${explorerUrl.replace(/\/$/, '')}/api?module=account&action=txlist` +
    `&address=${attester}&sort=desc&page=1&offset=100`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`GIWA explorer returned HTTP ${response.status} for the attester's transactions`);
  }
  const body = (await response.json()) as { status?: string; result?: unknown };
  if (!Array.isArray(body.result)) {
    // status "0" with a message is how Blockscout says "no transactions", which
    // is a real answer and not a failure.
    return [];
  }
  return body.result as Array<{ hash: string; to: string | null; input: string }>;
}

/**
 * The attestation transaction for `walletAddress`, or null when there is none.
 *
 * `null` is a real answer here -- a wallet nobody has attested -- and is left
 * for the caller to turn into the error its own context deserves.
 */
export async function findGiwaAttestation(
  explorerUrl: string,
  rpcUrl: string,
  walletAddress: string,
): Promise<GiwaAttestationTx | null> {
  const wanted = ethers.getAddress(walletAddress);
  const attester = ethers.getAddress(GIWA_AUTHORIZED_SIGNERS[0]);

  const calls = await attesterCalls(explorerUrl, attester);
  const match = calls.find((tx) => {
    if (!tx.to || ethers.getAddress(tx.to) !== ethers.getAddress(GIWA_ATTESTER_CONTRACT)) {
      return false;
    }
    return attestedAddressOf(tx.input) === wanted;
  });
  if (!match) return null;

  const tx = (await jsonRpc(rpcUrl, 'eth_getTransactionByHash', [match.hash])) as {
    to: string; nonce: string; gas: string; gasPrice?: string;
    maxFeePerGas?: string; maxPriorityFeePerGas?: string;
    input: string; value: string; chainId: string; type: string;
    v: string; r: string; s: string;
    accessList?: Array<{ address: string; storageKeys: string[] }>;
  } | null;
  if (!tx) {
    throw new Error(`GIWA attestation ${match.hash} is in the explorer but not on the node`);
  }

  return {
    txHash: match.hash,
    rawTransaction: reconstructRawTransaction(tx),
    attestedAddress: wanted,
  };
}
