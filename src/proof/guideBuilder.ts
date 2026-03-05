import { createRequire } from 'module';
import { CIRCUITS, type CircuitId } from '../config/circuits.js';
import { AUTHORIZED_SIGNERS, COINBASE_ATTESTER_CONTRACT } from '../config/contracts.js';
import { getChainVerifiers } from '../config/deployments.js';
import type { Config } from '../config/index.js';

const require = createRequire(import.meta.url);
let mcpPkgVersion: string;
try {
  mcpPkgVersion = require('../../packages/mcp/package.json').version;
} catch {
  mcpPkgVersion = '0.1.0';
}

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
  const chainVerifiers = getChainVerifiers(String(chainId));
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
    },
    rpc: {
      eas_rpc_url: config.baseRpcUrl,
      eas_rpc_chain: 'Base Mainnet (chain ID 8453)',
      eas_rpc_note: 'Used for EAS attestation query, raw TX fetch, attester pubkey recovery, Merkle proof. EAS attestations are ALWAYS on Base Mainnet regardless of payment chain.',
      payment_rpc_url: config.chainRpcUrl,
      payment_rpc_chain: isTestnet ? 'Base Sepolia (chain ID 84532)' : 'Base Mainnet (chain ID 8453)',
      payment_rpc_note: 'Used for x402 payment settlement and on-chain proof verification.',
    },
    x402: {
      facilitator_url: 'https://www.x402.org/facilitator',
      settle_endpoint: 'https://www.x402.org/facilitator/settle',
      protocol: 'EIP-3009 TransferWithAuthorization',
      description: 'Client signs EIP-712 authorization, facilitator settles on-chain (facilitator pays gas)',
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


function buildInputSchema(circuitId: CircuitId) {
  const baseFields = [
    {
      name: 'signal_hash',
      type: 'hex string',
      bytes: 32,
      description: 'keccak256(abi.encodePacked(userAddress, scope, circuitId)) -- binds proof to user + scope + circuit',
      how_to_obtain: 'Computed from user address, scope, and circuit ID',
    },
    {
      name: 'nullifier',
      type: 'hex string',
      bytes: 32,
      description: 'Double-proof prevention hash derived from user address, signal_hash, and scope_bytes',
      how_to_obtain: 'Computed from user address, signal_hash, and scope',
    },
    {
      name: 'scope_bytes',
      type: 'hex string',
      bytes: 32,
      description: 'keccak256(toUtf8Bytes(scope)) -- hashed scope string',
      how_to_obtain: 'Computed from user address, signal_hash, and scope',
    },
    {
      name: 'merkle_root',
      type: 'hex string',
      bytes: 32,
      description: 'Root of the Merkle tree over authorized Coinbase attester addresses',
      how_to_obtain: 'Built from authorized attester addresses',
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
      how_to_obtain: 'User signs signal_hash via personal_sign',
    },
    {
      name: 'user_pubkey_x',
      type: 'hex string',
      bytes: 32,
      description: 'X coordinate of the user uncompressed secp256k1 public key',
      how_to_obtain: 'Recovered from user signature',
    },
    {
      name: 'user_pubkey_y',
      type: 'hex string',
      bytes: 32,
      description: 'Y coordinate of the user uncompressed secp256k1 public key',
      how_to_obtain: 'Recovered from user signature',
    },
    {
      name: 'raw_transaction',
      type: 'hex string',
      bytes: null as number | null,
      description: 'Signed RLP-encoded attestation transaction bytes (EIP-1559, 12 fields, variable length)',
      how_to_obtain: 'Fetched from EAS attestation transaction',
    },
    {
      name: 'tx_length',
      type: 'number',
      bytes: null as number | null,
      description: 'Byte length of raw_transaction',
      how_to_obtain: 'Fetched from EAS attestation transaction',
    },
    {
      name: 'coinbase_attester_pubkey_x',
      type: 'hex string',
      bytes: 32,
      description: 'X coordinate of the Coinbase attester uncompressed secp256k1 public key',
      how_to_obtain: 'Recovered from attestation transaction signature',
    },
    {
      name: 'coinbase_attester_pubkey_y',
      type: 'hex string',
      bytes: 32,
      description: 'Y coordinate of the Coinbase attester uncompressed secp256k1 public key',
      how_to_obtain: 'Recovered from attestation transaction signature',
    },
    {
      name: 'merkle_proof',
      type: 'hex string[]',
      bytes: 32,
      description: 'Array of sibling hashes from leaf to root in the authorized-signers Merkle tree',
      how_to_obtain: 'Built from authorized attester addresses',
    },
    {
      name: 'leaf_index',
      type: 'number',
      bytes: null as number | null,
      description: 'Index of the attester in the AUTHORIZED_SIGNERS array (0-based)',
      how_to_obtain: 'Built from authorized attester addresses',
    },
    {
      name: 'depth',
      type: 'number',
      bytes: null as number | null,
      description: 'Depth of the Merkle proof (number of sibling hashes)',
      how_to_obtain: 'Built from authorized attester addresses',
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
      flow: 'x402 single-step: POST with {circuit} → 402 with nonce + TEE public key → encrypt inputs → pay → retry with {circuit, encrypted_payload} + payment headers',
      timeout_hint: '10-30 seconds',
      description: 'Verifies payment on-chain and triggers ZK proof generation inside TEE. Inputs are E2E encrypted — the server is a blind relay.',
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

    // E2E Encryption with TEE (Trusted Execution Environment)
    e2e_encryption: {
      enabled: true,
      description: 'All proof inputs are end-to-end encrypted using X25519 ECDH + AES-256-GCM. The server acts as a blind relay and cannot read your inputs.',
      protocol: 'Client encrypts with TEE\'s attested X25519 public key (bound to AWS Nitro Enclave attestation). Only the TEE can decrypt and generate the proof.',
      tee_public_key: 'Included in the 402 challenge response as teePublicKey field. Cryptographically verified via AWS Nitro attestation document (COSE Sign1).',
      sdk_usage: 'generateProof() automatically detects and applies E2E encryption when TEE is available. No additional configuration needed.',
    },

    // PRIMARY RECOMMENDATION: Local MCP Server (npm package)
    local_mcp_server: {
      recommended: true,
      npm_package: '@zkproofport-ai/mcp',
      version: mcpPkgVersion,
      install: `npm install @zkproofport-ai/mcp@${mcpPkgVersion}`,
      readme: 'https://www.npmjs.com/package/@zkproofport-ai/mcp',
    },

    // ALTERNATIVE: SDK for programmatic use
    sdk: {
      package: '@zkproofport-ai/sdk',
      repository: 'https://github.com/zkproofport/proofport-ai',
      note: 'Install via npm or clone the repository.',
      install: 'npm install @zkproofport-ai/sdk ethers',
      description:
        'Use the @zkproofport-ai/sdk SDK directly in your code for programmatic proof generation.',
      quick_start: `\
import { generateProof, fromPrivateKey } from '@zkproofport-ai/sdk';

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
cd proofport-ai && npm install && npx tsc -p packages/sdk

# Run full-flow example
ATTESTATION_KEY=0x... PAYMENT_KEY=0x... SERVER_URL=${config.a2aBaseUrl} npx tsx packages/sdk/examples/full-flow.ts`,
    },

    constants: buildConstants(config, circuitId, isTestnet, chainId, usdcAddress, paymentAmount),
    formulas: buildFormulas(circuitId),

    input_schema: buildInputSchema(circuitId),
    endpoints: buildEndpoints(config, circuitId),
  };
}
