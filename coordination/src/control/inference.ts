import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { updateDraining } from "../updates/drain.ts";
import { readFileSync, statfsSync } from "node:fs";
import { platform } from "node:os";
import type { DatabaseSync } from "node:sqlite";
import { Accounts } from "../accounts.ts";
import { CapacityLedger } from "../capacity.ts";
import { identifier } from "../consumers.ts";
import type { Resources } from "../consumers.ts";
import { object, ServiceError } from "../errors.ts";
import { modelIdentity, modelJobCanRelease, modelReceiptMatches, parseModelJob } from "../model-job.ts";
import type { GenerationResult, ModelJob, ModelJobState } from "../model-job.ts";
import { resources } from "../resource-domains.ts";
import type { SqliteStore } from "../sqlite.ts";
import { requireAdmin } from "./contracts.ts";
import type { ControlModule, ControlOptions } from "./contracts.ts";

const terminal = (state: string): boolean => ["succeeded", "failed", "cancelled"].includes(state);
const rank = (state: string): number => state === "queued" || state === "waitingForResources" ? 0 : state === "running" ? 1 : state === "unknown" ? 2 : 3;
const keys = ["cpu", "memoryMiB", "diskGiB"] as const;
const placeholderDigest = `sha256:${"0".repeat(64)}`;
export const MiB = 1024 ** 2, GiB = 1024 ** 3;
export const INFERENCE_LEASE_SECONDS = 30;

export interface InferenceModel { id: string; digest: string; capability: "generation"; resources: Resources }
export interface InferenceOffer { runtime: "ollama"; models: InferenceModel[] }
export interface InferenceRequest { id: string; model: string; prompt: string; maxTokens: number; digest?: string; hostId?: string }
export interface InferenceReport {
  state: ModelJobState; detail?: string; result?: GenerationResult;
  stopped?: boolean; cleanup?: "pending" | "complete"; cancelRequested?: boolean; sequence?: number;
}
export interface InferenceJob {
  id: string; hostId: string; model: string; definition: InferenceModel; desired: "running" | "cancelled";
  state: ModelJobState; detail: string; updatedAt: number; stopped: boolean; cleanup: "pending" | "complete";
  reservationHeld: boolean; sequence: number; result?: GenerationResult;
}
export interface InferenceAssignment extends InferenceJob { request: InferenceRequest }
interface JobRow {
  id: string; request: string; host: string; definition: string; desired: "running" | "cancelled";
  state: ModelJobState; detail: string; result: string | null; updated: number; created: number; seen?: number;
}
interface ReceiptRow { report: string; sequence: number }
interface NormalReport {
  state: ModelJobState; detail: string; stopped: boolean; cleanup: "pending" | "complete";
  cancelRequested: boolean; result?: GenerationResult;
}

function fields(value: Record<string, unknown>, required: string[], optional: string[] = []): void {
  if (required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => ![...required, ...optional].includes(key))) {
    throw new ServiceError("Invalid inference fields.", 400);
  }
}
function inTransaction(db: DatabaseSync): void {
  if (!db.isTransaction) throw new TypeError("Inference requires the caller's admission/heartbeat transaction.");
}
// Preserve the legacy ensure_ascii JSON bounds, including separator whitespace.
function encoded(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(encoded).join(", ")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).map(([key, item]) => `${encoded(key)}: ${encoded(item)}`).join(", ")}}`;
  return JSON.stringify(value).replace(/[\u007f-\uffff]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/** Public inventory excludes executable/model-directory paths and accepts no remote aliases. */
export function inferenceOffer(value: unknown): InferenceOffer {
  const offer = object(value);
  if (offer.runtime !== "ollama" || !Array.isArray(offer.models) || offer.models.length < 1 || offer.models.length > 100) {
    throw new ServiceError("Offer 1 to 100 installed ollama generation models.", 400);
  }
  const models = offer.models.map(value => {
    const model = object(value);
    if (!modelIdentity(model.id, model.digest) || (Object.hasOwn(model, "capability") && model.capability !== "generation")) {
      throw new ServiceError("Models require an exact local generation tag and pinned sha256 digest.", 400);
    }
    return { id: model.id as string, digest: model.digest as string, capability: "generation" as const, resources: resources(model.resources) };
  });
  if (new Set(models.map(model => model.id)).size !== models.length) throw new ServiceError("Model IDs must be unique within a host offer.", 400);
  return { runtime: "ollama", models };
}

export function inferenceRequest(value: unknown): InferenceRequest {
  const input = object(value);
  fields(input, ["id", "model", "prompt"], ["maxTokens", "digest", "hostId"]);
  const id = identifier(input.id), digest = Object.hasOwn(input, "digest") ? input.digest : placeholderDigest;
  let parsed: ModelJob;
  try {
    parsed = parseModelJob({ version: 1, applicationId: id, id, message: {
      type: "submit", adapter: "ollama", model: input.model, digest, prompt: input.prompt,
      maxTokens: Object.hasOwn(input, "maxTokens") ? input.maxTokens : 600,
    } });
  } catch { throw new ServiceError("Invalid local model, digest, prompt or token limit.", 400); }
  if (parsed.message.type !== "submit") throw new TypeError("submit");
  if (Buffer.byteLength(encoded(parsed.message.prompt)) > 65536) throw new ServiceError("The JSON-encoded prompt must fit 64 KiB.", 400);
  return { id, model: parsed.message.model, prompt: parsed.message.prompt, maxTokens: parsed.message.maxTokens,
    ...(Object.hasOwn(input, "digest") ? { digest: parsed.message.digest } : {}),
    ...(Object.hasOwn(input, "hostId") ? { hostId: identifier(input.hostId) } : {}) };
}

/** Local adapter envelope only. This host ID grants no application/model-job authority. */
export function inferenceSubmission(job: Pick<InferenceAssignment, "id" | "hostId" | "request" | "definition">): ModelJob {
  const request = inferenceRequest(job.request);
  const definition = inferenceOffer({ runtime: "ollama", models: [job.definition] }).models[0]!;
  if (request.id !== job.id || request.model !== definition.id ||
      (request.digest !== undefined && request.digest !== definition.digest) ||
      (request.hostId !== undefined && request.hostId !== job.hostId)) throw new ServiceError("Inference assignment does not match its pinned request.", 409);
  return parseModelJob({ version: 1, applicationId: job.hostId, id: job.id, message: {
    type: "submit", adapter: "ollama", model: definition.id, digest: definition.digest,
    prompt: request.prompt, maxTokens: request.maxTokens,
  } });
}

function normalizeReport(value: unknown, row: JobRow): NormalReport {
  const input = object(value);
  fields(input, ["state"], ["detail", "result", "stopped", "cleanup", "cancelRequested", "sequence"]);
  const detail = Object.hasOwn(input, "detail") ? input.detail : "";
  if (typeof detail !== "string" || Array.from(detail).length > 2000) throw new ServiceError("Invalid inference detail.", 400);
  // A legacy terminal word alone is not positive process-stop and cleanup evidence.
  if (typeof input.state === "string" && terminal(input.state) && (!Object.hasOwn(input, "stopped") || !Object.hasOwn(input, "cleanup"))) {
    throw new ServiceError("Terminal inference reports require explicit stop and cleanup evidence.", 400);
  }
  let receipt: ModelJob;
  try {
    receipt = parseModelJob({ version: 1, applicationId: row.host, id: row.id, message: {
      type: "receipt", state: input.state, cancelRequested: Object.hasOwn(input, "cancelRequested") ? input.cancelRequested : input.state === "cancelled",
      stopped: Object.hasOwn(input, "stopped") ? input.stopped : false, cleanup: Object.hasOwn(input, "cleanup") ? input.cleanup : "pending",
      ...(Object.hasOwn(input, "result") ? { result: input.result } : {}),
    } });
  } catch { throw new ServiceError("Invalid inference receipt or measured result.", 400); }
  if (receipt.message.type !== "receipt") throw new TypeError("receipt");
  const message = receipt.message;
  if (message.cancelRequested && row.desired !== "cancelled") throw new ServiceError("Cancellation was not requested for this inference job.", 409);
  if (message.result && (message.result.model !== (JSON.parse(row.request) as InferenceRequest).model || Buffer.byteLength(encoded(message.result)) > 262144)) {
    throw new ServiceError("Invalid inference result identity or encoded size.", 400);
  }
  const result = message.result ? { model: message.result.model, text: message.result.text,
    usage: { inputTokens: message.result.usage.inputTokens, outputTokens: message.result.usage.outputTokens } } : undefined;
  return { state: message.state, detail, stopped: message.stopped, cleanup: message.cleanup,
    cancelRequested: message.cancelRequested, ...(result ? { result } : {}) };
}
function released(report: NormalReport): boolean { return terminal(report.state) && report.stopped && report.cleanup === "complete"; }
function currentReceipt(db: DatabaseSync, row: JobRow, includeResult = true): { report: NormalReport; sequence: number } {
  const receipt = db.prepare(`SELECT ${includeResult ? "report" : "json_remove(report,'$.result') AS report"},sequence FROM inference_control_receipts WHERE job=?`).get(row.id) as unknown as ReceiptRow | undefined;
  return receipt ? { report: JSON.parse(receipt.report) as NormalReport, sequence: receipt.sequence } : {
    report: { state: row.state, detail: row.detail, stopped: false, cleanup: "pending", cancelRequested: false }, sequence: 0,
  };
}

/** Only owns inference tables. The legacy host/VM/image capacity tables belong to their controllers. */
function compatibleInferenceSchema(db: DatabaseSync): boolean {
  const columns = new Set(db.prepare("PRAGMA table_info(inference_jobs)").all().map(column => column.name));
  return ["id", "request", "host", "definition", "desired", "state", "detail", "result", "updated", "created"].every(column => columns.has(column));
}
function unavailableSchema(): never {
  throw new ServiceError("Legacy inference is unavailable for this opaque inference_jobs schema; its rows were not adopted.", 503, { retryable: false });
}

/** Returns false for opaque legacy tables without reading, altering or adopting their rows. */
export function initializeInference(db: DatabaseSync): boolean {
  inTransaction(db);
  db.exec("CREATE TABLE IF NOT EXISTS inference_jobs (id TEXT PRIMARY KEY, request TEXT NOT NULL, host TEXT NOT NULL, definition TEXT NOT NULL, desired TEXT NOT NULL, state TEXT NOT NULL, detail TEXT NOT NULL, result TEXT, updated REAL NOT NULL, created REAL NOT NULL)");
  if (!compatibleInferenceSchema(db)) return false;
  db.exec(`CREATE INDEX IF NOT EXISTS inference_jobs_host_state ON inference_jobs(host,state);
    CREATE TABLE IF NOT EXISTS inference_control_receipts (job TEXT PRIMARY KEY, report TEXT NOT NULL, sequence INTEGER NOT NULL);
    UPDATE inference_jobs SET state='unknown',result=NULL,detail='Legacy terminal outcome has no explicit stop/cleanup receipt; operator reconciliation is required.'
      WHERE state IN ('succeeded','failed','cancelled') AND id NOT IN (SELECT job FROM inference_control_receipts);`);
  return true;
}
function jobView(db: DatabaseSync, row: JobRow, now: number, assignment = false, includeResult = true): InferenceJob | InferenceAssignment {
  const { report, sequence } = currentReceipt(db, row, includeResult && !assignment), held = !released(report);
  const result: InferenceJob = { id: row.id, hostId: row.host, model: (JSON.parse(row.request) as InferenceRequest).model,
    definition: inferenceOffer({ runtime: "ollama", models: [JSON.parse(row.definition)] }).models[0]!, desired: row.desired,
    state: !assignment && held && !terminal(report.state) && (row.seen === undefined || now - row.seen >= INFERENCE_LEASE_SECONDS) ? "unknown" : report.state,
    detail: report.detail, updatedAt: row.updated, stopped: report.stopped, cleanup: report.cleanup, reservationHeld: held, sequence,
    ...(includeResult && !assignment && report.state === "succeeded" && report.result ? { result: report.result } : {}) };
  return assignment ? { ...result, request: JSON.parse(row.request) as InferenceRequest } : result;
}

/** Caller must authenticate the current host credential in this SAME transaction first. FIFO is row insertion order. */
export function assignedInferenceJobs(db: DatabaseSync, hostId: string, now: number): InferenceAssignment[] {
  inTransaction(db);
  // Opaque rows belong to another slice and are never emitted as executable assignments.
  if (!compatibleInferenceSchema(db)) return [];
  return (db.prepare("SELECT * FROM inference_jobs WHERE host=? AND state NOT IN ('succeeded','failed','cancelled') ORDER BY rowid").all(identifier(hostId)) as unknown as JobRow[])
    .map(row => jobView(db, row, now, true) as InferenceAssignment);
}

/** Heartbeat hook. Authenticate the current host in this transaction before calling.
 * Throwing rolls back the caller's VM/host updates too; never catch and commit this error.
 */
export function reportInferenceJobs(db: DatabaseSync, hostId: string, value: unknown, now: number): void {
  inTransaction(db);
  const host = identifier(hostId), reports = object(value);
  if (Object.keys(reports).length > 32) throw new ServiceError("At most 32 inference reports are allowed.", 400);
  if (!compatibleInferenceSchema(db)) {
    if (Object.keys(reports).length) unavailableSchema();
    return;
  }
  for (const [id, input] of Object.entries(reports)) {
    const row = db.prepare("SELECT * FROM inference_jobs WHERE id=?").get(identifier(id)) as unknown as JobRow | undefined;
    if (!row || row.host !== host) throw new ServiceError("Cannot report inference assigned to another host.", 403);
    const next = normalizeReport(input, row), previous = currentReceipt(db, row);
    const suppliedSequence = object(input).sequence;
    if (suppliedSequence !== undefined && (typeof suppliedSequence !== "number" || !Number.isSafeInteger(suppliedSequence) || suppliedSequence < 1)) throw new ServiceError("Invalid inference report sequence.", 400);
    const same = JSON.stringify(next) === JSON.stringify(previous.report);
    if (same && (suppliedSequence === undefined || suppliedSequence === previous.sequence)) continue;
    if ((suppliedSequence !== undefined && suppliedSequence !== previous.sequence + 1) || released(previous.report)) throw new ServiceError("Conflicting, stale or closed inference receipt.", 409);
    if (terminal(previous.report.state)) {
      if (next.state !== previous.report.state || JSON.stringify(next.result) !== JSON.stringify(previous.report.result) ||
          (previous.report.stopped && !next.stopped) || (previous.report.cleanup === "complete" && next.cleanup !== "complete")) {
        throw new ServiceError("Terminal inference outcomes can only add stop and cleanup evidence.", 409);
      }
    } else if (rank(next.state) < rank(previous.report.state)) throw new ServiceError("Inference receipts cannot regress or replay unknown work.", 409);
    if (["running", "succeeded"].includes(next.state) && !terminal(previous.report.state) &&
        db.prepare("SELECT 1 FROM inference_jobs WHERE host=? AND rowid<(SELECT rowid FROM inference_jobs WHERE id=?) AND state NOT IN ('succeeded','failed','cancelled') LIMIT 1").get(host, row.id)) {
      throw new ServiceError("Inference execution must preserve assignment FIFO.", 409);
    }
    const sequence = suppliedSequence === undefined ? previous.sequence + 1 : suppliedSequence as number;
    db.prepare("INSERT INTO inference_control_receipts VALUES (?,?,?) ON CONFLICT(job) DO UPDATE SET report=excluded.report,sequence=excluded.sequence").run(row.id, JSON.stringify(next), sequence);
    // CapacityLedger reads this exact legacy table. Keep partial terminal evidence charged as unknown.
    db.prepare("UPDATE inference_jobs SET state=?,detail=?,result=?,updated=? WHERE id=?")
      .run(terminal(next.state) && !released(next) ? "unknown" : next.state, next.detail, next.result ? JSON.stringify(next.result) : null, now, row.id);
  }
}

/** Shared accounting hook for hosts that do not use CapacityLedger directly. */
export function inferenceUsed(db: DatabaseSync, hostId: string): Resources {
  inTransaction(db);
  if (!compatibleInferenceSchema(db)) unavailableSchema();
  const used = { cpu: 0, memoryMiB: 0, diskGiB: 0 };
  for (const row of db.prepare("SELECT definition FROM inference_jobs WHERE host=? AND state NOT IN ('succeeded','failed','cancelled')").all(identifier(hostId))) {
    const amount = resources(object(JSON.parse(String(row.definition))).resources);
    for (const key of keys) {
      used[key] += amount[key];
      if (!Number.isSafeInteger(used[key])) throw new ServiceError("Invalid inference capacity ledger.", 503);
    }
  }
  return used;
}

export function createModule(store: SqliteStore, _options: ControlOptions): ControlModule {
  const ledger = new CapacityLedger(store);
  const accounts = new Accounts(store);
  const available = store.transaction(initializeInference);
  return { handle(request) {
    const { method, path, parts } = request;
    const models = path === "/v1/models" && method === "GET";
    const collection = path === "/v1/jobs" && ["GET", "POST"].includes(method);
    const inspect = parts.length === 3 && parts[0] === "v1" && parts[1] === "jobs" && method === "GET";
    const cancel = parts.length === 4 && parts[0] === "v1" && parts[1] === "jobs" && parts[3] === "cancel" && method === "POST";
    if (!models && !collection && !inspect && !cancel) return undefined;
    const authenticated = requireAdmin(request);
    return store.transaction(db => {
      // principal() may open its own transaction. Human authority is checked again
      // on THIS connection so committed revocation/demotion wins without nesting.
      requireAdmin({ ...request, principal: () => authenticated.kind === "operator" ? authenticated : accounts.principalDb(db, request.token) });
      if (!available) unavailableSchema();
      try {
        if (models) {
          const inventory = db.prepare("SELECT * FROM hosts WHERE id NOT IN (SELECT id FROM retired_runners) ORDER BY id").all() as unknown as Array<{ id: string; offer: string; seen: number; enabled: number }>;
          return { body: { models: inventory.flatMap(host => {
            const offer = object(JSON.parse(host.offer));
            return offer.inference === undefined ? [] : inferenceOffer(offer.inference).models.map(model => ({ ...model, hostId: host.id, online: store.clock() - host.seen < INFERENCE_LEASE_SECONDS, accepting: Boolean(host.enabled) }));
          }) } };
        }
        if (collection && method === "POST") {
          const input = inferenceRequest(request.body);
          const old = db.prepare("SELECT j.*,h.seen FROM inference_jobs j LEFT JOIN hosts h ON h.id=j.host WHERE j.id=?").get(input.id) as unknown as JobRow | undefined;
          if (old) {
            if (JSON.stringify(inferenceRequest(JSON.parse(old.request))) !== JSON.stringify(input)) throw new ServiceError("Request identity is already used for another inference specification.", 409);
            return { body: jobView(db, old, store.clock()) };
          }
          const candidates: Array<{ score: number; host: string; model: InferenceModel }> = [];
          const hosts = db.prepare("SELECT * FROM hosts WHERE enabled=1 AND id NOT IN (SELECT id FROM retired_runners) ORDER BY id").all() as unknown as Array<{ id: string; offer: string; seen: number }>;
          for (const host of hosts) {
            if (updateDraining(db, host.id)) continue;
            if (store.clock() - host.seen >= INFERENCE_LEASE_SECONDS || (input.hostId !== undefined && input.hostId !== host.id)) continue;
            const offer = object(JSON.parse(host.offer));
            if (offer.inference === undefined) continue;
            if (!["native", "apple", "libvirt"].includes(String(offer.provider))) throw new ServiceError("Embedded inference requires a native Mac or Linux host offer.", 409);
            if (Number(db.prepare("SELECT count(*) AS n FROM inference_jobs WHERE host=? AND state NOT IN ('succeeded','failed','cancelled')").get(host.id)!.n) >= 32) continue;
            const remaining = ledger.remaining(db, host.id), used = ledger.used(db, host.id), capacity = resources(offer.capacity);
            for (const model of inferenceOffer(offer.inference).models) {
              if (model.id === input.model && (input.digest === undefined || input.digest === model.digest) && keys.every(key => model.resources[key] <= remaining[key])) {
                candidates.push({ score: used.memoryMiB / capacity.memoryMiB, host: host.id, model });
              }
            }
          }
          if (!candidates.length) throw new ServiceError("No online accepting host offers this model and enough unreserved capacity.", 409);
          if (input.digest === undefined && new Set(candidates.map(candidate => candidate.model.digest)).size > 1) throw new ServiceError("Multiple model digests are available; choose digest explicitly.", 409);
          candidates.sort((a, b) => a.score - b.score || (a.host < b.host ? -1 : a.host > b.host ? 1 : 0));
          const chosen = candidates[0]!, now = store.clock();
          db.prepare("INSERT INTO inference_jobs VALUES (?,?,?,?,'running','queued','',NULL,?,?)").run(input.id, JSON.stringify(input), chosen.host, JSON.stringify(chosen.model), now, now);
          const row = db.prepare("SELECT j.*,h.seen FROM inference_jobs j JOIN hosts h ON h.id=j.host WHERE j.id=?").get(input.id) as unknown as JobRow;
          return { body: jobView(db, row, now) };
        }
        if (cancel) {
          fields(request.body, []);
          const id = identifier(parts[2]);
          if (!db.prepare("SELECT 1 FROM inference_jobs WHERE id=?").get(id)) throw new ServiceError("Unknown inference job.", 404);
          db.prepare("UPDATE inference_jobs SET desired='cancelled',updated=? WHERE id=? AND state NOT IN ('succeeded','failed','cancelled')").run(store.clock(), id);
        }
        if (inspect || cancel) {
          const row = db.prepare("SELECT j.*,h.seen FROM inference_jobs j LEFT JOIN hosts h ON h.id=j.host WHERE j.id=?").get(identifier(parts[2])) as unknown as JobRow | undefined;
          if (!row) throw new ServiceError("Unknown inference job.", 404);
          return { body: jobView(db, row, store.clock()) };
        }
        const rows = db.prepare("SELECT j.id,j.host,j.request,j.definition,j.desired,j.state,j.detail,NULL AS result,j.updated,j.created,h.seen FROM inference_jobs j LEFT JOIN hosts h ON h.id=j.host ORDER BY j.rowid DESC LIMIT 100").all() as unknown as JobRow[];
        return { body: { jobs: rows.map(row => jobView(db, row, store.clock(), false, false)) } };
      } catch (error) {
        if (error instanceof Error && /no such (table|column)/.test(error.message)) throw new ServiceError("Inference requires the integrated host, VM, image and capacity ledgers.", 503, { retryable: false });
        throw error;
      }
    });
  } };
}

export interface MemorySample { physical: number; available: number; normal: boolean; written: number }
function sampleValid(sample: MemorySample): MemorySample {
  if (![sample.physical, sample.available, sample.written].every(n => Number.isSafeInteger(n) && n >= 0) || sample.physical <= 0 || sample.available > sample.physical || typeof sample.normal !== "boolean") throw new Error("Invalid host memory telemetry.");
  return sample;
}
export function macMemorySample(vmstat: string, physical: number, pressure: number): MemorySample {
  const page = Number(/page size of (\d+) bytes/.exec(vmstat)?.[1]);
  if (!Number.isSafeInteger(page) || page < 1) throw new Error("Invalid memory page size.");
  const counts = new Map([...vmstat.matchAll(/^(.+?):\s+(\d+)\./gm)].map(match => [match[1]!, Number(match[2])]));
  const count = (key: string): number => {
    const n = counts.get(key);
    if (n === undefined || !Number.isSafeInteger(n) || n < 0) throw new Error("Missing memory counter.");
    return n;
  };
  const capacity = Math.max(0, physical - page * (count("Pages wired down") + count("Pages occupied by compressor")));
  const free = Math.min(page * count("Pages free"), capacity);
  const cache = Math.min(page * Math.max(0, count("File-backed pages") - count("Pages speculative")), capacity - free);
  const purgeable = Math.min(page * count("Pages purgeable"), capacity - free - cache);
  if (!Number.isFinite(pressure)) throw new Error("Missing memory pressure.");
  return sampleValid({ physical, available: free + cache + purgeable, normal: pressure === 1, written: count("Swapouts") * page });
}
export function linuxMemorySample(meminfo: string, vmstat: string, page: number): MemorySample {
  const info = new Map([...meminfo.matchAll(/^(\w+):\s+(\d+) kB/gm)].map(match => [match[1], Number(match[2]) * 1024]));
  const physical = info.get("MemTotal")!, available = info.get("MemAvailable")!;
  const swap = /(?:^|\n)pswpout\s+(\d+)(?:\n|$)/.exec(vmstat)?.[1];
  if (swap === undefined || !Number.isSafeInteger(page) || page < 1) throw new Error("Missing swap counter or page size.");
  return sampleValid({ physical, available, normal: available >= Math.max(2 * GiB, Math.floor(physical / 10)), written: Number(swap) * page });
}
/** Invoked only by an explicitly configured runner, never by controller admission. */
export function memorySample(): MemorySample {
  const command = (path: string, args: string[]): string => execFileSync(path, args, { timeout: 3000, maxBuffer: MiB, encoding: "utf8", env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LC_ALL: "C" }, stdio: ["ignore", "pipe", "pipe"] });
  if (platform() === "darwin") return macMemorySample(command("/usr/bin/vm_stat", []), Number(command("/usr/sbin/sysctl", ["-n", "hw.memsize"])), Number(command("/usr/sbin/sysctl", ["-n", "kern.memorystatus_vm_pressure_level"])));
  if (platform() === "linux") return linuxMemorySample(readFileSync("/proc/meminfo", "utf8"), readFileSync("/proc/vmstat", "utf8"), Number(command("/usr/bin/getconf", ["PAGESIZE"])));
  throw new Error("Host memory admission supports Mac and Linux only.");
}

/** Cache-aware estimates, not an OS reservation or native fit evidence. Missing telemetry blocks work. */
export class ResourceGuard {
  private history: Array<{ time: number; written: number }> = [];
  constructor(readonly directory: string, readonly sample: () => MemorySample = memorySample,
    readonly clock: () => number = () => performance.now() / 1000,
    readonly freeDisk: () => number = () => { const stat = statfsSync(directory); return stat.bavail * stat.bsize; }) {}
  restriction(budgetMiB: number, running = false): string | undefined {
    try {
      const sample = sampleValid(this.sample()), now = this.clock();
      if (!Number.isSafeInteger(budgetMiB) || budgetMiB < 1 || !Number.isFinite(now) || now < 0) throw new Error("Invalid admission sample.");
      const last = this.history.at(-1);
      if (last && (sample.written < last.written || now < last.time)) this.history = [];
      // At most one bucket per second keeps a 30-second baseline even under fast polling.
      const previous = this.history.at(-1);
      if (!previous || Math.floor(previous.time) !== Math.floor(now)) this.history.push({ time: now, written: sample.written });
      while (this.history.length > 1 && this.history[1]!.time <= now - 30) this.history.shift();
      if (this.history.length < 2) return "Collecting a baseline for active swap traffic.";
      if (!sample.normal) return "Waiting for normal system memory pressure.";
      if (sample.written - this.history[0]!.written >= 32 * MiB) return "Waiting for SSD swap activity to settle.";
      if (sample.available < Math.max(2 * GiB, Math.floor(sample.physical / 10)) + (running ? 0 : budgetMiB * MiB)) return "Waiting for RAM after reclaimable cache and system headroom.";
      const disk = this.freeDisk();
      if (!Number.isFinite(disk) || disk < 0) throw new Error("Invalid disk telemetry.");
      if (disk < 2 * GiB) return "Waiting for at least 2 GiB of free disk space.";
      return undefined;
    } catch { return "Host memory or disk telemetry is unavailable."; }
  }
}

/** Adapter must use owned execution with a durable launch journal, no pull/retry, isolated
 * credentials/environment, pinned local inventory and positive process-group cleanup.
 * Existing Rust model-execution implements that execution boundary for model-job routes;
 * its standalone HTTP loop does not consume these legacy heartbeat assignments.
 */
export interface InferenceExecutor {
  execute(submission: ModelJob, control: () => "continue" | "cancel" | "fence", restriction: () => string | undefined): Promise<ModelJob>;
}
interface RunnerReceipt { fingerprint: string; report: string }

/** Portable legacy runner state machine. A real executor is explicit; no subprocess or
 * network fallback exists here. Keep this private runner store separate from controller state.
 */
export class InferenceRunner {
  private busy = false;
  private waiting = new Map<string, number>();
  constructor(readonly store: SqliteStore, readonly models: InferenceModel[], readonly guard: ResourceGuard,
    readonly executor?: InferenceExecutor, readonly clock: () => number = () => performance.now() / 1000) {
    store.transaction(db => db.exec("CREATE TABLE IF NOT EXISTS inference_runner_receipts (job TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, report TEXT NOT NULL)"));
  }
  private save(id: string, fingerprint: string, report: InferenceReport): void {
    this.store.transaction(db => db.prepare("INSERT INTO inference_runner_receipts VALUES (?,?,?) ON CONFLICT(job) DO UPDATE SET report=excluded.report WHERE fingerprint=excluded.fingerprint").run(id, fingerprint, JSON.stringify(report)));
  }
  async reconcile(job: InferenceAssignment, control: () => "continue" | "cancel" | "fence", started: () => void = () => {}): Promise<InferenceReport> {
    if (this.busy) throw new ServiceError("Inference execution is already in progress.", 409);
    this.busy = true;
    try {
      const submission = inferenceSubmission(job);
      const fingerprint = createHash("sha256").update(JSON.stringify({ host: job.hostId, request: inferenceRequest(job.request), definition: inferenceOffer({ runtime: "ollama", models: [job.definition] }).models[0] })).digest("hex");
      const previous = this.store.transaction(db => db.prepare("SELECT * FROM inference_runner_receipts WHERE job=?").get(job.id) as unknown as RunnerReceipt | undefined);
      if (previous) {
        if (previous.fingerprint !== fingerprint) return { state: "unknown", detail: "Local inference identity conflicts with the assignment.", stopped: false, cleanup: "pending" };
        const report = JSON.parse(previous.report) as InferenceReport;
        if (terminal(report.state)) return report;
        return { state: "unknown", detail: "Previous inference outcome is uncertain. Fence the old runtime; this job will not be replayed.", stopped: false, cleanup: "pending" };
      }
      let cancelRequested = job.desired === "cancelled";
      const checkedControl = (): "continue" | "cancel" | "fence" => {
        const signal = control();
        if (signal === "cancel") cancelRequested = true;
        return signal;
      };
      const signal = checkedControl();
      if (signal === "fence") return { state: "waitingForResources", detail: "Controller contact is not fresh; no runtime was started." };
      let report: InferenceReport | undefined;
      if (job.desired === "cancelled" || signal === "cancel") {
        report = { state: "cancelled", cancelRequested: true, stopped: true, cleanup: "complete" };
      } else if (!this.models.some(model => JSON.stringify(inferenceOffer({ runtime: "ollama", models: [model] }).models[0]) === JSON.stringify(inferenceOffer({ runtime: "ollama", models: [job.definition] }).models[0]))) {
        report = { state: "failed", detail: "The pinned model contract is no longer installed on this host.", stopped: true, cleanup: "complete" };
      } else if (!this.executor) {
        return { state: "waitingForResources", detail: "Owned model execution adapter is not configured; no runtime was started." };
      } else {
        const reason = this.guard.restriction(job.definition.resources.memoryMiB);
        if (reason) {
          const now = this.clock(), since = this.waiting.get(job.id) ?? now;
          this.waiting.set(job.id, since);
          if (now - since < 600) return { state: "waitingForResources", detail: reason };
          report = { state: "failed", detail: `Resource wait expired: ${reason}`, stopped: true, cleanup: "complete" };
        }
      }
      // The unique insert arbitrates concurrent runner processes before any launch or receipt.
      const won = this.store.transaction(db => db.prepare("INSERT OR IGNORE INTO inference_runner_receipts VALUES (?,?,?)").run(job.id, fingerprint, JSON.stringify(report ?? { state: "running" })).changes);
      if (!won) return { state: "unknown", detail: "Another runner invocation owns the durable inference receipt.", stopped: false, cleanup: "pending" };
      if (!report) {
        try {
          started();
          const receipt = parseModelJob(await this.executor!.execute(submission, checkedControl, () => this.guard.restriction(job.definition.resources.memoryMiB, true)));
          if (!modelReceiptMatches(submission, receipt) || receipt.message.type !== "receipt") throw new Error("Execution receipt identity mismatch.");
          const message = receipt.message;
          if (!terminal(message.state) && message.state !== "unknown") throw new Error("Execution returned without a durable outcome.");
          report = normalizeReport({ state: message.state, stopped: message.stopped, cleanup: message.cleanup, cancelRequested: message.cancelRequested,
            ...(message.result ? { result: message.result } : {}) }, { id: job.id, host: job.hostId, desired: cancelRequested ? "cancelled" : "running", request: JSON.stringify(job.request) } as JobRow);
          if (message.state === "succeeded" && !modelJobCanRelease(receipt)) report.detail = "Generation returned, but process stop or cleanup remains unconfirmed.";
        } catch { report = { state: "unknown", detail: "Execution or cleanup is uncertain; inspect the durable owned executor journal.", stopped: false, cleanup: "pending" }; }
      }
      this.waiting.delete(job.id);
      this.save(job.id, fingerprint, report);
      return report;
    } finally { this.busy = false; }
  }

  /** One job per worker turn. A prior launch with no terminal receipt blocks new work. */
  async work(jobs: InferenceAssignment[], control: (job: InferenceAssignment) => "continue" | "cancel" | "fence"): Promise<{ id: string; report: InferenceReport } | undefined> {
    const uncertain = this.store.transaction(db => db.prepare("SELECT job,report FROM inference_runner_receipts").all().find(row => {
      const report = JSON.parse(String(row.report)) as InferenceReport;
      return !terminal(report.state) || !report.stopped || report.cleanup !== "complete";
    }));
    if (uncertain) {
      const job = jobs.find(job => job.id === uncertain.job);
      return job ? { id: job.id, report: await this.reconcile(job, () => control(job)) } : undefined;
    }
    const pending = jobs.filter(job => job.reservationHeld);
    const next = pending.find(job => job.desired === "cancelled") ?? pending[0];
    return next ? { id: next.id, report: await this.reconcile(next, () => control(next)) } : undefined;
  }
}
