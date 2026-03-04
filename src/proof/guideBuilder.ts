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
// Step builders
// ---------------------------------------------------------------------------

interface GuideStep {
  step: number;
  title: string;
  description: string;
  code: string;
}

function buildStep1(config: Config, circuitId: CircuitId): GuideStep {
  const alias = circuitAlias(circuitId);
  return {
    step: 1,
    title: 'Initiate Proof Request (x402 single-step)',
    description:
      'Send the proof request to /api/v1/prove without payment headers. ' +
      'The server responds with HTTP 402 containing a payment nonce. ' +
      'Save the nonce — you will use it when paying and retry with X-Payment-TX and X-Payment-Nonce headers. ' +
      'NOTE: You need all circuit inputs ready before this step. Prepare them in Steps 2-9 first, ' +
      'then come back to initiate the request.',
    code: `\
// First call: no payment headers — server returns 402 with nonce
const response = await fetch('${config.a2aBaseUrl}/api/v1/prove', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ circuit: '${alias}', inputs: { /* prepared in Steps 2-9 */ } }),
});

// Response status: 402 Payment Required
const data = await response.json();
// data = {
//   error: 'PAYMENT_REQUIRED',
//   nonce: '0x...',  // use this as the payment nonce
//   payment: { recipient: string, amount: number, asset: string, network: string, ... },
// }

const paymentNonce = data.nonce;
const payment = data.payment;  // { recipient, amount, asset, network }`,
  };
}

function buildStep2(config: Config, circuitId: CircuitId): GuideStep {
  const circuit = CIRCUITS[circuitId];
  return {
    step: 2,
    title: 'Query EAS Attestation',
    description:
      "Find the user's Coinbase attestation on Base chain via the EAS (Ethereum Attestation Service) GraphQL API. " +
      'Query for the most recent non-revoked attestation matching the schema ID and the user wallet address. ' +
      'Save the txid from the result -- it is the on-chain transaction that created the attestation.',
    code: `\
const EAS_GRAPHQL = '${config.easGraphqlEndpoint}';
const SCHEMA_ID = '${circuit.easSchemaId}';

const query = \`
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
  }
\`;

const response = await fetch(EAS_GRAPHQL, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    query,
    variables: { schemaId: SCHEMA_ID, recipient: userAddress },
  }),
});
const { data } = await response.json();

if (!data.attestations || data.attestations.length === 0) {
  throw new Error('No attestation found for this address and schema');
}

const attestation = data.attestations[0];
const txid = attestation.txid;  // Save this -- needed for raw TX fetch`,
  };
}

function buildStep3(config: Config, circuitId: CircuitId): GuideStep {
  const circuit = CIRCUITS[circuitId];
  const isTestnet = config.paymentMode === 'testnet';
  return {
    step: 3,
    title: 'Fetch Raw Transaction',
    description:
      'Fetch the full transaction object from the chain using the txid from Step 2. ' +
      'Validate that the transaction targets the Coinbase attester contract and uses the correct function selector. ' +
      'Then extract the signed RLP-encoded transaction bytes -- these are the raw bytes the ZK circuit will parse.',
    code: `\
import { ethers } from 'ethers';

const RPC_URL = '${config.baseRpcUrl}';  // Base Mainnet RPC (EAS attestations are always on Base Mainnet)
const provider = new ethers.JsonRpcProvider(RPC_URL);
const tx = await provider.getTransaction(txid);

if (!tx) {
  throw new Error('Transaction not found on chain');
}

// Validate target contract
if (tx.to?.toLowerCase() !== '${COINBASE_ATTESTER_CONTRACT}'.toLowerCase()) {
  throw new Error('Transaction is not to Coinbase attester contract');
}

// Validate function selector
if (!tx.data.startsWith('${circuit.functionSelector}')) {
  throw new Error('Wrong function selector');
}

// Get raw RLP-encoded signed transaction (EIP-1559, 12 fields)
const rawTx = ethers.Transaction.from(tx).serialized;
const rawTxBytes = ethers.getBytes(rawTx);
const tx_length = rawTxBytes.length;
const raw_transaction = ethers.hexlify(rawTxBytes);  // "0x..." hex string for the prove endpoint`,
  };
}

function buildStep4(): GuideStep {
  return {
    step: 4,
    title: 'Recover Attester Public Key',
    description:
      'Recover the uncompressed secp256k1 public key of the transaction signer (Coinbase attester). ' +
      'This is done by computing the unsigned transaction hash and using the transaction signature to recover the key. ' +
      'The result is a 65-byte uncompressed public key starting with 0x04. ' +
      'Split it into X and Y coordinates (32 bytes each) for the circuit.',
    code: `\
// Recover the uncompressed public key of the transaction signer (Coinbase attester)
const txResponse = await provider.getTransaction(txid);
const unsignedTx = ethers.Transaction.from(txResponse);
const unsignedHash = ethers.keccak256(unsignedTx.unsignedSerialized);
const signature = txResponse.signature;

const attesterPubkey = ethers.SigningKey.recoverPublicKey(unsignedHash, signature);
// attesterPubkey is "0x04..." (65 bytes uncompressed)

// Extract X and Y coordinates (each 32 bytes)
const pubkeyHex = attesterPubkey.slice(4); // remove "0x04" prefix
const coinbase_attester_pubkey_x = '0x' + pubkeyHex.slice(0, 64);
const coinbase_attester_pubkey_y = '0x' + pubkeyHex.slice(64, 128);`,
  };
}

function buildStep5(): GuideStep {
  return {
    step: 5,
    title: 'Build Merkle Proof',
    description:
      'Build a Merkle tree from the list of authorized Coinbase attester addresses. ' +
      'Determine which signer signed the attestation TX, find its leaf index, and extract the Merkle proof (sibling hashes). ' +
      'The circuit verifies that the attester is a member of this authorized set without revealing which one.',
    code: `\
const AUTHORIZED_SIGNERS = ${JSON.stringify(AUTHORIZED_SIGNERS, null, 2)};

// 1. Find which signer signed the attestation TX
const signerAddress = ethers.computeAddress(attesterPubkey);
const leaf_index = AUTHORIZED_SIGNERS.findIndex(
  s => s.toLowerCase() === signerAddress.toLowerCase()
);
if (leaf_index === -1) {
  throw new Error('Signer not in authorized list');
}

// 2. Build Merkle tree
// Leaf = keccak256(address_bytes) for each signer
const leaves = AUTHORIZED_SIGNERS.map(addr => {
  const addrBytes = ethers.getBytes(ethers.getAddress(addr));
  return ethers.keccak256(addrBytes);
});

// Build layers bottom-up (binary hash tree)
let layers = [leaves];
let currentLayer = leaves;
while (currentLayer.length > 1) {
  const nextLayer = [];
  for (let i = 0; i < currentLayer.length; i += 2) {
    const left = currentLayer[i];
    const right = currentLayer[i + 1] || left; // duplicate last if odd count
    nextLayer.push(
      ethers.keccak256(
        ethers.concat([ethers.getBytes(left), ethers.getBytes(right)])
      )
    );
  }
  layers.push(nextLayer);
  currentLayer = nextLayer;
}

const merkle_root = layers[layers.length - 1][0];  // "0x..." root hash

// 3. Extract proof path for leaf_index
const merkle_proof = [];
let idx = leaf_index;
for (let i = 0; i < layers.length - 1; i++) {
  const layer = layers[i];
  const siblingIdx = idx % 2 === 1 ? idx - 1 : idx + 1;
  merkle_proof.push(
    siblingIdx < layer.length ? layer[siblingIdx] : layer[idx]
  );
  idx = Math.floor(idx / 2);
}
const depth = merkle_proof.length;`,
  };
}

function buildStep6(circuitId: CircuitId): GuideStep {
  return {
    step: 6,
    title: 'Compute Signal Hash',
    description:
      'Compute the signal hash that binds the proof to a specific user address, scope, and circuit. ' +
      'This is keccak256(solidityPacked([address, string, string], [userAddress, scope, circuitId])). ' +
      'The circuitId MUST be the canonical name (e.g. "coinbase_attestation"), NOT the alias. ' +
      'SCOPE: A string chosen by the requesting application (e.g. "myapp-kyc-2024"). ' +
      'Same address + same scope = same nullifier = cannot re-prove. ' +
      'Use a unique scope per verification context. If unsure, use "default".',
    code: `\
// userAddress: the Ethereum address of the user who has the Coinbase attestation
// scope: a string chosen by your application to partition nullifiers
//   - Example: "myapp-kyc-2024", "verification-round-1", or "default"
//   - Same user + same scope → same nullifier → prevents double-proving
const scope = 'default';  // Replace with your application's scope string

// signal_hash = keccak256(abi.encodePacked(userAddress, scope, circuitId))
const signal_hash = ethers.keccak256(
  ethers.solidityPacked(
    ['address', 'string', 'string'],
    [userAddress, scope, '${circuitId}']
  )
);`,
  };
}

function buildStep7(): GuideStep {
  return {
    step: 7,
    title: 'Get User Signature',
    description:
      'The user signs the signal_hash with eth_sign (personal_sign). ' +
      'This produces a 65-byte ECDSA signature (r + s + v). ' +
      'The signature binds the user wallet to the proof request. ' +
      'AUTONOMOUS AGENT: If you have the user\'s private key (e.g. agent-controlled wallet), ' +
      'create an ethers.Wallet and call signMessage directly — no browser or MetaMask needed. ' +
      'DELEGATED AGENT: If you do NOT have the private key, you MUST ask the user to sign this message ' +
      'via their wallet (MetaMask, WalletConnect, etc.).',
    code: `\
// NOTE: This uses the KYC WALLET — the wallet that holds the Coinbase attestation.
// This may be DIFFERENT from the payer wallet used in Step 10.

// Option A: Autonomous agent with private key (no user interaction needed)
const kycWallet = new ethers.Wallet(kycPrivateKey, provider);
const signature = await kycWallet.signMessage(ethers.getBytes(signal_hash));

// Option B: Delegated agent — ask user to sign via their KYC wallet
// const signature = await userKycWallet.signMessage(ethers.getBytes(signal_hash));

// signature is "0x..." (65 bytes = 130 hex chars + "0x" prefix)`,
  };
}

function buildStep8(): GuideStep {
  return {
    step: 8,
    title: 'Recover User Public Key',
    description:
      "Recover the user's uncompressed secp256k1 public key from their signature. " +
      'Since eth_sign (personal_sign) prepends the Ethereum signed message prefix, use ethers.hashMessage to compute the correct digest. ' +
      'Split the recovered key into X and Y coordinates for the circuit.',
    code: `\
// Recover user's public key from the signature
const ethSignedHash = ethers.hashMessage(ethers.getBytes(signal_hash));
const userPubkey = ethers.SigningKey.recoverPublicKey(ethSignedHash, signature);
// userPubkey is "0x04..." (65 bytes uncompressed)

const pubHex = userPubkey.slice(4); // remove "0x04" prefix
const user_pubkey_x = '0x' + pubHex.slice(0, 64);
const user_pubkey_y = '0x' + pubHex.slice(64, 128);`,
  };
}

function buildStep9(): GuideStep {
  return {
    step: 9,
    title: 'Compute Scope & Nullifier',
    description:
      'Compute the scope bytes and the nullifier. ' +
      'scope_bytes = keccak256(toUtf8Bytes(scopeString)). ' +
      'nullifier = keccak256(keccak256(address_bytes || signal_hash_bytes) || scope_bytes_bytes). ' +
      'The nullifier prevents double-proving for the same user+scope combination.',
    code: `\
// scope_bytes = keccak256(toUtf8Bytes(scopeString))
const scope_bytes = ethers.keccak256(ethers.toUtf8Bytes(scope));

// nullifier = keccak256(keccak256(address_bytes || signal_hash_bytes) || scope_bytes_bytes)
const userAddressBytes = ethers.getBytes(userAddress);
const signalHashBytes = ethers.getBytes(signal_hash);
const scopeBytesBytes = ethers.getBytes(scope_bytes);

const userSecret = ethers.keccak256(
  ethers.concat([userAddressBytes, signalHashBytes])
);
const nullifier = ethers.keccak256(
  ethers.concat([ethers.getBytes(userSecret), scopeBytesBytes])
);`,
  };
}

function buildStep10(config: Config, usdcAddress: string, chainId: number, isTestnet: boolean): GuideStep {
  if (isTestnet) {
    return {
      step: 10,
      title: 'Make USDC Payment (Direct Transfer)',
      description:
        'Pay for proof generation using a direct ERC-20 transfer. ' +
        'Base Sepolia USDC does NOT support EIP-3009 (transferWithAuthorization), ' +
        'so testnet uses a direct transfer() call with the session nonce appended to calldata. ' +
        'The payer wallet pays gas directly (no facilitator on testnet). ' +
        'IMPORTANT: Append payment.nonce (from Step 1) to the transfer calldata — ' +
        'the server uses this to match the payment to your proof session. ' +
        'AUTONOMOUS AGENT: If you have the private key for a USDC-holding wallet, ' +
        'create an ethers.Wallet and send the transaction directly — fully autonomous. ' +
        'DELEGATED AGENT: If you do NOT have the private key, ask the user to send the transaction via their wallet.',
      code: `\
// Step 10: Make USDC Payment (Direct Transfer)
// Base Sepolia USDC does NOT support EIP-3009 (transferWithAuthorization),
// so we use a direct ERC-20 transfer with the session nonce appended to calldata.
const USDC_ADDRESS = '${usdcAddress}';
const payment = data.payment;  // from Step 1 (402 response body)

// NOTE: The PAYER wallet can be DIFFERENT from the KYC wallet (userAddress).
// The payer just needs USDC balance + ETH for gas.

// Option A: Autonomous agent with private key
const payerWallet = new ethers.Wallet(payerPrivateKey, provider);
// Option B: Delegated — use user's signer
// const payerWallet = userPayerSigner;

// Encode transfer(to, amount) + append payment nonce to calldata
const iface = new ethers.Interface(['function transfer(address to, uint256 amount) returns (bool)']);
const transferData = iface.encodeFunctionData('transfer', [payment.recipient, payment.amount]);
const dataWithNonce = transferData + paymentNonce.slice(2); // append raw nonce bytes

const tx = await payerWallet.sendTransaction({
  to: USDC_ADDRESS,
  data: dataWithNonce,
});
console.log('TX submitted:', tx.hash);
const receipt = await tx.wait();
const payment_tx_hash = tx.hash;  // Use this in Step 11`,
    };
  }

  return {
    step: 10,
    title: 'Make USDC Payment via x402',
    description:
      'Pay for proof generation using the x402 payment protocol. ' +
      'Base Mainnet USDC supports EIP-3009 TransferWithAuthorization for gasless USDC transfers. ' +
      'You sign an EIP-712 typed data authorization, then submit it to the x402 facilitator ' +
      'who settles the payment on-chain (the facilitator pays gas, not you). ' +
      'IMPORTANT: Use the session nonce from Step 1 (payment.nonce) as the EIP-3009 nonce. ' +
      'This binds the payment to your proof session. ' +
      'AUTONOMOUS AGENT: If you have the private key for a USDC-holding wallet, ' +
      'create an ethers.Wallet and call signTypedData directly — fully autonomous, no browser needed. ' +
      'DELEGATED AGENT: If you do NOT have the private key, ask the user to sign the EIP-712 authorization via their wallet.',
    code: `\
// Step 10: Make USDC Payment via x402 Protocol
// Base Mainnet USDC supports EIP-3009 (transferWithAuthorization).
// Sign an EIP-712 authorization, then submit to x402 facilitator (facilitator pays gas).
const USDC_ADDRESS = '${usdcAddress}';
const X402_FACILITATOR = 'https://www.x402.org/facilitator';
const payment = data.payment;  // from Step 1 (402 response body)

// NOTE: The PAYER wallet can be DIFFERENT from the KYC wallet (userAddress).
const from = payerAddress;          // payer wallet (must hold USDC)
const to = payment.recipient;       // prover agent (payee)
const value = payment.amount;       // USDC amount in base units
const validAfter = 0;
const validBefore = Math.floor(Date.now() / 1000) + 3600;
// Payment nonce from Step 1 (402 response) — zero-pad to 32 bytes for EIP-3009
const nonce = ethers.zeroPadValue(paymentNonce, 32);

// Sign EIP-712 TransferWithAuthorization
const domain = {
  name: '${isTestnet ? 'USDC' : 'USD Coin'}',
  version: '2',
  chainId: ${chainId},
  verifyingContract: USDC_ADDRESS,
};
const types = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
};
const message = { from, to, value, validAfter, validBefore, nonce };

// Option A: Autonomous agent with private key
const payerWallet = new ethers.Wallet(payerPrivateKey, provider);
const authSig = await payerWallet.signTypedData(domain, types, message);

// Option B: Delegated — ask user to sign
// const authSig = await userPayerWallet.signTypedData(domain, types, message);

// Submit to x402 facilitator (Coinbase x402 v1 API format)
const settleResponse = await fetch(X402_FACILITATOR + '/settle', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    x402Version: 1,
    paymentPayload: {
      x402Version: 1,
      scheme: 'exact',
      network: 'base',
      payload: {
        signature: authSig,
        authorization: {
          from,
          to,
          value: String(value),
          validAfter: String(validAfter),
          validBefore: String(validBefore),
          nonce,
        },
      },
    },
    paymentRequirements: {
      scheme: 'exact',
      network: 'base',
      maxAmountRequired: String(value),
      resource: '${config.a2aBaseUrl}/api/v1/prove',
      description: 'ZK proof generation payment',
      mimeType: 'application/json',
      payTo: to,
      maxTimeoutSeconds: 300,
      asset: USDC_ADDRESS,
      extra: {
        name: '${isTestnet ? 'USDC' : 'USD Coin'}',
        version: '2',
      },
    },
  }),
});

const settleResult = await settleResponse.json();
if (!settleResult.success) {
  throw new Error('x402 settlement failed: ' + JSON.stringify(settleResult));
}
const payment_tx_hash = settleResult.txHash;  // Use this in Step 11`,
  };
}

function buildStep11(config: Config, circuitId: CircuitId): GuideStep {
  const isCountry = circuitId === 'coinbase_country_attestation';
  const alias = circuitAlias(circuitId);

  const countryComment = isCountry
    ? `\
    // Country-specific fields (REQUIRED for coinbase_country circuit):
    country_list: countryList,  // e.g. ["US", "KR"] -- ISO 3166-1 alpha-2
    is_included: isIncluded,    // true = prove membership, false = prove exclusion`
    : `\
    // For coinbase_country circuit only (not needed here):
    // country_list: ["US", "KR"],
    // is_included: true,`;

  return {
    step: 11,
    title: 'Submit Proof Request (with payment headers)',
    description:
      'Retry POST /api/v1/prove with payment headers (X-Payment-TX and X-Payment-Nonce). ' +
      'The server verifies payment on-chain and generates the ZK proof inside a TEE. ' +
      'Returns the proof, public inputs, and optional attestation. ' +
      (isCountry
        ? 'This is the coinbase_country circuit, so country_list and is_included fields are REQUIRED.'
        : 'For the coinbase_country circuit, you would also include country_list and is_included fields.'),
    code: `\
const proveBody = {
  circuit: '${alias}',
  inputs: {
    signal_hash,
    nullifier,
    scope_bytes,
    merkle_root,
    user_address: userAddress,
    signature,
    user_pubkey_x,
    user_pubkey_y,
    raw_transaction,
    tx_length,
    coinbase_attester_pubkey_x,
    coinbase_attester_pubkey_y,
    merkle_proof,
    leaf_index,
    depth,
${countryComment}
  },
};

// payment_tx_hash comes from Step 10 (x402 facilitator or direct transfer)
const response = await fetch('${config.a2aBaseUrl}/api/v1/prove', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-Payment-TX': payment_tx_hash,   // from Step 10
    'X-Payment-Nonce': paymentNonce,   // from Step 1 (402 response)
  },
  body: JSON.stringify(proveBody),
});

// Response: {
//   proof: string,          // hex-encoded proof bytes
//   publicInputs: string,   // hex-encoded public inputs (concatenated 32-byte fields)
//   proofWithInputs: string,// combined hex for on-chain submission
//   attestation?: object,   // TEE attestation (if enabled)
//   timing: object,         // performance metrics
// }
const result = await response.json();`,
  };
}

function buildStep12(config: Config, circuitId: CircuitId, chainId: number): GuideStep {
  const chainVerifiers = VERIFIER_ADDRESSES[String(chainId)] || {};
  const verifierAddr = chainVerifiers[circuitId] || 'NOT_DEPLOYED';

  return {
    step: 12,
    title: 'Verify Proof On-Chain (Optional)',
    description:
      'After receiving the proof from Step 11, you can verify it on-chain by calling the verifier smart contract. ' +
      'The verifier takes two arguments: the proof bytes and an array of bytes32 public inputs. ' +
      'The API returns publicInputs as one concatenated hex blob — split it into 32-byte chunks for the bytes32[] parameter. ' +
      'The verify function returns true if the proof is valid. ' +
      'This step is OPTIONAL — it is useful for applications that need trustless on-chain verification ' +
      '(e.g., gating access to a DeFi protocol, minting an NFT, or recording verification on-chain).',
    code: `\
// Verifier contract address for ${circuitId} on chain ${chainId}
const VERIFIER_ADDRESS = '${verifierAddr}';
const VERIFIER_ABI = [
  'function verify(bytes calldata _proof, bytes32[] calldata _publicInputs) external view returns (bool)',
];

// Use payment chain provider for on-chain verification
const verificationProvider = new ethers.JsonRpcProvider('${config.chainRpcUrl}');
const verifier = new ethers.Contract(VERIFIER_ADDRESS, VERIFIER_ABI, verificationProvider);

// The API returns proof and publicInputs as separate hex strings.
// publicInputs is one concatenated blob — split into 32-byte (bytes32) chunks.
const rawPI = result.publicInputs.startsWith('0x') ? result.publicInputs.slice(2) : result.publicInputs;
const publicInputsArray = [];
for (let i = 0; i < rawPI.length; i += 64) {
  publicInputsArray.push('0x' + rawPI.slice(i, i + 64));
}

const isValid = await verifier.verify(result.proof, publicInputsArray);
console.log('On-chain verification:', isValid ? 'VALID' : 'INVALID');`,
  };
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
  const priceStr = config.paymentProofPrice;

  const steps: GuideStep[] = [
    buildStep1(config, circuitId),
    buildStep2(config, circuitId),
    buildStep3(config, circuitId),
    buildStep4(),
    buildStep5(),
    buildStep6(circuitId),
    buildStep7(),
    buildStep8(),
    buildStep9(),
    buildStep10(config, usdcAddress, chainId, isTestnet),
    buildStep11(config, circuitId),
    buildStep12(config, circuitId, chainId),
  ];

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
        install: 'cd proofport-ai && npm install',
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
      install: 'git clone https://github.com/zkproofport/proofport-ai.git && cd proofport-ai && npm install',
      description:
        'Use the @proofport/client SDK directly in your code for programmatic proof generation.',
      quick_start: `\
import { generateProof } from '@proofport/client';

const result = await generateProof(
  { baseUrl: '${config.a2aBaseUrl}' },
  {
    attestationPrivateKey: '0x...',  // wallet with Coinbase KYC attestation
    paymentPrivateKey: '0x...',      // wallet with USDC balance (optional, defaults to attestation key)
  },
  { circuit: '${circuitAlias(circuitId)}', scope: 'proofport' },
);

console.log(result.proof);           // ZK proof hex
console.log(result.publicInputs);    // public inputs hex
console.log(result.proofWithInputs); // combined for on-chain verify`,
      cli: `\
# Clone and install
git clone https://github.com/zkproofport/proofport-ai.git
cd proofport-ai && npm install

# Run full-flow example
ATTESTATION_KEY=0x... PAYMENT_KEY=0x... SERVER_URL=${config.a2aBaseUrl} npx tsx packages/client/examples/full-flow.ts`,
    },

    // MANUAL REFERENCE: For agents that cannot install npm packages
    manual_reference: {
      overview:
        'The steps below document the manual process for agents that CANNOT install npm packages. ' +
        'If you can install packages, use the local MCP server or SDK above instead. ' +
        'IMPORTANT: This flow uses TWO chains. ' +
        'EAS attestation data (Steps 2-5) is ALWAYS on Base Mainnet (chain ID 8453, RPC: ' + config.baseRpcUrl + '). ' +
        'Payment and on-chain verification (Steps 10-12) use ' +
        (isTestnet ? 'Base Sepolia (testnet, chain ID 84532, RPC: ' + config.chainRpcUrl + ')' : 'Base Mainnet (chain ID 8453, RPC: ' + config.chainRpcUrl + ')') + '. ' +
        'Do NOT use the payment chain RPC for EAS data — attestation transactions will not be found on testnet.',
      prerequisites: [
        'ethers.js v6 (npm install ethers)',
        'User wallet address with Coinbase KYC attestation on Base',
        'User wallet capable of signing messages (personal_sign) and EIP-712 typed data',
        'USDC balance sufficient for proof fee (' + priceStr + ' USDC) on ' + (isTestnet ? 'Base Sepolia' : 'Base'),
        'Internet access to query EAS GraphQL API and Base RPC',
      ],
      agent_modes: {
        autonomous: {
          description: 'Agent has private keys. All steps execute without user interaction.',
          requirements: [
            'ATTESTATION_KEY: Private key for wallet with Coinbase EAS attestation',
            'PAYMENT_KEY: Private key for wallet with USDC balance (can be same wallet)',
          ],
          fully_automatic: true,
        },
        delegated: {
          description: 'Agent prepares inputs but delegates signing to user.',
          user_interactions: ['Step 7: personal_sign of signal_hash', 'Step 10: EIP-712 signTypedData for USDC payment'],
          fully_automatic: false,
        },
      },
      steps,
    },

    constants: buildConstants(config, circuitId, isTestnet, chainId, usdcAddress, paymentAmount),
    formulas: buildFormulas(circuitId),
    code_examples: buildCodeExamples(config, circuitId, usdcAddress, chainId, paymentAmount),
    input_schema: buildInputSchema(circuitId),
    endpoints: buildEndpoints(config, circuitId),
  };
}
