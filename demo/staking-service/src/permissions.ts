import {randomUUID} from 'node:crypto';
export type PermissionKind='proof'|'stake';
export interface Permission {id:string;kind:PermissionKind;status:'pending'|'approved'|'rejected'|'expired';requestedAt:string;expiresAt:string;decidedAt:string|null;details:Record<string,unknown>}
/** Agent requests are immutable; only the separate browser decision route may approve. */
export class PermissionLedger {
 private rows:Permission[]=[];
 request(kind:PermissionKind,details:Record<string,unknown>){
  const existing=this.rows.find(row=>row.kind===kind);
  if(existing){if(JSON.stringify(existing.details)!==JSON.stringify(details))throw Error('Permission details changed; submit a new user instruction.');return this.get(existing.id);}
  const now=Date.now();const row:Permission={id:randomUUID(),kind,status:'pending',requestedAt:new Date(now).toISOString(),expiresAt:new Date(now+300000).toISOString(),decidedAt:null,details:structuredClone(details)};
  this.rows.push(row);return structuredClone(row);
 }
 get(id:string){const row=this.rows.find(row=>row.id===id);if(!row)throw Error('Unknown permission request.');
  if(row.status==='pending'&&Date.now()>=Date.parse(row.expiresAt)){row.status='expired';row.decidedAt=new Date().toISOString();}
  return structuredClone(row);
 }
 decide(id:string,decision:'approve'|'reject'){
  if(this.get(id).status!=='pending')throw Error('This permission request is no longer pending.');
  const row=this.rows.find(row=>row.id===id)!;row.status=decision==='approve'?'approved':'rejected';row.decidedAt=new Date().toISOString();return structuredClone(row);
 }
 snapshot(){return this.rows.map(row=>this.get(row.id));}
 close(){for(const row of this.rows)if(row.status==='pending'){row.status='rejected';row.decidedAt=new Date().toISOString();}}
}
