import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { identifier } from "../consumers.ts";
import { object, ServiceError } from "../errors.ts";
import type { SqliteStore } from "../sqlite.ts";
import { owns, requireScope } from "./contracts.ts";
import type { ControlModule, ControlOptions, ControlRequest, Principal } from "./contracts.ts";

/** Controller coordination only. Native stop/removal proofs belong to the runner. */
export const HOST_LEASE_SECONDS = 30;
const terminal = new Set(["failed", "released", "expired"]);
const observedStates = new Set(["pending", "starting", "running", "stopping", "stopped", "error", "unknown"]);
const reasons = new Set(["execution_pending", "operations_pending", "sessions_pending", "ownership",
  "storage_removal", "credential_erasure", "unsupported", "recovery"]);
const completionFlags = ["executionStopped", "storageRemoved", "credentialsErased"] as const;

interface IntentRow { id: string; machine: string; state: string; created: number }
export interface CleanupRow {
  id: string; machine: string; lease: string; state: string; reason: string | null;
  attempts: number; next_retry: number; updated: number;
}
export interface MachineReservation { id: string; desired: string; observed: string }
interface MachineRow extends MachineReservation { host: string; owner: string | null; template: string }
export interface LifecycleFields {
  powerOffRequest?: string;
  deletion?: { id: string; state: string };
  leaseCleanup?: { id: string; leaseId: string; state: string; attempts: number; notBefore: number };
  ready?: boolean;
}

/** Faithful legacy schemas preserve queued/uncertain receipts across migration. */
export function initializeLifecycle(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS machine_power_offs (id TEXT PRIMARY KEY,machine TEXT NOT NULL,state TEXT NOT NULL,created REAL NOT NULL);
    CREATE INDEX IF NOT EXISTS machine_power_offs_machine ON machine_power_offs(machine,state);
    CREATE TABLE IF NOT EXISTS machine_deletions (id TEXT PRIMARY KEY,machine TEXT NOT NULL UNIQUE,state TEXT NOT NULL,created REAL NOT NULL);
    CREATE TABLE IF NOT EXISTS lease_cleanup_members (id TEXT PRIMARY KEY,machine TEXT NOT NULL UNIQUE,lease TEXT NOT NULL,state TEXT NOT NULL,reason TEXT,attempts INTEGER NOT NULL,next_retry REAL NOT NULL,updated REAL NOT NULL);
    CREATE INDEX IF NOT EXISTS lease_cleanup_lease ON lease_cleanup_members(lease,state);
  `);
}

function tableExists(db: DatabaseSync, table: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
}

function leaseOwned(db: DatabaseSync, machineId: string): boolean {
  return tableExists(db, "lease_members") && !!db.prepare("SELECT 1 FROM lease_members WHERE machine=?").get(machineId);
}

export function deletion(db: DatabaseSync, machineId: string): IntentRow | undefined {
  return db.prepare("SELECT * FROM machine_deletions WHERE machine=?").get(machineId) as unknown as IntentRow | undefined;
}

export function leaseCleanup(db: DatabaseSync, machineId: string): CleanupRow | undefined {
  return db.prepare("SELECT * FROM lease_cleanup_members WHERE machine=?").get(machineId) as unknown as CleanupRow | undefined;
}

export function isDeleted(db: DatabaseSync, machineId: string): boolean {
  return deletion(db, machineId)?.state === "complete" || leaseCleanup(db, machineId)?.state === "complete";
}

export function hasPendingPowerOff(db: DatabaseSync, machineId: string): boolean {
  return !!db.prepare("SELECT 1 FROM machine_power_offs WHERE machine=? AND state!='succeeded'").get(machineId);
}

/** Storage is reserved for every non-deleted machine; use this for CPU/memory only. */
export function computeReserved(db: DatabaseSync, row: MachineReservation): boolean {
  if (isDeleted(db, row.id)) return false;
  return leaseOwned(db, row.id) || row.desired === "running" || row.observed !== "stopped" || hasPendingPowerOff(db, row.id);
}

function visibleMachine(db: DatabaseSync, principal: Principal, machineId: string): MachineRow {
  const row = db.prepare("SELECT * FROM machines WHERE id=?").get(machineId) as unknown as MachineRow | undefined;
  if (!row || !owns(principal, row.owner)) throw new ServiceError("Unknown machine.", 404);
  return row;
}

function pendingCapture(db: DatabaseSync, machineId: string): boolean {
  return tableExists(db, "image_tasks") && !!db.prepare("SELECT 1 FROM image_tasks WHERE machine=? AND state IN ('queued','running','unknown')").get(machineId);
}

function requestIntent(store: SqliteStore, req: ControlRequest, action: "power-off" | "delete") {
  const body = object(req.body);
  if (Object.keys(body).length !== 1 || !Object.hasOwn(body, "id")) {
    throw new ServiceError("Lifecycle operations require a stable request UUID and no other fields.", 400);
  }
  const machineId = identifier(req.parts[2]), requestId = identifier(body.id);
  return store.transaction(db => {
    const principal = requireScope(req, "write");
    // Hide foreign receipt identities before comparing their target or operation,
    // including requests against absent machines and attempts to change operation.
    const oldPower = db.prepare("SELECT * FROM machine_power_offs WHERE id=?").get(requestId) as unknown as IntentRow | undefined;
    const oldDeletion = db.prepare("SELECT * FROM machine_deletions WHERE id=?").get(requestId) as unknown as IntentRow | undefined;
    for (const old of [oldPower, oldDeletion]) if (old) visibleMachine(db, principal, old.machine);
    const machine = visibleMachine(db, principal, machineId);
    const old = action === "power-off" ? oldPower : oldDeletion;
    const other = action === "power-off" ? oldDeletion : oldPower;
    if (other || (old && old.machine !== machineId)) throw new ServiceError("Request UUID already belongs to another lifecycle operation.", 409);
    if (old) return { id: old.id, machineId, state: old.state };
    if (deletion(db, machineId)) throw new ServiceError("A deletion intent already exists. Reuse its request ID.", 409);
    if (leaseOwned(db, machineId)) throw new ServiceError("Lease-owned machines use lease cleanup.", 409);
    const host = db.prepare("SELECT seen,offer FROM hosts WHERE id=?").get(machine.host) as { seen: number; offer: string } | undefined;
    if (!host || store.clock() - host.seen >= HOST_LEASE_SECONDS ||
        (action === "delete" && (machine.desired !== "stopped" || machine.observed !== "stopped"))) {
      throw new ServiceError(action === "delete" ? "Deletion requires confirmed shutdown on a connected host." : "Power off requires a connected host.", 409);
    }
    const offer = object(JSON.parse(host.offer)), template = object(JSON.parse(machine.template));
    if ((offer.provider !== "apple" && offer.provider !== "macos") || (template.os !== "linux" && template.os !== "macos")) {
      throw new ServiceError("This lifecycle operation is not implemented for this runtime.", 409, { code: "capability_unsupported" });
    }
    if (pendingCapture(db, machineId)) throw new ServiceError("Resolve the image capture before changing its source.", 409);
    if (hasPendingPowerOff(db, machineId)) throw new ServiceError("Resolve the pending power-off intent. Reuse its request ID.", 409);
    const table = action === "power-off" ? "machine_power_offs" : "machine_deletions";
    db.prepare(`INSERT INTO ${table} (id,machine,state,created) VALUES (?,?,'queued',?)`).run(requestId, machineId, store.clock());
    if (action === "power-off") db.prepare("UPDATE machines SET desired='stopped' WHERE id=?").run(machineId);
    return { id: requestId, machineId, state: "queued" };
  });
}

export function createModule(store: SqliteStore, _options: ControlOptions): ControlModule {
  store.transaction(db => { initializeLifecycle(db); refreshLeaseCleanup(db, store.clock()); });
  return {
    handle(req) {
      if (req.method !== "POST" || req.parts.length !== 4 || req.parts[0] !== "v1" || req.parts[1] !== "machines") return undefined;
      const action = req.parts[3];
      if (action !== "power-off" && action !== "delete") return undefined;
      return { body: requestIntent(store, req, action) };
    },
  };
}

/** Decorate a freshly built assignment after filtering isDeleted(). */
export function lifecycleAssignment<T extends { id: string }>(db: DatabaseSync, machine: T): T & LifecycleFields {
  const result: LifecycleFields = {};
  const power = db.prepare("SELECT id FROM machine_power_offs WHERE machine=? AND state!='succeeded' ORDER BY created,id LIMIT 1").get(machine.id);
  if (power) result.powerOffRequest = String(power.id);
  const removal = deletion(db, machine.id);
  if (removal) { result.deletion = { id: removal.id, state: removal.state }; result.ready = false; }
  const cleanup = leaseCleanup(db, machine.id);
  if (cleanup) {
    result.leaseCleanup = { id: cleanup.id, leaseId: cleanup.lease, state: cleanup.state, attempts: cleanup.attempts, notBefore: cleanup.next_retry };
    result.ready = false;
  }
  return { ...machine, ...result };
}

function cleanupId(leaseId: string, machineId: string): string {
  const namespace = Buffer.from(identifier(leaseId).replaceAll("-", ""), "hex");
  const bytes = createHash("sha1").update(namespace).update("cleanup:" + machineId).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  return identifier(bytes.toString("hex"));
}

/** Call when ending a lease, in the same transaction as its terminal transition. */
export function ensureLeaseCleanup(db: DatabaseSync, leaseId: string, now: number): void {
  leaseId = identifier(leaseId);
  const lease = db.prepare("SELECT state FROM leases WHERE id=?").get(leaseId);
  if (!lease || !terminal.has(String(lease.state))) throw new ServiceError("Active leases cannot be reclaimed.", 409);
  for (const member of db.prepare("SELECT machine FROM lease_members WHERE lease=?").all(leaseId)) {
    const machineId = String(member.machine), id = cleanupId(leaseId, machineId);
    const old = leaseCleanup(db, machineId);
    if (old && (old.lease !== leaseId || old.id !== id)) throw new ServiceError("Cleanup identity does not match its pinned assignment.", 409);
    db.prepare("INSERT OR IGNORE INTO lease_cleanup_members (id,machine,lease,state,reason,attempts,next_retry,updated) VALUES (?,?,?,'pending',NULL,0,0,?)").run(id, machineId, leaseId, now);
  }
}

/** Call from lease refresh/startup and after heartbeat receipts, within their transaction. */
export function refreshLeaseCleanup(db: DatabaseSync, now: number): void {
  if (!tableExists(db, "leases") || !tableExists(db, "lease_members")) return;
  for (const lease of db.prepare("SELECT id FROM leases WHERE state IN ('failed','released','expired') AND cleanup!='complete'").all()) {
    const id = String(lease.id);
    ensureLeaseCleanup(db, id, now);
    const states = db.prepare("SELECT state FROM lease_cleanup_members WHERE lease=?").all(id).map(row => row.state);
    const state = states.length && states.every(s => s === "complete") ? "complete" : states.includes("blocked") ? "blocked"
      : states.some(s => s === "running" || s === "complete") ? "running" : "pending";
    db.prepare("UPDATE leases SET cleanup=? WHERE id=?").run(state, id);
  }
}

export function cleanupView(row: CleanupRow) {
  return { id: row.id, state: row.state, reason: row.reason, attempts: row.attempts, retryAt: row.next_retry || null };
}

function assignedMachine(db: DatabaseSync, hostId: string, machineId: string): MachineRow {
  const row = db.prepare("SELECT * FROM machines WHERE id=?").get(machineId) as unknown as MachineRow | undefined;
  if (!row || row.host !== identifier(hostId)) throw new ServiceError("Cannot report a machine assigned to another host.", 403);
  return row;
}

function validateReport(report: Record<string, unknown>): void {
  if (typeof report.state !== "string" || !observedStates.has(report.state)) throw new ServiceError("Invalid observed state.", 400);
}

/** The caller must authenticate hostId; these helpers additionally bind every receipt to its assignment. */
export function reportPowerOff(db: DatabaseSync, hostId: string, machineId: string, report: Record<string, unknown>): void {
  machineId = identifier(machineId);
  assignedMachine(db, hostId, machineId);
  validateReport(report);
  if (isDeleted(db, machineId) || report.powerOffId === undefined || report.powerOffId === null) return;
  const id = identifier(report.powerOffId);
  const row = db.prepare("SELECT * FROM machine_power_offs WHERE id=?").get(id) as unknown as IntentRow | undefined;
  if (!row || row.machine !== machineId) throw new ServiceError("Power-off receipt does not match this machine.", 403);
  if (row.state === "succeeded") return;
  if (["stopped", "unknown", "error"].includes(String(report.state))) {
    db.prepare("UPDATE machine_power_offs SET state=? WHERE id=?").run(report.state === "stopped" ? "succeeded" : "unknown", id);
  }
}

export function reportDeletion(db: DatabaseSync, hostId: string, machineId: string, report: Record<string, unknown>): void {
  machineId = identifier(machineId);
  assignedMachine(db, hostId, machineId);
  validateReport(report);
  if (isDeleted(db, machineId) || report.deletion === undefined || report.deletion === null) return;
  const receipt = object(report.deletion);
  if (Object.keys(receipt).length !== 2 || !Object.hasOwn(receipt, "id") || !Object.hasOwn(receipt, "state") ||
      typeof receipt.state !== "string" || !["running", "blocked", "complete"].includes(receipt.state)) throw new ServiceError("Invalid deletion receipt.", 400);
  const row = deletion(db, machineId);
  if (!row || row.id !== identifier(receipt.id)) throw new ServiceError("Deletion receipt does not match this assignment.", 403);
  if (receipt.state === "complete" && report.state !== "stopped") throw new ServiceError("Deletion completion requires a stopped runtime.", 409);
  db.prepare("UPDATE machine_deletions SET state=? WHERE machine=?").run(String(receipt.state), machineId);
}

/** False means the caller must skip ordinary observation/preparation updates for this report. */
export function reportLeaseCleanup(db: DatabaseSync, hostId: string, machineId: string, report: Record<string, unknown>, now: number): boolean {
  machineId = identifier(machineId);
  assignedMachine(db, hostId, machineId);
  validateReport(report);
  if (isDeleted(db, machineId)) return false;
  if (report.leaseCleanup === undefined || report.leaseCleanup === null) return true;
  const receipt = object(report.leaseCleanup);
  const base = ["id", "leaseId", "state", "attempt"], allowed = new Set([...base, "reason", ...completionFlags]);
  if (base.some(key => !Object.hasOwn(receipt, key)) || Object.keys(receipt).some(key => !allowed.has(key)) ||
      typeof receipt.state !== "string" || !["running", "blocked", "complete"].includes(receipt.state)) throw new ServiceError("Invalid lease cleanup receipt.", 400);
  const row = leaseCleanup(db, machineId);
  if (!row || row.id !== identifier(receipt.id) || row.lease !== identifier(receipt.leaseId)) {
    throw new ServiceError("Lease cleanup receipt does not match its pinned assignment.", 403);
  }
  const attempt = receipt.attempt;
  if (typeof attempt !== "number" || !Number.isInteger(attempt) || attempt < 1 || attempt > 2 ** 31) throw new ServiceError("Invalid cleanup attempt.", 400);
  if (attempt < row.attempts || (attempt === row.attempts && row.state === "blocked" && receipt.state === "running")) return false;
  const lease = db.prepare("SELECT state FROM leases WHERE id=?").get(row.lease);
  if (!lease || !terminal.has(String(lease.state))) throw new ServiceError("Active leases cannot be reclaimed.", 409);
  // Verify both directions of ownership, even if a corrupted/stale intent exists.
  if (!db.prepare("SELECT 1 FROM lease_members WHERE lease=? AND machine=?").get(row.lease, machineId)) {
    throw new ServiceError("Cleanup assignment no longer belongs to this lease.", 403);
  }
  let reason = receipt.reason ?? null;
  if (reason !== null && (typeof reason !== "string" || !reasons.has(reason))) throw new ServiceError("Invalid cleanup reason.", 400);
  if (completionFlags.some(key => Object.hasOwn(receipt, key) && typeof receipt[key] !== "boolean")) throw new ServiceError("Invalid cleanup completion flags.", 400);
  if (receipt.state === "complete") {
    if (report.state !== "stopped" || completionFlags.some(key => receipt[key] !== true)) {
      throw new ServiceError("Cleanup completion requires stopped execution, removed storage and erased guest credentials.", 409);
    }
    reason = null;
    db.prepare("UPDATE machines SET desired='stopped',observed='stopped',preparation_hash=NULL,prepared_at=0,access_ready=0 WHERE id=?").run(machineId);
  }
  if (receipt.state === "blocked" && reason === null) throw new ServiceError("Blocked cleanup requires a bounded reason.", 400);
  const changed = attempt > row.attempts || receipt.state !== row.state || reason !== row.reason;
  const retry = receipt.state === "blocked" ? changed ? now + Math.min(60, 2 ** Math.min(attempt, 6)) : row.next_retry : 0;
  db.prepare("UPDATE lease_cleanup_members SET state=?,reason=?,attempts=?,next_retry=?,updated=? WHERE machine=?")
    .run(String(receipt.state), reason, attempt, retry, now, machineId);
  return receipt.state !== "complete";
}

/** Run before ordinary heartbeat updates in the authenticated host's transaction.
 * False also covers completed tombstones, so stale preparation cannot restore credentials.
 * Filter isDeleted() when returning inventory/allocations and use computeReserved() in every ledger.
 */
export function reportLifecycle(db: DatabaseSync, hostId: string, machineId: string, report: Record<string, unknown>, now: number): boolean {
  if (!reportLeaseCleanup(db, hostId, machineId, report, now)) {
    refreshLeaseCleanup(db, now);
    return false;
  }
  reportPowerOff(db, hostId, machineId, report);
  reportDeletion(db, hostId, machineId, report);
  refreshLeaseCleanup(db, now);
  return !isDeleted(db, machineId);
}
