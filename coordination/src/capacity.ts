import type { DatabaseSync } from "node:sqlite";
import { identifier } from "./consumers.ts";
import type { Resources } from "./consumers.ts";
import { object, ServiceError } from "./errors.ts";
import type { SqliteStore } from "./sqlite.ts";
import { updateDraining } from "./updates/drain.ts";

const keys = ["cpu", "memoryMiB", "diskGiB"] as const;
const zero = (): Resources => ({ cpu: 0, memoryMiB: 0, diskGiB: 0 });
function transaction(db: DatabaseSync): void {
  if (!db.isTransaction) throw new TypeError("Capacity reads require the caller's admission transaction.");
}
function storedObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") throw new ServiceError("Invalid persisted capacity state.", 503);
  return object(JSON.parse(value) as unknown);
}
function amount(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new ServiceError("Capacity accounting is unavailable for invalid persisted amounts.", 503);
  return value;
}
function sum(a: number, b: number): number { return amount(a + amount(b)); }
function size(value: unknown, input = false): Resources {
  const r = object(value), result = zero();
  for (const key of keys) {
    if (input && (typeof r[key] !== "number" || !Number.isSafeInteger(r[key]) || r[key] < 1 || r[key] > 1_048_576))
      throw new ServiceError(`Invalid ${key}.`, 400);
    result[key] = amount(r[key]);
  }
  return result;
}

/** Reads existing controller reservation tables; it does not enroll hosts,
 * create machine/image/lease schemas, or establish native cleanup evidence.
 * The db-taking methods compose inside the caller's placement transaction.
 */
export class CapacityLedger {
  constructor(readonly store: SqliteStore) {
    store.transaction(db => db.exec("CREATE TABLE IF NOT EXISTS host_limits (host TEXT PRIMARY KEY, limits TEXT NOT NULL)"));
  }

  save(hostId: string, value: unknown): { hostId: string; limits: Resources } {
    const host = identifier(hostId), r = object(value);
    if (Object.keys(r).length !== 1 || !("limits" in r)) throw new ServiceError("Specify CPU, memory and disk limits for this host.", 400);
    const limits = size(r.limits, true);
    return this.store.transaction(db => {
      this.hostLimits(db, host);
      db.prepare("INSERT INTO host_limits VALUES (?,?) ON CONFLICT(host) DO UPDATE SET limits=excluded.limits").run(host, JSON.stringify(limits));
      return { hostId: host, limits };
    });
  }

  hostLimits(db: DatabaseSync, host: string): Resources {
    transaction(db);
    const row = db.prepare("SELECT offer FROM hosts WHERE id=? AND id NOT IN (SELECT id FROM retired_runners)").get(host);
    if (!row) throw new ServiceError("Unknown host.", 404);
    const configured = db.prepare("SELECT limits FROM host_limits WHERE host=?").get(host);
    return effectiveHostCapacity(db, host, configured ? size(storedObject(configured.limits)) : size(storedObject(row.offer).capacity));
  }

  used(db: DatabaseSync, host: string, exclude?: string): Resources {
    return combineResources(hostReservations(db, host, exclude), boundDomainReservations(db, host));
  }

  remaining(db: DatabaseSync, host: string, exclude?: string): Resources {
    transaction(db);
    const row = db.prepare("SELECT offer FROM hosts WHERE id=?").get(host);
    if (!row) throw new ServiceError("Unknown host.", 404);
    const domain = hostDomain(db, host);
    if (domain && !boundHostState(db, domain, this.store.clock())?.available) return zero();
    const limits = this.hostLimits(db, host), capacity = size(storedObject(row.offer).capacity), used = this.used(db, host, exclude), remaining = zero();
    for (const key of keys) remaining[key] = Math.max(0, Math.min(capacity[key], limits[key]) - used[key]);
    return remaining;
  }
}

function hasTable(db: DatabaseSync, name: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}
function deleted(db: DatabaseSync, machine: string): boolean {
  return !!db.prepare("SELECT 1 FROM machine_deletions WHERE machine=? AND state='complete'").get(machine) ||
    !!db.prepare("SELECT 1 FROM lease_cleanup_members WHERE machine=? AND state='complete'").get(machine);
}
/** Only host-owned reservations: never calls the domain ledger. */
export function hostReservations(db: DatabaseSync, host: string, exclude?: string): Resources {
    transaction(db);
    const used = zero();
    if (hasTable(db, "inference_jobs")) for (const row of db.prepare("SELECT definition FROM inference_jobs WHERE host=? AND state NOT IN ('succeeded','failed','cancelled')").all(host)) {
      const reserved = size(storedObject(row.definition).resources);
      for (const key of keys) used[key] = sum(used[key], reserved[key]);
    }
    const artifacts = new Map<string, number>();
    if (hasTable(db, "images")) for (const row of db.prepare("SELECT metadata FROM images WHERE host=?").all(host)) {
      const metadata = storedObject(row.metadata);
      if (typeof metadata.sha256 !== "string" || typeof metadata.format !== "string") throw new ServiceError("Invalid stored image identity.", 503);
      artifacts.set(JSON.stringify([metadata.sha256, metadata.format]), amount(metadata.bytes));
    }
    for (const bytes of artifacts.values()) used.diskGiB = sum(used.diskGiB, Math.ceil(bytes / 1_073_741_824));
    if (hasTable(db, "image_tasks")) for (const row of db.prepare("SELECT reserved_disk FROM image_tasks WHERE host=? AND state IN ('queued','running','unknown')").all(host)) used.diskGiB = sum(used.diskGiB, amount(row.reserved_disk));
    if (hasTable(db, "machines")) for (const row of db.prepare("SELECT id,request,desired,observed FROM machines WHERE host=?").all(host)) {
      const id = String(row.id);
      if (id === exclude || deleted(db, id)) continue;
      const reserved = size(storedObject(row.request).resources);
      used.diskGiB = sum(used.diskGiB, reserved.diskGiB);
      const held = (hasTable(db, "lease_members") && !!db.prepare("SELECT 1 FROM lease_members WHERE machine=?").get(id)) || row.desired === "running" || row.observed !== "stopped" ||
        !!db.prepare("SELECT 1 FROM machine_power_offs WHERE machine=? AND state!='succeeded'").get(id);
      if (held) for (const key of ["cpu", "memoryMiB"] as const) used[key] = sum(used[key], reserved[key]);
    }
    return used;
}
export function combineResources(a: Resources, b: Resources): Resources {
  return { cpu: sum(a.cpu, b.cpu), memoryMiB: sum(a.memoryMiB, b.memoryMiB), diskGiB: sum(a.diskGiB, b.diskGiB) };
}
export function hostDomain(db: DatabaseSync, host: string): string | undefined {
  transaction(db);
  return hasTable(db, "resource_domain_hosts") ? db.prepare("SELECT domain FROM resource_domain_hosts WHERE host=?").get(host)?.domain as string | undefined : undefined;
}
export function boundDomainReservations(db: DatabaseSync, host: string): Resources {
  const domain = hostDomain(db, host); let used = zero();
  if (domain) for (const row of db.prepare("SELECT resources FROM resource_reservations WHERE domain=? AND state='held'").all(domain)) used = combineResources(used, size(storedObject(row.resources)));
  return used;
}
/** Operator headroom is shared by both execution ledgers after an explicit binding. */
export function effectiveHostCapacity(db: DatabaseSync, host: string, limits: Resources): Resources {
  const domain = hostDomain(db, host);
  if (!domain) return limits;
  const row = db.prepare("SELECT capacity FROM resource_domains WHERE id=?").get(domain);
  if (!row) throw new ServiceError("Bound resource domain is unavailable.", 503);
  const capacity = size(storedObject(row.capacity));
  return { cpu: Math.min(limits.cpu, capacity.cpu), memoryMiB: Math.min(limits.memoryMiB, capacity.memoryMiB), diskGiB: Math.min(limits.diskGiB, capacity.diskGiB) };
}
export function boundHostState(db: DatabaseSync, domain: string, now: number): { host: string; capacity: Resources; available: boolean } | undefined {
  transaction(db);
  if (!hasTable(db, "resource_domain_hosts")) return undefined;
  const binding = db.prepare("SELECT host FROM resource_domain_hosts WHERE domain=?").get(domain);
  if (!binding) return undefined;
  const host = String(binding.host), row = db.prepare("SELECT offer,seen,enabled FROM hosts WHERE id=?").get(host);
  if (!row) return { host, capacity: zero(), available: false };
  const physical = size(storedObject(row.offer).capacity), configured = hasTable(db, "host_limits") ? db.prepare("SELECT limits FROM host_limits WHERE host=?").get(host) : undefined;
  const limits = configured ? size(storedObject(configured.limits)) : physical;
  const capacity = { cpu: Math.min(physical.cpu, limits.cpu), memoryMiB: Math.min(physical.memoryMiB, limits.memoryMiB), diskGiB: Math.min(physical.diskGiB, limits.diskGiB) };
  const retired = hasTable(db, "retired_runners") && !!db.prepare("SELECT 1 FROM retired_runners WHERE id=?").get(host);
  const health = hasTable(db, "host_health") ? db.prepare("SELECT report,received FROM host_health WHERE host=?").get(host) : undefined;
  const healthy = !health?.report || (now - Number(health.received) < 120 && ["passed", "warning"].includes(String(storedObject(health.report).status)));
  return { host, capacity, available: Boolean(row.enabled) && now - Number(row.seen) < 30 && !retired && healthy && !updateDraining(db, host) };
}
