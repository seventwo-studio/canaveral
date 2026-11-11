import type { DatabaseSync } from "node:sqlite";
import { identifier } from "./consumers.ts";
import type { Resources } from "./consumers.ts";
import { object, ServiceError } from "./errors.ts";
import { comparePlacementScore, placementScore } from './placement.ts';

import { boundHostState, combineResources, hostReservations } from "./capacity.ts";

const keys = ["cpu", "memoryMiB", "diskGiB"] as const;

export interface ResourceDomain {
  id: string; name: string; capacity: Resources; reserved: Resources; available: Resources; reservations: number;
  host?: { id: string; reserved: Resources; accepting: boolean };
  runnerReserved?: Resources;
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
  /** A runner identity retains one budget across adapters and enrollment generations.
   * Old approvals still anchor unknown held work; revocation cannot create fresh capacity.
   */
  runnerDomainMatches(db: DatabaseSync, binding: { controllerId: string; runnerId: string }, domain: string): boolean {
    requireTransaction(db);
    for (const table of ["model_runner_approvals", "linux_lease_runner_approvals"] as const) {
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) continue;
      if (db.prepare(`SELECT 1 FROM ${table} WHERE controller=? AND runner=? AND domain!=? LIMIT 1`)
        .get(binding.controllerId, binding.runnerId, domain)) return false;
    }
    return true;
  }

  assertRunnerDomain(db: DatabaseSync, binding: { controllerId: string; runnerId: string }, domain: string): void {
    if (!this.runnerDomainMatches(db, binding, domain)) throw new ServiceError("Runner identity is already bound to a different resource domain.", 409);
  }

  constructor(readonly clock: () => number = () => Date.now() / 1000) {}
  static schema(db: DatabaseSync): void {
    db.exec(`CREATE TABLE IF NOT EXISTS resource_domains (id TEXT PRIMARY KEY, name TEXT NOT NULL, capacity TEXT NOT NULL, created REAL NOT NULL);
      CREATE TABLE IF NOT EXISTS resource_reservations (id TEXT PRIMARY KEY, domain TEXT NOT NULL, kind TEXT NOT NULL, owner TEXT NOT NULL, resources TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('held','released')), created REAL NOT NULL, released REAL);
      CREATE TABLE IF NOT EXISTS resource_domain_hosts (host TEXT PRIMARY KEY, domain TEXT NOT NULL UNIQUE, created REAL NOT NULL);
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
    const capacity = stored(row.capacity); let reserved = { cpu: 0, memoryMiB: 0, diskGiB: 0 };
    const held = db.prepare("SELECT resources FROM resource_reservations WHERE domain=? AND state='held'").all(id);
    for (const reservation of held) {
      const amount = stored(reservation.resources);
      reserved = combineResources(reserved, amount);
    }
    const runnerReserved = { ...reserved };
    const host = boundHostState(db, id, this.clock());
    if (host) {
      reserved = combineResources(reserved, hostReservations(db, host.host));
      for (const key of keys) capacity[key] = Math.min(capacity[key], host.capacity[key]);
    }
    const available = { cpu: 0, memoryMiB: 0, diskGiB: 0 };
    for (const key of keys) available[key] = host && !host.available ? 0 : Math.max(0, capacity[key] - reserved[key]);
    return { id: row.id, name: row.name, capacity, reserved, available, reservations: held.length,
      ...(host ? { host: { id: host.host, reserved: hostReservations(db, host.host), accepting: host.available }, runnerReserved } : {}) };
  }

  /** Bind once without moving or rewriting any existing reservation. */
  bindHost(db: DatabaseSync, value: unknown, now: number): { hostId: string; domainId: string } {
    requireTransaction(db);
    const input = object(value);
    if (Object.keys(input).length !== 2 || !Object.hasOwn(input, "hostId") || !Object.hasOwn(input, "domainId")) throw new ServiceError("Specify hostId and domainId.", 400);
    const hostId = identifier(input.hostId), domainId = identifier(input.domainId);
    const existing = db.prepare("SELECT host,domain FROM resource_domain_hosts WHERE host=? OR domain=?").all(hostId, domainId);
    if (existing.length) {
      if (existing.length === 1 && existing[0]!.host === hostId && existing[0]!.domain === domainId) return { hostId, domainId };
      throw new ServiceError("Host or domain already has a different immutable binding.", 409);
    }
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='hosts'").get() || !db.prepare("SELECT 1 FROM hosts WHERE id=?").get(hostId)) throw new ServiceError("Unknown host.", 404);
    this.view(db, domainId);
    db.exec("SAVEPOINT bind_resource_host");
    try {
      db.prepare("INSERT INTO resource_domain_hosts VALUES (?,?,?)").run(hostId, domainId, now);
      const view = this.view(db, domainId), host = boundHostState(db, domainId, now)!;
      if (!host.available || keys.some(key => view.reserved[key] > view.capacity[key])) throw new ServiceError("Binding requires an accepting host and fitting existing reservations.", 409);
      db.exec("RELEASE SAVEPOINT bind_resource_host");
    } catch (error) { db.exec("ROLLBACK TO SAVEPOINT bind_resource_host; RELEASE SAVEPOINT bind_resource_host"); throw error; }
    return { hostId, domainId };
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

  /** Filter and rank caller-approved domains under the same admission lock.
   * Held Linux and model reservations both contribute; released ones do not.
   */
  placements(db: DatabaseSync, domains: readonly string[], request: Resources): string[] {
    requireTransaction(db);
    const amount = resources(request);
    return [...new Set(domains)].map(id => this.view(db, id))
      .filter(domain => keys.every(key => amount[key] <= domain.available[key]))
      .map(domain => ({ id: domain.id, score: placementScore(domain.capacity, domain.reserved, amount) }))
      .sort((a, b) => comparePlacementScore(a.score, b.score) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map(domain => domain.id);
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
