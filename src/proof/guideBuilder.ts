import { createRequire } from 'module';
import { CIRCUITS, type CircuitId } from '../config/circuits.js';
import { CIRCUIT_IDS } from '../config/circuitIds.js';
import { AUTHORIZED_SIGNERS, COINBASE_ATTESTER_CONTRACT, ATTESTATION_SOURCES, GIWA_CHAIN_ID } from '../config/contracts.js';
import { getChainVerifiers } from '../config/deployments.js';
import { resolvePaymentNetworks, type PaymentNetwork } from '../payment/networks.js';
import { type Config, getPaymentChainId, isTestnet } from '../config/index.js';
import { parseUnits } from 'ethers';

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

function encryptionGuide(config: Config) {
  const encrypted = config.teeMode === 'nitro';
  return {
    enabled: encrypted,
    description: encrypted
      ? 'Encrypt proof inputs with the attested teePublicKey from the challenge. Only the Nitro enclave decrypts the witness.'
      : 'This deployment provides no hardware TEE attestation. HTTPS protects transport; the prover receives proof inputs.',
    sdk_usage: 'generateProof checks the actual challenge for teePublicKey and encrypts when available.',
  };
}

function paymentGuide(config: Config, networks: PaymentNetwork[]) {
  return {
    protocol: 'x402 v2; use the selected live offer',
    chains: networks.map(network => ({
      network: network.caip2, network_name: network.id, asset: network.usdc, decimals: network.decimals,
      settlement: network.settlement,
      eip712_domain: network.batching
        ? { name: network.batching.name, version: network.batching.version, chainId: network.chainId, verifyingContract: network.batching.gatewayWallet }
        : { name: network.eip3009.name, version: network.eip3009.version, chainId: network.chainId, verifyingContract: network.usdc },
    })),
    single_step_flow: 'POST /api/v1/prove → 402 PAYMENT-REQUIRED and accepts → sign the selected offer → retry with PAYMENT-SIGNATURE. Return X-Payment-Nonce when the challenge supplied one.',
    nonce_details: 'X-Payment-Nonce is single-use and circuit-bound; required with X-Payment-TX. Signed authorization payments also have their own replay protection.',
    nanopayments: 'For arc-testnet-nano, use @circle-fin/x402-batching. Circle Agent Wallet backing EOA signs GatewayWalletBatched; Gateway settles against deposited balance. USDC in the wallet and deposited Gateway balance are separate.',
  };
}

function circuitAlias(circuitId: CircuitId): string {
  const aliases: Record<CircuitId, string> = {
    [CIRCUIT_IDS.COINBASE_ATTESTATION]: 'coinbase_kyc',
    [CIRCUIT_IDS.COINBASE_COUNTRY_ATTESTATION]: 'coinbase_country',
    [CIRCUIT_IDS.OIDC_DOMAIN_ATTESTATION]: 'oidc_domain',
    [CIRCUIT_IDS.ARC_ELIGIBILITY]: 'arc_eligibility',
    [CIRCUIT_IDS.GIWA_ATTESTATION]: 'giwa_attestation',
  };
  const alias = aliases[circuitId];
  if (!alias) throw new Error(`Unknown circuit '${circuitId}'.`);
  return alias;
}

// ---------------------------------------------------------------------------
// Section builders
// ---------------------------------------------------------------------------


function buildConstants(config: Config, circuitId: CircuitId) {
  const circuit = CIRCUITS[circuitId];
  const chainId = getPaymentChainId(config);
  const networks = resolvePaymentNetworks(config.paymentNetworks);
  const first = networks[0];
  if (!first) throw new Error('No configured payment network');
  const verifierAddr = getChainVerifiers(String(chainId))[circuitId];
  if (!verifierAddr) throw new Error(`No ${circuitId} verifier configured on chain ${chainId}`);
  const source = ATTESTATION_SOURCES[circuitId];
  return {
    ...(source?.kind === 'eas-base' && {
      eas: { graphql_endpoint: config.easGraphqlEndpoint, schema_id: (circuit as any).easSchemaId, chain_id: 8453 },
      authorized_signers: source.signers,
    }),
    contracts: {
      ...(source && { coinbase_attester: source.contract, function_selector: (circuit as any).functionSelector }),
      verifier_address: verifierAddr, chain_id: chainId,
    },
    payment: {
      required: config.paymentMode !== 'disabled', recipient: config.paymentPayTo,
      amount: config.paymentMode === 'disabled' ? '0' : parseUnits(config.paymentProofPrice.replace(/^\$/, ''), first.decimals).toString(),
      asset: first.usdc, network: first.id, currency: 'USDC', decimals: first.decimals,
      source: 'The first configured offer is shown here for compatibility. Use the live 402 accepts list to select a network.',
    },
    rpc: {
      ...(source?.kind === 'eas-base' && { eas_rpc_url: config.baseRpcUrl, eas_rpc_chain: 'Base Mainnet (8453)' }),
      verification_rpc_url: config.chainRpcUrl,
    },
    x402: paymentGuide(config, networks),
    verification: {
      verifier_address: verifierAddr, chain_id: chainId, chain_name: isTestnet(config) ? 'Base Sepolia' : 'Base', rpc_url: config.chainRpcUrl,
      function_signature: 'verify(bytes proof, bytes32[] publicInputs) external view returns (bool)',
      input_format: 'Keep proof and publicInputs separate; split the publicInputs hex blob into bytes32 words.',
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
      note: 'Use generateProof or prepareOidcPayload: the SDK fetches JWKS and sends jwt, jwks, scope and provider. The prover validates the JWT and builds circuit inputs.',
      client_fields: [
        { name: 'jwt', type: 'string', description: 'RS256 id_token from Google or Microsoft containing the required email claims.' },
        { name: 'jwks', type: 'object', description: 'Issuer JWKS fetched by prepareOidcPayload.' },
        { name: 'scope', type: 'string', description: 'Application scope string for nullifier partitioning.' },
        { name: 'provider', type: 'google | microsoft', description: 'Provider matching the JWT issuer; defaults to google in the SDK.' },
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
  const alias = circuitId;
  return {
    prove: {
      method: 'POST',
      url: `${config.a2aBaseUrl}/api/v1/prove`,
      content_type: 'application/json',
      flow: config.teeMode === 'nitro'
        ? 'x402 single-step: POST with {circuit} → 402 with nonce + TEE public key → encrypt inputs → pay → retry with {circuit, encrypted_payload} + payment headers'
        : 'x402 single-step: POST with {circuit} → 402 with nonce and live offers → pay when required → retry with {circuit, inputs} over HTTPS and payment headers',
      timeout_hint: '10-30 seconds',
      description: 'Settles the selected payment and generates the proof. Encrypt with teePublicKey when the challenge supplies it; otherwise the prover receives the witness over HTTPS.',
    },
    guide: {
      method: 'GET',
      url: `${config.a2aBaseUrl}/api/v1/guide/${alias}`,
      description: 'Returns this guide as JSON (the document you are reading)',
    },
  };
}


/** Both action-capable circuits also support identity-only proofs. */
function buildActionGuide(circuitId: CircuitId, config: Config) {
  const circuit = CIRCUITS[circuitId];
  const source = ATTESTATION_SOURCES[circuitId];
  if (!source) throw new Error(`No attestation source for ${circuitId}`);
  const targets: Partial<Record<CircuitId, { chainId: number; name: string; rpc: string }>> = {
    [CIRCUIT_IDS.ARC_ELIGIBILITY]: { chainId: config.arcChainId, name: `Arc (${config.arcChainId})`, rpc: config.arcRpcUrl },
    [CIRCUIT_IDS.GIWA_ATTESTATION]: { chainId: GIWA_CHAIN_ID, name: 'GIWA Sepolia', rpc: config.giwaRpcUrl },
  };
  const target = targets[circuitId];
  if (!target) throw new Error(`No action guide target for ${circuitId}`);
  if (!Number.isSafeInteger(target.chainId) || target.chainId <= 0) throw new Error(`Invalid verification chain for ${circuitId}`);
  const verifier = getChainVerifiers(String(target.chainId))[circuitId];
  if (!verifier) throw new Error(`No ${circuitId} verifier configured on chain ${target.chainId}`);
  const networks = resolvePaymentNetworks(config.paymentNetworks);
  const nano = networks.find(network => network.id === 'arc-testnet-nano');
  const isGiwa = source.kind === 'giwa-sepolia';
  const cliBase = `PROOFPORT_URL=${config.a2aBaseUrl} zkproofport-prove ${circuitId} --scope myapp:membership${nano ? ' --pay-with arc --pay-on arc-testnet-nano' : ''}`;
  return {
    circuit_id: circuit.id, display_name: circuit.displayName,
    description: `Prove the configured ${isGiwa ? 'GIWA' : 'Coinbase KYC'} attestation, optionally authorizing one exact EIP-712 action with the same wallet.`,
    e2e_encryption: encryptionGuide(config),
    local_mcp_server: {
      recommended: true, npm_package: '@zkproofport-ai/mcp', version: mcpPkgVersion,
      install: 'npm install -g @zkproofport-ai/mcp@latest', command: 'zkproofport-mcp', transport: 'stdio',
      discovery: 'Connect, call tools/list, and follow generate_proof inputSchema. Keys stay in the local signer process.',
      required_arguments: ['circuit'], optional_arguments: ['scope', 'action', 'pay_with', 'pay_on', 'max_payment'],
      generate_proof: { circuit: circuitId, scope: 'myapp:membership', ...(nano ? { pay_with: 'arc', pay_on: nano.id } : {}) },
      action_bound_example: { circuit: circuitId, scope: 'myapp:membership', action: '<complete EIP-712 typed action supplied by the trusted application>' },
      verification: `Call verify_proof with the returned result. Check the proof on ${target.name}; action authorization additionally requires application policy checks.`,
      credentials: `ATTESTATION_KEY stays local.${isGiwa ? ' The SDK uses its built-in GIWA Sepolia RPC and explorer for witness preparation; server GIWA_RPC_URL/GIWA_EXPLORER_URL configure the server-side path.' : ''} PAYMENT_PRIVATE_KEY is a separate key-based payment option, not a fallback to the attestation signer.`,
    },
    sdk: {
      package: '@zkproofport-ai/sdk',
      quick_start: `import { createConfig, generateProof${nano ? ', walletFromArcAgent' : ''} } from '@zkproofport-ai/sdk';
${nano ? "const payment = await walletFromArcAgent({ address: agentWalletB, chain: 'ARC-TESTNET' });" : '// Supply an explicitly selected funded payment wallet when this service charges.'}
const result = await generateProof(
  createConfig({ baseUrl: '${config.a2aBaseUrl}' }),
  { attestation: existingAttestationSigner, payment },
  { circuit: '${circuitId}', scope: 'myapp:membership', action${nano ? ", payOn: 'arc-testnet-nano'" : ''} },
);
// Omit action above for an identity-only proof.`,
      cli: `${cliBase} --action action.json --silent`,
      identity_only: `${cliBase} --silent`, action_bound: `${cliBase} --action action.json --silent`,
      payment_selection: 'Choose an offered network and an existing funded payment wallet explicitly. Payment is independent of the circuit verification chain.',
    },
    constants: {
      ...(source.kind === 'eas-base' && { eas: { graphql_endpoint: config.easGraphqlEndpoint, schema_id: (circuit as any).easSchemaId, chain_id: 8453 } }),
      attestation_source: source.kind === 'giwa-sepolia'
        ? { chain_id: source.chainId, rpc_url: config.giwaRpcUrl, explorer_url: config.giwaExplorerUrl }
        : { chain_id: 8453, rpc_url: config.baseRpcUrl, graphql_endpoint: config.easGraphqlEndpoint },
      contracts: { attester: source.contract, verifier_address: verifier, chain_id: target.chainId },
      authorized_signers: source.signers,
      payment: { required: config.paymentMode !== 'disabled', recipient: config.paymentPayTo, price: config.paymentProofPrice, source: 'Use the live 402 accepts list.' },
      x402: paymentGuide(config, networks),
      verification: { verifier_address: verifier, chain_id: target.chainId, chain_name: target.name, rpc_url: target.rpc,
        function_signature: 'verify(bytes proof, bytes32[] publicInputs) external view returns (bool)', public_input_count: 192,
        input_format: '192 bytes32 field words encoding six [u8;32] values. Keep proof and publicInputs separate.',
      },
    },
    action: {
      required: false, type: 'EIP-712 TypedData', required_fields_when_present: ['domain', 'types', 'primaryType', 'message'],
      domain: 'Bind name, version, chainId and verifyingContract to the intended application.',
      message: 'Use the complete application-provided typed action. The schema is application-defined; do not replace it with a fixed deposit or delegation example.',
      security: 'The application must compare domain, action hash, trusted attester root, scope and its replay/expiry policy. An identity-only proof does not authorize an action.',
    },
    formulas: {
      identity_signature: 'Without action, personal_sign(signal_hash). Circuit action_hash and domain_separator are zero.',
      signing_digest: 'With action, keccak256(0x1901 || domain_separator || action_hash); signal_hash is zero in the circuit witness.',
      domain_separator: 'EIP-712 domain hash', action_hash: 'EIP-712 hashStruct(primaryType, message)', scope: 'keccak256(UTF8(scope))',
      nullifier: 'keccak256(keccak256(address_bytes || keccak256(UTF8(circuitId))) || scope_bytes)',
      nullifier_note: 'Same wallet, circuit and scope produce the same nullifier with or without action.',
    },
    input_schema: {
      preparation: 'Use generate_proof locally. On the REST wire omit both domain_separator and action_hash for identity-only mode; for action mode provide both 32-byte hashes.',
      public_fields: ['signal_hash', 'domain_separator', 'action_hash', 'signer_list_merkle_root', 'scope', 'nullifier'],
      private_inputs: 'Wallet public key and signature, signed attestation transaction and attester membership proof. Never expose these through an LLM.',
    },
    endpoints: buildEndpoints(config, circuitId),
  };
}

export function buildGuide(circuitId: CircuitId, config: Config): object {
  const circuit = CIRCUITS[circuitId];
  if (!circuit) throw new Error(`Unknown circuit '${circuitId}'.`);
  if (circuitId === CIRCUIT_IDS.ARC_ELIGIBILITY || circuitId === CIRCUIT_IDS.GIWA_ATTESTATION) return buildActionGuide(circuitId, config);
  const oidc = circuitId === CIRCUIT_IDS.OIDC_DOMAIN_ATTESTATION;
  const country = circuitId === CIRCUIT_IDS.COINBASE_COUNTRY_ATTESTATION;
  if (!oidc && !country && circuitId !== CIRCUIT_IDS.COINBASE_ATTESTATION) throw new Error(`No guide builder for '${circuitId}'.`);
  const params = country ? ", countryList: ['KR'], isIncluded: true" : '';
  const oidcParams = oidc ? ", jwt: existingIdToken, provider: 'google'" : '';
  return {
    circuit_id: circuitId, display_name: circuit.displayName, description: circuit.description,
    ...(oidc && { overview: {
      what: 'Prove email domain affiliation without disclosing the full email in the public proof.',
      how: 'The SDK takes a Google or Microsoft JWT and scope, fetches JWKS, and sends jwt, jwks, scope and provider to the prover. The prover validates the JWT and builds circuit inputs.',
      privacy: config.teeMode === 'nitro' ? 'Inputs are encrypted to the Nitro enclave. Public proof inputs reveal the domain and nullifier.' : 'HTTPS protects transport, but this prover receives the JWT. Public proof inputs reveal the domain and nullifier.',
    } }),
    e2e_encryption: encryptionGuide(config),
    local_mcp_server: {
      recommended: true, npm_package: '@zkproofport-ai/mcp', version: mcpPkgVersion,
      install: 'npm install -g @zkproofport-ai/mcp@latest', readme: 'https://www.npmjs.com/package/@zkproofport-ai/mcp',
      required_arguments: ['circuit', ...(country ? ['country_list', 'is_included'] : []), ...(oidc ? ['jwt'] : [])],
      generate_proof: { circuit: circuitAlias(circuitId), scope: 'myapp:membership', ...(country && { country_list: ['KR'], is_included: true }), ...(oidc && { jwt: '<existing id_token>', provider: 'google' }) },
    },
    sdk: {
      package: '@zkproofport-ai/sdk', repository: 'https://github.com/zkproofport/proofport-ai', install: 'npm install @zkproofport-ai/sdk@latest ethers',
      description: 'Use generateProof to prepare witnesses, request a challenge, pay using the explicit payment wallet, and encrypt when the deployment supplies a TEE key.',
      quick_start: `import { createConfig, generateProof } from '@zkproofport-ai/sdk';
// Existing signer and explicitly selected funded payment wallet stay in local code.
const result = await generateProof(
  createConfig({ baseUrl: '${config.a2aBaseUrl}' }),
  { attestation: existingAttestationSigner, payment: existingPaymentWallet },
  { circuit: '${circuitAlias(circuitId)}', scope: 'myapp:membership'${params}${oidcParams} },
);`,
      cli: oidc
        ? 'Use local MCP generate_proof with jwt and provider, or the SDK example. Keep JWTs out of shell history.'
        : `PROOFPORT_URL=${config.a2aBaseUrl} zkproofport-prove ${circuitAlias(circuitId)} --scope myapp:membership${country ? ' --countries KR --included true' : ''} --silent`,
      payment_selection: 'Load PAYMENT_PRIVATE_KEY for pay_with=key, or select an existing Circle/CDP payment wallet. The attestation signer is not a payment fallback.',
    },
    constants: buildConstants(config, circuitId), formulas: buildFormulas(circuitId), input_schema: buildInputSchema(circuitId), endpoints: buildEndpoints(config, circuitId),
  };
}
