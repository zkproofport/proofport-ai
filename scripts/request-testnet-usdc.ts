#!/usr/bin/env npx tsx
/**
 * Request testnet USDC from CDP faucet on Base Sepolia.
 *
 * Usage:
 *   CDP_API_KEY_ID=... CDP_API_KEY_SECRET=... CDP_WALLET_SECRET=... npx tsx scripts/request-testnet-usdc.ts [address]
 *
 * Requires: npm install @coinbase/cdp-sdk
 */

async function main() {
  const address = process.argv[2] || process.env.CDP_WALLET_ADDRESS;

  if (!process.env.CDP_API_KEY_ID || !process.env.CDP_API_KEY_SECRET || !process.env.CDP_WALLET_SECRET) {
    console.error('Required env vars: CDP_API_KEY_ID, CDP_API_KEY_SECRET, CDP_WALLET_SECRET');
    process.exit(1);
  }

  let CdpClient: any;
  try {
    const mod = await import('@coinbase/cdp-sdk');
    CdpClient = mod.CdpClient;
  } catch {
    console.error('Install @coinbase/cdp-sdk first: npm install @coinbase/cdp-sdk');
    process.exit(1);
  }

  const cdp = new CdpClient({
    apiKeyId: process.env.CDP_API_KEY_ID,
    apiKeySecret: process.env.CDP_API_KEY_SECRET,
    walletSecret: process.env.CDP_WALLET_SECRET,
  });

  if (address) {
    console.log(`Requesting testnet USDC for ${address}...`);
    const result = await cdp.evm.requestFaucet({
      address,
      network: 'base-sepolia',
      token: 'usdc',
    });
    console.log(`TX: ${result.transactionHash}`);
    console.log(`https://sepolia.basescan.org/tx/${result.transactionHash}`);
  } else {
    console.log('No address provided, creating new account...');
    const account = await cdp.evm.createAccount();
    const result = await account.requestFaucet({
      network: 'base-sepolia',
      token: 'usdc',
    });
    console.log(`Address: ${account.address}`);
    console.log(`TX: ${result.transactionHash}`);
    console.log(`https://sepolia.basescan.org/tx/${result.transactionHash}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
