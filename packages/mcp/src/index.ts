#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { fromPrivateKey, createConfig, CdpWalletSigner, type ProofportSigner } from '@zkproofport-ai/sdk';
import { registerTools } from './tools.js';

// ─── Load config from environment variables ───────────────────────────
const attestationKey = process.env.ATTESTATION_KEY;
if (!attestationKey) {
  console.error('ATTESTATION_KEY is required (private key of wallet with EAS attestation)');
  process.exit(1);
}

const config = createConfig({
  ...(process.env.PROOFPORT_URL && { baseUrl: process.env.PROOFPORT_URL }),
  ...(process.env.EAS_RPC_URL && { easRpcUrl: process.env.EAS_RPC_URL }),
  ...(process.env.EAS_GRAPHQL_URL && { easGraphqlUrl: process.env.EAS_GRAPHQL_URL }),
});

// ─── Attestation signer (always from private key — EAS attestation is tied to this address)
const attestationSigner = fromPrivateKey(attestationKey);
console.error(`[zkproofport-mcp] Attestation wallet: ${attestationSigner.getAddress()}`);

// ─── Payment signer (PAYMENT_KEY > CDP wallet > attestation key fallback)
let paymentSigner: ProofportSigner | undefined;

if (process.env.PAYMENT_KEY) {
  paymentSigner = fromPrivateKey(process.env.PAYMENT_KEY);
  console.error(`[zkproofport-mcp] Payment wallet: ${paymentSigner.getAddress()}`);
} else {
  const cdpApiKeyId = process.env.CDP_API_KEY_ID;
  const cdpApiKeySecret = process.env.CDP_API_KEY_SECRET;
  const cdpWalletSecret = process.env.CDP_WALLET_SECRET;

  if (cdpApiKeyId && cdpApiKeySecret && cdpWalletSecret) {
    paymentSigner = await CdpWalletSigner.create({
      apiKeyId: cdpApiKeyId,
      apiKeySecret: cdpApiKeySecret,
      walletSecret: cdpWalletSecret,
      address: process.env.CDP_WALLET_ADDRESS,
    });
    console.error(`[zkproofport-mcp] Payment wallet (CDP): ${paymentSigner.getAddress()}`);
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
