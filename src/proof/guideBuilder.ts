import { CIRCUITS, type CircuitId } from '../config/circuits.js';
import { AUTHORIZED_SIGNERS, COINBASE_ATTESTER_CONTRACT, VERIFIER_ADDRESSES } from '../config/contracts.js';
import type { Config } from '../config/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function derivePaymentConstants(config: Config) {
  const isTestnet = config.paymentMode === 'testnet';
  const chainId = isTestnet ? 84532 : 8453;
  const usdcAddress = isTestnet
    ? '0x036CbD53842c5426634e7929541eC2318f3dCF7e'
    : '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

  // paymentProofPrice is e.g. "$0.10" -- parse to USDC base units (6 decimals)
  const priceStr = config.paymentProofPrice.replace(/[^0-9.]/g, '');
  const paymentAmount = String(Math.round(parseFloat(priceStr) * 1e6));

  return { isTestnet, chainId, usdcAddress, paymentAmount };
}

function circuitAlias(circuitId: CircuitId): string {
  return circuitId === 'coinbase_attestation' ? 'coinbase_kyc' : 'coinbase_country';
}

// ---------------------------------------------------------------------------
// Section builders
// ---------------------------------------------------------------------------


function buildConstants(
  config: Config,
  circuitId: CircuitId,
  isTestnet: boolean,
  chainId: number,
  usdcAddress: string,
  paymentAmount: string,
) {
  const circuit = CIRCUITS[circuitId];
  const chainVerifiers = VERIFIER_ADDRESSES[String(chainId)] || {};
  const verifierAddr = chainVerifiers[circuitId] || 'NOT_DEPLOYED';

  return {
    eas: {
      graphql_endpoint: config.easGraphqlEndpoint,
      schema_id: circuit.easSchemaId,
    },
    contracts: {
      coinbase_attester: COINBASE_ATTESTER_CONTRACT,
      function_selector: circuit.functionSelector,
      verifier_address: verifierAddr,
      chain_id: chainId,
    },
    authorized_signers: AUTHORIZED_SIGNERS,
    payment: {
      recipient: config.paymentPayTo,
      amount: paymentAmount,
      asset: usdcAddress,
      network: isTestnet ? 'base-sepolia' : 'base',
      currency: 'USDC',
      decimals: 6,
      testnet_note: 'Base Sepolia USDC does NOT support EIP-3009. Testnet uses direct transfer() + nonce in calldata instead of x402.',
    },
    rpc: {
      eas_rpc_url: config.baseRpcUrl,
      eas_rpc_chain: 'Base Mainnet (chain ID 8453)',
      eas_rpc_note: 'Used for Steps 2-5: EAS attestation query, raw TX fetch, attester pubkey recovery, Merkle proof. EAS attestations are ALWAYS on Base Mainnet regardless of payment chain.',
      payment_rpc_url: config.chainRpcUrl,
      payment_rpc_chain: isTestnet ? 'Base Sepolia (chain ID 84532)' : 'Base Mainnet (chain ID 8453)',
      payment_rpc_note: 'Used for Steps 10-12: x402 payment settlement and on-chain proof verification.',
    },
    x402: {
      facilitator_url: 'https://www.x402.org/facilitator',
      settle_endpoint: 'https://www.x402.org/facilitator/settle',
      protocol: 'EIP-3009 TransferWithAuthorization',
      description: 'Client signs EIP-712 authorization, facilitator settles on-chain (facilitator pays gas)',
      testnet_note: 'x402/EIP-3009 is NOT available on Base Sepolia. Testnet uses direct transfer() instead.',
      single_step_flow: {
        description: 'x402 single-step flow for clients that do not use sessions. POST /prove with circuit + inputs → receive 402 with nonce in response body → client signs payment → retry with X-Payment-TX and X-Payment-Nonce headers.',
        nonce_details: 'Server returns 32-byte nonce in 402 response body. Client must include nonce in retry as X-Payment-Nonce header. Nonce is single-use (consumed on first successful payment verification). Nonce is circuit-bound (cannot reuse a coinbase_kyc nonce for coinbase_country).',
      },
    },
    verification: {
      description: 'On-chain proof verification using deployed Solidity verifier contracts',
      verifier_address: verifierAddr,
      chain_id: chainId,
      chain_name: isTestnet ? 'Base Sepolia' : 'Base',
      function_signature: 'verify(bytes calldata _proof, bytes32[] calldata _publicInputs) external view returns (bool)',
      input_format: 'proof and publicInputs are separate fields. Split publicInputs hex blob into 32-byte (bytes32) chunks.',
    },
  };
}

function buildFormulas(circuitId: CircuitId) {
  return {
    signal_hash: {
      description:
        'Binds the proof to a specific user address, scope string, and circuit. Used as the message the user signs.',
      formula: 'signal_hash = keccak256(abi.encodePacked(userAddress, scope, circuitId))',
      ethers_v6_code: `ethers.keccak256(ethers.solidityPacked(['address', 'string', 'string'], [userAddress, scope, '${circuitId}']))`,
    },
    scope_bytes: {
      description:
        'The keccak256 hash of the scope string. Scopes partition nullifiers so the same user can prove once per scope.',
      formula: 'scope_bytes = keccak256(toUtf8Bytes(scope))',
      ethers_v6_code: `ethers.keccak256(ethers.toUtf8Bytes(scope))`,
    },
    nullifier: {
      description:
        'Prevents double-proving for the same user + scope. Deterministic from address, signal_hash, and scope_bytes.',
      formula: 'nullifier = keccak256(keccak256(address_bytes || signal_hash_bytes) || scope_bytes_bytes)',
      ethers_v6_code: [
        `const userSecret = ethers.keccak256(ethers.concat([ethers.getBytes(userAddress), ethers.getBytes(signal_hash)]));`,
        `const nullifier = ethers.keccak256(ethers.concat([ethers.getBytes(userSecret), ethers.getBytes(scope_bytes)]));`,
      ].join('\n'),
    },
    merkle_leaf: {
      description:
        'Each leaf in the authorized-signers Merkle tree is the keccak256 hash of the checksum-encoded address bytes.',
      formula: 'leaf = keccak256(address_bytes_20)',
      ethers_v6_code: `ethers.keccak256(ethers.getBytes(ethers.getAddress(signerAddress)))`,
    },
    merkle_tree: {
      description:
        'Binary Merkle tree built bottom-up. Each internal node = keccak256(left_child || right_child). ' +
        'If a layer has an odd number of nodes, the last node is duplicated as its own sibling. ' +
        'The proof is the list of sibling hashes from leaf to root.',
      formula: 'node = keccak256(left || right); if odd count, right = left for last pair',
      ethers_v6_code: `ethers.keccak256(ethers.concat([ethers.getBytes(left), ethers.getBytes(right)]))`,
    },
  };
}

function buildCodeExamples(config: Config, circuitId: CircuitId, usdcAddress: string, chainId: number, paymentAmount: string) {
  const circuit = CIRCUITS[circuitId];
  return {
    eas_query: {
      description: 'GraphQL query to find attestations from EAS',
      language: 'graphql',
      code: `\
query GetAttestation($schemaId: String!, $recipient: String!) {
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
    attester
    recipient
    time
  }
}`,
    },
    raw_tx_extraction: {
      description: 'Extract signed RLP-encoded transaction bytes (EIP-1559, 12 fields)',
      language: 'typescript',
      code: `\
const tx = await provider.getTransaction(txid);
const rawTx = ethers.Transaction.from(tx).serialized;
const rawTxBytes = ethers.getBytes(rawTx);
const tx_length = rawTxBytes.length;
const raw_transaction = ethers.hexlify(rawTxBytes);`,
    },
    pubkey_recovery: {
      description: 'Recover uncompressed secp256k1 public key from a transaction',
      language: 'typescript',
      code: `\
const unsignedTx = ethers.Transaction.from(txResponse);
const unsignedHash = ethers.keccak256(unsignedTx.unsignedSerialized);
const pubkey = ethers.SigningKey.recoverPublicKey(unsignedHash, txResponse.signature);
// pubkey = "0x04" + x (64 hex) + y (64 hex)
const x = '0x' + pubkey.slice(4, 68);
const y = '0x' + pubkey.slice(68, 132);`,
    },
    user_signature: {
      description: 'User signs signal_hash via personal_sign and recover public key',
      language: 'typescript',
      code: `\
const signature = await wallet.signMessage(ethers.getBytes(signal_hash));
const ethSignedHash = ethers.hashMessage(ethers.getBytes(signal_hash));
const userPubkey = ethers.SigningKey.recoverPublicKey(ethSignedHash, signature);`,
    },
    payment: {
      description: 'USDC payment. Testnet (Base Sepolia): direct transfer() + nonce in calldata (no EIP-3009 support). Mainnet (Base): x402 facilitator with EIP-3009 TransferWithAuthorization (facilitator pays gas).',
      language: 'typescript',
      code: `\
// === MAINNET (Base): x402 facilitator with EIP-3009 ===
// 1. Sign EIP-712 TransferWithAuthorization
const domain = { name: '${chainId === 84532 ? 'USDC' : 'USD Coin'}', version: '2', chainId: ${chainId}, verifyingContract: USDC_ADDRESS };
const types = { TransferWithAuthorization: [
  { name: 'from', type: 'address' }, { name: 'to', type: 'address' },
  { name: 'value', type: 'uint256' }, { name: 'validAfter', type: 'uint256' },
  { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
]};
const nonce = ethers.zeroPadValue(paymentNonce, 32); // bytes32 — paymentNonce from Step 1 (402 response)
const sig = await wallet.signTypedData(domain, types, { from, to, value, validAfter: 0, validBefore, nonce });

// 2. Settle via x402 facilitator (Coinbase x402 v1 API format)
const res = await fetch('https://www.x402.org/facilitator/settle', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    x402Version: 1,
    paymentPayload: { x402Version: 1, scheme: 'exact', network: 'base',
      payload: { signature: sig, authorization: { from, to, value: String(value),
        validAfter: '0', validBefore: String(validBefore), nonce } } },
    paymentRequirements: { scheme: 'exact', network: 'base', maxAmountRequired: String(value),
      resource: '${config.a2aBaseUrl}/api/v1/prove', payTo: to, asset: '${usdcAddress}',
      extra: { name: '${chainId === 84532 ? 'USDC' : 'USD Coin'}', version: '2' } },
  }),
});
const payment_tx_hash = (await res.json()).txHash;

// === TESTNET (Base Sepolia): direct transfer() + nonce in calldata ===
// const iface = new ethers.Interface(['function transfer(address to, uint256 amount) returns (bool)']);
// const transferData = iface.encodeFunctionData('transfer', [payment.recipient, payment.amount]);
// const dataWithNonce = transferData + payment.nonce.slice(2);
// const tx = await payerWallet.sendTransaction({ to: USDC_ADDRESS, data: dataWithNonce });
// const payment_tx_hash = tx.hash;`,
    },
    x402_curl: {
      description: 'cURL example for x402 facilitator /settle call (for testing/debugging)',
      language: 'bash',
      code: `\
# After obtaining the EIP-712 signature from the user's wallet:
curl -X POST https://www.x402.org/facilitator/settle \\
  -H "Content-Type: application/json" \\
  -d '{
    "payload": {
      "signature": "0x<EIP-712-signature-hex>",
      "scheme": "exact",
      "networkId": "${chainId}",
      "authorization": {
        "from": "<user-address>",
        "to": "${config.paymentPayTo}",
        "value": "${paymentAmount}",
        "validAfter": "0",
        "validBefore": "<unix-timestamp-1h-from-now>",
        "nonce": "<session-nonce-zero-padded-to-32-bytes>"
      }
    },
    "accepted": {
      "scheme": "exact",
      "networkId": "${chainId}",
      "maxAmountRequired": "${paymentAmount}",
      "resource": "${config.a2aBaseUrl}/api/v1/prove",
      "description": "ZK proof generation payment",
      "mimeType": "application/json",
      "payTo": "${config.paymentPayTo}",
      "maxTimeoutSeconds": 300,
      "asset": "${usdcAddress}"
    }
  }'

# Expected response on success:
# { "success": true, "txHash": "0x..." }
# Use txHash as payment_tx_hash in Step 11 (retry with X-Payment-TX header)`,
    },
  };
}

function buildInputSchema(circuitId: CircuitId) {
  const baseFields = [
    {
      name: 'signal_hash',
      type: 'hex string',
      bytes: 32,
      description: 'keccak256(abi.encodePacked(userAddress, scope, circuitId)) -- binds proof to user + scope + circuit',
      how_to_obtain: 'Step 6: Compute Signal Hash',
    },
    {
      name: 'nullifier',
      type: 'hex string',
      bytes: 32,
      description: 'Double-proof prevention hash derived from user address, signal_hash, and scope_bytes',
      how_to_obtain: 'Step 9: Compute Scope & Nullifier',
    },
    {
      name: 'scope_bytes',
      type: 'hex string',
      bytes: 32,
      description: 'keccak256(toUtf8Bytes(scope)) -- hashed scope string',
      how_to_obtain: 'Step 9: Compute Scope & Nullifier',
    },
    {
      name: 'merkle_root',
      type: 'hex string',
      bytes: 32,
      description: 'Root of the Merkle tree over authorized Coinbase attester addresses',
      how_to_obtain: 'Step 5: Build Merkle Proof',
    },
    {
      name: 'user_address',
      type: 'hex string',
      bytes: 20,
      description: 'The Ethereum address of the user requesting the proof (checksummed or lowercase)',
      how_to_obtain: 'User wallet address',
    },
    {
      name: 'signature',
      type: 'hex string',
      bytes: 65,
      description: 'User personal_sign signature over signal_hash (r + s + v)',
      how_to_obtain: 'Step 7: Get User Signature',
    },
    {
      name: 'user_pubkey_x',
      type: 'hex string',
      bytes: 32,
      description: 'X coordinate of the user uncompressed secp256k1 public key',
      how_to_obtain: 'Step 8: Recover User Public Key',
    },
    {
      name: 'user_pubkey_y',
      type: 'hex string',
      bytes: 32,
      description: 'Y coordinate of the user uncompressed secp256k1 public key',
      how_to_obtain: 'Step 8: Recover User Public Key',
    },
    {
      name: 'raw_transaction',
      type: 'hex string',
      bytes: null as number | null,
      description: 'Signed RLP-encoded attestation transaction bytes (EIP-1559, 12 fields, variable length)',
      how_to_obtain: 'Step 3: Fetch Raw Transaction',
    },
    {
      name: 'tx_length',
      type: 'number',
      bytes: null as number | null,
      description: 'Byte length of raw_transaction',
      how_to_obtain: 'Step 3: Fetch Raw Transaction',
    },
    {
      name: 'coinbase_attester_pubkey_x',
      type: 'hex string',
      bytes: 32,
      description: 'X coordinate of the Coinbase attester uncompressed secp256k1 public key',
      how_to_obtain: 'Step 4: Recover Attester Public Key',
    },
    {
      name: 'coinbase_attester_pubkey_y',
      type: 'hex string',
      bytes: 32,
      description: 'Y coordinate of the Coinbase attester uncompressed secp256k1 public key',
      how_to_obtain: 'Step 4: Recover Attester Public Key',
    },
    {
      name: 'merkle_proof',
      type: 'hex string[]',
      bytes: 32,
      description: 'Array of sibling hashes from leaf to root in the authorized-signers Merkle tree',
      how_to_obtain: 'Step 5: Build Merkle Proof',
    },
    {
      name: 'leaf_index',
      type: 'number',
      bytes: null as number | null,
      description: 'Index of the attester in the AUTHORIZED_SIGNERS array (0-based)',
      how_to_obtain: 'Step 5: Build Merkle Proof',
    },
    {
      name: 'depth',
      type: 'number',
      bytes: null as number | null,
      description: 'Depth of the Merkle proof (number of sibling hashes)',
      how_to_obtain: 'Step 5: Build Merkle Proof',
    },
  ];

  const result: Record<string, unknown> = {
    fields: baseFields,
  };

  if (circuitId === 'coinbase_country_attestation') {
    result.country_fields = [
      {
        name: 'country_list',
        type: 'string[]',
        bytes: null,
        description: 'Array of ISO 3166-1 alpha-2 country codes to check against (e.g. ["US", "KR"])',
        how_to_obtain: 'Provided by the requesting application',
      },
      {
        name: 'is_included',
        type: 'boolean',
        bytes: null,
        description: 'true = prove the user IS in country_list, false = prove the user is NOT in country_list',
        how_to_obtain: 'Provided by the requesting application',
      },
    ];
  }

  return result;
}

function buildEndpoints(config: Config, circuitId: CircuitId) {
  const alias = circuitAlias(circuitId);
  return {
    prove: {
      method: 'POST',
      url: `${config.a2aBaseUrl}/api/v1/prove`,
      content_type: 'application/json',
      flow: 'x402 single-step: POST with {circuit, inputs} → 402 with nonce → pay → retry with X-Payment-TX and X-Payment-Nonce headers',
      timeout_hint: '30-90 seconds',
      description: 'Verifies payment on-chain and triggers ZK proof generation inside TEE',
    },
    guide: {
      method: 'GET',
      url: `${config.a2aBaseUrl}/api/v1/guide/${alias}`,
      description: 'Returns this guide as JSON (the document you are reading)',
    },
  };
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export function buildGuide(circuitId: CircuitId, config: Config): object {
  const circuit = CIRCUITS[circuitId];
  const { isTestnet, chainId, usdcAddress, paymentAmount } = derivePaymentConstants(config);

  return {
    circuit_id: circuitId,
    display_name: circuit.displayName,
    description: circuit.description,

    // PRIMARY RECOMMENDATION: Local MCP Server
    local_mcp_server: {
      recommended: true,
      description:
        'RECOMMENDED: Install and run the local MCP server. It handles all cryptographic computation, ' +
        'attestation fetching, payment, and proof submission automatically via MCP tools.',
      setup: {
        clone: 'git clone https://github.com/zkproofport/proofport-ai.git',
        install: 'cd proofport-ai && npm install && npx tsc -p packages/client',
        run: 'cd proofport-ai && ATTESTATION_KEY=0x... npx tsx packages/mcp-server/src/index.ts',
      },
      claude_desktop_config: {
        mcpServers: {
          proofport: {
            command: 'npx',
            args: ['tsx', 'packages/mcp-server/src/index.ts'],
            env: {
              ATTESTATION_KEY: '0x... (private key of wallet with Coinbase EAS attestation on Base)',
              PAYMENT_KEY: '0x... (optional: private key of wallet with USDC, defaults to ATTESTATION_KEY)',
              PROOFPORT_URL: config.a2aBaseUrl,
            },
          },
        },
      },
      env_vars: {
        ATTESTATION_KEY: {
          required: true,
          description: 'Private key of wallet with Coinbase EAS KYC attestation on Base. This wallet must have a valid, non-revoked Coinbase Verified Account attestation.',
        },
        PAYMENT_KEY: {
          required: false,
          description: 'Private key of wallet with USDC balance for proof payment. Defaults to ATTESTATION_KEY if not set. Can be a different wallet.',
        },
        PROOFPORT_URL: {
          required: false,
          default: config.a2aBaseUrl,
          description: 'ZKProofport server URL for remote proof generation in TEE.',
        },
        CDP_API_KEY_ID: {
          required: false,
          description: 'Coinbase Developer Platform API key ID. Set this instead of PAYMENT_KEY to use a CDP MPC wallet for payment.',
        },
        CDP_API_KEY_SECRET: {
          required: false,
          description: 'CDP API key secret.',
        },
        CDP_WALLET_SECRET: {
          required: false,
          description: 'CDP wallet encryption secret.',
        },
        CDP_WALLET_ADDRESS: {
          required: false,
          description: 'Existing CDP wallet address to reuse. If omitted, a new wallet is created.',
        },
      },
      tools: [
        'generate_proof — All-in-one: prepare inputs + pay + generate proof',
        'get_supported_circuits — List available circuits',
        'prepare_inputs — Step 1: Prepare all circuit inputs',
        'request_challenge — Step 2: Get 402 payment challenge',
        'make_payment — Step 3: Pay USDC via x402',
        'submit_proof — Step 4: Submit with payment to generate proof',
        'verify_proof — Step 5 (optional): Verify proof on-chain',
        'request_testnet_usdc — Fund wallet with testnet USDC via CDP faucet',
      ],
    },

    // ALTERNATIVE: SDK for programmatic use
    sdk: {
      package: '@proofport/client',
      repository: 'https://github.com/zkproofport/proofport-ai',
      note: 'Not yet published to npm. Clone the repository to use.',
      install: 'git clone https://github.com/zkproofport/proofport-ai.git && cd proofport-ai && npm install && npx tsc -p packages/client',
      description:
        'Use the @proofport/client SDK directly in your code for programmatic proof generation.',
      quick_start: `\
import { generateProof, fromPrivateKey } from '@proofport/client';

const attestationSigner = fromPrivateKey('0x...');  // wallet with Coinbase KYC attestation
const paymentSigner = fromPrivateKey('0x...');      // wallet with USDC balance (optional, defaults to attestation signer)

const result = await generateProof(
  { baseUrl: '${config.a2aBaseUrl}' },
  { attestation: attestationSigner, payment: paymentSigner },
  { circuit: '${circuitAlias(circuitId)}', scope: 'proofport' },
);

console.log(result.proof);           // ZK proof hex
console.log(result.publicInputs);    // public inputs hex
console.log(result.proofWithInputs); // combined for on-chain verify`,
      cli: `\
# Clone, install, and build
git clone https://github.com/zkproofport/proofport-ai.git
cd proofport-ai && npm install && npx tsc -p packages/client

# Run full-flow example
ATTESTATION_KEY=0x... PAYMENT_KEY=0x... SERVER_URL=${config.a2aBaseUrl} npx tsx packages/client/examples/full-flow.ts`,
    },

    constants: buildConstants(config, circuitId, isTestnet, chainId, usdcAddress, paymentAmount),
    formulas: buildFormulas(circuitId),
    code_examples: buildCodeExamples(config, circuitId, usdcAddress, chainId, paymentAmount),
    input_schema: buildInputSchema(circuitId),
    endpoints: buildEndpoints(config, circuitId),
  };
}
