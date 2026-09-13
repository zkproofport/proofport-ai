#!/usr/bin/env node

import { randomBytes } from 'crypto';
import {readFileSync} from 'node:fs';
const packageVersion=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8')).version as string;
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { fromPrivateKey, createConfig } from '@zkproofport-ai/sdk';
import { registerTools } from './tools.js';

// ─── Load config from environment variables ───────────────────────────
const attestationKey = process.env.ATTESTATION_KEY;

const config = createConfig({
  ...(process.env.PROOFPORT_URL && { baseUrl: process.env.PROOFPORT_URL }),
});

// ─── Attestation signer (for Coinbase circuits — EAS attestation is tied to this address)
// For OIDC/login flows, ATTESTATION_KEY is not needed — an ephemeral key is used
let attestationSigner;
if (attestationKey) {
  attestationSigner = fromPrivateKey(attestationKey);
  console.error('[zkproofport-mcp] Private credential signer: ****');
} else {
  attestationSigner = fromPrivateKey('0x' + randomBytes(32).toString('hex'));
  console.error('[zkproofport-mcp] No ATTESTATION_KEY — using ephemeral key (login/OIDC mode)');
}

// ─── Create MCP server ────────────────────────────────────────────────
const server = new McpServer({
  name: 'zkproofport-mcp',
  version: packageVersion,
});

registerTools(server, config, attestationSigner);

// ─── Connect via stdio ────────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);
console.error('zkproofport-mcp server started on stdio');
