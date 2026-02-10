import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer } from './server.js';

const server = createMcpServer();
const transport = new StdioServerTransport();
await server.connect(transport);
console.error('zkproofport-prover MCP server started on stdio');
