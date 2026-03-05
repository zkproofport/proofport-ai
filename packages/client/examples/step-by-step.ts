/**
 * Step-by-Step ZK Proof Generation (x402 flow)
 *
 * Demonstrates each step independently for debugging and understanding.
 *
 * Usage:
 *   ATTESTATION_KEY=0x... PAYMENT_KEY=0x... SERVER_URL=https://stg-ai.zkproofport.app npx tsx examples/step-by-step.ts
 */
import { ethers } from 'ethers';
import {
  requestChallenge,
  prepareInputs,
  makePayment,
  submitProof,
  verifyOnChain,
  computeSignalHash,
  CIRCUIT_NAME_MAP,
  USDC_ADDRESSES,
  EthersWalletSigner,
  createConfig,
} from '../src/index.js';
import type { CircuitName, PaymentInfo } from '../src/index.js';

async function main() {
  const attestationKey = process.env.ATTESTATION_KEY;
  if (!attestationKey) {
    console.error('Error: ATTESTATION_KEY environment variable is required');
    process.exit(1);
  }

  const config = createConfig({
    ...(process.env.SERVER_URL && { baseUrl: process.env.SERVER_URL }),
  });

  const circuit: CircuitName = (process.env.CIRCUIT || 'coinbase_kyc') as CircuitName;
  const circuitId = CIRCUIT_NAME_MAP[circuit];
  const scope = process.env.SCOPE || 'proofport';

  const attestationWallet = new ethers.Wallet(attestationKey);
  const paymentKey = process.env.PAYMENT_KEY || attestationKey;
  const paymentWallet = new ethers.Wallet(paymentKey);

  console.log('=== Step-by-Step Proof Generation (x402 flow) ===');
  console.log(`Attestation wallet: ${attestationWallet.address}`);
  console.log(`Payment wallet:     ${paymentWallet.address}`);
  console.log('');

  // -- Step 1: Sign Signal Hash --
  console.log('[Step 1] Signing signal hash...');
  const signalHash = computeSignalHash(attestationWallet.address, scope, circuitId);
  const signalHashHex = ethers.hexlify(signalHash);
  const signature = await attestationWallet.signMessage(ethers.getBytes(signalHashHex));
  console.log(`  Signal hash: ${signalHashHex}`);
  console.log(`  Signature:   ${signature}`);
  console.log('');

  // -- Step 2: Prepare Circuit Inputs --
  console.log('[Step 2] Preparing circuit inputs (fetching attestation, computing hashes)...');
  const inputs = await prepareInputs(config, {
    circuitId,
    userAddress: attestationWallet.address,
    userSignature: signature,
    scope,
  });
  console.log(`  Signal hash:  ${inputs.signal_hash}`);
  console.log(`  Nullifier:    ${inputs.nullifier}`);
  console.log(`  Merkle root:  ${inputs.merkle_root}`);
  console.log(`  TX length:    ${inputs.tx_length} bytes`);
  console.log('');

  // -- Step 3: Request 402 Challenge --
  console.log('[Step 3] Requesting 402 payment challenge...');
  const challenge = await requestChallenge(config, circuit, inputs);
  console.log(`  Nonce:      ${challenge.nonce}`);
  console.log(`  Amount:     ${challenge.payment.maxAmountRequired} (${parseInt(challenge.payment.maxAmountRequired) / 1e6} USDC)`);
  console.log(`  Pay to:     ${challenge.payment.payTo}`);
  console.log(`  Network:    ${challenge.payment.network}`);
  console.log('');

  // -- Step 4: Make Payment --
  console.log('[Step 4] Making payment via x402 facilitator...');
  const network = challenge.payment.network as keyof typeof USDC_ADDRESSES;
  const rpcUrl = network === 'base' ? 'https://mainnet.base.org' : 'https://sepolia.base.org';
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const connectedPaymentWallet = paymentWallet.connect(provider);
  const paymentSigner = new EthersWalletSigner(connectedPaymentWallet);

  const paymentInfo: PaymentInfo = {
    nonce: challenge.nonce,
    recipient: challenge.payment.payTo,
    amount: parseInt(challenge.payment.maxAmountRequired),
    asset: USDC_ADDRESSES[network],
    network: challenge.payment.network,
    instruction: challenge.payment.description,
  };

  const paymentTxHash = await makePayment(paymentSigner, paymentInfo);
  console.log(`  Payment TX: ${paymentTxHash}`);
  console.log('');

  // -- Step 5: Submit Proof with Payment Headers --
  console.log('[Step 5] Submitting proof generation request...');
  const proveResult = await submitProof(config, {
    circuit,
    inputs,
    paymentTxHash,
    paymentNonce: challenge.nonce,
  });
  console.log(`  Proof:     ${proveResult.proof}`);
  console.log(`  Inputs:    ${proveResult.publicInputs}`);
  console.log(`  TEE:       ${proveResult.attestation ? 'Attested' : 'None'}`);
  console.log(`  Timing:    ${proveResult.timing.totalMs}ms total`);
  console.log('');

  // -- Step 6: On-Chain Verification --
  console.log('[Step 6] Verifying on-chain...');
  if (!proveResult.verification) {
    console.log('  Skipped: no verifier deployed on this network');
  } else {
    const verification = await verifyOnChain(
      proveResult.verification,
      proveResult.proof,
      proveResult.publicInputs,
    );
    console.log(`  Valid: ${verification.valid}`);
    if (verification.error) {
      console.log(`  Error: ${verification.error}`);
    }
  }

  console.log('');
  console.log('=== Complete ===');
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
