import type { DatabaseSync } from "node:sqlite";
import { identifier } from "./consumers.ts";
import type { Resources } from "./consumers.ts";
import { object, ServiceError } from "./errors.ts";
import type { SqliteStore } from "./sqlite.ts";

const keys = ["cpu", "memoryMiB", "diskGiB"] as const;
const zero = (): Resources => ({ cpu: 0, memoryMiB: 0, diskGiB: 0 });
function transaction(db: DatabaseSync): void {
  if (!db.isTransaction) throw new TypeError("Capacity reads require the caller's admission transaction.");
}
export interface SharedBudget {
  id: string; name: string; capacity: Resources; hostIds: string[];
  reserved: Resources; available: Resources; overcommitted: boolean;
}
interface BudgetRow { id: string; name: string; capacity: string }
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
    store.transaction(db => db.exec(`
      CREATE TABLE IF NOT EXISTS resource_budgets (id TEXT PRIMARY KEY, name TEXT NOT NULL, capacity TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS resource_budget_members (budget TEXT NOT NULL, host TEXT NOT NULL, PRIMARY KEY(budget,host));
      CREATE INDEX IF NOT EXISTS resource_budget_host ON resource_budget_members(host,budget);
    `));
  }

  save(value: unknown): SharedBudget {
    const r = object(value);
    if (Object.keys(r).some(k => !["id", "name", "capacity", "hostIds"].includes(k))) throw new ServiceError("Invalid shared resource budget.", 400);
    const id = identifier(r.id);
    // Preserve Python str.strip(), including C1 separators but excluding BOM.
    if (typeof r.name !== "string" || !/[^\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/u.test(r.name) || Array.from(r.name).length > 100) throw new ServiceError("Invalid budget name.", 400);
    const name = r.name, capacity = size(r.capacity, true);
    if (!Array.isArray(r.hostIds) || r.hostIds.length > 1000) throw new ServiceError("Specify at most 1000 runner IDs.", 400);
    const members = r.hostIds.map(identifier);
    if (new Set(members).size !== members.length) throw new ServiceError("Budget membership must not contain duplicates.", 400);
    return this.store.transaction(db => {
      for (const host of members) if (!db.prepare("SELECT 1 FROM hosts WHERE id=?").get(host)) throw new ServiceError("A budget member is not an enrolled runner.", 404);
      db.prepare("INSERT INTO resource_budgets VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,capacity=excluded.capacity").run(id, name, JSON.stringify(capacity));
      db.prepare("DELETE FROM resource_budget_members WHERE budget=?").run(id);
      const insert = db.prepare("INSERT INTO resource_budget_members VALUES (?,?)");
      for (const host of members) insert.run(id, host);
      return this.budget(db, id);
    });
  }

  list(): SharedBudget[] {
    return this.store.transaction(db => db.prepare("SELECT id FROM resource_budgets ORDER BY name,id").all().map(r => this.budget(db, String(r.id))));
  }

  private deleted(db: DatabaseSync, machine: string): boolean {
    return !!db.prepare("SELECT 1 FROM machine_deletions WHERE machine=? AND state='complete'").get(machine) ||
      !!db.prepare("SELECT 1 FROM lease_cleanup_members WHERE machine=? AND state='complete'").get(machine);
  }

  used(db: DatabaseSync, host: string, exclude?: string): Resources {
    transaction(db);
    const used = zero();
    for (const row of db.prepare("SELECT definition FROM inference_jobs WHERE host=? AND state NOT IN ('succeeded','failed','cancelled')").all(host)) {
      const reserved = size(storedObject(row.definition).resources);
      for (const key of keys) used[key] = sum(used[key], reserved[key]);
    }
    const artifacts = new Map<string, number>();
    for (const row of db.prepare("SELECT metadata FROM images WHERE host=?").all(host)) {
      const metadata = storedObject(row.metadata);
      if (typeof metadata.sha256 !== "string" || typeof metadata.format !== "string") throw new ServiceError("Invalid stored image identity.", 503);
      artifacts.set(JSON.stringify([metadata.sha256, metadata.format]), amount(metadata.bytes));
    }
    for (const bytes of artifacts.values()) used.diskGiB = sum(used.diskGiB, Math.ceil(bytes / 1_073_741_824));
    for (const row of db.prepare("SELECT reserved_disk FROM image_tasks WHERE host=? AND state IN ('queued','running','unknown')").all(host)) used.diskGiB = sum(used.diskGiB, amount(row.reserved_disk));
    for (const row of db.prepare("SELECT id,request,desired,observed FROM machines WHERE host=?").all(host)) {
      const id = String(row.id);
      if (id === exclude || this.deleted(db, id)) continue;
      const reserved = size(storedObject(row.request).resources);
      used.diskGiB = sum(used.diskGiB, reserved.diskGiB);
      const held = !!db.prepare("SELECT 1 FROM lease_members WHERE machine=?").get(id) || row.desired === "running" || row.observed !== "stopped" ||
        !!db.prepare("SELECT 1 FROM machine_power_offs WHERE machine=? AND state!='succeeded'").get(id);
      if (held) for (const key of ["cpu", "memoryMiB"] as const) used[key] = sum(used[key], reserved[key]);
    }
    return used;
  }

  budget(db: DatabaseSync, id: string, exclude?: string): SharedBudget {
    transaction(db);
    const row = db.prepare("SELECT * FROM resource_budgets WHERE id=?").get(id) as unknown as BudgetRow | undefined;
    if (!row) throw new ServiceError("Unknown shared resource budget.", 404);
    const members = db.prepare("SELECT host FROM resource_budget_members WHERE budget=? ORDER BY host").all(id).map(r => String(r.host));
    const capacity = size(storedObject(row.capacity)), reserved = zero(), available = zero();
    for (const host of members) { const used = this.used(db, host, exclude); for (const key of keys) reserved[key] = sum(reserved[key], used[key]); }
    for (const key of keys) available[key] = Math.max(0, capacity[key] - reserved[key]);
    return { id: row.id, name: row.name, capacity, hostIds: members, reserved, available, overcommitted: keys.some(k => reserved[k] > capacity[k]) };
  }

  hostBudgets(db: DatabaseSync, host: string, exclude?: string): SharedBudget[] {
    transaction(db);
    return db.prepare("SELECT budget FROM resource_budget_members WHERE host=? ORDER BY budget").all(host).map(r => this.budget(db, String(r.budget), exclude));
  }

  remaining(db: DatabaseSync, host: string, exclude?: string): Resources {
    transaction(db);
    const row = db.prepare("SELECT offer FROM hosts WHERE id=?").get(host);
    if (!row) throw new ServiceError("Unknown host.", 404);
    const capacity = size(storedObject(row.offer).capacity), used = this.used(db, host, exclude), remaining = zero();
    for (const key of keys) remaining[key] = Math.max(0, capacity[key] - used[key]);
    for (const shared of this.hostBudgets(db, host, exclude)) for (const key of keys) remaining[key] = Math.min(remaining[key], shared.available[key]);
    return remaining;
  }
}
