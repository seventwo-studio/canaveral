import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { identifier } from "../consumers.ts";
import { hasCurrentRunnerBinding } from "../enrollment.ts";
import { object, ServiceError } from "../errors.ts";
import { physicalMapping } from "../physical-domains.ts";
import type { SqliteStore } from "../sqlite.ts";
import { updateDraining } from "../updates/drain.ts";
import { requireAdmin } from "./contracts.ts";
import { installAttemptClean } from "./install-cleanup.ts";
import type { InstallAttempt } from "./install-cleanup.ts";
import type { ControlRequest } from "./contracts.ts";
import type { MachineHooks } from "./machines.ts";

type Owner = "manual" | "update" | "legacy";
type Row = Record<string, string | number | null>;
type Drain = { id: string; host: string; phase: "draining" | "resumed"; reason: string | null; created_at: number;
  resume_id: string | null; challenge: string | null; challenge_issued_at: number | null; challenge_run: string | null; challenge_fingerprint: string | null;
  ack_at: number | null; ack_run: string | null; ack_fingerprint: string | null; ack_report: string | null };
type InventoryItem = { id: string; storage: "present" | "absent" | "unknown" | "unsupported" | "notMaterialized"; stopProof: "native" | "unsupported" };
type Proof = { drainId: string; challenge: string; idle: boolean; workloadsStopped: boolean;
  inventory: { complete: boolean; assignments: InventoryItem[]; unexpected: string[] }; issues: string[] };
type Blocker = { kind: string; id: string; state: string; detail: string; blocks: ["powerOff"] | ["powerOff", "resume"] };

function table(db: DatabaseSync, name: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}
function activeDrain(db: DatabaseSync, host: string): Drain | undefined {
  return db.prepare("SELECT * FROM host_maintenance WHERE host=? AND phase='draining'").get(host) as Drain | undefined;
}
function latestDrain(db: DatabaseSync, host: string): Drain | undefined {
  return activeDrain(db, host) ?? db.prepare("SELECT * FROM host_maintenance WHERE host=? ORDER BY rowid DESC LIMIT 1").get(host) as Drain | undefined;
}

export function hostAdmissionClosed(db: DatabaseSync, hostId: string): { closed: boolean; owners: Owner[] } {
  if (!db.isTransaction) throw new TypeError("Host admission requires a transaction.");
  const owners: Owner[] = [];
  if (table(db, "host_maintenance") && activeDrain(db, hostId)) owners.push("manual");
  if (updateDraining(db, hostId)) owners.push("update");
  if (table(db, "hosts") && db.prepare("SELECT * FROM hosts WHERE id=?").get(hostId)?.enabled === 0) owners.push("legacy");
  return { closed: owners.length > 0, owners };
}
function draining(): never { throw new ServiceError("Host admission is closed.", 409, { code: "host_draining" }); }
export function requireHostAdmission(db: DatabaseSync, hostId: string): void {
  if (hostAdmissionClosed(db, hostId).closed) draining();
}
export function domainAdmissionClosed(db: DatabaseSync, domainId: string): boolean {
  const mapping = physicalMapping(db, { domainId });
  return !!mapping && hostAdmissionClosed(db, mapping.hostId).closed;
}
export function requireDomainAdmission(db: DatabaseSync, domainId: string): void {
  if (domainAdmissionClosed(db, domainId)) draining();
}

const proofLifetime = 20;
const terminalUpdate = "('succeeded','rolledBack','failed','cancelled')";
function ledger(db: DatabaseSync, host: string, browserHosts: readonly string[], drainStartedAt: number | null) {
  const h = db.prepare("SELECT offer,credential FROM hosts WHERE id=?").get(host);
  let provider: unknown;
  try { provider = JSON.parse(String(h?.offer))?.provider; } catch { /* An opaque legacy offer has no usable provider contract. */ }
  const mapping = physicalMapping(db, { hostId: host });
  const domain = mapping?.domainId;
  const reported = table(db, "host_maintenance_capabilities") ? db.prepare("SELECT reports FROM host_maintenance_capabilities WHERE host=?").get(host)?.reports : null;
  const reportIds = new Set<string>(reported ? JSON.parse(String(reported)) : []);
  const assignments = db.prepare(`SELECT m.id,m.desired,m.observed FROM machines m WHERE m.host=?
    AND NOT EXISTS (SELECT 1 FROM machine_deletions d WHERE d.machine=m.id AND d.state='complete')
    AND NOT EXISTS (SELECT 1 FROM lease_cleanup_members l WHERE l.machine=m.id AND l.state='complete')
    ORDER BY m.id`).all(host).map(m => ({ id: String(m.id), desired: String(m.desired), observed: String(m.observed), reported: reportIds.has(String(m.id)) }));
  const entries: { kind: string; id: string; state: string; detail: string; extra?: Row }[] = [];
  const runnerBindings = !!domain && table(db, "runner_bindings");
  function add(tables: string[], kind: string, detail: string, query: string, target = host, ...args: SQLInputValue[]) {
    if (tables.some(name => !table(db, name))) return;
    for (const row of db.prepare(query).all(target, ...args) as Row[]) {
      const { id, state, ...extra } = row;
      const lostAuthority = extra.controller !== undefined && (!runnerBindings ||
        !hasCurrentRunnerBinding(db, { controllerId: String(extra.controller), runnerId: String(extra.runner),
          generation: Number(extra.generation), incarnationId: String(extra.incarnation) }));
      entries.push(lostAuthority ? { kind: "unknownState", id: String(id), state: "unknown", detail: detail + " has lost runner authority.", extra } :
        { kind, id: String(id), state: String(state), detail, extra });
    }
  }

  add(["machine_power_offs"], "operation", "Machine power-off", `SELECT o.id,o.state,o.state='succeeded' AS terminal
    FROM machine_power_offs o JOIN machines m ON m.id=o.machine WHERE m.host=? AND (o.state!='succeeded' OR o.created>=?)`, host, drainStartedAt);
  add(["machine_deletions"], "operation", "Machine deletion", `SELECT o.id,o.state FROM machine_deletions o
    JOIN machines m ON m.id=o.machine WHERE m.host=? AND o.state!='complete'`);
  add(["image_tasks"], "operation", "Image task", "SELECT id,state FROM image_tasks WHERE host=? AND state IN ('queued','running','unknown')");
  const deviceDispatched = table(db, "control_device_dispatch");
  add(["device_operations"], "operation", "Device operation", `SELECT o.id,o.state${deviceDispatched ? ",d.id IS NOT NULL AS dispatched" : ""}
    FROM device_operations o ${deviceDispatched ? "LEFT JOIN control_device_dispatch d ON d.id=o.id" : ""}
    WHERE o.host=? AND o.state IN ('queued','running','unknown')`);
  if (table(db, "device_operations") && table(db, "control_device_pending")) {
    const attempts = db.prepare(`SELECT id,state,result FROM device_operations WHERE host=?
      AND state IN ('succeeded','failed','unknown') AND json_extract(request,'$.action')='install-uploaded'`).all(host) as unknown as InstallAttempt[];
    for (const attempt of attempts) if (!installAttemptClean(db, attempt)) {
      entries.push({ kind: "operation", id: attempt.id, state: "uncertain", detail: "Uploaded app install cleanup is unconfirmed.", extra: { outcome: attempt.state } });
    }
  }
  add(["inference_jobs"], "operation", "Embedded inference", "SELECT id,state,desired FROM inference_jobs WHERE host=? AND state NOT IN ('succeeded','failed','cancelled')");
  add(["app_artifacts"], "operation", "App artifact upload", "SELECT id,state,received FROM app_artifacts WHERE host=? AND state='uploading'");
  add(["leases", "lease_members"], "lease", "Machine lease", `SELECT DISTINCT l.id,l.state,l.cleanup FROM leases l
    JOIN lease_members lm ON lm.lease=l.id JOIN machines m ON m.id=lm.machine WHERE m.host=? AND l.cleanup!='complete'`);
  add(["lease_cleanup_members"], "lease", "Machine lease cleanup", `SELECT l.id,l.state,l.reason FROM lease_cleanup_members l
    JOIN machines m ON m.id=l.machine WHERE m.host=? AND l.state!='complete'`);
  add(["control_access_sessions"], "session", "Access session", `SELECT id,state,host_attached,consumer_attached FROM control_access_sessions
    WHERE host=? AND ledger='legacy' AND state IN ('pending','attaching','ready')`);
  add(["mobile_video_sessions"], "session", "Mobile video session", "SELECT id,state,host_attached,consumer_attached FROM mobile_video_sessions WHERE host=? AND cleaned=0");
  add(["attached_sessions"], "session", "Attached session", "SELECT id,'active' AS state FROM attached_sessions WHERE host=?");
  add(["browser_launches"], "session", "Browser launch", "SELECT id,state FROM browser_launches WHERE host=? AND state IN ('launching','active')");
  if (browserHosts.includes(host)) entries.push({ kind: "unsupportedProof", id: host, state: "browser", detail: "Configured browser worker has no maintenance proof." });
  if (table(db, "host_update_jobs")) {
    const classified = db.prepare("PRAGMA table_info(host_update_jobs)").all().some(c => c.name === "target_kind");
    const plan = table(db, "update_component_plans") ? ",EXISTS (SELECT 1 FROM update_component_plans p WHERE p.job=j.id) AS planned" : "";
    const receipts = table(db, "update_component_reports") ? ",(SELECT MAX(r.sequence) FROM update_component_reports r WHERE r.job=j.id) AS componentSequence" : "";
    // Keep terminal jobs in the fingerprint. Plans are insert-only and sequences advance even if the phase cycles.
    const columns = `id,phase AS state,phase IN ${terminalUpdate} AS terminal${classified ? ",uncertain,sequence,delivered" : ""}${plan}${receipts}`;
    add([], "update", "Runtime update", `SELECT ${columns} FROM host_update_jobs j
      WHERE host=?${classified ? " AND target_kind='host'" : ""}`);
    if (classified && domain) add([], "update", "Mapped runner update", `SELECT ${columns} FROM host_update_jobs j
      WHERE host IN (${mappedRunners(db)}) AND target_kind='runner'`, domain);
  }
  if (domain) {
    for (const [tableName, state] of [["linux_lease_runner_approvals", "linux"], ["model_runner_approvals", "model"]]) {
      add([tableName!], "unsupportedProof", "Mapped runner has no maintenance proof.",
        `SELECT runner AS id,'${state}' AS state,generation,incarnation,revoked FROM ${tableName} WHERE domain=? AND revoked=0`, domain);
    }
    add(["model_assignments", "model_jobs"], "operation", "Mapped model assignment", `SELECT a.id,j.state,j.cancel_requested,j.cleanup,j.stopped,a.sequence,a.controller,a.runner,a.generation,a.incarnation
      FROM model_assignments a JOIN model_jobs j ON j.application=a.application AND j.id=a.job WHERE a.domain=? AND a.closed=0`, domain);
    add(["linux_leases"], "lease", "Mapped Linux lease", `SELECT id,state,runtime,cleanup FROM linux_leases
      WHERE domain=? AND (state IN ('provisioning','ready') OR cleanup!='complete')`, domain);
    add(["linux_leases", "linux_lease_assignments"], "operation", "Mapped Linux assignment", `SELECT a.id,l.runtime AS state,a.stopped,a.storage_removed,a.credentials_erased,a.sequence,a.controller,a.runner,a.generation,a.incarnation
      FROM linux_lease_assignments a JOIN linux_leases l ON l.id=a.lease WHERE l.domain=? AND a.closed=0`, domain);
    add(["linux_leases", "linux_operations"], "operation", "Linux command", `SELECT o.id,o.state,o.dispatched FROM linux_operations o
      JOIN linux_leases l ON l.id=o.lease WHERE l.domain=? AND o.state NOT IN ('succeeded','failed','cancelled')`, domain);
    add(["linux_leases", "linux_transfers"], "operation", "Linux transfer", `SELECT t.id,t.state,t.offset FROM linux_transfers t
      JOIN linux_leases l ON l.id=t.lease WHERE l.domain=? AND t.state IN ('created','writing','reading','unknown')`, domain);
    add(["linux_leases", "linux_transfer_steps"], "operation", "Linux transfer step", `SELECT t.id || '/' || s.step AS id,s.state FROM linux_transfer_steps s
      JOIN linux_transfers t ON t.id=s.id JOIN linux_leases l ON l.id=t.lease WHERE l.domain=? AND s.state IN ('queued','dispatched','unknown')`, domain);
    add(["linux_leases", "control_access_sessions"], "session", "Mapped Linux access session", `SELECT s.id,s.state,s.host_attached,s.consumer_attached
      FROM control_access_sessions s JOIN linux_leases l ON l.id=s.lease WHERE l.domain=? AND s.ledger='linux' AND s.state IN ('pending','attaching','ready')`, domain);
  }
  entries.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return { provider, credential: h?.credential, domain, assignments, entries };
}

function mappedRunners(db: DatabaseSync): string {
  const queries = ["linux_lease_runner_approvals","model_runner_approvals"].filter(name => table(db, name))
    .map(name => `SELECT runner FROM ${name} WHERE domain=(SELECT domain FROM mapped) AND revoked=0`);
  return `WITH mapped(domain) AS (VALUES (?)) ${queries.join(" UNION ") || "SELECT NULL FROM mapped"}`;
}
function fingerprint(data: ReturnType<typeof ledger>): string {
  return createHash("sha256").update(JSON.stringify(data)).digest("hex");
}
export function maintenanceFingerprint(db: DatabaseSync, host: string, browserHosts: readonly string[] = []): string {
  const drainStartedAt = table(db, "host_maintenance") ? activeDrain(db, host)?.created_at : undefined;
  return fingerprint(ledger(db, host, browserHosts, drainStartedAt ?? null));
}

function exact(input: unknown, required: string[], optional: string[] = []): Record<string, unknown> {
  const v = object(input);
  if (required.some(key => !Object.hasOwn(v, key)) || Object.keys(v).some(key => !required.includes(key) && !optional.includes(key))) invalid();
  return v;
}
function invalid(): never { throw new ServiceError("Invalid maintenance request.", 400); }
function strings(input: unknown): string[] {
  if (!Array.isArray(input) || input.length > 100 || input.some(v => typeof v !== "string" || [...v].length > 200)) invalid();
  return input;
}
function proof(input: unknown): Proof | undefined {
  const extension = exact(input, ["version"], ["proof"]);
  if (extension.version !== 1) invalid();
  if (!Object.hasOwn(extension, "proof")) return undefined;
  const v = exact(extension.proof, ["drainId", "challenge", "idle", "workloadsStopped", "inventory", "issues"]);
  const inv = exact(v.inventory, ["complete", "assignments", "unexpected"]);
  if (typeof v.drainId !== "string" || v.drainId.length > 200 || typeof v.challenge !== "string" || !/^[a-f0-9]{64}$/.test(v.challenge) ||
      typeof v.idle !== "boolean" || typeof v.workloadsStopped !== "boolean" || typeof inv.complete !== "boolean" ||
      !Array.isArray(inv.assignments) || inv.assignments.length > 10000) invalid();
  const ids = new Set<string>();
  const assignments = inv.assignments.map(input => {
    const item = exact(input, ["id", "storage", "stopProof"]);
    if (typeof item.id !== "string" || [...item.id].length > 200 || ids.has(item.id) ||
        !["present", "absent", "unknown", "unsupported", "notMaterialized"].includes(item.storage as string) || !["native", "unsupported"].includes(item.stopProof as string)) invalid();
    ids.add(item.id);
    return item as InventoryItem;
  });
  return { drainId: identifier(v.drainId), challenge: v.challenge, idle: v.idle, workloadsStopped: v.workloadsStopped,
    inventory: { complete: inv.complete, assignments, unexpected: strings(inv.unexpected) }, issues: strings(v.issues) };
}

export class HostMaintenance {
  private readonly run = randomUUID();
  constructor(readonly store: SqliteStore, readonly browserHosts: readonly string[] = []) {
    store.transaction(db => {
      db.exec(`
      CREATE TABLE IF NOT EXISTS host_maintenance (
        id TEXT PRIMARY KEY, host TEXT NOT NULL, actor TEXT, reason TEXT, created_at INTEGER NOT NULL,
        phase TEXT NOT NULL CHECK(phase IN ('draining','resumed')), resume_id TEXT UNIQUE, resumed_at INTEGER,
        challenge TEXT, challenge_run TEXT, challenge_fingerprint TEXT, challenge_issued_at REAL, ack_at INTEGER, ack_run TEXT, ack_fingerprint TEXT, ack_report TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS host_maintenance_active ON host_maintenance(host) WHERE phase='draining';
      CREATE INDEX IF NOT EXISTS host_maintenance_history ON host_maintenance(host);
      CREATE TABLE IF NOT EXISTS host_maintenance_capabilities (host TEXT PRIMARY KEY, supported INTEGER NOT NULL, reports TEXT);
      `);
      if (!db.prepare("PRAGMA table_info(host_maintenance)").all().some(column => column.name === "challenge_issued_at")) {
        db.exec("ALTER TABLE host_maintenance ADD COLUMN challenge_issued_at REAL");
      }
    });
  }
  readonly hooks: MachineHooks = {
    heartbeatFields: ["maintenance"],
    heartbeatResponse: (db, host, body) => {
      const capable = Object.hasOwn(body, "maintenance"), report = capable ? proof(body.maintenance) : undefined;
      const row = activeDrain(db, host);
      const reports = JSON.stringify(Object.keys(object(body.reports ?? {})).map(identifier));
      db.prepare(`INSERT INTO host_maintenance_capabilities VALUES (?,?,?) ON CONFLICT(host)
        DO UPDATE SET supported=excluded.supported,reports=excluded.reports`).run(host, Number(capable), reports);
      if (!row) {
        const previous = latestDrain(db, host);
        return { maintenance: previous ? { version: 1, phase: "resumed", drainId: previous.id } : { version: 1, phase: "open", drainId: null } };
      }
      const hash = fingerprint(ledger(db, host, this.browserHosts, row.created_at));
      const now = this.store.clock(), issued = row.challenge_issued_at;
      if (issued !== null && now >= issued && now - issued < proofLifetime && report?.drainId === row.id && report.challenge === row.challenge && row.challenge_run === this.run && row.challenge_fingerprint === hash) {
        db.prepare("UPDATE host_maintenance SET ack_at=?,ack_run=?,ack_fingerprint=?,ack_report=? WHERE id=?")
          .run(issued, this.run, hash, JSON.stringify(report), row.id);
      } else if (row.ack_fingerprint !== null && row.ack_fingerprint !== hash) {
        // Observations and cleanup receipts can return to an earlier state on later heartbeats.
        db.prepare("UPDATE host_maintenance SET ack_fingerprint=NULL WHERE id=?").run(row.id);
      }
      const challenge = randomBytes(32).toString("hex");
      db.prepare("UPDATE host_maintenance SET challenge=?,challenge_run=?,challenge_fingerprint=?,challenge_issued_at=? WHERE id=?").run(challenge, this.run, hash, now, row.id);
      return { maintenance: { version: 1, phase: "draining", drainId: row.id, challenge } };
    },
  };
  private status(db: DatabaseSync, row: Drain) {
    const { closed, owners } = hostAdmissionClosed(db, row.host);
    const data = ledger(db, row.host, this.browserHosts, row.created_at);
    const scope = data.provider === "kubevirt" ? "pool" : "directHost";
    const now = this.store.clock(), blockers: Blocker[] = [];
    function block(kind: string, id: string, state: string, detail: string, resume = false) {
      blockers.push({ kind, id, state, detail, blocks: resume ? ["powerOff", "resume"] : ["powerOff"] });
    }
    if (row.phase === "draining") {
      const capability = db.prepare("SELECT supported FROM host_maintenance_capabilities WHERE host=?").get(row.host);
      const age = now - (row.ack_at ?? 0);
      const ackState = row.ack_at === null ? "missing" : row.ack_run !== this.run ? "previousRun" :
        age < 0 || age >= proofLifetime ? "stale" : row.ack_fingerprint !== fingerprint(data) ? "ledgerChanged" : null;
      if (ackState) block("acknowledgement", row.id, ackState, "A current maintenance acknowledgement is required.", true);
      if (!capability?.supported) block("agentUnsupported", row.host, "unsupported", "Host agent has not advertised maintenance v1.", true);
      if (scope === "pool") block("poolScope", row.host, "pool", "A pool cannot prove its underlying nodes safe to power off.");
      const report = !ackState && row.ack_report ? JSON.parse(row.ack_report) as Proof : undefined;
      const inventory = new Map(report?.inventory.assignments.map(item => [item.id, item]));
      const expected = new Set(data.assignments.map(item => item.id));
      const online = now - Number(db.prepare("SELECT seen FROM hosts WHERE id=?").get(row.host)?.seen) < proofLifetime;
      for (const m of data.assignments) {
        if (m.desired !== "stopped" || m.observed !== "stopped") block("assignment", m.id, m.observed, `Desired state is ${m.desired}.`);
        if (!online || !m.reported || m.observed === "unknown") block("unknownState", m.id, "unknown", "A fresh assignment observation is required.", true);
        const item = inventory.get(m.id);
        if (report && !item) block("incompleteInventory", m.id, "missing", "Host did not inspect this assignment.", true);
        if (item?.stopProof === "unsupported") block("unsupportedProof", m.id, "unsupported", "Runtime cannot prove this assignment stopped.");
        if (item?.storage === "unsupported") {
          block("unsupportedProof", m.id, "unsupported", "Runtime cannot inspect this assignment's backing storage.");
        } else if (item?.storage === "absent" || item?.storage === "unknown") {
          block("missingResource", m.id, item.storage, "Expected assignment storage could not be confirmed.", true);
        }
      }
      if (report) {
        if (!report.inventory.complete) block("incompleteInventory", row.host, "incomplete", "Host could not inspect its entire inventory.", true);
        for (const id of new Set([...report.inventory.unexpected, ...[...inventory.keys()].filter(id => !expected.has(id))])) {
          block("unexpectedResource", id, "unexpected", "Host found a resource outside its assignments.", true);
        }
        if (!report.idle || !report.workloadsStopped) block("notIdle", row.host, "busy", "Host has not confirmed quiescence.");
      }
      for (const { kind, id, state, detail, extra } of data.entries) {
        if (extra?.terminal) continue;
        const uncertain = kind === "operation" && (state === "unknown" || state === "uncertain") || kind === "update" && !!extra?.uncertain;
        block(uncertain ? "uncertainOperation" : kind, id, state, detail, uncertain || kind === "unknownState");
      }
    }
    return { id: row.id, hostId: row.host, scope, phase: row.phase, createdAt: row.created_at, reason: row.reason,
      admissionClosed: closed, owners, safeToPowerOff: row.phase === "draining" && !blockers.length,
      readyToResume: row.phase === "draining" && !blockers.some(b => b.blocks.length === 2), lastRunnerConfirmedAt: row.ack_at, blockers };
  }
  summary(db: DatabaseSync, host: string) {
    const row = latestDrain(db, host);
    if (!row) return null;
    const { id, phase, safeToPowerOff, readyToResume } = this.status(db, row);
    return { id, phase, safeToPowerOff, readyToResume };
  }
  handle(req: ControlRequest, transaction: <T>(operation: (db: DatabaseSync) => T) => T) {
    const p = req.parts;
    if (p[0] !== "v1" || p[1] !== "hosts" || p[3] !== "maintenance") return undefined;
    const begin = p.length === 4 && req.method === "POST", read = p.length === 4 && req.method === "GET";
    const resume = p.length === 6 && p[5] === "resume" && req.method === "POST";
    if (!begin && !read && !resume) return undefined;
    return transaction(db => {
      const actor = requireAdmin(req), host = identifier(p[2]);
      if (req.query.size) invalid();
      if (!db.prepare("SELECT 1 FROM hosts WHERE id=? AND id NOT IN (SELECT id FROM retired_runners)").get(host)) throw new ServiceError("Unknown host.", 404);
      if (read) {
        const row = latestDrain(db, host);
        return { body: row ? this.status(db, row) : null };
      }
      if (begin) {
        const { id: inputId, reason = null } = exact(req.body, ["id"], ["reason"]), id = identifier(inputId);
        if (Object.hasOwn(req.body, "reason") && (typeof reason !== "string" || [...reason].length > 500)) invalid();
        const old = db.prepare("SELECT * FROM host_maintenance WHERE id=?").get(id) as Drain | undefined;
        if (old) {
          if (old.host !== host || old.reason !== reason) throw new ServiceError("Maintenance UUID belongs to a different intent.", 409);
          return { status: 200, body: this.status(db, old) };
        }
        if (activeDrain(db, host)) throw new ServiceError("Host already has an active maintenance drain.", 409);
          db.prepare("INSERT INTO host_maintenance(id,host,actor,reason,created_at,phase) VALUES (?,?,?,?,?,'draining')")
          .run(id, host, actor.user?.id ?? "operator", reason as string | null, this.store.clock());
        return { status: 201, body: this.status(db, activeDrain(db, host)!) };
      }
      const id = identifier(p[4]), requestId = identifier(exact(req.body, ["requestId"]).requestId);
      const row = db.prepare("SELECT * FROM host_maintenance WHERE id=? AND host=?").get(id, host) as Drain | undefined;
      if (!row) throw new ServiceError("Unknown drain.", 404);
      if (row.resume_id === requestId) return { body: this.status(db, row) };
      if (row.phase !== "draining" || db.prepare("SELECT 1 FROM host_maintenance WHERE resume_id=?").get(requestId)) throw new ServiceError("Resume UUID conflicts with maintenance history.", 409);
      const status = this.status(db, row);
      if (!status.readyToResume) return { status: 409, body: { error: "Resume is blocked until the listed resume blockers are resolved.", code: "maintenance_blocked", status } };
      db.prepare("UPDATE host_maintenance SET phase='resumed',resume_id=?,resumed_at=?,challenge=NULL,challenge_run=NULL,challenge_fingerprint=NULL,challenge_issued_at=NULL WHERE id=?")
        .run(requestId, this.store.clock(), row.id);
      return { body: this.status(db, { ...row, phase: "resumed" }) };
    });
  }
}
