/** Table-level facts about warm pool devices and device baselines, for modules that must not
 * depend on the pool or baseline modules themselves. Every function runs in the caller's transaction. */
import type { DatabaseSync } from "node:sqlite";
import { ServiceError } from "../errors.ts";

function table(db: DatabaseSync, name: string): boolean { return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name); }

export interface PoolDevice { machine: string; hold: string; host: string; state: string; lease: string | null; origin: string | null }
/** The pool's record of a machine it created, in any state; undefined for every other machine. */
export function poolDevice(db: DatabaseSync, machineId: string): PoolDevice | undefined {
  return table(db, "warm_devices") ? db.prepare("SELECT machine,hold,host,state,lease,origin FROM warm_devices WHERE machine=?").get(machineId) as unknown as PoolDevice | undefined : undefined;
}
/** A warm device has no owner and no consumer. Only the pool creates, checks and destroys it, so
 * machine actions (start, stop, delete, device operations, uploads, recordings, baselines) refuse
 * it. Once a lease has claimed it, the existing lease-owned refusals apply instead. */
export function requireNotPooled(db: DatabaseSync, machineId: string): void {
  const device = poolDevice(db, machineId);
  if (device && device.lease === null) throw new ServiceError("Warm pool devices are managed by the pool, not through machine actions.", 409, { code: "warm_pool_device" });
}
/** A device whose disk state is being captured must stay stopped and must not be deleted. */
export function pendingBaselineSave(db: DatabaseSync, machineId: string): boolean {
  return table(db, "device_baselines") && !!db.prepare("SELECT 1 FROM device_baselines WHERE machine=? AND state IN ('saving','unknown')").get(machineId);
}
/** Whether a host last reported exactly the baseline a template pins: same name, revision and
 * digest, made from the template's own device definition and architecture, and not stale against
 * the host's installed system image. A template without a baseline is always usable. */
export function baselineUsable(db: DatabaseSync, hostId: string, image: Record<string, unknown>): boolean {
  if (image.baseline == null) return true;
  if (!table(db, "host_baselines")) return false;
  const row = db.prepare("SELECT report FROM host_baselines WHERE host=?").get(hostId);
  if (!row) return false;
  const wanted = image.baseline as Record<string, unknown>, device = image.device as Record<string, unknown> | undefined;
  return (JSON.parse(String(row.report)) as Record<string, unknown>[]).some(entry => entry.name === wanted.name && entry.revision === wanted.revision && entry.digest === wanted.digest &&
    entry.stale === false && entry.arch === image.arch && !!device && (entry.device as Record<string, unknown>).systemImage === device.systemImage && (entry.device as Record<string, unknown>).profile === device.profile);
}
