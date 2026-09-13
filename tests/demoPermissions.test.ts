import {describe,it,expect,vi} from 'vitest';
import {PermissionLedger} from '../demo/staking-service/src/permissions.ts';
describe('user decisions bound to the active agent request',()=>{
 it('starts pending and requires a matching explicit decision',()=>{
  const ledger=new PermissionLedger();const p=ledger.request('proof',{amount:'0.1',delegate:'B'});
  expect(p.status).toBe('pending');expect(()=>ledger.decide('unknown','approve')).toThrow();
  expect(ledger.decide(p.id,'approve').status).toBe('approved');
  expect(()=>ledger.decide(p.id,'reject')).toThrow();
  expect(()=>ledger.request('proof',{amount:'1',delegate:'B'})).toThrow();
 });
 it('keeps rejection final and closes pending requests when the agent exits',()=>{
  const ledger=new PermissionLedger();const p=ledger.request('proof',{});
  ledger.decide(p.id,'reject');expect(ledger.request('proof',{}).status).toBe('rejected');
  const s=ledger.request('stake',{});ledger.close();expect(ledger.get(s.id).status).toBe('rejected');
 });
 it('expires unanswered requests and protects records from caller mutation',()=>{
  vi.useFakeTimers();try{const ledger=new PermissionLedger();const p=ledger.request('proof',{amount:'0.1'});
  p.details.amount='999';expect(ledger.get(p.id).details.amount).toBe('0.1');
  vi.advanceTimersByTime(300001);expect(ledger.get(p.id).status).toBe('expired');
  expect(()=>ledger.decide(p.id,'approve')).toThrow();}finally{vi.useRealTimers();}
 });
});
