import { DatabaseSync } from "node:sqlite";
import { ConsumerIdentities, identifier } from "./consumers.ts";
import { object, ServiceError } from "./errors.ts";
import type { SqliteStore } from "./sqlite.ts";
import { cancelModelJob, insertQueuedModelJob, modelGrantResources, modelJobSchema, modelRequestIntent, modelRequestRecord, settleModelRequests } from "./model-requests.ts";

/** `model-job` requests are admitted by a runner claim, not by the controller pass; see model-jobs.ts. */
export type RequestKind = "lease" | "linux-lease" | "model-job";
export type RequestState = "waiting" | "admitted" | "cancelled" | "expired" | "rejected";
interface Row { application: string; id: string; kind: RequestKind; intent: string; resources: string; priority: number; deadline: number | null; source: string | null; state: RequestState; sequence: number; created: number; admitted_at: number | null; target: string | null; reason: string | null }
export interface RequestView { id: string; kind: RequestKind; intent: Record<string, unknown>; resources: unknown; priority: number; deadline: string | null; source: Record<string, unknown> | null; state: RequestState; sequence: number; createdAt: string; admittedAt: string | null; target: string | null; reason: string | null }
const utc = (n: number) => new Date(n * 1000).toISOString();
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k,v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value);
}
function view(row: Row): RequestView {
  return { id: row.id, kind: row.kind, intent: JSON.parse(row.intent), resources: JSON.parse(row.resources), priority: row.priority,
    deadline: row.deadline === null ? null : utc(row.deadline), source: row.source === null ? null : JSON.parse(row.source), state: row.state,
    sequence: row.sequence, createdAt: utc(row.created), admittedAt: row.admitted_at === null ? null : utc(row.admitted_at), target: row.target, reason: row.reason };
}
export function requestSchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS requests (
    application TEXT NOT NULL,id TEXT NOT NULL,kind TEXT NOT NULL,intent TEXT NOT NULL,resources TEXT NOT NULL,priority INTEGER NOT NULL,
    deadline REAL,source TEXT,state TEXT NOT NULL,sequence INTEGER NOT NULL,created REAL NOT NULL,admitted_at REAL,target TEXT,reason TEXT,PRIMARY KEY(application,id));
    CREATE INDEX IF NOT EXISTS requests_waiting ON requests(application,priority DESC,sequence) WHERE state='waiting';
    CREATE INDEX IF NOT EXISTS requests_deadline ON requests(deadline) WHERE state='waiting';
    CREATE TABLE IF NOT EXISTS request_scheduler (id INTEGER PRIMARY KEY CHECK(id=1),turn TEXT NOT NULL,sequence INTEGER NOT NULL);
    INSERT OR IGNORE INTO request_scheduler VALUES(1,'',0);
    CREATE TABLE IF NOT EXISTS request_scan (sequence INTEGER PRIMARY KEY);
    DROP TABLE IF EXISTS request_pool_turns;
    DROP TABLE IF EXISTS request_unit_turns;
    CREATE TABLE IF NOT EXISTS request_admissions (application TEXT PRIMARY KEY,admitted INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS request_admissions_order ON request_admissions(admitted);`);
  // Interim builds of this change kept turns per image pin (request_pool_turns) and per capacity unit
  // (request_unit_turns). Admission order is disposable state, so they are dropped rather than converted.
}
/** Requests of one application with the same normalized intent apart from UUID and name have the same fit. */
const GROUP = "application||char(31)||kind||char(31)||json_remove(intent,'$.id','$.name')";
/** Refused attempts one application may use in a single admission pass before its remaining candidates wait for the next cycle. */
const REFUSALS_PER_APPLICATION_PASS = 16;

/** Lease kinds are admitted only by the control worker; each acquisition is a nested savepoint in one
 * bounded write pass. Model-job requests share this table, envelope, replay, waiting cap and cancellation,
 * but a runner claim admits them (ModelJobs.claim) because only a claim binds a physical domain.
 */
export class Requests {
  constructor(readonly store: SqliteStore, readonly applications: ConsumerIdentities,
    /** Must decide a 429 or 503 refusal from the intent apart from its UUID and name, and from application and
     * capacity state, never from the request UUID: the pass skips a refused request's whole group on that basis. */
    readonly acquire: (kind: RequestKind, application: string, intent: Record<string, unknown>) => void,
    readonly release: (db: DatabaseSync, row: { kind: RequestKind; id: string }, token: string) => void,
    /** Pure shape check shared with direct acquisition, so malformed intent is refused before it consumes a UUID. */
    readonly validate: (kind: RequestKind, intent: Record<string, unknown>) => void = () => {}) {
    // Model calls insert their job with the request, so the model tables exist before the first submission.
    store.transaction(db => { requestSchema(db); modelJobSchema(db); });
  }
  submit(token: string, value: unknown): { created: boolean; request: RequestView } {
    const input = object(value);
    if (Object.keys(input).some(k => !["id","kind","intent","priority","deadline","source"].includes(k))) throw new ServiceError("Unknown request field.",400);
    const id = identifier(input.id);
    if (input.kind !== "lease" && input.kind !== "linux-lease" && input.kind !== "model-job") throw new ServiceError("Use kind lease, linux-lease or model-job.",400,{code:"request_kind_unsupported"});
    const kind = input.kind, model = kind === "model-job";
    if (Object.hasOwn(object(input.intent),"id")) throw new ServiceError("Put the UUID on the request envelope, not in intent.",400);
    const intent: Record<string, unknown> = model ? modelRequestIntent(input.intent) : { ...object(input.intent), id };
    if (!model) this.validate(kind, intent);
    // Normalize defaults without freezing capacity, credentials or a placement.
    return this.store.transaction(db => {
      const app = this.applications.verify(db,token);
      const normalized: Record<string, unknown> = model ? modelRequestRecord(intent) : { ...intent, ttlSeconds: intent.ttlSeconds === undefined ? app.limits.defaultTTLSeconds : intent.ttlSeconds, requiredCapabilities: intent.requiredCapabilities === undefined ? [] : intent.requiredCapabilities, resources: intent.resources === undefined ? {} : intent.resources };
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
      const frozen = canonical(normalized);
      const old = db.prepare("SELECT * FROM requests WHERE application=? AND id=?").get(app.id,id) as unknown as Row | undefined;
      if (old) {
        if (old.kind !== kind || old.intent !== frozen || old.priority !== priority || old.deadline !== deadline || old.source !== source) throw new ServiceError("Request UUID already has a different intent.",409,{code:"request_conflict"});
        return { created:false,request:view(old) };
      }
      if (db.prepare("SELECT 1 FROM requests WHERE id=?").get(id)) throw new ServiceError("Unknown request.",404);
      // A direct /v1/model-jobs submission already owns this UUID; it never becomes queued intent.
      if (model && db.prepare("SELECT 1 FROM model_jobs WHERE application=? AND id=?").get(app.id,id)) throw new ServiceError("Request UUID already has a different intent.",409,{code:"request_conflict"});
      const resources = model ? canonical(modelGrantResources(db,app.id,String(intent.model),String(intent.digest),intent.adapter)) : canonical(normalized.resources ?? {});
      const count = Number(db.prepare("SELECT COUNT(*) AS n FROM requests WHERE application=? AND state='waiting' AND (deadline IS NULL OR deadline>?)").get(app.id,this.store.clock())!.n);
      if (count >= (app.limits.maxWaitingRequests ?? 100)) throw new ServiceError("Waiting request limit reached; cancel waiting requests or wait for admission before submitting more.",429,{code:"request_waiting_limit",retryable:true});
      db.prepare("UPDATE request_scheduler SET sequence=sequence+1 WHERE id=1").run();
      db.prepare("INSERT INTO requests VALUES(?,?,?,?,?,?,?,?, 'waiting', (SELECT sequence FROM request_scheduler WHERE id=1),?,NULL,NULL,NULL)").run(app.id,id,kind,frozen,resources,priority,deadline,source,this.store.clock());
      if (model) insertQueuedModelJob(db,app.id,id,intent,this.store.clock());
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
      // Model calls cancel through the job: waiting intent closes unexecuted, admitted work needs a runner receipt.
      if (row.kind === "model-job" && (row.state === "waiting" || row.state === "admitted")) cancelModelJob(db,row.application,row.id,this.store.clock());
      else if (row.state === "waiting") {
        const expired = row.deadline !== null && this.store.clock() >= row.deadline;
        db.prepare("UPDATE requests SET state=?,reason=? WHERE application=? AND id=?").run(expired ? "expired" : "cancelled",expired ? "deadline" : "consumer_cancelled",row.application,row.id);
      }
      else if (row.state === "admitted") this.release(db,row,token);
      return view(this.row(db,row.application,row.id));
    });
  }
  /** Rejects an invalid application credential before any admission work is done on its behalf. */
  authenticate(token: string): void { this.store.transaction(db => { this.applications.verify(db,token); }); }
  /** Timer and post-request entry: a busy database or unexpected failure must not take the worker or a committed reply down. */
  wake(): boolean {
    try { this.pass(); return true; }
    catch { return false; }
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
      db.prepare("UPDATE requests SET state='cancelled',reason='application_revoked' WHERE state='waiting' AND application NOT IN (SELECT id FROM consumers WHERE revoked=0)").run();
      db.prepare("UPDATE requests SET state='expired',reason='deadline' WHERE state='waiting' AND deadline<=?").run(this.store.clock());
      settleModelRequests(db,this.store.clock());
      // Groups are computed once per pass into a connection-local table of the remaining candidates. Rows leave
      // request_pass when attempted or when their group is blocked; the transaction owns every change.
      db.exec(`DROP TABLE IF EXISTS temp.request_pass;
        CREATE TEMP TABLE request_pass AS SELECT application,id,sequence,priority,${GROUP} AS grp
          FROM requests WHERE state='waiting' AND kind!='model-job' AND sequence NOT IN (SELECT sequence FROM request_scan);
        CREATE UNIQUE INDEX temp.request_pass_id ON request_pass(application,id);
        CREATE INDEX temp.request_pass_group ON request_pass(grp);
        DROP TABLE IF EXISTS temp.request_deferred;
        CREATE TEMP TABLE request_deferred AS SELECT * FROM request_pass WHERE 0;`);

      // At most 256 savepoint-isolated attempts; each request is attempted at most once per scan cycle.
      // Across the whole pass the least recently admitted application goes first (never admitted before any),
      // then higher priority, then FIFO sequence. Only an admission moves an application to the back: a refused
      // attempt leaves the order, so the next candidate is tried in the same pass. One order for every image pin
      // and kind means an application that keeps being admitted cannot keep taking capacity that an application
      // admitted less recently could use, whatever domains or hosts their pins share.
      const candidate = db.prepare(`SELECT p.application,p.id,p.grp FROM temp.request_pass p LEFT JOIN request_admissions a ON a.application=p.application
        ORDER BY coalesce(a.admitted,0),p.priority DESC,p.sequence LIMIT 1`);
      // Refusals per application per pass. An application that reaches the cap has its remaining candidates set
      // aside until no other application has one, so unservable backlogs (or cancel-and-resubmit churn) from a few
      // applications cannot use every attempt in every pass and keep a servable application waiting. Set-aside
      // candidates stay unscanned and return to the pass once the others are exhausted, so a lone application
      // keeps its full throughput.
      const refusals = new Map<string, number>();
      for (let i=0;i<256;i++) {
        const next = candidate.get() as { application: string; id: string; grp: string } | undefined;
        if (!next) {
          if (db.prepare("SELECT 1 FROM temp.request_deferred LIMIT 1").get()) {
            db.exec("INSERT INTO temp.request_pass SELECT * FROM temp.request_deferred; DELETE FROM temp.request_deferred");
            refusals.clear(); i--; continue;
          }
          db.exec("DELETE FROM request_scan; DROP TABLE temp.request_pass; DROP TABLE temp.request_deferred"); break;
        }
        db.prepare("DELETE FROM temp.request_pass WHERE application=? AND id=?").run(next.application,next.id);
        const row = this.row(db,next.application,next.id);
        db.prepare("INSERT OR IGNORE INTO request_scan VALUES(?)").run(row.sequence);
        // Earlier attempts take time: decide expiry against the clock immediately before this acquisition.
        if (row.deadline !== null && this.store.clock() >= row.deadline) {
          db.prepare("UPDATE requests SET state='expired',reason='deadline' WHERE application=? AND id=?").run(row.application,row.id);
          continue;
        }
        try {
          this.store.transaction(() => this.acquire(row.kind,row.application,JSON.parse(row.intent)));
          db.prepare("UPDATE requests SET state='admitted',admitted_at=?,target=?,reason=NULL WHERE application=? AND id=?").run(this.store.clock(),row.id,row.application,row.id);
          db.prepare(`INSERT INTO request_admissions VALUES(?,(SELECT coalesce(max(admitted),0)+1 FROM request_admissions))
            ON CONFLICT(application) DO UPDATE SET admitted=excluded.admitted`).run(row.application);
        } catch (error) {
          // The savepoint already rolled this attempt back. An unexpected failure stays waiting with a
          // visible reason and is not retried until the next round, so it cannot stall other requests.
          const temporary = !(error instanceof ServiceError) || error.status === 429 || error.status === 503 || error.code === "host_draining";
          db.prepare("UPDATE requests SET state=?,reason=? WHERE application=? AND id=?").run(temporary ? "waiting" : "rejected",error instanceof ServiceError ? error.code : "admission_error",row.application,row.id);
          // A capacity or quota refusal applies to the group's other requests for the rest of this pass, so a large
          // unservable backlog costs one attempt per group and cannot hide servable work behind it. This relies on
          // the acquire contract above: such a refusal never depends on the request UUID. A host drain refusal
          // (host_draining, where the controller has one) is capacity state too.
          // The skipped members count as scanned, so the group costs one attempt per scan cycle, not per pass.
          if (error instanceof ServiceError && (error.status === 429 || error.status === 503 || error.code === "host_draining")) {
            db.prepare("INSERT OR IGNORE INTO request_scan SELECT sequence FROM temp.request_pass WHERE grp=?").run(next.grp);
            db.prepare("DELETE FROM temp.request_pass WHERE grp=?").run(next.grp);
          }
          const refused = (refusals.get(next.application) ?? 0) + 1; refusals.set(next.application, refused);
          if (refused >= REFUSALS_PER_APPLICATION_PASS) {
            db.prepare("INSERT INTO temp.request_deferred SELECT * FROM temp.request_pass WHERE application=?").run(next.application);
            db.prepare("DELETE FROM temp.request_pass WHERE application=?").run(next.application);
          }
        }
      }
    });
  }
}
