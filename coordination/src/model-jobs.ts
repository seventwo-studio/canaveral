import { randomUUID } from "node:crypto";
import { updateDraining } from "./updates/drain.ts";
import type { DatabaseSync } from "node:sqlite";
import { identifier } from "./consumers.ts";
import type { ConsumerIdentities } from "./consumers.ts";
import type { Binding, RunnerEnrollment } from "./enrollment.ts";
import { object, ServiceError } from "./errors.ts";
import { modelIdentity, modelJobCanRelease, modelReceiptMatches, parseModelJob, sameModelSubmission } from "./model-job.ts";
import type { GenerationResult, ModelJob, ModelJobState } from "./model-job.ts";
import { resources, ResourceDomains } from "./resource-domains.ts";
import type { SqliteStore } from "./sqlite.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TERMINAL = ["succeeded", "failed", "cancelled"];
const MAX_ACTIVE_ASSIGNMENTS = 32;
const terminal = (state: string): boolean => TERMINAL.includes(state);
/** Forward-only progression; `unknown` never returns to an unfinished state. */
function rank(state: string): number {
  return state === "queued" || state === "waitingForResources" ? 0 : state === "running" ? 1 : state === "unknown" ? 2 : 3;
}

interface JobRow {
  application: string; id: string; submission: string; model: string; digest: string; state: ModelJobState;
  cancel_requested: number; stopped: number; cleanup: "pending" | "complete"; result: string | null; closed: number; created: number; updated: number;
}
interface AssignmentRow {
  id: string; claim: string; application: string; job: string; controller: string; runner: string; generation: number; incarnation: string;
  domain: string; reservation: string; sequence: number; report: string | null; closed: number; created: number;
}
interface ApprovalRow { controller: string; runner: string; generation: number; incarnation: string; domain: string; models: string; revoked: number }

function exact(value: unknown, names: string[], what: string): Record<string, unknown> {
  const input = object(value);
  if (Object.keys(input).length !== names.length || names.some(key => !Object.hasOwn(input, key))) throw new ServiceError(`Invalid ${what} fields.`, 400);
  return input;
}
function strictId(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) throw new ServiceError("Model job IDs are lowercase hyphenated UUIDs.", 400);
  return value;
}
function positive(value: unknown, maximum: number, what: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > maximum) throw new ServiceError(`Invalid ${what}.`, 400);
  return value;
}
function parse(value: unknown, type: "submit" | "cancel" | "receipt"): ModelJob {
  let job: ModelJob;
  try { job = parseModelJob(value); } catch { throw new ServiceError("Invalid model-job/1 record.", 400); }
  if (job.message.type !== type) throw new ServiceError(`Expected a model-job/1 ${type} message.`, 400);
  return job;
}
function bindingOf(row: { controller: string; runner: string; generation: number; incarnation: string }): Binding {
  return { controllerId: row.controller, runnerId: row.runner, generation: row.generation, incarnationId: row.incarnation };
}
function sameBinding(row: { controller: string; runner: string; generation: number; incarnation: string }, b: Binding): boolean {
  return row.controller === b.controllerId && row.runner === b.runnerId && row.generation === b.generation && row.incarnation === b.incarnationId;
}
/** Key-order independent encoding used for exact report replay comparison. */
function canonicalReceipt(job: ModelJob): string {
  const m = job.message;
  if (m.type !== "receipt") throw new TypeError("receipt");
  return JSON.stringify({ version: 1, applicationId: job.applicationId, id: job.id, message: {
    type: "receipt", state: m.state, cancelRequested: m.cancelRequested, stopped: m.stopped, cleanup: m.cleanup,
    ...(m.result ? { result: JSON.parse(canonicalResult(m.result)!) as unknown } : {}),
  } });
}
function canonicalResult(result: GenerationResult | undefined): string | null {
  return result ? JSON.stringify({ model: result.model, text: result.text, usage: { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens } }) : null;
}

/** Application-owned model-job ledger with claim-time admission against operator-approved
 * runner bindings and their shared physical resource domains. Every effect runs inside one
 * BEGIN IMMEDIATE transaction that also re-verifies the caller's credential. It never retries,
 * reassigns, times out or replays a job, and only a correctly bound positive stop-and-cleanup
 * receipt releases a reservation.
 */
export class ModelJobs {
  readonly domains = new ResourceDomains();
  constructor(readonly store: SqliteStore, readonly applications: ConsumerIdentities, readonly runners: RunnerEnrollment | undefined) {
    store.transaction(db => {
      ResourceDomains.schema(db);
      db.exec(`CREATE TABLE IF NOT EXISTS model_catalog (model TEXT NOT NULL, digest TEXT NOT NULL, adapter TEXT NOT NULL, resources TEXT NOT NULL, created REAL NOT NULL, PRIMARY KEY(model,digest));
        CREATE TABLE IF NOT EXISTS model_grants (application TEXT NOT NULL, model TEXT NOT NULL, digest TEXT NOT NULL, max_unfinished INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0, created REAL NOT NULL, PRIMARY KEY(application,model,digest));
        CREATE TABLE IF NOT EXISTS model_runner_approvals (controller TEXT NOT NULL, runner TEXT NOT NULL, generation INTEGER NOT NULL, incarnation TEXT NOT NULL, domain TEXT NOT NULL, models TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0, created REAL NOT NULL, PRIMARY KEY(controller,runner,generation));
        CREATE TABLE IF NOT EXISTS model_jobs (application TEXT NOT NULL, id TEXT NOT NULL, submission TEXT NOT NULL, model TEXT NOT NULL, digest TEXT NOT NULL, state TEXT NOT NULL, cancel_requested INTEGER NOT NULL DEFAULT 0, stopped INTEGER NOT NULL DEFAULT 0, cleanup TEXT NOT NULL DEFAULT 'pending', result TEXT, closed INTEGER NOT NULL DEFAULT 0, created REAL NOT NULL, updated REAL NOT NULL, PRIMARY KEY(application,id));
        CREATE INDEX IF NOT EXISTS model_jobs_open ON model_jobs(closed,state,created);
        CREATE TABLE IF NOT EXISTS model_assignments (id TEXT PRIMARY KEY, claim TEXT NOT NULL UNIQUE, application TEXT NOT NULL, job TEXT NOT NULL, controller TEXT NOT NULL, runner TEXT NOT NULL, generation INTEGER NOT NULL, incarnation TEXT NOT NULL, domain TEXT NOT NULL, reservation TEXT NOT NULL UNIQUE, sequence INTEGER NOT NULL DEFAULT 0, report TEXT, closed INTEGER NOT NULL DEFAULT 0, created REAL NOT NULL, UNIQUE(application,job));
        CREATE INDEX IF NOT EXISTS model_assignments_binding ON model_assignments(controller,runner,generation,closed);`);
    });
  }

  private now(): number { return this.store.clock(); }
  private requireRunners(): RunnerEnrollment {
    if (!this.runners) throw new ServiceError("Runner model work requires a configured controller identity.", 503, { retryable: false });
    return this.runners;
  }

  // Operator configuration. Callers must have verified the administrator role.

  defineDomain(value: unknown): unknown {
    return this.store.transaction(db => this.domains.define(db, value, this.now()));
  }
  inspectDomain(id: string): unknown {
    return this.store.transaction(db => this.domains.view(db, identifier(id)));
  }

  catalog(value: unknown): unknown {
    const input = exact(value, ["model", "digest", "adapter", "resources"], "model catalog");
    if (!modelIdentity(input.model, input.digest) || input.adapter !== "ollama") throw new ServiceError("Catalog entries pin an ollama model label and sha256 digest.", 400);
    const amount = resources(input.resources), view = { model: input.model as string, digest: input.digest as string, adapter: "ollama", resources: amount };
    return this.store.transaction(db => {
      const row = db.prepare("SELECT adapter,resources FROM model_catalog WHERE model=? AND digest=?").get(view.model, view.digest) as { adapter: string; resources: string } | undefined;
      if (row && (row.adapter !== view.adapter || row.resources !== JSON.stringify(amount))) throw new ServiceError("Catalog entry already exists with a different definition.", 409);
      if (!row) db.prepare("INSERT INTO model_catalog VALUES (?,?,?,?,?)").run(view.model, view.digest, view.adapter, JSON.stringify(amount), this.now());
      return view;
    });
  }

  grant(value: unknown): unknown {
    const input = exact(value, ["applicationId", "model", "digest", "maxUnfinished"], "model grant");
    const application = identifier(input.applicationId), limit = positive(input.maxUnfinished, 1024, "maxUnfinished");
    if (!modelIdentity(input.model, input.digest)) throw new ServiceError("Grants pin a model label and sha256 digest.", 400);
    const model = input.model as string, digest = input.digest as string;
    return this.store.transaction(db => {
      if (!this.applications.active(db, application)) throw new ServiceError("Grants require an existing unrevoked application.", 404);
      if (!db.prepare("SELECT 1 FROM model_catalog WHERE model=? AND digest=?").get(model, digest)) throw new ServiceError("Grants require an operator catalog entry.", 404);
      const row = db.prepare("SELECT max_unfinished,revoked FROM model_grants WHERE application=? AND model=? AND digest=?").get(application, model, digest) as { max_unfinished: number; revoked: number } | undefined;
      if (row && (row.revoked || row.max_unfinished !== limit)) throw new ServiceError("Grant already exists with a different definition or was revoked.", 409);
      if (!row) db.prepare("INSERT INTO model_grants VALUES (?,?,?,?,0,?)").run(application, model, digest, limit, this.now());
      return { applicationId: application, model, digest, maxUnfinished: limit, revoked: false };
    });
  }

  revokeGrant(value: unknown): unknown {
    const input = exact(value, ["applicationId", "model", "digest"], "model grant");
    const application = identifier(input.applicationId);
    return this.store.transaction(db => {
      const changed = db.prepare("UPDATE model_grants SET revoked=1 WHERE application=? AND model=? AND digest=?").run(application, String(input.model), String(input.digest));
      if (!changed.changes) throw new ServiceError("Unknown model grant.", 404);
      return { applicationId: application, model: input.model, digest: input.digest, revoked: true };
    });
  }

  /** Explicitly maps one current runner binding to one physical domain and served models. */
  approve(value: unknown): unknown {
    const runners = this.requireRunners();
    const input = exact(value, ["binding", "domainId", "models"], "runner model approval");
    const domain = identifier(input.domainId);
    if (!Array.isArray(input.models) || input.models.length < 1 || input.models.length > 100) throw new ServiceError("Approve 1 to 100 models.", 400);
    const models = input.models.map(item => {
      const entry = exact(item, ["model", "digest"], "approved model");
      if (!modelIdentity(entry.model, entry.digest)) throw new ServiceError("Approved models pin a label and sha256 digest.", 400);
      return [entry.model as string, entry.digest as string] as [string, string];
    }).sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0);
    if (new Set(models.map(m => m.join("@"))).size !== models.length) throw new ServiceError("Approved models must be unique.", 400);
    return this.store.transaction(db => {
      const binding = runners.current(db, input.binding);
      if (!binding) throw new ServiceError("Approve only the current unrevoked runner binding.", 409);
      if (!this.domains.exists(db, domain)) throw new ServiceError("Unknown resource domain.", 404);
      for (const [model, digest] of models) {
        if (!db.prepare("SELECT 1 FROM model_catalog WHERE model=? AND digest=?").get(model, digest)) throw new ServiceError("Approved models require operator catalog entries.", 404);
      }
      const row = db.prepare("SELECT * FROM model_runner_approvals WHERE controller=? AND runner=? AND generation=?").get(binding.controllerId, binding.runnerId, binding.generation) as unknown as ApprovalRow | undefined;
      if (row && (row.revoked || row.domain !== domain || row.models !== JSON.stringify(models) || row.incarnation !== binding.incarnationId)) {
        throw new ServiceError("Runner approval already exists with a different definition or was revoked.", 409);
      }
      if (!row) db.prepare("INSERT INTO model_runner_approvals VALUES (?,?,?,?,?,?,0,?)").run(binding.controllerId, binding.runnerId, binding.generation, binding.incarnationId, domain, JSON.stringify(models), this.now());
      return { binding, domainId: domain, models: models.map(([model, digest]) => ({ model, digest })), revoked: false };
    });
  }

  /** Stops new claims. Existing assignments keep their reservation and report authority. */
  revokeApproval(value: unknown): unknown {
    const input = exact(value, ["binding"], "runner model approval");
    const b = exact(input.binding, ["controllerId", "runnerId", "generation", "incarnationId"], "binding");
    const binding = { controllerId: identifier(b.controllerId), runnerId: identifier(b.runnerId), generation: positive(b.generation, Number.MAX_SAFE_INTEGER, "generation"), incarnationId: identifier(b.incarnationId) };
    return this.store.transaction(db => {
      const changed = db.prepare("UPDATE model_runner_approvals SET revoked=1 WHERE controller=? AND runner=? AND generation=? AND incarnation=?")
        .run(binding.controllerId, binding.runnerId, binding.generation, binding.incarnationId);
      if (!changed.changes) throw new ServiceError("Unknown runner model approval.", 404);
      return { binding, revoked: true };
    });
  }

  // Application routes. The application credential is re-verified inside each transaction.

  submit(token: string, value: unknown): { created: boolean; job: unknown } {
    const job = parse(value, "submit");
    if (job.message.type !== "submit") throw new TypeError("submit");
    const { model, digest } = job.message;
    return this.store.transaction(db => {
      const application = this.applications.verify(db, token);
      if (job.applicationId !== application.id) throw new ServiceError("Model jobs must name the authenticated application.", 403);
      const existing = this.job(db, application.id, job.id);
      if (existing) {
        if (!sameModelSubmission(JSON.parse(existing.submission) as unknown, job)) {
          throw new ServiceError("Job ID already exists with a different submission; it was not executed again.", 409);
        }
        return { created: false, job: this.view(db, existing) };
      }
      const grant = db.prepare("SELECT max_unfinished FROM model_grants WHERE application=? AND model=? AND digest=? AND revoked=0").get(application.id, model, digest) as { max_unfinished: number } | undefined;
      if (!grant) throw new ServiceError("The application has no grant for this pinned model.", 403);
      const open = db.prepare("SELECT count(*) AS n FROM model_jobs WHERE application=? AND model=? AND digest=? AND closed=0").get(application.id, model, digest) as { n: number };
      if (Number(open.n) >= grant.max_unfinished) throw new ServiceError("The application's unfinished model-job limit is reached.", 429);
      const now = this.now();
      db.prepare("INSERT INTO model_jobs VALUES (?,?,?,?,?,'queued',0,0,'pending',NULL,0,?,?)").run(application.id, job.id, JSON.stringify(job), model, digest, now, now);
      return { created: true, job: this.view(db, this.job(db, application.id, job.id)!) };
    });
  }

  inspect(token: string, id: string): unknown {
    return this.store.transaction(db => {
      const application = this.applications.verify(db, token);
      return this.view(db, this.owned(db, application.id, id));
    });
  }

  /** Cancellation intent. An unclaimed job cancels in the same transaction that excludes any claim. */
  cancel(token: string, id: string, value: unknown): unknown {
    const request = parse(value, "cancel");
    return this.store.transaction(db => {
      const application = this.applications.verify(db, token);
      if (request.applicationId !== application.id || request.id !== id) throw new ServiceError("Cancellation must name the authenticated application and path job ID.", 403);
      const job = this.owned(db, application.id, id);
      if (!terminal(job.state) && !job.cancel_requested) {
        const now = this.now();
        if (this.assignment(db, job)) db.prepare("UPDATE model_jobs SET cancel_requested=1,updated=? WHERE application=? AND id=?").run(now, job.application, job.id);
        else db.prepare("UPDATE model_jobs SET cancel_requested=1,state='cancelled',stopped=1,cleanup='complete',closed=1,updated=? WHERE application=? AND id=?").run(now, job.application, job.id);
      }
      return this.view(db, this.owned(db, application.id, id));
    });
  }

  // Runner routes. Every request carries `{binding, ...}` and the runner credential.

  /** Claim the oldest eligible job that fits the runner's approved domain, or replay `claimId`. */
  claim(token: string, value: unknown): unknown {
    const runners = this.requireRunners();
    const input = exact(value, ["binding", "claimId"], "claim"), claim = identifier(input.claimId);
    return this.store.transaction(db => {
      const b = runners.verify(db, token, input.binding);
      const previous = db.prepare("SELECT * FROM model_assignments WHERE claim=?").get(claim) as unknown as AssignmentRow | undefined;
      if (previous) {
        if (!sameBinding(previous, b)) throw new ServiceError("Claim ID belongs to another runner binding.", 409);
        return { assignment: this.assignmentView(db, previous) };
      }
      const approval = db.prepare("SELECT * FROM model_runner_approvals WHERE controller=? AND runner=? AND generation=? AND incarnation=? AND revoked=0")
        .get(b.controllerId, b.runnerId, b.generation, b.incarnationId) as unknown as ApprovalRow | undefined;
      if (!approval) throw new ServiceError("This runner binding has no model approval.", 403);
      if (updateDraining(db, b.runnerId, "runner")) return { assignment: null };
      const active = db.prepare("SELECT count(*) AS n FROM model_assignments WHERE controller=? AND runner=? AND generation=? AND closed=0").get(b.controllerId, b.runnerId, b.generation) as { n: number };
      if (Number(active.n) >= MAX_ACTIVE_ASSIGNMENTS) return { assignment: null };
      const served = new Set((JSON.parse(approval.models) as Array<[string, string]>).map(m => JSON.stringify(m)));
      const queue = db.prepare(`SELECT j.* FROM model_jobs j WHERE j.closed=0 AND j.state IN ('queued','waitingForResources') AND j.cancel_requested=0
        AND NOT EXISTS (SELECT 1 FROM model_assignments a WHERE a.application=j.application AND a.job=j.id) ORDER BY j.created, j.rowid`).all() as unknown as JobRow[];
      const next = queue.find(job => served.has(JSON.stringify([job.model, job.digest])) && this.applications.active(db, job.application) &&
        !!db.prepare("SELECT 1 FROM model_grants WHERE application=? AND model=? AND digest=? AND revoked=0").get(job.application, job.model, job.digest));
      if (!next) return { assignment: null };
      const entry = db.prepare("SELECT resources FROM model_catalog WHERE model=? AND digest=?").get(next.model, next.digest) as { resources: string } | undefined;
      if (!entry) throw new ServiceError("Model catalog state is unavailable.", 503, { retryable: false });
      const id = randomUUID(), reservation = randomUUID(), now = this.now();
      const fits = this.domains.reserve(db, { id: reservation, domain: approval.domain, kind: "model-job", owner: id, resources: resources(JSON.parse(entry.resources) as unknown) }, now);
      if (!fits) {
        // Strict per-runner FIFO: the oldest eligible job waits rather than being overtaken.
        if (next.state !== "waitingForResources") db.prepare("UPDATE model_jobs SET state='waitingForResources',updated=? WHERE application=? AND id=?").run(now, next.application, next.id);
        return { assignment: null };
      }
      db.prepare("INSERT INTO model_assignments VALUES (?,?,?,?,?,?,?,?,?,?,0,NULL,0,?)")
        .run(id, claim, next.application, next.id, b.controllerId, b.runnerId, b.generation, b.incarnationId, approval.domain, reservation, now);
      db.prepare("UPDATE model_jobs SET state='queued',updated=? WHERE application=? AND id=?").run(now, next.application, next.id);
      return { assignment: this.assignmentView(db, db.prepare("SELECT * FROM model_assignments WHERE id=?").get(id) as unknown as AssignmentRow) };
    });
  }

  /** Unreleased assignments of this exact binding, for restart reconciliation and cancel delivery. */
  assignments(token: string, value: unknown): unknown {
    const runners = this.requireRunners();
    const input = exact(value, ["binding"], "assignment listing");
    return this.store.transaction(db => {
      const b = runners.verify(db, token, input.binding);
      const rows = db.prepare("SELECT * FROM model_assignments WHERE controller=? AND runner=? AND generation=? AND incarnation=? AND closed=0 ORDER BY created,id")
        .all(b.controllerId, b.runnerId, b.generation, b.incarnationId) as unknown as AssignmentRow[];
      return { assignments: rows.map(row => this.assignmentView(db, row)) };
    });
  }

  /** Ordered receipt. `sequence` advances by exactly one; repeating the last one is an exact replay. */
  report(token: string, value: unknown): unknown {
    const runners = this.requireRunners();
    const input = exact(value, ["binding", "assignmentId", "sequence", "receipt"], "report");
    const id = identifier(input.assignmentId), sequence = positive(input.sequence, Number.MAX_SAFE_INTEGER, "sequence");
    const receipt = parse(input.receipt, "receipt"), encoded = canonicalReceipt(receipt);
    if (receipt.message.type !== "receipt") throw new TypeError("receipt");
    const r = receipt.message;
    return this.store.transaction(db => {
      const b = runners.verify(db, token, input.binding);
      const assignment = db.prepare("SELECT * FROM model_assignments WHERE id=?").get(id) as unknown as AssignmentRow | undefined;
      if (!assignment) throw new ServiceError("Unknown assignment.", 404);
      if (!sameBinding(assignment, b)) throw new ServiceError("The assignment is bound to another runner binding.", 403);
      const job = this.job(db, assignment.application, assignment.job);
      if (!job) throw new ServiceError("Assigned job state is unavailable.", 503, { retryable: false });
      if (!modelReceiptMatches(JSON.parse(job.submission) as unknown, receipt)) throw new ServiceError("The receipt does not match the assigned job.", 409);
      if (sequence === assignment.sequence) {
        if (assignment.report !== encoded) throw new ServiceError("A different receipt was already recorded at this sequence.", 409);
        return this.reportView(db, assignment);
      }
      if (assignment.closed) throw new ServiceError("The assignment is closed; only the final receipt can be replayed.", 409);
      if (sequence !== assignment.sequence + 1) throw new ServiceError("Report sequence must advance by exactly one.", 409);
      if (r.cancelRequested && !job.cancel_requested) throw new ServiceError("The application did not request cancellation.", 409);
      if (terminal(job.state)) {
        if (r.state !== job.state || (job.state === "succeeded" && canonicalResult(r.result) !== job.result) ||
            (job.stopped && !r.stopped) || (job.cleanup === "complete" && r.cleanup !== "complete")) {
          throw new ServiceError("Terminal outcomes can only add stop and cleanup evidence.", 409);
        }
      } else if (rank(r.state) < rank(job.state)) throw new ServiceError("Receipts cannot regress job state.", 409);
      const now = this.now(), release = modelJobCanRelease(receipt);
      db.prepare("UPDATE model_jobs SET state=?,stopped=?,cleanup=?,result=?,closed=?,updated=? WHERE application=? AND id=?")
        .run(r.state, r.stopped ? 1 : 0, r.cleanup, canonicalResult(r.result) ?? job.result, release ? 1 : 0, now, job.application, job.id);
      db.prepare("UPDATE model_assignments SET sequence=?,report=?,closed=? WHERE id=?").run(sequence, encoded, release ? 1 : 0, id);
      if (release) this.domains.release(db, assignment.reservation, assignment.id, now);
      return this.reportView(db, db.prepare("SELECT * FROM model_assignments WHERE id=?").get(id) as unknown as AssignmentRow);
    });
  }

  private job(db: DatabaseSync, application: string, id: string): JobRow | undefined {
    return db.prepare("SELECT * FROM model_jobs WHERE application=? AND id=?").get(application, id) as unknown as JobRow | undefined;
  }
  /** Other applications' jobs are indistinguishable from missing ones. */
  private owned(db: DatabaseSync, application: string, id: string): JobRow {
    const job = UUID.test(id) ? this.job(db, application, id) : undefined;
    if (!job) throw new ServiceError("Unknown model job.", 404);
    return job;
  }
  private assignment(db: DatabaseSync, job: JobRow): AssignmentRow | undefined {
    return db.prepare("SELECT * FROM model_assignments WHERE application=? AND job=?").get(job.application, job.id) as unknown as AssignmentRow | undefined;
  }

  private view(db: DatabaseSync, job: JobRow): unknown {
    const assignment = this.assignment(db, job);
    const authority = !assignment ? "none" : assignment.closed ? "released" : this.runners?.current(db, bindingOf(assignment)) ? "current" : "revoked";
    // A revoked or superseded runner cannot report; its unfinished work is uncertain, not failed.
    const state = authority === "revoked" && !terminal(job.state) ? "unknown" : job.state;
    const submission = parseModelJob(JSON.parse(job.submission) as unknown);
    return {
      version: 1, applicationId: job.application, id: job.id, model: job.model, digest: job.digest,
      maxTokens: submission.message.type === "submit" ? submission.message.maxTokens : undefined,
      state, cancelRequested: Boolean(job.cancel_requested), stopped: Boolean(job.stopped), cleanup: job.cleanup,
      assignment: authority, reservationHeld: !!assignment && this.domains.held(db, assignment.reservation),
      ...(job.state === "succeeded" && job.result ? { result: JSON.parse(job.result) as unknown } : {}),
      createdAt: job.created, updatedAt: job.updated,
    };
  }
  private assignmentView(db: DatabaseSync, row: AssignmentRow): unknown {
    const job = this.job(db, row.application, row.job)!;
    return { id: row.id, claimId: row.claim, domainId: row.domain, sequence: row.sequence, closed: Boolean(row.closed),
      cancelRequested: Boolean(job.cancel_requested), job: JSON.parse(job.submission) as unknown };
  }
  private reportView(db: DatabaseSync, row: AssignmentRow): unknown {
    const job = this.job(db, row.application, row.job)!;
    return { assignmentId: row.id, sequence: row.sequence, state: job.state, cancelRequested: Boolean(job.cancel_requested),
      stopped: Boolean(job.stopped), cleanup: job.cleanup, released: !this.domains.held(db, row.reservation) };
  }
}
