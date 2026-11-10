import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { ServiceError, object } from "../errors.ts";
import { SqliteStore } from "../sqlite.ts";
import { owns, requireScope } from "./contracts.ts";
import type { ControlModule, ControlOptions, Principal } from "./contracts.ts";
import { registerMachineHooks } from "./machines.ts";
import type { MachineHooks } from "./machines.ts";
import { refreshConsumerOperations } from "./consumer-operations.ts";
import { legacyDigest } from "./templates.ts";
import { decodeData, guestPath, jsonBytes, uuid } from "./transfers.ts";

export const MAX_RESULT = 6 * 1048576;
export const TERMINAL = ["succeeded", "failed", "unknown"] as const;
export type OperationState = typeof TERMINAL[number];
export interface OperationRequest { id: string; action: string; arguments: Record<string, unknown> }
export interface OperationAssignment extends OperationRequest { machineId: string; expiresAt: number; leaseId?: string }
export interface OperationReport { state: OperationState; result: unknown }
export interface OperationReceipt { id: string; machineId: string; hostId: string; state: string; updatedAt: number; result?: unknown }
interface OperationRow { id: string; machine: string; host: string; request: string; state: string; result: string | null; updated: number; created: number }
interface MachineRow { id: string; host: string; owner: string | null; template: string; desired: string; observed: string; seen: number; enabled: number }

const fields: Record<string, readonly string[]> = {
  screenshot: [], hierarchy: [], apps: [], logs: [], accessibility: [],
  tap: ["x", "y"], swipe: ["x", "y", "toX", "toY", "durationMs"], text: ["text"], key: ["key"],
  install: ["artifact"], uninstall: ["app"], launch: ["app"], terminate: ["app"], "open-url": ["url"],
  location: ["latitude", "longitude"], push: ["path", "data"], pull: ["path"], shell: ["argv"],
  permission: ["app", "permission", "state"], rotate: ["orientation"],
  "accessibility-action": ["snapshotId", "nodeId", "nativeAction"], "list-files": ["path"],
  "shell-open": ["session"], "shell-read": ["session", "offset"], "shell-write": ["session", "text"],
  "shell-close": ["session"], "shell-resize": ["session", "rows", "cols"],
};
function string(value: unknown, label: string, maximum = 4096): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || value.includes("\0") || value.startsWith("-")) {
    throw new ServiceError(`Invalid ${label}.`, 400);
  }
  return value;
}
function integer(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) throw new ServiceError(`Invalid ${label}.`, 400);
  return value;
}
export function deviceDefinition(value: unknown, system: string, arch: string): Record<string, string> {
  if (!["android", "ios"].includes(system) || !["arm64", "amd64"].includes(arch)) throw new ServiceError("Unsupported device platform or architecture.", 400);
  const input = object(value), keys = system === "android" ? ["systemImage", "profile"] : ["runtime", "deviceType"];
  if (Object.keys(input).length !== keys.length || keys.some(key => !Object.hasOwn(input, key))) throw new ServiceError("Invalid device definition.", 400);
  const result: Record<string, string> = {};
  for (const key of keys) {
    const val = string(input[key], key, 200);
    if (!/^[A-Za-z0-9_.;:-]+$/.test(val)) throw new ServiceError("Invalid SDK runtime or device profile identifier.", 400);
    result[key] = val;
  }
  if (system === "android") {
    const abi = arch === "arm64" ? "arm64-v8a" : "x86_64";
    if (!new RegExp(`^system-images;android-[0-9]+;[A-Za-z0-9_-]+;${abi}$`).test(result.systemImage!)) throw new ServiceError("Android system image must match the template architecture.", 400);
  } else if (!result.runtime!.startsWith("com.apple.CoreSimulator.SimRuntime.iOS-") || !result.deviceType!.startsWith("com.apple.CoreSimulator.SimDeviceType.")) {
    throw new ServiceError("Use full iOS runtime and simulator device-type identifiers.", 400);
  }
  return result;
}

export function operationRequest(value: unknown): OperationRequest {
  const input = object(value), action = input.action;
  if (Object.keys(input).some(key => !["id", "action", "arguments"].includes(key))) throw new ServiceError("Invalid device operation.", 400);
  if (typeof action !== "string" || !Object.hasOwn(fields, action)) throw new ServiceError("Unsupported device action.", 400);
  const args = input.arguments === undefined ? {} : object(input.arguments), required = fields[action]!;
  const optional = ["push", "pull", "list-files"].includes(action) ? ["app"] : [];
  if (required.some(key => !Object.hasOwn(args, key)) || Object.keys(args).some(key => !required.includes(key) && !optional.includes(key))) throw new ServiceError(`Invalid arguments for ${action}.`, 400);
  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(args)) {
    if (key === "session") result[key] = uuid(val);
    else if (key === "offset") result[key] = integer(val, "shell offset", 0, Number.MAX_SAFE_INTEGER);
    else if (["rows", "cols"].includes(key)) result[key] = integer(val, key, 1, 500);
    else if (["x", "y", "toX", "toY"].includes(key)) result[key] = integer(val, key, 0, 32768);
    else if (key === "durationMs") result[key] = integer(val, "swipe duration", 1, 10000);
    else if (["latitude", "longitude"].includes(key)) {
      if (typeof val !== "number" || !Number.isFinite(val) || Math.abs(val) > (key === "latitude" ? 90 : 180)) throw new ServiceError("Invalid geographic coordinate.", 400);
      result[key] = val;
    } else if (key === "data") { decodeData(val); result[key] = val; }
    else if (key === "argv") {
      if (!Array.isArray(val) || val.length < 1 || val.length > 100 || val.some(item => typeof item !== "string" || item.includes("\0") || item.length > 4096)) throw new ServiceError("Shell requires a bounded guest argument list.", 400);
      string(val[0], "guest executable"); result[key] = [...val];
    } else if (key === "text") {
      if (typeof val !== "string" || val.includes("\0") || val.length > 16000) throw new ServiceError("Invalid input text.", 400);
      result[key] = val;
    } else result[key] = string(val, key);
  }
  if ("app" in args && !/^[A-Za-z0-9_][A-Za-z0-9_.]*(?:\/[A-Za-z0-9_.$]+)?$/.test(args.app as string)) throw new ServiceError("Invalid app identifier or Android component.", 400);
  if (action === "permission" && !["grant", "revoke", "reset"].includes(args.state as string)) throw new ServiceError("Invalid permission state.", 400);
  if (action === "rotate" && !["PORTRAIT", "PORTRAIT_UPSIDE_DOWN", "LANDSCAPE_LEFT", "LANDSCAPE_RIGHT"].includes(args.orientation as string)) throw new ServiceError("Invalid device orientation.", 400);
  return { id: uuid(input.id), action, arguments: result };
}

/** Exact legacy schema: shared with machine heartbeat and consumer-operation modules. */
export function initializeDevices(db: DatabaseSync, now = Date.now() / 1000): void {
  db.exec(`CREATE TABLE IF NOT EXISTS device_operations (id TEXT PRIMARY KEY,machine TEXT NOT NULL,host TEXT NOT NULL,request TEXT NOT NULL,state TEXT NOT NULL,result TEXT,updated REAL NOT NULL,created REAL NOT NULL);
    CREATE INDEX IF NOT EXISTS device_operations_host_state ON device_operations(host,state);
    CREATE TABLE IF NOT EXISTS control_device_dispatch (id TEXT PRIMARY KEY,dispatched REAL NOT NULL);
    CREATE TABLE IF NOT EXISTS control_device_pending (id TEXT PRIMARY KEY);`);
  closeUnprovenDeviceOperations(db, now);
}
/** Python administrative queues have no dispatch bit. Absence of the new journal is
 * ambiguity, never evidence that an effect did not start. Scoped queues already have
 * their own durable dispatched bit. Only new administrative inserts create pending proof. */
function closeUnprovenDeviceOperations(db: DatabaseSync, now: number): void {
  const scoped = tableExists(db, "consumer_operations") ? " AND NOT EXISTS (SELECT 1 FROM consumer_operations c WHERE c.id=device_operations.id)" : "";
  db.prepare(`UPDATE device_operations SET state='unknown',result=?,updated=? WHERE state='queued'
    AND NOT EXISTS (SELECT 1 FROM control_device_pending p WHERE p.id=device_operations.id)
    AND NOT EXISTS (SELECT 1 FROM control_device_dispatch d WHERE d.id=device_operations.id)${scoped}`)
    .run(JSON.stringify({ detail: "Retained operation has no proven delivery history; it may have executed. Inspect before issuing another effect." }), now);
}
function receipt(row: OperationRow): OperationReceipt {
  return { id: row.id, machineId: row.machine, hostId: row.host, state: row.state, updatedAt: row.updated,
    ...(row.result === null ? {} : { result: JSON.parse(row.result) as unknown }) };
}
function machine(db: DatabaseSync, id: string, principal: Principal): MachineRow {
  const row = db.prepare("SELECT m.*,h.seen,h.enabled FROM machines m JOIN hosts h ON h.id=m.host WHERE m.id=?").get(id) as unknown as MachineRow | undefined;
  if (!row || !owns(principal, row.owner)) throw new ServiceError("Unknown machine.", 404);
  return row;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
export function platformArguments(template: Record<string, unknown>, request: OperationRequest): void {
  const system = template.os, args = request.arguments;
  if (system !== "android" && system !== "ios" && template.guestAccess !== true) throw new ServiceError("This machine has no device or guest access.");
  if (system === "ios" && request.action.startsWith("shell")) throw new ServiceError("Guest shell is Android-only.", 400);
  if (["push", "pull", "list-files"].includes(request.action)) {
    guestPath(args.path, system === "ios" ? "container" : "absolute", request.action === "list-files");
    if (system === "ios" && typeof args.app !== "string") throw new ServiceError("iOS file access requires an app container.", 400);
  }
}

export function createModule(store: SqliteStore, _options: ControlOptions): ControlModule {
  store.transaction(db => initializeDevices(db, store.clock()));
  registerMachineHooks(store, deviceMachineHooks(store));
  return { handle(req) {
    const parts = req.parts[0] === "v1" ? req.parts.slice(1) : req.parts;
    const submit = req.method === "POST" && parts.length === 3 && parts[0] === "machines" && parts[2] === "operations";
    const read = req.method === "GET" && parts.length === 2 && parts[0] === "operations";
    if (!submit && !read) return undefined;
    return store.transaction(db => {
      // Resolve inside the write transaction, including for idempotent replay.
      const principal = requireScope(req, "access");
      if (read) {
        const row = db.prepare("SELECT * FROM device_operations WHERE id=?").get(uuid(parts[1])) as unknown as OperationRow | undefined;
        if (!row) throw new ServiceError("Unknown device operation.", 404);
        machine(db, row.machine, principal);
        return { body: receipt(row) };
      }
      const request = operationRequest(req.body), mid = uuid(parts[1]);
      const old = db.prepare("SELECT * FROM device_operations WHERE id=?").get(request.id) as unknown as OperationRow | undefined;
      if (old) {
        machine(db, old.machine, principal);
        if (old.machine !== mid || canonical(JSON.parse(old.request)) !== canonical(request)) throw new ServiceError("Request identity already belongs to another device operation.");
        return { body: receipt(old) };
      }
      const row = machine(db, mid, principal);
      platformArguments(object(JSON.parse(row.template)), request);
      const now = store.clock();
      if (!row.enabled || row.desired !== "running" || row.observed !== "running" || now - row.seen >= 30) throw new ServiceError("Device must be running on an online host.");
      const count = db.prepare("SELECT count(*) AS n FROM device_operations WHERE host=? AND state='queued'").get(row.host)!.n as number;
      if (count >= 32) throw new ServiceError("Host device operation queue is full.", 429);
      db.prepare("INSERT INTO device_operations(id,machine,host,request,state,result,updated,created) VALUES (?,?,?,?,'queued',NULL,?,?)").run(request.id, mid, row.host, JSON.stringify(request), now, now);
      db.prepare("INSERT INTO control_device_pending VALUES (?)").run(request.id);
      return { body: receipt({ id: request.id, machine: mid, host: row.host, request: JSON.stringify(request), state: "queued", result: null, updated: now, created: now }) };
    });
  } };
}

/** Register once per controller store; createModule registers these hooks automatically. */
export function deviceMachineHooks(store: SqliteStore): MachineHooks {
  return {
    heartbeatFields: ["deviceReports"],
    afterHeartbeat(db, hostId, body) { reportDeviceOperations(db, hostId, body.deviceReports ?? {}, store.clock()); },
    heartbeatResponse(db, hostId) { return { deviceOperations: assignedDeviceOperations(db, hostId, store.clock()) }; },
  };
}

/** Call only inside the authenticated host heartbeat's transaction. Never trust a body host ID. */
export function reportDeviceOperations(db: DatabaseSync, hostId: string, reports: unknown, now: number): void {
  closeUnprovenDeviceOperations(db, now);
  // Heartbeat observations and offered images may just have changed in this transaction.
  // Close invalid scoped work before a late success can become its first receipt.
  refreshConsumerOperations(db, now);
  const entries = Object.entries(object(reports));
  if (entries.length > 1) throw new ServiceError("Report at most one device operation per heartbeat.", 400);
  for (const [id, value] of entries) {
    const row = db.prepare("SELECT * FROM device_operations WHERE id=?").get(uuid(id)) as unknown as OperationRow | undefined;
    if (!row || row.host !== hostId) throw new ServiceError("Cannot report another host's device operation.", 403);
    const report = object(value);
    if (Object.keys(report).some(key => !["state", "result"].includes(key)) || !TERMINAL.includes(report.state as OperationState)) throw new ServiceError("Invalid device operation report.", 400);
    const encoded = jsonBytes(report.result ?? {}, MAX_RESULT).toString("utf8");
    if (TERMINAL.includes(row.state as OperationState)) continue;
    db.prepare("UPDATE device_operations SET state=?,result=?,updated=? WHERE id=?").run(report.state as string, encoded, now, id);
  }
}
function tableExists(db: DatabaseSync, name: string): boolean { return db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name) !== undefined; }

/** Returns one FIFO action. The runner must honor expiresAt and its contact lease before starting. */
export function assignedDeviceOperations(db: DatabaseSync, hostId: string, now: number): OperationAssignment[] {
  closeUnprovenDeviceOperations(db, now);
  refreshConsumerOperations(db, now);
  const rows = db.prepare("SELECT * FROM device_operations WHERE host=? AND state='queued' ORDER BY rowid").all(hostId) as unknown as OperationRow[];
  for (const row of rows) {
    let leaseId: string | undefined, expiresAt = row.created + 120, scopedInvalid = false, scopedDispatched = false;
    if (tableExists(db, "consumer_operations")) {
      const scoped = db.prepare("SELECT * FROM consumer_operations WHERE id=?").get(row.id) as { lease: string; credential: string; dispatched: number } | undefined;
      if (scoped) {
        leaseId = scoped.lease; scopedDispatched = !!scoped.dispatched;
        const lease = tableExists(db, "leases") ? db.prepare("SELECT state,credential,expires FROM leases WHERE id=?").get(scoped.lease) as { state: string; credential: string; expires: number } | undefined : undefined;
        scopedInvalid = !lease || lease.state !== "ready" || lease.credential !== scoped.credential || now >= lease.expires;
        if (lease) expiresAt = Math.min(expiresAt, lease.expires);
      }
    }
    const target = db.prepare("SELECT host,desired,observed FROM machines WHERE id=?").get(row.machine);
    if (now >= expiresAt || !target || target.host !== hostId || target.desired !== "running" || target.observed !== "running" || scopedInvalid) {
      const undispatched = !scopedDispatched && (leaseId !== undefined || !!db.prepare("SELECT 1 FROM control_device_pending WHERE id=?").get(row.id));
      const dispatched = !undispatched || !!db.prepare("SELECT 1 FROM control_device_dispatch WHERE id=?").get(row.id);
      db.prepare("UPDATE device_operations SET state=?,result=?,updated=? WHERE id=?").run(dispatched ? "unknown" : "failed", JSON.stringify({ detail: "Device operation expired or authorization ended; inspect before issuing another effect." }), now, row.id);
      continue;
    }
    if (leaseId !== undefined) db.prepare("UPDATE consumer_operations SET dispatched=1 WHERE id=?").run(row.id);
    db.prepare("INSERT OR IGNORE INTO control_device_dispatch VALUES (?,?)").run(row.id, now);
    db.prepare("DELETE FROM control_device_pending WHERE id=?").run(row.id);
    return [{ ...operationRequest(JSON.parse(row.request)), machineId: row.machine, expiresAt, ...(leaseId === undefined ? {} : { leaseId }) }];
  }
  return [];
}

export interface DeviceExecutionMachine { id: string; desired: string; template: Record<string, unknown> }
export interface DeviceExecutionContext { signal: AbortSignal; authorized(): boolean }
/** Native adapter must fence the exact assignment, revalidate ownership, bound output and honor cancellation.
 * This interface supplies no native implementation or platform acceptance. */
export interface DeviceOperationProvider {
  control(machine: DeviceExecutionMachine, request: OperationRequest, context: DeviceExecutionContext): Promise<unknown>;
}

function initializeExecution(db: DatabaseSync): void {
  db.exec("CREATE TABLE IF NOT EXISTS control_device_execution (id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,report TEXT)");
}
/** Import an owner-loaded legacy receipt before enabling a migrated assignment.
 * The native adapter must read a bounded, private regular file; no receipt-tree discovery
 * or automatic adoption is performed here. Unmatched legacy fingerprints fail closed. */
export function importDeviceExecutionReceipt(store: SqliteStore, machineId: string, value: OperationRequest, saved: unknown): void {
  const mid = uuid(machineId), request = operationRequest(value), source = object(saved);
  jsonBytes(source, MAX_RESULT + 16384);
  if (source.fingerprint !== legacyDigest({ machine: mid, ...request })) throw new ServiceError("Legacy device operation receipt does not match this assignment; inspect before execution.");
  let report: string | null = null;
  if (source.report !== undefined) {
    const parsed = object(source.report);
    if (!TERMINAL.includes(parsed.state as OperationState) || Object.keys(parsed).some(key => !["state", "result"].includes(key))) throw new ServiceError("Invalid legacy operation receipt.");
    report = jsonBytes({ state: parsed.state, result: parsed.result ?? {} }, MAX_RESULT + 16384).toString("utf8");
    jsonBytes(parsed.result ?? {}, MAX_RESULT);
  } else if (source.started !== true) throw new ServiceError("Legacy operation receipt has no confirmed phase; inspect before execution.");
  const fingerprint = createHash("sha256").update(canonical({ machine: mid, ...request })).digest("hex");
  store.transaction(db => {
    initializeExecution(db);
    const old = db.prepare("SELECT fingerprint FROM control_device_execution WHERE id=?").get(request.id);
    if (old && old.fingerprint !== fingerprint) throw new ServiceError("Device operation identity conflicts with its local receipt.");
    db.prepare("INSERT OR IGNORE INTO control_device_execution VALUES (?,?,?)").run(request.id, fingerprint, report);
  });
}

/** Read-only receipt lookup never starts provider work or imports another assignment. */
export function deviceExecutionReceipt(store: SqliteStore, operationId: string): OperationReport {
  const id = uuid(operationId);
  return store.transaction(db => {
    const row = tableExists(db, "control_device_execution") ? db.prepare("SELECT report FROM control_device_execution WHERE id=?").get(id) : undefined;
    if (!row?.report) return { state: "unknown", result: { detail: "No completed local receipt is available. Inspect before retrying." } };
    const report = String(row.report);
    if (Buffer.byteLength(report) > MAX_RESULT + 16384) throw new ServiceError("Operation receipt exceeds its bounded envelope.");
    return JSON.parse(report) as OperationReport;
  });
}

/** Runner-private SQLite journal replaces per-operation JSON receipts and locks.
 * A started receipt is committed before provider dispatch. Crash/concurrent delivery never repeats it. */
export async function executeDeviceOperation(store: SqliteStore, machine: DeviceExecutionMachine, assignment: OperationAssignment,
  provider: DeviceOperationProvider | undefined, authorized: () => boolean, signal?: AbortSignal): Promise<OperationReport> {
  const request = operationRequest({ id: assignment.id, action: assignment.action, arguments: assignment.arguments });
  if (uuid(machine.id) !== uuid(assignment.machineId) || !Number.isFinite(assignment.expiresAt)) throw new ServiceError("Operation assignment does not match this device.", 403);
  const fingerprint = createHash("sha256").update(canonical({ machine: machine.id, ...request })).digest("hex");
  const unknown: OperationReport = { state: "unknown", result: { detail: "Interrupted device action; inspect before issuing another operation." } };
  const previous = store.transaction(db => {
    initializeExecution(db);
    const old = db.prepare("SELECT fingerprint,report FROM control_device_execution WHERE id=?").get(request.id) as { fingerprint: string; report: string | null } | undefined;
    if (old) {
      if (old.fingerprint !== fingerprint) throw new ServiceError("Device operation identity conflicts with its local receipt.");
      return old.report === null ? unknown : JSON.parse(old.report) as OperationReport;
    }
    db.prepare("INSERT INTO control_device_execution VALUES (?,?,NULL)").run(request.id, fingerprint);
    return undefined;
  });
  if (previous) return previous;
  let report: OperationReport;
  if (store.clock() >= assignment.expiresAt || machine.desired !== "running" || !authorized() || signal?.aborted) {
    report = { state: "failed", result: { detail: "Device operation expired, stopped or lost authorization before execution." } };
  } else if (!provider) {
    report = { state: "failed", result: { code: "capability_unsupported", detail: "Native device execution is unsupported without an explicitly bound provider." } };
  } else {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cancel = () => abort.abort();
    signal?.addEventListener("abort", cancel, { once: true });
    const allowed = () => !abort.signal.aborted && !signal?.aborted && store.clock() < assignment.expiresAt && authorized();
    try {
      platformArguments(machine.template, request);
      const cancelled = new Promise<never>((_resolve, reject) => {
        abort.signal.addEventListener("abort", () => reject(new ServiceError("Device execution interrupted; cancellation is unconfirmed.", 409, { outcome: "unknown" })), { once: true });
        timer = setTimeout(cancel, Math.max(1, Math.min(60_000, (assignment.expiresAt - store.clock()) * 1000)));
      });
      if (!allowed()) throw new ServiceError("Device execution authorization ended.", 401);
      const result = await Promise.race([provider.control(machine, request, { signal: abort.signal, authorized: allowed }), cancelled]);
      if (!allowed()) throw new ServiceError("Device execution authorization ended before acknowledgement.", 401);
      jsonBytes(result, MAX_RESULT);
      report = { state: "succeeded", result };
    } catch (error) {
      report = { state: "unknown", result: { detail: error instanceof ServiceError ? error.message.slice(0, 2000) : "Device action failed or was interrupted; inspect before retrying." } };
    } finally { if (timer) clearTimeout(timer); signal?.removeEventListener("abort", cancel); }
  }
  // No late result may overwrite the first durable local receipt.
  store.transaction(db => db.prepare("UPDATE control_device_execution SET report=? WHERE id=? AND report IS NULL").run(JSON.stringify(report), request.id));
  return report;
}
