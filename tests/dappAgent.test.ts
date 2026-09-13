import {describe,it,expect} from 'vitest';
import {createRedactor} from '../demo/user-agent/src/privacy.ts';
import {ActionGuard} from '../demo/user-agent/src/actionGuard.ts';
import {Wallet} from 'ethers';
describe('dApp agent authority boundaries',()=>{
 it('rejects spending before verified discovery, guide, delegation and proof',()=>{const g=new ActionGuard('0.1');expect(()=>g.proof()).toThrow();expect(()=>g.stake('0.1')).toThrow();});
 it('binds the approved amount and refuses repeated payment or stake',()=>{const g=new ActionGuard('0.1');g.discovered=true;g.guideRead=true;g.mcpConnected=true;g.delegated=true;g.proof();expect(()=>g.proof()).toThrow();g.verified=true;expect(()=>g.stake('1')).toThrow();g.stake('0.1');expect(()=>g.stake('0.1')).toThrow();});
 it('masks configured secrets and the credential address, including case variants',()=>{const r=createRedactor({TOKEN:'private-token-123',E2E_ATTESTATION_WALLET_ADDRESS:'0x'+'a'.repeat(40)});expect(r('private-token-123 0x'+'A'.repeat(40))).toBe('**** ****');expect(r('public tool result')).toBe('public tool result');});
});

describe('dApp model and UI privacy',()=>{
 it('masks raw and JSON-escaped secrets without corrupting tool-result JSON',()=>{
  const secret='synthetic-"quoted"-secret\\path\nnext-line\tend';
  const redact=createRedactor({TEST_SECRET:secret});
  expect(redact(`error: ${secret}`)).toBe('error: ****');
  const result=redact(JSON.stringify({ok:false,error:`Upstream rejected ${secret}`,publicValue:'Arc Testnet'}));
  expect(JSON.parse(result)).toEqual({ok:false,error:'Upstream rejected ****',publicValue:'Arc Testnet'});
 });
 it('treats secret regex characters literally and replaces repeated occurrences',()=>{
  const secret='test-secret.*+[wallet](key)?$';
  const redact=createRedactor({API_TOKEN:secret});
  expect(redact(`${secret} / ${secret}`)).toBe('**** / ****');
  expect(redact('test-secret is public context')).toBe('test-secret is public context');
 });
 it('masks the configured private key and derived credential address in every case',()=>{
  const key='0x'+'12'.repeat(32);
  const address=new Wallet(key).address;
  const redact=createRedactor({ATTESTATION_KEY:key});
  const result=redact(JSON.stringify({key,address,lower:address.toLowerCase(),upper:address.toUpperCase()}));
  expect(JSON.parse(result)).toEqual({key:'****',address:'****',lower:'****',upper:'****'});
 });
});
