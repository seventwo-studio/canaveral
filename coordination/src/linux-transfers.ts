import { createHash, type Hash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { operationObject as exact } from "./linux-operations.ts";
import { ServiceError } from "./errors.ts";

const terminal = new Set(['committed', 'verified', 'aborted', 'failed', 'unknown']);
export const TRANSFER_SPOOL_LIMIT = 67108864;
export function transferError(code: string, status = 400): never { throw new ServiceError(code, status, { code, retryable: status === 503 }); }
export function transferUUID(v: unknown): string {
  if (typeof v !== 'string' || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(v) || v === '00000000-0000-0000-0000-000000000000') transferError('invalid_request');
  return v;
}
function integer(v: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min || v > max) transferError('invalid_cursor');
  return v;
}
export function transferPath(v: unknown): string {
  if (typeof v !== 'string' || !v || Buffer.byteLength(v) > 4096 || /[\0\\]/.test(v) || v.split('/').some(c => !c || c === '.' || c === '..') || v.split('/')[0] === '.canaveral' || Buffer.from(v).toString() !== v) transferError('invalid_path');
  return v;
}
function digest(v: unknown): string { if (typeof v !== 'string' || !/^[0-9a-f]{64}$/.test(v)) transferError('invalid_request'); return v; }
function data(v: unknown, empty = false): Buffer {
  if (typeof v !== 'string' || Buffer.from(v, 'base64').toString('base64') !== v) transferError('invalid_request');
  const b = Buffer.from(v, 'base64');
  if (b.length > 65536) transferError('chunk_too_large', 413);
  if (!empty && !b.length) transferError('invalid_request');
  return b;
}
function canonical(v: unknown): string {
  if (v && typeof v === 'object' && !Array.isArray(v)) return JSON.stringify(Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,x])=>[k,JSON.parse(canonical(x))])));
  return JSON.stringify(v);
}
function hash(v: string): string { return createHash('sha256').update(v).digest('hex'); }
const utc = (n: number) => new Date(n * 1000).toISOString();
export interface TransferOwner { id: string; lease: string; member: string; credential: string; bytes: number }
interface TransferRow { id: string; lease: string; assignment: string; member: string; credential: string; intent: string; direction: string; state: string; offset: number; bytes: number | null; sha256: string | null; durable: number; updated: number; error: string | null }
interface StepRow { id: string; step: number; digest: string; request: string | null; state: string; receipt: string | null; runner_receipt: string | null; updated: number; start_before: number; deadline: number | null; dispatched: number | null; spool: number; evicted: number }
/** Durable metadata; only one transient chunk is retained for each assignment. */
export class LinuxTransfers {
  private hashes = new Map<string, Hash>();
  constructor(db: DatabaseSync, now: number) {
    db.exec(`CREATE TABLE IF NOT EXISTS linux_transfers (
      id TEXT PRIMARY KEY, lease TEXT NOT NULL REFERENCES linux_leases(id), assignment TEXT NOT NULL REFERENCES linux_lease_assignments(id),
      member TEXT NOT NULL, credential TEXT NOT NULL, intent TEXT NOT NULL, direction TEXT NOT NULL, state TEXT NOT NULL,
      offset INTEGER NOT NULL, bytes INTEGER, sha256 TEXT, durable INTEGER NOT NULL, updated REAL NOT NULL, error TEXT);
      CREATE TABLE IF NOT EXISTS linux_transfer_steps (
      id TEXT NOT NULL REFERENCES linux_transfers(id), step INTEGER NOT NULL, digest TEXT NOT NULL, request TEXT, state TEXT NOT NULL,
      receipt TEXT, runner_receipt TEXT, updated REAL NOT NULL, start_before REAL NOT NULL, deadline REAL, dispatched REAL,
      spool INTEGER NOT NULL DEFAULT 0, evicted INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(id,step));
      CREATE TABLE IF NOT EXISTS linux_transfer_polls (id TEXT PRIMARY KEY, assignment TEXT NOT NULL, boot TEXT NOT NULL, digest TEXT NOT NULL, transfer TEXT NOT NULL, step INTEGER NOT NULL);`);
    for (const t of db.prepare("SELECT * FROM linux_transfers WHERE state IN ('created','writing','reading')").all() as unknown as TransferRow[]) {
      const pending = this.pending(db, t.id);
      this.fail(db, t, pending, 'controller_restarted', now);
    }
  }
  checkpoint(): Map<string, Hash> { return new Map([...this.hashes].map(([id,h])=>[id,h.copy()])); }
  restore(snapshot: Map<string, Hash>): void { this.hashes=snapshot; }
  row(db: DatabaseSync, id: string): TransferRow | undefined { return db.prepare('SELECT * FROM linux_transfers WHERE id=?').get(id) as unknown as TransferRow | undefined; }
  step(db: DatabaseSync, id: string, step: number): StepRow | undefined { return db.prepare('SELECT * FROM linux_transfer_steps WHERE id=? AND step=?').get(id, step) as unknown as StepRow | undefined; }
  pending(db: DatabaseSync, id: string): StepRow | undefined { return db.prepare("SELECT * FROM linux_transfer_steps WHERE id=? AND state IN ('queued','dispatched')").get(id) as unknown as StepRow | undefined; }
  view(t: TransferRow): unknown { return { id: t.id, leaseId: t.lease, member: 'primary', direction: t.direction, state: t.state, offset: t.offset, bytes: t.bytes, sha256: t.sha256, durable: !!t.durable, updatedAt: utc(t.updated), error: t.error ? JSON.parse(t.error) : null }; }
  stepView(s: StepRow): unknown {
    if (s.evicted) transferError('chunk_evicted', 410);
    return { id: s.id, step: s.step, state: s.state, receipt: s.receipt ? JSON.parse(s.receipt) : null, updatedAt: utc(s.updated) };
  }
  owned(db: DatabaseSync, lease: string, id: string): TransferRow { const t = this.row(db, transferUUID(id)); if (!t || t.lease !== lease) transferError('not_found', 404); return t; }
  create(db: DatabaseSync, owner: TransferOwner, value: unknown, now: number): unknown {
    const raw = exact(value, ['id', 'member', 'direction', 'path'], ['bytes', 'sha256', 'replace']);
    const id = transferUUID(raw.id), path = transferPath(raw.path);
    if (raw.member !== 'primary' || !['upload', 'download'].includes(raw.direction as string)) transferError('invalid_request');
    const upload = raw.direction === 'upload';
    exact(value, upload ? ['id','member','direction','path','bytes','sha256','replace'] : ['id','member','direction','path']);
    const bytes = upload ? integer(raw.bytes, 0, owner.bytes) : null, sha256 = upload ? digest(raw.sha256) : null;
    if (upload && typeof raw.replace !== 'boolean') transferError('invalid_request');
    const intent = JSON.stringify({ id, member: 'primary', direction: raw.direction, path, ...(upload ? { bytes, sha256, replace: raw.replace } : {}) });
    const old = this.row(db, id);
    if (old) { if (old.lease !== owner.lease) transferError('not_found',404); if (old.intent !== intent) transferError('idempotency_conflict',409); return { created:false, transfer:this.view(old) }; }
    if (db.prepare("SELECT 1 FROM linux_transfers WHERE assignment=? AND state IN ('created','writing','reading','unknown')").get(owner.id)) transferError('transfer_busy',429);
    db.prepare("INSERT INTO linux_transfers VALUES (?,?,?,?,?,?,?,'created',0,?,?,0,?,NULL)").run(id,owner.lease,owner.id,owner.member,owner.credential,intent,raw.direction as string,bytes,sha256,now);
    this.hashes.set(id, createHash('sha256'));
    return { created:true, transfer:this.view(this.row(db,id)!) };
  }
  submit(db: DatabaseSync, t: TransferRow, value: unknown, now: number, expires: number): unknown {
    const r = exact(value,['step','request']), n = integer(r.step,1), q = exact(r.request,['action'],['path','bytes','sha256','replace','offset','data','maxBytes']);
    let normalized: Record<string,unknown>; let spool = 0;
    const intent = JSON.parse(t.intent) as Record<string,unknown>;
    switch(q.action) {
      case 'beginUpload': exact(q,['action','path','bytes','sha256','replace']); normalized={action:q.action,path:transferPath(q.path),bytes:integer(q.bytes),sha256:digest(q.sha256),replace:q.replace}; break;
      case 'beginDownload': exact(q,['action','path']); normalized={action:q.action,path:transferPath(q.path)}; break;
      case 'write': exact(q,['action','offset','data']); spool=data(q.data).length; normalized={action:q.action,offset:integer(q.offset),data:q.data}; break;
      case 'read': exact(q,['action','offset','maxBytes']); normalized={action:q.action,offset:integer(q.offset),maxBytes:integer(q.maxBytes,1,65536)}; break;
      case 'finish': exact(q,['action','bytes','sha256']); normalized={action:q.action,bytes:integer(q.bytes),sha256:digest(q.sha256)}; break;
      case 'abort': exact(q,['action']); normalized={action:q.action}; break;
      default: transferError('invalid_request');
    }
    const request=JSON.stringify(normalized), fingerprint=hash(request), old=this.step(db,t.id,n);
    if(old) { if(old.digest!==fingerprint) transferError('idempotency_conflict',409); return {completed:!['queued','dispatched'].includes(old.state),step:this.stepView(old)}; }
    if(terminal.has(t.state)) transferError('lease_ended',410);
    if(this.pending(db,t.id)) transferError('step_pending',409);
    const latest=db.prepare('SELECT max(step) AS n FROM linux_transfer_steps WHERE id=?').get(t.id) as {n:number|null};
    if(n!==(latest.n??0)+1) transferError('invalid_cursor');
    if(q.action!=='abort') {
      if(t.state==='created') {
        const expected=t.direction==='upload' ? {action:'beginUpload',path:intent.path,bytes:t.bytes,sha256:t.sha256,replace:intent.replace} : {action:'beginDownload',path:intent.path};
        if(request!==JSON.stringify(expected)) transferError('invalid_request');
      } else if(q.action==='write') { if(t.direction!=='upload' || q.offset!==t.offset || t.offset+spool>t.bytes!) transferError('invalid_cursor'); }
      else if(q.action==='read') { if(t.direction!=='download' || q.offset!==t.offset) transferError('invalid_cursor'); }
      else if(q.action==='finish') {
        if(q.bytes!==t.offset || q.bytes!==t.bytes) transferError('invalid_cursor');
        if(q.sha256!==this.hashes.get(t.id)?.copy().digest('hex') || (t.direction==='upload' && q.sha256!==t.sha256)) transferError('digest_mismatch');
      } else transferError('invalid_request');
    }
    // Reserve the maximum possible read reply before any handoff.
    if(q.action==='read') spool=q.maxBytes as number;
    const used=db.prepare('SELECT coalesce(sum(spool),0) AS n FROM linux_transfer_steps').get() as {n:number};
    const held=db.prepare('SELECT coalesce(sum(spool),0) AS n FROM linux_transfer_steps WHERE id=?').get(t.id) as {n:number};
    if(used.n-held.n+spool>TRANSFER_SPOOL_LIMIT) transferError('transfer_backpressure',503);
    this.evict(db,t.id);
    db.prepare("INSERT INTO linux_transfer_steps (id,step,digest,request,state,updated,start_before,spool) VALUES (?,?,?,?,'queued',?,?,?)").run(t.id,n,fingerprint,request,now,Math.min(now+120,expires),spool);
    if(q.action==='abort' && t.state==='created') this.accept(db,t,this.step(db,t.id,n)!,{state:'aborted'},now,false);
    const step=this.step(db,t.id,n)!;
    return {completed:step.state==='succeeded',step:this.stepView(step)};
  }
  private evict(db: DatabaseSync,id:string): void {
    for(const s of db.prepare('SELECT * FROM linux_transfer_steps WHERE id=? AND spool>0').all(id) as unknown as StepRow[]) {
      const r=s.receipt ? JSON.parse(s.receipt) as Record<string,unknown> : null;
      const evicted=!!r && Object.hasOwn(r,'data');
      if(evicted) delete r!.data;
      db.prepare('UPDATE linux_transfer_steps SET spool=0,receipt=?,evicted=? WHERE id=? AND step=?').run(r?JSON.stringify(r):null,evicted?1:0,id,s.step);
    }
  }
  fail(db: DatabaseSync,t:TransferRow,s:StepRow|undefined,code:string,now:number):void {
    // An acknowledged begin still owns guest descriptors between steps.
    const opened=t.state==='writing'||t.state==='reading';
    const stepState=s?.dispatched===null || !s ? 'failed' : 'unknown';
    const state=opened ? 'unknown' : stepState;
    if(s) db.prepare('UPDATE linux_transfer_steps SET state=?,receipt=?,request=NULL,spool=0,updated=? WHERE id=? AND step=?').run(stepState,JSON.stringify({state:stepState,code}),now,t.id,s.step);
    this.evict(db,t.id);
    db.prepare('UPDATE linux_transfers SET state=?,error=?,updated=? WHERE id=?').run(state,JSON.stringify({code,outcome:state}),now,t.id);
    this.hashes.delete(t.id);
  }
  refresh(db:DatabaseSync,now:number,authority:(t:TransferRow)=>{eligible:boolean;expires:number;credential:string|null;reason?:string}):void {
    for(const t of db.prepare("SELECT * FROM linux_transfers WHERE state IN ('created','writing','reading')").all() as unknown as TransferRow[]) {
      const a=authority(t),s=this.pending(db,t.id);
      if(!a.eligible || a.credential!==t.credential) this.fail(db,t,s,a.reason??'authorization_lost',now);
      else if(s && now >= Math.min(a.expires,s.deadline??s.start_before)) this.fail(db,t,s,'deadline',now);
    }
  }
  poll(db:DatabaseSync,owner:TransferOwner,boot:string,bundle:string,poll:string,now:number,expires:number,eligible:boolean):unknown {
    const old=db.prepare('SELECT * FROM linux_transfer_polls WHERE id=?').get(transferUUID(poll)) as {assignment:string;boot:string;digest:string;transfer:string;step:number}|undefined;
    if(old && (old.assignment!==owner.id || old.boot!==boot || old.digest!==bundle)) transferError('idempotency_conflict',409);
    let t=old?this.row(db,old.transfer):undefined, s=old?this.step(db,old.transfer,old.step):undefined;
    if(!old && eligible) {
      t=db.prepare("SELECT t.* FROM linux_transfers t JOIN linux_transfer_steps s ON s.id=t.id WHERE t.assignment=? AND s.state='queued' AND s.dispatched IS NULL ORDER BY s.rowid LIMIT 1").get(owner.id) as unknown as TransferRow|undefined;
      if(t) { s=this.pending(db,t.id)!;
        db.prepare("UPDATE linux_transfer_steps SET state='dispatched',dispatched=?,deadline=?,updated=? WHERE id=? AND step=?").run(now,Math.min(now+120,expires),now,t.id,s.step);
        db.prepare('INSERT INTO linux_transfer_polls VALUES (?,?,?,?,?,?)').run(poll,owner.id,boot,bundle,t.id,s.step); s=this.step(db,t.id,s.step)!;
      }
    }
    return {transfer:t&&s?{id:t.id,leaseId:t.lease,memberId:t.member,assignmentId:owner.id,bootAttempt:boot,bundleDigest:bundle,step:s.step,request:s.request?JSON.parse(s.request):null,startBefore:s.start_before,deadlineAt:s.deadline,state:s.state==='dispatched'?'queued':s.state}:null,cancelRequested:!eligible||(t && s ? t.state==='unknown'||['failed','unknown'].includes(s.state) : !!db.prepare("SELECT 1 FROM linux_transfers WHERE assignment=? AND state='unknown'").get(owner.id))};
  }
  report(db:DatabaseSync,assignment:string,id:string,n:number,value:unknown,now:number):unknown {
    const t=this.row(db,transferUUID(id)),s=this.step(db,id,integer(n,1));
    if(!t || t.assignment!==assignment || !s) transferError('not_found',404);
    if(s.dispatched===null) transferError('invalid_request',409);
    if(!['queued','dispatched'].includes(s.state)) {
      if(s.runner_receipt && s.runner_receipt!==hash(canonical(value))) transferError('idempotency_conflict',409);
    } else this.accept(db,t,s,value,now,true);
    return {transferId:id,step:n,state:this.step(db,id,n)!.state};
  }
  private accept(db:DatabaseSync,t:TransferRow,s:StepRow,value:unknown,now:number,runner:boolean):void {
    const r=exact(value,['state'],['offset','bytes','sha256','durable','data','code']),q=JSON.parse(s.request!) as Record<string,unknown>;
    let offset=t.offset,bytes=t.bytes,sha=t.sha256,durable=0,spool=0;
    if(r.state==='failed'||r.state==='unknown') {
      exact(r,['state','code']);
      const codes=['not_found','path_denied','not_regular','hardlink_denied','destination_exists','disk_full','size_mismatch','digest_mismatch','source_changed','io_error','deadline','authorization_lost','controller_restarted','data_channel_lost','publication_unknown','transport_unknown'];
      if(!codes.includes(r.code as string)) transferError('invalid_request');
    } else switch(q.action) {
      case 'beginUpload': exact(r,['state','offset']); if(r.state!=='writing'||r.offset!==0) transferError('invalid_cursor'); break;
      case 'beginDownload': exact(r,['state','offset','bytes']); if(r.state!=='reading'||r.offset!==0) transferError('invalid_cursor'); bytes=integer(r.bytes);
        {const l=db.prepare('SELECT workspace FROM linux_leases WHERE id=?').get(t.lease) as {workspace:string};if(bytes>(JSON.parse(l.workspace) as {bytes:number}).bytes) transferError('invalid_request');} break;
      case 'write': exact(r,['state','offset']); offset=t.offset+data(q.data).length; if(r.state!=='writing'||r.offset!==offset) transferError('invalid_cursor'); this.hashes.get(t.id)!.update(data(q.data)); break;
      case 'read': { exact(r,['state','offset','data']); const b=data(r.data,true); offset=t.offset+b.length;
        if(r.state!=='reading'||r.offset!==offset||b.length>(q.maxBytes as number)||offset>bytes!||(!b.length&&offset!==bytes)) transferError('invalid_cursor');
        this.hashes.get(t.id)!.update(b); spool=b.length; break; }
      case 'finish': exact(r,t.direction==='upload'?['state','bytes','sha256','durable']:['state','bytes','sha256']);
        if(r.state!==(t.direction==='upload'?'committed':'verified')||r.bytes!==q.bytes||r.sha256!==q.sha256||(t.direction==='upload'&&r.durable!==true)) transferError('digest_mismatch');
        sha=digest(r.sha256); durable=t.direction==='upload'?1:0; break;
      case 'abort': exact(r,['state']); if(r.state!=='aborted') transferError('invalid_request'); break;
      default: transferError('invalid_request');
    }
    const failed=r.state==='failed'||r.state==='unknown';
    db.prepare('UPDATE linux_transfer_steps SET state=?,receipt=?,runner_receipt=?,request=NULL,spool=?,updated=? WHERE id=? AND step=?').run(failed?r.state as string:'succeeded',JSON.stringify(r),runner?hash(canonical(value)):null,spool,now,t.id,s.step);
    db.prepare('UPDATE linux_transfers SET state=?,offset=?,bytes=?,sha256=?,durable=?,updated=?,error=? WHERE id=?').run(r.state as string,offset,bytes,sha,durable,now,failed?JSON.stringify({code:r.code,outcome:r.state}):null,t.id);
    if(terminal.has(r.state as string)) { this.evict(db,t.id); this.hashes.delete(t.id); }
  }
}
