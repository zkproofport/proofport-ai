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
import { createPaymentMiddleware, buildPaymentRequiredHeaderValue } from './payment/x402Middleware.js';
import { createPaymentRecordingMiddleware } from './payment/recordingMiddleware.js';
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
import { createChatRoutes } from './chat/chatHandler.js';
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
  const paymentMiddleware = createPaymentMiddleware(config);
  const paymentRecordingMiddleware = createPaymentRecordingMiddleware({
    paymentMode: config.paymentMode,
    facilitator: paymentFacilitator,
  });
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

  // Discovery endpoints for 8004scan
  app.get('/.well-known/agent.json', getOasfAgentHandler(config, agentTokenId));
  app.get('/.well-known/agent-card.json', getAgentCardHandler(config, agentTokenId));
  app.get('/.well-known/mcp.json', getMcpDiscoveryHandler(config));

  // Payment gate only for message/send and message/stream (proof generation)
  const a2aPaymentMiddleware = (req: any, res: any, next: any) => {
    const method = req.body?.method;
    if (method === 'message/send' || method === 'message/stream') {
      // Skip payment for get_supported_circuits (read-only, no proof generation)
      const message = req.body?.params?.message;
      if (message) {
        const parts = message.parts || [];
        const isFreeSkill = parts.some((p: any) =>
          p.kind === 'data' && (p.data?.skill === 'get_supported_circuits' || p.data?.skill === 'verify_proof')
        );
        if (isFreeSkill) {
          next();
          return;
        }
      }
      return paymentMiddleware(req, res, () => {
        paymentRecordingMiddleware(req, res, next);
      });
    }
    next();
  };

  // Payment-gated routes — single POST /a2a handles all A2A v0.3 JSON-RPC methods
  app.post('/a2a', a2aPaymentMiddleware, createA2aHandler({ taskStore, taskEventEmitter, paymentFacilitator }));

  // REST API routes with payment middleware on proof generation only (verify is free)
  const restPaymentMiddleware = (req: any, res: any, next: any) => {
    const isProofGeneration = req.path === '/proofs' && req.method === 'POST';
    if (isProofGeneration) {
      return paymentMiddleware(req, res, () => {
        paymentRecordingMiddleware(req, res, next);
      });
    }
    next();
  };
  app.use('/api/v1', restPaymentMiddleware, createRestRoutes({ taskStore, taskEventEmitter, redis, config, paymentFacilitator }));

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

  // MCP StreamableHTTP endpoint (stateless mode, payment only on paid tools/call)
  const mcpPaymentMiddleware = (req: any, res: any, next: any) => {
    const method = req.body?.method;
    if (method === 'tools/call') {
      // Skip payment for free tools (read-only or verification)
      const toolName = req.body?.params?.name;
      if (toolName === 'get_supported_circuits' || toolName === 'verify_proof') {
        next();
        return;
      }
      return paymentMiddleware(req, res, () => {
        paymentRecordingMiddleware(req, res, next);
      });
    }
    next();
  };
  app.post('/mcp', mcpPaymentMiddleware, async (req, res) => {
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
  // Payment enforced via PaymentRequiredError — same x402 flow as REST/MCP/A2A
  const llmProviders: LLMProvider[] = [];
  if (config.openaiApiKey) {
    llmProviders.push(new OpenAIProvider({ apiKey: config.openaiApiKey }));
  }
  if (config.geminiApiKey) {
    llmProviders.push(new GeminiProvider({ apiKey: config.geminiApiKey }));
  }

  if (llmProviders.length > 0) {
    const llmProvider = new MultiLLMProvider(llmProviders);
    const paymentRequiredHeader = buildPaymentRequiredHeaderValue(
      config,
      `${config.a2aBaseUrl}/v1/chat/completions`,
      'ZK proof generation/verification via chat',
    );
    const chatDeps = {
      redis, taskStore, taskEventEmitter, a2aBaseUrl: config.a2aBaseUrl, llmProvider,
      paymentRequiredHeader,
    };

    // Conditional payment verifier: only runs x402 verification when PAYMENT-SIGNATURE is present
    const chatPaymentVerifier = (req: any, res: any, next: any) => {
      const hasPayment = req.headers['payment-signature'] || req.headers['x-payment'];
      if (hasPayment) {
        return paymentMiddleware(req, res, () => {
          paymentRecordingMiddleware(req, res, () => {
            req.paymentVerified = true;
            next();
          });
        });
      }
      next();
    };

    app.use('/api/v1', chatPaymentVerifier, createChatRoutes(chatDeps));
    app.use('/v1', chatPaymentVerifier, createOpenAIRoutes(chatDeps));
    console.log(`[Chat] LLM chat endpoint enabled (providers: ${llmProviders.map(p => p.name).join(' -> ')})`);
    console.log('[OpenAI] Compatible endpoint enabled at /v1/chat/completions');
  } else {
    app.post('/api/v1/chat', (_req, res) => {
      res.status(503).json({ error: 'Chat not configured. Set OPENAI_API_KEY or GEMINI_API_KEY.' });
    });
    app.post('/v1/chat/completions', (_req, res) => {
      res.status(503).json({ error: { message: 'Chat not configured. Set OPENAI_API_KEY or GEMINI_API_KEY.', type: 'server_error', code: 'not_configured' } });
    });
  }

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
      payTo: config.paymentPayTo,
      amount,
      priceDisplay: config.paymentProofPrice || '$0.10',
      usdcAddress,
      chainId,
      chainName: isTestnet ? 'Base Sepolia' : 'Base',
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

    console.log(`[Payment] Confirmed for ${requestId}: ${txHash}`);
    res.json({ status: 'confirmed' });
  });

  // Payment page for USDC transfer
  app.get('/pay/:requestId', (req, res) => {
    const { requestId } = req.params;
    const infoUrl = `${config.a2aBaseUrl}/api/payment/${requestId}`;
    const confirmUrl = `${config.a2aBaseUrl}/api/payment/confirm/${requestId}`;
    res.setHeader('Content-Type', 'text/html');
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>proveragent.eth — Payment</title>
<script src="https://cdn.jsdelivr.net/npm/ethers@6.13.1/dist/ethers.umd.min.js"><\/script>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0a0a0a;color:#f0f0f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:1rem}
.card{background:#1a1a1a;border:1px solid #333;border-radius:12px;padding:2rem;max-width:480px;width:100%}
h1{font-size:1.25rem;font-weight:600;margin-bottom:.5rem;text-align:center}
.subtitle{color:#999;font-size:.875rem;text-align:center;margin-bottom:1.5rem}
.field{margin-bottom:.75rem}
.label{color:#999;font-size:.75rem;text-transform:uppercase;letter-spacing:.05em;margin-bottom:.25rem}
.value{font-family:'Courier New',monospace;font-size:.8rem;color:#93c5fd;word-break:break-all}
.price{font-size:2rem;font-weight:700;text-align:center;color:#4ade80;margin:1rem 0}
.btn{display:block;width:100%;padding:.875rem;border:none;border-radius:8px;font-size:1rem;font-weight:600;cursor:pointer;margin-top:1rem;transition:opacity .2s}
.btn-pay{background:#2563eb;color:#fff}
.btn-pay:hover{opacity:.9}
.btn-pay:disabled{opacity:.5;cursor:not-allowed}
.status{padding:1rem;border-radius:8px;margin-top:1rem;font-size:.875rem;text-align:center}
.loading{background:#1a2a3a;border:1px solid #2a4a5a;color:#93c5fd}
.success{background:#1a3a2a;border:1px solid #2a5a3a;color:#4ade80}
.error{background:#3a1a1a;border:1px solid #5a2a2a;color:#f87171;word-break:break-word;overflow-wrap:break-word}
.done{background:#1a3a2a;border:1px solid #2a5a3a;color:#4ade80}
.balance-info{color:#999;font-size:.8rem;text-align:center;margin-top:.5rem}
.faucet-link{color:#93c5fd;text-decoration:underline}
.spinner{display:inline-block;width:16px;height:16px;border:2px solid #93c5fd;border-top-color:transparent;border-radius:50%;animation:spin 1s linear infinite;vertical-align:middle;margin-right:6px}
@keyframes spin{to{transform:rotate(360deg)}}
</style>
</head>
<body>
<div class="card">
<h1>proveragent.eth</h1>
<p class="subtitle">ZK Proof Generation Payment</p>
<div id="content"><div class="status loading"><span class="spinner"></span>Loading...</div></div>
</div>
<script>
const INFO_URL='${infoUrl}';
const CONFIRM_URL='${confirmUrl}';
const ERC20_ABI=['function transfer(address to, uint256 amount) returns (bool)','function balanceOf(address) view returns (uint256)'];

let payInfo=null;

async function init(){
  const el=document.getElementById('content');
  try{
    const r=await fetch(INFO_URL);
    if(!r.ok){const d=await r.json();el.innerHTML='<div class="status error">'+d.error+'</div>';return}
    payInfo=await r.json();

    if(payInfo.paymentStatus==='completed'){
      el.innerHTML='<div class="status done">\\u2713 Payment already completed</div><p style="text-align:center;color:#999;margin-top:1rem;font-size:.875rem">Return to the chat and tell the agent to proceed.</p>';
      return;
    }

    el.innerHTML=
      '<div class="field"><div class="label">Circuit</div><div class="value">'+payInfo.circuitId+'</div></div>'+
      '<div class="field"><div class="label">Network</div><div class="value">'+payInfo.chainName+'</div></div>'+
      '<div class="price">'+payInfo.priceDisplay+' USDC</div>'+
      '<button class="btn btn-pay" id="payBtn" onclick="handlePay()">Connect Wallet & Pay</button>'+
      '<div id="payStatus"></div>';
  }catch(e){el.innerHTML='<div class="status error">Failed to load: '+e.message+'</div>'}
}

async function handlePay(){
  const btn=document.getElementById('payBtn');
  const st=document.getElementById('payStatus');
  btn.disabled=true;
  btn.textContent='Connecting...';

  try{
    if(!window.ethereum){
      st.innerHTML='<div class="status error">No wallet detected. Please open this page in a browser with MetaMask or a Web3 wallet.</div>';
      btn.disabled=false;btn.textContent='Connect Wallet & Pay';
      return;
    }

    const provider=new ethers.BrowserProvider(window.ethereum);
    const signer=await provider.getSigner();
    const network=await provider.getNetwork();

    // Switch chain if needed
    const targetChainHex='0x'+payInfo.chainId.toString(16);
    if(Number(network.chainId)!==payInfo.chainId){
      btn.textContent='Switching network...';
      try{
        await window.ethereum.request({method:'wallet_switchEthereumChain',params:[{chainId:targetChainHex}]});
      }catch(switchErr){
        if(switchErr.code===4902){
          await window.ethereum.request({method:'wallet_addEthereumChain',params:[{
            chainId:targetChainHex,
            chainName:payInfo.chainName,
            nativeCurrency:{name:'ETH',symbol:'ETH',decimals:18},
            rpcUrls:[payInfo.chainId===84532?'https://sepolia.base.org':'https://mainnet.base.org'],
            blockExplorerUrls:[payInfo.chainId===84532?'https://sepolia.basescan.org':'https://basescan.org']
          }]});
        }else throw switchErr;
      }
    }

    btn.textContent='Checking balance...';
    const usdc=new ethers.Contract(payInfo.usdcAddress,ERC20_ABI,signer);
    const addr=await signer.getAddress();
    const balance=await usdc.balanceOf(addr);
    const required=BigInt(payInfo.amount);

    if(balance<required){
      const balFmt=(Number(balance)/1e6).toFixed(2);
      const reqFmt=(Number(required)/1e6).toFixed(2);
      const isTn=payInfo.chainId===84532;
      st.innerHTML='<div class="status error">Insufficient USDC balance<br><br>'+
        'Your balance: <strong>'+balFmt+' USDC</strong><br>'+
        'Required: <strong>'+reqFmt+' USDC</strong></div>'+
        (isTn?'<p class="balance-info">This is Base Sepolia testnet. Get test USDC from <a class="faucet-link" href="https://faucet.circle.com/" target="_blank">Circle Faucet</a></p>':'');
      btn.disabled=false;btn.textContent='Connect Wallet & Pay';
      return;
    }

    btn.textContent='Sending USDC...';
    st.innerHTML='<div class="status loading"><span class="spinner"></span>Confirm the transaction in your wallet</div>';

    const tx=await usdc.transfer(payInfo.payTo,required);

    st.innerHTML='<div class="status loading"><span class="spinner"></span>Waiting for confirmation...</div>';
    btn.textContent='Confirming...';
    await tx.wait(1);

    // Notify backend
    st.innerHTML='<div class="status loading"><span class="spinner"></span>Confirming payment...</div>';
    await fetch(CONFIRM_URL,{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({txHash:tx.hash})
    });

    btn.style.display='none';
    st.innerHTML='<div class="status success">\\u2713 Payment confirmed!</div><p style="text-align:center;color:#999;margin-top:1rem;font-size:.875rem">Return to the chat and tell the agent to proceed.</p>';
  }catch(e){
    console.error(e);
    let msg=e.message||'Unknown error';
    if(msg.includes('transfer amount exceeds balance'))msg='Insufficient USDC balance. Please fund your wallet and try again.';
    else if(msg.includes('user rejected'))msg='Transaction rejected by user.';
    else if(msg.includes('denied'))msg='Transaction denied by wallet.';
    else if(msg.length>200)msg=msg.substring(0,200)+'...';
    st.innerHTML='<div class="status error">'+msg+'</div>';
    btn.disabled=false;btn.textContent='Connect Wallet & Pay';
  }
}

init();
<\/script>
</body>
</html>`);
  });

  // Proxy sign-page requests to internal Next.js server
  app.use('/s', createSignPageProxy());
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
