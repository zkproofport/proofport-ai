import type { Express, Request } from 'express';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {randomUUID} from 'node:crypto';
import {PermissionLedger} from './permissions.ts';
import { RecordingRun, parseStakeAmount, parseInstruction } from './recording.ts';
import { ClaudeStreamDecoder, claudeArguments, claudeEnvironment } from './claudeSession.ts';
import { createRedactor } from '../../user-agent/src/privacy.ts';
import type { DemoConfig } from '../../shared/config.ts';

export function isLocalRecordingRequest(req: Request, port: number) {
  if (!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '')) return false;
  const origin=req.get('origin');
  return !origin || [`http://localhost:${port}`,`http://127.0.0.1:${port}`].includes(origin);
}

export function installRecordingRoutes(app: Express, options: { proverUrl: string; port: number; positions: () => Promise<unknown>; chain:DemoConfig }) {
  let current: RecordingRun | null = null;
  let permissions=new PermissionLedger();
  let agentToken='';
  const snapshot=()=>current ? {...current.snapshot(),permissions:permissions.snapshot()} : null;
  let terminateAgent: (() => void) | null = null;
  process.once('SIGTERM', () => { terminateAgent?.(); process.exit(0); });
  let healthCache: { at: number; value: unknown } | null = null;
  const subscribers = new Set<import('express').Response>();
  const publish = () => {
    const message = `data: ${JSON.stringify(snapshot())}\n\n`;
    for (const res of subscribers) res.write(message);
  };

  async function health() {
    if (healthCache && Date.now() - healthCache.at < 3000) return healthCache.value;
    let value: unknown;
    try {
      const response = await fetch(`${options.proverUrl}/health`, { signal: AbortSignal.timeout(5000) });
      const data = await response.json() as { tee?: { mode?: string }; status?: string;paymentMode?:string;paymentRequired?:boolean;paymentNetworks?:string };
      value = { reachable: response.ok, teeMode: data.tee?.mode ?? 'unknown',host:'GCP Cloud Run',
        paymentReady:data.paymentMode==='testnet'&&data.paymentRequired===true&&Boolean(data.paymentNetworks?.split(',').includes('arc-testnet-nano')) };
    } catch { value = { reachable: false, teeMode: 'unknown' }; }
    healthCache = { at: Date.now(), value };
    return value;
  }

  app.get('/health', (_req, res) => res.json({ service: 'ledger-house', recording: true }));
  app.get('/demo/state', async (_req, res) => {
    try { res.set('Cache-Control', 'no-store').json({ run: snapshot(),
      prover: await health(), positions: await options.positions(), chainId: 5042002, chain:options.chain,
      execution: 'onchain-stake', payment: 'arc-testnet-nano' }); }
    catch { res.status(503).json({error:'Arc position data is temporarily unavailable.'}); }
  });
  app.get('/demo/events', (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.flushHeaders();
    subscribers.add(res);
    res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
    const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15000);
    req.on('close', () => { clearInterval(heartbeat); subscribers.delete(res); });
  });
  const isAgent=(req:Request)=>isLocalRecordingRequest(req,options.port)&&agentToken.length>0&&req.get('authorization')===`Bearer ${agentToken}`&&current?.snapshot().status==='running';
  app.post('/demo/permissions', (req,res)=>{
    if(!isAgent(req))return res.status(403).json({error:'Only the active agent may request permission.'});
    const {kind,details}=req.body??{};
    if(!['proof','stake'].includes(kind)||!details||typeof details!=='object'||Array.isArray(details)||JSON.stringify(details).length>12000||details.amount!==current!.amount)return res.status(400).json({error:'Invalid permission request.'});
    try{const value=permissions.request(kind,JSON.parse(createRedactor(process.env)(JSON.stringify(details))));publish();return res.json(value);}
    catch(error){return res.status(409).json({error:(error as Error).message});}
  });
  app.get('/demo/permissions/:id',(req,res)=>{
    if(!isAgent(req))return res.status(403).json({error:'This agent session is no longer active.'});
    try{return res.json(permissions.get(String(req.params.id)));}catch{return res.status(404).json({error:'Unknown permission request.'});}
  });
  app.post('/demo/permissions/:id/decision',(req,res)=>{
    // Browser-only action: the model has no decision tool and no browser capability.
    if(!isLocalRecordingRequest(req,options.port)||!req.get('origin')||req.get('x-demo-user-action')!=='1')return res.status(403).json({error:'Confirm this request in the dApp.'});
    if(current?.snapshot().status!=='running'||!['approve','reject'].includes(req.body?.decision))return res.status(409).json({error:'No matching active user decision.'});
    try{const value=permissions.decide(String(req.params.id),req.body.decision);publish();return res.json(value);}
    catch(error){return res.status(409).json({error:(error as Error).message});}
  });
  app.post('/demo/run', async (req, res) => {
    if (!isLocalRecordingRequest(req,options.port)) return res.status(403).json({ error: 'Run this demo from this computer.' });
    if (terminateAgent || current?.snapshot().status === 'running') return res.status(409).json({ error: 'An agent is already running. Wait for its result.' });
    let amount: string, instruction: string;
    try { amount = parseStakeAmount(req.body?.amount); instruction = parseInstruction(req.body?.instruction); }
    catch (error) { return res.status(400).json({ error: (error as Error).message }); }
    const redact = createRedactor(process.env);
    instruction = redact(instruction);
    const run = new RecordingRun(amount, redact);
    current = run;
    permissions=new PermissionLedger();agentToken=randomUUID();
    run.startClaude(instruction);
    publish();
    let directory: string;
    try {
      directory = await mkdtemp(join(tmpdir(), 'ledger-house-claude-'));
      await writeFile(join(directory, 'mcp.json'), JSON.stringify({ mcpServers: { ledger_house: {
        command: process.execPath,
        args: [fileURLToPath(new URL('../../user-agent/src/dapp-mcp.ts', import.meta.url))],
        env: { DEMO_SERVICE: `http://localhost:${options.port}`, DEMO_AMOUNT: amount, DEMO_AGENT_TOKEN:agentToken },
      } } }), { mode: 0o600 });
    } catch {
      run.finish(1, 'Could not prepare the Claude Code session.'); publish();
      return res.status(503).json({error: 'Could not prepare the Claude Code session.'});
    }
    const child = spawn('claude', claudeArguments(instruction, join(directory, 'mcp.json'), amount),
      { cwd: directory, env: claudeEnvironment(process.env), detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const terminate = () => {
      if (!child.pid) return;
      try { process.kill(-child.pid, 'SIGTERM'); } catch { /* The process group already exited. */ }
    };
    terminateAgent = terminate;
    const output = new ClaudeStreamDecoder(event => { run.observeClaude(event); publish(); });
    let streamFailed = false;
    child.stdout.on('data', chunk => {
      if (streamFailed) return;
      try { output.push(chunk); }
      catch { streamFailed = true; terminate(); run.finish(1, 'Claude returned invalid or oversized stream JSON.'); publish(); }
    });
    // Drain diagnostics without storing or exposing model output or credentials.
    child.stderr.on('data', () => {});
    child.on('error', () => { run.finish(1, 'The agent process could not start. Check the recording terminal.'); publish(); });
    const timeout = setTimeout(() => { terminate(); run.finish(1, 'The agent exceeded the 15 minute time limit. Check the recording terminal.'); publish(); }, 900000);
    child.on('close', code => {
      clearTimeout(timeout); if (terminateAgent === terminate) terminateAgent = null;
      if (!streamFailed) {
        try { output.end(); } catch { streamFailed = true; }
      }
      permissions.close();run.finish(streamFailed ? 1 : code); publish();
      void rm(directory, { recursive: true, force: true });
    });
    return res.status(202).json({ runId: run.id, state: '/demo/state', events: '/demo/events' });
  });
}
