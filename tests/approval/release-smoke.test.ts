import { describe, expect, it, vi } from 'vitest';
import { approvalRequestUrl, parseOptions, runReleaseSmoke } from '../../scripts/verify-approval-deployment.mjs';

describe('deployed approval smoke guards (unit)', () => {
  it('requires explicit opt-in before either canonical HTTPS host', () => {
    expect(() => parseOptions(['--base-url', 'https://stg-ai.zkproofport.app'])).toThrow();
    for (const hostname of ['stg-ai.zkproofport.app', 'ai.zkproofport.app']) {
      expect(parseOptions(['--allow-deployed', '--base-url', `https://${hostname}`]).baseUrl).toBe(`https://${hostname}`);
    }
  });
  it.each([
    'http://stg-ai.zkproofport.app', 'https://ai.zkproofport.app:8443',
    'https://ai.zkproofport.app.evil.example', 'https://user:secret@ai.zkproofport.app',
    'https://ai.zkproofport.app/approve/anything', 'https://ai.zkproofport.app?secret=x',
    'https://ai.zkproofport.app#secret', 'http://127.0.0.1:4002', 'https://stg-ai.zkproofport.app.',
  ])('rejects a noncanonical release target without sending requests (%s)', value => {
    expect(() => parseOptions(['--allow-deployed', '--base-url', value])).toThrow();
  });
  it('rejects ambiguous/unknown arguments and malformed expected digests', () => {
    expect(() => parseOptions(['--allow-deployed','--base-url','https://ai.zkproofport.app','--base-url','https://stg-ai.zkproofport.app'])).toThrow();
    expect(() => parseOptions(['--allow-deployed','--base-url','https://ai.zkproofport.app','--payment'])).toThrow();
    expect(() => parseOptions(['--allow-deployed','--base-url','https://ai.zkproofport.app','--expected-index-sha256','bad'])).toThrow();
  });
  it('allows only approval/health routes and exact local asset paths', () => {
    const base='https://ai.zkproofport.app'; const id='ab'.repeat(16);
    expect(approvalRequestUrl(base,`/api/v1/action-approvals/${id}/consume`)).toBe(`${base}/api/v1/action-approvals/${id}/consume`);
    expect(approvalRequestUrl(base,'/approval/assets/index-Abc123.js')).toBe(`${base}/approval/assets/index-Abc123.js`);
    for(const path of ['/api/v1/prove','/api/v1/challenge','/payment','//evil.example','/approval/assets/../../secret','/approval/assets/index.js?token=x']) {
      expect(()=>approvalRequestUrl(base,path)).toThrow();
    }
  });
  it('sanitizes network failures without printing provider errors or secrets', async () => {
    const fetcher=vi.fn(async()=>{throw new Error('private-token-and-signature');});
    const report=await runReleaseSmoke(parseOptions(['--allow-deployed','--base-url','https://stg-ai.zkproofport.app']),{fetcher});
    expect(report.success).toBe(false);expect(report.failure.step).toBe('service-health');
    expect(JSON.stringify(report)).not.toContain('private-token');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('stops on a version mismatch before creating an approval session',async()=>{
    const fetcher=vi.fn(async()=>new Response(JSON.stringify({service:'proofport-ai',status:'healthy',version:'wrong'}),{status:200}));
    const report=await runReleaseSmoke(parseOptions(['--allow-deployed','--base-url','https://ai.zkproofport.app','--expected-version','expected']),{fetcher});
    expect(report.success).toBe(false);expect(report.failure.code).toBe('version_mismatch');expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('detects leaked capability fields in HTTP status and emits only a sanitized failure',async()=>{
    const id='ab'.repeat(16), browserToken='12'.repeat(32), requesterToken='34'.repeat(32);
    const headers={'cache-control':'no-store','referrer-policy':'no-referrer','content-security-policy':"script-src 'self'"};
    let createdBody:any;
    const fetcher=vi.fn(async(url:string,options:any)=>{
      const path=new URL(url).pathname;
      const response=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers});
      if(path==='/health') return response({service:'proofport-ai',status:'healthy',version:'1.0.0'});
      if(path.startsWith('/approve/')) return new Response('<script src="/approval/assets/index-test.js"></script><link href="/approval/assets/index-test.css">',{status:200,headers});
      if(path.startsWith('/approval/assets/')) return new Response('fixture',{status:200});
      if(path.endsWith('/config')) return response({});
      if(options.headers.Origin) return response({},403);
      if(path==='/api/v1/action-approvals') {createdBody=JSON.parse(options.body);return response({approvalId:id,approvalUrl:`https://ai.zkproofport.app/approve/${id}#${browserToken}`,requesterToken,status:'pending',expiresAt:new Date(Date.now()+600000).toISOString()},201);}
      if(path.endsWith('/reject')) return response({status:'rejected'});
      if(options.headers.Authorization!==`Bearer ${browserToken}`) return response({},401);
      return response({...createdBody,approvalId:id,status:'pending',requesterToken});
    });
    const report=await runReleaseSmoke(parseOptions(['--allow-deployed','--base-url','https://ai.zkproofport.app']),{fetcher});
    expect(report.success).toBe(false);expect(report.failure.code).toBe('private_field_in_public_state');
    expect(JSON.stringify(report)).not.toContain(browserToken);expect(JSON.stringify(report)).not.toContain(requesterToken);
    expect(fetcher.mock.calls.every(([url])=>!url.includes('#')&&!url.includes(browserToken)&&!url.includes(requesterToken))).toBe(true);
  });
});
