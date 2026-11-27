import { persistedOffer } from "./machines.ts";
import { physicalMapping } from "../physical-domains.ts";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { Accounts } from "../accounts.ts";
import { CapacityLedger } from "../capacity.ts";
import { identifier } from "../consumers.ts";
import type { Resources } from "../consumers.ts";
import { object, secret, ServiceError } from "../errors.ts";
import type { SqliteStore } from "../sqlite.ts";
import { requireAdmin } from "./contracts.ts";
import { pressureView } from "./pressure.ts";
import type { ControlModule, ControlOptions } from "./contracts.ts";
import { enabledRuntimes, hostProvider, HOST_RUNTIMES, legacyDigest, legacyJson, normalizeTemplate, resources, runtimeFor, text } from "./templates.ts";
import type { Template } from "./templates.ts";

const keys = ["cpu", "memoryMiB", "diskGiB"] as const;
const zero = (): Resources => ({ cpu: 0, memoryMiB: 0, diskGiB: 0 });
const parse = (value: unknown): Record<string, unknown> => object(JSON.parse(String(value)) as unknown);
const same = (a: unknown, b: unknown): boolean => legacyJson(a) === legacyJson(b);
const numeric = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 2 ** 53;
const fields = (v: Record<string, unknown>, allowed: string[]): boolean => Object.keys(v).every(k => allowed.includes(k));
function fail(message: string): never { throw new ServiceError(message, 400); }
const inTransaction = (db: DatabaseSync): void => { if (!db.isTransaction) throw new TypeError("Infrastructure updates require the caller's transaction."); };
export interface HealthCheck { id: string; label: string; detail: string; status: "passed" | "warning" | "failed" | "skipped" }
export interface HealthReport { status: "checking" | "passed" | "warning" | "failed"; checkedAt: number; checks?: HealthCheck[]; capabilities?: Record<string, boolean>; environment?: Record<string, string> }
export function validateHealth(value: unknown): HealthReport {
  const v = object(value);
  if (!fields(v, ["status", "checkedAt", "checks", "capabilities", "environment"]) || !["checking", "passed", "warning", "failed"].includes(String(v.status)) || !numeric(v.checkedAt)) fail("Invalid host health report.");
  const capabilities = object(v.capabilities ?? {}), environment = object(v.environment ?? {});
  if (Object.keys(capabilities).length > 30 || Object.entries(capabilities).some(([k, flag]) => k.length > 100 || typeof flag !== "boolean")) fail("Invalid host capabilities.");
  if (Object.keys(environment).length > 20 || Object.entries(environment).some(([k, val]) => k.length > 100 || typeof val !== "string" || val.length > 200)) fail("Invalid environment metadata.");
  const checks = v.checks ?? [];
  if (!Array.isArray(checks) || checks.length > 50) fail("Invalid environment checks.");
  for (const item of checks as unknown[]) {
    const c = object(item);
    if (!["passed", "warning", "failed", "skipped"].includes(String(c.status))) fail("Invalid environment check.");
    for (const key of ["id", "label", "detail"]) text(c[key], key, 1000);
    if (c.status === "failed" && v.status !== "failed") fail("Failed checks cannot report a ready host.");
  }
  if (legacyJson(v).length > 32768) fail("Host health report is too large.");
  return structuredClone(v) as unknown as HealthReport;
}
export function validateSample(value: unknown): Record<string, unknown> {
  const v = object(value);
  if (v.scope !== "host" || typeof v.domain !== "string" || v.domain.length > 100 || !fields(v, ["scope", "domain", "sampledAt", "cpuPercent", "cpuCount", "memoryTotalMiB", "memoryAvailableMiB", "diskTotalGiB", "diskFreeGiB", "canaveral"])) fail("Invalid resource sample.");
  for (const [key, n] of Object.entries(v)) {
    if (key === "canaveral") {
      const c = object(n);
      if (Object.keys(c).length !== 2 || !fields(c, ["scope", "categories"]) || !["runner-process-tree", "runner-and-owned-processes"].includes(String(c.scope)) || !Array.isArray(c.categories) || c.categories.length !== 3) fail("Invalid Canaveral usage.");
      const seen = new Set<string>();
      for (const item of c.categories as unknown[]) {
        const g = object(item);
        if (Object.keys(g).length !== 4 || !fields(g, ["id", "cpuPercent", "memoryMiB", "processCount"]) || !["services", "virtualMachines", "simulators"].includes(String(g.id)) || seen.has(String(g.id))) fail("Invalid usage category.");
        seen.add(String(g.id));
        for (const metric of ["cpuPercent", "memoryMiB", "processCount"]) if (g[metric] !== null && (!numeric(g[metric]) || (metric === "cpuPercent" && Number(g[metric]) > 100))) fail("Invalid category metric.");
      }
      continue;
    }
    if (["scope", "domain"].includes(key) || n === null) continue;
    if (!numeric(n) || (key === "cpuPercent" && n > 100)) fail("Invalid resource metric.");
  }
  return structuredClone(v);
}
/** Legacy schemas are retained so cutover preserves issued secrets and cached report age. */
export function initializeInfrastructure(db: DatabaseSync): void {
  inTransaction(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS host_limits (host TEXT PRIMARY KEY,limits TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS retired_runners (id TEXT PRIMARY KEY,target TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS connection_setups (id TEXT PRIMARY KEY,specification TEXT NOT NULL,token_hash TEXT NOT NULL,expires REAL NOT NULL,claimed_host TEXT,revoked INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS host_health (host TEXT PRIMARY KEY,report TEXT,received REAL,requested REAL NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS resource_samples (host TEXT NOT NULL,captured REAL NOT NULL,report TEXT NOT NULL,PRIMARY KEY(host,captured));
    CREATE TABLE IF NOT EXISTS host_image_inventory (host TEXT PRIMARY KEY,definitions TEXT NOT NULL,received REAL NOT NULL);
  `);
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='hosts'").get()) {
    for (const row of db.prepare("SELECT id,offer FROM hosts").all()) {
      let capacity: Resources;
      try { capacity = resources(parse(row.offer).capacity); }
      catch { continue; } // Preserve opaque legacy offers; admission needs a valid authenticated offer.
      db.prepare("INSERT OR IGNORE INTO host_limits VALUES (?,?)").run(row.id!, JSON.stringify(capacity));
    }
  }
}
export function authenticateSetup(db: DatabaseSync, token: string, now: number): void {
  inTransaction(db);
  const row = db.prepare("SELECT * FROM connection_setups WHERE token_hash=?").get(legacyDigest(secret(token)));
  if (!row || row.revoked || (!row.claimed_host && Number(row.expires) <= now)) throw new ServiceError("Setup credential rejected.", 401);
}
/** Must run inside enrollment's host-credential check/insert transaction. */
export function claimSetup(db: DatabaseSync, token: string, hostId: string, proposed: Record<string, unknown>, now: number): void {
  inTransaction(db);
  const id = identifier(hostId), row = db.prepare("SELECT * FROM connection_setups WHERE token_hash=?").get(legacyDigest(secret(token)));
  if (!row || row.revoked || (row.claimed_host !== null && row.claimed_host !== id) || (!row.claimed_host && Number(row.expires) <= now)) throw new ServiceError("Setup credential is expired, revoked or already used.", 401);
  const spec = { name: proposed.name, provider: proposed.provider, capacity: proposed.capacity };
  if (!same(parse(row.specification), spec)) throw new ServiceError("Runner name, provider and capacity must match its setup.", 403);
  const host = db.prepare("SELECT credential FROM hosts WHERE id=?").get(id);
  // The caller also checks the submitted persistent host credential. Claiming
  // never replaces an existing identity or authorizes inventory access.
  if (db.prepare("SELECT 1 FROM retired_runners WHERE id=?").get(id)) throw new ServiceError("Runtime identity is retired.", 403);
  void host;
  db.prepare("UPDATE connection_setups SET claimed_host=? WHERE id=?").run(id, row.id!);
}
export function healthReady(db: DatabaseSync, hostId: string, now: number): boolean {
  inTransaction(db);
  const row = db.prepare("SELECT report,received FROM host_health WHERE host=?").get(hostId);
  return !row?.report || (now - Number(row.received) < 120 && ["passed", "warning"].includes(String(parse(row.report).status)));
}
export function hostHealth(db: DatabaseSync, hostId: string, now: number): Record<string, unknown> {
  const row = db.prepare("SELECT report,received,requested FROM host_health WHERE host=?").get(hostId);
  return row?.report ? { ...parse(row.report), receivedAt: row.received, fresh: now - Number(row.received) < 120, requestedAt: row.requested } : { status: "unreported", fresh: false, checks: [], requestedAt: row?.requested ?? 0 };
}
/** Call only after authenticating the host, inside its heartbeat transaction. */
export function recordInfrastructure(db: DatabaseSync, hostId: string, value: Record<string, unknown>, now: number): number {
  inTransaction(db);
  if (value.health !== undefined && value.health !== null) {
    const report = validateHealth(value.health), old = db.prepare("SELECT report FROM host_health WHERE host=?").get(hostId);
    if (!old?.report || !same(parse(old.report), report)) db.prepare("INSERT INTO host_health(host,report,received) VALUES (?,?,?) ON CONFLICT(host) DO UPDATE SET report=excluded.report,received=excluded.received").run(hostId, JSON.stringify(report), now);
  }
  if (value.resources !== undefined && value.resources !== null) {
    const sample = validateSample(value.resources), previous = db.prepare("SELECT captured,report FROM resource_samples WHERE host=? ORDER BY captured DESC LIMIT 1").get(hostId);
    if (!previous || (now - Number(previous.captured) >= 10 && !same(parse(previous.report), sample))) {
      db.prepare("INSERT INTO resource_samples VALUES (?,?,?)").run(hostId, now, JSON.stringify(sample));
      db.prepare("DELETE FROM resource_samples WHERE host=? AND captured<?").run(hostId, now - 21600);
    }
  }
  return Number(db.prepare("SELECT requested FROM host_health WHERE host=?").get(hostId)?.requested ?? 0);
}
/** Supply image ownership validation from the image controller before publication. */
export function recordHostImages(db: DatabaseSync, hostId: string, value: unknown, now: number, validateCatalogue: (db: DatabaseSync, host: string, definitions: Template[]) => void): void {
  inTransaction(db);
  if (value === undefined || value === null) return;
  if (!Array.isArray(value) || value.length > 1000) fail("Invalid installed image inventory.");
  const definitions = value.map(normalizeTemplate), seen = new Set<string>();
  for (const image of definitions) { const key = JSON.stringify([image.id, image.revision, image.arch]); if (seen.has(key)) fail("Duplicate installed image revision."); seen.add(key); }
  validateCatalogue(db, hostId, definitions);
  for (const definition of definitions) {
    const old = db.prepare("SELECT definition FROM templates WHERE id=? AND revision=? AND arch=?").get(definition.id, definition.revision, definition.arch);
    if (old && !same(parse(old.definition), definition)) throw new ServiceError("Template identity/revision already has a different definition. Publish a new revision.", 409);
    if (!old) db.prepare("INSERT INTO templates VALUES (?,?,?,?)").run(definition.id, definition.revision, definition.arch, JSON.stringify(definition));
  }
  db.prepare("INSERT OR REPLACE INTO host_image_inventory VALUES (?,?,?)").run(hostId, JSON.stringify(definitions), now);
}
function deleted(db: DatabaseSync, id: string): boolean {
  return !!db.prepare("SELECT 1 FROM machine_deletions WHERE machine=? AND state='complete'").get(id) || !!db.prepare("SELECT 1 FROM lease_cleanup_members WHERE machine=? AND state='complete'").get(id);
}
function computeReserved(db: DatabaseSync, row: Record<string, unknown>): boolean {
  return !!db.prepare("SELECT 1 FROM lease_members WHERE machine=?").get(String(row.id)) || row.desired === "running" || row.observed !== "stopped" || !!db.prepare("SELECT 1 FROM machine_power_offs WHERE machine=? AND state!='succeeded'").get(String(row.id));
}
export class InfrastructureStore {
  readonly capacity: CapacityLedger;
  constructor(readonly store: SqliteStore) {
    store.transaction(initializeInfrastructure);
    this.capacity = new CapacityLedger(store);
  }
  createSetup(value: unknown, authorize: (db: DatabaseSync) => void = () => {}): Record<string, unknown> {
    const v = object(value), id = identifier(v.id);
    const provider = hostProvider(v.provider);
    const spec = { name: text(v.name, "connection name"), provider, capacity: resources(v.capacity) };
    const token = randomBytes(32).toString("base64url");
    return this.store.transaction(db => {
      authorize(db);
      if (db.prepare("SELECT 1 FROM connection_setups WHERE id=?").get(id)) throw new ServiceError("This setup was already issued. Its secret is returned once; revoke it before creating a replacement.", 409);
      const expires = this.store.clock() + 1800;
      db.prepare("INSERT INTO connection_setups VALUES (?,?,?,?,NULL,0)").run(id, JSON.stringify(spec), legacyDigest(token), expires);
      return { id, ...spec, enrollmentToken: token, expiresAt: expires };
    });
  }
  setups(authorize: (db: DatabaseSync) => void = () => {}): Record<string, unknown>[] {
    return this.store.transaction(db => {
      authorize(db);
      return db.prepare("SELECT * FROM connection_setups ORDER BY expires DESC LIMIT 100").all().map(r => ({ id: r.id, ...parse(r.specification), expiresAt: r.expires, hostId: r.claimed_host, state: r.revoked ? "revoked" : r.claimed_host ? "connected" : Number(r.expires) <= this.store.clock() ? "expired" : "pending" }));
    });
  }
  revokeSetup(value: string, authorize: (db: DatabaseSync) => void = () => {}): Record<string, unknown> {
    const id = identifier(value);
    return this.store.transaction(db => { authorize(db); if (db.prepare("UPDATE connection_setups SET revoked=1 WHERE id=?").run(id).changes !== 1) throw new ServiceError("Unknown setup.", 404); return { id, state: "revoked" }; });
  }
  requestChecks(value: string, authorize: (db: DatabaseSync) => void = () => {}): Record<string, unknown> {
    const id = identifier(value);
    return this.store.transaction(db => {
      authorize(db);
      if (!db.prepare("SELECT 1 FROM hosts WHERE id=? AND id NOT IN (SELECT id FROM retired_runners)").get(id)) throw new ServiceError("Unknown host.", 404);
      db.prepare("INSERT INTO host_health(host,requested) VALUES (?,?) ON CONFLICT(host) DO UPDATE SET requested=excluded.requested").run(id, this.store.clock());
      return { id, requested: true };
    });
  }
  saveLimits(value: string, body: unknown, authorize: (db: DatabaseSync) => void = () => {}): Record<string, unknown> {
    const hostId = identifier(value), input = object(body);
    if (Object.keys(input).length !== 1 || !("limits" in input)) fail("Specify CPU, memory and disk limits for this host.");
    const limits = resources(input.limits);
    return this.store.transaction(db => {
      authorize(db);
      this.capacity.hostLimits(db, hostId);
      db.prepare("INSERT INTO host_limits VALUES (?,?) ON CONFLICT(host) DO UPDATE SET limits=excluded.limits").run(hostId, JSON.stringify(limits));
      return { hostId, limits };
    });
  }
  hostResources(value: string, authorize: (db: DatabaseSync) => void = () => {}): Record<string, unknown> {
    const id = identifier(value);
    return this.store.transaction(db => {
      authorize(db);
      const host = db.prepare("SELECT * FROM hosts WHERE id=? AND id NOT IN (SELECT id FROM retired_runners)").get(id);
      if (!host) throw new ServiceError("Unknown host.", 404);
      const offer = persistedOffer(host.offer);
      const categories = new Map<string, Resources & { id: string; label: string }>();
      for (const [key, label] of [["virtualMachines", "Virtual machines"], ["simulators", "Simulators"], ["retainedDisks", "Stopped machine disks"], ["images", "Images"], ["imageTasks", "Image imports and captures"], ["inference", "Inference"]]) categories.set(key!, { id: key!, label: label!, ...zero() });
      const allocations: Record<string, unknown>[] = [];
      for (const row of db.prepare("SELECT * FROM machines WHERE host=? ORDER BY id").all(id)) {
        if (deleted(db, String(row.id))) continue;
        const request = parse(row.request), size = resources(request.resources), active = computeReserved(db, row);
        const category = active ? ["android", "ios", "tvos", "watchos"].includes(String(parse(row.template).os)) ? "simulators" : "virtualMachines" : "retainedDisks", group = categories.get(category)!;
        group.diskGiB += size.diskGiB; if (active) { group.cpu += size.cpu; group.memoryMiB += size.memoryMiB; }
        allocations.push({ id: row.id, name: request.name, resources: size, desired: row.desired, observed: offer ? row.observed : "unknown", computeReserved: active });
      }
      for (const row of db.prepare("SELECT reserved_disk FROM image_tasks WHERE host=? AND state IN ('queued','running','unknown')").all(id)) categories.get("imageTasks")!.diskGiB += Number(row.reserved_disk);
      const artifacts = new Map<string, number>(), records = new Map<string, Record<string, unknown>>();
      for (const row of db.prepare("SELECT id,metadata FROM images WHERE host=?").all(id)) {
        const metadata = parse(row.metadata); records.set(String(row.id), metadata); artifacts.set(JSON.stringify([metadata.sha256, metadata.format]), Number(metadata.bytes));
      }
      for (const size of artifacts.values()) categories.get("images")!.diskGiB += Math.ceil(size / 1073741824);
      for (const row of db.prepare("SELECT definition FROM inference_jobs WHERE host=? AND state NOT IN ('succeeded','failed','cancelled')").all(id)) { const size = resources(parse(row.definition).resources); for (const key of keys) categories.get("inference")![key] += size[key]; }
      const offered = (offer?.templates ?? []) as Template[];
      const inventory = offer && db.prepare("SELECT definitions FROM host_image_inventory WHERE host=?").get(id);
      const key = (t: Template): string => JSON.stringify([t.id, t.revision, t.arch]);
      const definitions = new Map<string, Template>();
      for (const t of [...(inventory ? (JSON.parse(String(inventory.definitions)) as unknown[]).map(normalizeTemplate) : offered), ...offered]) definitions.set(key(t), t);
      const offeredKeys = new Set(offered.map(key)), images: Record<string, unknown>[] = [];
      for (const [k, definition] of definitions) {
        const artifact = records.get(String(definition.catalogueImageId ?? definition.id));
        if (artifact && artifact.revision === definition.revision && artifact.arch === definition.arch) { records.delete(String(artifact.id)); images.push({ ...definition, ...artifact, offered: offeredKeys.has(k), origin: "library" }); }
        else images.push({ ...definition, offered: offeredKeys.has(k), origin: "runtime" });
      }
      for (const record of records.values()) images.push({ ...record, offered: false, origin: "library" });
      const reserved = this.capacity.used(db, id), mapping = physicalMapping(db, { hostId: id });
      if (mapping) {
        const shared = { id: "physicalShared", label: "Shared runner and extension reservations", ...zero() };
        for (const resource of keys) {
          shared[resource] = reserved[resource] - [...categories.values()].reduce((n, group) => n + group[resource], 0);
          if (!Number.isSafeInteger(shared[resource]) || shared[resource] < 0) throw new ServiceError("Invalid shared reservation categories.", 503);
        }
        categories.set(shared.id, shared);
      }
      for (const resource of keys) if ([...categories.values()].reduce((n, g) => n + g[resource], 0) !== reserved[resource]) throw new ServiceError("Reservation category accounting is unavailable.", 503);
      return { hostId: id, ...(mapping ? { physicalDomainId: mapping.domainId } : {}), capacity: offer?.capacity ?? zero(), limits: offer ? this.capacity.hostLimits(db, id) : zero(), reserved, images, categories: [...categories.values()], available: offer ? this.capacity.remaining(db, id) : zero(), pressure: pressureView(db, id, this.store.clock()), samples: offer ? db.prepare("SELECT * FROM resource_samples WHERE host=? ORDER BY captured DESC LIMIT 360").all(id).map(r => ({ receivedAt: r.captured, ...parse(r.report) })) : [], allocations };
    });
  }
}
export function createModule(store: SqliteStore, options: ControlOptions): ControlModule {
  const infrastructure = new InfrastructureStore(store);
  const accounts = new Accounts(store);
  return { handle(req) {
    const setupRoute = req.path === "/v1/connection-setups", revoke = /^\/v1\/connection-setups\/[^/]+\/revoke$/.test(req.path), host = /^\/v1\/hosts\/[^/]+\/(checks|limits|resources)$/.test(req.path);
    if (!(setupRoute && ["GET", "POST"].includes(req.method)) && !(revoke && req.method === "POST") && !(host && ((req.parts[3] === "resources" && req.method === "GET") || (["checks", "limits"].includes(req.parts[3]!) && req.method === "POST")))) return undefined;
    requireAdmin(req);
    // Account authority is read under the same write lock as the protected
    // operation. Calling request.principal() here could nest a transaction.
    const authorize = (db: DatabaseSync): void => {
      const token = Buffer.from(req.token), operator = Buffer.from(options.adminToken);
      const isOperator = token.length === operator.length && timingSafeEqual(token, operator);
      requireAdmin({ ...req, principal: () => isOperator ? { kind: "operator", user: null, scopes: ["admin"] } : accounts.principalDb(db, req.token) });
    };
    if (setupRoute) return { body: req.method === "GET" ? { setups: infrastructure.setups(authorize) } : infrastructure.createSetup(req.body, authorize) };
    if (revoke) return { body: infrastructure.revokeSetup(req.parts[2]!, authorize) };
    const id = req.parts[2]!;
    if (req.parts[3] === "resources") return { body: infrastructure.hostResources(id, authorize) };
    if (req.parts[3] === "limits") return { body: infrastructure.saveLimits(id, req.body, authorize) };
    if (Object.keys(req.body).length) fail("Checks request expects an empty object.");
    return { body: infrastructure.requestChecks(id, authorize) };
  } };
}

/** Offline only. The launcher must hold every identity lock throughout this call. */
export function consolidateLocalRuntimes(store: SqliteStore, targetId: string, sourceIds: string[], definition: unknown, assertLocallyFenced: (ids: readonly string[]) => void): Record<string, unknown> {
  const target = identifier(targetId), sources = sourceIds.map(identifier), input = object(definition);
  if (sources.includes(target) || new Set(sources).size !== sources.length || !Object.hasOwn(HOST_RUNTIMES, String(input.provider))) fail("Invalid physical-host consolidation.");
  const runtimes = Object.keys(enabledRuntimes(input)).sort();
  if (!Array.isArray(input.templates) || input.templates.length > 100) fail("Invalid consolidated template catalogue.");
  const templates = input.templates.map(normalizeTemplate);
  for (const t of templates) runtimeFor(input, t);
  if (new Set(templates.map(t => JSON.stringify([t.id, t.revision, t.arch]))).size !== templates.length) fail("Duplicate template revision.");
  const proposed = { name: text(input.name, "host name"), provider: String(input.provider), capacity: resources(input.capacity), runtimes, templates };
  const ids = [target, ...sources];
  assertLocallyFenced(ids);
  return store.transaction(db => {
    inTransaction(db); assertLocallyFenced(ids);
    for (const id of ids) {
      const row = db.prepare("SELECT * FROM hosts WHERE id=?").get(id);
      if (!row) throw new ServiceError("Runtime identity is missing; do not adopt another host.", 404);
      const old = parse(row.offer);
      if (!runtimes.includes(String(old.provider)) && !(id === target && old.provider === proposed.provider)) throw new ServiceError("Runtime does not belong to this physical host configuration.", 409);
      if (old.inference || old.leaseProtocol) throw new ServiceError("Retain inference and lease execution contracts through a separate migration.", 409);
      if (db.prepare("SELECT 1 FROM inference_jobs WHERE host=? AND state NOT IN ('succeeded','failed','cancelled')").get(id)) throw new ServiceError("Active historical inference work requires separate migration.", 409);
      for (const machine of db.prepare("SELECT template FROM machines WHERE host=?").all(id)) if (!templates.some(t => same(t, parse(machine.template)))) throw new ServiceError("Retain every assigned immutable image definition during consolidation.", 409);
      if (id !== target && (db.prepare("SELECT 1 FROM images WHERE host=?").get(id) || db.prepare("SELECT 1 FROM image_tasks WHERE host=?").get(id))) throw new ServiceError("Historical image storage requires explicit ownership migration.", 409);
    }
    for (const image of templates) {
      const old = db.prepare("SELECT definition FROM templates WHERE id=? AND revision=? AND arch=?").get(image.id, image.revision, image.arch);
      if (old && !same(parse(old.definition), image)) throw new ServiceError("Template revision is already registered differently.", 409);
      if (!old) db.prepare("INSERT INTO templates VALUES (?,?,?,?)").run(image.id, image.revision, image.arch, JSON.stringify(image));
    }
    for (const source of sources) {
      const retired = db.prepare("SELECT target FROM retired_runners WHERE id=?").get(source);
      if (retired && retired.target !== target) throw new ServiceError("Runtime was already moved to another host.", 409);
      for (const table of ["machines", "device_operations", "inference_jobs"]) db.prepare(`UPDATE ${table} SET host=? WHERE host=?`).run(target, source);
      db.prepare("UPDATE hosts SET enabled=0 WHERE id=?").run(source);
      db.prepare("INSERT OR IGNORE INTO retired_runners VALUES (?,?)").run(source, target);
    }
    db.prepare("UPDATE hosts SET offer=? WHERE id=?").run(JSON.stringify(proposed), target);
    db.prepare("INSERT INTO host_health(host,report,received) VALUES (?,?,?) ON CONFLICT(host) DO UPDATE SET report=excluded.report,received=excluded.received").run(target, JSON.stringify({ status: "checking", checkedAt: store.clock(), checks: [] }), store.clock());
    return { id: target, retiredRunnerIds: sources };
  });
}

export type UsageCategory = "services" | "virtualMachines" | "simulators";
export interface ProcessObservation {
  pid: number; birth: number; name: string; executable?: string;
  userSeconds: number; systemSeconds: number; rssBytes: number;
  category?: UsageCategory; expectedBirth?: number;
  /** Revalidate native ownership after counters, including current PID birth. */
  verify?(): boolean;
}
/** Per-observer counter state. Inputs must already be tree members or ownership-verified assignments. */
export class ProcessUsageCollector {
  private previous = new Map<string, [time: number, cpu: number]>();
  collect(processes: readonly ProcessObservation[] | null, cpuCount: number | null, monotonicSeconds: number, unavailable: ReadonlySet<UsageCategory> = new Set(), ownedScope = false): Record<string, unknown> {
    const groups = new Map<UsageCategory, { id: UsageCategory; cpuPercent: number | null; memoryMiB: number | null; processCount: number | null }>();
    for (const id of ["services", "virtualMachines", "simulators"] as const) groups.set(id, { id, cpuPercent: 0, memoryMiB: 0, processCount: 0 });
    const unknown = new Set(unavailable), current = new Map<string, [number, number]>(), seen = new Set<string>();
    if (processes === null) for (const key of groups.keys()) unknown.add(key);
    for (const p of processes ?? []) {
      let category = p.category;
      if (!category) {
        const name = p.name.toLowerCase(), executable = (p.executable ?? "").toLowerCase().replaceAll("\\", "/");
        category = /^(emulator|simulator|qemu-system-android)/.test(name) || (name.startsWith("qemu-system") && executable.includes("/emulator/")) ? "simulators" : name.includes("canaveralvmrunner") || name.startsWith("qemu-system") ? "virtualMachines" : "services";
      }
      const group = groups.get(category)!;
      const identity = `${p.pid}:${p.birth}`;
      if (seen.has(identity)) continue; seen.add(identity);
      try {
        if (![p.pid, p.birth, p.userSeconds, p.systemSeconds, p.rssBytes].every(numeric) || (p.expectedBirth !== undefined && (p.birth !== p.expectedBirth || !p.verify)) || (p.verify && !p.verify())) throw new TypeError();
        const total = p.userSeconds + p.systemSeconds;
        if (!numeric(total)) throw new TypeError();
        const previous = this.previous.get(identity); current.set(identity, [monotonicSeconds, total]);
        group.processCount!++; group.memoryMiB! += p.rssBytes / 1048576;
        if (cpuCount !== null && Number.isInteger(cpuCount) && cpuCount > 0 && previous && total >= previous[1] && monotonicSeconds > previous[0] && group.cpuPercent !== null) group.cpuPercent += (total - previous[1]) / (monotonicSeconds - previous[0]) / cpuCount * 100;
        else group.cpuPercent = null;
      } catch { unknown.add(category); }
    }
    this.previous = current;
    for (const group of groups.values()) {
      if (unknown.has(group.id)) { group.cpuPercent = null; group.memoryMiB = null; group.processCount = null; }
      if (group.cpuPercent !== null) group.cpuPercent = Number(Math.min(100, group.cpuPercent).toFixed(2));
      if (group.memoryMiB !== null) group.memoryMiB = Number(group.memoryMiB.toFixed(1));
    }
    return { scope: ownedScope || unavailable.size ? "runner-and-owned-processes" : "runner-process-tree", categories: [...groups.values()] };
  }
}
export interface InspectionEvidence {
  system: "Darwin" | "Linux" | "Windows"; arch: string;
  storageWritable: boolean;
  tools: readonly { label: string; available: boolean; version?: string }[];
  /** Evidence from the matching provider checker, never raw SDK stderr. */
  backendValid: boolean | null;
  measurements?: Record<string, unknown>;
  libvirtLeaseArtifact?: boolean | null;
  androidUploadHelper?: boolean | null;
}
/** Reduce independently collected prerequisites; no runtime/provider command is invoked here. */
export function inspectHost(config: Record<string, unknown>, evidence: InspectionEvidence, now: number): HealthReport {
  const checks: HealthCheck[] = [], provider = String(config.provider), images = Array.isArray(config.templates) ? config.templates.map(normalizeTemplate) : [];
  const add = (id: string, label: string, status: HealthCheck["status"], detail: string): void => { checks.push({ id, label, status, detail }); };
  const expected: Record<string, string[]> = { macos: ["Darwin"], linux: ["Linux"], windows: ["Windows"], apple: ["Darwin"], ios: ["Darwin"], android: ["Darwin", "Linux"], libvirt: ["Linux"], hyperv: ["Windows"] };
  add("platform", "Operating system", expected[provider]?.includes(evidence.system) ? "passed" : "failed", `${evidence.system} / ${evidence.arch}; configured ${provider}.`);
  add("storage", "Storage access", evidence.storageWritable ? "passed" : "failed", evidence.storageWritable ? "Runner can write its configured storage directory." : "Set an absolute, writable storage directory owned by this runner account.");
  const required: Record<string, string[]> = { apple: ["runner"], libvirt: ["virsh", "qemu-img"], hyperv: ["powershell"], ios: ["xcrun", "idb", "idb_companion"], android: ["adb", "emulator", "avdmanager", "java"] };
  const requiredTools = Object.hasOwn(HOST_RUNTIMES, provider) ? Object.keys(enabledRuntimes(config)).flatMap(r => required[r] ?? []) : required[provider] ?? [];
  for (const [i, label] of [...new Set(requiredTools)].entries()) {
    const tool = evidence.tools.find(t => t.label === label), version = tool?.version && /^\d+\.\d+(?:\.\d+)?$/.test(tool.version) ? `; version ${tool.version}` : "";
    add(`tool-${i}`, label, tool?.available ? "passed" : "failed", tool?.available ? `Executable available${version}.` : "Install this prerequisite or correct its configured path.");
  }
  const hasRuntime = (runtime: string): boolean => provider === runtime || (Object.hasOwn(HOST_RUNTIMES, provider) && Object.hasOwn(enabledRuntimes(config), runtime));
  if (hasRuntime("libvirt")) {
    const valid = evidence.libvirtLeaseArtifact;
    add("libvirt-lease-artifact", "Linux lease deadline artifact", valid === true ? "passed" : valid === false ? "failed" : "warning", valid === true ? "Owned artifact architecture and required exports passed static inspection. No code was loaded." : valid === false ? "Correct the configured private deadline artifact and required exports." : "Native deadline artifact is not verified.");
    add("libvirt-lease-acceptance", "Native consumer lease verification", "warning", "Artifact checks do not establish expiry, cleanup, restart or fresh-lease isolation. Consumer admission retains its separate acceptance gate.");
  }
  if (hasRuntime("android")) add("android-upload-helper", "Android durable upload helper", evidence.androidUploadHelper === true ? "passed" : evidence.androidUploadHelper === false ? "failed" : "warning", "Configured helper architecture, API level and checksums require validation; guest execution retains its acceptance gate.");
  else {
    const size = resources(config.capacity), m = evidence.measurements ?? {}, known = numeric(m.cpuCount) && numeric(m.memoryTotalMiB), tooLarge = (numeric(m.cpuCount) && size.cpu > m.cpuCount) || (numeric(m.memoryTotalMiB) && size.memoryMiB > m.memoryTotalMiB);
    add("capacity", "Offered host capacity", tooLarge ? "failed" : known ? "passed" : "warning", tooLarge ? "Offered CPU or memory exceeds this host; lower configured capacity." : known ? "Offered capacity fits measured CPU and memory." : "Physical resources are unavailable; verify configured capacity.");
    add("disk-space", "Storage headroom", !numeric(m.diskFreeGiB) || size.diskGiB > m.diskFreeGiB ? "warning" : "passed", "Logical disk reservations remain separate from measured free storage.");
  }
  if (checks.some(c => c.status === "failed")) add("backend", "Runtime and image validation", "skipped", "Fix failed prerequisites, then run checks again.");
  else add("backend", "Runtime and image validation", evidence.backendValid === true ? "passed" : "failed", evidence.backendValid === true ? "Backend connection and configured image bindings passed provider validation." : "Provider validation is unavailable or failed. Verify runtime access, permissions and image bindings locally.");
  add("images", "Image catalogue", images.length ? "passed" : "warning", images.length ? `${images.length} configured images.` : "Connected without images. Add installed image definitions to the runner configuration.");
  const mobile = hasRuntime("android") || hasRuntime("ios"), guest = images.some(t => t.guestAccess === true);
  return validateHealth({ status: checks.some(c => c.status === "failed") ? "failed" : checks.some(c => c.status === "warning") ? "warning" : "passed", checkedAt: now, checks, capabilities: { virtualMachines: ["apple", "libvirt", "hyperv"].some(hasRuntime), simulators: mobile, desktopStream: mobile || guest, files: mobile || guest, shell: hasRuntime("android") || guest, accessibility: mobile || guest, outboundControl: true, remoteDesktopBroker: false, libvirtLeaseArtifact: evidence.libvirtLeaseArtifact === true, androidUploadHelper: evidence.androidUploadHelper === true }, environment: { system: evidence.system, arch: evidence.arch } });
}
