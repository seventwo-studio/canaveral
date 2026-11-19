import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { object, ServiceError } from "./errors.ts";
import { modelAdapter, parseModelJob } from "./model-job.ts";
import type { ModelJob } from "./model-job.ts";
import { resources, ResourceDomains } from "./resource-domains.ts";
import type { Resources } from "./consumers.ts";

/** Model-job tables and the per-runner model-claim turns. Every statement is idempotent so either worker may run it first. */
export function modelJobSchema(db: DatabaseSync): void {
  ResourceDomains.schema(db);
  // Interim builds of this change used a single global turn. The turn is disposable state.
  const scheduler = db.prepare("PRAGMA table_info(model_job_scheduler)").all() as Array<{ name: string }>;
  if (scheduler.length && !scheduler.some(column => column.name === "runner")) db.exec("DROP TABLE model_job_scheduler");
  db.exec(`CREATE TABLE IF NOT EXISTS model_catalog (model TEXT NOT NULL, digest TEXT NOT NULL, adapter TEXT NOT NULL, resources TEXT NOT NULL, created REAL NOT NULL, PRIMARY KEY(model,digest));
    CREATE TABLE IF NOT EXISTS model_grants (application TEXT NOT NULL, model TEXT NOT NULL, digest TEXT NOT NULL, max_unfinished INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0, created REAL NOT NULL, PRIMARY KEY(application,model,digest));
    CREATE TABLE IF NOT EXISTS model_runner_approvals (controller TEXT NOT NULL, runner TEXT NOT NULL, generation INTEGER NOT NULL, incarnation TEXT NOT NULL, domain TEXT NOT NULL, models TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0, created REAL NOT NULL, PRIMARY KEY(controller,runner,generation));
    CREATE TABLE IF NOT EXISTS model_jobs (application TEXT NOT NULL, id TEXT NOT NULL, submission TEXT NOT NULL, model TEXT NOT NULL, digest TEXT NOT NULL, state TEXT NOT NULL, cancel_requested INTEGER NOT NULL DEFAULT 0, stopped INTEGER NOT NULL DEFAULT 0, cleanup TEXT NOT NULL DEFAULT 'pending', result TEXT, closed INTEGER NOT NULL DEFAULT 0, created REAL NOT NULL, updated REAL NOT NULL, PRIMARY KEY(application,id));
    CREATE INDEX IF NOT EXISTS model_jobs_open ON model_jobs(closed,state,created);
    CREATE INDEX IF NOT EXISTS model_jobs_group ON model_jobs(application,model,digest,closed);
    CREATE TABLE IF NOT EXISTS model_assignments (id TEXT PRIMARY KEY, claim TEXT NOT NULL UNIQUE, application TEXT NOT NULL, job TEXT NOT NULL, controller TEXT NOT NULL, runner TEXT NOT NULL, generation INTEGER NOT NULL, incarnation TEXT NOT NULL, domain TEXT NOT NULL, reservation TEXT NOT NULL UNIQUE, sequence INTEGER NOT NULL DEFAULT 0, report TEXT, closed INTEGER NOT NULL DEFAULT 0, created REAL NOT NULL, UNIQUE(application,job));
    CREATE INDEX IF NOT EXISTS model_assignments_binding ON model_assignments(controller,runner,generation,closed);
    CREATE TABLE IF NOT EXISTS model_job_scheduler (runner TEXT PRIMARY KEY, turn TEXT NOT NULL);`);
}

export { cancelModelJob, closeAllRevokedModelJobs, closeRevokedModelJobs, expireModelRequest, expireModelRequests, settleModelRequests } from "./model-settlement.ts";
const table = (db: DatabaseSync, name: string): boolean => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
const INTENT_FIELDS = ["adapter", "model", "digest", "prompt", "maxTokens"];

/** Queued model-call intent is exactly the model-job/1 submit message without `type`. Pure shape check. */
export function modelRequestIntent(value: unknown): Record<string, unknown> {
  const input = object(value);
  if (Object.keys(input).length !== INTENT_FIELDS.length || INTENT_FIELDS.some(key => !Object.hasOwn(input, key))) {
    throw new ServiceError("Model-job intent requires exactly adapter, model, digest, prompt and maxTokens.", 400);
  }
  try {
    parseModelJob({ version: 1, applicationId: "00000000-0000-4000-8000-000000000000", id: "00000000-0000-4000-8000-000000000000",
      message: { type: "submit", adapter: input.adapter, model: input.model, digest: input.digest, prompt: input.prompt, maxTokens: input.maxTokens } });
  } catch { throw new ServiceError("Invalid model-job intent.", 400); }
  return { adapter: input.adapter, model: input.model, digest: input.digest, prompt: input.prompt, maxTokens: input.maxTokens };
}

/** The stored and returned request intent: the prompt is replaced by its SHA-256 digest, so request views never
 * echo it while exact replay still compares it. The job record keeps the prompt for the runner.
 */
export function modelRequestRecord(intent: Record<string, unknown>): Record<string, unknown> {
  const promptDigest = "sha256:" + createHash("sha256").update(String(intent.prompt), "utf8").digest("hex");
  return { adapter: intent.adapter, model: intent.model, digest: intent.digest, promptDigest, maxTokens: intent.maxTokens };
}

/** Same grant and catalog checks as direct submission. Returns the pinned catalog resources. */
export function modelGrantResources(db: DatabaseSync, application: string, model: string, digest: string, adapter: unknown): Resources {
  const grant = db.prepare("SELECT 1 FROM model_grants WHERE application=? AND model=? AND digest=? AND revoked=0").get(application, model, digest);
  if (!grant) throw new ServiceError("The application has no grant for this pinned model.", 403);
  const catalog = db.prepare("SELECT adapter,resources FROM model_catalog WHERE model=? AND digest=?").get(model, digest) as { adapter: string; resources: string } | undefined;
  if (!catalog || !modelAdapter(adapter) || catalog.adapter !== adapter) throw new ServiceError("Submission adapter does not match its pinned catalog entry.", 409);
  return resources(JSON.parse(catalog.resources) as unknown);
}

/** Inserts the unassigned job for a new queued model-call request in the request's own transaction. */
export function insertQueuedModelJob(db: DatabaseSync, application: string, id: string, intent: Record<string, unknown>, now: number): void {
  const job: ModelJob = parseModelJob({ version: 1, applicationId: application, id, message: { type: "submit", ...intent } });
  if (job.message.type !== "submit") throw new TypeError("submit");
  db.prepare("INSERT INTO model_jobs VALUES (?,?,?,?,?,'queued',0,0,'pending',NULL,0,?,?)").run(application, id, JSON.stringify(job), job.message.model, job.message.digest, now, now);
}

export interface ModelQueueView { state: string; priority: number; deadline: string | null; reason: string | null; admittedAt: string | null }
/** Queue projection for jobs submitted through /v1/requests; direct submissions have none. */
export function modelQueueView(db: DatabaseSync, application: string, id: string): ModelQueueView | undefined {
  if (!table(db, "requests")) return undefined;
  const row = db.prepare("SELECT state,priority,deadline,reason,admitted_at FROM requests WHERE application=? AND id=? AND kind='model-job'").get(application, id) as
    { state: string; priority: number; deadline: number | null; reason: string | null; admitted_at: number | null } | undefined;
  const utc = (n: number | null) => n === null ? null : new Date(n * 1000).toISOString();
  return row ? { state: row.state, priority: row.priority, deadline: utc(row.deadline), reason: row.reason, admittedAt: utc(row.admitted_at) } : undefined;
}
