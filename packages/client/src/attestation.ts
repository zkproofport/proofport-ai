import { ethers } from 'ethers';
import { CIRCUITS, COINBASE_ATTESTER_CONTRACT, DEFAULT_EAS_GRAPHQL, DEFAULT_EAS_RPC } from './constants.js';
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
 * Includes retry logic for 429/5xx responses with exponential backoff.
 */
export async function fetchRawTransaction(
  rpcUrl: string,
  txHash: string,
): Promise<string> {
  let lastError: Error | undefined;

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
        throw new Error(`Transaction ${txHash} not found`);
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

  // Check destination
  if (!tx.to || tx.to.toLowerCase() !== COINBASE_ATTESTER_CONTRACT.toLowerCase()) {
    return {
      valid: false,
      error: `Transaction destination ${tx.to} does not match Coinbase Attester Contract ${COINBASE_ATTESTER_CONTRACT}`,
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
export async function fetchAttestation(
  config: ClientConfig,
  circuitId: CircuitId,
  recipientAddress: string,
): Promise<AttestationData> {
  const easGraphqlUrl = config.easGraphqlUrl || DEFAULT_EAS_GRAPHQL;
  const easRpcUrl = config.easRpcUrl || DEFAULT_EAS_RPC;

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
