import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer } from './server.js';
import { createLogger } from '../logger.js';

const log = createLogger('MCP');

const server = createMcpServer();
const transport = new StdioServerTransport();
await server.connect(transport);
log.info('zkproofport-prover MCP server started on stdio');
