import { createRequire } from 'module';
import { CIRCUITS, type CircuitId } from '../config/circuits.js';
import { CIRCUIT_IDS } from '../config/circuitIds.js';
import { AUTHORIZED_SIGNERS, COINBASE_ATTESTER_CONTRACT, ATTESTATION_SOURCES, GIWA_CHAIN_ID } from '../config/contracts.js';
import { getChainVerifiers } from '../config/deployments.js';
import { resolvePaymentNetworks, type PaymentNetwork } from '../payment/networks.js';
import { type Config, getPaymentChainId, isTestnet } from '../config/index.js';
import { parseUnits } from 'ethers';
import {
  HUMAN_PASSPORT_ISSUER,
  HUMAN_PASSPORT_ISSUER_LEAVES,
  HUMAN_PASSPORT_ISSUER_ROOT,
  HUMAN_PASSPORT_MAX_DATA_BYTES,
  HUMAN_PASSPORT_CHAINS,
} from '@zkproofport-app/core/circuits';
import { humanPassportSource } from '../input/humanPassport.js';

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
      eip712_domain: { name: network.eip3009.name, version: network.eip3009.version, chainId: network.chainId, verifyingContract: network.usdc },
    })),
    single_step_flow: 'POST /api/v1/prove → 402 PAYMENT-REQUIRED and accepts → sign the selected offer → retry with PAYMENT-SIGNATURE. Return X-Payment-Nonce when the challenge supplied one.',
    nonce_details: 'X-Payment-Nonce is single-use and circuit-bound; required with X-Payment-TX. Signed authorization payments also have their own replay protection.',
  };
}

function circuitAlias(circuitId: CircuitId): string {
  const aliases: Record<CircuitId, string> = {
    [CIRCUIT_IDS.COINBASE_ATTESTATION]: 'coinbase_kyc',
    [CIRCUIT_IDS.COINBASE_COUNTRY_ATTESTATION]: 'coinbase_country',
    [CIRCUIT_IDS.OIDC_DOMAIN_ATTESTATION]: 'oidc_domain',
    [CIRCUIT_IDS.GIWA_ATTESTATION]: 'giwa_attestation',
    [CIRCUIT_IDS.HUMAN_PASSPORT_SCORE]: 'human_passport',
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

/**
 * The OPRF nullifier inputs every wallet circuit takes, as the guide states
 * them. One text for every wallet circuit: the construction does not vary by
 * circuit (the pinned key hash may, see GET /api/v1/oprf).
 */
export const OPRF_GUIDE = Object.freeze({
  description:
    'The nullifier comes from an OPRF network: one value per wallet per (domain, scope), which nobody without the network key can ' +
    'compute from an address. The SDK (@zkproofport-ai/sdk generateProof, or the local MCP) computes all eleven values: it reduces the ' +
    'domain and scope names, blinds the query with a fresh random factor, asks the OPRF network, verifies the network\'s DLog-equality ' +
    'proof and unblinds the answer. Do not compute them by hand. Names: 1-256 UTF-8 bytes, no control or format characters, never trimmed ' +
    'or normalized. domain names the service the proof is for and is required; there is no default.',
  public: {
    oprf_key_hash: 'Poseidon2 hash of the OPRF public key; must equal the key hash pinned for this deployment\'s environment (GET /api/v1/oprf) or the request is refused before payment (OPRF_KEY_HASH_MISMATCH)',
    domain: 'keccak256(UTF8(domain name)) mod p',
    scope: 'keccak256(UTF8(scope name)) mod p',
    nullifier: 'Poseidon2(DS_out, query, P.x, P.y), P the unblinded OPRF answer for query = Poseidon2(DS_query, address, domain, scope)',
  },
  private: ['oprf_public_key_x', 'oprf_public_key_y', 'oprf_beta', 'oprf_dlog_e', 'oprf_dlog_s', 'oprf_response_x', 'oprf_response_y'],
  wire_format: '0x + exactly 64 hex each; below the BN254 field modulus p (oprf_beta and oprf_dlog_s below the BabyJubJub subgroup order r, oprf_beta non-zero); never reduced',
});

const OPRF_WIRE_FIELDS = ['oprf_key_hash', 'domain', 'scope', 'nullifier', ...OPRF_GUIDE.private] as const;

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
        description: 'SHA-256 is precomputed over the whole 64-byte blocks before the "." between JWT header and payload. The rest (the whole payload) is passed as circuit input, and the payload starts base64_decode_offset bytes into it.',
        formula: 'cut = floor(len(header_b64) / 64) * 64; partialHash = SHA256_state(jwt_signed_data[0..cut]); base64_decode_offset = len(header_b64) + 1 - cut',
      },
      aud_hash: {
        description: 'keccak256 of the token\'s aud claim. This server proves only id_tokens from the ZKProofport device sign-in (@zkproofport-ai/mcp); a token issued to any other client is refused before proving, and verifiers refuse it too.',
        formula: 'aud_hash = keccak256(toUtf8Bytes(aud))',
      },
      nonce: {
        description: 'Device sign-in cannot carry a nonce, so this server always proves with nonce_mode 0 and an all-zero nonce_binding. (nonce_mode 1 is the ZKProofport app path, which binds the token to a dApp request.)',
        formula: 'nonce_mode = 0; nonce_binding = 0x00 * 32',
      },
      now: {
        description: 'Unix seconds the proof is made at; the circuit proves iat <= now < exp. Verifiers accept now up to 15 minutes behind and 5 minutes ahead of their clock, so verify soon after proving.',
        formula: 'now = server clock (raised to iat when the clock lags iat by at most 60s)',
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
        'Binds the proof to one request: the scope, the circuit and the request id the verifier issued (or a fresh one ' +
        'the SDK mints and returns). Contains NO wallet address -- it is a public input. The message the user signs ' +
        'when no action is bound; all zeros when one is. requestId: ASCII letters, digits and "-", at most 128 characters.',
      formula: 'signal_hash = keccak256(abi.encodePacked(scope, circuitId, requestId))',
      ethers_v6_code: `ethers.solidityPackedKeccak256(['string', 'string', 'string'], [scope, '${circuitId}', requestId])`,
    },
    oprf_nullifier: OPRF_GUIDE,
    ...(circuitId === CIRCUIT_IDS.COINBASE_ATTESTATION && {
      revocation_statement: {
        description:
          'coinbase_attestation v2: before any payment is taken the server reads the wallet\'s Coinbase KYC attestation ' +
          'on EAS (Base) and refuses unless it is Coinbase\'s, for this wallet, unrevoked and unexpired; it then signs a ' +
          '225-byte statement (wallet, time, attestation uid, this request\'s signed digest, the OPRF scope field as 32 bytes big-endian) with its statement key, ' +
          'which the circuit pins. Clients send nothing extra. The proof carries the statement time as public input ' +
          '`attested_at` (the last of 133 public inputs); verifiers should require it to be recent (e.g. 15 minutes).',
        refusals: 'NO_COINBASE_ATTESTATION / COINBASE_ATTESTATION_REVOKED / COINBASE_ATTESTATION_EXPIRED (403), OPRF_KEY_HASH_MISMATCH / INVALID_REQUEST (400), OPRF_NOT_CONFIGURED / OPRF_UNAVAILABLE (503) -- all before payment.',
      },
    }),
    ...(circuitId === CIRCUIT_IDS.COINBASE_COUNTRY_ATTESTATION && {
      revocation_statement: {
        description:
          'coinbase_country_attestation v2: before any payment is taken the server reads the wallet\'s Coinbase Verified ' +
          'Country attestation on EAS (Base) and refuses unless it is Coinbase\'s, for this wallet, unrevoked and unexpired, ' +
          'and names the same country as the attestCountry transaction in raw_transaction; it then signs a 227-byte ' +
          'statement (wallet, time, attestation uid, this request\'s signed digest, the OPRF scope field as 32 bytes big-endian, country) with its statement key, ' +
          'which the circuit pins. Clients send nothing extra. The proof carries the statement time as public input ' +
          '`attested_at` (the last of 155 public inputs); verifiers should require it to be recent (e.g. 15 minutes).',
        refusals: 'NO_COINBASE_ATTESTATION / COINBASE_ATTESTATION_REVOKED / COINBASE_ATTESTATION_EXPIRED / COINBASE_COUNTRY_MISMATCH / COINBASE_COUNTRY_UNREADABLE (403), OPRF_KEY_HASH_MISMATCH / INVALID_REQUEST (400), OPRF_NOT_CONFIGURED / OPRF_UNAVAILABLE (503) -- all before payment.',
      },
    }),
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
        { name: 'scope', type: 'string', description: 'Required, no default: what the proof is for within the service (1 to 256 UTF-8 bytes, no control or format characters). The nullifier is one per wallet per (oprf_domain, scope).' },
        { name: 'provider', type: 'google | microsoft', description: 'Optional. Read off the JWT iss; when given it must agree with it.' },
      ],
      accepted_tokens: 'RS256 id_token from the ZKProofport device sign-in only: aud must be the Google device client or the Microsoft client of @zkproofport-ai/mcp, iss Google or a Microsoft v2.0 tenant, and the token unexpired.',
      public_input_count: 214,
      provider_key_statement: {
        description:
          'Before any payment is taken the server validates the token, checks that the RSA key it was signed with is in ' +
          'the provider\'s published key list (Google, or Microsoft\'s organizations list), and signs a 313-byte statement ' +
          '(provider, now, modulus) with its own key, which the circuit pins. Clients send nothing extra; anything sent as ' +
          'providerKeyStatement is replaced. The public inputs are unchanged.',
        refusals: 'OIDC_TOKEN_REFUSED / OIDC_PROVIDER_KEY_INVALID (400), OIDC_PROVIDER_KEY_UNPUBLISHED (403, also when the key list cannot be fetched) -- all before payment. Encrypted payloads are refused (E2E_UNSUPPORTED).',
      },
      server_computed_fields: [
        { name: 'pubkey_modulus_limbs', description: '18 x u128 RSA public key modulus limbs (from JWKS)' },
        { name: 'domain', description: 'BoundedVec<u8, 64> — email domain bytes' },
        { name: 'scope', description: '32-byte keccak256(scope_string)' },
        { name: 'nullifier', description: '32-byte keccak256(keccak256(email) ++ scope)' },
        { name: 'provider', description: '0 = Google, 1 = Microsoft (public input 147)' },
        { name: 'aud_hash', description: '32-byte keccak256(aud) (public inputs 148-179)' },
        { name: 'nonce_mode', description: '0: device sign-in carries no nonce (public input 180)' },
        { name: 'nonce_binding', description: '32 zero bytes in nonce_mode 0 (public inputs 181-212)' },
        { name: 'now', description: 'u64 unix seconds, iat <= now < exp (public input 213)' },
        { name: 'partial_data', description: 'BoundedVec<u8, 2048> — JWT signed data from the block holding the header/payload "." onward' },
        { name: 'partial_hash', description: '8 x u32 — intermediate SHA-256 state' },
        { name: 'full_data_length', description: 'Total byte length of JWT signed data' },
        { name: 'base64_decode_offset', description: 'Index of the payload start within partial_data (1..64), asserted in-circuit' },
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
      description: 'keccak256(abi.encodePacked(scope, circuitId, requestId)) -- binds the proof to one request; no wallet address; zeros with an action',
      how_to_obtain: 'computeSignalHash({ scope, circuitId, requestId }) from @zkproofport-ai/sdk; requestId is the verifier\'s request id or a fresh UUID',
    },
    ...OPRF_WIRE_FIELDS.map((name) => ({
      name,
      type: 'hex string',
      bytes: 32,
      description: name in OPRF_GUIDE.public
        ? `OPRF public input: ${OPRF_GUIDE.public[name as keyof typeof OPRF_GUIDE.public]}`
        : 'OPRF private input',
      how_to_obtain: `Computed by the SDK OPRF step. ${OPRF_GUIDE.wire_format}.`,
    })),
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


/** The action-capable circuit also supports identity-only proofs. */
function buildActionGuide(circuitId: CircuitId, config: Config) {
  const circuit = CIRCUITS[circuitId];
  const source = ATTESTATION_SOURCES[circuitId];
  if (!source) throw new Error(`No attestation source for ${circuitId}`);
  const targets: Partial<Record<CircuitId, { chainId: number; name: string; rpc: string }>> = {
    [CIRCUIT_IDS.GIWA_ATTESTATION]: { chainId: GIWA_CHAIN_ID, name: 'GIWA Sepolia', rpc: config.giwaRpcUrl },
  };
  const target = targets[circuitId];
  if (!target) throw new Error(`No action guide target for ${circuitId}`);
  if (!Number.isSafeInteger(target.chainId) || target.chainId <= 0) throw new Error(`Invalid verification chain for ${circuitId}`);
  const verifier = getChainVerifiers(String(target.chainId))[circuitId];
  if (!verifier) throw new Error(`No ${circuitId} verifier configured on chain ${target.chainId}`);
  const networks = resolvePaymentNetworks(config.paymentNetworks);
  const isGiwa = source.kind === 'giwa-sepolia';
  const cliBase = `PROOFPORT_URL=${config.a2aBaseUrl} zkproofport-prove ${circuitId} --scope myapp:membership`;
  return {
    circuit_id: circuit.id, display_name: circuit.displayName,
    description: `Prove the configured ${isGiwa ? 'GIWA' : 'Coinbase KYC'} attestation, optionally authorizing one exact EIP-712 action with the same wallet.`,
    e2e_encryption: encryptionGuide(config),
    local_mcp_server: {
      recommended: true, npm_package: '@zkproofport-ai/mcp', version: mcpPkgVersion,
      install: 'npm install -g @zkproofport-ai/mcp@latest', command: 'zkproofport-mcp', transport: 'stdio',
      discovery: 'Connect, call tools/list, and follow generate_proof inputSchema. Keys stay in the local signer process.',
      required_arguments: ['circuit', 'scope', 'oprf_domain'], optional_arguments: ['action', 'pay_with', 'pay_on', 'max_payment'],
      generate_proof: { circuit: circuitId, oprf_domain: 'myapp.example.com', scope: 'myapp:membership' },
      action_bound_example: { circuit: circuitId, oprf_domain: 'myapp.example.com', scope: 'myapp:membership', action: '<complete EIP-712 typed action supplied by the trusted application>' },
      verification: `Call verify_proof with the returned result. Check the proof on ${target.name}; action authorization additionally requires application policy checks.`,
      credentials: `ATTESTATION_KEY stays local.${isGiwa ? ' The SDK uses its built-in GIWA Sepolia RPC and explorer for witness preparation; server GIWA_RPC_URL/GIWA_EXPLORER_URL configure the server-side path.' : ''} PAYMENT_PRIVATE_KEY is a separate key-based payment option, not a fallback to the attestation signer.`,
    },
    sdk: {
      package: '@zkproofport-ai/sdk',
      quick_start: `import { createConfig, generateProof } from '@zkproofport-ai/sdk';
// Supply an explicitly selected funded payment wallet when this service charges.
const result = await generateProof(
  createConfig({ baseUrl: '${config.a2aBaseUrl}' }),
  { attestation: existingAttestationSigner, payment },
  { circuit: '${circuitId}', oprfDomain: 'myapp.example.com', scope: 'myapp:membership', action },
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
        function_signature: 'verify(bytes proof, bytes32[] publicInputs) external view returns (bool)', public_input_count: 132,
        input_format: '132 bytes32 words: signal_hash 0-31, domain_separator 32-63, action_hash 64-95, signer_list_merkle_root 96-127 (one byte per word), oprf_key_hash 128, domain 129, scope 130, nullifier 131 (one Field per word). Keep proof and publicInputs separate.',
      },
    },
    action: {
      required: false, type: 'EIP-712 TypedData', required_fields_when_present: ['domain', 'types', 'primaryType', 'message'],
      domain: 'Bind name, version, chainId and verifyingContract to the intended application.',
      message: 'Use the complete application-provided typed action. The schema is application-defined; do not replace it with a fixed deposit or delegation example.',
      security: 'The application must compare domain, action hash, trusted attester root, scope and its replay/expiry policy. An identity-only proof does not authorize an action. The domain and action hash are public: an action whose proof is shown off-chain should not contain the user\'s wallet address in any field.',
    },
    formulas: {
      identity_signature: 'Without action, personal_sign(signal_hash), signal_hash = keccak256(abi.encodePacked(scope, circuitId, requestId)) (no wallet address). Circuit action_hash and domain_separator are zero.',
      signing_digest: 'With action, keccak256(0x1901 || domain_separator || action_hash); signal_hash is zero in the circuit witness.',
      domain_separator: 'EIP-712 domain hash', action_hash: 'EIP-712 hashStruct(primaryType, message)', scope: 'keccak256(UTF8(scope name)) mod p (computed by the SDK)',
      nullifier: OPRF_GUIDE.public.nullifier,
      nullifier_note: 'Same wallet, domain and scope produce the same nullifier with or without an action. See oprf_nullifier.',
      oprf_nullifier: OPRF_GUIDE,
    },
    input_schema: {
      preparation: 'Use generate_proof locally. On the REST wire omit both domain_separator and action_hash for identity-only mode; for action mode provide both 32-byte hashes.',
      public_fields: ['signal_hash', 'domain_separator', 'action_hash', 'signer_list_merkle_root', 'oprf_key_hash', 'domain', 'scope', 'nullifier'],
      private_inputs: 'Wallet public key and signature, signed attestation transaction and attester membership proof. Never expose these through an LLM.',
    },
    endpoints: buildEndpoints(config, circuitId),
  };
}

export function buildGuide(circuitId: CircuitId, config: Config): object {
  const circuit = CIRCUITS[circuitId];
  if (!circuit) throw new Error(`Unknown circuit '${circuitId}'.`);
  if (circuitId === CIRCUIT_IDS.GIWA_ATTESTATION) return buildActionGuide(circuitId, config);
  if (circuitId === CIRCUIT_IDS.HUMAN_PASSPORT_SCORE) return buildHumanPassportGuide(config);
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
      required_arguments: ['circuit', 'scope', ...(oidc ? [] : ['oprf_domain']), ...(country ? ['country_list', 'is_included'] : []), ...(oidc ? ['jwt'] : [])],
      generate_proof: { circuit: circuitAlias(circuitId), ...(!oidc && { oprf_domain: 'myapp.example.com' }), scope: 'myapp:membership', ...(country && { country_list: ['KR'], is_included: true }), ...(oidc && { jwt: '<existing id_token>', provider: 'google' }) },
    },
    sdk: {
      package: '@zkproofport-ai/sdk', repository: 'https://github.com/zkproofport/proofport-ai', install: 'npm install @zkproofport-ai/sdk@latest ethers',
      description: 'Use generateProof to prepare witnesses, request a challenge, pay using the explicit payment wallet, and encrypt when the deployment supplies a TEE key.',
      quick_start: `import { createConfig, generateProof } from '@zkproofport-ai/sdk';
// Existing signer and explicitly selected funded payment wallet stay in local code.
const result = await generateProof(
  createConfig({ baseUrl: '${config.a2aBaseUrl}' }),
  { attestation: existingAttestationSigner, payment: existingPaymentWallet },
  { circuit: '${circuitAlias(circuitId)}'${oidc ? '' : ", oprfDomain: 'myapp.example.com'"}, scope: 'myapp:membership'${params}${oidcParams} },
);`,
      cli: oidc
        ? 'Use local MCP generate_proof with jwt and provider, or the SDK example. Keep JWTs out of shell history.'
        : `PROOFPORT_URL=${config.a2aBaseUrl} zkproofport-prove ${circuitAlias(circuitId)} --scope myapp:membership${country ? ' --countries KR --included true' : ''} --silent`,
      payment_selection: 'Load PAYMENT_PRIVATE_KEY for pay_with=key, or select an existing CDP payment wallet with pay_with=cdp. The attestation signer is not a payment fallback.',
    },
    constants: buildConstants(config, circuitId), formulas: buildFormulas(circuitId), input_schema: buildInputSchema(circuitId), endpoints: buildEndpoints(config, circuitId),
  };
}

/**
 * human_passport_score: the client sends only its own signed request and the
 * threshold; the server finds and checks the Human Passport issuance on Base
 * before payment (src/input/humanPassport.ts).
 */
function buildHumanPassportGuide(config: Config) {
  const circuitId = CIRCUIT_IDS.HUMAN_PASSPORT_SCORE;
  const circuit = CIRCUITS[circuitId];
  const chainId = getPaymentChainId(config);
  const verifier = getChainVerifiers(String(chainId))[circuitId];
  if (!verifier) throw new Error(`No ${circuitId} verifier configured on chain ${chainId}`);
  const networks = resolvePaymentNetworks(config.paymentNetworks);
  const cliBase = `PROOFPORT_URL=${config.a2aBaseUrl} zkproofport-prove human_passport --min-score 20 --chain 8453 --scope myapp:membership`;
  return {
    circuit_id: circuitId, display_name: circuit.displayName, description: circuit.description,
    overview: {
      what: 'Prove the wallet holds an unexpired Human Passport score at or above min_score, without revealing the wallet or the exact score.',
      how: 'The wallet signs the request (or one EIP-712 action). The server finds the wallet\'s newest scoreV2 attestation on the chain the request names, reads the issuer-signed request from the transaction that recorded it, and proves the issuer signature, the threshold and the expiry in the circuit.',
      prerequisite: 'The wallet must already have a Human Passport score recorded on one of the chains below; the request names that chain (`chain`, its chain id).',
    },
    e2e_encryption: {
      ...encryptionGuide(config),
      this_circuit: 'Encrypted payloads are refused for human_passport (E2E_UNSUPPORTED): the server must read the request to find the wallet\'s issuance. Send plaintext inputs over HTTPS.',
    },
    local_mcp_server: {
      recommended: true, npm_package: '@zkproofport-ai/mcp', version: mcpPkgVersion,
      install: 'npm install -g @zkproofport-ai/mcp@latest', command: 'zkproofport-mcp', transport: 'stdio',
      required_arguments: ['circuit', 'scope', 'oprf_domain', 'min_score', 'chain'], optional_arguments: ['action', 'pay_with', 'pay_on', 'max_payment'],
      generate_proof: { circuit: 'human_passport', oprf_domain: 'myapp.example.com', scope: 'myapp:membership', min_score: 20, chain: 8453 },
    },
    sdk: {
      package: '@zkproofport-ai/sdk',
      quick_start: `import { createConfig, generateProof } from '@zkproofport-ai/sdk';
const result = await generateProof(
  createConfig({ baseUrl: '${config.a2aBaseUrl}' }),
  { attestation: existingAttestationSigner, payment },
  { circuit: 'human_passport', oprfDomain: 'myapp.example.com', scope: 'myapp:membership', minScore: 20, chain: 8453 },
);`,
      cli: `${cliBase} --silent`,
    },
    constants: {
      score_chains: Object.values(HUMAN_PASSPORT_CHAINS).map(c => ({
        chain_id: c.chainId, name: c.name, schema_id: c.schema, scorer_id: c.scorerId,
        index: humanPassportSource(c.chainId).index.url,
      })),
      issuer: HUMAN_PASSPORT_ISSUER,
      issuer_list: { root: HUMAN_PASSPORT_ISSUER_ROOT, leaves: HUMAN_PASSPORT_ISSUER_LEAVES, leaf: 'keccak256(issuer ++ GitcoinVerifier EIP-712 domain separator ++ scoreV2 schema); tree padded to a power of two, node = keccak256(left || right)' },
      max_score_data_bytes: HUMAN_PASSPORT_MAX_DATA_BYTES,
      payment: { required: config.paymentMode !== 'disabled', recipient: config.paymentPayTo, price: config.paymentProofPrice, source: 'Use the live 402 accepts list.' },
      x402: paymentGuide(config, networks),
      verification: {
        verifier_address: verifier, chain_id: chainId, rpc_url: config.chainRpcUrl,
        function_signature: 'verify(bytes proof, bytes32[] publicInputs) external view returns (bool)', public_input_count: 135,
        public_inputs: 'signal_hash 0-31, domain_separator 32-63, action_hash 64-95, signer_list_merkle_root 96-127, oprf_key_hash 128, domain 129, scope 130, nullifier 131, min_score 132 (score x 10^4), scorer_id 133, now 134',
        verifier_policy: 'The contract checks the proof only. Also require signer_list_merkle_root = the issuer root above, scorer_id one of the score_chains scorers, min_score = the threshold you asked for, and now within 15 minutes of your clock (@zkproofport-app/core checkHumanPassportProof does all four).',
      },
    },
    formulas: {
      signal_hash: 'keccak256(abi.encodePacked(scope, "human_passport_score", requestId)) -- no wallet address; personal_sign it when no action is bound',
      signing_digest: 'With an action, keccak256(0x1901 || domain_separator || action_hash); signal_hash is zero in the circuit witness.',
      scope: 'keccak256(UTF8(scope name)) mod p (computed by the SDK)',
      nullifier: OPRF_GUIDE.public.nullifier,
      oprf_nullifier: OPRF_GUIDE,
      min_score: 'threshold in Passport points x 10^4 (20 -> 200000); sent as a number of points, at most four decimals',
      now: 'server clock when the proof is made; the attestation must be unexpired then',
    },
    input_schema: {
      client_fields: [
        { name: 'signal_hash', bytes: 32 }, ...OPRF_WIRE_FIELDS.map((name) => ({ name, bytes: 32 })),
        { name: 'user_address', bytes: 20 }, { name: 'signature', bytes: 65 },
        { name: 'user_pubkey_x', bytes: 32 }, { name: 'user_pubkey_y', bytes: 32 },
        { name: 'min_score', type: 'number', description: 'Threshold in Passport points (e.g. 20), above 0, at most four decimals' },
        { name: 'chain', type: 'number', description: 'Chain id the score is recorded on (one of score_chains). Required; an unknown or missing chain is INVALID_REQUEST.' },
        { name: 'domain_separator', bytes: 32, optional: true }, { name: 'action_hash', bytes: 32, optional: true },
      ],
      refusals: 'NO_HUMAN_PASSPORT_SCORE / HUMAN_PASSPORT_SCORE_EXPIRED / HUMAN_PASSPORT_SCORE_BELOW_THRESHOLD / HUMAN_PASSPORT_DATA_TOO_LARGE / HUMAN_PASSPORT_ISSUANCE_UNREADABLE (403), HUMAN_PASSPORT_LOOKUP_FAILED (503), OPRF_KEY_HASH_MISMATCH / INVALID_REQUEST (400), OPRF_NOT_CONFIGURED / OPRF_UNAVAILABLE (503) -- all before payment.',
    },
    endpoints: buildEndpoints(config, circuitId),
  };
}
