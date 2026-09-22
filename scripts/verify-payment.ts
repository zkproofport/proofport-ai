/**
 * Prove, on a real chain, that a buyer can pay without gas.
 *
 * The claim this checks is the whole basis of the payment design: the buyer
 * signs an EIP-3009 authorization and somebody else submits it, so the buyer
 * needs USDC and nothing else -- no native gas token, no balance beyond the
 * price. On Arc that claim is load-bearing, because no public x402 facilitator
 * settles Arc, so this service settles it and the buyer has no third party to
 * fall back on.
 *
 * It is a script and not a hand-typed sequence because the sequence is fiddly
 * (three wallets, two decimal views of one balance, a gas measurement that is
 * only meaningful if read at the right moment) and because a future session
 * asking "does paying on Arc actually work" should be able to run it rather
 * than reconstruct it.
 *
 * ## What it does
 *
 *   1. Funds a settler wallet, if it needs it. On Arc the gas asset IS USDC,
 *      so this is a plain transfer.
 *   2. Builds the payment requirement with `buildPaymentRequirements` -- the
 *      same function that answers 402 -- and signs it with `signPayment` from
 *      the SDK. The buyer never touches the chain.
 *   3. Settles it with `settlePayment`, the same function the route calls.
 *   4. Checks that the recipient received exactly the price, and that the
 *      buyer's balance fell by exactly the price and not one wei more --
 *      which is the actual test. A buyer paying its own gas would show a
 *      larger drop.
 *
 * Steps 2 and 3 deliberately call the production functions rather than a
 * hand-built equivalent. An earlier version of this script assembled the
 * EIP-3009 signature and the `transferWithAuthorization` call itself, which
 * proved the CHAIN supports the flow and said nothing about whether this
 * service's code does. Three bugs that would have broken every payment lived
 * in exactly that gap -- the v2 amount field name, the v2 header name, and
 * spend controls refusing Arc's USDC -- and none of them were visible to a
 * hand-built check.
 *
 * ## Prerequisites
 *
 *   PAYMENT_BUYER_KEY     a wallet with USDC on the chain being tested.
 *                         On arc-testnet this is the wallet Arc's faucet
 *                         funded; `circuits/.env.development` PRIVATE_KEY was
 *                         that wallet on 2026-09-09.
 *   PROVER_PRIVATE_KEY   the wallet that submits. Funded from the
 *                         buyer by step 1 when it is empty.
 *   PAYMENT_PAY_TO       the prover wallet address for direct settlement.
 *
 * ## Usage
 *
 *   PAYMENT_BUYER_KEY=0x... PROVER_PRIVATE_KEY=0x... PAYMENT_PAY_TO=0x... \
 *     npx tsx scripts/verify-payment.ts arc-testnet [price]
 */

import { createWalletClient, createPublicClient, http, publicActions, parseUnits, formatUnits } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import * as viemChains from 'viem/chains';
import { getPaymentNetwork, allPaymentNetworkIds, buildPaymentRequirements } from '../src/payment/networks.js';
import { settlePayment } from '../src/payment/settle.js';
import { getSettlementAccount } from '../src/payment/settlementAccount.js';
import { signPayment } from '../packages/sdk/src/payment.js';
import { walletFromPrivateKey } from '../packages/sdk/src/wallets.js';

const ERC20 = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'transfer', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }] },
  {
    type: 'function',
    name: 'transferWithAuthorization',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' },
      { name: 'validBefore', type: 'uint256' },
      { name: 'nonce', type: 'bytes32' },
      { name: 'v', type: 'uint8' },
      { name: 'r', type: 'bytes32' },
      { name: 's', type: 'bytes32' },
    ],
    outputs: [],
  },
  { type: 'function', name: 'name', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'version', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  { type: 'function', name: 'DOMAIN_SEPARATOR', stateMutability: 'view', inputs: [], outputs: [{ type: 'bytes32' }] },
] as const;

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v.startsWith('0x') ? v : `0x${v}`;
}

async function main() {
  const networkName = process.argv[2];
  const price = process.argv[3] ?? '0.01';
  if (!networkName) {
    throw new Error(`Usage: verify-payment.ts <network> [price]\nNetworks: ${allPaymentNetworkIds().join(', ')}`);
  }
  const net = getPaymentNetwork(networkName);
  if (!net) {
    throw new Error(`Unknown network '${networkName}'. Known: ${allPaymentNetworkIds().join(', ')}`);
  }

  const chain = Object.values(viemChains).find(
    (c): c is typeof viemChains.base => !!c && typeof c === 'object' && 'id' in c && c.id === net.chainId,
  );
  if (!chain) throw new Error(`viem has no chain for ${net.id} (chainId ${net.chainId})`);

  const rpc = process.env[net.rpcEnv] || net.defaultRpc;
  const pub = createPublicClient({ chain, transport: http(rpc) });

  const buyer = privateKeyToAccount(need('PAYMENT_BUYER_KEY') as `0x${string}`);
  // Only chains this service settles itself need a settler wallet. On a
  // facilitator-settled chain the facilitator pays the gas and no wallet of
  // ours is involved at all -- demanding one there would refuse to test the
  // very route that needs no wallet.
  const needsSettler = net.settlement === 'payee';
  const settler = needsSettler
    ? getSettlementAccount(need('PROVER_PRIVATE_KEY'), process.env.PAYMENT_PAY_TO || '')
    : null;
  // Direct settlement must target the submitting prover wallet (Arc enforces
  // this). Facilitator settlement can still measure a fresh recipient.
  const recipient = settler ? settler.address : privateKeyToAccount(generatePrivateKey()).address;
  if (buyer.address.toLowerCase() === recipient.toLowerCase()) {
    throw new Error("PAYMENT_BUYER_KEY must differ from the prover recipient for the balance measurement.");
  }

  console.log(`\n  chain      ${net.id} (${net.chainId}) via ${rpc}`);
  console.log(`  buyer      ${buyer.address}`);
  console.log(
    `  settler    ${settler ? settler.address : `(none — ${net.facilitatorUrl} settles this chain and pays the gas)`}`,
  );
  console.log(`  recipient  ${recipient}`);

  // The contract's own answers, not this table's. A mismatch here is the
  // difference between a valid signature and a valid signature over the wrong
  // message, which fails with no useful error.
  const [onName, onVersion, onDecimals, onSeparator] = await Promise.all([
    pub.readContract({ address: net.usdc as `0x${string}`, abi: ERC20, functionName: 'name' }),
    pub.readContract({ address: net.usdc as `0x${string}`, abi: ERC20, functionName: 'version' }),
    pub.readContract({ address: net.usdc as `0x${string}`, abi: ERC20, functionName: 'decimals' }),
    pub.readContract({ address: net.usdc as `0x${string}`, abi: ERC20, functionName: 'DOMAIN_SEPARATOR' }),
  ]);
  console.log(`\n  USDC at ${net.usdc}`);
  console.log(`    name()      ${onName}       (table: ${net.eip3009.name})`);
  console.log(`    version()   ${onVersion}          (table: ${net.eip3009.version})`);
  console.log(`    decimals()  ${onDecimals}          (table: ${net.decimals})`);
  if (onName !== net.eip3009.name || onVersion !== net.eip3009.version || Number(onDecimals) !== net.decimals) {
    throw new Error(
      `networks.ts disagrees with the contract. Fix the table -- a wrong EIP-712 domain ` +
      `produces a valid signature over the wrong message.`,
    );
  }

  const amount = parseUnits(price, net.decimals);
  const fmt = (v: bigint) => `${formatUnits(v, net.decimals)} USDC`;
  /**
   * A balance, read at a named block rather than at "latest".
   *
   * The block matters. Read at "latest" immediately after a receipt, a
   * load-balanced RPC can answer from a node one block behind and report the
   * pre-payment balance -- which is not a small error, it is the whole
   * measurement. This script did exactly that on base-sepolia on 2026-09-09
   * and printed FAILED over a payment that had gone through correctly:
   * 0x fb5ee2a7... moved 0.01 USDC to the right address and the balances said
   * nothing had moved. Reporting that as a broken facilitator would have been
   * a false claim produced by a lagging read.
   *
   * So "before" is read at the block before settlement and "after" at the
   * settlement block, both pinned. Every node agrees about a past block.
   */
  const usdcOf = (who: `0x${string}`, blockNumber?: bigint) =>
    pub.readContract({
      address: net.usdc as `0x${string}`,
      abi: ERC20,
      functionName: 'balanceOf',
      args: [who],
      ...(blockNumber === undefined ? {} : { blockNumber }),
    }) as Promise<bigint>;

  // Step 1: the settler needs gas. On Arc that means USDC.
  let settlerNative = settler ? await pub.getBalance({ address: settler.address }) : 0n;
  if (settler && settlerNative === 0n) {
    if (!net.nativeUsdc) {
      throw new Error(
        `settler ${settler.address} has no native balance on ${net.id} and USDC is not the gas asset there, ` +
        `so it cannot be funded from USDC. Fund it with the chain's gas token.`,
      );
    }
    console.log(`\n  settler has no gas; sending 1 USDC (which IS gas here)`);
    const buyerWallet = createWalletClient({ account: buyer, chain, transport: http(rpc) });
    const fundHash = await buyerWallet.sendTransaction({
      to: settler.address,
      value: parseUnits('1', net.nativeDecimals ?? 18),
    });
    await pub.waitForTransactionReceipt({ hash: fundHash });
    settlerNative = await pub.getBalance({ address: settler.address });
    console.log(`    funded: ${fundHash}`);
  }

  // Pinned, so "before" and "after" are the same two blocks for every node.
  const blockBefore = await pub.getBlockNumber();
  const before = {
    buyerUsdc: await usdcOf(buyer.address, blockBefore),
    buyerNative: await pub.getBalance({ address: buyer.address, blockNumber: blockBefore }),
    recipientUsdc: await usdcOf(recipient, blockBefore),
    settlerNative: settler ? await pub.getBalance({ address: settler.address, blockNumber: blockBefore }) : 0n,
  };
  console.log(`\n  before`);
  console.log(`    buyer      ${fmt(before.buyerUsdc)}`);
  console.log(`    recipient  ${fmt(before.recipientUsdc)}`);

  // Step 2: the buyer signs, through the SDK, the requirement this service
  // would actually have sent.
  const requirement = buildPaymentRequirements({
    networks: [net],
    price,
    payTo: recipient,
    resource: 'https://example.invalid/api/v1/prove',
    nonce: '0x' + '22'.repeat(32),
    parseUnits: (v, d) => parseUnits(v, d),
  })[0];

  const nonce = requirement.extra.nonce;
  if (typeof nonce !== 'string') throw new Error('Payment requirement is missing its string nonce.');
  const wallet = await walletFromPrivateKey(need('PAYMENT_BUYER_KEY'));
  const paid = await signPayment(
    { nonce, accepts: [requirement as never] },
    wallet,
    { network: net.id },
  );
  const header = paid.headers['PAYMENT-SIGNATURE'];
  if (!header) {
    throw new Error(
      `signPayment produced no PAYMENT-SIGNATURE header (got ${Object.keys(paid.headers).join(', ')})`,
    );
  }
  console.log(`\n  buyer signed via signPayment: ${fmt(amount)} on ${paid.paidOn}, no transaction sent`);

  // Step 3: this service settles it, through the same function the route uses.
  const payload = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
  const settled = await settlePayment({
    payload: payload.paymentPayload ?? payload,
    requirements: requirement,
    network: net,
    networks: [net],
  });
  console.log(`  settled via settlePayment (${settled.via}): ${settled.txHash}`);
  const receipt = await pub.waitForTransactionReceipt({ hash: settled.txHash as `0x${string}` });
  if (receipt.status !== 'success') throw new Error(`settlement reverted: ${settled.txHash}`);
  console.log(`    receipt ${receipt.status}, gas ${receipt.gasUsed}`);

  // Step 4: the measurement that matters.
  const settledAt = receipt.blockNumber;
  const after = {
    buyerUsdc: await usdcOf(buyer.address, settledAt),
    buyerNative: await pub.getBalance({ address: buyer.address, blockNumber: settledAt }),
    recipientUsdc: await usdcOf(recipient, settledAt),
    settlerNative: settler
      ? await pub.getBalance({ address: settler.address, blockNumber: settledAt })
      : 0n,
  };
  const recipientGain = after.recipientUsdc - before.recipientUsdc;
  const buyerSpent = before.buyerUsdc - after.buyerUsdc;
  const gasCost = receipt.gasUsed * receipt.effectiveGasPrice;
  // Arc pays gas and receives payment in the same asset. The native balance
  // delta is therefore gas minus payment, not gas alone.
  const nativePayment = settler && net.nativeUsdc ? parseUnits(price, net.nativeDecimals ?? 18) : 0n;
  const settlerSpent = before.settlerNative + nativePayment - after.settlerNative;

  console.log(`\n  after (block ${settledAt}, before was ${blockBefore})`);
  console.log(`    recipient received  ${fmt(recipientGain)}`);
  console.log(`    buyer spent         ${fmt(buyerSpent)}`);
  console.log(
    settler
      ? `    settler spent       ${formatUnits(settlerSpent, net.nativeDecimals ?? 18)} (gas)`
      : `    gas                 paid by ${net.facilitatorUrl}, not by us`,
  );

  const problems: string[] = [];
  if (settler && net.nativeUsdc) {
    if (settlerSpent !== gasCost) problems.push(`recipient native balance does not equal prior balance plus payment minus receipt gas`);
  } else if (recipientGain !== amount) {
    problems.push(`recipient received ${fmt(recipientGain)}, expected ${fmt(amount)}`);
  }
  if (buyerSpent !== amount) {
    problems.push(
      `buyer's balance fell by ${fmt(buyerSpent)}, expected exactly ${fmt(amount)} -- ` +
      `a larger drop means the buyer paid gas, which is what this design exists to avoid`,
    );
  }
  if (settler && settlerSpent <= 0n) {
    problems.push(`settler spent nothing on gas, so it did not submit this`);
  }

  if (problems.length) {
    console.error(`\n  FAILED:\n${problems.map((p) => `    - ${p}`).join('\n')}\n`);
    process.exit(1);
  }
  console.log(`\n  PASS: the buyer paid ${price} USDC on ${net.id} and spent no gas.\n`);
}

main().catch((e) => {
  console.error(`\n  ${(e as Error).message}\n`);
  process.exit(1);
});
