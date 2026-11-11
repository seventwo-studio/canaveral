import { ResourceDomains } from "../../src/resource-domains.ts";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SqliteStore } from "../../src/sqlite.ts";
import { ServiceError } from "../../src/errors.ts";
import { acknowledgedImages, assertNoPendingCapture, assignedImageTasks, createModule, ImagesController, reportImageTasks, validateCatalogueOffer } from "../../src/control/images.ts";
import type { ControlRequest, Principal } from "../../src/control/contracts.ts";

const admin: Principal = { kind: "operator", user: null, scopes: ["admin"] };
function request(path: string, method = "GET", body: Record<string, unknown> = {}, principal = admin, token = "human"): ControlRequest {
  return { path, parts: path.split("/").filter(Boolean), method, body, query: new URLSearchParams(), token, principal: () => principal };
}
const spec = (extra = {}) => ({ id: randomUUID(), name: "Reusable disk", os: "linux", arch: "amd64", mode: "desktop", mediaType: "disk", format: "raw", minimum: { cpu: 1, memoryMiB: 1024, diskGiB: 4 }, ...extra });
function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "images-controller-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new SqliteStore(join(root, "db"), () => 100), controller = new ImagesController(store);
  const host = randomUUID(), token = "host-credential", owner = randomUUID(), machine = randomUUID();
  store.transaction(db => {
    db.exec(`CREATE TABLE hosts(id TEXT PRIMARY KEY,credential TEXT,offer TEXT,seen REAL);
      CREATE TABLE retired_runners(id TEXT PRIMARY KEY);
      CREATE TABLE machines(id TEXT PRIMARY KEY,host TEXT,request TEXT,template TEXT,owner TEXT,desired TEXT,observed TEXT,prepared_at REAL);
      CREATE TABLE machine_deletions(machine TEXT,state TEXT);
      CREATE TABLE machine_power_offs(machine TEXT,state TEXT);
      CREATE TABLE lease_cleanup_members(machine TEXT,state TEXT);
      CREATE TABLE lease_members(machine TEXT);
      CREATE TABLE inference_jobs(host TEXT,state TEXT,definition TEXT);`);
    db.prepare("INSERT INTO hosts VALUES (?,?,?,?)").run(host, createHash("sha256").update(JSON.stringify(token)).digest("hex"), JSON.stringify({ provider: "libvirt", capacity: { cpu: 8, memoryMiB: 16384, diskGiB: 100 } }), 100);
    db.prepare("INSERT INTO machines VALUES (?,?,?,?,?,'stopped','stopped',0)").run(machine, host, JSON.stringify({ id: machine, resources: { cpu: 1, memoryMiB: 1024, diskGiB: 10 } }), JSON.stringify({ os: "linux" }), owner);
  });
  return { store, controller, host, token, owner, machine };
}
function fails(fn: () => unknown, status: number) { assert.throws(fn, e => e instanceof ServiceError && e.status === status); }

test("registry intent pins owned source before reserving bytes; retries cannot change it", t => {
  const { store, controller, host, token } = fixture(t), id = randomUUID();
  const intent = { id, hostId: host, registryId: "ubuntu-noble-cloud-amd64" };
  assert.equal(controller.createRegistryImport(intent).state, "queued");
  assert.equal(store.transaction(db => controller.ledger.used(db, host)).diskGiB, 10);
  const source = { url: "https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img", sha256: "a".repeat(64), bytes: 512, version: "fixture" };
  fails(() => controller.resolveRegistryImport(host, "wrong", id, source), 401);
  const resolved = controller.resolveRegistryImport(host, token, id, source);
  assert.deepEqual(controller.resolveRegistryImport(host, token, id, source), resolved);
  fails(() => controller.resolveRegistryImport(host, token, id, { ...source, sha256: "b".repeat(64) }), 409);
  assert.equal(store.transaction(db => controller.ledger.used(db, host)).diskGiB, 11);
  assert.equal(controller.createRegistryImport(intent).state, "running");
  fails(() => controller.createRegistryImport({ ...intent, registryId: "debian-stable-netinst-amd64" }), 409);
  const other = randomUUID(); controller.createRegistryImport({ ...intent, id: other });
  fails(() => controller.resolveRegistryImport(host, token, other, { ...source, bytes: 100 * 1_073_741_824 }), 409);
  assert.equal(store.transaction(db => controller.ledger.used(db, host)).diskGiB, 11);
  store.transaction(db => db.prepare("INSERT INTO retired_runners VALUES (?)").run(host));
  fails(() => controller.resolveRegistryImport(host, token, id, source), 401);
});

test("registry publication validates pinned digest/provenance and requires acknowledgement before offering", t => {
  const { store, controller, host, token } = fixture(t), id = randomUUID();
  controller.createRegistryImport({ id, hostId: host, registryId: "ubuntu-noble-cloud-amd64" });
  const source = { url: "https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img", sha256: "a".repeat(64), bytes: 512, version: "fixture" };
  const job = controller.resolveRegistryImport(host, token, id, source), metadata = job.metadata as Record<string, unknown>;
  const result = { ...metadata, id, kind: "base", revision: "1", sha256: source.sha256, bytes: 512, registry: { id: job.registryId, version: source.version, url: source.url, publisherSha256: source.sha256 } };
  const offer = { templates: [{ ...metadata, catalogueImageId: id, artifactSha256: source.sha256 }] };
  fails(() => store.transaction(db => validateCatalogueOffer(db, host, offer)), 409);
  fails(() => store.transaction(db => reportImageTasks(db, host, { [id]: { state: "succeeded", result: { ...result, sha256: "b".repeat(64) } } }, 101)), 409);
  assert.deepEqual(store.transaction(db => acknowledgedImages(db, host)), {});
  store.transaction(db => reportImageTasks(db, host, { [id]: { state: "succeeded", result } }, 101));
  assert.deepEqual(store.transaction(db => acknowledgedImages(db, host)), { [id]: source.sha256 });
  store.transaction(db => validateCatalogueOffer(db, host, offer));
  fails(() => store.transaction(db => validateCatalogueOffer(db, randomUUID(), offer)), 409);
  fails(() => store.transaction(db => reportImageTasks(db, randomUUID(), { [id]: { state: "failed" } }, 102)), 403);
  assert.equal(store.transaction(db => controller.ledger.used(db, host)).diskGiB, 11);
});

test("capture uncertainty retains reservations, blocks restart and never reassigns the unknown task", t => {
  const { store, controller, host, machine } = fixture(t), id = randomUUID(), intent = { id, machineId: machine, name: "Configured image" };
  assert.equal(controller.createCapture(intent).state, "queued");
  assert.equal(store.transaction(db => controller.ledger.used(db, host)).diskGiB, 21);
  fails(() => store.transaction(db => assignedImageTasks(db, host)), 503);
  const assigned = store.transaction(db => assignedImageTasks(db, host, row => ({ id: row.id, desired: row.desired, observed: row.observed })));
  assert.equal((assigned[0]!.machine as Record<string, unknown>).id, machine);
  fails(() => store.transaction(db => assertNoPendingCapture(db, machine)), 409);
  store.transaction(db => reportImageTasks(db, host, { [id]: { state: "unknown", result: { detail: "Fence exit unconfirmed" } } }, 101));
  assert.equal(store.transaction(db => controller.ledger.used(db, host)).diskGiB, 21);
  assert.deepEqual(store.transaction(db => assignedImageTasks(db, host)), []);
  // A later host assertion cannot automatically resolve an uncertain disk effect.
  store.transaction(db => reportImageTasks(db, host, { [id]: { state: "failed", result: {} } }, 102));
  assert.equal(controller.createCapture(intent).state, "unknown");
  fails(() => controller.createCapture({ ...intent, id: randomUUID() }), 409);
});

test("failed capture releases only image reservation; stale/still-running/unprepared sources fail closed", t => {
  const { store, controller, host, machine } = fixture(t), id = randomUUID();
  controller.createCapture({ id, machineId: machine, name: "Configured" });
  store.transaction(db => reportImageTasks(db, host, { [id]: { state: "failed", result: {} } }, 101));
  assert.equal(store.transaction(db => controller.ledger.used(db, host)).diskGiB, 10);
  store.transaction(db => assertNoPendingCapture(db, machine));
  const attempt = () => controller.createCapture({ id: randomUUID(), machineId: machine, name: "Configured" });
  store.transaction(db => db.prepare("UPDATE machines SET observed='running'").run()); fails(attempt, 409);
  store.transaction(db => { db.prepare("UPDATE machines SET observed='stopped',template=?").run(JSON.stringify({ os: "linux", guestAccess: true })); }); fails(attempt, 409);
  store.transaction(db => { db.prepare("UPDATE machines SET template=?").run(JSON.stringify({ os: "linux" })); db.prepare("UPDATE hosts SET seen=0").run(); }); fails(attempt, 409);
});

test("immutable aliases charge once per host/hash/format; report envelopes and field injection are rejected", t => {
  const { store, controller, host } = fixture(t);
  for (const [format, expected] of [["raw", 11], ["raw", 11], ["qcow2", 12]] as const) {
    const metadata = spec({ format }); controller.reserveImageImport(host, metadata, 512);
    controller.finishImageImport(metadata.id, host, { ...metadata, sha256: "a".repeat(64), bytes: 512, kind: "base", revision: "1" });
    assert.equal(store.transaction(db => controller.ledger.used(db, host)).diskGiB, expected);
    assert.equal(controller.finishImageImport(metadata.id, host, undefined, true).state, "succeeded");
  }
  fails(() => store.transaction(db => reportImageTasks(db, host, { [randomUUID()]: {}, [randomUUID()]: {} }, 100)), 400);
  fails(() => controller.reserveImageImport(host, spec({ image: "/private/path" }), 512), 400);
});

test("public routes preserve administrator boundary; capture checks current machine ownership", t => {
  const { store, controller, machine, owner, host, token } = fixture(t), module = createModule(store, { adminToken: "admin", controllerId: randomUUID() });
  const user: Principal = { kind: "token", user: { id: owner, username: "user", role: "user", status: "active" }, scopes: ["machines:read", "machines:write"] };
  for (const path of ["/v1/images", "/v1/image-tasks", "/v1/image-registry"]) fails(() => module.handle(request(path, "GET", {}, user)), 403);
  fails(() => module.handle(request("/v1/images/captures", "POST", { id: randomUUID(), machineId: machine, name: "capture" }, user)), 403);
  const intent = { id: randomUUID(), machineId: machine, name: "Owned capture" };
  controller.createCapture(intent, request("/internal", "POST", intent, user));
  const foreign = { ...user, user: { ...user.user!, id: randomUUID() } };
  fails(() => controller.createCapture(intent, request("/internal", "POST", intent, foreign)), 404);
  // Revocation is re-read inside the admission transaction, including retries.
  const revoked = request("/v1/image-registry/imports", "POST", { id: randomUUID(), registryId: "ubuntu-noble-cloud-amd64", hostId: host });
  let calls = 0; revoked.principal = () => { if (++calls > 1) throw new ServiceError("Revoked.", 401); return admin; };
  fails(() => module.handle(revoked), 401);
  const demoted = request("/v1/images/captures", "POST", { id: randomUUID(), machineId: machine, name: "Demoted retry" });
  let captureCalls = 0; demoted.principal = () => ++captureCalls === 1 ? admin : user;
  fails(() => module.handle(demoted), 403);
  const hostRequest = request("/v1/hosts/" + host + "/image-tasks/" + randomUUID() + "/resolve", "POST", {}, admin, token);
  hostRequest.principal = () => { throw new Error("Host route must not use human auth"); };
  fails(() => module.handle(hostRequest), 404);
  assert.equal(module.handle(request("/v1/unowned")), undefined);
});

test("image download reservations share disk headroom with bound runner jobs", t => {
  for (const imageFirst of [true, false]) {
    const f = fixture(t), domains = new ResourceDomains(() => 100), domain = randomUUID();
    f.store.transaction(db => {
      db.exec("ALTER TABLE hosts ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1");
      ResourceDomains.schema(db); domains.define(db, { id: domain, name: "shared", capacity: { cpu: 8, memoryMiB: 16384, diskGiB: 11 } }, 100);
      domains.bindHost(db, { hostId: f.host, domainId: domain }, 100);
    });
    const id = randomUUID(); f.controller.createRegistryImport({ id, hostId: f.host, registryId: "ubuntu-noble-cloud-amd64" });
    const source = { url: "https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img", sha256: "a".repeat(64), bytes: 512, version: "fixture" };
    const reserve = () => f.store.transaction(db => domains.reserve(db, { id: randomUUID(), domain, kind: "model-job", owner: randomUUID(), resources: { cpu: 1, memoryMiB: 1, diskGiB: 1 } }, 100));
    if (imageFirst) { f.controller.resolveRegistryImport(f.host, f.token, id, source); assert.equal(reserve(), false); }
    else { assert.equal(reserve(), true); fails(() => f.controller.resolveRegistryImport(f.host, f.token, id, source), 409); }
    assert.equal(f.store.transaction(db => domains.view(db, domain).reserved.diskGiB), 11);
  }
});
