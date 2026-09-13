import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { DemoConfig } from '../demo/shared/config.ts';
import { installRecordingRoutes } from '../demo/staking-service/src/recordingRoutes.ts';
import { MAX_CLAUDE_STREAM_BYTES } from '../demo/staking-service/src/claudeSession.ts';

const spawn = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({spawn}));
let app: express.Express;
let children: (EventEmitter & {stdout: PassThrough; stderr: PassThrough; pid: number})[];
let oldSignals: NodeJS.SignalsListener[];
beforeEach(() => {
  children = [];
  spawn.mockReset().mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), {stdout: new PassThrough(), stderr: new PassThrough(), pid: 987654});
    children.push(child); return child;
  });
  vi.spyOn(process, 'kill').mockReturnValue(true);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({paymentMode:'testnet', paymentRequired:true,paymentNetworks:'arc-testnet-nano'}))));
  oldSignals = process.listeners('SIGTERM');
  app = express(); app.use(express.json());
  installRecordingRoutes(app, {port:4107, proverUrl:'https://example.invalid', positions:async()=>[], chain:{} as DemoConfig});
});
afterEach(() => {
  for (const child of children) { child.emit('close', 1); child.removeAllListeners(); }
  for (const listener of process.listeners('SIGTERM')) if (!oldSignals.includes(listener)) process.removeListener('SIGTERM', listener);
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
});

describe('Claude recording route', () => {
  it('requires both an explicit instruction and validated amount before creating a process', async () => {
    for (const body of [{amount:'0.1'}, {amount:'0.1',instruction:' '}, {amount:'0.1',instruction:'x'.repeat(2001)}, {amount:'-1',instruction:'Stake'}]) {
      expect((await request(app).post('/demo/run').send(body)).status).toBe(400);
    }
    expect(spawn).not.toHaveBeenCalled();
  });

  it('rejects cross-origin spending requests', async () => {
    const response = await request(app).post('/demo/run').set('Origin','https://unrelated.example').send({amount:'0.1',instruction:'Stake'});
    expect(response.status).toBe(403); expect(spawn).not.toHaveBeenCalled();
  });

  it('redacts configured credentials before the instruction reaches Claude', async () => {
    const secret = 'fixture-credential-never-send';
    vi.stubEnv('ATTESTATION_WALLET_ADDRESS', secret);
    const response = await request(app).post('/demo/run').send({amount:'0.1',instruction:`Inspect the dApp; credential ${secret}.`});
    expect(response.status).toBe(202);
    const args = spawn.mock.calls[0][1];
    expect(args[1]).toBe('Inspect the dApp; credential ****.');
    expect(JSON.stringify(args)).not.toContain(secret);
    const state = (await request(app).get('/demo/state')).body.run;
    expect(JSON.stringify(state)).not.toContain(secret);
  });

  it('launches Claude from a private temporary directory with only the dedicated MCP server', async () => {
    const response = await request(app).post('/demo/run').send({amount:'0.1',instruction:'Inspect the dApp without spending.'});
    expect(response.status).toBe(202);
    const [command, args, options] = spawn.mock.calls[0];
    expect(command).toBe('claude'); expect(args.slice(0,2)).toEqual(['-p','Inspect the dApp without spending.']);
    expect(options.cwd).not.toBe(process.cwd());
    expect(Object.keys(options.env)).not.toEqual(expect.arrayContaining(['ATTESTATION_KEY']));
    expect(Object.keys(options.env)).not.toEqual(expect.arrayContaining(['OPENAI_API_KEY']));
    const config = JSON.parse(await readFile(join(options.cwd, 'mcp.json'), 'utf8'));
    expect(Object.keys(config.mcpServers)).toEqual(['ledger_house']);
    expect(config.mcpServers.ledger_house.command).toBe(process.execPath);
    expect(config.mcpServers.ledger_house.args[0]).toMatch(/\/demo\/user-agent\/src\/dapp-mcp\.ts$/);
    expect(config.mcpServers.ledger_house.env).toEqual({DEMO_SERVICE:'http://localhost:4107', DEMO_AMOUNT:'0.1',DEMO_AGENT_TOKEN:expect.any(String)});
    expect((await stat(join(options.cwd, 'mcp.json'))).mode & 0o777).toBe(0o600);
    expect((await request(app).post('/demo/run').send({amount:'0.1',instruction:'Another run'})).status).toBe(409);
    children[0].stdout.write(JSON.stringify({type:'system',subtype:'init',model:'claude-actual-fixture'})+'\n');
    children[0].stdout.write(JSON.stringify({type:'assistant',message:{content:[{type:'thinking',thinking:'never publish this thought'}]}})+'\n');
    children[0].stderr.write('never publish this diagnostic');
    const state = (await request(app).get('/demo/state')).body.run;
    expect(state.agent).toEqual({provider:'Claude Code',model:'claude-actual-fixture'});
    expect(state.instruction).toBe('Inspect the dApp without spending.');
    expect(state.terminal.command).toContain('claude -p');
    expect(JSON.stringify(state)).not.toMatch(/never publish/);
  });

  it('fails boundedly on oversized output and terminates only the spawned process group', async () => {
    await request(app).post('/demo/run').send({amount:'0.1',instruction:'Stake 0.1 USDC'});
    children[0].stdout.write(Buffer.alloc(MAX_CLAUDE_STREAM_BYTES+1));
    const state = (await request(app).get('/demo/state')).body.run;
    expect(state.status).toBe('failed');
    expect(process.kill).toHaveBeenCalledWith(-children[0].pid, 'SIGTERM');
  });

  it('does not start an agent on page state reads and requires a separate browser decision',async()=>{
    expect((await request(app).get('/demo/state')).body.run).toBeNull();expect(spawn).not.toHaveBeenCalled();
    await request(app).post('/demo/run').send({amount:'0.1',instruction:'Stake after asking me for permission.'});
    const config=JSON.parse(await readFile(join(spawn.mock.calls[0][2].cwd,'mcp.json'),'utf8'));
    const token=config.mcpServers.ledger_house.env.DEMO_AGENT_TOKEN;
    const details={amount:'0.1',delegate:'B',fee:'0.001'};
    expect((await request(app).post('/demo/permissions').send({kind:'proof',details})).status).toBe(403);
    const p=(await request(app).post('/demo/permissions').set('Authorization',`Bearer ${token}`).send({kind:'proof',details})).body;
    expect(p.status).toBe('pending');
    const state=(await request(app).get('/demo/state')).body;
    expect(state.run.permissions[0].status).toBe('pending');expect(JSON.stringify(state)).not.toContain(token);
    expect((await request(app).post(`/demo/permissions/${p.id}/decision`).set('Authorization',`Bearer ${token}`).send({decision:'approve'})).status).toBe(403);
    expect((await request(app).post(`/demo/permissions/${p.id}/decision`).set('Origin','https://attacker.invalid').set('X-Demo-User-Action','1').send({decision:'approve'})).status).toBe(403);
    const approved=await request(app).post(`/demo/permissions/${p.id}/decision`).set('Origin','http://localhost:4107').set('X-Demo-User-Action','1').send({decision:'approve'});
    expect(approved.body.status).toBe('approved');expect(approved.body.decidedAt).toEqual(expect.any(String));
    expect((await request(app).post('/demo/permissions').set('Authorization',`Bearer ${token}`).send({kind:'proof',details:{...details,fee:'1'}})).status).toBe(409);
    children[0].emit('close',0);
    expect((await request(app).get(`/demo/permissions/${p.id}`).set('Authorization',`Bearer ${token}`)).status).toBe(403);
  });

  it('reports spawn failure and rejects a successful exit without stake evidence', async () => {
    await request(app).post('/demo/run').send({amount:'0.1',instruction:'Stake 0.1 USDC'});
    children[0].emit('error', new Error('fixture spawn error'));
    children[0].emit('close', 0);
    const state = (await request(app).get('/demo/state')).body.run;
    expect(state.status).toBe('failed'); expect(state.txHash).toBeNull();
  });
});
