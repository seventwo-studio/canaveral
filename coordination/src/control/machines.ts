import { timingSafeEqual } from "node:crypto";
import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import { ServiceError, object, secret } from "../errors.ts";
import { SqliteStore } from "../sqlite.ts";
import { HostMaintenance, hostAdmissionClosed, requireHostAdmission } from "./maintenance.ts";
import { comparePlacementScore, placementScore } from '../placement.ts';
import type { PlacementScore } from '../placement.ts';
import { owns, requireAdmin, requireScope } from "./contracts.ts";
import type { ControlModule, ControlOptions, ControlRequest } from "./contracts.ts";

import { initializeLifecycle, isDeleted, computeReserved, deletion, hasPendingPowerOff, lifecycleAssignment, reportLifecycle } from "./lifecycle.ts";

import { hostProvider, legacyJson, legacyDigest, normalizeTemplate } from "./templates.ts";
import { initializeInfrastructure, claimSetup, healthReady, recordInfrastructure, recordHostImages } from "./infrastructure.ts";
import { recordPreparation } from "./preparation.ts";
import { initializePressure, pressureAdmission, pressureRefusal, pressureView, recordPressure } from "./pressure.ts";
import type { PressureCode } from "./pressure.ts";
import { reportImageTasks, assignedImageTasks, acknowledgedImages, validateCatalogueOffer } from "./images.ts";
import { reportInferenceJobs, assignedInferenceJobs, INFERENCE_HOST_PROVIDERS } from "./inference.ts";
import { blueprint, initializeBlueprints } from "./blueprints.ts";
import { baselineUsable, pendingBaselineSave, requireNotPooled } from "./pool-ledger.ts";

import { PhysicalDomains, physicalBudget, physicalMapping } from "../physical-domains.ts";

type Json = Record<string, any>;
export type MachineRow = Record<string, SQLOutputValue>;
export interface Resources { cpu: number; memoryMiB: number; diskGiB: number }
const resourceKeys = ["cpu", "memoryMiB", "diskGiB"] as const;
const failure = (message: string, status = 400): never => { throw new ServiceError(message, status); };
function fields(value: Json, allowed: string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) failure("Unknown request fields.");
}
function text(value: unknown, label: string, max = 100): string {
  if (typeof value !== "string" || !value.trim() || [...value].length > max) failure(`Invalid ${label}.`);
  return value as string;
}
function integer(value: unknown, label: string, max = 1048576): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > max) failure(`Invalid ${label}.`);
  return value as number;
}
export function machineIdentifier(value: unknown): string {
  if (typeof value !== "string") return failure("Expected a UUID.");
  const hex = value.toLowerCase().replace(/^urn:uuid:/, "").replace(/^\{(.*)\}$/, "$1").replaceAll("-", "");
  if (!/^[a-f0-9]{32}$/.test(hex)) return failure("Expected a UUID.");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export function machineResources(value: unknown): Resources {
  const input = object(value);
  return { cpu: integer(input.cpu, "cpu"), memoryMiB: integer(input.memoryMiB, "memoryMiB"), diskGiB: integer(input.diskGiB, "diskGiB") };
}
// Legacy digest is SHA-256 of Python json.dumps(sort_keys=True), including spaces,
// ASCII escaping and the quotes around secrets. Preserve persisted host/guest hashes.
const pythonJson = legacyJson;
export const machineDigest = legacyDigest;
function equal(a: unknown, b: unknown): boolean { return pythonJson(a) === pythonJson(b); }
function secureEqual(a: string, b: string): boolean {
  return Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
function checksum(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) return failure("Invalid SHA-256 checksum.");
  return value;
}
export const validateTemplate = normalizeTemplate;
const platformRuntimes: Record<string, string[]> = { macos: ["apple", "android", "ios"], linux: ["libvirt", "android"], windows: ["hyperv"] };
export function machineImageRuntime(host: Json, image: Json): string {
  if (!platformRuntimes[host.provider]) {
    if (!["apple", "libvirt", "hyperv", "android", "ios"].includes(host.provider) || (image.runtime ?? host.provider) !== host.provider) failure("Lease image runtime differs from its host adapter.");
    return host.provider;
  }
  const names: string[] = Array.isArray(host.runtimes) ? host.runtimes : Object.keys(host.runtimes ?? {});
  const name = image.runtime ?? (["android", "ios"].includes(image.os) ? image.os : names.find(key => ["apple", "libvirt", "hyperv"].includes(key)));
  const systems: Record<string, string[]> = { apple: ["linux", "macos"], libvirt: ["linux", "windows"], hyperv: ["linux", "windows"], android: ["android"], ios: ["ios"] };
  if (!names.includes(name) || !systems[name]?.includes(image.os)) failure("Image operating system is incompatible with its enabled runtime.");
  return name;
}
/** The isolation class of an iOS simulator lease. A simulator app is an ordinary process of the
 * Mac host's user, so the lease is not fenced from its host (owner decision, 21 November 2026). */
export const SHARED_HOST_ISOLATION = "shared-host";
/** The exact selector a host must advertise before this image can be leased on it. An iOS
 * selector carries the explicit shared-host declaration, so one without it never matches;
 * the controller applies the same gate as the host and has no default for it. */
export function leaseImageReference(host: Json, image: Json): Json {
  const runtime = machineImageRuntime(host, image);
  return { id: image.id, revision: image.revision, arch: image.arch, runtime, ...(runtime === "ios" ? { isolation: SHARED_HOST_ISOLATION } : {}) };
}
export function machineLeaseEligible(host: Json, image: Json): boolean {
  if (host.leaseProtocol !== 1 || !Array.isArray(host.templates) || !host.templates.some((offered: Json) => equal(offered, image)) || !Array.isArray(host.leaseImages)) return false;
  try {
    const reference = leaseImageReference(host, image);
    return host.leaseImages.some((entry: Json) => equal(entry, reference));
  } catch (error) { if (error instanceof ServiceError) return false; throw error; }
}
/** The size a request gets from an image, or undefined when it breaks the image's minimum or its
 * memory step. One rule for admission and for anything that predicts an admission. */
export function placementSize(image: Json, overrides: Partial<Resources>, preset?: { minimum: Resources; defaults: Resources } | null): Resources | undefined {
  const size: Resources = { ...(preset?.defaults ?? image.defaults ?? image.minimum), ...overrides };
  return size.memoryMiB % (image.memoryStepMiB ?? 1) === 0 && resourceKeys.every(key => (preset?.minimum ?? image.minimum)[key] <= size[key]) ? size : undefined;
}
export function validateOffer(value: unknown): Json {
  const input = object(value);
  const provider = hostProvider(input.provider);
  const result: Json = { name: text(input.name, "host name"), capacity: machineResources(input.capacity), provider };
  if ("leaseProtocol" in input) { if (input.leaseProtocol !== 1) failure("Unsupported lease execution protocol."); result.leaseProtocol = 1; }
  if (!Array.isArray(input.templates) || input.templates.length > 100) failure("Offer at most 100 installed templates.");
  result.templates = (input.templates as unknown[]).map(validateTemplate);
  if (new Set(result.templates.map((t: Json) => pythonJson([t.id, t.revision, t.arch]))).size !== result.templates.length) failure("Template ID/revision/architecture combinations must be unique on a host.");
  if (platformRuntimes[result.provider]) {
    const runtimes = Array.isArray(input.runtimes) ? Object.fromEntries(input.runtimes.map(name => [text(name, "runtime"), {}])) : object(input.runtimes);
    const names = Object.keys(runtimes);
    if (!names.length || (Array.isArray(input.runtimes) && input.runtimes.length !== names.length) || names.some(name => !platformRuntimes[result.provider]!.includes(name) || runtimes[name] === null || typeof runtimes[name] !== "object" || Array.isArray(runtimes[name]))) failure("A runtime is incompatible with this host operating system.");
    // Resolve against the original insertion order, as the Python runtime selector does.
    for (const image of result.templates) machineImageRuntime({ ...result, runtimes }, image);
    result.runtimes = names.sort();
  } else for (const image of result.templates) {
    const mobile = ["android", "ios"].includes(image.os);
    if ((mobile && image.os !== result.provider) || (["android", "ios"].includes(result.provider) && !mobile)) failure("Mobile templates require their matching device provider.");
  }
  if ("leaseImages" in input || "leaseProtocol" in result) {
    const images = input.leaseImages === undefined ? [] : input.leaseImages;
    if (!Array.isArray(images) || images.length > 100) failure("Lease images must explicitly list at most 100 installed image/runtime identities.");
    const seen = new Set<string>();
    result.leaseImages = (images as unknown[]).map(value => {
      const entry = object(value); fields(entry, ["id", "revision", "arch", "runtime", "isolation"]);
      for (const key of ["id", "revision", "arch", "runtime"]) text(entry[key], `lease image ${key}`);
      // Only an iOS selector declares an isolation class, and it must be exactly shared-host.
      if (entry.runtime === "ios" ? entry.isolation !== SHARED_HOST_ISOLATION : "isolation" in entry) failure("An iOS lease image must declare the shared-host isolation class; no other runtime may declare one.");
      const identity = pythonJson([entry.id, entry.revision, entry.arch]);
      const image = result.templates.find((image: Json) => equal([image.id, image.revision, image.arch], [entry.id, entry.revision, entry.arch]));
      if (seen.has(identity) || !image || entry.runtime !== machineImageRuntime(result, image)) failure("Lease image must uniquely match an installed image and its configured runtime.");
      seen.add(identity); return entry;
    }).sort((a: Json, b: Json) => { for (const key of ["id", "revision", "arch", "runtime"]) { if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1; } return 0; });
  }
  // Lease port tunnels are a separate, explicit declaration on top of lease execution.
  if ("leaseTunnelProtocol" in input) {
    if (input.leaseTunnelProtocol !== 1 || result.leaseProtocol !== 1) failure("Lease tunnels require lease execution protocol 1 and tunnel protocol 1.");
    // An account-owned emulator launches without the lease isolation arguments and can reach the
    // host's adb server, and through it a leased device's tunnelled port. A host that declares
    // tunnels therefore offers Android templates for leases only.
    if (result.templates.some((image: Json) => image.os === "android" && !result.leaseImages.some((entry: Json) => equal([entry.id, entry.revision, entry.arch], [image.id, image.revision, image.arch])))) failure("A host that declares lease tunnels may offer only leased Android templates.");
    result.leaseTunnelProtocol = 1;
  }
  // A host's own opt-in and bounds for warm devices; meaningful only with lease execution.
  if ("warmPool" in input) {
    const pool = object(input.warmPool); fields(pool, ["maxDevices", "maxAgeSeconds"]);
    if (result.leaseProtocol !== 1) failure("Warm devices require lease execution.");
    result.warmPool = { maxDevices: integer(pool.maxDevices, "warm device limit", 64), maxAgeSeconds: integer(pool.maxAgeSeconds, "warm maximum age", 86400) };
    if (result.warmPool.maxAgeSeconds < 60) failure("Invalid warm maximum age.");
  }
  if ("inference" in input) {
    if (!INFERENCE_HOST_PROVIDERS.includes(result.provider)) failure("Embedded inference requires a native Mac or Linux host.");
    const inference = object(input.inference);
    if (inference.runtime !== "ollama" || !Array.isArray(inference.models) || !inference.models.length || inference.models.length > 100) failure("Offer between 1 and 100 installed ollama models.");
    const models = (inference.models as unknown[]).map(value => {
      const model = object(value), id = text(model.id, "model ID", 200);
      if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(id) || id.toLowerCase().includes("cloud") || typeof model.digest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(model.digest) || (model.capability ?? "generation") !== "generation") failure("Use an exact installed generation model with a pinned digest.");
      return { id, digest: model.digest, capability: "generation", resources: machineResources(model.resources) };
    });
    if (new Set(models.map(m => m.id)).size !== models.length) failure("Model IDs must be unique within a host offer.");
    result.inference = { runtime: "ollama", models };
  }
  if (result.provider === "native" && result.templates.length) failure("The native inference provider does not offer VMs.");
  return result;
}
export function validateMachineRequest(value: unknown): Json {
  const input = object(value); fields(input, ["id", "name", "templateId", "resources", "templateRevision", "hostId", "arch", "blueprintId", "blueprintRevision"]);
  const overrides = object(input.resources === undefined ? {} : input.resources); fields(overrides, [...resourceKeys]);
  const result: Json = { id: machineIdentifier(input.id), name: text(input.name, "machine name"), resources: Object.fromEntries(Object.entries(overrides).map(([key, v]) => [key, integer(v, key)])) };
  if (input.blueprintId !== undefined) {
    if (input.templateId !== undefined || input.templateRevision !== undefined || input.arch !== undefined) failure("Choose either a pinned blueprint or an image source.");
    result.blueprintId = machineIdentifier(input.blueprintId); result.blueprintRevision = text(input.blueprintRevision, "blueprint revision");
  } else {
    if (input.blueprintRevision !== undefined) failure("Blueprint revision requires a blueprint ID.");
    result.templateId = text(input.templateId, "template id");
  }
  if ("templateRevision" in input) result.templateRevision = text(input.templateRevision, "template revision");
  if (input.hostId != null) result.hostId = machineIdentifier(input.hostId);
  if (input.arch != null) { if (!["arm64", "amd64"].includes(String(input.arch))) failure("Invalid architecture."); result.arch = input.arch; }
  return result;
}

export function persistedOffer(value: unknown): Json | undefined {
  try { return validateOffer(JSON.parse(String(value))); }
  catch (error) { if (error instanceof ServiceError || error instanceof SyntaxError) return undefined; throw error; }
}

/** Shared legacy schema: hosts(id,credential,offer,seen,enabled), templates(id,
 * revision,arch,definition), machines(id,request,host,template,desired,observed,
 * detail,updated,owner,intent,preparation_hash,prepared_at,preparation_state,
 * access_ready). request.resources and template are JSON, observed is runtime
 * state; there are deliberately no alternate resources/state/image columns.
 * Initialization migrates the eight-column Python machines table in place.
 */
export function initializeMachines(db: DatabaseSync): void {
  initializeBlueprints(db);
  db.exec(`CREATE TABLE IF NOT EXISTS hosts (id TEXT PRIMARY KEY,credential TEXT NOT NULL,offer TEXT NOT NULL,seen REAL NOT NULL,enabled INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE IF NOT EXISTS machines (id TEXT PRIMARY KEY,request TEXT NOT NULL,host TEXT NOT NULL,template TEXT NOT NULL,desired TEXT NOT NULL,observed TEXT NOT NULL,detail TEXT NOT NULL,updated REAL NOT NULL);
    CREATE TABLE IF NOT EXISTS templates (id TEXT NOT NULL,revision TEXT NOT NULL,arch TEXT NOT NULL,definition TEXT NOT NULL,PRIMARY KEY(id,revision,arch));`);
  const columns = new Set(db.prepare("PRAGMA table_info(machines)").all().map(row => row.name));
  for (const [name, definition] of Object.entries({ owner: "TEXT", intent: "TEXT", preparation_hash: "TEXT", prepared_at: "REAL NOT NULL DEFAULT 0", preparation_state: "TEXT NOT NULL DEFAULT 'pending'", access_ready: "INTEGER" })) {
    if (!columns.has(name)) db.exec(`ALTER TABLE machines ADD COLUMN ${name} ${definition}`);
  }
  db.exec("UPDATE machines SET intent=request WHERE intent IS NULL");
  for (const row of db.prepare("SELECT offer FROM hosts").all()) {
    const offer = persistedOffer(row.offer);
    if (offer) registerTemplates(db, offer); // Opaque legacy inventory is retained, never admitted.
  }
}
export function visibleMachine(db: DatabaseSync, req: ControlRequest, id: string): MachineRow {
  const principal = req.principal();
  const row = db.prepare("SELECT * FROM machines WHERE id=?").get(machineIdentifier(id));
  if (!row || !owns(principal, row.owner)) return failure("Unknown machine.", 404);
  return row;
}
function registerTemplates(db: DatabaseSync, proposed: Json): void {
  for (const image of proposed.templates) {
    const previous = db.prepare("SELECT definition FROM templates WHERE id=? AND revision=? AND arch=?").get(image.id, image.revision, image.arch);
    if (previous && !equal(JSON.parse(String(previous.definition)), image)) failure("Template identity/revision already has a different definition. Publish a new revision.", 409);
    if (!previous) db.prepare("INSERT INTO templates VALUES (?,?,?,?)").run(image.id, image.revision, image.arch, JSON.stringify(image));
  }
}
function table(db: DatabaseSync, name: string): boolean { return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)); }
function record(db: DatabaseSync, name: string, machine: string): MachineRow | undefined {
  return table(db, name) ? db.prepare(`SELECT * FROM ${name} WHERE machine=?`).get(machine) : undefined;
}


/** Hooks run synchronously inside the SAME BEGIN IMMEDIATE transaction as host
 * authentication, observations and assignment delivery. Throwing rolls back the
 * entire heartbeat. Register before serving requests. Receipts must be handled
 * here by their owning module, never by another transaction after the heartbeat.
 * `heartbeatFields`/`reportFields` declare extension ownership; unhandled nonempty
 * extensions fail closed. reportMachine returning false preserves an assignment
 * that its cleanup owner says must ignore this observation.
 */
export interface MachineHooks {
  beforeTransaction?(db: DatabaseSync): void;
  heartbeatFields?: readonly string[];
  reportFields?: readonly string[];
  claimSetup?(db: DatabaseSync, token: string, hostId: string, offer: Json): boolean;
  validateOffer?(db: DatabaseSync, hostId: string, offer: Json): void;
  enrolled?(db: DatabaseSync, hostId: string, offer: Json): void;
  beforeHeartbeat?(db: DatabaseSync, hostId: string, body: Json): Json | void;
  reportMachine?(db: DatabaseSync, hostId: string, machineId: string, report: Json): boolean | void;
  afterHeartbeat?(db: DatabaseSync, hostId: string, body: Json): void;
  assignment?(db: DatabaseSync, machine: Json, forHost: boolean): Json;
  heartbeatResponse?(db: DatabaseSync, hostId: string, body: Json): Json;
  /** An owner or administrator changed a machine's desired state through the machine API. */
  desiredChanged?(db: DatabaseSync, machineId: string, state: "running" | "stopped"): void;
  /** SQL SELECT returning cpu, memoryMiB, diskGiB; one positional host parameter.
   * Required for mapped hosts; use a stable id across restarts. */
  additionalReservationsSql?: { id: string; query: string };
  additionalReservations?(db: DatabaseSync, hostId: string): Partial<Resources>;
}
const maintenance = new WeakMap<SqliteStore, HostMaintenance>();
const registeredHooks = new WeakMap<SqliteStore, MachineHooks[]>();
export function registerMachineHooks(store: SqliteStore, hooks: MachineHooks): void {
  if (hooks.additionalReservations) store.transaction(db => {
    PhysicalDomains.schema(db);
    const source = hooks.additionalReservationsSql;
    db.prepare("INSERT INTO physical_reservation_sources VALUES (?,?) ON CONFLICT(id) DO UPDATE SET query=excluded.query")
      .run(source?.id ?? "unsupported-hook", source?.query ?? null);
  });
  const current = registeredHooks.get(store) ?? []; current.push(hooks); registeredHooks.set(store, current);
}
export interface MachineStoreOptions { leaseSeconds?: number; hooks?: MachineHooks[] }

export class MachineStore implements ControlModule {
  readonly leaseSeconds: number;
  private readonly maintenance: HostMaintenance;
  constructor(readonly store: SqliteStore, readonly options: ControlOptions, settings: MachineStoreOptions = {}) {
    this.leaseSeconds = settings.leaseSeconds ?? 30;
    if (options.enrollmentToken !== undefined && secureEqual(options.adminToken, options.enrollmentToken)) failure("Admin and enrollment credentials must be different.");
    for (const hook of settings.hooks ?? []) registerMachineHooks(store, hook);
    store.transaction(db => { initializeMachines(db); initializeLifecycle(db); initializeInfrastructure(db); initializePressure(db); PhysicalDomains.schema(db); });
    this.maintenance = maintenance.get(store) ?? new HostMaintenance(store, options.browserHosts);
    maintenance.set(store, this.maintenance);
  }
  private get hooks(): MachineHooks[] { return [...(registeredHooks.get(this.store) ?? []), this.maintenance.hooks]; }
  private transaction<T>(operation: (db: DatabaseSync) => T): T {
    return this.store.transaction(db => { for (const hook of this.hooks) hook.beforeTransaction?.(db); return operation(db); });
  }
  private authenticate(db: DatabaseSync, id: string, credential: string): MachineRow {
    if (table(db, "retired_runners") && db.prepare("SELECT 1 FROM retired_runners WHERE id=?").get(id)) failure("This runtime identity was retired into its physical host.", 403);
    const host = db.prepare("SELECT * FROM hosts WHERE id=?").get(id);
    if (!host || !secureEqual(String(host.credential), machineDigest(credential))) return failure("Host credential rejected.", 401);
    return host;
  }
  authenticateHost(id: string, credential: string): void { this.transaction(db => { this.authenticate(db, machineIdentifier(id), credential); }); }
  promoteHost(id: string, body: Json, operatorToken: string): Json {
    if (!secureEqual(operatorToken, this.options.adminToken)) failure("Host migration requires the controller operator credential.", 403);
    id = machineIdentifier(id);
    fields(body, ["credential", "replacementCredential", "offer", "modelDomainId"]);
    const domain = body.modelDomainId === undefined ? undefined : machineIdentifier(body.modelDomainId);
    const previous = secret(body.credential), replacement = secret(body.replacementCredential);
    if (secureEqual(previous, replacement) || secureEqual(replacement, operatorToken)
      || (this.options.enrollmentToken && secureEqual(replacement, this.options.enrollmentToken))) failure("Generate a new dedicated host credential.");
    const proposed = validateOffer(body.offer);
    if (proposed.provider !== "macos" || !proposed.runtimes.includes("android") || proposed.leaseProtocol) failure("Migration requires a macOS host retaining its Android runtime.");
    return this.transaction(db => {
      const host = db.prepare("SELECT * FROM hosts WHERE id=?").get(id);
      if (!host || db.prepare("SELECT 1 FROM retired_runners WHERE id=?").get(id)) failure("Unknown host.", 404);
      const original = persistedOffer(host!.offer);
      if (secureEqual(String(host!.credential), machineDigest(replacement)) && original && equal(original, proposed)
        && (!domain || physicalMapping(db, { hostId: id })?.domainId === domain)) return { id, provider: proposed.provider };
      this.authenticate(db, id, previous);
      if (original?.provider !== "android" || original.leaseProtocol || host!.enabled || this.store.clock() - Number(host!.seen) < this.leaseSeconds) {
        failure("Drain and stop the Android runner, then wait for its heartbeat to expire before migration.", 409);
      }
      for (const row of db.prepare("SELECT * FROM machines WHERE host=?").all(id)) {
        if (isDeleted(db, String(row.id))) continue;
        if (computeReserved(db, { id: String(row.id), desired: String(row.desired), observed: String(row.observed) })) failure("Confirm all assigned machines stopped before migration.", 409);
        if (!proposed.templates.some((template: Json) => equal(template, JSON.parse(String(row.template))))) failure("Retain all assigned template definitions before migration.", 409);
      }
      if (table(db, "device_operations") && db.prepare("SELECT 1 FROM device_operations WHERE host=? AND state IN ('queued','running','unknown')").get(id)) {
        failure("Resolve pending or uncertain device operations before migration.", 409);
      }
      if (table(db, "image_tasks") && db.prepare("SELECT 1 FROM image_tasks WHERE host=? AND state IN ('queued','running','unknown')").get(id)) {
        failure("Resolve pending or uncertain image operations before migration.", 409);
      }
      validateCatalogueOffer(db, id, proposed);
      for (const hook of this.hooks) hook.validateOffer?.(db, id, proposed);
      registerTemplates(db, proposed);
      if (domain) new PhysicalDomains().attachForMigration(db, id, domain, proposed.capacity);
      db.prepare("UPDATE hosts SET offer=?, credential=? WHERE id=?").run(JSON.stringify(proposed), machineDigest(replacement), id);
      db.prepare("INSERT INTO host_health(host,report,received) VALUES (?,?,?) ON CONFLICT(host) DO UPDATE SET report=excluded.report,received=excluded.received")
        .run(id, JSON.stringify({ status: "checking", checkedAt: this.store.clock(), checks: [] }), this.store.clock());
      return { id, provider: proposed.provider };
    });
  }
  enroll(value: Json, token: string): Json {
    const id = machineIdentifier(value.id), credential = machineDigest(secret(value.credential)), offer = validateOffer(value.offer);
    return this.transaction(db => {
      const global = this.options.enrollmentToken !== undefined && secureEqual(token, this.options.enrollmentToken);
      if (!global && !this.hooks.some(hook => hook.claimSetup?.(db, token, id, offer))) claimSetup(db, token, id, offer, this.store.clock());
      // New fenced identities and retired runtime aliases cannot be adopted by legacy enrollment.
      if ((table(db, "runner_bindings") && db.prepare("SELECT 1 FROM runner_bindings WHERE runner=?").get(id)) || (table(db, "retired_runners") && db.prepare("SELECT 1 FROM retired_runners WHERE id=?").get(id))) failure("Host identity is already fenced or retired.", 403);
      const old = db.prepare("SELECT credential FROM hosts WHERE id=?").get(id);
      if (old) { if (!secureEqual(String(old.credential), credential)) failure("Host identity already exists with a different credential.", 403); return { id }; }
      validateCatalogueOffer(db, id, offer);
      for (const hook of this.hooks) hook.validateOffer?.(db, id, offer);
      registerTemplates(db, offer);
      db.prepare("INSERT INTO hosts(id,credential,offer,seen,enabled) VALUES (?,?,?,?,1)").run(id, credential, JSON.stringify(offer), this.store.clock());
      if (table(db, "host_limits")) db.prepare("INSERT OR IGNORE INTO host_limits VALUES (?,?)").run(id, JSON.stringify(offer.capacity));
      for (const hook of this.hooks) hook.enrolled?.(db, id, offer);
      return { id };
    });
  }
  private healthReady(db: DatabaseSync, id: string): boolean { return !hostAdmissionClosed(db, id).closed && healthReady(db, id, this.store.clock()); }
  used(db: DatabaseSync, hostId: string, exclude?: string): Resources {
    const physical = physicalBudget(db, { hostId }, exclude);
    if (physical) return physical.reserved;
    const used: Resources = { cpu: 0, memoryMiB: 0, diskGiB: 0 };
    for (const row of db.prepare("SELECT * FROM machines WHERE host=?").all(hostId)) {
      if (row.id === exclude || isDeleted(db, String(row.id))) continue;
      const size = machineResources(JSON.parse(String(row.request)).resources);
      used.diskGiB += size.diskGiB;
      if (computeReserved(db, { id: String(row.id), desired: String(row.desired), observed: String(row.observed) })) { used.cpu += size.cpu; used.memoryMiB += size.memoryMiB; }
    }
    if (table(db, "inference_jobs")) for (const row of db.prepare("SELECT definition FROM inference_jobs WHERE host=? AND state NOT IN ('succeeded','failed','cancelled')").all(hostId)) {
      const size = machineResources(JSON.parse(String(row.definition)).resources);
      for (const key of resourceKeys) used[key] += size[key];
    }
    if (table(db, "images")) {
      const artifacts = new Map<string, number>();
      for (const row of db.prepare("SELECT metadata FROM images WHERE host=?").all(hostId)) { const value = JSON.parse(String(row.metadata)); artifacts.set(`${value.sha256}:${value.format}`, value.bytes); }
      for (const size of artifacts.values()) used.diskGiB += Math.ceil(size / 1073741824);
    }
    if (table(db, "image_tasks")) used.diskGiB += Number(db.prepare("SELECT COALESCE(SUM(reserved_disk),0) AS n FROM image_tasks WHERE host=? AND state IN ('queued','running','unknown')").get(hostId)!.n);
    for (const hook of this.hooks) { const size = hook.additionalReservations?.(db, hostId); if (size) for (const key of resourceKeys) used[key] += size[key] ?? 0; }
    return used;
  }
  private limits(db: DatabaseSync, host: MachineRow): Resources {
    const row = table(db, "host_limits") ? db.prepare("SELECT limits FROM host_limits WHERE host=?").get(host.id!) : undefined;
    return row ? JSON.parse(String(row.limits)) : JSON.parse(String(host.offer)).capacity;
  }
  remainingCapacity(db: DatabaseSync, hostId: string, exclude?: string): Resources {
    const physical = physicalBudget(db, { hostId }, exclude);
    if (physical) return physical.available;
    const host = db.prepare("SELECT * FROM hosts WHERE id=?").get(hostId);
    if (!host) return failure("Unknown host.", 404);
    if (!persistedOffer(host.offer)) return { cpu: 0, memoryMiB: 0, diskGiB: 0 };
    const capacity = JSON.parse(String(host.offer)).capacity as Resources, limits = this.limits(db, host), used = this.used(db, hostId, exclude);
    return Object.fromEntries(resourceKeys.map(key => [key, Math.max(0, Math.min(capacity[key], limits[key]) - used[key])])) as unknown as Resources;
  }
  machine(db: DatabaseSync, row: MachineRow, online: boolean, forHost = false): Json {
    const image = JSON.parse(String(row.template)), required = (image.preparationDriver ?? "none") !== "none";
    let result: Json = { ...JSON.parse(String(row.request)), ownerId: row.owner, hostId: row.host, template: image, desired: row.desired, observed: online ? row.observed : "unknown", detail: row.detail, updatedAt: row.updated,
      preparation: { state: required ? row.preparation_state : "notRequired", completedAt: row.prepared_at || null }, guestConnectionReady: row.access_ready == null ? null : Boolean(row.access_ready) };
    result.ready = result.observed === "running" && (!required || Boolean(row.prepared_at)) && (!image.guestAccess || Boolean(row.access_ready));
    const mobile = ["android", "ios"].includes(image.os), guest = Boolean(image.guestAccess), graphical = (mobile || guest) && image.mode !== "headless";
    result.capabilities = { desktopStream: graphical, screenshot: graphical, files: mobile || guest, shell: image.os === "android" || guest, accessibility: graphical };
    result = lifecycleAssignment(db, { ...result, id: String(row.id) });
    for (const hook of this.hooks) result = hook.assignment?.(db, result, forHost) ?? result;
    return result;
  }
  hosts(req: Pick<ControlRequest, "principal">): Json[] {
    return this.transaction(db => {
      requireAdmin(req);
      return db.prepare("SELECT * FROM hosts ORDER BY id").all().filter(row => !(table(db, "retired_runners") && db.prepare("SELECT 1 FROM retired_runners WHERE id=?").get(row.id!))).map(row => {
        const offer = persistedOffer(row.offer), maintenance = this.maintenance.summary(db, String(row.id));
        if (!offer) return { id: row.id, name: row.id, provider: "unsupported", maintenance, online: false, enabled: Boolean(row.enabled), lastSeen: row.seen, placementReady: false, invalidOffer: true, detail: "Host offer is unsupported. Review any outstanding assignments and resources before cleanup.", templates: [], reserved: this.used(db, String(row.id)), capacity: { cpu: 0, memoryMiB: 0, diskGiB: 0 }, available: { cpu: 0, memoryMiB: 0, diskGiB: 0 } };
        const online = this.store.clock() - Number(row.seen) < this.leaseSeconds;
        const health = table(db, "host_health") ? db.prepare("SELECT * FROM host_health WHERE host=?").get(row.id!) : undefined;
        const sample = table(db, "resource_samples") ? db.prepare("SELECT * FROM resource_samples WHERE host=? ORDER BY captured DESC LIMIT 1").get(row.id!) : undefined;
        const report = health?.report ? JSON.parse(String(health.report)) : null;
        const system = report?.environment?.system;
        const platforms: Record<string, string> = { Darwin: "macos", Linux: "linux", Windows: "windows", apple: "macos", ios: "macos", hyperv: "windows", libvirt: "linux", macos: "macos", linux: "linux", windows: "windows" };
        const reserved = this.used(db, String(row.id)), limits = this.limits(db, row), physical = physicalBudget(db, { hostId: String(row.id) });
        return { ...offer, id: row.id, maintenance, online, enabled: Boolean(row.enabled), lastSeen: row.seen, reserved, ...(physical ? { physicalDomainId: physical.domainId, effectiveCapacity: physical.capacity } : {}), kind: "host", health: report ? { ...report, receivedAt: health!.received, fresh: this.store.clock() - Number(health!.received) < 120 } : null,
          platform: platforms[system] ?? platforms[offer.provider] ?? null, runtimes: [
            ...(offer.runtimes ?? [offer.provider]),
            ...(offer.inference || (physical && table(db, "model_runner_approvals")
              && db.prepare("SELECT 1 FROM model_runner_approvals WHERE domain=? AND revoked=0").get(physical.domainId)) ? ["inference"] : []),
            ...(offer.provider === "macos" && this.options.browserHosts?.includes(String(row.id)) ? ["browser"] : []),
          ], placementReady: online && Boolean(row.enabled) && this.healthReady(db, String(row.id)) && !pressureAdmission(db, String(row.id), this.store.clock()).blocked,
          pressure: pressureView(db, String(row.id), this.store.clock()),
          usage: sample ? { ...JSON.parse(String(sample.report)), receivedAt: sample.captured, fresh: online && this.store.clock() - Number(sample.captured) < 30 } : null,
          available: this.remainingCapacity(db, String(row.id)), limits, overcommitted: resourceKeys.some(key => reserved[key] > (physical?.capacity[key] ?? Math.min(offer.capacity[key], limits[key]))) };
      });
    });
  }
  templates(req: ControlRequest): Json[] {
    // The catalogue is readable by ordinary users; infrastructure inventory is admin-only.
    return this.transaction(db => {
      requireScope(req, "read"); const result: Json[] = [];
      for (const host of db.prepare("SELECT * FROM hosts ORDER BY id").all()) {
        if (table(db, "retired_runners") && db.prepare("SELECT 1 FROM retired_runners WHERE id=?").get(host.id!)) continue;
        const online = this.store.clock() - Number(host.seen) < this.leaseSeconds;
        const offer = persistedOffer(host.offer); if (!offer) continue;
        for (const image of offer.templates) result.push({ ...image, hostId: host.id, online, accepting: online && Boolean(host.enabled) && this.healthReady(db, String(host.id)) && !pressureAdmission(db, String(host.id), this.store.clock()).blocked });
      }
      return result;
    });
  }
  machines(req: ControlRequest): Json[] {
    return this.transaction(db => {
      const principal = requireScope(req, "read");
      return db.prepare("SELECT m.*,h.seen,h.offer AS host_offer FROM machines m JOIN hosts h ON m.host=h.id ORDER BY m.id").all().filter(row => !isDeleted(db, String(row.id)) && owns(principal, row.owner)).map(row => this.machine(db, row, !!persistedOffer(row.host_offer) && this.store.clock() - Number(row.seen) < this.leaseSeconds));
    });
  }
  create(value: Json, req: ControlRequest): Json {
    return this.transaction(db => {
      const principal = requireScope(req, "write");
      // Check ownership before comparing an existing receipt or parsing its specification.
      const id = machineIdentifier(value.id), old = db.prepare("SELECT * FROM machines WHERE id=?").get(id);
      if (old && !owns(principal, old.owner)) failure("Unknown machine.", 404);
      const request = validateMachineRequest(value);
      if (old) {
        if (!equal(JSON.parse(String(old.intent)), request)) failure("Request identity is already used for another specification.", 409);
        const host = db.prepare("SELECT seen,offer FROM hosts WHERE id=?").get(old.host!);
        return this.machine(db, old, !!host && !!persistedOffer(host.offer) && this.store.clock() - Number(host.seen) < this.leaseSeconds);
      }
      // A baseline carries its preparer's data, so only an administrator makes an account-owned device from one.
      return this.createMachine(db, request, false, principal.kind === "operator" ? null : principal.user?.id ?? null, principal.kind === "operator" || principal.user?.role === "admin");
    });
  }
  /** Transaction-local admission for generic leases. Caller authenticates the lease/application
   * and pins its member row in this same transaction. A lease never acquires user ownership. */
  createMachine(db: DatabaseSync, value: Json, leased = false, ownerId: string | null = null, baselines = leased): Json {
    if (!db.isTransaction) throw new TypeError("Machine admission requires the caller transaction.");
    const request = validateMachineRequest(value), id = request.id;
    if (leased && ownerId !== null) failure("Leased machines cannot acquire human ownership.", 409);
    const old = db.prepare("SELECT * FROM machines WHERE id=?").get(id);
    if (old) {
      if (leased && (old.owner != null || !record(db, "lease_members", id))) failure("Machine identity already belongs to another allocation.", 409);
      if (!equal(JSON.parse(String(old.intent)), request)) failure("Request identity is already used for another specification.", 409);
      const host = db.prepare("SELECT seen,offer FROM hosts WHERE id=?").get(old.host!);
      return this.machine(db, old, !!host && !!persistedOffer(host.offer) && this.store.clock() - Number(host.seen) < this.leaseSeconds);
    }
    if (leased && request.blueprintId) failure("Application leases require their approved image policy, not a machine blueprint.", 400);
    if (request.hostId) requireHostAdmission(db, request.hostId);
    const preset = request.blueprintId ? blueprint(db, request.blueprintId, request.blueprintRevision) : null;
    const candidates = this.placements(db, request, leased, baselines, preset);
    if (!candidates.length) failure("No online accepting host offers this template and enough unreserved capacity.", 409);
    if (!preset && !request.templateRevision && new Set(candidates.map(c => c.image.revision)).size > 1) failure("Multiple template revisions are available; choose templateRevision explicitly.", 409);
    const selected = candidates[0]!;

    db.prepare("INSERT INTO machines(id,request,host,template,desired,observed,detail,updated,intent,owner) VALUES (?,?,?,?,'running','pending','',?,?,?)").run(id, JSON.stringify({ ...request, ...(preset ? { templateId: selected.image.id, templateRevision: selected.image.revision, arch: selected.image.arch } : {}), resources: selected.size }), selected.host.id!, JSON.stringify(selected.image), this.store.clock(), JSON.stringify(request), ownerId);
    return this.machine(db, db.prepare("SELECT * FROM machines WHERE id=?").get(id)!, true);
  }
  /** Every host and image that would take this validated request, best first. This is the one
   * placement rule: host health, admission and eligibility, the image's minimum and memory step, a
   * usable baseline of the right data size, and unreserved capacity. Admission calls it as it is.
   * `spare` asks what would be placed if a host had that much more (or less) unreserved capacity,
   * for predicting an admission; it never changes what admission itself decides. */
  placements(db: DatabaseSync, request: Json, leased: boolean, baselines: boolean, preset: { image: Json; minimum: Resources; defaults: Resources } | null = null, spare?: (hostId: string) => Resources): { score: PlacementScore; host: MachineRow; image: Json; size: Resources }[] {
    const candidates: { score: PlacementScore; host: MachineRow; image: Json; size: Resources }[] = [];
    // Hosts that would have fitted but whose operator gates placement on pressure, and that are
    // under memory or disk pressure or have no current sample.
    const pressured = new Set<PressureCode>();
    for (const host of db.prepare("SELECT * FROM hosts WHERE enabled=1 ORDER BY id").all()) {
      if (!this.healthReady(db, String(host.id)) || this.store.clock() - Number(host.seen) >= this.leaseSeconds || (request.hostId ?? host.id) !== host.id || (table(db, "retired_runners") && db.prepare("SELECT 1 FROM retired_runners WHERE id=?").get(host.id!))) continue;
      const advertised = persistedOffer(host.offer); if (!advertised) continue;
      const reserved = this.used(db, String(host.id)), remaining = { ...this.remainingCapacity(db, String(host.id)) }, extra = spare?.(String(host.id));
      // A prediction treats the spare capacity as no longer reserved, for the fit and for the score alike.
      const used = extra ? Object.fromEntries(resourceKeys.map(key => [key, Math.max(0, reserved[key] - extra[key])])) as unknown as Resources : reserved;
      if (extra) for (const key of resourceKeys) remaining[key] += extra[key];
      const limits = this.limits(db, host), pressure = pressureAdmission(db, String(host.id), this.store.clock());
      const capacity = physicalBudget(db, { hostId: String(host.id) })?.capacity ?? Object.fromEntries(resourceKeys.map(key => [key, Math.min(advertised.capacity[key], limits[key])])) as unknown as Resources;
      for (const image of advertised.templates) {
        if (leased && !machineLeaseEligible(advertised, image)) continue;
        // No account-owned emulator runs beside tunnelled leases (see validateOffer).
        if (!leased && advertised.leaseTunnelProtocol === 1 && image.os === "android") continue;
        if (preset ? !equal(image, preset.image) : (image.id !== request.templateId || (request.arch ?? image.arch) !== image.arch || (request.templateRevision ?? image.revision) !== image.revision)) continue;
        const size = placementSize(image, request.resources, preset);
        if (!size) continue;
        // A baseline-backed image is placed only where the host stores that exact, unstale baseline,
        // saved with the data size this device would get. Leases reach it through their application's
        // allowlist; other callers need administrator authority.
        if (image.baseline && (!baselines || !baselineUsable(db, String(host.id), image, size.diskGiB))) continue;
        if (!resourceKeys.every(key => size[key] <= remaining[key])) continue;
        if (pressure.blocked) { pressured.add(pressure.code!); continue; }
        // Admission scores every fitting candidate as before. A prediction on an overcommitted host
        // can pass the clamped fit and still not be a valid reservation; it is then no candidate.
        if (!extra) candidates.push({ score: placementScore(capacity, used, size), host, image, size });
        else try { candidates.push({ score: placementScore(capacity, used, size), host, image, size }); } catch (error) { if (!(error instanceof ServiceError)) throw error; }
      }
    }
    if (!spare && !candidates.length && pressured.size) throw pressureRefusal(pressured, 409);
    return candidates.sort((a, b) => comparePlacementScore(a.score, b.score) || (String(a.host.id) < String(b.host.id) ? -1 : String(a.host.id) > String(b.host.id) ? 1 : 0));
  }
  enable(id: string, enabled: unknown, req: ControlRequest): Json {
    return this.transaction(db => {
      requireAdmin(req); id = machineIdentifier(id);
      if (typeof enabled !== "boolean") failure("enabled must be a boolean.");
      if (db.prepare("UPDATE hosts SET enabled=? WHERE id=?").run(enabled ? 1 : 0, id).changes !== 1) failure("Unknown host.", 404);
      return { id, enabled };
    });
  }
  desired(id: string, state: unknown, req: ControlRequest): Json {
    return this.transaction(db => {
      requireScope(req, "write"); const row = visibleMachine(db, req, id); id = String(row.id);
      if (state !== "running" && state !== "stopped") failure("Desired state must be running or stopped.");
      if (deletion(db, id)) failure("A machine with a deletion intent cannot change desired state.", 409);
      if (record(db, "lease_members", id)) failure("Lease-owned machines use lease lifecycle actions.", 409);
      requireNotPooled(db, id);
      if (state === "running" && pendingBaselineSave(db, id)) failure("Resolve the pending baseline save before restarting this device.", 409);
      if (state === "running" && row.desired !== "running") {
        requireHostAdmission(db, String(row.host));
        if (hasPendingPowerOff(db, id)) failure("Resolve the pending power-off intent before restarting.", 409);
        if (table(db, "image_tasks") && db.prepare("SELECT 1 FROM image_tasks WHERE machine=? AND state IN ('queued','running','unknown')").get(id)) failure("Resolve the pending image capture before restarting this machine.", 409);
        const host = db.prepare("SELECT * FROM hosts WHERE id=?").get(row.host!);
        if (!host || !persistedOffer(host.offer) || !host.enabled || !this.healthReady(db, String(row.host)) || this.store.clock() - Number(host.seen) >= this.leaseSeconds) failure("Assigned host is offline or draining.", 409);
        // Refused only when this host's operator opted into gating restarts on pressure.
        const pressure = pressureAdmission(db, String(row.host), this.store.clock(), "restart");
        if (pressure.blocked) throw pressureRefusal(new Set([pressure.code!]), 409);
        const remaining = this.remainingCapacity(db, String(row.host), id), size = machineResources(JSON.parse(String(row.request)).resources);
        if (!resourceKeys.every(key => size[key] <= remaining[key])) failure("Assigned host has insufficient unreserved capacity to restart.", 409);
      }
      db.prepare("UPDATE machines SET desired=? WHERE id=?").run(String(state), id);
      for (const hook of this.hooks) hook.desiredChanged?.(db, id, state as "running" | "stopped");
      const host = db.prepare("SELECT seen,offer FROM hosts WHERE id=?").get(row.host!);
      return this.machine(db, db.prepare("SELECT * FROM machines WHERE id=?").get(id)!, !!host && !!persistedOffer(host.offer) && this.store.clock() - Number(host.seen) < this.leaseSeconds);
    });
  }
  prepared(id: string, credential: string): Json {
    id = machineIdentifier(id);
    return this.transaction(db => {
      const row = db.prepare("SELECT preparation_hash,prepared_at FROM machines WHERE id=?").get(id);
      if (!row?.preparation_hash || !secureEqual(String(row.preparation_hash), machineDigest(credential))) failure("Preparation credential rejected.", 401);
      db.prepare("UPDATE machines SET preparation_state='ready',prepared_at=? WHERE id=?").run(Number(row!.prepared_at) || this.store.clock(), id);
      return { prepared: true };
    });
  }
  heartbeat(id: string, credential: string, value: Json): Json {
    id = machineIdentifier(id); const proposed = validateOffer(value.offer), reports = object(value.reports === undefined ? {} : value.reports);
    if (Object.keys(reports).length > 10000) failure("Invalid machine inventory.");
    return this.transaction(db => {
      const host = this.authenticate(db, id, credential);
      let previousProvider: unknown;
      try { previousProvider = object(JSON.parse(String(host.offer))).provider; } catch { /* An opaque legacy row has no usable provider contract. */ }
      if (previousProvider != null && previousProvider !== proposed.provider) failure("An enrolled runner cannot change provider; register a separate identity.", 409);
      const knownHeartbeatFields = new Set(["health", "resources", "installedImages", ...(table(db, "image_tasks") ? ["imageReports"] : []), ...(table(db, "inference_jobs") ? ["inferenceReports"] : []), ...this.hooks.flatMap(h => h.heartbeatFields ?? [])]);
      for (const field of ["health", "resources", "installedImages", "imageReports", "inferenceReports", "deviceReports"]) {
        const extension = value[field];
        if (extension != null && !(typeof extension === "object" && Object.keys(extension).length === 0) && !knownHeartbeatFields.has(field)) failure(`Heartbeat extension ${field} has no registered controller handler.`, 503);
      }
      let extra: Json = { checksRequestedAt: recordInfrastructure(db, id, value, this.store.clock()) };
      // Recorded before any admission in this transaction reads it.
      recordPressure(db, id, value.pressure, this.store.clock());
      recordHostImages(db, id, value.installedImages, this.store.clock(), (db, hostId, templates) => validateCatalogueOffer(db, hostId, { templates }));
      if (table(db, "image_tasks") && !this.hooks.some(h => h.heartbeatFields?.includes("imageReports"))) reportImageTasks(db, id, value.imageReports ?? {}, this.store.clock());
      validateCatalogueOffer(db, id, proposed);
      for (const hook of this.hooks) extra = { ...extra, ...hook.beforeHeartbeat?.(db, id, value) };
      for (const hook of this.hooks) hook.validateOffer?.(db, id, proposed);
      registerTemplates(db, proposed);
      for (const [mid, input] of Object.entries(reports)) {
        const machineId = machineIdentifier(mid), report = object(input);
        if (!["pending", "starting", "running", "stopping", "stopped", "error", "unknown"].includes(String(report.state))) failure("Invalid observed state.");
        const detail = report.detail === undefined ? "" : report.detail;
        if (typeof detail !== "string" || [...detail].length > 2000) failure("Invalid status detail.");
        const row = db.prepare("SELECT * FROM machines WHERE id=?").get(machineId);
        if (!row || row.host !== id) failure("Cannot report a machine assigned to another host.", 403);
        if (isDeleted(db, machineId)) continue;
        const knownReportFields = new Set(["powerOffId", "deletion", "leaseCleanup", ...this.hooks.flatMap(h => h.reportFields ?? [])]);
        for (const field of ["powerOffId", "deletion", "leaseCleanup", "leaseFenced"]) if (report[field] != null && !knownReportFields.has(field)) failure(`Machine receipt ${field} has no registered controller handler.`, 503);
        if (!reportLifecycle(db, id, machineId, report, this.store.clock())) continue;
        let ignore = false;
        for (const hook of this.hooks) if (hook.reportMachine?.(db, id, machineId, report) === false) { ignore = true; break; }
        if (ignore || isDeleted(db, machineId)) continue;
        db.prepare("UPDATE machines SET observed=?,detail=?,updated=? WHERE id=?").run(String(report.state), String(detail), this.store.clock(), machineId);
        if ("accessReady" in report) {
          if (typeof report.accessReady !== "boolean") failure("Invalid guest connection readiness.");
          db.prepare("UPDATE machines SET access_ready=? WHERE id=?").run(report.accessReady ? 1 : 0, machineId);
        } else if (report.state !== "running") db.prepare("UPDATE machines SET access_ready=CASE WHEN access_ready IS NULL THEN NULL ELSE 0 END WHERE id=?").run(machineId);
        if (report.preparation != null) recordPreparation(db, machineId, id, report.preparation, this.store.clock());
      }
      if (table(db, "inference_jobs") && !this.hooks.some(h => h.heartbeatFields?.includes("inferenceReports"))) reportInferenceJobs(db, id, value.inferenceReports ?? {}, this.store.clock());
      db.prepare("UPDATE hosts SET offer=?,seen=? WHERE id=?").run(JSON.stringify(proposed), this.store.clock(), id);
      for (const hook of this.hooks) hook.afterHeartbeat?.(db, id, value);
      const machines = db.prepare("SELECT * FROM machines WHERE host=?").all(id).filter(row => !isDeleted(db, String(row.id))).map(row => this.machine(db, row, true, true));
      if (table(db, "image_tasks")) extra = { ...extra, imageTasks: assignedImageTasks(db, id, row => this.machine(db, row as MachineRow, true, true)), imageAcknowledged: acknowledgedImages(db, id) };
      if (table(db, "inference_jobs")) extra.inferenceJobs = assignedInferenceJobs(db, id, this.store.clock());
      for (const hook of this.hooks) extra = { ...extra, ...hook.heartbeatResponse?.(db, id, value) };
      return { checksRequestedAt: 0, inferenceJobs: [], deviceOperations: [], accessSessions: [], imageTasks: [], imageAcknowledged: {}, ...extra, machines };
    });
  }
  handle(req: ControlRequest) {
    const { method, parts, body, token } = req;
    const maintenance = this.maintenance.handle(req, operation => this.transaction(operation));
    if (maintenance) return maintenance;
    if (method === "POST" && req.path === "/v1/hosts/enroll") return { body: this.enroll(body, token) };
    if (parts.length === 4 && parts[0] === "v1" && parts[1] === "hosts" && method === "POST") {
      if (parts[3] === "physical-domain") return { body: this.transaction(db => {
        requireAdmin(req); fields(body, ["domainId"]);
        return new PhysicalDomains().map(db, machineIdentifier(parts[2]!), machineIdentifier(body.domainId));
      }) };
      if (parts[3] === "heartbeat") return { body: this.heartbeat(parts[2]!, token, body) };
      if (parts[3] === "promote-macos") return { body: this.promoteHost(parts[2]!, body, token) };
      if (parts[3] === "accepting") return { body: this.enable(parts[2]!, body.enabled, req) };
    }
    if (method === "GET" && req.path === "/v1/hosts") return { body: { hosts: this.hosts(req) } };
    if (method === "GET" && req.path === "/v1/templates") return { body: { templates: this.templates(req) } };
    if (req.path === "/v1/machines") {
      if (method === "GET") return { body: { machines: this.machines(req) } };
      if (method === "POST") return { body: this.create(body, req) };
    }
    if (method === "GET" && parts.length === 3 && parts[0] === "v1" && parts[1] === "machines") return { body: this.transaction(db => {
      requireScope(req, "read"); const row = visibleMachine(db, req, parts[2]!);
      if (isDeleted(db, String(row.id))) failure("Unknown machine.", 404);
      const host = db.prepare("SELECT seen,offer FROM hosts WHERE id=?").get(row.host!);
      return this.machine(db, row, !!host && !!persistedOffer(host.offer) && this.store.clock() - Number(host.seen) < this.leaseSeconds);
    }) };
    if (method === "POST" && parts.length === 4 && parts[0] === "v1" && parts[1] === "machines") {
      const id = parts[2]!;
      if (parts[3] === "prepared") { if (!equal(body, { state: "ready" })) failure("Preparation receipts must report ready."); return { body: this.prepared(id, token) }; }
      if (parts[3] === "desired") { fields(body, ["state"]); return { body: this.desired(id, body.state, req) }; }
      if (parts[3] === "authorize") return { body: this.transaction(db => {
        fields(body, ["action"]);
        if (body.action !== "read" && body.action !== "write" && body.action !== "access") failure("Invalid authorization action.");
        requireScope(req, body.action as "read" | "write" | "access"); const row = visibleMachine(db, req, id);
        return { authorized: true, machineId: row.id, action: body.action };
      }) };
    }
    return undefined;
  }
}
export function createModule(store: SqliteStore, options: ControlOptions): ControlModule { return new MachineStore(store, options); }
