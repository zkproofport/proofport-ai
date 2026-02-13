import express from 'express';
import http from 'node:http';
import swaggerUi from 'swagger-ui-express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Config } from './config/index.js';
import { loadConfig } from './config/index.js';
import { ensureArtifacts } from './circuit/artifactManager.js';
import { createMcpServer } from './mcp/server.js';
import { swaggerSpec } from './swagger.js';
import { createRedisClient } from './redis/client.js';
import { RateLimiter } from './redis/rateLimiter.js';
import { ProofCache } from './redis/proofCache.js';
import { getAgentCardHandler, getMcpDiscoveryHandler, getOasfAgentHandler } from './a2a/agentCard.js';
import { createA2aHandler } from './a2a/taskHandler.js';
import { TaskStore } from './a2a/taskStore.js';
import { TaskEventEmitter, createStreamHandler } from './a2a/streaming.js';
import { createPaymentMiddleware } from './payment/x402Middleware.js';
import { PaymentFacilitator } from './payment/facilitator.js';
import { SettlementWorker } from './payment/settlementWorker.js';
import { validatePaymentConfig, getPaymentModeConfig } from './payment/freeTier.js';
import { createSigningCallbackHandler } from './signing/webSigning.js';
import { createBatchSigningHandler } from './signing/eip7702Signing.js';
import { getTeeConfig, createTeeProvider, resolveTeeMode } from './tee/index.js';
import { TaskWorker } from './a2a/taskWorker.js';
import { ensureAgentRegistered } from './identity/autoRegister.js';
import { computeSignalHash } from './input/inputBuilder.js';
import { ethers } from 'ethers';
import type { SigningRequestRecord } from './signing/types.js';

/**
 * Create a reverse proxy middleware to forward requests to the internal Next.js sign-page.
 * The sign-page runs on port 3200 inside the same container.
 */
function createSignPageProxy() {
  const target = 'http://127.0.0.1:3200';
  return (req: any, res: any) => {
    const proxyReq = http.request(
      `${target}${req.originalUrl}`,
      { method: req.method, headers: req.headers },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
        proxyRes.pipe(res);
      }
    );
    proxyReq.on('error', () => {
      if (!res.headersSent) {
        res.status(502).json({ error: 'Sign page not available' });
      }
    });
    req.pipe(proxyReq);
  };
}

function createApp(config: Config, agentTokenId?: bigint | null) {
  // Validate payment config at startup
  validatePaymentConfig(config);

  const app = express();

  // Redis setup
  const redis = createRedisClient(config.redisUrl);
  const rateLimiter = new RateLimiter(redis, {
    maxRequests: 10,
    windowSeconds: 60,
    keyPrefix: 'rl:prove',
  });
  const proofCache = new ProofCache(redis, { ttlSeconds: 3600 });

  // A2A setup
  const taskStore = new TaskStore(redis, 86400);
  const taskEventEmitter = new TaskEventEmitter();

  // Payment setup
  const paymentFacilitator = new PaymentFacilitator(redis, { ttlSeconds: 86400 });
  const paymentMiddleware = createPaymentMiddleware(config);
  const paymentModeConfig = getPaymentModeConfig(config.paymentMode);

  // TEE setup
  const teeConfig = getTeeConfig();
  const resolvedMode = resolveTeeMode(teeConfig.mode);
  console.log(`[TEE] Mode: ${teeConfig.mode} → resolved to: ${resolvedMode}`);
  const teeProvider = createTeeProvider({ ...teeConfig, mode: resolvedMode });

  // Task worker setup
  const taskWorker = new TaskWorker({ taskStore, taskEventEmitter, config, teeProvider });

  // Settlement worker setup (only if payment mode is not disabled)
  let settlementWorker: SettlementWorker | null = null;
  if (paymentModeConfig.mode !== 'disabled') {
    // Only create if settlement config is provided
    if (
      config.settlementChainRpcUrl &&
      config.settlementPrivateKey &&
      config.settlementOperatorAddress &&
      config.settlementUsdcAddress
    ) {
      settlementWorker = new SettlementWorker(paymentFacilitator, {
        chainRpcUrl: config.settlementChainRpcUrl,
        privateKey: config.settlementPrivateKey,
        operatorAddress: config.settlementOperatorAddress,
        usdcContractAddress: config.settlementUsdcAddress,
        pollIntervalMs: 30000,
      });
    }
  }

  app.use(express.json());

  // Swagger UI
  app.use('/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));
  app.get('/openapi.json', (_req, res) => res.json(swaggerSpec));

  app.get('/health', (_req, res) => {
    res.json({
      status: 'healthy',
      service: 'proofport-ai',
      paymentMode: paymentModeConfig.mode,
      paymentRequired: paymentModeConfig.requiresPayment,
      tee: {
        mode: resolvedMode,
        attestationEnabled: teeConfig.attestationEnabled,
      },
    });
  });

  // Payment status endpoint
  app.get('/payment/status', (_req, res) => {
    res.json({
      mode: paymentModeConfig.mode,
      network: paymentModeConfig.network,
      requiresPayment: paymentModeConfig.requiresPayment,
      description: paymentModeConfig.description,
    });
  });

  // Signing status endpoint
  app.get('/signing/status', (_req, res) => {
    res.json({
      providers: {
        privy: { enabled: !!config.privyAppId && !!config.privyApiSecret },
        web: { enabled: !!config.signPageUrl, signPageUrl: config.signPageUrl || null },
        eip7702: { enabled: true },
      },
    });
  });

  // TEE status endpoint
  app.get('/tee/status', (_req, res) => {
    res.json({
      mode: teeConfig.mode,
      attestationEnabled: teeConfig.attestationEnabled,
      available: teeConfig.mode !== 'disabled',
    });
  });

  // Identity status endpoint
  app.get('/identity/status', (_req, res) => {
    res.json({
      erc8004: {
        identityContract: config.erc8004IdentityAddress || null,
        reputationContract: config.erc8004ReputationAddress || null,
        configured: !!config.erc8004IdentityAddress && !!config.erc8004ReputationAddress,
      },
    });
  });

  // Discovery endpoints for 8004scan
  app.get('/.well-known/agent.json', getOasfAgentHandler(config, agentTokenId));
  app.get('/.well-known/agent-card.json', getAgentCardHandler(config, agentTokenId));
  app.get('/.well-known/mcp.json', getMcpDiscoveryHandler(config));
  app.get('/a2a/stream/:taskId', createStreamHandler(taskEventEmitter));

  // Payment-gated routes
  app.post('/a2a', paymentMiddleware, createA2aHandler({ taskStore }));

  // CORS for signing routes (sign-page on port 3200 → AI server on port 4002)
  app.use('/api/signing', (req, res, next) => {
    const origin = req.headers.origin;
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    }
    if (req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }
    next();
  });

  // Signing request details (sign-page fetches request info from here)
  app.get('/api/signing/:requestId', async (req, res) => {
    const { requestId } = req.params;
    const key = `signing:${requestId}`;
    const data = await redis.get(key);

    if (!data) {
      res.status(404).json({ error: 'Request not found or expired' });
      return;
    }

    const record: SigningRequestRecord = JSON.parse(data);

    res.json({
      address: record.address || null,
      signalHash: record.signalHash || null,
      scope: record.scope,
      circuitId: record.circuitId,
      status: record.status,
      expiresAt: record.expiresAt,
    });
  });

  // Prepare signing request — sign-page calls this after user connects wallet
  // Computes signalHash from the connected address + stored scope/circuitId
  app.post('/api/signing/:requestId/prepare', async (req, res) => {
    const { requestId } = req.params;
    const { address } = req.body;

    if (!address) {
      res.status(400).json({ error: 'Missing address' });
      return;
    }

    const key = `signing:${requestId}`;
    const data = await redis.get(key);

    if (!data) {
      res.status(404).json({ error: 'Request not found or expired' });
      return;
    }

    const record: SigningRequestRecord = JSON.parse(data);

    if (record.status !== 'pending') {
      res.status(400).json({ error: `Request is already ${record.status}` });
      return;
    }

    // Compute signalHash from connected wallet address
    const signalHash = computeSignalHash(address, record.scope, record.circuitId);
    const signalHashHex = ethers.hexlify(signalHash);

    // Update record with address + signalHash
    const updatedRecord: SigningRequestRecord = {
      ...record,
      address,
      signalHash: signalHashHex,
    };

    const ttl = await redis.ttl(key);
    await redis.set(key, JSON.stringify(updatedRecord), 'EX', ttl > 0 ? ttl : 300);

    res.json({ signalHash: signalHashHex });
  });

  // Signing callback routes (no payment gate — these receive signatures from users)
  app.post('/api/signing/callback/:requestId', createSigningCallbackHandler(redis));
  app.post('/api/signing/batch', createBatchSigningHandler(redis));

  // MCP StreamableHTTP endpoint (stateless mode, payment-gated)
  app.post('/mcp', paymentMiddleware, async (req, res) => {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const server = createMcpServer({ rateLimiter, proofCache, redis, teeProvider });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  app.get('/mcp', async (_req, res) => {
    res.status(405).json({ error: 'SSE not supported in stateless mode. Use POST /mcp instead.' });
  });

  app.delete('/mcp', async (_req, res) => {
    res.status(405).json({ error: 'Session management not supported in stateless mode.' });
  });

  // Proxy sign-page requests to internal Next.js server
  app.use('/s', createSignPageProxy());
  app.use('/_next', createSignPageProxy());

  return { app, paymentFacilitator, teeProvider, taskWorker, settlementWorker };
}

async function startServer() {
  const config = loadConfig();
  const paymentModeConfig = getPaymentModeConfig(config.paymentMode);

  try {
    // Download circuit artifacts if not present
    await ensureArtifacts(config.circuitsDir, config.circuitsRepoUrl);
    console.log('Circuit artifacts ready');

    // Create TEE provider early (needed for both registration and app)
    const teeConfig = getTeeConfig();
    const resolvedTeeMode = resolveTeeMode(teeConfig.mode);
    const earlyTeeProvider = createTeeProvider({ ...teeConfig, mode: resolvedTeeMode });

    // Register agent on ERC-8004 (if configured) + submit TEE validation
    const agentTokenId = await ensureAgentRegistered(config, earlyTeeProvider);

    // Create app with tokenId
    const { app, paymentFacilitator, teeProvider, taskWorker, settlementWorker } = createApp(
      config,
      agentTokenId
    );

    app.listen(config.port, () => {
      console.log(`proofport-ai server listening on port ${config.port}`);
      console.log(`MCP endpoint: http://localhost:${config.port}/mcp`);
      console.log(`Environment: ${config.nodeEnv}`);
      console.log(`Payment mode: ${paymentModeConfig.mode} (${paymentModeConfig.description})`);
      if (paymentModeConfig.requiresPayment) {
        console.log(`Payment network: ${paymentModeConfig.network}`);
      }

      taskWorker.start();
      console.log('TaskWorker started');

      if (settlementWorker) {
        settlementWorker.start();
        console.log('SettlementWorker started');
      } else if (paymentModeConfig.mode !== 'disabled') {
        console.warn('SettlementWorker not configured (missing settlement env vars)');
      }
    });
  } catch (error) {
    console.error('Failed to start server:', error);
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
