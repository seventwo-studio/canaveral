/** Runtime, storage and idle upkeep for mobile hosts.
 *
 * Runtime installs and removals, storage inspection and orphan purges are durable administrator
 * host operations delivered over the existing outbound heartbeat. A lease or machine creation
 * never queues one. Uncertain outcomes become `unknown` and are never replayed.
 * Idle stop is a controller pass over account-owned devices that only requests `stopped`.
 * Everything here has portable fixture coverage only; no native SDK or Xcode run is recorded. */
import type { DatabaseSync } from "node:sqlite";
import { identifier } from "../consumers.ts";
import { object, ServiceError } from "../errors.ts";
import type { SqliteStore } from "../sqlite.ts";
import { updateDraining } from "../updates/drain.ts";
import { requireAdmin } from "./contracts.ts";
import type { ControlModule, ControlOptions, ControlRequest, ControlResponse } from "./contracts.ts";
import { unresolvedInstall } from "./install-cleanup.ts";
import { deletion, hasPendingPowerOff, isDeleted } from "./lifecycle.ts";
import { registerMachineHooks } from "./machines.ts";
import type { MachineHooks } from "./machines.ts";
import { unresolvedVideoSession } from "./video-cleanup.ts";

export type HostOperationKind = "runtime-list" | "runtime-install" | "runtime-remove" | "storage-inspect" | "storage-purge";
export type MobilePlatform = "android" | "ios";
const KINDS: readonly HostOperationKind[] = ["runtime-list", "runtime-install", "runtime-remove", "storage-inspect", "storage-purge"];
const PLATFORMS: readonly MobilePlatform[] = ["android", "ios"];
const MUTATIONS = "('runtime-install','runtime-remove','storage-purge')";
const TERMINAL = ["succeeded", "failed", "unknown"];
/** A host must collect and start an operation within this window, or it never runs. */
export const HOST_OPERATION_START_SECONDS = 120;
const HOST_LEASE_SECONDS = 30;
const MAX_RESULT_BYTES = 262_144;
/** An inspection names what a purge may remove; an older one no longer describes the host. */
export const STORAGE_INSPECTION_SECONDS = 900;
export const IDLE_STOP_MINIMUM_SECONDS = 300;
export const IDLE_STOP_MAXIMUM_SECONDS = 2_592_000;
const PHASES = ["starting", "downloading", "installing", "removing", "verifying", "inspecting"];
const uuidPattern = "[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}";
const storageEntry = new RegExp(`^(?:${uuidPattern}|\\.removing-${uuidPattern}-${uuidPattern})$`), machineUuid = new RegExp(`^${uuidPattern}$`);
/** The identifiers mobile templates can pin; an install is only ever requested for one of these shapes. */
export const ANDROID_SYSTEM_IMAGE = /^system-images;android-[0-9]+;[A-Za-z0-9_-]+;(?:arm64-v8a|x86_64)$/;
export const IOS_RUNTIME_VERSION = /^com\.apple\.CoreSimulator\.SimRuntime\.iOS-[0-9]+(?:-[0-9]+){1,2}$/;
export const IOS_RUNTIME = /^com\.apple\.CoreSimulator\.SimRuntime\.iOS-[A-Za-z0-9]+(?:-[A-Za-z0-9]+){0,7}$/;

interface ResolutionRow { id: string; operation: string; decision: string; reason: string; decided_by: string; created: number }
interface OperationRow { id: string; host: string; kind: HostOperationKind; platform: string | null; request: string; state: string; progress: string | null; result: string | null;
  actor: string; created: number; updated: number; start_by: number; deadline: number; dispatched: number | null; acknowledged: number | null }
interface MachineRow { id: string; host: string; request: string; template: string; desired: string; observed: string }
export interface IdlePolicy { defaultSeconds: number | null; templates: Record<string, number | null> }
export interface UpkeepReport { version: 1; platforms: MobilePlatform[]; idleStop: IdlePolicy; busy: string[] }
export interface IdleCandidate { machineId: string; name: unknown; templateId: unknown; desired: string; observed: string; leased: boolean;
  idleStopSeconds: number | null; idleSeconds: number | null; lastActivityAt: number | null; wouldStop: boolean; reason: string; blockers: string[] }

function invalid(message = "Invalid host operation."): never { throw new ServiceError(message, 400); }
function refuse(message: string, code: string, status = 409): never { throw new ServiceError(message, status, { code }); }
function exact(input: unknown, required: string[], optional: string[] = []): Record<string, unknown> {
  const v = object(input);
  if (required.some(key => !Object.hasOwn(v, key)) || Object.keys(v).some(key => !required.includes(key) && !optional.includes(key))) invalid();
  return v;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function tableExists(db: DatabaseSync, name: string): boolean { return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name); }
function seconds(value: unknown, label: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) invalid(`Invalid ${label}.`);
  return value as number;
}
function idleSeconds(value: unknown): number | null {
  if (value === null || value === 0) return null;
  return seconds(value, "idle stop time", IDLE_STOP_MINIMUM_SECONDS, IDLE_STOP_MAXIMUM_SECONDS);
}
/** The host's operator-owned policy and capability, as advertised on each heartbeat. */
export function validateUpkeepReport(value: unknown): UpkeepReport {
  const v = exact(value, ["version", "platforms", "idleStop", "busy"]);
  if (v.version !== 1 || !Array.isArray(v.platforms) || v.platforms.length > 2 || new Set(v.platforms).size !== v.platforms.length || v.platforms.some(p => !PLATFORMS.includes(p as MobilePlatform))) invalid("Invalid upkeep report.");
  const idle = exact(v.idleStop, ["defaultSeconds", "templates"]), templates = object(idle.templates);
  if (Object.keys(templates).length > 100 || Object.keys(templates).some(key => !key || [...key].length > 100)) invalid("Invalid idle stop templates.");
  if (!Array.isArray(v.busy) || v.busy.length > 10_000) invalid("Invalid busy device list.");
  return { version: 1, platforms: [...v.platforms as MobilePlatform[]].sort(), busy: [...new Set(v.busy.map(identifier))],
    idleStop: { defaultSeconds: idleSeconds(idle.defaultSeconds), templates: Object.fromEntries(Object.entries(templates).map(([key, n]) => [key, idleSeconds(n)])) } };
}
function platformOf(value: unknown): MobilePlatform {
  if (!PLATFORMS.includes(value as MobilePlatform)) invalid("Platform must be android or ios.");
  return value as MobilePlatform;
}
/** Normalized arguments are the replay identity of an operation. */
export function hostOperationArguments(kind: HostOperationKind, value: unknown): Record<string, unknown> {
  if (kind === "storage-inspect") { exact(value ?? {}, []); return {}; }
  if (kind === "storage-purge") {
    const v = exact(value, ["inspection", "entries"]);
    if (!Array.isArray(v.entries) || !v.entries.length || v.entries.length > 50 || v.entries.some(name => typeof name !== "string" || !storageEntry.test(name))) invalid("Name between 1 and 50 inspected storage entries.");
    return { inspection: identifier(v.inspection), entries: [...new Set(v.entries as string[])].sort() };
  }
  if (kind === "runtime-list") return { platform: platformOf(exact(value, ["platform"]).platform) };
  const v = exact(value, ["platform", "identifier"], kind === "runtime-install" ? ["acceptLicenses", "timeoutSeconds"] : ["timeoutSeconds"]);
  const platform = platformOf(v.platform), install = kind === "runtime-install";
  const pattern = platform === "android" ? ANDROID_SYSTEM_IMAGE : install ? IOS_RUNTIME_VERSION : IOS_RUNTIME;
  if (typeof v.identifier !== "string" || v.identifier.length > 200 || !pattern.test(v.identifier)) invalid(platform === "android" ? "Name a full Android system image package." : "Name a full iOS simulator runtime identifier.");
  const timeoutSeconds = seconds(v.timeoutSeconds ?? (install ? 3600 : 900), "operation timeout", 60, 14_400);
  if (!install) return { platform, identifier: v.identifier, timeoutSeconds };
  if (v.acceptLicenses !== undefined && v.acceptLicenses !== true) invalid("acceptLicenses can only be true.");
  // Android SDK licences are never accepted implicitly: the acknowledgement is part of this one request.
  if (platform === "android" && v.acceptLicenses !== true) refuse("An Android install must acknowledge the SDK licences in this request.", "license_acknowledgement_required", 400);
  if (platform === "ios" && v.acceptLicenses !== undefined) invalid("Licence acknowledgement applies to Android installs only.");
  return { platform, identifier: v.identifier, timeoutSeconds, ...(platform === "android" ? { acceptLicenses: true } : {}) };
}
function operationTimeout(kind: HostOperationKind, args: Record<string, unknown>): number {
  return typeof args.timeoutSeconds === "number" ? args.timeoutSeconds : kind === "storage-purge" ? 600 : 300;
}
function view(row: OperationRow): Record<string, unknown> {
  return { id: row.id, hostId: row.host, kind: row.kind, arguments: JSON.parse(row.request) as unknown, state: row.state, requestedBy: row.actor,
    createdAt: row.created, updatedAt: row.updated, startBy: row.start_by, deadline: row.deadline,
    ...(row.progress === null ? {} : { progress: JSON.parse(row.progress) as unknown }), ...(row.result === null ? {} : { result: JSON.parse(row.result) as unknown }),
    ...(row.acknowledged === null ? {} : { acknowledgedAt: row.acknowledged }) };
}
function templateRuntime(template: Record<string, unknown>, platform: MobilePlatform): string | undefined {
  if (template.os !== platform || template.mode !== "device") return undefined;
  const device = object(template.device ?? {});
  const value = platform === "android" ? device.systemImage : device.runtime;
  return typeof value === "string" ? value : undefined;
}
function machineIdOf(entry: string): string { return entry.startsWith(".removing-") ? entry.slice(10, 46) : entry; }
function reasonText(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 1000 || /[\u0000-\u0008\u000b-\u001f\u007f]/.test(value)) invalid("Resolution requires a reason of at most 1000 characters.");
  return value as string;
}

export class HostUpkeep implements ControlModule {
  constructor(readonly store: SqliteStore) {
    store.transaction(db => {
      db.exec(`
      CREATE TABLE IF NOT EXISTS host_operations (id TEXT PRIMARY KEY,host TEXT NOT NULL,kind TEXT NOT NULL,platform TEXT,request TEXT NOT NULL,state TEXT NOT NULL,
        progress TEXT,result TEXT,actor TEXT NOT NULL,created REAL NOT NULL,updated REAL NOT NULL,start_by REAL NOT NULL,deadline REAL NOT NULL,dispatched REAL,acknowledged REAL);
      CREATE INDEX IF NOT EXISTS host_operations_host ON host_operations(host,state);
      CREATE TABLE IF NOT EXISTS host_upkeep (host TEXT PRIMARY KEY,report TEXT NOT NULL,received REAL NOT NULL);
      CREATE TABLE IF NOT EXISTS machine_activity (machine TEXT PRIMARY KEY,running_since REAL,idle_stopped_at REAL,idle_seconds REAL,idle_policy REAL,active_at REAL);
      CREATE TABLE IF NOT EXISTS host_operation_resolutions (id TEXT PRIMARY KEY,operation TEXT NOT NULL UNIQUE,decision TEXT NOT NULL,reason TEXT NOT NULL,decided_by TEXT NOT NULL,created REAL NOT NULL);`);
      // Additive for a database created by an earlier build of this change.
      if (!db.prepare("PRAGMA table_info(machine_activity)").all().some(column => column.name === "active_at")) db.exec("ALTER TABLE machine_activity ADD COLUMN active_at REAL");
    });
  }
  readonly hooks: MachineHooks = {
    heartbeatFields: ["upkeep", "hostOperationReports"],
    beforeHeartbeat: (db, host, body) => {
      this.expire(db);
      // A runner that sends no upkeep report cannot run host operations and has no idle policy:
      // an older runner, or one whose mobile runtimes were removed. What a newer runner advertised
      // before must not outlive it.
      if (body.upkeep === undefined || body.upkeep === null) { db.prepare("DELETE FROM host_upkeep WHERE host=?").run(host); return; }
      // Written only when it changes, so a steady host adds no write to its heartbeat.
      const report = JSON.stringify(validateUpkeepReport(body.upkeep));
      if (db.prepare("SELECT report FROM host_upkeep WHERE host=?").get(host)?.report !== report) db.prepare("INSERT INTO host_upkeep VALUES (?,?,?) ON CONFLICT(host) DO UPDATE SET report=excluded.report,received=excluded.received")
        .run(host, report, this.store.clock());
    },
    reportMachine: (db, _host, machine, report) => {
      // The idle clock starts when the controller first sees this run, and restarts with every run.
      if (report.state === "running") db.prepare(`INSERT INTO machine_activity(machine,running_since) VALUES (?,?)
        ON CONFLICT(machine) DO UPDATE SET running_since=excluded.running_since WHERE machine_activity.running_since IS NULL`).run(machine, this.store.clock());
      else db.prepare("UPDATE machine_activity SET running_since=NULL WHERE machine=? AND running_since IS NOT NULL").run(machine);
    },
    afterHeartbeat: (db, host, body) => {
      this.recordReports(db, host, body.hostOperationReports ?? {});
      // Only a heartbeat that carries the host's current policy and busy list may stop anything.
      if (body.upkeep !== undefined && body.upkeep !== null) this.idlePass(db, host);
    },
    heartbeatResponse: (db, host) => ({ hostOperations: this.assigned(db, host) }),
    // An explicit start is the owner using the device: the idle time starts over, even when the
    // host has not yet reported the stop that preceded it.
    desiredChanged: (db, machine, state) => { if (state === "running") this.touch(db, machine, this.store.clock()); },
  };
  private touch(db: DatabaseSync, machine: string, now: number): void {
    db.prepare("INSERT INTO machine_activity(machine,active_at) VALUES (?,?) ON CONFLICT(machine) DO UPDATE SET active_at=excluded.active_at").run(machine, now);
  }

  /** Undelivered work fails without effect; delivered work without a receipt is unknown, never replayed. */
  private expire(db: DatabaseSync): void {
    const now = this.store.clock();
    db.prepare("UPDATE host_operations SET state='failed',result=?,updated=? WHERE state='queued' AND dispatched IS NULL AND start_by<=?")
      .run(JSON.stringify({ code: "expired", detail: "The host did not collect this operation in time; nothing was started." }), now, now);
    db.prepare("UPDATE host_operations SET state='unknown',result=?,progress=NULL,updated=? WHERE state IN ('queued','running') AND deadline<=?")
      .run(JSON.stringify({ code: "outcome_unknown", detail: "The host reported no outcome in time. Inspect the host before another change; this operation is never replayed." }), now, now);
  }
  private assigned(db: DatabaseSync, host: string): Record<string, unknown>[] {
    this.expire(db);
    // Nothing is handed to a runner whose heartbeat advertised no upkeep; it could not run it,
    // and the operation then fails as never collected instead of ending unknown.
    if (!this.capability(db, host)) return [];
    const rows = db.prepare("SELECT * FROM host_operations WHERE host=? AND state IN ('queued','running') ORDER BY rowid LIMIT 8").all(host) as unknown as OperationRow[];
    // Only what this response delivers counts as collected.
    const collected = db.prepare("UPDATE host_operations SET dispatched=? WHERE id=? AND state='queued' AND dispatched IS NULL");
    for (const row of rows) collected.run(this.store.clock(), row.id);
    return rows.map(row => ({ id: row.id, kind: row.kind, arguments: JSON.parse(row.request) as unknown, startBy: row.start_by, timeoutSeconds: operationTimeout(row.kind, object(JSON.parse(row.request))) }));
  }
  private recordReports(db: DatabaseSync, host: string, value: unknown): void {
    const entries = Object.entries(object(value));
    if (entries.length > 16) invalid("Report at most 16 host operations per heartbeat.");
    const now = this.store.clock();
    for (const [raw, input] of entries) {
      const id = identifier(raw), row = db.prepare("SELECT * FROM host_operations WHERE id=?").get(id) as unknown as OperationRow | undefined;
      if (!row || row.host !== host) throw new ServiceError("Cannot report another host's operation.", 403);
      const report = exact(input, ["state"], ["progress", "result", "detail"]);
      if (report.state !== "running" && !TERMINAL.includes(String(report.state))) invalid("Invalid host operation report.");
      // The first terminal receipt is durable; a later or repeated report never replaces it.
      if (TERMINAL.includes(row.state)) continue;
      if (report.state === "running") {
        let progress: string | null = null;
        if (report.progress !== undefined) {
          const p = exact(report.progress, ["phase"], ["percent"]);
          if (!PHASES.includes(String(p.phase)) || p.percent !== undefined && (typeof p.percent !== "number" || !Number.isFinite(p.percent) || p.percent < 0 || p.percent > 100)) invalid("Invalid host operation progress.");
          progress = JSON.stringify({ ...p, updatedAt: now });
        }
        db.prepare("UPDATE host_operations SET state='running',progress=COALESCE(?,progress),updated=? WHERE id=?").run(progress, now, id);
        continue;
      }
      // The runner's own journal reports an interrupted or conflicting operation with a bare detail.
      const encoded = JSON.stringify(object(report.result ?? (typeof report.detail === "string" ? { detail: report.detail.slice(0, 2000) } : {})));
      if (Buffer.byteLength(encoded) > MAX_RESULT_BYTES) invalid("Host operation result exceeds its envelope.");
      db.prepare("UPDATE host_operations SET state=?,result=?,updated=? WHERE id=?").run(String(report.state), encoded, now, id);
      // Re-inspection is how an operator settles an unknown change: a later successful listing
      // of the same platform, or storage inspection, acknowledges it.
      if (report.state === "succeeded" && row.kind === "runtime-list") db.prepare(`UPDATE host_operations SET acknowledged=? WHERE host=? AND platform=? AND state='unknown'
        AND acknowledged IS NULL AND kind IN ('runtime-install','runtime-remove') AND updated<=?`).run(now, host, row.platform, row.created);
      if (report.state === "succeeded" && row.kind === "storage-inspect") db.prepare(`UPDATE host_operations SET acknowledged=? WHERE host=? AND state='unknown'
        AND acknowledged IS NULL AND kind='storage-purge' AND updated<=?`).run(now, host, row.created);
    }
  }

  private capability(db: DatabaseSync, host: string): UpkeepReport | undefined {
    const row = db.prepare("SELECT report FROM host_upkeep WHERE host=?").get(host);
    return row ? JSON.parse(String(row.report)) as UpkeepReport : undefined;
  }
  private host(db: DatabaseSync, value: unknown): { id: string; offer: Record<string, unknown>; seen: number } {
    const id = identifier(value);
    const row = db.prepare("SELECT id,offer,seen FROM hosts WHERE id=? AND id NOT IN (SELECT id FROM retired_runners)").get(id);
    if (!row) throw new ServiceError("Unknown host.", 404);
    let offer: Record<string, unknown> = {};
    try { offer = object(JSON.parse(String(row.offer))); } catch { /* An opaque legacy offer advertises nothing. */ }
    return { id, offer, seen: Number(row.seen) };
  }
  /** Templates the host configures (offered or retained) and devices placed on it, per runtime. */
  private usage(db: DatabaseSync, host: { id: string; offer: Record<string, unknown> }, platform: MobilePlatform) {
    const templates = new Map<string, { identifier: string; id: unknown; revision: unknown; arch: unknown; offered: boolean }>();
    const add = (value: unknown, offered: boolean): void => {
      const template = object(value), runtime = templateRuntime(template, platform);
      if (!runtime) return;
      const key = JSON.stringify([template.id, template.revision, template.arch]), previous = templates.get(key);
      templates.set(key, { identifier: runtime, id: template.id, revision: template.revision, arch: template.arch, offered: offered || previous?.offered === true });
    };
    const inventory = tableExists(db, "host_image_inventory") ? db.prepare("SELECT definitions FROM host_image_inventory WHERE host=?").get(host.id) : undefined;
    for (const template of inventory ? JSON.parse(String(inventory.definitions)) as unknown[] : []) add(template, false);
    for (const template of Array.isArray(host.offer.templates) ? host.offer.templates : []) add(template, true);
    const machines: { identifier: string; id: string; name: unknown; desired: string; observed: string; leased: boolean }[] = [];
    const leases = tableExists(db, "lease_members");
    for (const row of db.prepare("SELECT * FROM machines WHERE host=? ORDER BY id").all(host.id) as unknown as MachineRow[]) {
      if (isDeleted(db, row.id)) continue;
      const runtime = templateRuntime(object(JSON.parse(row.template)), platform);
      if (runtime) machines.push({ identifier: runtime, id: row.id, name: object(JSON.parse(row.request)).name, desired: row.desired, observed: row.observed,
        leased: leases && !!db.prepare("SELECT 1 FROM lease_members WHERE machine=?").get(row.id) });
    }
    return { templates: [...templates.values()], machines };
  }
  private usedBy(usage: ReturnType<HostUpkeep["usage"]>, name: string) {
    return { templates: usage.templates.filter(t => t.identifier === name).map(({ identifier: _i, ...t }) => t), machines: usage.machines.filter(m => m.identifier === name).map(({ identifier: _i, ...m }) => m) };
  }

  private submit(db: DatabaseSync, req: ControlRequest): ControlResponse {
    const principal = requireAdmin(req), body = exact(req.body, ["id", "kind"], ["arguments"]);
    const host = this.host(db, req.parts[2]), id = identifier(body.id), now = this.store.clock();
    if (!KINDS.includes(body.kind as HostOperationKind)) invalid("Unsupported host operation kind.");
    const kind = body.kind as HostOperationKind;
    const old = db.prepare("SELECT * FROM host_operations WHERE id=?").get(id) as unknown as OperationRow | undefined;
    // An acknowledgement is part of the request, so a replay must repeat it; compare before refusing its absence.
    let args: Record<string, unknown>;
    try { args = hostOperationArguments(kind, body.arguments); }
    catch (error) { if (old) throw new ServiceError("Request identity already belongs to another host operation.", 409); throw error; }
    if (old) {
      if (old.host !== host.id || old.kind !== kind || old.request !== canonical(args)) throw new ServiceError("Request identity already belongs to another host operation.", 409);
      return { status: 200, body: view(old) };
    }
    const capability = this.capability(db, host.id), platform = typeof args.platform === "string" ? args.platform as MobilePlatform : null;
    if (!capability || platform && !capability.platforms.includes(platform)) refuse("This host has not advertised upkeep for that platform.", "upkeep_unsupported");
    if (now - host.seen >= HOST_LEASE_SECONDS) throw new ServiceError("Host operations need an online host.", 409);
    // A runner fenced for a managed update starts nothing, and a queued operation would keep it
    // from quiescing. A manual maintenance drain is different: upkeep is maintenance work.
    if (updateDraining(db, host.id)) throw new ServiceError("Host admission is closed for a runtime update.", 409, { code: "host_draining" });
    if (kind === "runtime-install" || kind === "runtime-remove" || kind === "storage-purge") {
      // One change per host and platform at a time (one purge per host). An unknown change must be
      // re-inspected first, so an uncertain install is never followed blindly by another.
      const lane = kind === "storage-purge" ? "kind='storage-purge'" : "platform=? AND kind IN ('runtime-install','runtime-remove')";
      const blocking = db.prepare(`SELECT state FROM host_operations WHERE host=? AND ${lane} AND (state IN ('queued','running') OR (state='unknown' AND acknowledged IS NULL))`)
        .all(...(kind === "storage-purge" ? [host.id] : [host.id, platform])) as { state: string }[];
      if (blocking.some(row => row.state !== "unknown")) refuse("Another change is in progress for this host and platform.", "host_operation_busy");
      if (blocking.length) refuse("An earlier change ended unknown; inspect the host again before another change.", "host_inspection_required");
    }
    if (kind === "runtime-remove") {
      const used = this.usedBy(this.usage(db, host, platform!), String(args.identifier));
      if (used.templates.length || used.machines.length) refuse("A template, device or lease on this host uses that runtime or system image.", "runtime_in_use");
    }
    if (kind === "storage-purge") this.purgeAdmission(db, host.id, args, now);
    const timeout = operationTimeout(kind, args), startBy = now + HOST_OPERATION_START_SECONDS;
    const actor = principal.kind === "operator" ? "operator" : `${principal.kind}:${principal.user!.id}`;
    db.prepare("INSERT INTO host_operations VALUES (?,?,?,?,?,'queued',NULL,NULL,?,?,?,?,?,NULL,NULL)").run(id, host.id, kind, platform, canonical(args), actor, now, now, startBy, startBy + timeout + 120);
    return { status: 201, body: view(db.prepare("SELECT * FROM host_operations WHERE id=?").get(id) as unknown as OperationRow) };
  }
  private receipt(db: DatabaseSync, row: OperationRow): Record<string, unknown> {
    const resolution = db.prepare("SELECT * FROM host_operation_resolutions WHERE operation=?").get(row.id) as unknown as ResolutionRow | undefined;
    return { ...view(row), ...(resolution ? { resolution: { id: resolution.id, decision: resolution.decision, reason: resolution.reason, decidedBy: JSON.parse(resolution.decided_by) as unknown, decidedAt: resolution.created } } : {}) };
  }
  /** Explicit administrator acknowledgement of a change that ended unknown, for when the host
   * can no longer be listed or inspected: its platform was removed, or the host is gone.
   * `inspected` states that the host was inspected by other means; `abandoned` accepts the
   * outcome as unknown. Neither changes the receipt's state or retries anything; both only end
   * the hold on further changes and on drain resume. One append-only decision per operation. */
  private resolve(db: DatabaseSync, req: ControlRequest): ControlResponse {
    const principal = requireAdmin(req), operation = identifier(req.parts[2]);
    const row = db.prepare("SELECT * FROM host_operations WHERE id=?").get(operation) as unknown as OperationRow | undefined;
    if (!row) throw new ServiceError("Unknown host operation.", 404);
    const body = exact(req.body, ["id", "decision", "reason"]), id = identifier(body.id), reason = reasonText(body.reason);
    if (body.decision !== "inspected" && body.decision !== "abandoned") invalid("Resolution decision must be inspected or abandoned.");
    for (const old of db.prepare("SELECT * FROM host_operation_resolutions WHERE id=? OR operation=?").all(id, operation) as unknown as ResolutionRow[]) {
      if (old.id !== id) throw new ServiceError("This operation already has a resolution. Reuse its request ID.", 409);
      if (old.operation !== operation || old.decision !== body.decision || old.reason !== reason) throw new ServiceError("Request identity already belongs to another resolution.", 409);
      return { status: 200, body: this.receipt(db, row) };
    }
    if (row.state !== "unknown" || !["runtime-install", "runtime-remove", "storage-purge"].includes(row.kind)) throw new ServiceError("Only an install, removal or purge that ended unknown can be resolved.", 409);
    if (row.acknowledged !== null) throw new ServiceError("A later inspection already acknowledged this operation; no resolution is needed.", 409);
    const now = this.store.clock(), decidedBy = JSON.stringify({ kind: principal.kind, userId: principal.user?.id ?? null, username: principal.user?.username ?? null });
    db.prepare("INSERT INTO host_operation_resolutions VALUES (?,?,?,?,?,?)").run(id, operation, String(body.decision), reason, decidedBy, now);
    db.prepare("UPDATE host_operations SET acknowledged=? WHERE id=?").run(now, operation);
    return { status: 201, body: this.receipt(db, db.prepare("SELECT * FROM host_operations WHERE id=?").get(operation) as unknown as OperationRow) };
  }
  /** A purge names entries of one recent, complete inspection of this host that the host proved
   * removable, and none may have a live owner in the controller's own ledger. */
  private purgeAdmission(db: DatabaseSync, host: string, args: Record<string, unknown>, now: number): void {
    const inspection = db.prepare("SELECT * FROM host_operations WHERE id=?").get(String(args.inspection)) as unknown as OperationRow | undefined;
    if (!inspection || inspection.host !== host || inspection.kind !== "storage-inspect" || inspection.state !== "succeeded" || now - inspection.updated >= STORAGE_INSPECTION_SECONDS)
      refuse("Purge needs a recent successful storage inspection of this host.", "host_inspection_required");
    const result = object(JSON.parse(inspection!.result ?? "{}")), listed = new Map<string, Record<string, unknown>>();
    for (const entry of Array.isArray(result.entries) ? result.entries : []) { const e = object(entry); if (typeof e.name === "string") listed.set(e.name, e); }
    for (const name of args.entries as string[]) {
      if (result.complete !== true || listed.get(name)?.removable !== true || this.owner(db, machineIdOf(name)) === "live") refuse("Named storage has a live owner or was not proven removable by that inspection.", "storage_owner_exists");
    }
  }
  private owner(db: DatabaseSync, machine: string): "live" | "deleted" | "absent" {
    if (!db.prepare("SELECT 1 FROM machines WHERE id=?").get(machine)) return "absent";
    return isDeleted(db, machine) ? "deleted" : "live";
  }

  private runtimes(db: DatabaseSync, hostId: unknown): Record<string, unknown> {
    const host = this.host(db, hostId), capability = this.capability(db, host.id);
    return { hostId: host.id, supported: !!capability, platforms: (capability?.platforms ?? []).map(platform => {
      const usage = this.usage(db, host, platform);
      const listing = db.prepare("SELECT * FROM host_operations WHERE host=? AND kind='runtime-list' AND platform=? AND state='succeeded' ORDER BY updated DESC,rowid DESC LIMIT 1").get(host.id, platform) as unknown as OperationRow | undefined;
      const result = listing ? object(JSON.parse(listing.result ?? "{}")) : {};
      const changes = db.prepare(`SELECT * FROM host_operations WHERE host=? AND platform=? AND kind IN ('runtime-install','runtime-remove')
        AND (state IN ('queued','running') OR (state='unknown' AND acknowledged IS NULL)) ORDER BY rowid`).all(host.id, platform) as unknown as OperationRow[];
      const installed = (Array.isArray(result.installed) ? result.installed : []).map(entry => { const e = object(entry); return { ...e, usedBy: this.usedBy(usage, String(e.identifier)) }; });
      // A template or device can pin a runtime the last listing did not find installed.
      const known = new Set(installed.map(e => String((e as Record<string, unknown>).identifier)));
      const missing = [...new Set([...usage.templates, ...usage.machines].map(u => u.identifier))].filter(name => !known.has(name)).map(name => ({ identifier: name, usedBy: this.usedBy(usage, name) }));
      return { platform, listedAt: listing?.updated ?? null, operationId: listing?.id ?? null, installed, available: result.available ?? null,
        ...(listing ? { requiredButNotListed: missing } : {}), inspectionRequired: changes.some(row => row.state === "unknown"), pending: changes.filter(row => row.state !== "unknown").map(view) };
    }) };
  }

  /** One evaluation shared by the dry-run and the pass, so the preview is what the rules do. */
  private idleCandidates(db: DatabaseSync, host: string, policy: IdlePolicy, busy: ReadonlySet<string>, now: number): IdleCandidate[] {
    const has = (name: string): boolean => tableExists(db, name), result: IdleCandidate[] = [];
    const latest = (query: string, machine: string): number | null => { const value = db.prepare(query).get(machine)?.at; return typeof value === "number" ? value : null; };
    for (const row of db.prepare("SELECT * FROM machines WHERE host=? ORDER BY id").all(host) as unknown as MachineRow[]) {
      const template = object(JSON.parse(row.template));
      if (isDeleted(db, row.id) || template.mode !== "device") continue;
      const leased = has("lease_members") && !!db.prepare("SELECT 1 FROM lease_members WHERE machine=?").get(row.id);
      const configured = Object.hasOwn(policy.templates, String(template.id)) ? policy.templates[String(template.id)]! : policy.defaultSeconds;
      const candidate: IdleCandidate = { machineId: row.id, name: object(JSON.parse(row.request)).name, templateId: template.id, desired: row.desired, observed: row.observed, leased,
        idleStopSeconds: configured, idleSeconds: null, lastActivityAt: null, wouldStop: false, reason: "idle", blockers: [] };
      result.push(candidate);
      // Leased devices belong to their lease's own deadline and cleanup; upkeep never touches them.
      if (leased) { candidate.reason = "leased"; continue; }
      if (row.desired !== "running" || row.observed !== "running") { candidate.reason = "not_running"; continue; }
      const blockers = candidate.blockers;
      if (deletion(db, row.id)) blockers.push("deletion_pending");
      if (hasPendingPowerOff(db, row.id)) blockers.push("power_off_pending");
      if (has("device_operations") && db.prepare("SELECT 1 FROM device_operations WHERE machine=? AND state IN ('queued','running')").get(row.id)) blockers.push("operation_in_flight");
      if (has("device_operations") && has("control_device_pending") && unresolvedInstall(db, row.id)) blockers.push("uncertain_install");
      if (has("mobile_video_sessions") && db.prepare("SELECT 1 FROM mobile_video_sessions WHERE machine=? AND state IN ('pending','attaching','ready')").get(row.id)) blockers.push("video_session");
      else if (unresolvedVideoSession(db, row.id)) blockers.push("video_cleanup_unconfirmed");
      if (has("app_artifacts") && db.prepare("SELECT 1 FROM app_artifacts WHERE machine=? AND state='uploading'").get(row.id)) blockers.push("upload_in_flight");
      if (has("image_tasks") && db.prepare("SELECT 1 FROM image_tasks WHERE machine=? AND state IN ('queued','running','unknown')").get(row.id)) blockers.push("capture_pending");
      // A locally attached display or connector is visible only to the host, which lists the device as busy.
      if (busy.has(row.id)) blockers.push("host_work_in_flight");
      // `active_at` is the last heartbeat on which something held this device, or its owner's last start.
      const activity = [latest("SELECT running_since AS at FROM machine_activity WHERE machine=?", row.id), latest("SELECT active_at AS at FROM machine_activity WHERE machine=?", row.id),
        has("device_operations") ? latest("SELECT MAX(MAX(created),MAX(updated)) AS at FROM device_operations WHERE machine=?", row.id) : null,
        has("mobile_video_sessions") ? latest("SELECT MAX(MAX(created),MAX(deadline)) AS at FROM mobile_video_sessions WHERE machine=?", row.id) : null];
      const runningSince = activity[0];
      if (runningSince !== null) {
        // A session deadline can lie ahead; activity never counts as later than now.
        candidate.lastActivityAt = Math.min(now, Math.max(...activity.filter(value => value !== null)));
        candidate.idleSeconds = Math.max(0, now - candidate.lastActivityAt);
      }
      if (configured === null) candidate.reason = "policy_off";
      else if (blockers.length) candidate.reason = blockers.some(b => b.startsWith("uncertain") || b.endsWith("unconfirmed")) ? "uncertain_operation" : "work_in_flight";
      else if (candidate.idleSeconds === null) candidate.reason = "running_time_unknown";
      else if (candidate.idleSeconds < configured) candidate.reason = "active";
      else candidate.wouldStop = true;
    }
    return result;
  }
  /** Requests `stopped` through the same desired state an owner's stop sets. Nothing is deleted,
   * and the host's normal reconciliation performs and proves the stop. Runs on every heartbeat
   * that carries the host's policy, also with the policy off, so activity is recorded either way. */
  private idlePass(db: DatabaseSync, host: string): void {
    const capability = this.capability(db, host);
    if (!capability) return;
    const now = this.store.clock();
    for (const candidate of this.idleCandidates(db, host, capability.idleStop, new Set(capability.busy), now)) {
      // Whatever holds a device is activity for as long as it holds it. Much of it carries no
      // timestamp of its own (an upload, a local viewer), so the hold itself is recorded and the
      // idle time starts over when it ends.
      if (candidate.blockers.length) { this.touch(db, candidate.machineId, now); continue; }
      if (!candidate.wouldStop) continue;
      if (db.prepare("UPDATE machines SET desired='stopped' WHERE id=? AND desired='running'").run(candidate.machineId).changes !== 1) continue;
      db.prepare("UPDATE machine_activity SET idle_stopped_at=?,idle_seconds=?,idle_policy=? WHERE machine=?").run(now, candidate.idleSeconds, candidate.idleStopSeconds, candidate.machineId);
    }
  }
  private dryRun(db: DatabaseSync, req: ControlRequest): Record<string, unknown> {
    const host = this.host(db, req.parts[2]), capability = this.capability(db, host.id), now = this.store.clock();
    let preview: number | undefined;
    for (const key of req.query.keys()) if (key !== "idleStopSeconds") invalid("Unsupported query.");
    if (req.query.has("idleStopSeconds")) {
      const raw = req.query.get("idleStopSeconds")!;
      if (!/^[0-9]{1,8}$/.test(raw)) invalid("Invalid idle stop preview.");
      preview = seconds(Number(raw), "idle stop preview", IDLE_STOP_MINIMUM_SECONDS, IDLE_STOP_MAXIMUM_SECONDS);
    }
    const configured = capability?.idleStop ?? { defaultSeconds: null, templates: {} };
    const devices = this.idleCandidates(db, host.id, preview === undefined ? configured : { defaultSeconds: preview, templates: {} }, new Set(capability?.busy ?? []), now);
    const stops = new Map((db.prepare("SELECT a.* FROM machine_activity a JOIN machines m ON m.id=a.machine WHERE m.host=? AND a.idle_stopped_at IS NOT NULL").all(host.id) as { machine: string; idle_stopped_at: number; idle_seconds: number; idle_policy: number }[])
      .map(row => [row.machine, { at: row.idle_stopped_at, idleSeconds: row.idle_seconds, idleStopSeconds: row.idle_policy }]));
    const inspection = db.prepare("SELECT * FROM host_operations WHERE host=? AND kind='storage-inspect' AND state='succeeded' ORDER BY updated DESC,rowid DESC LIMIT 1").get(host.id) as unknown as OperationRow | undefined;
    const result = inspection ? object(JSON.parse(inspection.result ?? "{}")) : {};
    const current = !!inspection && now - inspection.updated < STORAGE_INSPECTION_SECONDS;
    const entries = (Array.isArray(result.entries) ? result.entries : []).map(value => {
      // The controller's own ledger decides whether an owner is live; a name it cannot map is unknown.
      const { removes, ...entry } = object(value), owner = typeof entry.machineId === "string" && machineUuid.test(entry.machineId) ? this.owner(db, entry.machineId) : "unknown";
      const wouldRemove = current && result.complete === true && entry.removable === true && (owner === "absent" || owner === "deleted");
      // What a purge removes is listed only for an entry this purge would remove.
      return { ...entry, ...(wouldRemove && removes !== undefined ? { removes } : {}), controllerOwner: owner, wouldRemove,
        reason: wouldRemove ? entry.reason : !current ? "inspection_expired" : result.complete !== true ? "inventory_incomplete" : owner === "live" ? "live_owner" : entry.reason };
    });
    // A journal has no entry of its own in a purge: it is removed with the storage it belongs to.
    const removed = new Set(entries.filter(entry => entry.wouldRemove).map(entry => (entry as Record<string, unknown>).name));
    for (const entry of entries as Record<string, unknown>[]) if (typeof entry.removedWith === "string") entry.wouldRemove = removed.has(entry.removedWith);
    return { hostId: host.id, supported: !!capability, evaluatedAt: now,
      idleStop: { policy: configured, ...(preview === undefined ? {} : { previewSeconds: preview }),
        devices: devices.map(device => ({ ...device, ...(stops.has(device.machineId) ? { lastIdleStop: stops.get(device.machineId) } : {}) })) },
      orphans: { inspection: inspection ? { id: inspection.id, inspectedAt: inspection.updated, complete: result.complete === true, current } : null, entries },
      // Nothing above is acted on by reading it. Idle stops happen on the host's own heartbeat when
      // its policy is on; orphans are removed only by an explicit storage-purge operation.
      pending: (db.prepare("SELECT * FROM host_operations WHERE host=? AND (state IN ('queued','running') OR (state='unknown' AND acknowledged IS NULL AND kind IN " + MUTATIONS + ")) ORDER BY rowid").all(host.id) as unknown as OperationRow[]).map(view) };
  }

  handle(req: ControlRequest): ControlResponse | undefined {
    const p = req.parts;
    if (p[0] !== "v1") return undefined;
    const hostRoute = p[1] === "hosts" && p.length === 4, receipt = p[1] === "host-operations" && p.length === 3 && req.method === "GET";
    const resolve = p[1] === "host-operations" && p.length === 4 && p[3] === "resolve" && req.method === "POST";
    const operations = hostRoute && p[3] === "operations" && (req.method === "GET" || req.method === "POST");
    const runtimes = hostRoute && p[3] === "runtimes" && req.method === "GET", upkeep = hostRoute && p[3] === "upkeep" && req.method === "GET";
    if (!receipt && !resolve && !operations && !runtimes && !upkeep) return undefined;
    return this.store.transaction(db => {
      // Administrator authority only: application, lease, enrollment, host and guest credentials
      // are not accounts and resolve to no principal here.
      requireAdmin(req);
      this.expire(db);
      if (!upkeep && req.query.size) invalid("Queries are not supported.");
      if (resolve) return this.resolve(db, req);
      if (receipt) {
        const row = db.prepare("SELECT * FROM host_operations WHERE id=?").get(identifier(p[2])) as unknown as OperationRow | undefined;
        if (!row) throw new ServiceError("Unknown host operation.", 404);
        return { body: this.receipt(db, row) };
      }
      if (runtimes) return { body: this.runtimes(db, p[2]) };
      if (upkeep) return { body: this.dryRun(db, req) };
      if (req.method === "POST") return this.submit(db, req);
      const host = this.host(db, p[2]);
      return { body: { operations: (db.prepare("SELECT * FROM host_operations WHERE host=? ORDER BY rowid DESC LIMIT 50").all(host.id) as unknown as OperationRow[]).map(row => this.receipt(db, row)) } };
    });
  }
}
/** Register once per controller store. */
export function createModule(store: SqliteStore, _options: ControlOptions): ControlModule {
  const upkeep = new HostUpkeep(store);
  registerMachineHooks(store, upkeep.hooks);
  return upkeep;
}
