import type { DatabaseSync } from "node:sqlite";
import { object, ServiceError } from "../errors.ts";
import { validatePressureReport } from "../pressure.ts";
import type { PressureReport } from "../pressure.ts";

/** A reporting host samples every five seconds. Twelve missed samples, twice the host contact
 * lease, make its last state untrustworthy; like a stale health check, that blocks placement. */
export const PRESSURE_STALE_SECONDS = 60;
export type HostPressureState = "normal" | "pressured" | "unknown" | "stale" | "disabled" | "unreported";
export type PressureCode = "host_pressure" | "host_pressure_unknown";
export interface PressureAdmission { blocked: boolean; state: HostPressureState; code?: PressureCode; reasons: ("memory" | "disk")[] }

function inTransaction(db: DatabaseSync): void { if (!db.isTransaction) throw new TypeError("Pressure admission requires the caller's transaction."); }
function table(db: DatabaseSync): boolean { return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='host_pressure'").get(); }
export function initializePressure(db: DatabaseSync): void {
  inTransaction(db);
  db.exec("CREATE TABLE IF NOT EXISTS host_pressure (host TEXT PRIMARY KEY,report TEXT NOT NULL,received REAL NOT NULL)");
}
/** Call only inside the authenticated host heartbeat. A cached report sent again keeps its
 * original receipt time, so repeated delivery never refreshes a sample's age. */
export function recordPressure(db: DatabaseSync, hostId: string, value: unknown, now: number): void {
  inTransaction(db);
  if (value === undefined || value === null) return;
  const report = validatePressureReport(value);
  const previous = db.prepare("SELECT report FROM host_pressure WHERE host=?").get(hostId);
  if (previous && object(JSON.parse(String(previous.report))).sampledAt === report.sampledAt) return;
  db.prepare("INSERT INTO host_pressure VALUES (?,?,?) ON CONFLICT(host) DO UPDATE SET report=excluded.report,received=excluded.received").run(hostId, JSON.stringify(report), now);
}
function stored(db: DatabaseSync, hostId: string): { report: PressureReport; received: number } | undefined {
  if (!table(db)) return undefined;
  const row = db.prepare("SELECT report,received FROM host_pressure WHERE host=?").get(hostId);
  return row ? { report: JSON.parse(String(row.report)) as PressureReport, received: Number(row.received) } : undefined;
}
/** Admission only, for machines, devices and generic leases placed on this host's own ledger.
 * Existing leases and running work are never stopped or shrunk by this state. Work on a runner
 * domain mapped to the host (Linux workspace leases, model jobs) is not gated here.
 * - never reported (an older runner, or a pool without a host signal): not blocked;
 * - `disabled` by the host's operator: not blocked;
 * - a reported sample older than PRESSURE_STALE_SECONDS, or an unreadable signal: blocked;
 * - `pressured`: blocked until the host itself reports `normal` after its hold time. */
export function pressureAdmission(db: DatabaseSync, hostId: string, now: number): PressureAdmission {
  inTransaction(db);
  const saved = stored(db, hostId);
  if (!saved) return { blocked: false, state: "unreported", reasons: [] };
  if (saved.report.state === "disabled") return { blocked: false, state: "disabled", reasons: [] };
  if (now - saved.received >= PRESSURE_STALE_SECONDS || now < saved.received) return { blocked: true, state: "stale", code: "host_pressure_unknown", reasons: [] };
  if (saved.report.state === "pressured") return { blocked: true, state: "pressured", code: "host_pressure", reasons: saved.report.reasons ?? [] };
  if (saved.report.state === "unknown") return { blocked: true, state: "unknown", code: "host_pressure_unknown", reasons: [] };
  return { blocked: false, state: "normal", reasons: [] };
}
/** The actual pressure wins over an unknown one when several candidates were skipped. */
export function pressureRefusal(codes: ReadonlySet<PressureCode>, status: number): ServiceError {
  return codes.has("host_pressure")
    ? new ServiceError("Every host that could take this work is under memory or disk pressure.", status, { code: "host_pressure", retryable: true })
    : new ServiceError("Every host that could take this work has no current pressure sample.", status, { code: "host_pressure_unknown", retryable: true });
}
/** Administrative projection shown beside host health. */
export function pressureView(db: DatabaseSync, hostId: string, now: number): Record<string, unknown> {
  const admission = pressureAdmission(db, hostId, now), saved = stored(db, hostId);
  if (!saved) return { state: "unreported", placementBlocked: false, reasons: [] };
  const { state: _reported, version: _version, ...report } = saved.report;
  return { ...report, state: admission.state, reported: saved.report.state, reasons: admission.state === "pressured" ? admission.reasons : [],
    placementBlocked: admission.blocked, receivedAt: saved.received, fresh: now - saved.received < PRESSURE_STALE_SECONDS };
}
