import express from 'express';
import swaggerUi from 'swagger-ui-express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { loadConfig } from './config/index.js';
import { ensureArtifacts } from './circuit/artifactManager.js';
import { createMcpServer } from './mcp/server.js';
import { swaggerSpec } from './swagger.js';
import { createRedisClient } from './redis/client.js';
import { RateLimiter } from './redis/rateLimiter.js';
import { ProofCache } from './redis/proofCache.js';

const config = loadConfig();
const app = express();

// Redis setup
const redis = createRedisClient(config.redisUrl);
const rateLimiter = new RateLimiter(redis, {
  maxRequests: 10,
  windowSeconds: 60,
  keyPrefix: 'rl:prove',
});
const proofCache = new ProofCache(redis, { ttlSeconds: 3600 });

app.use(express.json());

// Swagger UI
app.use('/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));
app.get('/openapi.json', (_req, res) => res.json(swaggerSpec));

app.get('/health', (req, res) => {
  res.json({ status: 'healthy', service: 'proofport-ai' });
});

// MCP StreamableHTTP endpoint (stateless mode)
app.post('/mcp', async (req, res) => {
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  const server = createMcpServer({ rateLimiter, proofCache });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.get('/mcp', async (_req, res) => {
  res.status(405).json({ error: 'SSE not supported in stateless mode. Use POST /mcp instead.' });
});

app.delete('/mcp', async (_req, res) => {
  res.status(405).json({ error: 'Session management not supported in stateless mode.' });
});

// Download circuit artifacts if not present, then start server
ensureArtifacts(config.circuitsDir, config.circuitsRepoUrl).then(() => {
  console.log('Circuit artifacts ready');

  app.listen(config.port, () => {
    console.log(`proofport-ai server listening on port ${config.port}`);
    console.log(`MCP endpoint: http://localhost:${config.port}/mcp`);
    console.log(`Environment: ${config.nodeEnv}`);
    console.log(`Payment mode: ${config.paymentMode}`);
  });
}).catch((error) => {
  console.error('Failed to download circuit artifacts:', error);
  process.exit(1);
});
