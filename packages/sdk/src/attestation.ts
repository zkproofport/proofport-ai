import { ethers } from 'ethers';
import {
  CIRCUITS,
  DEFAULT_EAS_GRAPHQL,
  DEFAULT_EAS_RPC,
  attestationSource,
} from './constants.js';
import type { AttestationSource } from './constants.js';
import type { CircuitId, EASAttestation, AttestationData, ClientConfig } from './types.js';

// ─── GraphQL query ──────────────────────────────────────────────────────

const EAS_ATTESTATIONS_QUERY = `
  query GetAttestations($schemaId: String!, $recipient: String!) {
    attestations(
      where: {
        schemaId: { equals: $schemaId }
        recipient: { equals: $recipient }
        revoked: { equals: false }
      }
      orderBy: [{ time: desc }]
      take: 1
    ) {
      id
      txid
      recipient
      attester
      time
      expirationTime
      schemaId
    }
  }
`;

// ─── Retry constants ────────────────────────────────────────────────────

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

// Public RPCs (e.g. base.org, base-sepolia) can take 5-30s to index a freshly
// submitted attestation tx. Retry the "result is null" case separately with a
// larger budget so generateProof doesn't fail immediately after the customer
// submits their attestation transaction.
const TX_INDEX_MAX_RETRIES = 15;
const TX_INDEX_DELAY_MS = 2000;

// ─── EAS GraphQL fetch ──────────────────────────────────────────────────

/**
 * Query EAS GraphQL for the latest attestation matching schemaId + recipient.
 */
export async function fetchAttestationFromEAS(
  easGraphqlUrl: string,
  circuitId: CircuitId,
  recipientAddress: string,
): Promise<EASAttestation> {
  const circuit = CIRCUITS[circuitId];
  const schemaId = circuit.easSchemaId;

  const response = await fetch(easGraphqlUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: EAS_ATTESTATIONS_QUERY,
      variables: {
        schemaId,
        recipient: recipientAddress.toLowerCase(),
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`EAS GraphQL request failed: HTTP ${response.status}`);
  }

  const data = await response.json();

  if (data.errors && data.errors.length > 0) {
    throw new Error(`EAS GraphQL error: ${data.errors[0].message}`);
  }

  const attestations = data.data?.attestations;
  if (!attestations || attestations.length === 0) {
    throw new Error(
      `No attestation found for schema ${schemaId} and recipient ${recipientAddress}`,
    );
  }

  return attestations[0];
}

// ─── Raw transaction fetch ──────────────────────────────────────────────

/**
 * Fetch raw transaction via eth_getTransactionByHash from an RPC endpoint.
 *
 * Retry policy:
 *   - HTTP 429/5xx, ECONNRESET, ETIMEDOUT: MAX_RETRIES (3) attempts, 1s base delay (transient network).
 *   - data.result === null (tx not yet indexed): TX_INDEX_MAX_RETRIES (15) attempts, 2s delay.
 *     Public RPCs (base.org, base-sepolia) need 5-30s to index a freshly submitted attestation tx.
 */
export async function fetchRawTransaction(
  rpcUrl: string,
  txHash: string,
): Promise<string> {
  let lastError: Error | undefined;
  let indexAttempts = 0;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'eth_getTransactionByHash',
          params: [txHash],
        }),
      });

      if (!response.ok) {
        if (RETRYABLE_STATUS.has(response.status) && attempt < MAX_RETRIES - 1) {
          lastError = new Error(`RPC request failed: HTTP ${response.status}`);
          await new Promise(r => setTimeout(r, RETRY_DELAY_MS * (attempt + 1)));
          continue;
        }
        throw new Error(`RPC request failed: HTTP ${response.status}`);
      }

      const data = await response.json();

      if (data.error) {
        throw new Error(`RPC error: ${data.error.message}`);
      }

      if (!data.result) {
        // Transaction not yet indexed — retry up to TX_INDEX_MAX_RETRIES times
        // with a longer delay, since public RPCs can lag 5-30s behind the mempool.
        if (indexAttempts < TX_INDEX_MAX_RETRIES) {
          indexAttempts++;
          await new Promise(r => setTimeout(r, TX_INDEX_DELAY_MS));
          attempt--;  // do not consume an outer retry slot for indexing waits
          continue;
        }
        throw new Error(
          `Transaction ${txHash} not found after ${TX_INDEX_MAX_RETRIES} retries (${(TX_INDEX_MAX_RETRIES * TX_INDEX_DELAY_MS) / 1000}s)`,
        );
      }

      return reconstructRawTransaction(data.result);
    } catch (err) {
      lastError = err as Error;
      const cause = (err as any)?.cause?.code;
      if (attempt < MAX_RETRIES - 1 && (cause === 'ECONNRESET' || cause === 'ETIMEDOUT')) {
        await new Promise(r => setTimeout(r, RETRY_DELAY_MS * (attempt + 1)));
        continue;
      }
      throw err;
    }
  }

  throw lastError || new Error(`RPC request failed after ${MAX_RETRIES} retries`);
}

// ─── Transaction reconstruction ─────────────────────────────────────────

/**
 * Reconstruct a raw signed transaction hex from RPC response fields.
 * Uses ethers v6 Transaction class. Returns tx.serialized (SIGNED).
 */
export function reconstructRawTransaction(txData: {
  to: string;
  nonce: string;
  gas: string;
  gasPrice?: string;
  maxFeePerGas?: string;
  maxPriorityFeePerGas?: string;
  input: string;
  value: string;
  chainId: string;
  type: string;
  v: string;
  r: string;
  s: string;
  accessList?: Array<{ address: string; storageKeys: string[] }>;
}): string {
  const txType = parseInt(txData.type, 16);

  const tx = ethers.Transaction.from({
    to: txData.to,
    nonce: parseInt(txData.nonce, 16),
    gasLimit: BigInt(txData.gas),
    maxFeePerGas: txData.maxFeePerGas ? BigInt(txData.maxFeePerGas) : undefined,
    maxPriorityFeePerGas: txData.maxPriorityFeePerGas ? BigInt(txData.maxPriorityFeePerGas) : undefined,
    gasPrice: txData.gasPrice ? BigInt(txData.gasPrice) : undefined,
    data: txData.input,
    value: BigInt(txData.value),
    chainId: BigInt(txData.chainId),
    type: txType,
    signature: {
      r: txData.r,
      s: txData.s,
      v: parseInt(txData.v, 16),
    },
    accessList: txData.accessList || [],
  });

  return tx.serialized;
}

// ─── Validation ─────────────────────────────────────────────────────────

/**
 * Validate the attestation transaction:
 * - tx.to matches COINBASE_ATTESTER_CONTRACT
 * - function selector matches the circuit's expected selector
 */
export function validateAttestationTx(
  rawTransaction: string,
  circuitId: CircuitId,
): { valid: boolean; error?: string } {
  const tx = ethers.Transaction.from(rawTransaction);

  // Check destination: the attester contract THIS circuit's attestation must
  // have been sent to, from the one table that knows.
  const expectedAttester = attestationSource(circuitId).contract;
  if (!tx.to || tx.to.toLowerCase() !== expectedAttester.toLowerCase()) {
    return {
      valid: false,
      error: `Transaction destination ${tx.to} does not match the attester contract for ${circuitId}: ${expectedAttester}`,
    };
  }

  // Check function selector
  const expectedSelector = CIRCUITS[circuitId].functionSelector;
  const actualSelector = tx.data.slice(0, 10);
  if (actualSelector !== expectedSelector) {
    return {
      valid: false,
      error: `Function selector ${actualSelector} does not match expected ${expectedSelector} for ${circuitId}`,
    };
  }

  return { valid: true };
}

// ─── Public key recovery ────────────────────────────────────────────────

/**
 * Recover the Coinbase attester's uncompressed public key from the transaction signature.
 * Returns "0x04..." (130 hex chars).
 */
export function recoverAttesterPubkey(rawTransaction: string): string {
  const tx = ethers.Transaction.from(rawTransaction);

  // Reconstruct unsigned tx to get the hash that was signed
  const unsignedTx = ethers.Transaction.from({
    to: tx.to,
    nonce: tx.nonce,
    gasLimit: tx.gasLimit,
    maxFeePerGas: tx.maxFeePerGas,
    maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
    gasPrice: tx.gasPrice,
    data: tx.data,
    value: tx.value,
    chainId: tx.chainId,
    type: tx.type,
    accessList: tx.accessList,
  });

  const unsignedTxHash = ethers.keccak256(unsignedTx.unsignedSerialized);

  if (!tx.signature) {
    throw new Error('Transaction has no signature');
  }

  const pubkey = ethers.SigningKey.recoverPublicKey(unsignedTxHash, tx.signature);
  return pubkey;
}

/**
 * Get the signer address from a recovered public key.
 */
export function getSignerAddress(pubkey: string): string {
  return ethers.computeAddress(pubkey);
}

// ─── Full pipeline ──────────────────────────────────────────────────────

/**
 * Full attestation fetch pipeline:
 * 1. Query EAS GraphQL for the latest attestation
 * 2. Fetch the raw transaction from RPC
 * 3. Validate transaction fields
 * 4. Return attestation + raw transaction
 */
/**
 * The GIWA attestation for a wallet, found by reading our attester's own calls.
 *
 * Not an EAS query: GIWA's attester is ours on GIWA Sepolia and nothing indexes
 * it. Asking Base's EAS for a GIWA wallet does not fail cleanly either -- the
 * schema id is absent, so the request comes back HTTP 400 and reads like a
 * broken endpoint rather than "wrong chain".
 */
async function fetchGiwaAttestation(
  source: Extract<AttestationSource, { kind: 'giwa-sepolia' }>,
  recipientAddress: string,
): Promise<AttestationData> {
  const attester = ethers.getAddress(source.signers[0]);
  const wanted = ethers.getAddress(recipientAddress);

  const listUrl =
    `${source.explorer}/api?module=account&action=txlist` +
    `&address=${attester}&sort=desc&page=1&offset=100`;
  const listResponse = await fetch(listUrl);
  if (!listResponse.ok) {
    throw new Error(`GIWA explorer request failed: HTTP ${listResponse.status}`);
  }
  const listBody = (await listResponse.json()) as { result?: unknown };
  const calls = Array.isArray(listBody.result)
    ? (listBody.result as Array<{ hash: string; to: string | null; input: string }>)
    : [];

  const ATTEST_ACCOUNT = '0x56feed5e';
  const match = calls.find((tx) => {
    if (!tx.to || ethers.getAddress(tx.to) !== ethers.getAddress(source.contract)) return false;
    if (!tx.input?.toLowerCase().startsWith(ATTEST_ACCOUNT) || tx.input.length < 74) return false;
    try {
      return ethers.getAddress('0x' + tx.input.slice(34, 74)) === wanted;
    } catch {
      return false;
    }
  });
  if (!match) {
    throw new Error(
      `No GIWA attestation found for ${recipientAddress} on GIWA Sepolia. ` +
      'This is not a Coinbase attestation -- the wallet must be attested by GIWA.',
    );
  }

  const rawTransaction = await fetchRawTransaction(source.rpc, match.hash);
  return {
    attestation: {
      id: match.hash,
      txid: match.hash,
      recipient: wanted,
      attester,
      time: 0,
      expirationTime: 0,
      schemaId: '',
    },
    rawTransaction,
  };
}

export async function fetchAttestation(
  config: ClientConfig,
  circuitId: CircuitId,
  recipientAddress: string,
): Promise<AttestationData> {
  // Which chain attests THIS circuit, and how it is found. Coinbase's are
  // indexed by EAS on Base Mainnet; GIWA's are not indexed at all, so they are
  // read from our attester's own calls.
  const source = attestationSource(circuitId);
  if (source.kind === 'giwa-sepolia') {
    return fetchGiwaAttestation(source, recipientAddress);
  }

  // EAS attestations are ALWAYS on Base Mainnet — never configurable
  const easGraphqlUrl = DEFAULT_EAS_GRAPHQL;
  const easRpcUrl = DEFAULT_EAS_RPC;

  // Step 1: Query EAS
  const attestation = await fetchAttestationFromEAS(
    easGraphqlUrl,
    circuitId,
    recipientAddress,
  );

  // Step 2: Fetch raw TX
  const rawTransaction = await fetchRawTransaction(easRpcUrl, attestation.txid);

  // Step 3: Validate
  const validation = validateAttestationTx(rawTransaction, circuitId);
  if (!validation.valid) {
    throw new Error(`Attestation TX validation failed: ${validation.error}`);
  }

  return {
    attestation,
    rawTransaction,
  };
}
