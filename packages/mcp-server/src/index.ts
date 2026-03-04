#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { fromPrivateKey, type ClientConfig, type ProofportSigner } from '@proofport/client';
import { registerTools } from './tools.js';
import { CdpWalletSigner } from './cdp.js';

// ─── Load config from environment variables ───────────────────────────
const attestationKey = process.env.ATTESTATION_KEY;
if (!attestationKey) {
  console.error('ATTESTATION_KEY is required (private key of wallet with EAS attestation)');
  process.exit(1);
}

const config: ClientConfig = {
  baseUrl: process.env.PROOFPORT_URL || 'https://stg-ai.zkproofport.app',
  easRpcUrl: process.env.EAS_RPC_URL,
  paymentRpcUrl: process.env.PAYMENT_RPC_URL,
  easGraphqlUrl: process.env.EAS_GRAPHQL_URL,
};

// ─── Attestation signer (always from private key — EAS attestation is tied to this address)
const attestationSigner = fromPrivateKey(attestationKey);
console.error(`[proofport-mcp] Attestation wallet: ${attestationSigner.getAddress()}`);

// ─── Payment signer (CDP wallet if credentials provided, otherwise attestation key)
let paymentSigner: ProofportSigner | undefined;

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
  console.error(`[proofport-mcp] Payment wallet (CDP): ${paymentSigner.getAddress()}`);
} else {
  console.error('[proofport-mcp] No CDP credentials — using attestation wallet for payment');
}

// ─── Create MCP server ────────────────────────────────────────────────
const server = new McpServer({
  name: 'proofport-mcp',
  version: '0.1.0',
});

registerTools(server, config, attestationSigner, paymentSigner);

// ─── Connect via stdio ────────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);
console.error('proofport-mcp server started on stdio');
