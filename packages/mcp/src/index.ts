#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { fromPrivateKey, fromExternalWallet, createConfig, type ProofportSigner } from '@zkproofport-ai/sdk';
import { registerTools } from './tools.js';

// ─── Load config from environment variables ───────────────────────────
const attestationKey = process.env.ATTESTATION_KEY;
const paymentKeyEnv = process.env.PAYMENT_KEY;

if (!attestationKey && !paymentKeyEnv) {
  console.error('At least one key is required:');
  console.error('  ATTESTATION_KEY  — for Coinbase KYC/Country circuits (EAS attested wallet)');
  console.error('  PAYMENT_KEY      — for x402 USDC payment (required for OIDC circuits)');
  console.error('');
  console.error('Coinbase circuits: ATTESTATION_KEY required, PAYMENT_KEY optional');
  console.error('OIDC circuits:     PAYMENT_KEY required, ATTESTATION_KEY not needed');
  process.exit(1);
}

const config = createConfig({
  ...(process.env.PROOFPORT_URL && { baseUrl: process.env.PROOFPORT_URL }),
  ...(process.env.EAS_RPC_URL && { easRpcUrl: process.env.EAS_RPC_URL }),
  ...(process.env.EAS_GRAPHQL_URL && { easGraphqlUrl: process.env.EAS_GRAPHQL_URL }),
});

// ─── Attestation signer (for Coinbase circuits — EAS attestation is tied to this address)
// For OIDC-only usage, PAYMENT_KEY is used as a stand-in (attestation signer is unused)
const primaryKey = attestationKey || paymentKeyEnv!;
const attestationSigner = fromPrivateKey(primaryKey);
if (attestationKey) {
  console.error(`[zkproofport-mcp] Attestation wallet: ${attestationSigner.getAddress()}`);
} else {
  console.error('[zkproofport-mcp] No ATTESTATION_KEY — Coinbase circuits unavailable (OIDC only mode)');
}

// ─── Payment signer (PAYMENT_KEY > CDP wallet > attestation key fallback)
let paymentSigner: ProofportSigner | undefined;

if (paymentKeyEnv) {
  paymentSigner = fromPrivateKey(paymentKeyEnv);
  console.error(`[zkproofport-mcp] Payment wallet: ${paymentSigner.getAddress()}`);
} else {
  const cdpApiKeyId = process.env.CDP_API_KEY_ID;
  const cdpApiKeySecret = process.env.CDP_API_KEY_SECRET;
  const cdpWalletSecret = process.env.CDP_WALLET_SECRET;

  if (cdpApiKeyId && cdpApiKeySecret && cdpWalletSecret) {
    try {
      const { CdpClient } = await import('@coinbase/cdp-sdk');
      const cdp = new CdpClient({
        apiKeyId: cdpApiKeyId,
        apiKeySecret: cdpApiKeySecret,
        walletSecret: cdpWalletSecret,
      });

      const cdpWalletAddress = process.env.CDP_WALLET_ADDRESS;
      const account = cdpWalletAddress
        ? await cdp.evm.getAccount({ address: cdpWalletAddress as `0x${string}` })
        : await cdp.evm.getOrCreateAccount({ name: 'zkproofport-mcp-payment' });

      const accountAddress = account.address!;

      paymentSigner = fromExternalWallet({
        getAddress: () => accountAddress,
        signMessage: async (msg) => {
          const message = msg instanceof Uint8Array ? Buffer.from(msg).toString() : msg;
          const result = await cdp.evm.signMessage({ address: accountAddress as `0x${string}`, message });
          return result.signature;
        },
        signTypedData: async (domain, types, message) => {
          const result = await cdp.evm.signTypedData({
            address: accountAddress as `0x${string}`,
            domain: domain as Record<string, unknown>,
            types: types as Record<string, Array<{ name: string; type: string }>>,
            primaryType: Object.keys(types).find(k => k !== 'EIP712Domain') || '',
            message: message as Record<string, unknown>,
          });
          return result.signature;
        },
        sendTransaction: async (tx) => {
          const result = await cdp.evm.sendTransaction({
            address: accountAddress as `0x${string}`,
            transaction: {
              to: tx.to as `0x${string}`,
              data: tx.data as `0x${string}`,
              value: tx.value ?? BigInt(0),
            },
            network: 'base-sepolia',
          });
          return { hash: result.transactionHash, wait: async () => ({ status: 1 }) };
        },
      });
      console.error(`[zkproofport-mcp] CDP payment wallet: ${accountAddress}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('Cannot find package') || msg.includes('MODULE_NOT_FOUND')) {
        console.error('[zkproofport-mcp] CDP credentials set but @coinbase/cdp-sdk not installed.');
        console.error('[zkproofport-mcp] Install it: npm install @coinbase/cdp-sdk');
      } else {
        console.error(`[zkproofport-mcp] CDP wallet init failed: ${msg}`);
      }
      console.error('[zkproofport-mcp] Falling back to attestation wallet for payment');
    }
  } else {
    console.error('[zkproofport-mcp] No payment wallet configured — using attestation wallet for payment');
  }
}

// ─── Create MCP server ────────────────────────────────────────────────
const server = new McpServer({
  name: 'zkproofport-mcp',
  version: '0.1.0',
});

registerTools(server, config, attestationSigner, paymentSigner);

// ─── Connect via stdio ────────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);
console.error('zkproofport-mcp server started on stdio');
