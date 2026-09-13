import {describe,it,expect} from 'vitest';
import {createRedactor} from '../demo/user-agent/src/privacy.ts';
import {ActionGuard} from '../demo/user-agent/src/actionGuard.ts';
import {Wallet} from 'ethers';
import {PermissionLedger} from '../demo/staking-service/src/permissions.ts';
const permissionDetails=()=>({amount:'0.1',chainId:5042002,gate:'0x'+'11'.repeat(20),delegate:'0x'+'22'.repeat(20),action:{domain:{chainId:5042002,verifyingContract:'0x'+'11'.repeat(20)},message:{expiresAt:Math.floor(Date.now()/1000)+3600,nonce:'test-nonce',amount:'100000'}}});
function approved(kind:'proof'|'stake',details:Record<string,unknown>){const ledger=new PermissionLedger();const p=ledger.request(kind,details);return ledger.decide(p.id,'approve');}
function prepared(){const g=new ActionGuard('0.1');g.discovered=true;g.guideRead=true;g.mcpConnected=true;g.delegated=true;g.verified=true;return g;}
describe('dApp agent authority boundaries',()=>{
 it('rejects spending before verified discovery, guide, delegation and proof',()=>{const g=new ActionGuard('0.1');expect(()=>g.proof()).toThrow();expect(()=>g.stake('0.1')).toThrow();});
 it('requires user approval even after all agent prerequisites succeed',()=>{const g=new ActionGuard('0.1');g.discovered=true;g.guideRead=true;g.mcpConnected=true;g.delegated=true;expect(()=>g.proof()).toThrow('user');g.verified=true;expect(()=>g.stake('0.1')).toThrow('user');});
 it('binds the approved amount and refuses repeated payment or stake',()=>{const g=prepared(),details=permissionDetails();g.approveProof(approved('proof',details),details);g.proof(details);expect(()=>g.proof(details)).toThrow();g.approveStake(approved('stake',details),details);expect(()=>g.stake('1',details)).toThrow();g.stake('0.1',details);expect(()=>g.stake('0.1',details)).toThrow();});
 it.each(['amount','chainId','gate','delegate','action'])('rejects a changed %s after approval',field=>{
  const details=permissionDetails();const changed={...details,[field]:field==='action'?{...details.action,message:{...details.action.message,expiresAt:details.action.message.expiresAt+1}}:'changed'};
  const g=prepared();g.approveProof(approved('proof',details),details);g.approveStake(approved('stake',details),details);
  expect(()=>g.proof(changed)).toThrow('approved');expect(()=>g.stake('0.1',changed)).toThrow('approved');
 });
 it('rejects pending, wrong-kind and expired delegation approvals',()=>{
  const details=permissionDetails(),g=prepared(),ledger=new PermissionLedger();
  expect(()=>g.approveProof(ledger.request('proof',details),details)).toThrow('user');
  expect(()=>g.approveProof(approved('stake',details),details)).toThrow('user');
  const expired={...details,action:{...details.action,message:{...details.action.message,expiresAt:1}}};
  expect(()=>g.approveProof(approved('proof',expired),expired)).toThrow('expired');
 });
 it('rechecks expiry at execution and keeps an immutable approval snapshot',()=>{
  const details=permissionDetails(),g=prepared(),p=approved('proof',details);g.approveProof(p,details);
  p.details.gate='changed';expect(()=>g.proof(details)).not.toThrow();
  const h=prepared();h.approveStake(approved('stake',details),details);
  const now=Date.now;Date.now=()=>Number(details.action.message.expiresAt)*1000;
  try{expect(()=>h.stake('0.1',details)).toThrow('expired');}finally{Date.now=now;}
 });
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
