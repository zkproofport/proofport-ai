import type { Express, Request } from 'express';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { RecordingRun, parseStakeAmount } from './recording.ts';
import type { DemoConfig } from '../../shared/config.ts';

export function isLocalRecordingRequest(req: Request, port: number) {
  if (!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '')) return false;
  const origin=req.get('origin');
  return !origin || [`http://localhost:${port}`,`http://127.0.0.1:${port}`].includes(origin);
}

export function installRecordingRoutes(app: Express, options: { proverUrl: string; port: number; positions: () => Promise<unknown>; chain:DemoConfig }) {
  let current: RecordingRun | null = null;
  let terminateAgent: (() => void) | null = null;
  process.once('SIGTERM', () => { terminateAgent?.(); process.exit(0); });
  let healthCache: { at: number; value: unknown } | null = null;
  const subscribers = new Set<import('express').Response>();
  const publish = () => {
    const message = `data: ${JSON.stringify(current?.snapshot() ?? null)}\n\n`;
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
    try { res.set('Cache-Control', 'no-store').json({ run: current?.snapshot() ?? null,
      prover: await health(), positions: await options.positions(), chainId: 5042002, chain:options.chain,
      execution: 'onchain-stake', payment: 'arc-testnet-nano' }); }
    catch { res.status(503).json({error:'Arc position data is temporarily unavailable.'}); }
  });
  app.get('/demo/events', (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.flushHeaders();
    subscribers.add(res);
    res.write(`data: ${JSON.stringify(current?.snapshot() ?? null)}\n\n`);
    const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15000);
    req.on('close', () => { clearInterval(heartbeat); subscribers.delete(res); });
  });
  app.post('/demo/run', (req, res) => {
    if (!isLocalRecordingRequest(req,options.port)) return res.status(403).json({ error: 'Run this demo from this computer.' });
    if (current?.snapshot().status === 'running') return res.status(409).json({ error: 'An agent is already running. Wait for its result.' });
    let amount: string;
    try { amount = parseStakeAmount(req.body?.amount); }
    catch (error) { return res.status(400).json({ error: (error as Error).message }); }
    if (!process.env.ATTESTATION_KEY || !process.env.PROVE_COMMAND) {
      return res.status(503).json({ error: 'Start the recording server with demo/record.sh so it can read the existing wallet environment.' });
    }
    const run = new RecordingRun(amount);
    current = run;
    publish();
    const child = spawn(process.execPath, [fileURLToPath(new URL('../../user-agent/src/stake.ts', import.meta.url)),
      '--service', `http://localhost:${options.port}`, '--amount', amount, '--pay-on', 'arc-testnet-nano', '--pay-with', 'arc'],
    { env: { ...process.env, CIRCLE_ACCEPT_TERMS: '1' }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const terminate = () => {
      if (!child.pid) return;
      try { process.kill(-child.pid, 'SIGTERM'); } catch { /* The process group already exited. */ }
    };
    terminateAgent = terminate;
    const output = createInterface({ input: child.stdout });
    output.on('line', line => { run.observe(line); publish(); });
    // Keep diagnostics on the host, never transmit the credential process's raw output.
    child.stderr.on('data', chunk => process.stderr.write(chunk));
    child.on('error', () => { run.finish(1, 'The agent process could not start. Check the recording terminal.'); publish(); });
    const timeout = setTimeout(() => { terminate(); run.finish(1, 'The agent exceeded the 8 minute time limit. Check the recording terminal.'); publish(); }, 480000);
    child.on('close', code => { clearTimeout(timeout); terminateAgent = null; output.close(); run.finish(code); publish(); });
    return res.status(202).json({ runId: run.id, state: '/demo/state', events: '/demo/events' });
  });
}
