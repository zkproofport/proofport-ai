import { createRequire } from 'module';
import { CIRCUITS, type CircuitId } from '../config/circuits.js';
import { CIRCUIT_IDS } from '../config/circuitIds.js';
import { AUTHORIZED_SIGNERS, COINBASE_ATTESTER_CONTRACT } from '../config/contracts.js';
import { getChainVerifiers } from '../config/deployments.js';
import { resolvePaymentNetworks, type PaymentNetwork } from '../payment/networks.js';
import type { Config } from '../config/index.js';

const require = createRequire(import.meta.url);
let mcpPkgVersion: string | null;
try {
  mcpPkgVersion = require('../../packages/mcp/package.json').version;
} catch {
  mcpPkgVersion = null;
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
  const aliases: Record<CircuitId, string> = {
    [CIRCUIT_IDS.COINBASE_ATTESTATION]: 'coinbase_kyc',
    [CIRCUIT_IDS.COINBASE_COUNTRY_ATTESTATION]: 'coinbase_country',
    [CIRCUIT_IDS.OIDC_DOMAIN_ATTESTATION]: 'oidc_domain',
    [CIRCUIT_IDS.ARC_ELIGIBILITY]: 'arc_eligibility',
  };
  const alias = aliases[circuitId];
  if (!alias) throw new Error(`Unknown circuit '${circuitId}'.`);
  return alias;
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
  paymentNetworks: PaymentNetwork[],
) {
  const circuit = CIRCUITS[circuitId];
  const chainVerifiers = getChainVerifiers(String(chainId));
  const verifierAddr = chainVerifiers[circuitId] || 'NOT_DEPLOYED';

  // OIDC circuits have no EAS, no Coinbase contracts
  if (circuitId === CIRCUIT_IDS.OIDC_DOMAIN_ATTESTATION) {
    return {
      contracts: {
        verifier_address: verifierAddr,
        chain_id: chainId,
      },
      payment: {
        recipient: config.paymentPayTo,
        amount: paymentAmount,
        asset: usdcAddress,
        network: isTestnet ? 'base-sepolia' : 'base',
        currency: 'USDC',
        decimals: 6,
      },
      rpc: {
        payment_rpc_url: config.chainRpcUrl,
        payment_rpc_chain: isTestnet ? 'Base Sepolia (chain ID 84532)' : 'Base Mainnet (chain ID 8453)',
        payment_rpc_note: 'Used for x402 payment settlement and on-chain proof verification.',
      },
      x402: {
        protocol: 'x402 v2, exact scheme (EIP-3009 TransferWithAuthorization)',
        description:
          'You sign a USDC authorization and send it. You never submit a transaction, so you ' +
          'need USDC on the chain you pay on and nothing else — no gas, no native token. ' +
          'Settlement is not your problem: a public facilitator does it where one serves the ' +
          'chain, and this service does it where none does.',
        // Named per chain, not once. A single facilitator_url was published
        // here and in the 402 body, which is wrong for any chain no public
        // facilitator serves -- Arc and both Ethereum chains -- and told an
        // agent to POST to a facilitator that would refuse it.
        chains: paymentNetworks.map((net) => ({
          network: net.caip2,
          network_name: net.id,
          asset: net.usdc,
          decimals: net.decimals,
          eip712_domain: { name: net.eip3009.name, version: net.eip3009.version, chainId: net.chainId },
          settled_by:
            net.settlement === 'facilitator'
              ? `facilitator ${net.facilitatorUrl} (it pays the gas)`
              : 'this service (it pays the gas, out of your payment)',
        })),
        single_step_flow: {
          description:
            'POST /prove with {circuit, inputs} → 402 listing chains in `accepts` → sign one → ' +
            'retry with the PAYMENT-SIGNATURE and X-Payment-Nonce headers.',
          header_note:
            'PAYMENT-SIGNATURE carries the base64 x402 payment payload. That is the v2 header name; ' +
            'X-Payment was v1 and is still read.',
          nonce_details:
            'The 402 body carries a 32-byte nonce. Send it back as X-Payment-Nonce. It is single-use ' +
            'and bound to the circuit it was issued for.',
          alternative:
            'If you would rather submit your own transaction, send its hash as X-Payment-TX with ' +
            'X-Payment-Network naming the chain. You pay the gas on that path.',
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

  return {
    eas: {
      graphql_endpoint: config.easGraphqlEndpoint,
      schema_id: (circuit as any).easSchemaId,
    },
    contracts: {
      coinbase_attester: COINBASE_ATTESTER_CONTRACT,
      function_selector: (circuit as any).functionSelector,
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
      protocol: 'x402 v2, exact scheme (EIP-3009 TransferWithAuthorization)',
      description:
        'You sign a USDC authorization and send it. You never submit a transaction, so you ' +
        'need USDC on the chain you pay on and nothing else — no gas, no native token. ' +
        'Settlement is not your problem: a public facilitator does it where one serves the ' +
        'chain, and this service does it where none does.',
      chains: paymentNetworks.map((net) => ({
        network: net.caip2,
        network_name: net.id,
        asset: net.usdc,
        decimals: net.decimals,
        eip712_domain: { name: net.eip3009.name, version: net.eip3009.version, chainId: net.chainId },
        settled_by:
          net.settlement === 'facilitator'
            ? `facilitator ${net.facilitatorUrl} (it pays the gas)`
            : 'this service (it pays the gas, out of your payment)',
      })),
      single_step_flow: {
        description:
          'POST /prove with circuit + inputs → 402 listing chains in `accepts` → sign one → ' +
          'retry with the PAYMENT-SIGNATURE and X-Payment-Nonce headers.',
        header_note:
          'PAYMENT-SIGNATURE carries the base64 x402 payment payload. That is the v2 header name; ' +
          'X-Payment was v1 and is still read.',
        nonce_details:
          'The 402 body carries a 32-byte nonce. Send it back as X-Payment-Nonce. Single-use ' +
          '(consumed on first successful payment verification) and circuit-bound (a coinbase_kyc ' +
          'nonce cannot be reused for coinbase_country).',
        alternative:
          'If you would rather submit your own transaction, send its hash as X-Payment-TX with ' +
          'X-Payment-Network naming the chain. You pay the gas on that path.',
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
  if (circuitId === CIRCUIT_IDS.OIDC_DOMAIN_ATTESTATION) {
    return {
      scope: {
        description: 'Keccak-256 hash of the scope string. Used to partition nullifiers.',
        formula: 'scope = keccak256(toUtf8Bytes(scope_string))',
      },
      nullifier: {
        description: 'Prevents double-proving for the same email + scope. Deterministic from email and scope.',
        formula: 'nullifier = keccak256(keccak256(email_bytes) ++ scope_bytes)',
      },
      domain: {
        description: 'Extracted from email claim in JWT payload (everything after @).',
        formula: 'domain = email.split("@")[1]',
      },
      partial_sha256: {
        description: 'SHA-256 is precomputed up to the "email" key in the JWT payload. The remaining data (containing email value) is passed as circuit input.',
        formula: 'partialHash = SHA256(jwt_signed_data[0..emailKeyOffset])',
      },
      rsa_limbs: {
        description: 'RSA-2048 values (modulus, signature, redc_params) are split into 18 x 120-bit limbs (little-endian).',
        formula: 'limbs[i] = (value >> (i * 120)) & ((1 << 120) - 1)',
      },
    };
  }
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
  if (circuitId === CIRCUIT_IDS.OIDC_DOMAIN_ATTESTATION) {
    return {
      note: 'OIDC circuit inputs are computed SERVER-SIDE from the JWT. The client only sends jwt and scope_string.',
      client_fields: [
        {
          name: 'jwt',
          type: 'string',
          description: 'Raw OIDC id_token (JWT) from provider (Google, Microsoft, Apple, etc.). Must use RS256 algorithm and contain email + email_verified claims.',
          how_to_obtain: 'OIDC authentication flow with the identity provider',
        },
        {
          name: 'scope_string',
          type: 'string',
          description: 'Scope string for nullifier partitioning (e.g. "myapp:membership")',
          how_to_obtain: 'Defined by the requesting application',
        },
        {
          name: 'domain',
          type: 'string (optional)',
          description: 'Domain to prove. If omitted, auto-extracted from email claim in JWT.',
          how_to_obtain: 'Optional override',
        },
      ],
      server_computed_fields: [
        { name: 'pubkey_modulus_limbs', description: '18 x u128 RSA public key modulus limbs (from JWKS)' },
        { name: 'domain', description: 'BoundedVec<u8, 64> — email domain bytes' },
        { name: 'scope', description: '32-byte keccak256(scope_string)' },
        { name: 'nullifier', description: '32-byte keccak256(keccak256(email) ++ scope)' },
        { name: 'partial_data', description: 'BoundedVec<u8, 640> — remaining JWT data after partial SHA' },
        { name: 'partial_hash', description: '8 x u32 — intermediate SHA-256 state' },
        { name: 'full_data_length', description: 'Total byte length of JWT signed data' },
        { name: 'base64_decode_offset', description: 'Alignment offset for base64 decoding' },
        { name: 'redc_params_limbs', description: '18 x u128 Barrett reduction parameter limbs' },
        { name: 'signature_limbs', description: '18 x u128 RSA signature limbs' },
      ],
    };
  }

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

  if (circuitId === CIRCUIT_IDS.COINBASE_COUNTRY_ATTESTATION) {
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


/** Arc's single proof binds the KYC holder to a typed action, not a generic KYC signature. */
function buildArcGuide(config: Config) {
  const circuit = CIRCUITS[CIRCUIT_IDS.ARC_ELIGIBILITY];
  const networks = resolvePaymentNetworks(config.paymentNetworks);
  const nano = networks.find(network => network.id === 'arc-testnet-nano');
  const chainId = 5042002;
  const verifier = getChainVerifiers(String(chainId))[CIRCUIT_IDS.ARC_ELIGIBILITY] ?? null;
  const encrypted = config.teeMode === 'nitro';
  const payment = { required: config.paymentMode !== 'disabled', recipient: config.paymentPayTo,
    price: config.paymentProofPrice, source: 'Use the live 402 accepts list for amount, asset, recipient and payment domain.' };
  return {
    circuit_id: circuit.id, display_name: circuit.displayName, description: circuit.description,
    e2e_encryption: {
      enabled: encrypted,
      description: encrypted
        ? 'Use the attested teePublicKey returned by the challenge to encrypt proof inputs.'
        : 'This deployment provides no hardware TEE attestation. HTTPS protects transport; the prover receives proof inputs.',
      sdk_usage: 'generateProof checks the actual challenge for teePublicKey. Never infer TEE availability from a circuit name.',
    },
    local_mcp_server: {
      recommended: true, npm_package: '@zkproofport-ai/mcp', version: mcpPkgVersion,
      install: `npm install @zkproofport-ai/mcp${mcpPkgVersion ? '@' + mcpPkgVersion : ''}`,
      command: 'zkproofport-mcp', transport: 'stdio',
      discovery: 'Connect to the local MCP server and call tools/list. Read generate_proof inputSchema before tools/call.',
      required_arguments: ['circuit', 'action'],
      generate_proof: { circuit: 'arc_eligibility', scope: 'ledger-house',
        action: '<complete EIP-712 typed action prepared by the trusted application>',
        ...(nano ? { pay_with: 'arc', pay_on: nano.id } : {}),
      },
      verification: 'After generate_proof, call verify_proof with its result. Verify on Arc Testnet before staking.',
      credentials: 'ATTESTATION_KEY stays in the local signer process. Circle Agent Wallet signing uses the existing Circle CLI login. Do not put keys in model prompts or tool arguments.',
    },
    sdk: {
      package: '@zkproofport-ai/sdk',
      quick_start: `import { createConfig, generateProof, walletFromArcAgent } from '@zkproofport-ai/sdk';
const payment = await walletFromArcAgent({ address: agentWalletB, chain: 'ARC-TESTNET' });
const result = await generateProof(
  createConfig({ baseUrl: '${config.a2aBaseUrl}' }),
  { attestation: existingKycSigner, payment },
  { circuit: 'arc_eligibility', scope: 'ledger-house', action${nano ? ", payOn: 'arc-testnet-nano'" : ''} },
);`,
      cli: `PROOFPORT_URL=${config.a2aBaseUrl} zkproofport-prove arc_eligibility --action delegation.json --scope ledger-house${nano ? ' --pay-with arc --pay-on arc-testnet-nano' : ''} --silent`,
      payment_selection: 'Explicitly choose an offered payment network and a funded payment wallet; no attestation-key payment fallback exists.',
    },
    constants: {
      eas: { graphql_endpoint: config.easGraphqlEndpoint, schema_id: (circuit as any).easSchemaId,
        chain_id: 8453, note: 'Coinbase KYC attestation data is read on Base Mainnet; proof verification is on Arc.' },
      contracts: { coinbase_attester: COINBASE_ATTESTER_CONTRACT, verifier_address: verifier, chain_id: chainId },
      authorized_signers: AUTHORIZED_SIGNERS,
      payment,
      x402: {
        protocol: 'x402 v2; use the selected live offer',
        chains: networks.map(network => ({
          network: network.caip2, network_name: network.id, asset: network.usdc, decimals: network.decimals,
          settlement: network.settlement,
          eip712_domain: network.batching
            ? { name: network.batching.name, version: network.batching.version, chainId: network.chainId,
                verifyingContract: network.batching.gatewayWallet }
            : { name: network.eip3009.name, version: network.eip3009.version, chainId: network.chainId,
                verifyingContract: network.usdc },
        })),
        single_step_flow: 'POST /api/v1/prove → 402 PAYMENT-REQUIRED and accepts → sign selected offer → retry with PAYMENT-SIGNATURE and X-Payment-Nonce.',
        nanopayments: 'For arc-testnet-nano, use @circle-fin/x402-batching. Circle CLI signs GatewayWalletBatched typed data using the Agent Wallet backing EOA. Gateway verifies and settles against its deposited balance; each proof purchase requires no buyer transfer transaction.',
      },
      verification: { verifier_address: verifier, chain_id: chainId, chain_name: 'Arc Testnet',
        rpc_url: config.arcRpcUrl,
        function_signature: 'verify(bytes proof, bytes32[] publicInputs) external view returns (bool)',
        public_input_count: 192,
        input_format: '192 bytes32 field words encoding six [u8;32] values. Keep the proof and publicInputs separate.',
      },
    },
    action: {
      type: 'EIP-712 TypedData', required_fields: ['domain', 'types', 'primaryType', 'message'],
      domain: 'Bind name, version, chainId and verifyingContract to the intended application.',
      message: 'The staking application builds CredentialDelegation(delegate, action, amount, expiresAt, nonce). Never replace the application-provided action with a generic example.',
      security: 'One circuit verifies both an authorized Coinbase attester transaction for wallet A and A\'s EIP-712 action signature. The application contract must match domain, action hash, trusted attester root, scope, expiry and replay protection before acting as delegate B.',
    },
    formulas: {
      signing_digest: 'keccak256(0x1901 || domain_separator || action_hash)',
      domain_separator: 'EIP-712 domain hash', action_hash: 'EIP-712 hashStruct(primaryType, message)',
      scope: 'keccak256(UTF8(scope))',
    },
    input_schema: {
      preparation: 'Use local MCP generate_proof with the typed action; the SDK prepares the private circuit witness locally.',
      public_fields: ['signal_hash', 'domain_separator', 'action_hash', 'signer_list_merkle_root', 'scope', 'nullifier'],
      private_inputs: 'KYC holder public key and EIP-712 signature, signed Coinbase attestation transaction and attester membership proof. Never send these through an LLM.',
    },
    endpoints: {
      prove: { method: 'POST', url: `${config.a2aBaseUrl}/api/v1/prove`, content_type: 'application/json' },
      guide: { method: 'GET', url: `${config.a2aBaseUrl}/api/v1/guide/arc_eligibility` },
    },
  };
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export function buildGuide(circuitId: CircuitId, config: Config): object {
  const circuit = CIRCUITS[circuitId];
  if (!circuit) throw new Error(`Unknown circuit '${circuitId}'.`);
  if (circuitId === CIRCUIT_IDS.ARC_ELIGIBILITY) return buildArcGuide(config);
  const { isTestnet, chainId, usdcAddress, paymentAmount } = derivePaymentConstants(config);

  // OIDC-specific guide
  if (circuitId === CIRCUIT_IDS.OIDC_DOMAIN_ATTESTATION) {
    return {
      circuit_id: circuitId,
      display_name: circuit.displayName,
      description: circuit.description,

      overview: {
        what: 'Prove email domain affiliation (e.g. "@google.com") from an OIDC JWT token without revealing the full email address.',
        how: 'Client sends a raw JWT (id_token from Google/Microsoft/Apple) and a scope string. The server fetches JWKS, verifies RSA signature structure, extracts the email domain, computes a nullifier, and generates a ZK proof.',
        privacy: 'The proof reveals only the domain (e.g. "google.com") and a nullifier. The full email, JWT claims, and RSA key material remain private.',
      },

      sdk: {
        package: '@zkproofport-ai/sdk',
        repository: 'https://github.com/zkproofport/proofport-ai',
        install: 'npm install @zkproofport-ai/sdk ethers',
        description: 'For OIDC proofs, the client only needs to provide the JWT and scope. The server handles all cryptographic computation.',
        quick_start: `\
// OIDC Domain proof — client only sends JWT + scope
const response = await fetch('${config.a2aBaseUrl}/api/v1/prove', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    circuit: 'oidc_domain',
    inputs: {
      jwt: '<OIDC id_token from Google/Microsoft/Apple>',
      scope_string: 'myapp:membership',
    },
  }),
});
// First call returns 402 with payment nonce
// After payment, retry with X-Payment-TX and X-Payment-Nonce headers`,
      },

      local_mcp_server: {
        recommended: true,
        npm_package: '@zkproofport-ai/mcp',
        version: mcpPkgVersion,
        install: `npm install @zkproofport-ai/mcp${mcpPkgVersion ? '@' + mcpPkgVersion : ''}`,
        readme: 'https://www.npmjs.com/package/@zkproofport-ai/mcp',
      },

      constants: buildConstants(config, circuitId, isTestnet, chainId, usdcAddress, paymentAmount, resolvePaymentNetworks(config.paymentNetworks)),
      formulas: buildFormulas(circuitId),
      input_schema: buildInputSchema(circuitId),
      endpoints: buildEndpoints(config, circuitId),
    };
  }

  // Coinbase circuit guides
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
      install: `npm install @zkproofport-ai/mcp${mcpPkgVersion ? '@' + mcpPkgVersion : ''}`,
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
      cdp_wallet: `\
// CDP wallet or any external wallet adapter
import { generateProof, CdpWalletSigner } from '@zkproofport-ai/sdk';

const signer = new CdpWalletSigner({
  getAddress: () => myWallet.getAddress(),
  signMessage: (msg) => myWallet.signMessage(msg),
  signTypedData: (domain, types, message) => myWallet.signTypedData(domain, types, message),
});

const result = await generateProof(
  { baseUrl: '${config.a2aBaseUrl}' },
  { attestation: signer },
  { circuit: '${circuitAlias(circuitId)}', scope: 'proofport' },
);`,
    },

    constants: buildConstants(config, circuitId, isTestnet, chainId, usdcAddress, paymentAmount, resolvePaymentNetworks(config.paymentNetworks)),
    formulas: buildFormulas(circuitId),

    input_schema: buildInputSchema(circuitId),
    endpoints: buildEndpoints(config, circuitId),
  };
}
