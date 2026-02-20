import './tracing.js';
import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
import { CleanupWorker } from './redis/cleanupWorker.js';
import { getAgentCardHandler, getMcpDiscoveryHandler, getOasfAgentHandler } from './a2a/agentCard.js';
import { createA2aHandler } from './a2a/taskHandler.js';
import { TaskStore } from './a2a/taskStore.js';
import { TaskEventEmitter } from './a2a/streaming.js';
import { PAYMENT_NETWORKS } from './payment/x402Middleware.js';
import { HTTPFacilitatorClient } from '@x402/core/server';
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
import { createRestRoutes } from './api/restRoutes.js';
import { createOpenAIRoutes } from './chat/openaiHandler.js';
import type { LLMProvider } from './chat/llmProvider.js';
import { OpenAIProvider } from './chat/openaiClient.js';
import { GeminiProvider } from './chat/geminiClient.js';
import { MultiLLMProvider } from './chat/multiProvider.js';

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

  // Build swagger spec with dynamic base URL
  const swaggerSpec = buildSwaggerSpec(config.a2aBaseUrl);

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

  // Cleanup worker setup
  const cleanupWorker = new CleanupWorker(redis);

  // Payment setup
  const paymentFacilitator = new PaymentFacilitator(redis, { ttlSeconds: 86400 });
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

  // Static files (icon.png for 8004scan agent image)
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  app.use(express.static(path.join(__dirname, '..', 'public')));

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
        web: { enabled: !!config.signPageUrl },
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

  // CORS for A2A client UIs (e.g., a2a-ui on port 3000)
  const a2aCorsOrigins = process.env.A2A_CORS_ORIGINS
    ? process.env.A2A_CORS_ORIGINS.split(',').map(s => s.trim())
    : [];

  function a2aCorsMiddleware(req: express.Request, res: express.Response, next: express.NextFunction) {
    const origin = req.headers.origin;
    if (origin && a2aCorsOrigins.length > 0 && a2aCorsOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
    }
    if (req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }
    next();
  }

  app.use('/.well-known', a2aCorsMiddleware);
  app.use('/a2a', a2aCorsMiddleware);

  // Discovery endpoints (A2A standard: agent.json = A2A v0.3 agent card)
  app.get('/.well-known/agent.json', getAgentCardHandler(config, agentTokenId));
  app.get('/.well-known/agent-card.json', getAgentCardHandler(config, agentTokenId));
  app.get('/.well-known/oasf.json', getOasfAgentHandler(config, agentTokenId));
  app.get('/.well-known/mcp.json', getMcpDiscoveryHandler(config));

  // LLM providers (created early — needed by both A2A text inference and chat endpoint)
  const llmProviders: LLMProvider[] = [];
  if (config.openaiApiKey) {
    llmProviders.push(new OpenAIProvider({ apiKey: config.openaiApiKey }));
  }
  if (config.geminiApiKey) {
    llmProviders.push(new GeminiProvider({ apiKey: config.geminiApiKey }));
  }
  const llmProvider = llmProviders.length > 0 ? new MultiLLMProvider(llmProviders) : undefined;

  // Single POST /a2a handles all A2A v0.3 JSON-RPC methods
  // Payment is handled inside skillHandler via request_payment flow (no HTTP-level x402 gate)
  app.post('/a2a', createA2aHandler({ taskStore, taskEventEmitter, llmProvider }));

  // REST API routes — payment is handled inside skillHandler via request_payment flow
  app.use('/api/v1', createRestRoutes({ taskStore, taskEventEmitter, redis, config, rateLimiter, proofCache, teeProvider }));

  // CORS for signing routes (sign-page on port 3200 → AI server on port 4002)
  app.use('/api/signing', (req, res, next) => {
    const origin = req.headers.origin;
    const allowedOrigins = [
      'http://127.0.0.1:3200',
      'http://localhost:3200',
      config.signPageUrl,
    ].filter(Boolean);
    if (origin && allowedOrigins.includes(origin)) {
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

  // CORS for payment routes (sign-page on port 3200 → AI server on port 4002)
  app.use('/api/payment', (req, res, next) => {
    const origin = req.headers.origin;
    const allowedOrigins = [
      'http://127.0.0.1:3200',
      'http://localhost:3200',
      config.signPageUrl,
    ].filter(Boolean);
    if (origin && allowedOrigins.includes(origin)) {
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

  // Chat endpoint (LLM-based natural language interface)
  // Payment is handled inside skillHandler via request_payment flow (no HTTP-level x402 gate)
  if (llmProvider) {
    const chatDeps = {
      redis, taskStore, taskEventEmitter, a2aBaseUrl: config.a2aBaseUrl, llmProvider,
      signPageUrl: config.signPageUrl,
      signingTtlSeconds: config.signingTtlSeconds,
      paymentMode: config.paymentMode,
      paymentProofPrice: config.paymentProofPrice,
      easGraphqlEndpoint: config.easGraphqlEndpoint,
      rpcUrls: [config.baseRpcUrl],
      bbPath: config.bbPath,
      nargoPath: config.nargoPath,
      circuitsDir: config.circuitsDir,
      chainRpcUrl: config.chainRpcUrl,
      rateLimiter,
      proofCache,
      teeProvider,
      teeMode: resolvedMode,
    };

    app.use('/v1', createOpenAIRoutes(chatDeps));
    console.log(`[Chat] LLM chat endpoint enabled (providers: ${llmProviders.map(p => p.name).join(' -> ')})`);
    console.log('[OpenAI] Compatible endpoint enabled at /v1/chat/completions');
  } else {
    app.post('/v1/chat/completions', (_req, res) => {
      res.status(503).json({ error: { message: 'Chat not configured. Set OPENAI_API_KEY or GEMINI_API_KEY.', type: 'server_error', code: 'not_configured' } });
    });
  }

  // Deprecated endpoint — redirect clients to the unified OpenAI-compatible endpoint
  app.post('/api/v1/chat', (_req, res) => {
    res.status(410).json({
      error: {
        message: 'This endpoint has been removed. Use POST /v1/chat/completions (OpenAI-compatible format) instead.',
        type: 'gone',
        code: 'endpoint_removed',
      },
    });
  });

  // Verification page for QR code scanning
  app.get('/v/:proofId', (req, res) => {
    const { proofId } = req.params;
    const apiUrl = `${config.a2aBaseUrl}/api/v1/verify/${proofId}`;
    res.setHeader('Content-Type', 'text/html');
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>proveragent.eth — Proof Verification</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0a0a0a;color:#f0f0f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:1rem}
.card{background:#1a1a1a;border:1px solid #333;border-radius:12px;padding:2rem;max-width:480px;width:100%}
h1{font-size:1.25rem;font-weight:600;margin-bottom:.5rem;text-align:center}
.subtitle{color:#999;font-size:.875rem;text-align:center;margin-bottom:1.5rem}
.status{padding:1rem;border-radius:8px;margin-bottom:1rem;font-size:.875rem}
.loading{background:#1a2a3a;border:1px solid #2a4a5a;color:#93c5fd}
.valid{background:#1a3a2a;border:1px solid #2a5a3a;color:#4ade80}
.invalid{background:#3a1a1a;border:1px solid #5a2a2a;color:#f87171}
.error{background:#3a1a1a;border:1px solid #5a2a2a;color:#f87171}
.field{margin-bottom:.75rem}
.label{color:#999;font-size:.75rem;text-transform:uppercase;letter-spacing:.05em;margin-bottom:.25rem}
.value{font-family:'Courier New',monospace;font-size:.8rem;color:#93c5fd;word-break:break-all}
.badge{display:inline-block;padding:.25rem .75rem;border-radius:20px;font-weight:600;font-size:1rem}
.badge-valid{background:#166534;color:#4ade80}
.badge-invalid{background:#7f1d1d;color:#f87171}
.privacy{text-align:center;color:#4ade80;font-size:.875rem;margin-top:1rem}
</style>
</head>
<body>
<div class="card">
<h1>proveragent.eth</h1>
<p class="subtitle">On-chain ZK Proof Verification</p>
<div id="result"><div class="status loading">Verifying proof on-chain...</div></div>
</div>
<script>
(async()=>{
const el=document.getElementById('result');
try{
const r=await fetch('${apiUrl}');
const d=await r.json();
if(!r.ok){el.innerHTML='<div class="status error">'+d.error+'</div>';return}
el.innerHTML=
'<div class="status '+(d.isValid?'valid':'invalid')+'">'+
'<span class="badge '+(d.isValid?'badge-valid':'badge-invalid')+'">'+(d.isValid?'\\u2713 VALID':'\\u2717 INVALID')+'</span>'+
'</div>'+
'<div class="field"><div class="label">Circuit</div><div class="value">'+d.circuitId+'</div></div>'+
'<div class="field"><div class="label">Nullifier</div><div class="value">'+d.nullifier+'</div></div>'+
'<div class="field"><div class="label">Verifier Contract</div><div class="value">'+d.verifierAddress+'</div></div>'+
'<div class="field"><div class="label">Chain</div><div class="value">Base Sepolia ('+d.chainId+')</div></div>'+
'<div class="privacy">0 bytes of personal data exposed</div>';
}catch(e){el.innerHTML='<div class="status error">Failed to verify: '+e.message+'</div>'}
})();
</script>
</body>
</html>`);
  });

  // Payment info endpoint (payment page fetches details)
  app.get('/api/payment/:requestId', async (req, res) => {
    const { requestId } = req.params;
    const key = `signing:${requestId}`;
    const data = await redis.get(key);

    if (!data) {
      res.status(404).json({ error: 'Request not found or expired' });
      return;
    }

    const record: SigningRequestRecord = JSON.parse(data);
    const isTestnet = config.paymentMode === 'testnet';
    const chainId = isTestnet ? 84532 : 8453;
    const usdcAddress = isTestnet
      ? '0x036CbD53842c5426634e7929541eC2318f3dCF7e'
      : '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
    const priceStr = (config.paymentProofPrice || '$0.10').replace('$', '');
    const amount = String(Math.round(parseFloat(priceStr) * 1_000_000));

    res.json({
      requestId,
      circuitId: record.circuitId,
      scope: record.scope,
      paymentStatus: record.paymentStatus || null,
      paymentTxHash: record.paymentTxHash || null,
      payTo: config.paymentPayTo,
      amount,
      priceDisplay: config.paymentProofPrice || '$0.10',
      usdcAddress,
      chainId,
      chainName: isTestnet ? 'Base Sepolia' : 'Base',
      usdcName: 'USDC',
      usdcVersion: '2',
    });
  });

  // Payment confirmation (called by payment page after tx)
  app.post('/api/payment/confirm/:requestId', async (req, res) => {
    const { requestId } = req.params;
    const { txHash } = req.body;

    if (!txHash || typeof txHash !== 'string') {
      res.status(400).json({ error: 'Missing txHash' });
      return;
    }

    const key = `signing:${requestId}`;
    const data = await redis.get(key);

    if (!data) {
      res.status(404).json({ error: 'Request not found or expired' });
      return;
    }

    const record: SigningRequestRecord = JSON.parse(data);

    if (record.paymentStatus === 'completed') {
      res.json({ status: 'already_completed' });
      return;
    }

    record.paymentStatus = 'completed';
    record.paymentTxHash = txHash;

    const ttl = await redis.ttl(key);
    await redis.set(key, JSON.stringify(record), 'EX', ttl > 0 ? ttl : 300);

    // Publish flow event if this requestId is linked to a flow
    try {
      const { getFlowByRequestId, publishFlowEvent } = await import('./skills/flowManager.js');
      const flow = await getFlowByRequestId(requestId, redis);
      if (flow) {
        await publishFlowEvent(redis, flow.flowId, { ...flow, updatedAt: new Date().toISOString() });
      }
    } catch (e) {
      console.error('[payment] Failed to publish flow event:', e);
    }

    console.log(`[Payment] Confirmed for ${requestId}: ${txHash}`);
    res.json({ status: 'confirmed' });
  });

  // Payment via EIP-3009 signed authorization (facilitator settles on-chain)
  app.post('/api/payment/sign/:requestId', async (req, res) => {
    const { requestId } = req.params;
    const { authorization, signature } = req.body;

    if (!authorization || !signature) {
      res.status(400).json({ error: 'Missing authorization or signature' });
      return;
    }

    const key = `signing:${requestId}`;
    const data = await redis.get(key);

    if (!data) {
      res.status(404).json({ error: 'Request not found or expired' });
      return;
    }

    const record: SigningRequestRecord = JSON.parse(data);

    if (record.paymentStatus === 'completed') {
      res.json({ success: true, message: 'Payment already completed', txHash: record.paymentTxHash });
      return;
    }

    // Build x402 payment payload and requirements for facilitator settlement
    const network = config.paymentMode === 'testnet'
      ? PAYMENT_NETWORKS.testnet
      : PAYMENT_NETWORKS.mainnet;
    const usdcAddress = network === PAYMENT_NETWORKS.testnet
      ? '0x036CbD53842c5426634e7929541eC2318f3dCF7e'
      : '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
    const priceStr = (config.paymentProofPrice || '$0.10').replace('$', '');
    const amount = String(Math.round(parseFloat(priceStr) * 1_000_000));

    const paymentRequirements = {
      scheme: 'exact' as const,
      network,
      amount,
      asset: usdcAddress,
      payTo: config.paymentPayTo,
      maxTimeoutSeconds: 300,
      extra: { name: 'USDC', version: '2' } as Record<string, unknown>,
    };

    const resourceUrl = `${config.a2aBaseUrl}/v1/chat/completions`;
    const paymentPayload = {
      x402Version: 2,
      resource: { url: resourceUrl, description: 'ZK proof generation payment', mimeType: '' },
      accepted: paymentRequirements,
      payload: { authorization, signature } as Record<string, unknown>,
    };

    try {
      const facilitatorClient = new HTTPFacilitatorClient({
        url: config.paymentFacilitatorUrl,
      });

      const settleResult = await facilitatorClient.settle(paymentPayload, paymentRequirements);

      if (settleResult.success) {
        record.paymentStatus = 'completed';
        record.paymentTxHash = settleResult.transaction;
        const ttl = await redis.ttl(key);
        await redis.set(key, JSON.stringify(record), 'EX', ttl > 0 ? ttl : 300);

        // Publish flow event if this requestId is linked to a flow
        try {
          const { getFlowByRequestId, publishFlowEvent } = await import('./skills/flowManager.js');
          const flow = await getFlowByRequestId(requestId, redis);
          if (flow) {
            await publishFlowEvent(redis, flow.flowId, { ...flow, updatedAt: new Date().toISOString() });
          }
        } catch (e) {
          console.error('[payment] Failed to publish flow event:', e);
        }

        console.log(`[Payment] Facilitator settled for ${requestId}: ${settleResult.transaction}`);
        res.json({
          success: true,
          txHash: settleResult.transaction,
          network: settleResult.network,
        });
      } else {
        console.error(`[Payment] Facilitator settlement failed for ${requestId}: ${settleResult.errorMessage}`);
        res.status(400).json({
          error: settleResult.errorMessage || settleResult.errorReason || 'Payment settlement failed',
        });
      }
    } catch (error: any) {
      console.error('[Payment] Facilitator settle error:', error);
      res.status(500).json({
        error: error.message || 'Payment processing failed',
      });
    }
  });

  // Payment page is now served by the sign-page Next.js app (proxied via /pay below)

  // Proxy sign-page requests to internal Next.js server
  app.use('/s', createSignPageProxy());
  app.use('/pay', createSignPageProxy());
  app.use('/_next', createSignPageProxy());

  return { app, paymentFacilitator, teeProvider, taskWorker, settlementWorker, cleanupWorker };
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
    const { app, paymentFacilitator, teeProvider, taskWorker, settlementWorker, cleanupWorker } = createApp(
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

      cleanupWorker.start();
      console.log('CleanupWorker started');

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
