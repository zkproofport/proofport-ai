import {describe,it,expect} from 'vitest';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';

describe('private credential configuration stays out of the staking service',()=>{
 for(const variable of ['ATTESTATION_KEY','E2E_ATTESTATION_WALLET_ADDRESS'])
  it(`refuses startup with ${variable}, without printing its value`,async()=>{
   const fixture=variable==='ATTESTATION_KEY'?'0x'+'11'.repeat(32):'0x'+'22'.repeat(20);
   const child=spawn(process.execPath,['--import','tsx','demo/staking-service/src/server.ts'],{
    cwd:fileURLToPath(new URL('../',import.meta.url)),
    env:{PATH:process.env.PATH,HOME:process.env.HOME,PORT:'4199',[variable]:fixture},stdio:['ignore','pipe','pipe'],
   });
   let output='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);
   const timeout=setTimeout(()=>child.kill('SIGTERM'),2500);
   try{
    const [code]=await once(child,'close');
    expect(code).not.toBeNull();expect(code).not.toBe(0);
    expect(output).toContain('Private credential configuration must stay in the local prover client');
    expect(output).not.toContain(fixture);expect(output).not.toContain('Ledger House: http://');
   }finally{clearTimeout(timeout);if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');}
  });
});
