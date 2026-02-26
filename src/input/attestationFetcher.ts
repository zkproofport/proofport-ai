import { ethers } from 'ethers';
import { CIRCUITS, type CircuitId } from '../config/circuits.js';
import { COINBASE_ATTESTER_CONTRACT } from '../config/contracts.js';

/**
 * EAS GraphQL query result shape.
 */
export interface EASAttestation {
  id: string;
  txid: string;
  recipient: string;
  attester: string;
  time: number;
  expirationTime: number;
  schemaId: string;
}

/**
 * Fetched attestation transaction data.
 */
export interface AttestationTxData {
  attestation: EASAttestation;
  rawTransaction: string;
  txBytes: Uint8Array;
}

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

/**
 * Step 3a: Query EAS GraphQL for the latest attestation matching schemaId + recipient.
 */
export async function fetchAttestationFromEAS(
  easGraphqlEndpoint: string,
  circuitId: CircuitId,
  recipientAddress: string,
): Promise<EASAttestation> {
  const circuit = CIRCUITS[circuitId];
  const schemaId = circuit.easSchemaId;

  const response = await fetch(easGraphqlEndpoint, {
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
      `No attestation found for schema ${schemaId} and recipient ${recipientAddress}`
    );
  }

  return attestations[0];
}

/**
 * Step 3b: Fetch raw transaction via eth_getTransactionByHash from Base RPC.
 * Uses Promise.any with multiple RPC endpoints for redundancy.
 */
export async function fetchRawTransaction(
  rpcUrls: string[],
  txHash: string,
): Promise<string> {
  if (rpcUrls.length === 0) {
    throw new Error('No RPC URLs provided');
  }

  const MAX_RETRIES = 3;
  const RETRY_DELAY_MS = 1000;
  const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

  const fetchFromRpc = async (rpcUrl: string): Promise<string> => {
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
            lastError = new Error(`RPC request to ${rpcUrl} failed: HTTP ${response.status}`);
            await new Promise(r => setTimeout(r, RETRY_DELAY_MS * (attempt + 1)));
            continue;
          }
          throw new Error(`RPC request to ${rpcUrl} failed: HTTP ${response.status}`);
        }

        const data = await response.json();

        if (data.error) {
          throw new Error(`RPC error from ${rpcUrl}: ${data.error.message}`);
        }

        if (!data.result) {
          throw new Error(`Transaction ${txHash} not found on ${rpcUrl}`);
        }

        // Reconstruct the raw signed transaction from the RPC response fields
        const tx = data.result;
        const rawTx = reconstructRawTransaction(tx);
        return rawTx;
      } catch (err) {
        lastError = err as Error;
        // Only retry on network-level errors (fetch failures), not logic errors
        if (attempt < MAX_RETRIES - 1 && (err as any)?.cause?.code === 'ECONNRESET' || (err as any)?.cause?.code === 'ETIMEDOUT') {
          await new Promise(r => setTimeout(r, RETRY_DELAY_MS * (attempt + 1)));
          continue;
        }
        throw err;
      }
    }

    throw lastError || new Error(`RPC request to ${rpcUrl} failed after ${MAX_RETRIES} retries`);
  };

  if (rpcUrls.length === 1) {
    return fetchFromRpc(rpcUrls[0]);
  }

  // Use Promise.any for redundancy across multiple RPCs
  return Promise.any(rpcUrls.map(url => fetchFromRpc(url)));
}

/**
 * Reconstruct a raw signed transaction hex from RPC response fields.
 * Uses ethers v6 Transaction class.
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

/**
 * Step 3c-3d: Validate the attestation transaction.
 * - Verify tx.to matches COINBASE_ATTESTER_CONTRACT
 * - Verify function selector matches expected circuit selector
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

/**
 * Step 4: Recover the Coinbase attester public key from the transaction signature.
 * Returns uncompressed public key "0x04..." (130 hex chars).
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
 * Get the signer address from the recovered public key.
 */
export function getSignerAddress(pubkey: string): string {
  return ethers.computeAddress(pubkey);
}

/**
 * Full attestation fetch pipeline: EAS query -> RPC fetch -> validate -> return data.
 */
export async function fetchAttestationData(
  easGraphqlEndpoint: string,
  rpcUrls: string[],
  circuitId: CircuitId,
  recipientAddress: string,
): Promise<AttestationTxData> {
  // Step 3a: Query EAS
  const attestation = await fetchAttestationFromEAS(
    easGraphqlEndpoint,
    circuitId,
    recipientAddress,
  );

  // Step 3b: Fetch raw TX
  const rawTransaction = await fetchRawTransaction(rpcUrls, attestation.txid);

  // Step 3c-3d: Validate
  const validation = validateAttestationTx(rawTransaction, circuitId);
  if (!validation.valid) {
    throw new Error(`Attestation TX validation failed: ${validation.error}`);
  }

  // Convert to bytes for the input vector
  const cleanHex = rawTransaction.startsWith('0x') ? rawTransaction.slice(2) : rawTransaction;
  const txBytes = ethers.getBytes('0x' + cleanHex);

  return {
    attestation,
    rawTransaction,
    txBytes,
  };
}
