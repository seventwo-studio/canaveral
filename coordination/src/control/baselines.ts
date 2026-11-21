/** Saved device baselines: the controller's record of them and of the work to save or remove one.
 *
 * A baseline is the prepared disk state of one stopped, account-owned Android device, stored on
 * that device's host. It carries whatever its preparer installed, signed in to or configured to
 * every device made from it. Saving and removing are therefore administrator actions, and a
 * device is made from a baseline only through a pinned template that names it by name, revision
 * and digest. An administrator saves only a device that the same account owns, so nobody turns
 * another account's device, with its accounts and tokens, into a lease image; the deciding
 * principal is recorded. The bytes never reach the controller; it holds identity, binding and
 * disk charge.
 *
 * Implementation limit: fixture coverage only. No real AVD has been captured or cloned. */
import type { DatabaseSync } from "node:sqlite";
import { identifier } from "../consumers.ts";
import { object, ServiceError } from "../errors.ts";
import type { SqliteStore } from "../sqlite.ts";
import { requireAdmin } from "./contracts.ts";
import type { ControlModule, ControlRequest, ControlResponse, Principal } from "./contracts.ts";
import { isDeleted } from "./lifecycle.ts";
import { requireHostAdmission } from "./maintenance.ts";
import { registerMachineHooks } from "./machines.ts";
import type { MachineStore } from "./machines.ts";
import { poolDevice } from "./pool-ledger.ts";
import { BASELINE_NAME, BASELINE_REVISION } from "./templates.ts";

type Json = Record<string, any>;
interface BaselineRow {
  id: string; host: string; name: string; revision: string; machine: string; state: string; request: string; manifest: string | null;
  reserved_disk: number; detail: string | null; created: number; updated: number; actor: string; removal: string | null; removal_from: string | null; removed_by: string | null;
}
/** Who decided: kind, account and name at the time. Never a credential. */
const decidedBy = (principal: Principal): string => JSON.stringify({ kind: principal.kind, userId: principal.user?.id ?? null, username: principal.user?.username ?? null });
const GiB = 1024 ** 3, HOST_LEASE_SECONDS = 30;
/** Held states charge the host's disk: work in progress, a stored baseline and an unresolved outcome. */
const reservationSql = "SELECT 0 AS cpu,0 AS memoryMiB,COALESCE(SUM(reserved_disk),0) AS diskGiB FROM device_baselines WHERE host=? AND state IN ('saving','ready','unknown','removing')";

export function initializeBaselines(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS device_baselines (id TEXT PRIMARY KEY,host TEXT NOT NULL,name TEXT NOT NULL,revision TEXT NOT NULL,machine TEXT NOT NULL,state TEXT NOT NULL,request TEXT NOT NULL,manifest TEXT,
      reserved_disk INTEGER NOT NULL,detail TEXT,created REAL NOT NULL,updated REAL NOT NULL,actor TEXT NOT NULL,removal TEXT,removal_from TEXT,removed_by TEXT);
    CREATE UNIQUE INDEX IF NOT EXISTS device_baselines_identity ON device_baselines(host,name,revision) WHERE state NOT IN ('failed','removed');
    CREATE INDEX IF NOT EXISTS device_baselines_host ON device_baselines(host,state);
    CREATE TABLE IF NOT EXISTS host_baselines (host TEXT PRIMARY KEY,report TEXT NOT NULL,received REAL NOT NULL);`);
  if (!db.prepare("PRAGMA table_info(device_baselines)").all().some(column => column.name === "removed_by")) {
    db.exec(`ALTER TABLE device_baselines ADD COLUMN removed_by TEXT;
      UPDATE device_baselines SET actor=json_object(
        'kind', CASE WHEN actor='operator' THEN actor ELSE substr(actor,1,instr(actor,':')-1) END,
        'userId', CASE WHEN actor='operator' THEN NULL ELSE substr(actor,instr(actor,':')+1) END,
        'username', NULL
      ) WHERE NOT json_valid(actor);`);
  }
}
function row(db: DatabaseSync, id: string): BaselineRow | undefined { return db.prepare("SELECT * FROM device_baselines WHERE id=?").get(id) as unknown as BaselineRow | undefined; }
/** The host's own view of one stored baseline. Unknown fields are dropped; nothing here is a path. */
function inventoryEntry(value: unknown): Json {
  const entry = object(value), device = object(entry.device);
  const text = (item: unknown, pattern: RegExp): string => { if (typeof item !== "string" || pattern.exec(item)?.[0] !== item) throw new ServiceError("Invalid baseline inventory.", 400); return item; };
  const whole = (item: unknown, maximum: number): number => { if (typeof item !== "number" || !Number.isSafeInteger(item) || item < 0 || item > maximum) throw new ServiceError("Invalid baseline inventory.", 400); return item; };
  if (typeof entry.stale !== "boolean" || (entry.arch !== "arm64" && entry.arch !== "amd64")) throw new ServiceError("Invalid baseline inventory.", 400);
  return { id: identifier(entry.id), name: text(entry.name, BASELINE_NAME), revision: text(entry.revision, BASELINE_REVISION), digest: text(entry.digest, /^[a-f0-9]{64}$/), arch: entry.arch,
    device: { systemImage: text(device.systemImage, /^[A-Za-z0-9_.;:-]{1,200}$/), profile: text(device.profile, /^[A-Za-z0-9_.;:-]{1,200}$/) }, diskGiB: whole(entry.diskGiB, 1_048_576), bytes: whole(entry.bytes, Number.MAX_SAFE_INTEGER),
    files: whole(entry.files, 4096), createdAt: whole(entry.createdAt, Number.MAX_SAFE_INTEGER), sourceMachineId: identifier(entry.sourceMachineId), stale: entry.stale,
    ...(typeof entry.staleReason === "string" ? { staleReason: [...entry.staleReason].slice(0, 300).join("") } : {}) };
}
function inventory(db: DatabaseSync, host: string): Json[] {
  const saved = db.prepare("SELECT report FROM host_baselines WHERE host=?").get(host);
  return saved ? JSON.parse(String(saved.report)) as Json[] : [];
}
/** Templates and machines on the baseline's host that still name it. */
function references(db: DatabaseSync, baseline: BaselineRow): { templates: Json[]; machines: number } {
  const names = (image: Json): boolean => image.baseline?.name === baseline.name && image.baseline.revision === baseline.revision;
  const host = db.prepare("SELECT offer FROM hosts WHERE id=?").get(baseline.host);
  let offered: Json[] = [];
  try { offered = (JSON.parse(String(host?.offer)).templates as Json[]).filter(names); } catch { /* An opaque offer names nothing. */ }
  let machines = 0;
  for (const machine of db.prepare("SELECT id,template FROM machines WHERE host=?").all(baseline.host)) if (!isDeleted(db, String(machine.id)) && names(JSON.parse(String(machine.template)))) machines++;
  return { templates: offered.map(image => ({ id: image.id, revision: image.revision, arch: image.arch })), machines };
}
function view(db: DatabaseSync, baseline: BaselineRow): Json {
  const manifest = baseline.manifest ? JSON.parse(baseline.manifest) as Json : undefined;
  const stored = manifest ? inventory(db, baseline.host).find(entry => entry.name === baseline.name && entry.revision === baseline.revision && entry.digest === manifest.digest) : undefined;
  return { id: baseline.id, hostId: baseline.host, name: baseline.name, revision: baseline.revision, state: baseline.state, sourceMachineId: baseline.machine, reservedDiskGiB: baseline.reserved_disk,
    createdAt: baseline.created, updatedAt: baseline.updated, ...(baseline.detail ? { detail: baseline.detail } : {}),
    savedBy: JSON.parse(baseline.actor) as Json, ...(baseline.removed_by ? { removedBy: JSON.parse(baseline.removed_by) as Json } : {}),
    // The image binding: a device is made from this baseline only by a template with this exact definition.
    ...(manifest ? { digest: manifest.digest, arch: manifest.arch, device: manifest.device, diskGiB: manifest.diskGiB, bytes: manifest.bytes, files: manifest.files,
      // Stale means the host's installed system image no longer matches the one it was saved from.
      present: !!stored, stale: stored ? stored.stale : null, ...(stored?.staleReason ? { staleReason: stored.staleReason } : {}) } : {}),
    references: references(db, baseline) };
}

export function createBaselinesModule(store: SqliteStore, machines: MachineStore): ControlModule {
  store.transaction(initializeBaselines);
  registerMachineHooks(store, {
    heartbeatFields: ["baselines", "baselineReports"],
    additionalReservationsSql: { id: "device-baselines-v1", query: reservationSql },
    additionalReservations: (db, host) => ({ diskGiB: Number(db.prepare(reservationSql).get(host)!.diskGiB) }),
    afterHeartbeat(db, hostId, body) {
      const now = store.clock();
      if (body.baselines !== undefined) {
        if (!Array.isArray(body.baselines) || body.baselines.length > 100) throw new ServiceError("Invalid baseline inventory.", 400);
        db.prepare("INSERT INTO host_baselines VALUES (?,?,?) ON CONFLICT(host) DO UPDATE SET report=excluded.report,received=excluded.received").run(hostId, JSON.stringify(body.baselines.map(inventoryEntry)), now);
      }
      const reports = Object.entries(object(body.baselineReports ?? {}));
      if (reports.length > 1) throw new ServiceError("Report at most one baseline task per heartbeat.", 400);
      for (const [task, value] of reports) {
        const report = object(value), id = identifier(task);
        if (!["succeeded", "failed", "unknown"].includes(String(report.state))) throw new ServiceError("Invalid baseline task report.", 400);
        const baseline = db.prepare("SELECT * FROM device_baselines WHERE id=? OR removal=?").get(id, id) as unknown as BaselineRow | undefined;
        // A receipt repeated after a lost reply may name work that is already settled; it changes nothing.
        if (!baseline) continue;
        // Only the host that stores a baseline may report on it.
        if (baseline.host !== hostId) throw new ServiceError("Cannot report another host's baseline task.", 403);
        const result = object(report.result ?? {}), detail = typeof result.detail === "string" ? [...result.detail].slice(0, 500).join("") : null;
        if (baseline.id === id && baseline.state === "saving") {
          if (report.state === "succeeded") {
            const saved = inventoryEntry(result);
            if (saved.id !== baseline.id || saved.name !== baseline.name || saved.revision !== baseline.revision || saved.sourceMachineId !== baseline.machine) throw new ServiceError("Baseline receipt does not match its save.", 409);
            // The stored baseline is charged by its logical size from now on.
            db.prepare("UPDATE device_baselines SET state='ready',manifest=?,reserved_disk=?,detail=NULL,updated=? WHERE id=?").run(JSON.stringify(saved), Math.max(1, Math.ceil(saved.bytes / GiB)), now, baseline.id);
          } else if (report.state === "failed") {
            // A failed save published nothing and left no staging directory.
            db.prepare("UPDATE device_baselines SET state='failed',reserved_disk=0,detail=?,updated=? WHERE id=?").run(detail ?? "The baseline was not saved.", now, baseline.id);
          } else db.prepare("UPDATE device_baselines SET state='unknown',detail=?,updated=? WHERE id=?").run("The save was interrupted; its storage is unconfirmed. Remove this baseline to clear it.", now, baseline.id);
        } else if (baseline.removal === id && baseline.state === "removing") {
          if (report.state === "succeeded") db.prepare("UPDATE device_baselines SET state='removed',reserved_disk=0,detail=NULL,updated=? WHERE id=?").run(now, baseline.id);
          // A refused or interrupted removal leaves the baseline as it was; removal can be asked again.
          else db.prepare("UPDATE device_baselines SET state=?,removal=NULL,removal_from=NULL,removed_by=NULL,detail=?,updated=? WHERE id=?").run(baseline.removal_from ?? "unknown", detail ?? "Removal was not confirmed; request it again.", now, baseline.id);
        }
      }
    },
    heartbeatResponse(db, hostId) {
      const tasks: Json[] = [];
      for (const baseline of db.prepare("SELECT * FROM device_baselines WHERE host=? AND state IN ('saving','removing') ORDER BY created,id").all(hostId) as unknown as BaselineRow[]) {
        if (baseline.state === "removing") { tasks.push({ id: baseline.removal, kind: "remove", baseline: baseline.id, name: baseline.name, revision: baseline.revision }); continue; }
        const source = db.prepare("SELECT * FROM machines WHERE id=?").get(baseline.machine);
        if (source) tasks.push({ id: baseline.id, kind: "save", baseline: baseline.id, name: baseline.name, revision: baseline.revision, machineId: baseline.machine, machine: machines.machine(db, source, true, true) });
      }
      return { baselineTasks: tasks };
    },
  });
  const save = (db: DatabaseSync, req: ControlRequest, machineId: string): ControlResponse => {
    const principal = requireAdmin(req), body = req.body;
    if (Object.keys(body).sort().join() !== "id,name,revision") throw new ServiceError("A baseline save needs a request UUID, a name and a revision.", 400);
    const id = identifier(body.id);
    if (typeof body.name !== "string" || BASELINE_NAME.exec(body.name)?.[0] !== body.name || typeof body.revision !== "string" || BASELINE_REVISION.exec(body.revision)?.[0] !== body.revision) throw new ServiceError("Invalid baseline name or revision.", 400);
    const intent = JSON.stringify({ machineId, name: body.name, revision: body.revision }), old = row(db, id);
    if (old) {
      if (old.request !== intent) throw new ServiceError("Request UUID already belongs to another baseline save.", 409);
      return { body: view(db, old) };
    }
    const machine = db.prepare("SELECT * FROM machines WHERE id=?").get(machineId);
    if (!machine || isDeleted(db, machineId)) throw new ServiceError("Unknown machine.", 404);
    // Only an account-owned device is captured: never a leased device and never a warm pool device.
    if (poolDevice(db, machineId) || db.prepare("SELECT 1 FROM lease_members WHERE machine=?").get(machineId)) throw new ServiceError("A leased or warm pool device cannot be saved as a baseline.", 409, { code: "baseline_source_leased" });
    // A device holds its owner's accounts and tokens. An administrator saves only a device that the
    // same account owns; the operator credential, which is no user, only a device no user owns.
    if ((machine.owner ?? null) !== (principal.kind === "operator" ? null : principal.user!.id)) throw new ServiceError("Only the account that owns a device can save it as a baseline.", 403, { code: "baseline_source_not_owned" });
    const image = JSON.parse(String(machine.template)) as Json;
    if (image.os !== "android" || image.mode !== "device") throw new ServiceError("Baselines are supported for Android devices only.", 409, { code: "capability_unsupported" });
    const host = db.prepare("SELECT seen FROM hosts WHERE id=?").get(String(machine.host));
    requireHostAdmission(db, String(machine.host));
    // A running device is never captured: both the intent and the host's confirmed observation must be stopped.
    if (!host || store.clock() - Number(host.seen) >= HOST_LEASE_SECONDS || machine.desired !== "stopped" || machine.observed !== "stopped") throw new ServiceError("Stop the device and wait for its online host to confirm shutdown before saving a baseline.", 409, { code: "baseline_source_running" });
    if (db.prepare("SELECT 1 FROM machine_deletions WHERE machine=?").get(machineId)) throw new ServiceError("A device with a deletion intent cannot be saved.", 409);
    if (db.prepare("SELECT 1 FROM device_operations WHERE machine=? AND state='queued'").get(machineId)) throw new ServiceError("Wait for the device's queued operations before saving a baseline.", 409);
    if (db.prepare("SELECT 1 FROM device_baselines WHERE host=? AND name=? AND revision=? AND state NOT IN ('failed','removed')").get(String(machine.host), body.name, body.revision)) throw new ServiceError("This baseline name and revision already exists on the host; save a new revision.", 409, { code: "baseline_exists" });
    if (db.prepare("SELECT 1 FROM device_baselines WHERE machine=? AND state IN ('saving','unknown')").get(machineId)) throw new ServiceError("This device already has an unresolved baseline save.", 409);
    // Until the stored size is known, hold the most a device of this data size can copy:
    // its raw data image, an overlay of at most the same size and the small fixed images.
    const reserved = 2 * Number(JSON.parse(String(machine.request)).resources.diskGiB) + 2;
    if (reserved > machines.remainingCapacity(db, String(machine.host)).diskGiB) throw new ServiceError("The host has too little unreserved disk for this baseline.", 409, { code: "capacity_unavailable" });
    const now = store.clock();
    db.prepare("INSERT INTO device_baselines VALUES (?,?,?,?,?,'saving',?,NULL,?,NULL,?,?,?,NULL,NULL,NULL)").run(id, String(machine.host), body.name, body.revision, machineId, intent, reserved, now, now, decidedBy(principal));
    return { status: 201, body: view(db, row(db, id)!) };
  };
  const remove = (db: DatabaseSync, req: ControlRequest, id: string): ControlResponse => {
    const principal = requireAdmin(req);
    if (Object.keys(req.body).sort().join() !== "id") throw new ServiceError("A baseline removal needs a request UUID.", 400);
    const removal = identifier(req.body.id), baseline = row(db, id);
    if (!baseline) throw new ServiceError("Unknown baseline.", 404);
    if (baseline.state === "removed" || baseline.removal === removal) return { body: view(db, baseline) };
    if (db.prepare("SELECT 1 FROM device_baselines WHERE id=? OR removal=?").get(removal, removal)) throw new ServiceError("Request UUID already belongs to other baseline work.", 409);
    if (baseline.state === "removing") throw new ServiceError("This baseline is already being removed.", 409);
    // A failed save stored nothing; only its record is retired.
    if (baseline.state === "failed") { db.prepare("UPDATE device_baselines SET state='removed',removal=?,removed_by=?,updated=? WHERE id=?").run(removal, decidedBy(principal), store.clock(), id); return { body: view(db, row(db, id)!) }; }
    if (baseline.state === "saving") throw new ServiceError("Wait for the save to finish before removing this baseline.", 409);
    // Never removed while a template its host offers, or any device there, still names it.
    const used = references(db, baseline);
    if (used.templates.length || used.machines) throw new ServiceError("A lease image or a device on this host still names this baseline.", 409, { code: "baseline_referenced" });
    db.prepare("UPDATE device_baselines SET state='removing',removal=?,removal_from=?,removed_by=?,updated=? WHERE id=?").run(removal, baseline.state, decidedBy(principal), store.clock(), id);
    return { body: view(db, row(db, id)!) };
  };
  return { handle(req) {
    const [root, kind, id, action] = req.parts;
    const saving = req.method === "POST" && req.parts.length === 4 && root === "v1" && kind === "machines" && action === "baselines";
    const listing = req.method === "GET" && req.path === "/v1/baselines";
    const reading = req.method === "GET" && req.parts.length === 3 && root === "v1" && kind === "baselines";
    const removing = req.method === "POST" && req.parts.length === 4 && root === "v1" && kind === "baselines" && action === "remove";
    if (!saving && !listing && !reading && !removing) return undefined;
    return store.transaction(db => {
      if ([...req.query.keys()].length) throw new ServiceError("Queries are not supported.", 400);
      if (saving) return save(db, req, identifier(id));
      if (removing) return remove(db, req, identifier(id));
      // What a baseline holds is whatever its preparer put on it; its inventory is administrative.
      requireAdmin(req);
      if (listing) return { body: { baselines: (db.prepare("SELECT * FROM device_baselines WHERE state!='removed' ORDER BY host,name,revision,created").all() as unknown as BaselineRow[]).map(item => view(db, item)) } };
      const baseline = row(db, identifier(id));
      if (!baseline) throw new ServiceError("Unknown baseline.", 404);
      return { body: view(db, baseline) };
    });
  } };
}
