import type { DatabaseSync } from "node:sqlite";
import type { Resources } from "./consumers.ts";
import { identifier } from "./consumers.ts";
import { ServiceError } from "./errors.ts";

const keys = ["cpu", "memoryMiB", "diskGiB"] as const;
const zero = (): Resources => ({ cpu: 0, memoryMiB: 0, diskGiB: 0 });
const table = (db: DatabaseSync, name: string): boolean => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
function transaction(db: DatabaseSync): void {
  if (!db.isTransaction) throw new TypeError("Physical capacity requires the caller's admission transaction.");
}
function amount(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new ServiceError("Invalid physical capacity state.", 503);
  return value;
}
function size(value: unknown): Resources {
  const input = value as Resources;
  return Object.fromEntries(keys.map(key => [key, amount(input?.[key])])) as unknown as Resources;
}
function add(target: Resources, value: Resources): void {
  for (const key of keys) target[key] = amount(target[key] + amount(value[key]));
}
export interface PhysicalMapping { hostId: string; domainId: string }
export interface PhysicalBudget extends PhysicalMapping { capacity: Resources; reserved: Resources; available: Resources }
export type PhysicalTarget = { hostId: string } | { domainId: string };

/** SQL-only accounting: no transactions, schema creation, callbacks or copied allocations.
 * Undefined means the caller must retain its original unmapped accounting behavior.
 */
export function physicalBudget(db: DatabaseSync, target: PhysicalTarget, excludeMachine?: string): PhysicalBudget | undefined {
  transaction(db);
  const mapping = physicalMapping(db, target);
  if (!mapping) return undefined;
  const { hostId, domainId } = mapping;
  const host = db.prepare("SELECT offer FROM hosts WHERE id=?").get(hostId);
  const domain = db.prepare("SELECT capacity FROM resource_domains WHERE id=?").get(domainId);
  if (!host || !domain) throw new ServiceError("Physical mapping inventory is unavailable.", 503);
  const offered = size(JSON.parse(String(host.offer)).capacity);
  const saved = table(db, "host_limits") ? db.prepare("SELECT limits FROM host_limits WHERE host=?").get(hostId) : undefined;
  const limits = saved ? size(JSON.parse(String(saved.limits))) : offered;
  const budget = size(JSON.parse(String(domain.capacity)));
  const capacity = zero();
  for (const key of keys) capacity[key] = Math.min(offered[key], limits[key], budget[key]);
  const reserved = hostReservations(db, hostId, excludeMachine);
  for (const row of db.prepare("SELECT resources FROM resource_reservations WHERE domain=? AND state='held'").all(domainId)) add(reserved, size(JSON.parse(String(row.resources))));
  const available = zero();
  for (const key of keys) available[key] = Math.max(0, capacity[key] - reserved[key]);
  return { ...mapping, capacity, reserved, available };
}

export function physicalMapping(db: DatabaseSync, target: PhysicalTarget): PhysicalMapping | undefined {
  transaction(db);
  if (!table(db, "physical_domains")) return undefined;
  const row = "hostId" in target
    ? db.prepare("SELECT host,domain FROM physical_domains WHERE host=?").get(target.hostId)
    : db.prepare("SELECT host,domain FROM physical_domains WHERE domain=?").get(target.domainId);
  return row ? { hostId: String(row.host), domainId: String(row.domain) } : undefined;
}
function complete(db: DatabaseSync, name: string, machine: string): boolean {
  return table(db, name) && !!db.prepare(`SELECT 1 FROM ${name} WHERE machine=? AND state='complete'`).get(machine);
}
function hostReservations(db: DatabaseSync, host: string, exclude?: string): Resources {
  const used = zero();
  if (table(db, "machines")) for (const row of db.prepare("SELECT id,request,desired,observed FROM machines WHERE host=?").all(host)) {
    const id = String(row.id);
    if (id === exclude || complete(db, "machine_deletions", id) || complete(db, "lease_cleanup_members", id)) continue;
    const r = size(JSON.parse(String(row.request)).resources);
    used.diskGiB = amount(used.diskGiB + r.diskGiB);
    const held = row.desired === "running" || row.observed !== "stopped" ||
      (table(db, "lease_members") && !!db.prepare("SELECT 1 FROM lease_members WHERE machine=?").get(id)) ||
      (table(db, "machine_power_offs") && !!db.prepare("SELECT 1 FROM machine_power_offs WHERE machine=? AND state!='succeeded'").get(id));
    if (held) { used.cpu = amount(used.cpu + r.cpu); used.memoryMiB = amount(used.memoryMiB + r.memoryMiB); }
  }
  if (table(db, "inference_jobs")) for (const row of db.prepare("SELECT definition FROM inference_jobs WHERE host=? AND state NOT IN ('succeeded','failed','cancelled')").all(host)) add(used, size(JSON.parse(String(row.definition)).resources));
  if (table(db, "images")) {
    const artifacts = new Map<string, number>();
    for (const row of db.prepare("SELECT metadata FROM images WHERE host=?").all(host)) {
      const m = JSON.parse(String(row.metadata));
      if (typeof m.sha256 !== "string" || typeof m.format !== "string") throw new ServiceError("Invalid stored image identity.", 503);
      artifacts.set(JSON.stringify([m.sha256, m.format]), amount(m.bytes));
    }
    for (const bytes of artifacts.values()) used.diskGiB = amount(used.diskGiB + Math.ceil(bytes / 1073741824));
  }
  if (table(db, "image_tasks")) for (const row of db.prepare("SELECT reserved_disk FROM image_tasks WHERE host=? AND state IN ('queued','running','unknown')").all(host)) used.diskGiB = amount(used.diskGiB + amount(row.reserved_disk));
  if (table(db, "physical_reservation_sources")) for (const row of db.prepare("SELECT query FROM physical_reservation_sources").all()) {
    if (row.query === null) throw new ServiceError("Mapped capacity requires SQL for every additional reservation hook.", 503);
    if (!/^\s*SELECT\b/i.test(String(row.query))) throw new ServiceError("Reservation sources must be read-only SELECT queries.", 503);
    for (const result of db.prepare(String(row.query)).all(host)) add(used, size(result));
  }
  return used;
}

export class PhysicalDomains {
  static schema(db: DatabaseSync): void {
    db.exec(`CREATE TABLE IF NOT EXISTS physical_domains (host TEXT PRIMARY KEY, domain TEXT NOT NULL UNIQUE);
      CREATE TABLE IF NOT EXISTS physical_reservation_sources (id TEXT PRIMARY KEY, query TEXT);`);
  }
  /** Replays are safe; remapping checks both the old and new domain. */
  map(db: DatabaseSync, hostId: string, domainId: string): PhysicalMapping {
    transaction(db);
    const host = identifier(hostId), domain = identifier(domainId);
    PhysicalDomains.schema(db);
    if (!table(db, "hosts") || !db.prepare("SELECT 1 FROM hosts WHERE id=?").get(host) ||
        (table(db, "retired_runners") && db.prepare("SELECT 1 FROM retired_runners WHERE id=?").get(host))) throw new ServiceError("Unknown host.", 404);
    if (!table(db, "resource_domains") || !db.prepare("SELECT 1 FROM resource_domains WHERE id=?").get(domain)) throw new ServiceError("Unknown resource domain.", 404);
    const old = physicalMapping(db, { hostId: host }), other = physicalMapping(db, { domainId: domain });
    if (other && other.hostId !== host) throw new ServiceError("Resource domain already maps to another host.", 409);
    if (old?.domainId === domain) return old;
    const used = hostReservations(db, host);
    const held = (id: string) => !!db.prepare("SELECT 1 FROM resource_reservations WHERE domain=? AND state='held'").get(id);
    if (keys.some(key => used[key] > 0) || held(domain) || (old && held(old.domainId))) throw new ServiceError("Cannot map a host or domain while reservations are held.", 409);
    db.prepare("INSERT INTO physical_domains VALUES (?,?) ON CONFLICT(host) DO UPDATE SET domain=excluded.domain").run(host, domain);
    return { hostId: host, domainId: domain };
  }
}
