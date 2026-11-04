import type { DatabaseSync } from "node:sqlite";
import { identifier } from "./consumers.ts";
import type { Resources } from "./consumers.ts";
import { object, ServiceError } from "./errors.ts";

const keys = ["cpu", "memoryMiB", "diskGiB"] as const;

export interface ResourceDomain {
  id: string; name: string; capacity: Resources; reserved: Resources; available: Resources; reservations: number;
}
interface DomainRow { id: string; name: string; capacity: string }

function requireTransaction(db: DatabaseSync): void {
  if (!db.isTransaction) throw new TypeError("Resource reservations require the caller's admission transaction.");
}

/** Positive bounded integers for every resource; extra or missing fields fail closed. */
export function resources(value: unknown): Resources {
  const input = object(value);
  if (Object.keys(input).length !== keys.length || keys.some(key => !Object.hasOwn(input, key))) {
    throw new ServiceError("Resources require exactly cpu, memoryMiB and diskGiB.", 400);
  }
  const result = { cpu: 0, memoryMiB: 0, diskGiB: 0 };
  for (const key of keys) {
    const amount = input[key];
    if (typeof amount !== "number" || !Number.isSafeInteger(amount) || amount < 1 || amount > 1_048_576) throw new ServiceError(`Invalid ${key}.`, 400);
    result[key] = amount;
  }
  return result;
}

function stored(value: unknown): Resources {
  try { return resources(JSON.parse(String(value)) as unknown); }
  catch { throw new ServiceError("Invalid persisted resource domain state.", 503, { retryable: false }); }
}

/** Operator-defined physical resource domains and a generic held/released reservation ledger.
 * Every method composes inside the caller's BEGIN IMMEDIATE transaction. Defining a domain
 * activates nothing: only explicitly approved claimants reserve from it. Model-job claims and
 * Linux lease admission are its claimants; both see every held reservation in a domain.
 */
export class ResourceDomains {
  static schema(db: DatabaseSync): void {
    db.exec(`CREATE TABLE IF NOT EXISTS resource_domains (id TEXT PRIMARY KEY, name TEXT NOT NULL, capacity TEXT NOT NULL, created REAL NOT NULL);
      CREATE TABLE IF NOT EXISTS resource_reservations (id TEXT PRIMARY KEY, domain TEXT NOT NULL, kind TEXT NOT NULL, owner TEXT NOT NULL, resources TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('held','released')), created REAL NOT NULL, released REAL);
      CREATE INDEX IF NOT EXISTS resource_reservations_held ON resource_reservations(domain,state);`);
  }

  /** Create once; an identical definition is a replay and any change conflicts. */
  define(db: DatabaseSync, value: unknown, now: number): ResourceDomain {
    requireTransaction(db);
    const input = object(value);
    if (Object.keys(input).length !== 3 || !["id", "name", "capacity"].every(key => Object.hasOwn(input, key))) throw new ServiceError("Invalid resource domain fields.", 400);
    const id = identifier(input.id), capacity = resources(input.capacity);
    if (typeof input.name !== "string" || !input.name.trim() || Array.from(input.name).length > 100) throw new ServiceError("Invalid resource domain name.", 400);
    const existing = db.prepare("SELECT * FROM resource_domains WHERE id=?").get(id) as unknown as DomainRow | undefined;
    if (existing) {
      if (existing.name !== input.name || JSON.stringify(stored(existing.capacity)) !== JSON.stringify(capacity)) {
        throw new ServiceError("Resource domain already exists with a different definition.", 409);
      }
    } else db.prepare("INSERT INTO resource_domains VALUES (?,?,?,?)").run(id, input.name, JSON.stringify(capacity), now);
    return this.view(db, id);
  }

  exists(db: DatabaseSync, id: string): boolean {
    requireTransaction(db);
    return !!db.prepare("SELECT 1 FROM resource_domains WHERE id=?").get(id);
  }

  view(db: DatabaseSync, id: string): ResourceDomain {
    requireTransaction(db);
    const row = db.prepare("SELECT * FROM resource_domains WHERE id=?").get(id) as unknown as DomainRow | undefined;
    if (!row) throw new ServiceError("Unknown resource domain.", 404);
    const capacity = stored(row.capacity), reserved = { cpu: 0, memoryMiB: 0, diskGiB: 0 };
    const held = db.prepare("SELECT resources FROM resource_reservations WHERE domain=? AND state='held'").all(id);
    for (const reservation of held) {
      const amount = stored(reservation.resources);
      for (const key of keys) reserved[key] += amount[key];
    }
    const available = { cpu: 0, memoryMiB: 0, diskGiB: 0 };
    for (const key of keys) available[key] = Math.max(0, capacity[key] - reserved[key]);
    return { id: row.id, name: row.name, capacity, reserved, available, reservations: held.length };
  }

  /** Hold `amount` only if it fits beside every held reservation in the domain. */
  reserve(db: DatabaseSync, request: { id: string; domain: string; kind: string; owner: string; resources: Resources }, now: number): boolean {
    requireTransaction(db);
    const amount = resources(request.resources);
    const domain = this.view(db, request.domain);
    if (keys.some(key => amount[key] > domain.available[key])) return false;
    db.prepare("INSERT INTO resource_reservations VALUES (?,?,?,?,?,'held',?,NULL)")
      .run(request.id, request.domain, request.kind, request.owner, JSON.stringify(amount), now);
    return true;
  }

  /** Release requires the exact owner recorded at reservation. Already released is a no-op. */
  release(db: DatabaseSync, id: string, owner: string, now: number): void {
    requireTransaction(db);
    const row = db.prepare("SELECT owner,state FROM resource_reservations WHERE id=?").get(id) as { owner: string; state: string } | undefined;
    if (!row || row.owner !== owner) throw new ServiceError("Reservation ownership does not match.", 409);
    if (row.state === "held") db.prepare("UPDATE resource_reservations SET state='released',released=? WHERE id=?").run(now, id);
  }

  held(db: DatabaseSync, id: string): boolean {
    requireTransaction(db);
    return !!db.prepare("SELECT 1 FROM resource_reservations WHERE id=? AND state='held'").get(id);
  }
}
