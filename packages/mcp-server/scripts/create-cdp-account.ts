/**
 * Create a CDP EVM account for payment signing.
 *
 * Usage:
 *   CDP_API_KEY_ID=xxx CDP_API_KEY_SECRET=xxx CDP_WALLET_SECRET=xxx npx tsx scripts/create-cdp-account.ts
 */
import { CdpClient } from '@coinbase/cdp-sdk';

const apiKeyId = process.env.CDP_API_KEY_ID;
const apiKeySecret = process.env.CDP_API_KEY_SECRET;
const walletSecret = process.env.CDP_WALLET_SECRET;

if (!apiKeyId || !apiKeySecret || !walletSecret) {
  console.error('Required: CDP_API_KEY_ID, CDP_API_KEY_SECRET, CDP_WALLET_SECRET');
  process.exit(1);
}

const cdp = new CdpClient({ apiKeyId, apiKeySecret, walletSecret });

const account = await cdp.evm.createAccount();
console.log('Account created!');
console.log(`Address: ${account.address}`);
console.log('');
console.log('Add to .env.test:');
console.log(`CDP_WALLET_ADDRESS=${account.address}`);
