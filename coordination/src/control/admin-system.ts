import type { DatabaseSync } from "node:sqlite";
import { cancelModelJob } from "../model-jobs.ts";
import { modelQueueView } from "../model-requests.ts";
import { identifier } from "../consumers.ts";
import { ServiceError } from "../errors.ts";
import type { ControlModule, ControlRequest } from "./contracts.ts";
import { isDeleted } from "./lifecycle.ts";
import { jobView } from "./inference.ts";
import { requireAdmin } from "./contracts.ts";
import { endLegacyLease, legacyTable, legacyLeaseView, refreshLegacyLeases } from "./leases.ts";
import type { LegacyLeases, LegacyLeaseRow } from "./leases.ts";

/** Administrator recovery never borrows an application or lease credential.
 * Payloads, command arguments, results, credential hashes and provider reports
 * are deliberately absent from these projections.
 */
export class AdminSystem implements ControlModule {
  constructor(readonly leases: LegacyLeases) {
    leases.store.transaction(db => db.exec(`CREATE TABLE IF NOT EXISTS admin_system_mutations (
      id TEXT PRIMARY KEY, actor TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL,
      result TEXT NOT NULL, created REAL NOT NULL)`));
  }
  handle(req: ControlRequest) {
    if (!req.path.startsWith("/v1/admin/")) return undefined;
    const match = /^\/v1\/admin\/(leases|sessions|applications|requests|jobs)\/([^/]+)\/(release|close|revoke|cancel)$/.exec(req.path);
    const inspect = /^\/v1\/admin\/(system|configuration)(?:\/pages\/(0|[1-9][0-9]{0,6}))?$/.exec(req.path);
    if (req.method === "GET" && req.path === "/v1/admin/model-jobs") return this.leases.store.transaction(db => {
      requireAdmin(req);
      if ([...req.query.keys()].length) throw new ServiceError("Queries are not supported.", 400);
      return { body: { jobs: this.modelJobs(db) } };
    });
    if (!(req.method === "GET" && inspect) && !(req.method === "POST" && match)) return undefined;
    return this.leases.store.transaction(db => {
      const principal = requireAdmin(req);
      if ([...req.query.keys()].length) throw new ServiceError("Queries are not supported.", 400);
      this.leases.linux.administrativeRefresh(db);
      refreshLegacyLeases(db, this.leases.store.clock());
      if (req.method === "GET") {
        const page = Number(inspect![2] ?? 0);
        if (page > 1000000) throw new ServiceError("Page exceeds the supported range.",400);
        return { body: inspect![1] === "configuration" ? this.configuration(db,page) : this.snapshot(db,page) };
      }
      const [, category, rawTarget, action] = match!;
      if (!({ leases: "release", sessions: "close", applications: "revoke", requests: "cancel", jobs: "cancel" } as Record<string,string>)[category!] ||
          ({ leases: "release", sessions: "close", applications: "revoke", requests: "cancel", jobs: "cancel" } as Record<string,string>)[category!] !== action) throw new ServiceError("Unknown endpoint.", 404);
      const scopedCancellation = category === "requests" || category === "jobs";
      const allowedFields = scopedCancellation ? ["id","applicationId"] : ["id"];
      if (!Object.hasOwn(req.body,"id") || Object.keys(req.body).some(key => !allowedFields.includes(key))) throw new ServiceError("Expected a mutation UUID and optional application selector for cancellation.",400);
      const requestId = identifier(req.body.id), target = identifier(rawTarget);
      const applicationId = Object.hasOwn(req.body,"applicationId") ? identifier(req.body.applicationId) : undefined;
      const receiptAction = `${category}:${action}${applicationId === undefined ? "" : ":"+applicationId}`;
      const actor = principal.kind === "operator" ? "operator" : `${principal.kind}:${principal.user!.id}`;
      const old = db.prepare("SELECT * FROM admin_system_mutations WHERE id=?").get(requestId);
      if (old) {
        if (old.actor !== actor || old.target !== target || old.action !== receiptAction) throw new ServiceError("Mutation UUID conflicts with another action.", 409);
        return { body: JSON.parse(String(old.result)) as unknown };
      }
      let state: string;
      if (category === "leases") state = this.release(db, target);
      else if (category === "applications") {
        this.leases.applications.revoke(target);
        this.leases.linux.administrativeRefresh(db);
        refreshLegacyLeases(db, this.leases.store.clock());
        state = "revoked";
      } else if (category === "requests" || category === "jobs") state = this.cancel(db,category,target,applicationId);
      else state = this.close(db, target);
      const result = { id: target, requestId, action, state, ...(applicationId === undefined ? {} : {applicationId}) };
      db.prepare("INSERT INTO admin_system_mutations VALUES (?,?,?,?,?,?)").run(requestId, actor, receiptAction, target, JSON.stringify(result), this.leases.store.clock());
      return { body: result };
    });
  }
  private release(db: DatabaseSync, id: string, applicationId?:string): string {
    const legacy = db.prepare("SELECT * FROM leases WHERE id=?").get(id) as unknown as LegacyLeaseRow | undefined;
    const linux = db.prepare("SELECT id,application FROM linux_leases WHERE id=?").get(id);
    if (legacy && linux) throw new ServiceError("Ambiguous lease identity.", 409);
    if (legacy && applicationId !== undefined && legacy.consumer !== applicationId) throw new ServiceError("Lease belongs to a different application.",409);
    if (linux && applicationId !== undefined && linux.application !== applicationId) throw new ServiceError("Lease belongs to a different application.",409);
    if (legacy) {
      endLegacyLease(db, legacy, "released", this.leases.store.clock());
      return String(db.prepare("SELECT state FROM leases WHERE id=?").get(id)!.state);
    }
    if (!linux) throw new ServiceError("Unknown lease.", 404);
    this.leases.linux.administrativeRelease(db, id);
    return String(db.prepare("SELECT state FROM linux_leases WHERE id=?").get(id)!.state);
  }
  private close(db: DatabaseSync, id: string): string {
    const access = legacyTable(db, "control_access_sessions") && db.prepare("SELECT state FROM control_access_sessions WHERE id=?").get(id);
    const video = legacyTable(db, "mobile_video_sessions") && db.prepare("SELECT state FROM mobile_video_sessions WHERE id=?").get(id);
    if (access && video) throw new ServiceError("Ambiguous session identity.", 409);
    if (access) {
      // Same transition as lease-owner close. Broker authorization observes it
      // on its next bounded check; native cleanup remains independently reported.
      db.prepare("UPDATE control_access_sessions SET state='closed' WHERE id=? AND state IN ('pending','attaching','ready')").run(id);
      return String(db.prepare("SELECT state FROM control_access_sessions WHERE id=?").get(id)!.state);
    }
    if (video) {
      // Same transition as video disconnect; retain reservations until host cleanup.
      db.prepare("UPDATE mobile_video_sessions SET state='disconnected',cleaned=CASE WHEN host_attached=0 THEN 1 ELSE cleaned END WHERE id=? AND state IN ('pending','attaching','ready')").run(id);
      return String(db.prepare("SELECT state FROM mobile_video_sessions WHERE id=?").get(id)!.state);
    }
    throw new ServiceError("Unknown session.", 404);
  }
  private cancel(db: DatabaseSync, category: string, id: string, applicationId?:string): string {
    if (category === "requests") {
      const rows = db.prepare("SELECT application,state,kind,target,deadline FROM requests WHERE id=?"+(applicationId === undefined ? "" : " AND application=?")).all(id,...(applicationId === undefined ? [] : [applicationId]));
      if (rows.length !== 1) throw new ServiceError("Unknown or ambiguous request.", rows.length ? 409 : 404);
      const row = rows[0]!;
      if (row.kind === "model-job" && (row.state === "waiting" || row.state === "admitted")) {
        // Waiting intent closes unexecuted; admitted work keeps its reservation until the runner confirms stop.
        cancelModelJob(db,String(row.application),id,this.leases.store.clock(),"administrator_cancelled");
        return String(db.prepare("SELECT state FROM requests WHERE application=? AND id=?").get(row.application!,id)!.state);
      }
      if (row.state === "waiting") {
        const expired = row.deadline !== null && Number(row.deadline) <= this.leases.store.clock();
        db.prepare("UPDATE requests SET state=?,reason=? WHERE application=? AND id=?").run(expired ? "expired" : "cancelled", expired ? "deadline" : "administrator_cancelled", row.application!,id);
        return expired ? "expired" : "cancelled";
      }
      if (row.state === "admitted") return this.release(db,id,String(row.application));
      return String(row.state);
    }
    const models = legacyTable(db,"model_jobs") ? db.prepare("SELECT application,state FROM model_jobs WHERE id=?"+(applicationId === undefined ? "" : " AND application=?")).all(id,...(applicationId === undefined ? [] : [applicationId])) : [];
    const inference = applicationId === undefined && legacyTable(db,"inference_jobs") && db.prepare("SELECT state FROM inference_jobs WHERE id=?").get(id);
    if (models.length + (inference ? 1 : 0) !== 1) throw new ServiceError("Unknown or ambiguous job.", models.length || inference ? 409 : 404);
    if (models.length) {
      cancelModelJob(db,String(models[0]!.application),id,this.leases.store.clock(),"administrator_cancelled");
      const state = String(db.prepare("SELECT state FROM model_jobs WHERE application=? AND id=?").get(models[0]!.application!,id)!.state);
      return ["succeeded","failed","cancelled"].includes(state) ? state : "cancel_requested";
    }
    db.prepare("UPDATE inference_jobs SET desired='cancelled',updated=? WHERE id=? AND state NOT IN ('succeeded','failed','cancelled')").run(this.leases.store.clock(),id);
    return inference && ["succeeded","failed","cancelled"].includes(String(inference.state)) ? String(inference.state) : "cancel_requested";
  }
  private pageReader(db:DatabaseSync, page:number, state:{more:boolean}) {
    return (table:string,sql:string) => {
      if (!legacyTable(db,table)) return [];
      // Paired ledgers share a category budget of 100 records per page.
      const limit = ["leases","linux_leases","model_jobs","inference_jobs","device_operations","linux_operations","control_access_sessions","mobile_video_sessions"].includes(table) ? 50 : 100;
      const order = table === "linux_lease_grants" ? "1,2,3,4" : "1,2,3";
      const rows = db.prepare(sql + ` ORDER BY ${order} LIMIT ? OFFSET ?`).all(limit+1,page*limit);
      if(rows.length>limit) state.more=true;
      return rows.slice(0,limit);
    };
  }
  private configuration(db: DatabaseSync, page:number) {
    const state = {more:false}, read = this.pageReader(db,page,state);
    const configuration = {
      modelCatalog: read("model_catalog","SELECT model,digest,adapter,resources,created FROM model_catalog"),
      resourceDomains: read("resource_domains","SELECT id,name,capacity,created FROM resource_domains"),
      reservations: read("resource_reservations","SELECT id,domain,kind,owner,resources,state,created,released FROM resource_reservations"),
      modelGrants: read("model_grants","SELECT application,model,digest,max_unfinished,revoked FROM model_grants"),
      modelRunnerApprovals: read("model_runner_approvals","SELECT controller,runner,generation,incarnation,domain,models,revoked FROM model_runner_approvals"),
      linuxImages: read("linux_lease_images","SELECT id,revision,arch,backend,digest,resources,capabilities,created FROM linux_lease_images"),
      linuxGrants: read("linux_lease_grants","SELECT application,image_id,image_revision,arch,digest,revoked FROM linux_lease_grants"),
      linuxRunnerApprovals: read("linux_lease_runner_approvals","SELECT controller,runner,generation,incarnation,domain,backend,images,revoked FROM linux_lease_runner_approvals"),
      runnerEnrollments: read("runner_enrollments","SELECT id,controller,runner,generation,incarnation,expires,CASE WHEN consumed IS NULL THEN 0 ELSE 1 END AS consumed,revoked FROM runner_enrollments"),
      appArtifacts: read("app_artifacts","SELECT id,machine,format,bytes,sha256,received,state,reserved_disk FROM app_artifacts"),
      runnerBindings: read("runner_bindings","SELECT controller,runner,generation,incarnation,revision,revoked FROM runner_bindings"),
    };
    return {...configuration,page,nextPage:state.more && page<1000000 ? page+1 : null};
  }
  /** Application model jobs for the dashboard queue: open work oldest first, so stuck work stays visible, then the
   * most recently closed. No prompts or results. */
  private modelJobs(db: DatabaseSync) {
    if (!legacyTable(db,"model_jobs")) return [];
    const rows = db.prepare(`SELECT j.id,j.application AS applicationId,j.model,j.digest,j.state,j.cancel_requested,j.stopped,j.cleanup,j.closed,j.created,j.updated,
      (SELECT reservation FROM model_assignments a WHERE a.application=j.application AND a.job=j.id) AS reservation
      FROM model_jobs j ORDER BY j.closed,CASE WHEN j.closed=0 THEN j.rowid ELSE -j.rowid END LIMIT 100`).all() as Array<Record<string, unknown>>;
    return rows.map(j => {
      const request = modelQueueView(db,String(j.applicationId),String(j.id));
      const held = j.reservation !== null && !!db.prepare("SELECT 1 FROM resource_reservations WHERE id=? AND state='held'").get(String(j.reservation));
      return { id:j.id,applicationId:j.applicationId,model:j.model,digest:j.digest,state:this.modelState(db,j),cancelRequested:Boolean(j.cancel_requested),
        stopped:Boolean(j.stopped),cleanup:j.cleanup,assigned:j.reservation !== null,reservationHeld:held,createdAt:j.created,updatedAt:j.updated,...(request ? {request} : {}) };
    });
  }
  private modelState(db:DatabaseSync, job:Record<string,unknown>): string {
    const a = db.prepare("SELECT * FROM model_assignments WHERE application=? AND job=?").get(String(job.applicationId),String(job.id));
    const current = !a || a.closed || this.leases.linux.runners?.current(db,{controllerId:a.controller,runnerId:a.runner,generation:a.generation,incarnationId:a.incarnation});
    return !current && !["succeeded","failed","cancelled"].includes(String(job.state)) ? "unknown" : String(job.state);
  }
  private legacyProjection(db: DatabaseSync, l: Record<string, unknown>) {
    const row = db.prepare("SELECT * FROM leases WHERE id=?").get(String(l.id)) as unknown as LegacyLeaseRow;
    const members = legacyLeaseView(db,row,this.leases.store.clock()).members.map(m => ({machineId:m.machineId,name:m.name,runtimeState:m.state,ready:m.ready,requestedState:String(db.prepare("SELECT desired FROM machines WHERE id=?").get(m.machineId)!.desired),...(m.cleanup ? {cleanup:m.cleanup.state} : {})}));
    const cleanup = db.prepare("SELECT reason,attempts,next_retry FROM lease_cleanup_members WHERE lease=? ORDER BY CASE WHEN state='blocked' THEN 0 ELSE 1 END,machine LIMIT 1").get(String(l.id));
    return { ...l, members, runtimeState:members.length === 1 ? members[0]!.runtimeState : "unknown", requestedState:members.length === 1 ? members[0]!.requestedState : "unknown", reservationHeld:members.some(m => !isDeleted(db,m.machineId)), ...(cleanup ? { ...(cleanup.reason ? {cleanupReason:String(cleanup.reason)} : {}),cleanupAttempts:Number(cleanup.attempts),cleanupRetryAt:Number(cleanup.next_retry) } : {}) };
  }
  private snapshot(db: DatabaseSync, page:number) {
    const state={more:false},read=this.pageReader(db,page,state);
    const snapshot = {
      applications: read("consumers", "SELECT id,'application' AS family,json_extract(specification,'$.name') AS name,revoked,created AS createdAt FROM consumers").map(a => ({...a,state:a.revoked ? "revoked" : "active",revoked:Boolean(a.revoked)})),
      leases: [
        ...read("leases", "SELECT id,'legacy' AS family,consumer AS applicationId,state,revision,created AS createdAt,expires AS expiresAt,cleanup FROM leases").map(l => this.legacyProjection(db,l)),
        ...read("linux_leases", "SELECT id,'linux' AS family,application AS applicationId,state,runtime AS runtimeState,revision,created AS createdAt,expires AS expiresAt,cleanup,member AS machineId FROM linux_leases").map(l => ({...l,...this.leases.linux.administrativeStatus(db,String(l.id)),requestedState:["provisioning","ready"].includes(String(l.state)) ? "running" : "stopped",reservationHeld:db.prepare("SELECT r.state FROM linux_leases l JOIN resource_reservations r ON r.id=l.reservation AND r.owner=l.id AND r.kind='linux-lease' WHERE l.id=?").get(l.id!)?.state !== "released"})),
      ],
      requests: read("requests", "SELECT id,'request' AS family,application AS applicationId,kind,state,priority,created AS createdAt,deadline AS expiresAt,target FROM requests"),
      jobs: [
        ...read("model_jobs", "SELECT id,'model' AS family,application AS applicationId,state,cancel_requested AS cancelRequested,cleanup,created AS createdAt FROM model_jobs").map(j => ({...j,state:this.modelState(db,j),cancelRequested:Boolean(j.cancelRequested)})),
        ...read("inference_jobs", "SELECT j.*,h.seen FROM inference_jobs j LEFT JOIN hosts h ON h.id=j.host").map(j => {
          const view = jobView(db,j as unknown as Parameters<typeof jobView>[1],this.leases.store.clock(),false,false);
          return {id:j.id,family:"inference",state:view.state,requestedState:j.desired,cancelRequested:j.desired === "cancelled",reservationHeld:view.reservationHeld,cleanup:view.cleanup,createdAt:j.created};
        }),
      ],
      operations: [
        ...read("device_operations", "SELECT d.id,CASE WHEN c.id IS NULL THEN 'device' ELSE 'consumer' END AS family,d.machine AS machineId,c.lease AS leaseId,d.state,d.created AS createdAt FROM device_operations d LEFT JOIN consumer_operations c ON c.id=d.id"),
        ...read("linux_operations", "SELECT id,'linux' AS family,lease AS leaseId,state,updated AS updatedAt FROM linux_operations"),
      ],
      sessions: [
        ...read("control_access_sessions", "SELECT id,'access' AS family,lease AS leaseId,machine AS machineId,state,created AS createdAt,deadline AS expiresAt FROM control_access_sessions"),
        ...read("mobile_video_sessions", "SELECT id,'video' AS family,machine AS machineId,state,created AS createdAt,deadline AS expiresAt FROM mobile_video_sessions"),
      ],
    };
    return {...Object.fromEntries(Object.entries(snapshot).map(([category,rows]) => [category, rows.map(row => Object.fromEntries(Object.entries(row).filter(([,value]) => value !== null)))])),page,nextPage:state.more && page<1000000 ? page+1 : null};
  }
}
