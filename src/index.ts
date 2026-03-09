import './tracing.js';
import express from 'express';
import { createLogger } from './logger.js';

const log = createLogger('Server');
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { version } = require('../package.json');
import swaggerUi from 'swagger-ui-express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Config } from './config/index.js';
import { loadConfig } from './config/index.js';
import { ensureArtifacts } from './circuit/artifactManager.js';
import { createMcpServer } from './mcp/server.js';
import { buildSwaggerSpec } from './swagger.js';
import { createRedisClient } from './redis/client.js';
import { RateLimiter } from './redis/rateLimiter.js';
import { ProofCache } from './redis/proofCache.js';
import { PROOF_CACHE_TTL } from './redis/constants.js';
import { CleanupWorker } from './redis/cleanupWorker.js';
import { getAgentCardHandler, getMcpDiscoveryHandler, getOasfAgentHandler, getSkillMdHandler } from './a2a/agentCard.js';
import { DefaultRequestHandler } from '@a2a-js/sdk/server';
import { jsonRpcHandler, UserBuilder } from '@a2a-js/sdk/server/express';
import { buildAgentCard } from './a2a/agentCard.js';
import { RedisTaskStore } from './a2a/redisTaskStore.js';
import { ProofportExecutor } from './a2a/proofportExecutor.js';
import { validatePaymentConfig, getPaymentModeConfig } from './payment/freeTier.js';
import { getTeeConfig, createTeeProvider, resolveTeeMode } from './tee/index.js';
import { ensureAgentRegistered } from './identity/autoRegister.js';
import { createAgentAuthMiddleware } from './identity/agentAuth.js';
import { createProofRoutes } from './proof/proofRoutes.js';
import type { LLMProvider } from './chat/llmProvider.js';
import { OpenAIProvider } from './chat/openaiClient.js';
import { GeminiProvider } from './chat/geminiClient.js';
import { MultiLLMProvider } from './chat/multiProvider.js';
import { syncDeployments } from './config/deployments.js';
import { startAcpSeller } from './virtuals/acpSeller.js';

function createApp(config: Config, agentTokenId?: bigint | null) {
  // Validate payment config at startup
  validatePaymentConfig(config);

  const app = express();

  // Build swagger spec with dynamic base URL
  const swaggerSpec = buildSwaggerSpec(config.a2aBaseUrl);

  // Redis setup
  const redis = createRedisClient(config.redisUrl);
  const rateLimiter = new RateLimiter(redis, {
    maxRequests: 10,
    windowSeconds: 60,
    keyPrefix: 'rl:prove',
  });
  const proofCache = new ProofCache(redis, { ttlSeconds: PROOF_CACHE_TTL });

  // A2A setup
  const taskStore = new RedisTaskStore(redis, 86400);

  // Cleanup worker setup
  const cleanupWorker = new CleanupWorker(redis);

  const paymentModeConfig = getPaymentModeConfig(config.paymentMode);

  // TEE setup
  const teeConfig = getTeeConfig();
  const resolvedMode = resolveTeeMode(teeConfig.mode);
  log.info({ action: 'server.tee.resolved', teeMode: teeConfig.mode, resolvedMode }, 'TEE mode resolved');
  const teeProvider = createTeeProvider({ ...teeConfig, mode: resolvedMode });

  // Static files (icon.png for 8004scan agent image)
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  app.use(express.json());

  // ERC-8128: Optional agent identity verification
  app.use(createAgentAuthMiddleware(config));

  // Swagger UI
  app.use('/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));
  app.get('/openapi.json', (_req, res) => res.json(swaggerSpec));

  app.get('/health', (_req, res) => {
    res.json({
      status: 'healthy',
      version,
      service: 'proofport-ai',
      paymentMode: paymentModeConfig.mode,
      paymentRequired: paymentModeConfig.requiresPayment,
      tee: {
        mode: resolvedMode,
        attestationEnabled: teeConfig.attestationEnabled,
      },
    });
  });

  // CORS: public read-only endpoints allow any origin (discovery, health, MCP info)
  function publicCorsMiddleware(req: express.Request, res: express.Response, next: express.NextFunction) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
    if (req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }
    next();
  }

  app.use('/.well-known', publicCorsMiddleware);
  app.use('/a2a', publicCorsMiddleware);
  app.use('/mcp', publicCorsMiddleware);

  // Discovery endpoints (agent.json = OASF identity, agent-card.json = A2A v0.3)
  app.get('/.well-known/agent.json', getOasfAgentHandler(config, agentTokenId));
  app.get('/.well-known/agent-card.json', getAgentCardHandler(config, agentTokenId));
  app.get('/.well-known/oasf.json', getOasfAgentHandler(config, agentTokenId));
  app.get('/.well-known/mcp.json', getMcpDiscoveryHandler(config));
  app.get('/.well-known/SKILL.md', getSkillMdHandler(config));

  // LLM providers (created early — needed by both A2A text inference and chat endpoint)
  const llmProviders: LLMProvider[] = [];
  if (config.openaiApiKey) {
    llmProviders.push(new OpenAIProvider({ apiKey: config.openaiApiKey }));
  }
  if (config.geminiApiKey) {
    llmProviders.push(new GeminiProvider({ apiKey: config.geminiApiKey }));
  }
  const llmProvider = llmProviders.length > 0 ? new MultiLLMProvider(llmProviders) : undefined;

  // A2A SDK setup
  const executor = new ProofportExecutor({ taskStore, config, teeProvider, llmProvider });
  const agentCard = buildAgentCard(config, agentTokenId);
  const requestHandler = new DefaultRequestHandler(agentCard, taskStore, executor);

  // Single POST /a2a handles all A2A v0.3 JSON-RPC methods
  // Payment is handled inside skillHandler via request_payment flow (no HTTP-level x402 gate)
  app.use('/a2a', jsonRpcHandler({ requestHandler, userBuilder: UserBuilder.noAuthentication }));

  // REST API routes — payment is handled inside skillHandler via request_payment flow
  app.use('/api/v1', createProofRoutes({ redis, config, teeProvider }));

  // MCP StreamableHTTP endpoint (stateless mode)
  // Payment is handled inside skillHandler via request_payment flow (no HTTP-level x402 gate)
  // MCP StreamableHTTP requires Accept to include both application/json and text/event-stream.
  // Swagger UI and simple curl clients often send only one — fix it here so they don't get 406.
  // Must patch both Express headers AND raw HTTP headers (Node.js IncomingMessage.rawHeaders)
  // because the MCP SDK converts to Web Standard Request using raw headers.
  app.post('/mcp', (req, _res, next) => {
    const accept = req.headers['accept'] || '';
    if (!accept.includes('text/event-stream') || !accept.includes('application/json')) {
      const fixed = 'application/json, text/event-stream';
      req.headers['accept'] = fixed;
      // Patch rawHeaders array (used by @hono/node-server getRequestListener)
      const idx = req.rawHeaders.findIndex(h => h.toLowerCase() === 'accept');
      if (idx !== -1) {
        req.rawHeaders[idx + 1] = fixed;
      } else {
        req.rawHeaders.push('Accept', fixed);
      }
    }
    next();
  }, async (req, res) => {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const server = createMcpServer({ rateLimiter, proofCache, redis, teeProvider }, config);
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  app.get('/mcp', async (_req, res) => {
    res.json({
      name: 'proofport-ai',
      version: '2025-11-25',
      protocol: 'MCP StreamableHTTP',
      description: 'ZK proof generation MCP server (stateless mode — use POST for JSON-RPC)',
      tools: ['prove', 'get_supported_circuits', 'get_guide'],
    });
  });

  app.delete('/mcp', async (_req, res) => {
    res.status(405).json({ error: 'Session management not supported in stateless mode.' });
  });

  return { app, teeProvider, cleanupWorker };
}

async function startServer() {
  const config = loadConfig();
  const paymentModeConfig = getPaymentModeConfig(config.paymentMode);

  try {
    // Download circuit artifacts if not present
    await ensureArtifacts(config.circuitsDir, config.circuitsRepoUrl);
    log.info({ action: 'server.artifacts.ready' }, 'Circuit artifacts ready');

    // Sync verifier addresses from GitHub broadcast JSON
    try {
      const deploymentsUpdated = await syncDeployments(config.paymentMode);
      log.info({ action: 'server.deployments.synced', updated: deploymentsUpdated }, 'Deployment addresses synced');
    } catch (err) {
      log.warn({ action: 'server.deployments.failed', err }, 'Deployment sync failed, using fallback addresses');
    }

    // Create TEE provider early (needed for both registration and app)
    const teeConfig = getTeeConfig();
    const resolvedTeeMode = resolveTeeMode(teeConfig.mode);
    const earlyTeeProvider = createTeeProvider({ ...teeConfig, mode: resolvedTeeMode });

    // Register agent on ERC-8004 (if configured) + submit TEE validation
    const agentTokenId = await ensureAgentRegistered(config, earlyTeeProvider);

    // Create app with tokenId
    const { app, teeProvider, cleanupWorker } = createApp(config, agentTokenId);

    app.listen(config.port, () => {
      log.info({ action: 'server.started', port: config.port }, 'proofport-ai server listening');
      log.info({ action: 'server.mcp.ready', mcpEndpoint: `http://localhost:${config.port}/mcp` }, 'MCP endpoint ready');
      log.info({ action: 'server.config', nodeEnv: config.nodeEnv, paymentMode: paymentModeConfig.mode, paymentDescription: paymentModeConfig.description }, 'Server configuration');
      if (paymentModeConfig.requiresPayment) {
        log.info({ action: 'server.payment.network', network: paymentModeConfig.network }, 'Payment network');
      }

      cleanupWorker.start();
      log.info({ action: 'server.cleanup.started' }, 'CleanupWorker started');

      // Start Virtuals ACP Seller (non-blocking, optional)
      startAcpSeller(config).catch(err => {
        log.warn({ action: 'server.virtuals.failed', err }, 'Virtuals ACP Seller failed to start (non-fatal)');
      });
    });
  } catch (error) {
    log.error({ action: 'server.start.failed', err: error }, 'Failed to start server');
    process.exit(1);
  }
}

// Export for testing
export { createApp, startServer };
export type { Config };

// Only start server when run directly (not imported by tests)
const isMainModule = process.argv[1]?.endsWith('index.js') || process.argv[1]?.endsWith('index.ts');
if (isMainModule) {
  startServer();
}
