import type { DatabaseSync } from "node:sqlite";
import { object, ServiceError } from "../errors.ts";
import { validatePressureReport } from "../pressure.ts";
import type { PressureGates, PressureReport } from "../pressure.ts";

/** A reporting host samples every five seconds. Twelve missed samples, twice the host contact
 * lease, make its last state untrustworthy; like a stale health check, that is not evidence. */
export const PRESSURE_STALE_SECONDS = 60;
export type HostPressureState = "normal" | "pressured" | "unknown" | "stale" | "disabled" | "unreported";
export type PressureCode = "host_pressure" | "host_pressure_unknown";
/** What a refusal is for: a new placement, or starting a machine that already lives on the host. */
export type PressurePurpose = "placement" | "restart";
export interface PressureAdmission { blocked: boolean; state: HostPressureState; code?: PressureCode; reasons: ("memory" | "disk")[] }
const NO_GATES: PressureGates = { placement: false, restart: false };

function inTransaction(db: DatabaseSync): void { if (!db.isTransaction) throw new TypeError("Pressure admission requires the caller's transaction."); }
function table(db: DatabaseSync): boolean { return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='host_pressure'").get(); }
export function initializePressure(db: DatabaseSync): void {
  inTransaction(db);
  db.exec("CREATE TABLE IF NOT EXISTS host_pressure (host TEXT PRIMARY KEY,report TEXT NOT NULL,received REAL NOT NULL)");
}
/** Call only inside the authenticated host heartbeat, on every heartbeat.
 * - A heartbeat without a report comes from a runner that does not report pressure: an older
 *   one, or one rolled back to an older version. Its host returns to the never-reported state,
 *   so a report left by a newer runner can never go stale and block it.
 * - A cached report sent again keeps its original receipt time, so repeated delivery never
 *   refreshes a sample's age. */
export function recordPressure(db: DatabaseSync, hostId: string, value: unknown, now: number): void {
  inTransaction(db);
  const previous = db.prepare("SELECT report FROM host_pressure WHERE host=?").get(hostId);
  if (value === undefined || value === null) {
    if (previous) db.prepare("DELETE FROM host_pressure WHERE host=?").run(hostId);
    return;
  }
  const report = validatePressureReport(value), encoded = JSON.stringify(report);
  if (previous && object(JSON.parse(String(previous.report))).sampledAt === report.sampledAt) {
    // The operator's gates and thresholds can change without a new sample, on a runner restart.
    if (previous.report !== encoded) db.prepare("UPDATE host_pressure SET report=? WHERE host=?").run(encoded, hostId);
    return;
  }
  db.prepare("INSERT INTO host_pressure VALUES (?,?,?) ON CONFLICT(host) DO UPDATE SET report=excluded.report,received=excluded.received").run(hostId, encoded, now);
}
function stored(db: DatabaseSync, hostId: string): { report: PressureReport; received: number } | undefined {
  if (!table(db)) return undefined;
  const row = db.prepare("SELECT report,received FROM host_pressure WHERE host=?").get(hostId);
  return row ? { report: JSON.parse(String(row.report)) as PressureReport, received: Number(row.received) } : undefined;
}
function observed(saved: { report: PressureReport; received: number } | undefined, now: number): { state: HostPressureState; code?: PressureCode; reasons: ("memory" | "disk")[] } {
  if (!saved) return { state: "unreported", reasons: [] };
  if (saved.report.state === "disabled") return { state: "disabled", reasons: [] };
  if (now - saved.received >= PRESSURE_STALE_SECONDS || now < saved.received) return { state: "stale", code: "host_pressure_unknown", reasons: [] };
  if (saved.report.state === "pressured") return { state: "pressured", code: "host_pressure", reasons: saved.report.reasons ?? [] };
  if (saved.report.state === "unknown") return { state: "unknown", code: "host_pressure_unknown", reasons: [] };
  return { state: "normal", reasons: [] };
}
/** Admission only, for machines, devices and generic leases on this host's own ledger. Existing
 * leases and running work are never stopped or shrunk. Work on a runner domain mapped to the
 * host (Linux workspace leases, model jobs) is not gated here.
 *
 * Pressure is an observation unless the host's own operator turned a gate on in the host file,
 * which the report carries: `placement` for new machines, devices and leases (and the host's
 * placement-ready state), `restart` for starting a machine that already lives there. With a gate
 * on, `pressured`, an unreadable signal and a sample older than PRESSURE_STALE_SECONDS refuse.
 * A host that never reported, stopped reporting or disabled its report is never refused. */
export function pressureAdmission(db: DatabaseSync, hostId: string, now: number, purpose: PressurePurpose = "placement"): PressureAdmission {
  inTransaction(db);
  const saved = stored(db, hostId), current = observed(saved, now), gates = saved?.report.gates ?? NO_GATES;
  return current.code && gates[purpose] ? { blocked: true, ...current } : { blocked: false, state: current.state, reasons: current.reasons };
}
/** The actual pressure wins over an unknown one when several candidates were skipped. */
export function pressureRefusal(codes: ReadonlySet<PressureCode>, status: number): ServiceError {
  return codes.has("host_pressure")
    ? new ServiceError("Every host that could take this work is under memory or disk pressure.", status, { code: "host_pressure", retryable: true })
    : new ServiceError("Every host that could take this work has no current pressure sample.", status, { code: "host_pressure_unknown", retryable: true });
}
/** Administrative projection shown beside host health: the observed state, and what it refuses. */
export function pressureView(db: DatabaseSync, hostId: string, now: number): Record<string, unknown> {
  const saved = stored(db, hostId), current = observed(saved, now);
  if (!saved) return { state: "unreported", gates: NO_GATES, placementBlocked: false, restartBlocked: false, reasons: [] };
  const { state: _reported, version: _version, gates: _gates, ...report } = saved.report, gates = saved.report.gates ?? NO_GATES;
  return { ...report, state: current.state, reported: saved.report.state, reasons: current.state === "pressured" ? current.reasons : [], gates,
    placementBlocked: !!current.code && gates.placement, restartBlocked: !!current.code && gates.restart, receivedAt: saved.received, fresh: now - saved.received < PRESSURE_STALE_SECONDS };
}
