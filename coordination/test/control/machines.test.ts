import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { SqliteStore } from "../../src/sqlite.ts";
import { ServiceError } from "../../src/errors.ts";
import { Accounts } from "../../src/accounts.ts";
import type { ControlRequest, Principal } from "../../src/control/contracts.ts";
import { MachineStore, initializeMachines, machineDigest, machineLeaseEligible, registerMachineHooks, validateOffer, validateTemplate } from "../../src/control/machines.ts";
import { InfrastructureStore } from "../../src/control/infrastructure.ts";

type Json = Record<string, any>;
const token = () => randomBytes(32).toString("base64url");
const operator: Principal = { kind: "operator", user: null, scopes: ["admin"] };
const person = (id: string = randomUUID(), scopes = ["machines:read", "machines:write", "machines:access"], role: "user" | "admin" = "user"): Principal => ({ kind: "token", user: { id, username: id, role, status: "active" }, scopes });
function req(method = "GET", path = "/v1/machines", body: Json = {}, principal: Principal = operator): ControlRequest {
  return { method, path, parts: path.split("/").filter(Boolean), body, query: new URLSearchParams(), token: token(), principal: () => principal };
}
const image = (extra: Json = {}): Json => ({ id: "linux", revision: "1", os: "linux", arch: "amd64", mode: "headless", minimum: { cpu: 1, memoryMiB: 1024, diskGiB: 4 }, ...extra });
const offered = (extra: Json = {}): Json => ({ name: "host", provider: "libvirt", capacity: { cpu: 4, memoryMiB: 4096, diskGiB: 40 }, templates: [image()], ...extra });
const request = (extra: Json = {}): Json => ({ id: randomUUID(), name: "computer", templateId: "linux", resources: { cpu: 2, memoryMiB: 2048, diskGiB: 10 }, ...extra });
function fixture(t: TestContext, changes: Json = {}) {
  const folder = mkdtempSync(join(tmpdir(), "canaveral-machines-")); t.after(() => rmSync(folder, { recursive: true, force: true }));
  let now = 1000;
  const store = new SqliteStore(join(folder, "state.sqlite"), () => now);
  const options = { adminToken: token(), enrollmentToken: token(), controllerId: randomUUID() };
  const machines = new MachineStore(store, options), id = randomUUID(), credential = token(), offer = offered(changes);
  machines.enroll({ id, credential, offer }, options.enrollmentToken);
  const heartbeat = (reports: Json = {}, extra: Json = {}) => machines.heartbeat(id, credential, { offer, reports, ...extra });
  return { store, machines, options, id, credential, offer, heartbeat, advance: (seconds: number) => { now += seconds; } };
}
function error(status: number) { return (value: unknown) => value instanceof ServiceError && value.status === status; }

test('placement balances CPU pressure as well as memory and keeps replay pinned', t => {
  const f = fixture(t, { capacity: { cpu: 10, memoryMiB: 16384, diskGiB: 100 } });
  const other = randomUUID();
  f.machines.enroll({ id: other, credential: token(), offer: f.offer }, f.options.enrollmentToken);
  f.machines.create(request({ hostId: f.id, resources: { cpu: 7, memoryMiB: 1024, diskGiB: 4 } }), req());
  f.machines.create(request({ hostId: other, resources: { cpu: 1, memoryMiB: 4096, diskGiB: 4 } }), req());
  const value = request({ resources: { cpu: 1, memoryMiB: 1024, diskGiB: 4 } });
  const placed = f.machines.create(value, req());
  assert.equal(placed.hostId, other, 'less RAM use must not hide CPU saturation');
  f.machines.enable(other, false, req());
  assert.equal(f.machines.create(value, req()).hostId, other, 'replay cannot move an existing assignment');
});

test('placement normalizes by configured limits rather than raw hardware capacity', t => {
  const f = fixture(t, { capacity: { cpu: 16, memoryMiB: 16384, diskGiB: 100 } });
  const other = randomUUID();
  f.machines.enroll({ id: other, credential: token(), offer: f.offer }, f.options.enrollmentToken);
  f.store.transaction(db => {
    db.exec('CREATE TABLE IF NOT EXISTS host_limits (host TEXT PRIMARY KEY,limits TEXT NOT NULL)');
    db.prepare('INSERT INTO host_limits VALUES (?,?) ON CONFLICT(host) DO UPDATE SET limits=excluded.limits').run(f.id, JSON.stringify({ cpu: 2, memoryMiB: 2048, diskGiB: 20 }));
  });
  assert.equal(f.machines.create(request({ resources: { cpu: 1, memoryMiB: 1024, diskGiB: 4 } }), req()).hostId, other);
});

test("create replay pins defaults and allocation through new revisions and restart", t => {
  const f = fixture(t), value = request({ resources: {} });
  const first = f.machines.create(value, req());
  assert.deepEqual(first.resources, { cpu: 1, memoryMiB: 1024, diskGiB: 4 });
  f.offer.templates = [image({ revision: "2", defaults: { cpu: 3, memoryMiB: 3072, diskGiB: 12 } })];
  f.heartbeat();
  const reopened = new MachineStore(f.store, f.options);
  assert.deepEqual(reopened.create(value, req()).resources, first.resources);
  assert.equal(reopened.create(value, req()).template.revision, "1");
  assert.throws(() => reopened.create({ ...value, name: "different" }, req()), error(409));
  assert.equal(reopened.machines(req()).length, 1);
});

test("expired hosts retain assignments and reservations and do not report stale readiness", t => {
  const f = fixture(t), vm = f.machines.create(request(), req());
  f.heartbeat({ [vm.id]: { state: "running" } }); f.advance(30);
  assert.equal(f.machines.hosts(req())[0]!.online, false);
  assert.equal(f.machines.machines(req())[0]!.observed, "unknown");
  assert.equal(f.machines.machines(req())[0]!.ready, false);
  assert.deepEqual(f.machines.hosts(req())[0]!.reserved, vm.resources);
  assert.throws(() => f.machines.create(request(), req()), error(409));
  const other = randomUUID(); f.machines.enroll({ id: other, credential: token(), offer: f.offer }, f.options.enrollmentToken);
  assert.equal(f.machines.machines(req())[0]!.hostId, vm.hostId);
});

test("stop holds compute until confirmation and keeps disk; restart checks available capacity", t => {
  const f = fixture(t), a = f.machines.create(request(), req()), b = f.machines.create(request(), req());
  f.machines.desired(a.id, "stopped", req());
  assert.throws(() => f.machines.create(request(), req()), error(409));
  f.heartbeat({ [a.id]: { state: "stopped" } });
  const c = f.machines.create(request(), req());
  assert.throws(() => f.machines.desired(a.id, "running", req()), error(409));
  f.heartbeat({ [b.id]: { state: "stopped" }, [c.id]: { state: "stopped" } });
  f.machines.desired(b.id, "stopped", req()); f.machines.desired(c.id, "stopped", req());
  assert.deepEqual(f.machines.hosts(req())[0]!.reserved, { cpu: 0, memoryMiB: 0, diskGiB: 30 });
  assert.throws(() => f.machines.create(request({ resources: { cpu: 1, memoryMiB: 1024, diskGiB: 20 } }), req()), error(409));
});

test("enrollment, runner and guest credentials cannot cross roles or report another host", t => {
  const f = fixture(t), vm = f.machines.create(request(), req());
  assert.throws(() => f.machines.enroll({ id: randomUUID(), credential: token(), offer: f.offer }, f.options.adminToken), error(401));
  assert.throws(() => f.machines.enroll({ id: f.id, credential: token(), offer: f.offer }, f.options.enrollmentToken), error(403));
  assert.deepEqual(f.machines.enroll({ id: f.id, credential: f.credential, offer: f.offer }, f.options.enrollmentToken), { id: f.id });
  const other = randomUUID(), otherToken = token(); f.machines.enroll({ id: other, credential: otherToken, offer: f.offer }, f.options.enrollmentToken);
  assert.throws(() => f.machines.heartbeat(other, otherToken, { offer: f.offer, reports: { [vm.id]: { state: "running" } } }), error(403));
  assert.throws(() => f.machines.heartbeat(f.id, f.options.adminToken, { offer: f.offer }), error(401));
  assert.throws(() => f.machines.prepared(vm.id, f.credential), error(401));
  assert.equal(JSON.stringify(f.machines.hosts(req())).includes(f.credential), false);
});

test("owner isolation hides receipt conflicts and single-machine reads enforce scope", t => {
  const f = fixture(t), alice = person(), bob = person(), value = request();
  const vm = f.machines.create(value, req("POST", "/v1/machines", value, alice));
  assert.equal(vm.ownerId, alice.user!.id);
  assert.equal(f.machines.machines(req("GET", "/v1/machines", {}, bob)).length, 0);
  assert.throws(() => f.machines.create({ ...value, name: "different" }, req("POST", "/v1/machines", {}, bob)), error(404));
  assert.throws(() => f.machines.desired(vm.id, "stopped", req("POST", "/", {}, bob)), error(404));
  assert.throws(() => f.machines.handle(req("GET", `/v1/machines/${vm.id}`, {}, bob)), error(404));
  const readOnly = person(alice.user!.id, ["machines:read"]);
  assert.equal((f.machines.handle(req("GET", `/v1/machines/${vm.id}`, {}, readOnly))!.body as Json).id, vm.id);
  assert.throws(() => f.machines.handle(req("POST", `/v1/machines/${vm.id}/authorize`, { action: "access" }, readOnly)), error(403));
  assert.equal((f.machines.handle(req("GET", `/v1/machines/${vm.id}`, {}, person(randomUUID(), ["admin"], "admin")))!.body as Json).id, vm.id);
  assert.throws(() => f.machines.hosts(req("GET", "/v1/hosts", {}, alice)), error(403));
  assert.equal(f.machines.templates(req("GET", "/v1/templates", {}, readOnly)).length, 1);
  f.store.transaction(db => db.prepare("INSERT INTO machine_deletions VALUES (?,?,'complete',1000)").run(randomUUID(), vm.id));
  assert.throws(() => f.machines.handle(req("GET", `/v1/machines/${vm.id}`)), error(404));
});

test("authorization uses current account state inside the machine transaction", async t => {
  const f = fixture(t), accounts = new Accounts(f.store);
  const session = await accounts.setup({ username: "admin", password: "portable-fixture-password" });
  const r = req(); r.token = session.token; r.principal = () => accounts.principal(r.token);
  const vm = f.machines.create(request(), r); assert.equal(vm.ownerId, session.user.id);
  f.store.transaction(db => db.prepare("UPDATE users SET status='disabled' WHERE id=?").run(session.user.id));
  assert.throws(() => f.machines.machines(r), error(401));
});

test("inventory validation is atomic, rejects booleans and enforces immutable templates/providers", t => {
  const f = fixture(t), vm = f.machines.create(request(), req());
  for (const cpu of [true, -1, 0, 1.5, "2", 2 ** 100]) assert.throws(() => f.machines.create(request({ resources: { cpu, memoryMiB: 1024, diskGiB: 10 } }), req()), error(400));
  assert.throws(() => f.heartbeat({ [vm.id]: { state: "stopped" }, [randomUUID()]: { state: "running" } }), error(403));
  assert.equal(f.machines.machines(req())[0]!.observed, "pending");
  assert.throws(() => f.heartbeat({}, { offer: offered({ templates: [image({ defaults: { cpu: 2, memoryMiB: 1024, diskGiB: 4 } })] }) }), error(409));
  assert.throws(() => f.heartbeat({}, { offer: offered({ provider: "apple" }) }), error(409));
  assert.equal(f.machines.templates(req())[0]!.defaults.cpu, 1);
});

test("preparation receipts are scoped, durable, reject hash changes and gate guest access readiness", t => {
  const f = fixture(t), prepared = image({ id: "prepared", guestAccess: true, prepare: { driver: "cloud-init", commands: ["printf ready"] } });
  f.offer.templates = [prepared]; f.heartbeat();
  const vm = f.machines.create(request({ templateId: "prepared" }), req()), guest = token();
  const report = { state: "running", accessReady: false, preparation: { state: "failed", tokenHash: machineDigest(guest) } };
  f.heartbeat({ [vm.id]: report }); assert.equal(f.machines.machines(req())[0]!.ready, false);
  f.machines.prepared(vm.id, guest); f.heartbeat({ [vm.id]: report });
  assert.equal(f.machines.machines(req())[0]!.preparation.state, "ready");
  assert.equal(f.machines.machines(req())[0]!.ready, false);
  f.heartbeat({ [vm.id]: { ...report, accessReady: true } });
  assert.equal(f.machines.machines(req())[0]!.ready, true);
  assert.throws(() => f.heartbeat({ [vm.id]: { ...report, preparation: { state: "ready", tokenHash: "b".repeat(64) } } }), error(409));
  f.heartbeat({ [vm.id]: { state: "stopped" } });
  assert.equal(f.machines.machines(req())[0]!.guestConnectionReady, false);
});

test("ambiguous revisions, memory granularity, architecture and drain reject placement", t => {
  const f = fixture(t);
  f.offer.templates = [image(), image({ revision: "2", memoryStepMiB: 1024 })]; f.heartbeat();
  assert.throws(() => f.machines.create(request(), req()), error(409));
  assert.throws(() => f.machines.create(request({ templateRevision: "2", resources: { memoryMiB: 1500 } }), req()), error(409));
  assert.throws(() => f.machines.create(request({ templateRevision: "2", arch: "arm64" }), req()), error(409));
  f.machines.enable(f.id, false, req());
  assert.throws(() => f.machines.create(request({ templateRevision: "2" }), req()), error(409));
  f.machines.enable(f.id, true, req());
  assert.equal(f.machines.create(request({ templateRevision: "2" }), req()).template.revision, "2");
});

test("transaction-local leased placement requires an explicit exact image/runtime selector", t => {
  const f = fixture(t);
  assert.throws(() => f.store.transaction(db => f.machines.createMachine(db, request(), true)), error(409));
  f.offer.leaseProtocol = 1; f.offer.leaseImages = [{ id: "linux", revision: "1", arch: "amd64", runtime: "libvirt" }]; f.heartbeat();
  const normalized = validateOffer(f.offer), pinned = normalized.templates[0];
  assert.equal(machineLeaseEligible(normalized, pinned), true);
  assert.equal(machineLeaseEligible(normalized, { ...pinned, defaults: { ...pinned.defaults, cpu: 3 } }), false);
  const vm = f.store.transaction(db => f.machines.createMachine(db, request(), true)); assert.equal(vm.ownerId, null);
  assert.throws(() => f.store.transaction(db => f.machines.createMachine(db, request(), true, randomUUID())), error(409));
  assert.throws(() => validateOffer({ ...f.offer, leaseImages: [{ ...f.offer.leaseImages[0], runtime: "apple" }] }), error(400));
});

test("scoped setup claims roll back on credential collision and permit saved exact retries", t => {
  const f = fixture(t), infra = new InfrastructureStore(f.store);
  const setup = infra.createSetup({ id: randomUUID(), name: "host", provider: "libvirt", capacity: f.offer.capacity });
  assert.throws(() => f.machines.enroll({ id: f.id, credential: token(), offer: f.offer }, String(setup.enrollmentToken)), error(403));
  assert.equal(infra.setups()[0]!.hostId, null);
  const id = randomUUID(), credential = token();
  f.machines.enroll({ id, credential, offer: f.offer }, String(setup.enrollmentToken));
  f.advance(1800);
  assert.deepEqual(f.machines.enroll({ id, credential, offer: f.offer }, String(setup.enrollmentToken)), { id });
  assert.throws(() => f.machines.enroll({ id: randomUUID(), credential: token(), offer: f.offer }, String(setup.enrollmentToken)), error(401));
});

test("extensions share the authenticated heartbeat transaction and failures roll back observations", t => {
  const f = fixture(t), vm = f.machines.create(request(), req());
  f.store.transaction(db => db.exec("CREATE TABLE fixture_receipt (value TEXT)"));
  registerMachineHooks(f.store, {
    heartbeatFields: ["deviceReports"], reportFields: ["leaseFenced"],
    beforeTransaction(db) { assert.equal(db.isTransaction, true); },
    beforeHeartbeat(db) { db.prepare("INSERT INTO fixture_receipt VALUES ('received')").run(); },
    afterHeartbeat(_db, _id, body) { if (body.deviceReports.fail) throw new ServiceError("Unconfirmed receipt.", 409); },
    heartbeatResponse() { return { deviceOperations: [{ id: "fixture" }] }; },
  });
  assert.throws(() => f.heartbeat({ [vm.id]: { state: "running" } }, { deviceReports: { fail: true } }), error(409));
  assert.equal(f.store.transaction(db => db.prepare("SELECT COUNT(*) AS n FROM fixture_receipt").get()!.n), 0);
  assert.equal(f.machines.machines(req())[0]!.observed, "pending");
  assert.equal(f.heartbeat({}, { deviceReports: {} }).deviceOperations[0].id, "fixture");
});

test("physical/mobile/native and recipe validation preserve public-only contracts", () => {
  const value = image({ prepare: { driver: "cloud-init", commands: ["printf ready"] }, source: { path: "/first/base.raw", format: "raw", sha256: "a".repeat(64) }, ssh: { identityFile: "/private/key" } });
  const normalized = validateTemplate(value);
  assert.equal("prepare" in normalized, false); assert.equal("source" in normalized, false); assert.equal("ssh" in normalized, false);
  assert.equal(validateTemplate({ ...value, source: { ...value.source, path: "/second/base.raw" } }).recipeDigest, normalized.recipeDigest);
  assert.deepEqual(validateTemplate(normalized), normalized);
  assert.throws(() => validateTemplate(image({ prepare: { driver: "cloud-init", packages: ["-bad"] } })), error(400));
  assert.throws(() => validateTemplate(image({ guestAccess: false })), error(400));
  const android = image({ id: "android", os: "android", mode: "device", device: { systemImage: "system-images;android-35;google_apis;x86_64", profile: "pixel_7" } });
  assert.equal(validateOffer(offered({ provider: "android", templates: [android] })).templates[0].os, "android");
  assert.throws(() => validateOffer(offered({ templates: [android] })), error(400));
  assert.throws(() => validateTemplate({ ...android, arch: "arm64" }), error(400));
  assert.throws(() => validateOffer(offered({ provider: "native" })), error(400));
  assert.throws(() => validateOffer(offered({ provider: "linux", runtimes: ["apple"] })), error(400));
  assert.equal(validateOffer(offered({ provider: "linux", runtimes: ["libvirt"] })).runtimes[0], "libvirt");
});

test("opaque legacy host rows survive startup unchanged and stay ineligible until valid heartbeat", t => {
  const f = fixture(t), id = randomUUID(), credential = token();
  f.store.transaction(db => db.prepare("INSERT INTO hosts VALUES (?,?,?,1000,1)").run(id, machineDigest(credential), "{}"));
  const reopened = new MachineStore(f.store, f.options);
  assert.equal(f.store.transaction(db => db.prepare("SELECT offer FROM hosts WHERE id=?").get(id)!.offer), "{}");
  assert.equal(reopened.hosts(req()).find(h => h.id === id)!.placementReady, false);
  assert.equal(reopened.templates(req()).some(h => h.hostId === id), false);
  assert.throws(() => reopened.create(request({ hostId: id }), req()), error(409));
  reopened.heartbeat(id, credential, { offer: f.offer, reports: {} });
  assert.equal(reopened.create(request({ hostId: id }), req()).hostId, id);
});

test("eight-column legacy machines migrate without losing intent, owner defaults or reservations", t => {
  const folder = mkdtempSync(join(tmpdir(), "canaveral-machine-migration-")); t.after(() => rmSync(folder, { recursive: true, force: true }));
  const path = join(folder, "old.sqlite"), db = new DatabaseSync(path), value = request(), host = randomUUID();
  db.exec("CREATE TABLE hosts(id TEXT PRIMARY KEY,credential TEXT NOT NULL,offer TEXT NOT NULL,seen REAL NOT NULL,enabled INTEGER NOT NULL); CREATE TABLE machines(id TEXT PRIMARY KEY,request TEXT NOT NULL,host TEXT NOT NULL,template TEXT NOT NULL,desired TEXT NOT NULL,observed TEXT NOT NULL,detail TEXT NOT NULL,updated REAL NOT NULL)");
  db.prepare("INSERT INTO hosts VALUES (?,?,?,?,1)").run(host, machineDigest(token()), JSON.stringify(offered()), 1000);
  db.prepare("INSERT INTO machines VALUES (?,?,?,?,'running','running','',1000)").run(value.id, JSON.stringify(value), host, JSON.stringify(image())); db.close();
  const store = new SqliteStore(path, () => 1000), machines = new MachineStore(store, { adminToken: token(), controllerId: randomUUID() });
  assert.equal(machines.create(value, req()).id, value.id);
  assert.equal(machines.machines(req())[0]!.preparation.state, "notRequired");
  assert.equal(machines.machines(req())[0]!.ownerId, null);
  store.transaction(initializeMachines);
  assert.equal(store.transaction(db => db.prepare("SELECT intent FROM machines WHERE id=?").get(value.id)!.intent), JSON.stringify(value));
});

test("independent workers cannot overcommit placement and restart retains reservations", async t => {
  const f = fixture(t), moduleUrl = new URL("../../src/control/machines.js", import.meta.url).href, storeUrl = new URL("../../src/sqlite.js", import.meta.url).href;
  const attempts = await Promise.all(Array.from({ length: 8 }, () => new Promise<boolean>((resolve, reject) => {
    const worker = new Worker(`const {parentPort,workerData}=require('node:worker_threads'); (async()=>{const {MachineStore}=await import(workerData.moduleUrl); const {SqliteStore}=await import(workerData.storeUrl); const machine=new MachineStore(new SqliteStore(workerData.path,()=>1000),workerData.options); try { machine.create(workerData.request,{ principal:()=>({kind:'operator',user:null,scopes:['admin']}) }); parentPort.postMessage(true); } catch(e) { if(e.status===409) parentPort.postMessage(false); else throw e; } })().catch(e=>{throw e});`, { eval: true, workerData: { moduleUrl, storeUrl, path: f.store.path, options: f.options, request: request() } });
    worker.once("message", resolve); worker.once("error", reject);
  })));
  assert.equal(attempts.filter(Boolean).length, 2);
  const reopened = new MachineStore(f.store, f.options);
  assert.equal(reopened.machines(req()).length, 2);
  assert.throws(() => reopened.create(request(), req()), error(409));
});

test("leased placement cannot adopt an existing administrative machine with the same specification", t => {
  const f = fixture(t), value = request();
  f.offer.leaseProtocol = 1; f.offer.leaseImages = [{ id: "linux", revision: "1", arch: "amd64", runtime: "libvirt" }]; f.heartbeat();
  f.machines.create(value, req());
  assert.throws(() => f.store.transaction(db => f.machines.createMachine(db, value, true)), error(409));
});

test("health and installed-image extensions affect admission within the heartbeat transaction", t => {
  const f = fixture(t), vm = f.machines.create(request(), req()), infra = new InfrastructureStore(f.store);
  infra.requestChecks(f.id);
  const report = { status: "passed", checkedAt: 1000, checks: [] };
  assert.equal(f.heartbeat({}, { health: report, installedImages: [image()] }).checksRequestedAt, 1000);
  assert.equal(f.store.transaction(db => db.prepare("SELECT definitions FROM host_image_inventory WHERE host=?").get(f.id)) !== undefined, true);
  f.advance(120);
  f.heartbeat({}, { health: report }); // Replaying the same health proof cannot renew its freshness.
  assert.equal(f.machines.hosts(req())[0]!.placementReady, false);
  assert.throws(() => f.machines.create(request(), req()), error(409));
  const updated = { ...report, checkedAt: 1120 };
  f.heartbeat({}, { health: updated }); assert.equal(f.machines.hosts(req())[0]!.placementReady, true);
  assert.throws(() => f.heartbeat({ [vm.id]: { state: "running" } }, { installedImages: [image(), image()] }), error(400));
  assert.equal(f.machines.machines(req())[0]!.observed, "pending");
});
