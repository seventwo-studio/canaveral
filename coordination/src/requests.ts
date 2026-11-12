import { DatabaseSync } from "node:sqlite";
import { ConsumerIdentities, identifier } from "./consumers.ts";
import { object, ServiceError } from "./errors.ts";
import type { SqliteStore } from "./sqlite.ts";

export type RequestKind = "lease" | "linux-lease";
export type RequestState = "waiting" | "admitted" | "cancelled" | "expired" | "rejected";
interface Row { application: string; id: string; kind: RequestKind; intent: string; resources: string; priority: number; deadline: number | null; source: string | null; state: RequestState; sequence: number; created: number; admitted_at: number | null; target: string | null; reason: string | null }
export interface RequestView { id: string; kind: RequestKind; intent: Record<string, unknown>; resources: unknown; priority: number; deadline: string | null; source: Record<string, unknown> | null; state: RequestState; sequence: number; createdAt: string; admittedAt: string | null; target: string | null; reason: string | null }
const utc = (n: number) => new Date(n * 1000).toISOString();
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k,v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value);
}
function view(row: Row): RequestView {
  return { id: row.id, kind: row.kind, intent: JSON.parse(row.intent), resources: JSON.parse(row.resources), priority: row.priority,
    deadline: row.deadline === null ? null : utc(row.deadline), source: row.source === null ? null : JSON.parse(row.source), state: row.state,
    sequence: row.sequence, createdAt: utc(row.created), admittedAt: row.admitted_at === null ? null : utc(row.admitted_at), target: row.target, reason: row.reason };
}
/** Owned only by the control worker. Each acquisition is a nested savepoint in one bounded write pass. */
export class Requests {
  constructor(readonly store: SqliteStore, readonly applications: ConsumerIdentities,
    readonly acquire: (kind: RequestKind, application: string, intent: Record<string, unknown>) => void,
    readonly release: (db: DatabaseSync, row: { kind: RequestKind; id: string }, token: string) => void) {
    store.transaction(db => db.exec(`CREATE TABLE IF NOT EXISTS requests (
      application TEXT NOT NULL,id TEXT NOT NULL,kind TEXT NOT NULL,intent TEXT NOT NULL,resources TEXT NOT NULL,priority INTEGER NOT NULL,
      deadline REAL,source TEXT,state TEXT NOT NULL,sequence INTEGER NOT NULL,created REAL NOT NULL,admitted_at REAL,target TEXT,reason TEXT,PRIMARY KEY(application,id));
      CREATE INDEX IF NOT EXISTS requests_waiting ON requests(application,priority DESC,sequence) WHERE state='waiting';
      CREATE INDEX IF NOT EXISTS requests_deadline ON requests(deadline) WHERE state='waiting';
      CREATE TABLE IF NOT EXISTS request_scheduler (id INTEGER PRIMARY KEY CHECK(id=1),turn TEXT NOT NULL,sequence INTEGER NOT NULL);
      INSERT OR IGNORE INTO request_scheduler VALUES(1,'',0);
      CREATE TABLE IF NOT EXISTS request_scan (sequence INTEGER PRIMARY KEY);`));
  }
  submit(token: string, value: unknown): { created: boolean; request: RequestView } {
    const input = object(value);
    if (Object.keys(input).some(k => !["id","kind","intent","priority","deadline","source"].includes(k))) throw new ServiceError("Unknown request field.",400);
    const id = identifier(input.id);
    if (input.kind !== "lease" && input.kind !== "linux-lease") throw new ServiceError("Use kind lease or linux-lease; model jobs use /v1/model-jobs.",400,{code:"request_kind_unsupported"});
    const kind = input.kind, intent: Record<string, unknown> = { ...object(input.intent), id };
    if (Object.hasOwn(input.intent as object,"id")) throw new ServiceError("Put the UUID on the request envelope, not in intent.",400);
    // Normalize defaults without freezing capacity, credentials or a placement.
    return this.store.transaction(db => {
      const app = this.applications.verify(db,token);
      const normalized: Record<string, unknown> = { ...intent, ttlSeconds: intent.ttlSeconds === undefined ? app.limits.defaultTTLSeconds : intent.ttlSeconds, requiredCapabilities: intent.requiredCapabilities === undefined ? [] : intent.requiredCapabilities, resources: intent.resources === undefined ? {} : intent.resources };
      if (kind === "lease") normalized.name = intent.name === undefined ? `lease-${id}` : intent.name;
      if (Array.isArray(normalized.requiredCapabilities)) normalized.requiredCapabilities = [...normalized.requiredCapabilities].sort();
      const priority = input.priority === undefined ? 0 : input.priority;
      if (typeof priority !== "number" || !Number.isSafeInteger(priority) || priority < -1000000 || priority > (app.limits.maxRequestPriority ?? 0)) throw new ServiceError("Priority exceeds application maximum or is not a bounded integer.",400,{code:"request_priority_invalid"});
      let deadline: number | null = null;
      if (input.deadline !== undefined) {
        if (typeof input.deadline !== "string" || !/^\d{4}-\d\d-\d\dT.*Z$/.test(input.deadline) || !Number.isFinite(Date.parse(input.deadline))) throw new ServiceError("deadline must be UTC RFC3339.",400);
        deadline = Date.parse(input.deadline)/1000;
      }
      let source: string | null = null;
      if (input.source !== undefined) {
        source = canonical(object(input.source));
        if (Buffer.byteLength(source) > 4096) throw new ServiceError("source must fit 4096 bytes.",400);
      }
      const frozen = canonical(normalized), resources = canonical(normalized.resources ?? {});
      const old = db.prepare("SELECT * FROM requests WHERE application=? AND id=?").get(app.id,id) as unknown as Row | undefined;
      if (old) {
        if (old.kind !== kind || old.intent !== frozen || old.priority !== priority || old.deadline !== deadline || old.source !== source) throw new ServiceError("Request UUID already has a different intent.",409,{code:"request_conflict"});
        return { created:false,request:view(old) };
      }
      if (db.prepare("SELECT 1 FROM requests WHERE id=?").get(id)) throw new ServiceError("Unknown request.",404);
      const count = Number(db.prepare("SELECT COUNT(*) AS n FROM requests WHERE application=? AND state='waiting'").get(app.id)!.n);
      if (count >= (app.limits.maxWaitingRequests ?? 100)) throw new ServiceError("Waiting request limit reached; cancel waiting requests or wait for admission before submitting more.",429,{code:"request_waiting_limit",retryable:true});
      db.prepare("UPDATE request_scheduler SET sequence=sequence+1 WHERE id=1").run();
      db.prepare("INSERT INTO requests VALUES(?,?,?,?,?,?,?,?, 'waiting', (SELECT sequence FROM request_scheduler WHERE id=1),?,NULL,NULL,NULL)").run(app.id,id,kind,frozen,resources,priority,deadline,source,this.store.clock());
      return { created:true,request:view(this.row(db,app.id,id)) };
    });
  }
  private row(db: DatabaseSync, application: string, id: string): Row {
    const row = db.prepare("SELECT * FROM requests WHERE application=? AND id=?").get(application,identifier(id)) as unknown as Row | undefined;
    if (!row) throw new ServiceError("Unknown request.",404);
    return row;
  }
  inspect(token: string,id: string): RequestView { return this.store.transaction(db => view(this.row(db,this.applications.verify(db,token).id,id))); }
  list(token: string, after?: string): { requests: RequestView[]; nextCursor: string | null } {
    return this.store.transaction(db => {
      const app = this.applications.verify(db,token);
      const rows = db.prepare("SELECT * FROM requests WHERE application=? AND id>? ORDER BY id LIMIT 101").all(app.id,after === undefined ? "" : identifier(after)) as unknown as Row[];
      return { requests:rows.slice(0,100).map(view),nextCursor:rows.length>100 ? rows[99]!.id : null };
    });
  }
  cancel(token: string,id: string,value: unknown): RequestView {
    if (Object.keys(object(value)).length) throw new ServiceError("Cancellation expects {}.",400);
    return this.store.transaction(db => {
      const row = this.row(db,this.applications.verify(db,token).id,id);
      if (row.state === "waiting") {
        const expired = row.deadline !== null && this.store.clock() >= row.deadline;
        db.prepare("UPDATE requests SET state=?,reason=? WHERE application=? AND id=?").run(expired ? "expired" : "cancelled",expired ? "deadline" : "consumer_cancelled",row.application,row.id);
      }
      else if (row.state === "admitted") this.release(db,row,token);
      return view(this.row(db,row.application,row.id));
    });
  }
  pass(): void {
    // Empty queues need no write boundary or lifecycle refresh. This is only a hint;
    // all expiry, authorization and admission decisions remain inside the transaction.
    const probe = new DatabaseSync(this.store.path, { readOnly: true, timeout: 15000 });
    let waiting: boolean;
    try { waiting = !!probe.prepare("SELECT 1 FROM requests WHERE state='waiting' LIMIT 1").get(); }
    finally { probe.close(); }
    if (!waiting) return;
    this.store.transaction(db => {
      const now = this.store.clock();
      db.prepare("UPDATE requests SET state='cancelled',reason='application_revoked' WHERE state='waiting' AND application NOT IN (SELECT id FROM consumers WHERE revoked=0)").run();
      db.prepare("UPDATE requests SET state='expired',reason='deadline' WHERE state='waiting' AND deadline<=?").run(now);
      let turn = String(db.prepare("SELECT turn FROM request_scheduler WHERE id=1").get()!.turn);

      // At most 256 savepoint-isolated attempts; failed fits do not occupy an application turn twice in a round.
      for (let i=0;i<256;i++) {
        const row = db.prepare(`SELECT * FROM requests WHERE state='waiting' AND sequence NOT IN (SELECT sequence FROM request_scan)
          ORDER BY application> ? DESC,application,priority DESC,sequence LIMIT 1`).get(turn) as unknown as Row | undefined;
        if (!row) { db.exec("DELETE FROM request_scan"); break; }
        db.prepare("INSERT OR IGNORE INTO request_scan VALUES(?)").run(row.sequence);
        turn = row.application;
        db.prepare("UPDATE request_scheduler SET turn=? WHERE id=1").run(turn);
        try {
          this.store.transaction(() => this.acquire(row.kind,row.application,JSON.parse(row.intent)));
          db.prepare("UPDATE requests SET state='admitted',admitted_at=?,target=?,reason=NULL WHERE application=? AND id=?").run(now,row.id,row.application,row.id);
        } catch (error) {
          if (!(error instanceof ServiceError)) throw error;
          const temporary = error.status === 429 || error.status === 503;
          db.prepare("UPDATE requests SET state=?,reason=? WHERE application=? AND id=?").run(temporary ? "waiting" : "rejected",error.code,row.application,row.id);
        }
      }
    });
  }
}
