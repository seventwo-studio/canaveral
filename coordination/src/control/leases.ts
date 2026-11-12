import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { Requests } from "../requests.ts";
import { ConsumerIdentities } from "../consumers.ts";
import { RunnerEnrollment } from "../enrollment.ts";
import { LinuxLeases } from "../linux-leases.ts";
import type { Application, ApplicationSpec } from "../consumers.ts";
import { object, secret, ServiceError } from "../errors.ts";
import type { SqliteStore } from "../sqlite.ts";
import type { ControlModule, ControlOptions, ControlRequest, ControlResponse } from "./contracts.ts";
import { MachineStore, machineDigest, machineIdentifier, machineImageRuntime, registerMachineHooks, validateMachineRequest } from "./machines.ts";
import { cleanupView, computeReserved, ensureLeaseCleanup, initializeLifecycle, isDeleted, leaseCleanup, refreshLeaseCleanup } from "./lifecycle.ts";
import { createModule as operationModule, initializeConsumerOperations, refreshConsumerOperations } from "./consumer-operations.ts";

export const ACTIVE = ["provisioning", "ready"];
export interface LegacyLeaseRow {
  id: string; consumer: string; request: string; state: string; revision: number;
  created: number; expires: number; provision_deadline: number; credential: string | null; cleanup: string;
}
export type LegacyMachineRow = Record<string, unknown>;
export type Capability = "command" | "pty" | "files" | "screenshot" | "displayStream" | "input" | "hierarchy";
const resourceKeys = ["cpu", "memoryMiB", "diskGiB"] as const;
export function legacyTable(db: DatabaseSync, name: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}
export function utc(seconds: number): string {
  const micros = Math.round(seconds * 1_000_000), whole = Math.floor(micros / 1_000_000), fraction = micros - whole * 1_000_000;
  return new Date(whole * 1000).toISOString().replace(".000Z", fraction ? `.${String(fraction).padStart(6, "0")}Z` : "Z");
}
export function sameJson(a: unknown, b: unknown): boolean { return machineDigest(a) === machineDigest(b); }
function positive(value: unknown, label: string, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > max) throw new ServiceError(`Invalid ${label}.`, 400);
  return value;
}
function equals(a: string, b: string): boolean {
  return a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
export function capabilities(image: Record<string, unknown>): Record<Capability, boolean> {
  const mobile = image.os === "android" || image.os === "ios", guest = Boolean(image.guestAccess);
  const shell = image.os === "android" || guest, display = (mobile || guest) && image.mode !== "headless";
  return { command: shell, pty: shell, files: mobile || guest, screenshot: display, displayStream: display, input: display, hierarchy: display };
}
/** Exact installed definition and explicit runtime selector; no host-wide inheritance. */
export function leaseEligible(offer: Record<string, unknown>, image: Record<string, unknown>): boolean {
  if (offer.leaseProtocol !== 1 || !Array.isArray(offer.templates) || !offer.templates.some(item => sameJson(item, image)) || !Array.isArray(offer.leaseImages)) return false;
  try {
    const reference = { id: image.id, revision: image.revision, arch: image.arch, runtime: machineImageRuntime(offer, image) };
    return offer.leaseImages.some(item => sameJson(item, reference));
  } catch { return false; }
}
function template(row: LegacyMachineRow): Record<string, unknown> { return object(typeof row.template === "string" ? JSON.parse(row.template) : row.template); }
function observedReady(db: DatabaseSync, row: LegacyMachineRow, now: number): boolean {
  const image = template(row), required = (image.preparationDriver ?? "none") !== "none";
  return now - Number(row.seen) < 30 && row.observed === "running" && (!required || Boolean(row.prepared_at)) &&
    (!image.guestAccess || Boolean(row.access_ready)) && !isDeleted(db, String(row.id)) &&
    !db.prepare("SELECT 1 FROM machine_deletions WHERE machine=?").get(String(row.id)) && !leaseCleanup(db, String(row.id));
}
/** SQL input: m.*, h.seen, h.enabled, h.offer AS host_offer. */
export function legacyMachineReady(db: DatabaseSync, row: LegacyMachineRow, now: number): boolean {
  const offer = row.host_offer ?? row.offer;
  return Boolean(row.enabled) && row.desired === "running" && observedReady(db, row, now) &&
    leaseEligible(object(typeof offer === "string" ? JSON.parse(offer) : offer), template(row));
}
export function initializeLeases(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS leases (id TEXT PRIMARY KEY,consumer TEXT NOT NULL,request TEXT NOT NULL,state TEXT NOT NULL,revision INTEGER NOT NULL,created REAL NOT NULL,expires REAL NOT NULL,provision_deadline REAL NOT NULL,credential TEXT,cleanup TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS lease_members (lease TEXT NOT NULL,name TEXT NOT NULL,machine TEXT NOT NULL UNIQUE,PRIMARY KEY(lease,name));
    CREATE TABLE IF NOT EXISTS lease_mutations (consumer TEXT NOT NULL,lease TEXT NOT NULL,action TEXT NOT NULL,id TEXT NOT NULL,request TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(consumer,lease,action,id));
    CREATE INDEX IF NOT EXISTS leases_consumer ON leases(consumer,state);`);
  initializeLifecycle(db);
  initializeConsumerOperations(db);
}
function leaseRow(db: DatabaseSync, id: string): LegacyLeaseRow | undefined {
  return db.prepare("SELECT * FROM leases WHERE id=?").get(id) as unknown as LegacyLeaseRow | undefined;
}
function credentialDigest(token: string): string {
  try { return machineDigest(secret(token)); } catch { throw new ServiceError("Lease credential rejected.", 401); }
}
/** Inspection/mutation accepts the owning application or current scoped lease key, even after termination. */
export function legacyLeaseAccess(db: DatabaseSync, leaseId: string, token: string, consumerOnly = false): LegacyLeaseRow {
  const id = machineIdentifier(leaseId), hash = credentialDigest(token), row = leaseRow(db, id);
  const consumer = db.prepare("SELECT id FROM consumers WHERE credential=? AND revoked=0").get(hash);
  if (consumer) {
    if (!row || row.consumer !== consumer.id) throw new ServiceError("Unknown lease.", 404);
    return row;
  }
  if (!consumerOnly && row?.credential && equals(row.credential, hash) && db.prepare("SELECT 1 FROM consumers WHERE id=? AND revoked=0").get(row.consumer)) return row;
  throw new ServiceError("Lease credential rejected.", 401);
}
/** Sessions/guest effects never accept application, operator, runner or another namespace's key. */
export function legacySessionLease(db: DatabaseSync, leaseId: string, token: string): LegacyLeaseRow {
  const row = leaseRow(db, machineIdentifier(leaseId)), hash = credentialDigest(token);
  if (!row?.credential || !equals(row.credential, hash) || !db.prepare("SELECT 1 FROM consumers WHERE id=? AND revoked=0").get(row.consumer)) throw new ServiceError("Lease credential rejected.", 401);
  return row;
}
export function endLegacyLease(db: DatabaseSync, row: LegacyLeaseRow, state: "expired" | "released" | "failed", now: number): void {
  if (!ACTIVE.includes(row.state)) return;
  db.prepare("UPDATE leases SET state=?,revision=revision+1,cleanup='pending' WHERE id=?").run(state, row.id);
  refreshConsumerOperations(db, now, row.id);
  for (const member of db.prepare("SELECT machine FROM lease_members WHERE lease=?").all(row.id)) {
    db.prepare("UPDATE machines SET desired='stopped' WHERE id=?").run(member.machine!);
    db.prepare("UPDATE device_operations SET state='failed',result=?,updated=? WHERE machine=? AND state='queued'")
      .run(JSON.stringify({ detail: "Lease ended before operation completion; any in-flight effects require inspection." }), now, member.machine!);
  }
  ensureLeaseCleanup(db, row.id, now);
}
/** Safe as an outer transaction hook, including during other module constructors. */
export function refreshLegacyLeases(db: DatabaseSync, now: number): void {
  if (!["leases", "lease_members", "consumers", "machines", "hosts", "lease_cleanup_members", "consumer_operations", "device_operations"].every(name => legacyTable(db, name))) return;
  for (const row of db.prepare("SELECT * FROM leases WHERE state IN ('provisioning','ready')").all() as unknown as LegacyLeaseRow[]) {
    // Foreign/opaque experimental fixtures are not valid generic lease identities.
    try { if (machineIdentifier(row.id) !== row.id) continue; } catch { continue; }
    const consumer = db.prepare("SELECT revoked FROM consumers WHERE id=?").get(row.consumer);
    if (!consumer || consumer.revoked) { endLegacyLease(db, row, "released", now); continue; }
    if (now >= row.expires) { endLegacyLease(db, row, "expired", now); continue; }
    const members = db.prepare("SELECT m.*,h.seen FROM machines m JOIN lease_members lm ON lm.machine=m.id JOIN hosts h ON h.id=m.host WHERE lm.lease=?").all(row.id);
    if (members.some(m => m.observed === "error" || m.preparation_state === "failed") || (row.state === "provisioning" && now >= row.provision_deadline)) { endLegacyLease(db, row, "failed", now); continue; }
    if (row.state === "provisioning" && members.length && members.every(m => observedReady(db, m, now))) db.prepare("UPDATE leases SET state='ready',revision=revision+1 WHERE id=?").run(row.id);
  }
  refreshLeaseCleanup(db, now);
  refreshConsumerOperations(db, now);
}
/** Add to the host assignment, retaining the independent lifecycle cleanup fields. */
export function legacyLeaseAssignment<T extends { id: string }>(db: DatabaseSync, machine: T, now: number): T & { lease?: Record<string, unknown> } {
  const row = db.prepare("SELECT l.* FROM leases l JOIN lease_members lm ON lm.lease=l.id WHERE lm.machine=?").get(machine.id) as unknown as LegacyLeaseRow | undefined;
  return row ? { ...machine, lease: { id: row.id, state: row.state, revision: row.revision, authorizationDeadline: row.expires, controllerNow: now, cleanup: row.cleanup } } : machine;
}
export function legacyLeaseView(db: DatabaseSync, row: LegacyLeaseRow, now: number) {
  const members = db.prepare("SELECT m.*,h.seen,lm.name AS member_name FROM machines m JOIN lease_members lm ON lm.machine=m.id JOIN hosts h ON h.id=m.host WHERE lm.lease=? ORDER BY lm.name").all(row.id).map(m => {
    const cleanup = leaseCleanup(db, String(m.id));
    return { name: String(m.member_name), machineId: String(m.id), state: now - Number(m.seen) < 30 ? String(m.observed) : "unknown",
      ready: ACTIVE.includes(row.state) && observedReady(db, m, now), capabilities: capabilities(template(m)), resources: object(JSON.parse(String(m.request))).resources,
      ...(cleanup ? { cleanup: cleanupView(cleanup) } : {}) };
  });
  return { id: row.id, state: row.state, runtimeState: members.length === 1 ? members[0]!.state : "unknown", revision: row.revision,
    createdAt: utc(row.created), expiresAt: utc(row.expires), cleanup: { state: row.cleanup }, members,
    capabilities: members.length === 1 ? members[0]!.capabilities : {} };
}
/** Application quotas span both independently scheduled ledgers. Terminal reservations remain held. */
export function applicationLeaseUsage(db: DatabaseSync, applicationId: string): { active: number; resources: { cpu: number; memoryMiB: number; diskGiB: number } } {
  let active = 0;
  const resources = { cpu: 0, memoryMiB: 0, diskGiB: 0 };
  if (legacyTable(db, "leases")) active += Number(db.prepare("SELECT count(*) AS n FROM leases WHERE consumer=? AND state IN ('provisioning','ready')").get(applicationId)!.n);
  if (["leases", "lease_members", "machines"].every(name => legacyTable(db, name))) {
    for (const m of db.prepare("SELECT m.* FROM machines m JOIN lease_members lm ON lm.machine=m.id JOIN leases l ON l.id=lm.lease WHERE l.consumer=?").all(applicationId)) {
      if (isDeleted(db, String(m.id))) continue;
      const size = object(object(JSON.parse(String(m.request))).resources);
      resources.diskGiB += Number(size.diskGiB);
      if (computeReserved(db, { id: String(m.id), desired: String(m.desired), observed: String(m.observed) })) { resources.cpu += Number(size.cpu); resources.memoryMiB += Number(size.memoryMiB); }
    }
  }
  if (legacyTable(db, "linux_leases")) {
    for (const l of db.prepare("SELECT id,state,resources,reservation FROM linux_leases WHERE application=?").all(applicationId)) {
      if (ACTIVE.includes(String(l.state))) active++;
      const reservation = legacyTable(db, "resource_reservations") ? db.prepare("SELECT state,owner FROM resource_reservations WHERE id=?").get(l.reservation!) : undefined;
      // Only an exact released reservation proves reclamation; missing ownership fails closed.
      if (reservation?.state === "released" && reservation.owner === l.id) continue;
      const size = object(JSON.parse(String(l.resources)));
      for (const k of resourceKeys) resources[k] += Number(size[k]);
    }
  }
  return { active, resources };
}

/** One UUID-ordered page across both ledgers. Filtering happens before ordering and limiting. */
export function mergedLeasePage(db: DatabaseSync, applicationId: string, cursor: string, now: number, linuxView: (id: string) => unknown) {
  const sources: string[] = [], args: string[] = [];
  if (legacyTable(db, "leases")) { sources.push("SELECT id,'legacy' AS ledger FROM leases WHERE consumer=? AND id>?"); args.push(applicationId, cursor); }
  if (legacyTable(db, "linux_leases")) { sources.push("SELECT id,'linux' AS ledger FROM linux_leases WHERE application=? AND id>?"); args.push(applicationId, cursor); }
  if (!sources.length) return { leases: [], nextCursor: null };
  const rows = db.prepare(sources.join(" UNION ALL ") + " ORDER BY id LIMIT 101").all(...args);
  if (rows.some((row, index) => index && row.id === rows[index - 1]!.id)) throw new ServiceError("Lease identity is ambiguous across ledgers.", 409);
  return { leases: rows.slice(0, 100).map(row => row.ledger === "legacy" ? legacyLeaseView(db, leaseRow(db, String(row.id))!, now) : linuxView(String(row.id))),
    nextCursor: rows.length > 100 ? String(rows[99]!.id) : null };
}

function memberId(leaseId: string): string {
  const bytes = createHash("sha1").update(Buffer.from(leaseId.replaceAll("-", ""), "hex")).update("primary").digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50; bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  return machineIdentifier(bytes.toString("hex"));
}

const ACQUISITION_FIELDS = ["id", "name", "templateId", "templateRevision", "arch", "resources", "ttlSeconds", "requiredCapabilities"];
export class LegacyLeases implements ControlModule {
  readonly applications: ConsumerIdentities;
  readonly machines: MachineStore;
  readonly linux: LinuxLeases;
  readonly requests: Requests;
  private operations: ControlModule;
  constructor(readonly store: SqliteStore, readonly options: ControlOptions) {
    this.applications = new ConsumerIdentities(store);
    this.machines = new MachineStore(store, options);
    this.linux = new LinuxLeases(store, this.applications, new RunnerEnrollment(store, options.controllerId));
    store.transaction(initializeLeases);
    store.addTransactionHook(refreshLegacyLeases);
    store.transaction(db => refreshLegacyLeases(db, store.clock()));
    this.requests = new Requests(store, this.applications, (kind, app, intent) => {
      if (kind === "lease") this.acquireForApplication(app, intent);
      else this.linux.acquireForApplication(app, intent);
    }, (db, row, token) => {
      if (row.kind === "lease") this.mutation(db, row.id, token, "release", { id: row.id });
      else this.linux.mutate(token, row.id, "release", { id: row.id });
    }, (kind, intent) => {
      if (kind === "linux-lease") { this.linux.validateAcquisition(intent); return; }
      if (Object.keys(intent).some(k => !ACQUISITION_FIELDS.includes(k))) throw new ServiceError("Invalid lease acquisition.", 400);
      if (Object.hasOwn(intent, "resources")) object(intent.resources);
    });
    this.operations = operationModule(store, options);
    registerMachineHooks(store, {
      reportFields: ["leaseFenced"],
      beforeTransaction(db) { refreshLegacyLeases(db, store.clock()); },
      beforeHeartbeat(db) { refreshLegacyLeases(db, store.clock()); },
      reportMachine(db, _host, mid, report) {
        if (report.leaseFenced !== undefined && typeof report.leaseFenced !== "boolean") throw new ServiceError("Invalid lease fence receipt.", 400);
        if (report.leaseFenced === true) {
          const row = db.prepare("SELECT l.* FROM leases l JOIN lease_members lm ON lm.lease=l.id WHERE lm.machine=?").get(mid) as unknown as LegacyLeaseRow | undefined;
          if (row) endLegacyLease(db, row, "failed", store.clock());
        }
      },
      afterHeartbeat(db) { refreshLegacyLeases(db, store.clock()); },
      assignment(db, machine) { return legacyLeaseAssignment(db, machine as { id: string }, store.clock()); },
    });
  }
  acquire(token: string, value: unknown): ControlResponse {
    return this.acquireAuthorized(value, db => this.applications.verify(db, token));
  }
  /** Internal queue entry; shares every validation, reservation and lifecycle rule with direct acquisition. */
  acquireForApplication(application: string, value: unknown) {
    return this.acquireAuthorized(value, db => this.applications.admission(db, application));
  }
  private acquireAuthorized(value: unknown, authorize: (db: DatabaseSync) => Application) {
    const input = object(value);
    if (Object.keys(input).some(k => !ACQUISITION_FIELDS.includes(k))) throw new ServiceError("Invalid lease acquisition.", 400);
    const id = machineIdentifier(input.id);
    return this.store.transaction(db => {
      const app = authorize(db), limits = app.limits;
      this.linux.refreshAuthorization(db, this.store.clock());
      const ttl = positive(Object.hasOwn(input, "ttlSeconds") ? input.ttlSeconds : limits.defaultTTLSeconds, "lease TTL", limits.maxTTLSeconds);
      if (Object.hasOwn(input, "resources")) object(input.resources);
      const request = validateMachineRequest({ ...Object.fromEntries(Object.entries(input).filter(([k]) => !["ttlSeconds", "requiredCapabilities"].includes(k))), id: memberId(id), name: Object.hasOwn(input, "name") ? input.name : `lease-${id}` });
      if (!request.templateRevision || !request.arch) throw new ServiceError("Lease image revision and architecture must be explicit.", 400);
      const required = Object.hasOwn(input, "requiredCapabilities") ? input.requiredCapabilities : [], known = capabilities({ os: "linux", mode: "headless" });
      if (!Array.isArray(required) || required.some(k => typeof k !== "string" || !Object.hasOwn(known, k)) || new Set(required).size !== required.length) throw new ServiceError("Invalid required capabilities.", 400);
      const frozen = { machine: request, ttlSeconds: ttl, requiredCapabilities: [...required].sort() };
      const old = leaseRow(db, id);
      if (old) {
        if (old.consumer !== app.id) throw new ServiceError("Unknown lease.", 404);
        if (!sameJson(JSON.parse(old.request), frozen)) throw new ServiceError("Lease ID already belongs to another acquisition.", 409);
        return { body: legacyLeaseView(db, old, this.store.clock()) };
      }
      if (legacyTable(db, "linux_leases") && db.prepare("SELECT 1 FROM linux_leases WHERE id=?").get(id)) throw new ServiceError("Lease identity is already in use.", 409);
      const allowed = { id: request.templateId, revision: request.templateRevision, arch: request.arch };
      if (!app.templates.some(item => sameJson(item, allowed))) throw new ServiceError("Image is not permitted for this application.", 403);
      const imageRow = db.prepare("SELECT definition FROM templates WHERE id=? AND revision=? AND arch=?").get(String(allowed.id), String(allowed.revision), String(allowed.arch));
      if (!imageRow) throw new ServiceError("Permitted image revision is unavailable.", 503);
      const image = object(JSON.parse(String(imageRow.definition))), caps = capabilities(image);
      if ((required as Capability[]).some(k => !caps[k])) throw new ServiceError("Required capability is unsupported by this image.", 409, { code: "capability_unsupported" });
      const count = applicationLeaseUsage(db, app.id).active;
      if (count >= limits.activeLeases) throw new ServiceError("Application active lease limit exceeded.", 429);
      if (db.prepare("SELECT 1 FROM machines WHERE id=?").get(String(request.id))) throw new ServiceError("Lease machine identity already exists.", 409);
      try { this.machines.createMachine(db, request, true); }
      catch (error) {
        if (error instanceof ServiceError && error.message.startsWith("No online accepting host")) throw new ServiceError("No eligible lease-capable host has capacity.", 503, { code: "capacity_unavailable" });
        throw error;
      }
      const now = this.store.clock();
      db.prepare("INSERT INTO leases VALUES (?,?,?,'provisioning',1,?,?,?,?, 'notRequested')").run(id, app.id, JSON.stringify(frozen), now, now + ttl, now + limits.provisioningTimeoutSeconds, null);
      db.prepare("INSERT INTO lease_members VALUES (?,?,?)").run(id, "primary", String(request.id));
      const used = applicationLeaseUsage(db, app.id).resources;
      if (resourceKeys.some(k => used[k] > limits.resources[k])) throw new ServiceError("Application resource limit exceeded.", 429);
      return { status: 201, body: legacyLeaseView(db, leaseRow(db, id)!, now) };
    });
  }
  private catalogue(db: DatabaseSync, app: Application) {
    const templates = app.templates.flatMap(allowed => {
      const row = db.prepare("SELECT definition FROM templates WHERE id=? AND revision=? AND arch=?").get(allowed.id, allowed.revision, allowed.arch);
      if (!row) return [];
      const image = object(JSON.parse(String(row.definition)));
      const available = db.prepare("SELECT * FROM hosts WHERE enabled=1").all().some(host => {
        if (this.store.clock() - Number(host.seen) >= 30) return false;
        const health = legacyTable(db, "host_health") ? db.prepare("SELECT report,received FROM host_health WHERE host=?").get(host.id!) : undefined;
        if (health?.report && (this.store.clock() - Number(health.received) >= 120 || !["passed", "warning"].includes(object(JSON.parse(String(health.report))).status as string))) return false;
        return leaseEligible(object(JSON.parse(String(host.offer))), image);
      });
      return [{ ...image, available, capabilities: capabilities(image) }];
    });
    return { templates, limits: app.limits };
  }
  private mutation(db: DatabaseSync, id: string, token: string, action: "renew" | "release", value: Record<string, unknown>) {
    const fields = action === "renew" ? ["id", "expectedRevision", "ttlSeconds"] : ["id"];
    if (Object.keys(value).length !== fields.length || fields.some(k => !Object.hasOwn(value, k))) throw new ServiceError("Invalid lease mutation.", 400);
    const mutation = machineIdentifier(value.id), row = legacyLeaseAccess(db, id, token);
    const old = db.prepare("SELECT * FROM lease_mutations WHERE consumer=? AND lease=? AND action=? AND id=?").get(row.consumer, row.id, action, mutation);
    if (old) {
      if (!sameJson(JSON.parse(String(old.request)), value)) throw new ServiceError("Mutation ID already belongs to another request.", 409);
      return { mutation: JSON.parse(String(old.result)) as unknown, lease: legacyLeaseView(db, row, this.store.clock()) };
    }
    if (action === "renew") {
      const spec = JSON.parse(String(db.prepare("SELECT specification FROM consumers WHERE id=?").get(row.consumer)!.specification)) as ApplicationSpec;
      const ttl = positive(value.ttlSeconds, "lease TTL", spec.limits.maxTTLSeconds), revision = positive(value.expectedRevision, "lease revision", Number.MAX_SAFE_INTEGER);
      if (!ACTIVE.includes(row.state)) throw new ServiceError("Ended leases cannot be renewed.", 409);
      if (row.revision !== revision) throw new ServiceError("Lease revision changed.", 409);
      const expires = Math.max(row.expires, Math.min(this.store.clock() + ttl, row.created + spec.limits.maxLifetimeSeconds));
      db.prepare("UPDATE leases SET expires=?,revision=revision+1 WHERE id=?").run(expires, row.id);
    } else endLegacyLease(db, row, "released", this.store.clock());
    const current = leaseRow(db, id)!, result = { id: mutation, state: current.state, revision: current.revision, expiresAt: utc(current.expires) };
    db.prepare("INSERT INTO lease_mutations VALUES (?,?,?,?,?,?)").run(row.consumer, row.id, action, mutation, JSON.stringify(value), JSON.stringify(result));
    return { mutation: result, lease: legacyLeaseView(db, current, this.store.clock()) };
  }
  handle(req: ControlRequest): ControlResponse | undefined | Promise<ControlResponse | undefined> {
    if (req.parts[0] === "v1" && req.parts[1] === "requests") {
      if ([...req.query.keys()].some(k => k !== "after") || req.query.getAll("after").length > 1) throw new ServiceError("Only an after cursor is supported.",400);
      // Authenticate before any admission work so an invalid credential cannot drive passes.
      this.requests.authenticate(req.token);
      if (req.parts.length === 2 && req.method === "POST") {
        this.requests.pass();
        const result = this.requests.submit(req.token, req.body);
        this.requests.pass();
        return { status: result.created ? 201 : 200, body: this.requests.inspect(req.token,result.request.id) };
      }
      // Cancellation wins if still waiting when it obtains the SQLite write lock.
      if (req.parts.length === 4 && req.parts[3] === "cancel" && req.method === "POST") return { body: this.requests.cancel(req.token,req.parts[2]!,req.body) };
      this.requests.pass();
      if (req.parts.length === 2 && req.method === "GET") return { body:this.requests.list(req.token, req.query.get("after") ?? undefined) };
      if (req.parts.length === 3 && req.method === "GET") return { body:this.requests.inspect(req.token,req.parts[2]!) };
      throw new ServiceError("Unknown request route.",404);
    }
    if (req.path === "/v1/environments/templates" && req.method === "GET") {
      return this.store.transaction(db => {
        const app = this.applications.verify(db, req.token);
        // Linux images have a different backend/digest contract. A wholly Linux catalogue stays with that module.
        const catalogue = this.catalogue(db, app);
        if (!catalogue.templates.length) return db.prepare("SELECT 1 FROM linux_lease_images").get() ? undefined : { body: catalogue };
        const linux = object(this.linux.catalogue(req.token));
        const images = [...catalogue.templates, ...(Array.isArray(linux.templates) ? linux.templates : [])] as Record<string, unknown>[];
        const identities = images.map(image => JSON.stringify([image.id, image.revision, image.arch]));
        if (new Set(identities).size !== identities.length) throw new ServiceError("Image identity is ambiguous across lease ledgers.", 409);
        images.sort((a, b) => { for (const key of ["id", "revision", "arch"]) { const x = String(a[key]), y = String(b[key]); if (x !== y) return x < y ? -1 : 1; } return 0; });
        return { body: { templates: images, limits: catalogue.limits } };
      });
    }
    if (req.parts[0] !== "v1" || req.parts[1] !== "leases") return undefined;
    if (req.parts.length === 2) {
      if (req.method === "POST") {
        const id = machineIdentifier(req.body.id);
        const generic = this.store.transaction(db => {
          if (leaseRow(db, id)) return true;
          if (db.prepare("SELECT 1 FROM linux_leases WHERE id=?").get(id)) return false;
          const imageArgs = [String(req.body.templateId), String(req.body.templateRevision), String(req.body.arch)];
          const installed = db.prepare("SELECT 1 FROM templates WHERE id=? AND revision=? AND arch=?").get(...imageArgs);
          const linuxImage = db.prepare("SELECT digest FROM linux_lease_images WHERE id=? AND revision=? AND arch=?").get(...imageArgs);
          if (!linuxImage) return ["templateId", "templateRevision", "arch", "name"].some(k => Object.hasOwn(req.body, k));
          if (!installed) return false;
          const app = this.applications.verify(db, req.token);
          const genericAllowed = app.templates.some(image => image.id === req.body.templateId && image.revision === req.body.templateRevision && image.arch === req.body.arch);
          const linuxGrant = db.prepare("SELECT digest FROM linux_lease_grants WHERE application=? AND image_id=? AND image_revision=? AND arch=? AND revoked=0").get(app.id, ...imageArgs);
          const linuxAllowed = linuxGrant?.digest === linuxImage.digest;
          if (genericAllowed && linuxAllowed) throw new ServiceError("Image identity is ambiguous across lease ledgers.", 409);
          return genericAllowed || !linuxAllowed;
        });
        if (!generic) return undefined;
        return this.acquire(req.token, req.body);
      }
      if (req.method !== "GET") return undefined;
      return { body: this.linux.list(req.token, req.query.has("after") ? String(req.query.get("after")) : undefined) };
    }
    const id = machineIdentifier(req.parts[2]);
    // Route ownership is determined from identity, never from success/failure of authentication.
    if (!this.store.transaction(db => !!leaseRow(db, id))) return undefined;
    if (req.parts[3] === "operations") return this.operations.handle(req);
    return this.store.transaction(db => {
      const row = legacyLeaseAccess(db, id, req.token);
      if (req.parts.length === 3 && req.method === "GET") return { body: legacyLeaseView(db, row, this.store.clock()) };
      if (req.parts.length !== 4 || req.method !== "POST") return undefined;
      if (req.parts[3] === "credential") {
        legacyLeaseAccess(db, id, req.token, true);
        if (Object.keys(req.body).length) throw new ServiceError("Credential exchange requires an empty object.", 400);
        if (!ACTIVE.includes(row.state)) throw new ServiceError("Lease has ended.", 410);
        const token = randomBytes(32).toString("base64url");
        db.prepare("UPDATE leases SET credential=? WHERE id=?").run(machineDigest(token), id);
        refreshConsumerOperations(db, this.store.clock());
        return { body: { id, credential: token } };
      }
      if (req.parts[3] === "renew" || req.parts[3] === "release") return { body: this.mutation(db, id, req.token, req.parts[3], req.body) };
      return undefined;
    });
  }
}
export function createModule(store: SqliteStore, options: ControlOptions): ControlModule { return new LegacyLeases(store, options); }
