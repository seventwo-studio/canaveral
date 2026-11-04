import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { identifier } from "./consumers.ts";
import type { Application, ApplicationSpec, ConsumerIdentities, Resources } from "./consumers.ts";
import type { Binding, RunnerEnrollment } from "./enrollment.ts";
import { object, secret, ServiceError } from "./errors.ts";
import { resources, ResourceDomains } from "./resource-domains.ts";
import type { SqliteStore } from "./sqlite.ts";

/** Execution backends that can host a Linux guest. The guest OS is always Linux. */
export const BACKENDS = ["kubevirt", "appleVirtualization"] as const;
export type Backend = typeof BACKENDS[number];
const CAPABILITIES = ["command", "pty", "files", "screenshot", "displayStream", "input", "hierarchy"] as const;
type Capability = typeof CAPABILITIES[number];
/** Headless Linux supports only these; graphics/accessibility are denied, never substituted. */
const HEADLESS = ["command", "pty", "files"] as const;
const ACTIVE = ["provisioning", "ready"];
const RUNTIME = ["starting", "running", "stopped", "unknown"] as const;
const CLEANUP = ["pending", "running", "blocked", "complete"] as const;
const FAILURE = ["provisioning", "runtime"] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const MAX_ACTIVE_ASSIGNMENTS = 32;
const keys = ["cpu", "memoryMiB", "diskGiB"] as const;

interface ImageRow { id: string; revision: string; arch: string; backend: Backend; digest: string; resources: string; capabilities: string }
interface ApprovalRow { controller: string; runner: string; generation: number; incarnation: string; domain: string; backend: Backend; images: string; revoked: number }
interface LeaseRow {
  id: string; application: string; request: string; image_id: string; image_revision: string; arch: string; backend: Backend; digest: string;
  resources: string; capabilities: string; required: string; member: string; domain: string; reservation: string;
  state: string; runtime: string; cleanup: string; cleanup_id: string | null; revision: number;
  created: number; expires: number; max_expires: number; provision_deadline: number; credential: string | null;
}
interface AssignmentRow {
  id: string; claim: string; lease: string; controller: string; runner: string; generation: number; incarnation: string;
  sequence: number; report: string | null; observed_revision: number; stopped: number; storage_removed: number; credentials_erased: number; closed: number; created: number;
}
interface Receipt {
  leaseId: string; memberId: string; backend: Backend; imageDigest: string; observedRevision: number;
  runtimeState: typeof RUNTIME[number]; ready: { command: boolean; pty: boolean; files: boolean };
  failure: typeof FAILURE[number] | null; executionStopped: boolean; storageRemoved: boolean; credentialsErased: boolean;
  cleanup: typeof CLEANUP[number];
}

function exact(value: unknown, names: readonly string[], what: string, optional: readonly string[] = []): Record<string, unknown> {
  const input = object(value);
  if (names.some(key => !Object.hasOwn(input, key)) || Object.keys(input).some(key => !names.includes(key) && !optional.includes(key))) {
    throw new ServiceError(`Invalid ${what} fields.`, 400);
  }
  return input;
}
function text(value: unknown, what: string): string {
  if (typeof value !== "string" || !/\S/.test(value) || Array.from(value).length > 100) throw new ServiceError(`Invalid ${what}.`, 400);
  return value;
}
function positive(value: unknown, maximum: number, what: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > maximum) throw new ServiceError(`Invalid ${what}.`, 400);
  return value;
}
function arch(value: unknown): "arm64" | "amd64" {
  if (value !== "arm64" && value !== "amd64") throw new ServiceError("Architecture must be arm64 or amd64.", 400);
  return value;
}
function backend(value: unknown): Backend {
  if (!BACKENDS.includes(value as Backend)) throw new ServiceError("Backend must be kubevirt or appleVirtualization.", 400);
  return value as Backend;
}
function bool(value: unknown, what: string): boolean {
  if (typeof value !== "boolean") throw new ServiceError(`Invalid ${what}.`, 400);
  return value;
}
function oneOf<T extends string>(value: unknown, allowed: readonly T[], what: string): T {
  if (!allowed.includes(value as T)) throw new ServiceError(`Invalid ${what}.`, 400);
  return value as T;
}
function unsupported(): never {
  throw new ServiceError("Headless Linux leases support only command, pty and files.", 409, { code: "capability_unsupported" });
}
/** Requested capability names: unknown names are malformed; known graphics/access ones are unsupported. */
function capabilityList(value: unknown, what: string): Capability[] {
  if (!Array.isArray(value) || new Set(value).size !== value.length || value.some(c => !CAPABILITIES.includes(c as Capability))) {
    throw new ServiceError(`Invalid ${what}.`, 400);
  }
  return (value as Capability[]).slice().sort();
}
function utc(seconds: number): string { return new Date(seconds * 1000).toISOString(); }
function leaseHash(token: string): string { return createHash("sha256").update("linux-lease:" + token, "ascii").digest("hex"); }
function equalHex(a: string, b: string): boolean { return a.length === b.length && timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex")); }
function bindingOf(row: { controller: string; runner: string; generation: number; incarnation: string }): Binding {
  return { controllerId: row.controller, runnerId: row.runner, generation: row.generation, incarnationId: row.incarnation };
}
function sameBinding(row: { controller: string; runner: string; generation: number; incarnation: string }, b: Binding): boolean {
  return row.controller === b.controllerId && row.runner === b.runnerId && row.generation === b.generation && row.incarnation === b.incarnationId;
}
function imageKey(image: { id: string; revision: string; arch: string; digest: string }): string {
  return JSON.stringify([image.id, image.revision, image.arch, image.digest]);
}
/** Forward-only runtime: starting < running/unknown < stopped. */
function runtimeRank(state: string): number {
  return state === "pending" ? 0 : state === "starting" ? 1 : state === "stopped" ? 3 : 2;
}

function parseReceipt(value: unknown): Receipt {
  const r = exact(value, ["leaseId", "memberId", "backend", "imageDigest", "observedRevision", "runtimeState", "ready", "failure",
    "executionStopped", "storageRemoved", "credentialsErased", "cleanup"], "linux lease receipt");
  const ready = exact(r.ready, HEADLESS, "ready capabilities");
  if (typeof r.imageDigest !== "string" || !DIGEST.test(r.imageDigest)) throw new ServiceError("Invalid image digest.", 400);
  return {
    leaseId: identifier(r.leaseId), memberId: identifier(r.memberId), backend: backend(r.backend), imageDigest: r.imageDigest,
    observedRevision: positive(r.observedRevision, Number.MAX_SAFE_INTEGER, "observedRevision"),
    runtimeState: oneOf(r.runtimeState, RUNTIME, "runtimeState"),
    ready: { command: bool(ready.command, "ready.command"), pty: bool(ready.pty, "ready.pty"), files: bool(ready.files, "ready.files") },
    failure: r.failure === null ? null : oneOf(r.failure, FAILURE, "failure"),
    executionStopped: bool(r.executionStopped, "executionStopped"), storageRemoved: bool(r.storageRemoved, "storageRemoved"),
    credentialsErased: bool(r.credentialsErased, "credentialsErased"), cleanup: oneOf(r.cleanup, CLEANUP, "cleanup"),
  };
}
/** Fixed key order for exact replay comparison. */
function canonical(r: Receipt): string {
  return JSON.stringify([r.leaseId, r.memberId, r.backend, r.imageDigest, r.observedRevision, r.runtimeState,
    r.ready.command, r.ready.pty, r.ready.files, r.failure, r.executionStopped, r.storageRemoved, r.credentialsErased, r.cleanup]);
}

/** Headless Linux guest leases on explicitly approved kubevirt or Apple Virtualization runner
 * bindings. Admission, quota, placement, lifecycle, replay and runner reports each run in one
 * BEGIN IMMEDIATE transaction that re-verifies the caller and refreshes expiry first. VM resources
 * are reserved once, at admission, in the same ResourceDomains ledger model-job claims use, and
 * are held until positive bound stop, storage removal and guest-credential erasure evidence.
 */
export class LinuxLeases {
  readonly domains = new ResourceDomains();
  constructor(readonly store: SqliteStore, readonly applications: ConsumerIdentities, readonly runners: RunnerEnrollment | undefined) {
    store.transaction(db => {
      ResourceDomains.schema(db);
      db.exec(`CREATE TABLE IF NOT EXISTS linux_lease_images (id TEXT NOT NULL, revision TEXT NOT NULL, arch TEXT NOT NULL, backend TEXT NOT NULL, digest TEXT NOT NULL, resources TEXT NOT NULL, capabilities TEXT NOT NULL, created REAL NOT NULL, PRIMARY KEY(id,revision,arch));
        CREATE TABLE IF NOT EXISTS linux_lease_grants (application TEXT NOT NULL, image_id TEXT NOT NULL, image_revision TEXT NOT NULL, arch TEXT NOT NULL, digest TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0, created REAL NOT NULL, PRIMARY KEY(application,image_id,image_revision,arch));
        CREATE TABLE IF NOT EXISTS linux_lease_runner_approvals (controller TEXT NOT NULL, runner TEXT NOT NULL, generation INTEGER NOT NULL, incarnation TEXT NOT NULL, domain TEXT NOT NULL, backend TEXT NOT NULL, images TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0, created REAL NOT NULL, PRIMARY KEY(controller,runner,generation));
        CREATE TABLE IF NOT EXISTS linux_leases (id TEXT PRIMARY KEY, application TEXT NOT NULL, request TEXT NOT NULL, image_id TEXT NOT NULL, image_revision TEXT NOT NULL, arch TEXT NOT NULL, backend TEXT NOT NULL, digest TEXT NOT NULL, resources TEXT NOT NULL, capabilities TEXT NOT NULL, required TEXT NOT NULL, member TEXT NOT NULL UNIQUE, domain TEXT NOT NULL, reservation TEXT NOT NULL UNIQUE, state TEXT NOT NULL, runtime TEXT NOT NULL, cleanup TEXT NOT NULL, cleanup_id TEXT, revision INTEGER NOT NULL, created REAL NOT NULL, expires REAL NOT NULL, max_expires REAL NOT NULL, provision_deadline REAL NOT NULL, credential TEXT UNIQUE);
        CREATE INDEX IF NOT EXISTS linux_leases_application ON linux_leases(application,id);
        CREATE INDEX IF NOT EXISTS linux_leases_state ON linux_leases(state,domain,created);
        CREATE TABLE IF NOT EXISTS linux_lease_mutations (application TEXT NOT NULL, lease TEXT NOT NULL, action TEXT NOT NULL, id TEXT NOT NULL, request TEXT NOT NULL, result TEXT NOT NULL, PRIMARY KEY(application,lease,action,id));
        CREATE TABLE IF NOT EXISTS linux_lease_assignments (id TEXT PRIMARY KEY, claim TEXT NOT NULL UNIQUE, lease TEXT NOT NULL UNIQUE, controller TEXT NOT NULL, runner TEXT NOT NULL, generation INTEGER NOT NULL, incarnation TEXT NOT NULL, sequence INTEGER NOT NULL DEFAULT 0, report TEXT, observed_revision INTEGER NOT NULL DEFAULT 0, stopped INTEGER NOT NULL DEFAULT 0, storage_removed INTEGER NOT NULL DEFAULT 0, credentials_erased INTEGER NOT NULL DEFAULT 0, closed INTEGER NOT NULL DEFAULT 0, created REAL NOT NULL);
        CREATE INDEX IF NOT EXISTS linux_lease_assignments_binding ON linux_lease_assignments(controller,runner,generation,closed);`);
    });
  }

  private now(): number { return this.store.clock(); }
  private requireRunners(): RunnerEnrollment {
    if (!this.runners) throw new ServiceError("Runner lease work requires a configured controller identity.", 503, { retryable: false });
    return this.runners;
  }
  /** Lease-ledger transaction: expiry, provisioning deadlines and application revocation are applied first. */
  private transaction<T>(operation: (db: DatabaseSync, now: number) => T): T {
    return this.store.transaction(db => { const now = this.now(); this.refresh(db, now); return operation(db, now); });
  }

  // Operator configuration. Callers must have verified the administrator role.

  /** Immutable installed-image entry: one backend, one digest, fixed reservation size and headless capabilities. */
  image(value: unknown): unknown {
    const input = exact(value, ["id", "revision", "arch", "os", "mode", "backend", "digest", "resources", "capabilities"], "linux lease image");
    if (input.os !== "linux" || input.mode !== "headless") throw new ServiceError("Only headless Linux images are supported.", 400);
    if (typeof input.digest !== "string" || !DIGEST.test(input.digest)) throw new ServiceError("Images pin a sha256 digest.", 400);
    const capabilities = capabilityList(input.capabilities, "image capabilities");
    if (!capabilities.length) throw new ServiceError("Images declare at least one capability.", 400);
    if (capabilities.some(c => !(HEADLESS as readonly string[]).includes(c))) unsupported();
    const view = { id: text(input.id, "image id"), revision: text(input.revision, "image revision"), arch: arch(input.arch), os: "linux", mode: "headless",
      backend: backend(input.backend), digest: input.digest, resources: resources(input.resources), capabilities };
    return this.store.transaction(db => {
      const row = this.imageRow(db, view.id, view.revision, view.arch);
      if (row && (row.backend !== view.backend || row.digest !== view.digest || row.resources !== JSON.stringify(view.resources) || row.capabilities !== JSON.stringify(capabilities))) {
        throw new ServiceError("Image entry already exists with a different definition.", 409);
      }
      if (!row) db.prepare("INSERT INTO linux_lease_images VALUES (?,?,?,?,?,?,?,?)")
        .run(view.id, view.revision, view.arch, view.backend, view.digest, JSON.stringify(view.resources), JSON.stringify(capabilities), this.now());
      return view;
    });
  }

  grant(value: unknown, revoke = false): unknown {
    const input = exact(value, ["applicationId", "imageId", "revision", "arch", "digest"], "linux lease grant");
    const application = identifier(input.applicationId), id = text(input.imageId, "image id"), revision = text(input.revision, "image revision"), a = arch(input.arch);
    if (typeof input.digest !== "string" || !DIGEST.test(input.digest)) throw new ServiceError("Grants pin a sha256 digest.", 400);
    const digest = input.digest;
    return this.store.transaction(db => {
      const existing = db.prepare("SELECT digest,revoked FROM linux_lease_grants WHERE application=? AND image_id=? AND image_revision=? AND arch=?").get(application, id, revision, a) as { digest: string; revoked: number } | undefined;
      if (revoke) {
        if (!existing || existing.digest !== digest) throw new ServiceError("Unknown linux lease grant.", 404);
        db.prepare("UPDATE linux_lease_grants SET revoked=1 WHERE application=? AND image_id=? AND image_revision=? AND arch=?").run(application, id, revision, a);
        return { applicationId: application, imageId: id, revision, arch: a, digest, revoked: true };
      }
      if (!this.applications.active(db, application)) throw new ServiceError("Grants require an existing unrevoked application.", 404);
      const image = this.imageRow(db, id, revision, a);
      if (!image || image.digest !== digest) throw new ServiceError("Grants require the exact catalogued image digest.", 404);
      if (existing && (existing.revoked || existing.digest !== digest)) throw new ServiceError("Grant already exists with a different definition or was revoked.", 409);
      if (!existing) db.prepare("INSERT INTO linux_lease_grants VALUES (?,?,?,?,?,0,?)").run(application, id, revision, a, digest, this.now());
      return { applicationId: application, imageId: id, revision, arch: a, digest, revoked: false };
    });
  }

  /** Maps one current binding to one domain, one backend and the exact installed images it serves. */
  approve(value: unknown): unknown {
    const runners = this.requireRunners();
    const input = exact(value, ["binding", "domainId", "backend", "images"], "linux lease runner approval");
    const domain = identifier(input.domainId), kind = backend(input.backend);
    if (!Array.isArray(input.images) || input.images.length < 1 || input.images.length > 100) throw new ServiceError("Approve 1 to 100 images.", 400);
    const images = input.images.map(item => {
      const entry = exact(item, ["id", "revision", "arch", "digest"], "approved image");
      if (typeof entry.digest !== "string" || !DIGEST.test(entry.digest)) throw new ServiceError("Approved images pin a sha256 digest.", 400);
      return { id: text(entry.id, "image id"), revision: text(entry.revision, "image revision"), arch: arch(entry.arch), digest: entry.digest };
    }).sort((x, y) => imageKey(x) < imageKey(y) ? -1 : imageKey(x) > imageKey(y) ? 1 : 0);
    if (new Set(images.map(imageKey)).size !== images.length) throw new ServiceError("Approved images must be unique.", 400);
    return this.store.transaction(db => {
      const binding = runners.current(db, input.binding);
      if (!binding) throw new ServiceError("Approve only the current unrevoked runner binding.", 409);
      if (!this.domains.exists(db, domain)) throw new ServiceError("Unknown resource domain.", 404);
      for (const image of images) {
        const row = this.imageRow(db, image.id, image.revision, image.arch);
        if (!row || row.digest !== image.digest) throw new ServiceError("Approved images require exact catalog entries.", 404);
        if (row.backend !== kind) throw new ServiceError("An approved image belongs to a different backend.", 409);
      }
      const stored = JSON.stringify(images.map(imageKey));
      const row = db.prepare("SELECT * FROM linux_lease_runner_approvals WHERE controller=? AND runner=? AND generation=?").get(binding.controllerId, binding.runnerId, binding.generation) as unknown as ApprovalRow | undefined;
      if (row && (row.revoked || row.domain !== domain || row.backend !== kind || row.images !== stored || row.incarnation !== binding.incarnationId)) {
        throw new ServiceError("Runner approval already exists with a different definition or was revoked.", 409);
      }
      if (!row) db.prepare("INSERT INTO linux_lease_runner_approvals VALUES (?,?,?,?,?,?,?,0,?)").run(binding.controllerId, binding.runnerId, binding.generation, binding.incarnationId, domain, kind, stored, this.now());
      return { binding, domainId: domain, backend: kind, images, revoked: false };
    });
  }

  /** Stops new admission placement and claims. Existing assignments keep reservations and report authority. */
  revokeApproval(value: unknown): unknown {
    const input = exact(value, ["binding"], "linux lease runner approval");
    const b = exact(input.binding, ["controllerId", "runnerId", "generation", "incarnationId"], "binding");
    const binding = { controllerId: identifier(b.controllerId), runnerId: identifier(b.runnerId), generation: positive(b.generation, Number.MAX_SAFE_INTEGER, "generation"), incarnationId: identifier(b.incarnationId) };
    return this.store.transaction(db => {
      const changed = db.prepare("UPDATE linux_lease_runner_approvals SET revoked=1 WHERE controller=? AND runner=? AND generation=? AND incarnation=?")
        .run(binding.controllerId, binding.runnerId, binding.generation, binding.incarnationId);
      if (!changed.changes) throw new ServiceError("Unknown linux lease runner approval.", 404);
      return { binding, revoked: true };
    });
  }

  // Application routes (consumer HTTP contract subset).

  catalogue(token: string): unknown {
    return this.transaction(db => {
      const application = this.applications.verify(db, token);
      const rows = db.prepare(`SELECT i.* FROM linux_lease_images i JOIN linux_lease_grants g ON g.image_id=i.id AND g.image_revision=i.revision AND g.arch=i.arch AND g.digest=i.digest
        WHERE g.application=? AND g.revoked=0 ORDER BY i.id,i.revision,i.arch`).all(application.id) as unknown as ImageRow[];
      return { templates: rows.map(row => {
        const amount = JSON.parse(row.resources) as Resources;
        return { id: row.id, revision: row.revision, os: "linux", arch: row.arch, mode: "headless", minimum: amount, defaults: amount, memoryStepMiB: 1,
          available: this.placements(db, row).length > 0, capabilities: this.capabilities(row.capabilities), runtime: row.backend === "kubevirt" ? "kubevirt" : "apple" };
      }), limits: application.limits };
    });
  }

  acquire(token: string, value: unknown): { created: boolean; lease: unknown } {
    const input = exact(value, ["id", "templateId", "templateRevision", "arch"], "lease acquisition", ["name", "resources", "ttlSeconds", "requiredCapabilities"]);
    const id = identifier(input.id), imageId = text(input.templateId, "templateId"), revision = text(input.templateRevision, "templateRevision"), a = arch(input.arch);
    const name = input.name === undefined ? undefined : text(input.name, "name");
    const required = input.requiredCapabilities === undefined ? [] : capabilityList(input.requiredCapabilities, "requiredCapabilities");
    const overrides = input.resources === undefined ? {} : exact(input.resources, [], "resources", keys);
    for (const key of Object.keys(overrides)) positive(overrides[key], 1_048_576, key);
    return this.transaction((db, now) => {
      const application = this.applications.verify(db, token);
      const limits = application.limits;
      const ttl = positive(input.ttlSeconds ?? limits.defaultTTLSeconds, limits.maxTTLSeconds, "ttlSeconds");
      const image = this.imageRow(db, imageId, revision, a);
      const minimum = image ? JSON.parse(image.resources) as Resources : undefined;
      const amount = minimum ? { ...minimum, ...overrides } as Resources : undefined;
      const frozen = JSON.stringify({ templateId: imageId, templateRevision: revision, arch: a, name: name ?? null, resources: amount ?? null, ttlSeconds: ttl, requiredCapabilities: required });
      const existing = this.row(db, id);
      if (existing) {
        if (existing.application !== application.id) throw new ServiceError("Lease ID is already in use and cannot be taken over.", 409);
        if (existing.request !== frozen) throw new ServiceError("Lease ID already belongs to another acquisition.", 409);
        return { created: false, lease: this.view(db, existing) };
      }
      const grant = db.prepare("SELECT digest FROM linux_lease_grants WHERE application=? AND image_id=? AND image_revision=? AND arch=? AND revoked=0").get(application.id, imageId, revision, a) as { digest: string } | undefined;
      if (!image || !minimum || !amount || !grant || grant.digest !== image.digest) throw new ServiceError("Image is not permitted for this application.", 403);
      const offered = JSON.parse(image.capabilities) as string[];
      if (required.some(c => !offered.includes(c))) unsupported();
      for (const key of keys) if (amount[key] < minimum[key]) throw new ServiceError(`Requested ${key} is below the image minimum.`, 400);
      this.quota(db, application, amount);
      // Pinned placement: the first approved domain serving this exact image where the VM fits.
      const reservation = randomUUID();
      const domain = this.placements(db, image).find(d => this.domains.reserve(db, { id: reservation, domain: d, kind: "linux-lease", owner: id, resources: amount }, now));
      if (!domain) throw new ServiceError("No approved runner domain serving this image has capacity.", 503, { code: "capacity_unavailable", retryable: true });
      db.prepare(`INSERT INTO linux_leases VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'provisioning','pending','notRequested',NULL,1,?,?,?,?,NULL)`).run(
        id, application.id, frozen, imageId, revision, a, image.backend, image.digest, JSON.stringify(amount), image.capabilities, JSON.stringify(required),
        randomUUID(), domain, reservation, now, now + ttl, now + limits.maxLifetimeSeconds, now + limits.provisioningTimeoutSeconds);
      return { created: true, lease: this.view(db, this.row(db, id)!) };
    });
  }

  list(token: string, after: string | undefined): unknown {
    const cursor = after === undefined ? "" : identifier(after);
    return this.transaction(db => {
      const application = this.applications.verify(db, token);
      const rows = db.prepare("SELECT * FROM linux_leases WHERE application=? AND id>? ORDER BY id LIMIT 101").all(application.id, cursor) as unknown as LeaseRow[];
      return { leases: rows.slice(0, 100).map(row => this.view(db, row)), nextCursor: rows.length > 100 ? rows[99]!.id : null };
    });
  }

  inspect(token: string, id: string): unknown {
    return this.transaction(db => this.view(db, this.access(db, id, token).lease));
  }

  /** Owner-only explicit exchange: a fresh opaque key whose hash replaces (revokes) the previous one. */
  credential(token: string, id: string, value: unknown): unknown {
    exact(value, [], "credential exchange");
    return this.transaction(db => {
      const { lease } = this.access(db, id, token, true);
      if (!ACTIVE.includes(lease.state)) throw new ServiceError("Ended leases cannot issue credentials.", 410);
      const credential = randomBytes(32).toString("base64url");
      db.prepare("UPDATE linux_leases SET credential=? WHERE id=?").run(leaseHash(credential), lease.id);
      return { id: lease.id, credential };
    });
  }

  mutate(token: string, id: string, action: "renew" | "release", value: unknown): unknown {
    const input = exact(value, action === "renew" ? ["id", "expectedRevision", "ttlSeconds"] : ["id"], "lease mutation");
    const mutation = identifier(input.id);
    const request = JSON.stringify(action === "renew"
      ? { id: mutation, expectedRevision: positive(input.expectedRevision, Number.MAX_SAFE_INTEGER, "expectedRevision"), ttlSeconds: positive(input.ttlSeconds, 2 ** 31 - 1, "ttlSeconds") }
      : { id: mutation });
    return this.transaction((db, now) => {
      const { lease, application } = this.access(db, id, token);
      const old = db.prepare("SELECT request,result FROM linux_lease_mutations WHERE application=? AND lease=? AND action=? AND id=?").get(application.id, lease.id, action, mutation) as { request: string; result: string } | undefined;
      if (old) {
        if (old.request !== request) throw new ServiceError("Mutation ID already belongs to another request.", 409);
        return { mutation: JSON.parse(old.result) as unknown, lease: this.view(db, lease) };
      }
      if (action === "renew") {
        const ttl = positive(input.ttlSeconds, application.limits.maxTTLSeconds, "ttlSeconds");
        if (!ACTIVE.includes(lease.state)) throw new ServiceError("Ended leases cannot be renewed.", 409);
        if (input.expectedRevision !== lease.revision) throw new ServiceError("Lease revision changed.", 409);
        // Never shortens; capped by the lifetime fixed at admission.
        const expires = Math.max(lease.expires, Math.min(now + ttl, lease.max_expires));
        db.prepare("UPDATE linux_leases SET expires=?,revision=revision+1 WHERE id=?").run(expires, lease.id);
      } else this.end(db, lease, "released", now);
      const current = this.row(db, lease.id)!;
      const result = { id: mutation, state: current.state, revision: current.revision, expiresAt: utc(current.expires) };
      db.prepare("INSERT INTO linux_lease_mutations VALUES (?,?,?,?,?,?)").run(application.id, lease.id, action, mutation, request, JSON.stringify(result));
      return { mutation: result, lease: this.view(db, current) };
    });
  }

  // Runner routes. Every request carries `{binding, ...}` and the runner credential.

  claim(token: string, value: unknown): unknown {
    const runners = this.requireRunners();
    const input = exact(value, ["binding", "claimId"], "claim"), claim = identifier(input.claimId);
    return this.transaction((db, now) => {
      const b = runners.verify(db, token, input.binding);
      const previous = db.prepare("SELECT * FROM linux_lease_assignments WHERE claim=?").get(claim) as unknown as AssignmentRow | undefined;
      if (previous) {
        if (!sameBinding(previous, b)) throw new ServiceError("Claim ID belongs to another runner binding.", 409);
        return { assignment: this.assignmentView(db, previous, now) };
      }
      const approval = this.approval(db, b);
      if (!approval) throw new ServiceError("This runner binding has no Linux lease approval.", 403);
      const open = db.prepare("SELECT count(*) AS n FROM linux_lease_assignments WHERE controller=? AND runner=? AND generation=? AND closed=0").get(b.controllerId, b.runnerId, b.generation) as { n: number };
      if (Number(open.n) >= MAX_ACTIVE_ASSIGNMENTS) return { assignment: null };
      const served = new Set(JSON.parse(approval.images) as string[]);
      const queue = db.prepare(`SELECT l.* FROM linux_leases l WHERE l.state='provisioning' AND l.domain=? AND l.backend=?
        AND NOT EXISTS (SELECT 1 FROM linux_lease_assignments a WHERE a.lease=l.id) ORDER BY l.created, l.rowid`).all(approval.domain, approval.backend) as unknown as LeaseRow[];
      const next = queue.find(l => served.has(imageKey({ id: l.image_id, revision: l.image_revision, arch: l.arch, digest: l.digest })));
      if (!next) return { assignment: null };
      // Never accept execution without the admission reservation.
      if (!this.domains.held(db, next.reservation)) throw new ServiceError("Lease reservation state is unavailable.", 503, { retryable: false });
      const id = randomUUID();
      db.prepare("INSERT INTO linux_lease_assignments VALUES (?,?,?,?,?,?,?,0,NULL,0,0,0,0,0,?)").run(id, claim, next.id, b.controllerId, b.runnerId, b.generation, b.incarnationId, now);
      return { assignment: this.assignmentView(db, this.assignmentRow(db, id)!, now) };
    });
  }

  assignments(token: string, value: unknown): unknown {
    const runners = this.requireRunners();
    const input = exact(value, ["binding"], "assignment listing");
    return this.transaction((db, now) => {
      const b = runners.verify(db, token, input.binding);
      const rows = db.prepare("SELECT * FROM linux_lease_assignments WHERE controller=? AND runner=? AND generation=? AND incarnation=? AND closed=0 ORDER BY created,id")
        .all(b.controllerId, b.runnerId, b.generation, b.incarnationId) as unknown as AssignmentRow[];
      return { assignments: rows.map(row => this.assignmentView(db, row, now)) };
    });
  }

  report(token: string, value: unknown): unknown {
    const runners = this.requireRunners();
    const input = exact(value, ["binding", "assignmentId", "sequence", "receipt"], "report");
    const id = identifier(input.assignmentId), sequence = positive(input.sequence, Number.MAX_SAFE_INTEGER, "sequence");
    const r = parseReceipt(input.receipt), encoded = canonical(r);
    return this.transaction((db, now) => {
      const b = runners.verify(db, token, input.binding);
      const assignment = this.assignmentRow(db, id);
      if (!assignment) throw new ServiceError("Unknown assignment.", 404);
      if (!sameBinding(assignment, b)) throw new ServiceError("The assignment is bound to another runner binding.", 403);
      const lease = this.row(db, assignment.lease);
      if (!lease) throw new ServiceError("Assigned lease state is unavailable.", 503, { retryable: false });
      if (r.leaseId !== lease.id || r.memberId !== lease.member || r.backend !== lease.backend) throw new ServiceError("The receipt does not match the assignment.", 409);
      if (r.imageDigest !== lease.digest) throw new ServiceError("The receipt reports a different image digest.", 409, { code: "image_mismatch" });
      if (sequence === assignment.sequence) {
        if (assignment.report !== encoded) throw new ServiceError("A different receipt was already recorded at this sequence.", 409);
        return this.reportView(db, this.assignmentRow(db, id)!, now);
      }
      if (assignment.closed) throw new ServiceError("The assignment is closed; only the final receipt can be replayed.", 409);
      if (sequence !== assignment.sequence + 1) throw new ServiceError("Report sequence must advance by exactly one.", 409);
      if (r.observedRevision > lease.revision || r.observedRevision < assignment.observed_revision) throw new ServiceError("Observed revision is stale or from the future.", 409);
      if (runtimeRank(r.runtimeState) < runtimeRank(lease.runtime) || (lease.runtime === "stopped" && r.runtimeState !== "stopped")) throw new ServiceError("Runtime state cannot regress.", 409);
      const offered = JSON.parse(lease.capabilities) as string[];
      for (const c of HEADLESS) {
        if (r.ready[c] && (r.runtimeState !== "running" || !offered.includes(c))) throw new ServiceError("Ready capabilities require a running runtime and a catalogued capability.", 409);
      }
      if ((assignment.stopped && !r.executionStopped) || (assignment.storage_removed && !r.storageRemoved) || (assignment.credentials_erased && !r.credentialsErased) ||
          (lease.cleanup === "complete" && r.cleanup !== "complete")) throw new ServiceError("Cleanup evidence cannot be withdrawn.", 409);
      if (r.executionStopped && r.runtimeState !== "stopped") throw new ServiceError("Execution stop requires a stopped runtime.", 409);
      const active = ACTIVE.includes(lease.state);
      if (active && r.runtimeState === "stopped" && !r.failure) throw new ServiceError("An active lease cannot stop without a reported failure.", 409);
      if (r.failure === "provisioning" && active && lease.state !== "provisioning") throw new ServiceError("Provisioning failure after readiness must be reported as a runtime failure.", 409);
      // Lifecycle first: failure ends an active lease, positive readiness promotes provisioning.
      if (active && r.failure) this.end(db, lease, "failed", now);
      else if (lease.state === "provisioning" && r.runtimeState === "running" && (JSON.parse(lease.required) as Capability[]).every(c => (HEADLESS as readonly string[]).includes(c) && r.ready[c as typeof HEADLESS[number]])) {
        db.prepare("UPDATE linux_leases SET state='ready',revision=revision+1 WHERE id=?").run(lease.id);
      }
      const current = this.row(db, lease.id)!;
      const terminal = !ACTIVE.includes(current.state);
      if (!terminal && (r.cleanup !== "pending" || r.storageRemoved || r.credentialsErased)) throw new ServiceError("Cleanup cannot start while the lease is active.", 409);
      const complete = r.cleanup === "complete";
      if (complete && !(r.runtimeState === "stopped" && r.executionStopped && r.storageRemoved && r.credentialsErased)) {
        throw new ServiceError("Cleanup completion requires stopped runtime, execution stop, storage removal and credential erasure.", 409);
      }
      db.prepare("UPDATE linux_leases SET runtime=?,cleanup=? WHERE id=?").run(r.runtimeState, terminal ? r.cleanup : "notRequested", lease.id);
      db.prepare("UPDATE linux_lease_assignments SET sequence=?,report=?,observed_revision=?,stopped=?,storage_removed=?,credentials_erased=?,closed=? WHERE id=?")
        .run(sequence, encoded, r.observedRevision, r.executionStopped ? 1 : 0, r.storageRemoved ? 1 : 0, r.credentialsErased ? 1 : 0, complete ? 1 : 0, id);
      if (complete) this.domains.release(db, lease.reservation, lease.id, now);
      return this.reportView(db, this.assignmentRow(db, id)!, now);
    });
  }

  // Ledger internals.

  /** Expiry wins at now >= expiresAt; revoked applications release; provisioning deadlines fail. */
  private refresh(db: DatabaseSync, now: number): void {
    for (const lease of db.prepare("SELECT * FROM linux_leases WHERE state IN ('provisioning','ready')").all() as unknown as LeaseRow[]) {
      if (!this.applications.active(db, lease.application)) this.end(db, lease, "released", now);
      else if (now >= lease.expires) this.end(db, lease, "expired", now);
      else if (lease.state === "provisioning" && now >= lease.provision_deadline) this.end(db, lease, "failed", now);
    }
  }

  /** Terminal transition. Only a never-claimed lease is reclaimed immediately: this transaction excludes any claim. */
  private end(db: DatabaseSync, lease: LeaseRow, state: "released" | "expired" | "failed", now: number): void {
    if (!ACTIVE.includes(lease.state)) return;
    const claimed = !!db.prepare("SELECT 1 FROM linux_lease_assignments WHERE lease=?").get(lease.id);
    db.prepare("UPDATE linux_leases SET state=?,revision=revision+1,cleanup=?,cleanup_id=? WHERE id=?").run(state, claimed ? "pending" : "complete", randomUUID(), lease.id);
    if (!claimed) this.domains.release(db, lease.reservation, lease.id, now);
  }

  /** Active lease count and held reservations (including terminal-but-unreclaimed) bound admission. */
  private quota(db: DatabaseSync, application: Application, amount: Resources): void {
    const rows = db.prepare("SELECT state,resources,reservation FROM linux_leases WHERE application=?").all(application.id) as Array<{ state: string; resources: string; reservation: string }>;
    if (rows.filter(row => ACTIVE.includes(row.state)).length >= application.limits.activeLeases) throw new ServiceError("Application active lease limit exceeded.", 429);
    const used = { ...amount };
    for (const row of rows) {
      if (!this.domains.held(db, row.reservation)) continue;
      const held = JSON.parse(row.resources) as Resources;
      for (const key of keys) used[key] += held[key];
    }
    if (keys.some(key => used[key] > application.limits.resources[key])) throw new ServiceError("Application resource limit exceeded.", 429);
  }

  /** Domains with a current, unrevoked approval for this exact image and backend, in stable order. */
  private placements(db: DatabaseSync, image: ImageRow): string[] {
    const wanted = imageKey(image), domains = new Set<string>();
    for (const row of db.prepare("SELECT * FROM linux_lease_runner_approvals WHERE revoked=0 AND backend=? ORDER BY domain,runner").all(image.backend) as unknown as ApprovalRow[]) {
      if ((JSON.parse(row.images) as string[]).includes(wanted) && this.runners?.current(db, bindingOf(row))) domains.add(row.domain);
    }
    return [...domains];
  }

  private approval(db: DatabaseSync, b: Binding): ApprovalRow | undefined {
    return db.prepare("SELECT * FROM linux_lease_runner_approvals WHERE controller=? AND runner=? AND generation=? AND incarnation=? AND revoked=0")
      .get(b.controllerId, b.runnerId, b.generation, b.incarnationId) as unknown as ApprovalRow | undefined;
  }

  /** Application owner or that lease's current key. Other owners' leases look missing. */
  private access(db: DatabaseSync, id: string, token: string, applicationOnly = false): { lease: LeaseRow; application: Application } {
    const lease = this.row(db, identifier(id));
    let application: Application | undefined;
    try { application = this.applications.verify(db, token); } catch { application = undefined; }
    if (application) {
      if (!lease || lease.application !== application.id) throw new ServiceError("Unknown lease.", 404);
      return { lease, application };
    }
    let hash: string;
    try { hash = leaseHash(secret(token)); } catch { throw new ServiceError("Lease credential rejected.", 401); }
    if (!lease || !lease.credential || !equalHex(lease.credential, hash)) throw new ServiceError("Lease credential rejected.", 401);
    if (applicationOnly) throw new ServiceError("Only the owning application can exchange lease credentials.", 403);
    return { lease, application: this.owner(db, lease.application) };
  }
  private owner(db: DatabaseSync, id: string): Application {
    const row = db.prepare("SELECT specification,created FROM consumers WHERE id=? AND revoked=0").get(id) as { specification: string; created: number } | undefined;
    if (!row) throw new ServiceError("Lease credential rejected.", 401);
    return { ...JSON.parse(row.specification) as ApplicationSpec, revoked: false, createdAt: row.created };
  }

  private imageRow(db: DatabaseSync, id: string, revision: string, a: string): ImageRow | undefined {
    return db.prepare("SELECT * FROM linux_lease_images WHERE id=? AND revision=? AND arch=?").get(id, revision, a) as unknown as ImageRow | undefined;
  }
  private row(db: DatabaseSync, id: string): LeaseRow | undefined {
    return db.prepare("SELECT * FROM linux_leases WHERE id=?").get(id) as unknown as LeaseRow | undefined;
  }
  private assignmentRow(db: DatabaseSync, id: string): AssignmentRow | undefined {
    return db.prepare("SELECT * FROM linux_lease_assignments WHERE id=?").get(id) as unknown as AssignmentRow | undefined;
  }
  private capabilities(stored: string): Record<Capability, boolean> {
    const offered = JSON.parse(stored) as string[];
    return Object.fromEntries(CAPABILITIES.map(c => [c, offered.includes(c)])) as Record<Capability, boolean>;
  }

  /** Consumer view: lifecycle `state`, observed `runtimeState` and reclamation `cleanup` stay separate. */
  private view(db: DatabaseSync, lease: LeaseRow): unknown {
    const assignment = db.prepare("SELECT * FROM linux_lease_assignments WHERE lease=?").get(lease.id) as unknown as AssignmentRow | undefined;
    // A revoked or superseded binding cannot report: its runtime is unknown and its reservation stays held.
    const stale = !!assignment && !assignment.closed && !this.runners?.current(db, bindingOf(assignment));
    const runtime = stale ? "unknown" : lease.runtime;
    const capabilities = this.capabilities(lease.capabilities);
    const terminal = !ACTIVE.includes(lease.state);
    const member: Record<string, unknown> = {
      name: "primary", machineId: lease.member, state: runtime, ready: lease.state === "ready" && runtime === "running",
      capabilities, resources: JSON.parse(lease.resources) as unknown,
    };
    if (terminal && lease.cleanup_id) {
      member.cleanup = { id: lease.cleanup_id, state: lease.cleanup,
        reason: lease.cleanup === "complete" ? null : stale || lease.cleanup === "blocked" ? "recovery" : "execution_pending", attempts: 0, retryAt: null };
    }
    return { id: lease.id, state: lease.state, runtimeState: runtime, revision: lease.revision, createdAt: utc(lease.created), expiresAt: utc(lease.expires),
      cleanup: { state: terminal ? lease.cleanup : "notRequested" }, members: [member], capabilities };
  }
  private authorization(lease: LeaseRow, now: number): unknown {
    return { state: lease.state, revision: lease.revision, expiresAt: lease.expires, controllerNow: now };
  }
  private assignmentView(db: DatabaseSync, row: AssignmentRow, now: number): unknown {
    const lease = this.row(db, row.lease)!;
    return { id: row.id, claimId: row.claim, leaseId: lease.id, memberId: lease.member, domainId: lease.domain, sequence: row.sequence, closed: Boolean(row.closed),
      image: { id: lease.image_id, revision: lease.image_revision, arch: lease.arch, backend: lease.backend, digest: lease.digest },
      resources: JSON.parse(lease.resources) as unknown, capabilities: JSON.parse(lease.capabilities) as unknown, requiredCapabilities: JSON.parse(lease.required) as unknown,
      lease: this.authorization(lease, now), stopRequested: !ACTIVE.includes(lease.state) };
  }
  private reportView(db: DatabaseSync, row: AssignmentRow, now: number): unknown {
    const lease = this.row(db, row.lease)!;
    return { assignmentId: row.id, sequence: row.sequence, lease: this.authorization(lease, now), runtimeState: lease.runtime,
      cleanup: ACTIVE.includes(lease.state) ? "notRequested" : lease.cleanup, stopRequested: !ACTIVE.includes(lease.state),
      released: !this.domains.held(db, lease.reservation) };
  }
}
