import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import test from "node:test";
import type { TestContext } from "node:test";
import { SqliteStore } from "../src/sqlite.ts";
import { CapacityLedger } from "../src/capacity.ts";
import { MachineStore, registerMachineHooks } from "../src/control/machines.ts";
import type { ControlRequest } from "../src/control/contracts.ts";
import { PhysicalDomains, physicalBudget, physicalMapping } from "../src/physical-domains.ts";
import { ResourceDomains } from "../src/resource-domains.ts";
import { ServiceError } from "../src/errors.ts";
const capacity = { cpu: 4, memoryMiB: 4096, diskGiB: 40 }, size = { cpu: 3, memoryMiB: 1024, diskGiB: 4 };
const token = () => randomBytes(32).toString("base64url");
const req = (): ControlRequest => ({ method: "GET", path: "/v1/hosts", parts: ["v1", "hosts"], query: new URLSearchParams(), body: {}, token: token(), principal: () => ({ kind: "operator", user: null, scopes: ["admin"] }) });
const conflict = (e: unknown) => e instanceof ServiceError && e.status === 409;
function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "physical-budget-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new SqliteStore(join(dir, "state.sqlite"), () => 1);
  const options = { adminToken: token(), enrollmentToken: token(), controllerId: randomUUID() };
  const machines = new MachineStore(store, options), domains = new ResourceDomains(), physical = new PhysicalDomains(), host = randomUUID(), domain = randomUUID();
  machines.enroll({ id: host, credential: token(), offer: { name: "fixture", provider: "libvirt", capacity, templates: [{ id: "linux", revision: "1", arch: "amd64", os: "linux", mode: "headless", minimum: { cpu: 1, memoryMiB: 1024, diskGiB: 1 } }] } }, options.enrollmentToken);
  store.transaction(db => { ResourceDomains.schema(db); domains.define(db, { id: domain, name: "physical", capacity }, 1); });
  const map = () => store.transaction(db => physical.map(db, host, domain));
  const create = () => machines.create({ id: randomUUID(), name: "fixture", hostId: host, templateId: "linux", resources: size }, req());
  const reserve = () => store.transaction(db => domains.reserve(db, { id: randomUUID(), domain, kind: "model", owner: domain, resources: size }, 1));
  return { store, options, machines, domains, physical, host, domain, map, create, reserve };
}
for (const order of ["host", "runner"]) test(`mapped mixed work cannot overspend: ${order} first`, t => {
  const f = fixture(t); f.map();
  if (order === "host") { f.create(); assert.equal(f.reserve(), false); }
  else { assert.equal(f.reserve(), true); assert.throws(f.create, conflict); }
  assert.deepEqual(f.machines.hosts(req())[0]!.reserved, size);
  assert.equal(f.machines.hosts(req())[0]!.physicalDomainId, f.domain);
  f.store.transaction(db => {
    assert.deepEqual(f.domains.view(db, f.domain).reserved, size);
    assert.deepEqual(physicalBudget(db, { hostId: f.host }), physicalBudget(db, { domainId: f.domain }));
  });
});
test("unmapped paths and old databases retain independent accounting", t => {
  const f = fixture(t);
  f.store.transaction(db => { db.exec("DROP TABLE physical_domains"); assert.equal(physicalBudget(db, { hostId: f.host }), undefined); });
  f.create(); assert.equal(f.reserve(), true);
  assert.deepEqual(f.machines.hosts(req())[0]!.reserved, size);
  assert.deepEqual(f.store.transaction(db => f.domains.view(db, f.domain).reserved), size);
});
test("mapping conflicts, held host disks and both remap domains are fenced", t => {
  const f = fixture(t); f.map();
  const next = randomUUID(), other = randomUUID();
  f.store.transaction(db => {
    f.domains.define(db, { id: next, name: "next", capacity }, 1);
    db.prepare("INSERT INTO hosts SELECT ?,credential,offer,seen,enabled FROM hosts WHERE id=?").run(other, f.host);
    assert.throws(() => f.physical.map(db, other, f.domain), conflict);
  });
  assert.equal(f.reserve(), true);
  f.store.transaction(db => assert.throws(() => f.physical.map(db, f.host, next), conflict));
  f.store.transaction(db => db.prepare("UPDATE resource_reservations SET state='released'").run());
  const machine = f.create();
  f.store.transaction(db => {
    db.prepare("UPDATE machines SET desired='stopped',observed='stopped' WHERE id=?").run(machine.id);
    assert.throws(() => f.physical.map(db, f.host, next), conflict);
    assert.deepEqual(f.physical.map(db, f.host, f.domain), { hostId: f.host, domainId: f.domain });
  });
});
test("empty remaps succeed but initial binding and target-held remaps fail", t => {
  const f = fixture(t); const next = randomUUID();
  f.store.transaction(db => f.domains.define(db, { id: next, name: "next", capacity }, 1));
  f.reserve(); assert.throws(f.map, conflict);
  f.store.transaction(db => db.prepare("UPDATE resource_reservations SET state='released'").run()); f.map();
  f.store.transaction(db => {
    f.domains.reserve(db, { id: randomUUID(), domain: next, owner: next, kind: "lease", resources: size }, 1);
    assert.throws(() => f.physical.map(db, f.host, next), conflict);
    db.prepare("UPDATE resource_reservations SET state='released'").run();
    assert.equal(f.physical.map(db, f.host, next).domainId, next);
  });
});
test("mapping and held allocations survive reopen and respect each minimum", t => {
  const f = fixture(t); f.map(); f.reserve();
  const reopened = new SqliteStore(f.store.path), ledger = new CapacityLedger(reopened);
  const machines = new MachineStore(reopened, f.options);
  reopened.transaction(db => {
    assert.equal(physicalMapping(db, { hostId: f.host })!.domainId, f.domain);
    assert.deepEqual(ledger.used(db, f.host), size);
    db.prepare("UPDATE resource_domains SET capacity=? WHERE id=?").run(JSON.stringify({ ...capacity, cpu: 3 }), f.domain);
    db.prepare("UPDATE hosts SET offer=json_set(offer,'$.capacity.diskGiB',20) WHERE id=?").run(f.host);
  });
  ledger.save(f.host, { limits: { ...capacity, memoryMiB: 2048 } });
  reopened.transaction(db => {
    assert.deepEqual(physicalBudget(db, { hostId: f.host })!.capacity, { cpu: 3, memoryMiB: 2048, diskGiB: 20 });
    assert.deepEqual(machines.remainingCapacity(db, f.host), { cpu: 0, memoryMiB: 1024, diskGiB: 16 });
  });
});
test("SQL hook reservations are visible from another store and unsupported callbacks fail closed", t => {
  const f = fixture(t);
  registerMachineHooks(f.store, { additionalReservations: () => ({ cpu: 1 }), additionalReservationsSql: { id: "fixture", query: "SELECT 1 AS cpu, 0 AS memoryMiB, 0 AS diskGiB WHERE ? IS NOT NULL" } });
  assert.throws(f.map, conflict);
  // A zero-work mapping precedes registering a hook in real operation.
  f.store.transaction(db => db.prepare("DELETE FROM physical_reservation_sources").run()); f.map();
  registerMachineHooks(f.store, { additionalReservations: () => ({ cpu: 1 }), additionalReservationsSql: { id: "fixture", query: "SELECT 1 AS cpu, 0 AS memoryMiB, 0 AS diskGiB WHERE ? IS NOT NULL" } });
  new SqliteStore(f.store.path).transaction(db => assert.equal(physicalBudget(db, { domainId: f.domain })!.reserved.cpu, 1));
  registerMachineHooks(f.store, { additionalReservations: () => ({ cpu: 1 }) });
  assert.throws(f.reserve, /requires SQL/);
});
test("administrator mapping route rejects ordinary principals", t => {
  const f = fixture(t), request = { ...req(), method: "POST", path: `/v1/hosts/${f.host}/physical-domain`, parts: ["v1", "hosts", f.host, "physical-domain"], body: { domainId: f.domain } };
  assert.throws(() => f.machines.handle({ ...request, principal: () => ({ kind: "token", user: null, scopes: ["machines:write"] }) }), (e: unknown) => e instanceof ServiceError && e.status === 403);
  assert.deepEqual(f.machines.handle(request)!.body, { hostId: f.host, domainId: f.domain });
});
test("independent concurrent stores cannot spend mapped capacity twice", { timeout: 30000 }, async t => {
  const f = fixture(t); f.map();
  const workers = ["host", "runner"].map(kind => {
    const worker = new Worker(new URL("./physical-domains-worker.js", import.meta.url), { workerData: { path: f.store.path, host: f.host, domain: f.domain, kind, id: randomUUID() } });
    t.after(async () => { await worker.terminate(); });
    let ready!: () => void, result!: (value: boolean) => void, fail!: (e: Error) => void;
    const started = new Promise<void>(resolve => { ready = resolve; });
    const done = new Promise<boolean>((resolve, reject) => { result = resolve; fail = reject; });
    worker.on("error", fail); worker.on("message", message => message === "ready" ? ready() : result(message as boolean));
    return { worker, started, done };
  });
  await Promise.all(workers.map(w => w.started)); for (const w of workers) w.worker.postMessage("admit");
  assert.deepEqual((await Promise.all(workers.map(w => w.done))).sort(), [false, true]);
});
test("restart excludes only its own host allocation, never held runner work", t => {
  const f = fixture(t); f.map(); const machine = f.create();
  f.store.transaction(db => db.prepare("UPDATE machines SET desired='stopped',observed='stopped' WHERE id=?").run(machine.id));
  assert.equal(f.reserve(), true);
  assert.throws(() => f.machines.desired(machine.id, "running", req()), conflict);
  f.store.transaction(db => db.prepare("UPDATE resource_reservations SET state='released'").run());
  assert.equal(f.machines.desired(machine.id, "running", req()).desired, "running");
});
test("unmapped missing tables and malformed image error behavior remain distinct", t => {
  const f = fixture(t), ledger = new CapacityLedger(f.store);
  f.store.transaction(db => {
    assert.deepEqual(f.machines.used(db, f.host), { cpu: 0, memoryMiB: 0, diskGiB: 0 });
    // The legacy strict ledger still requires its integrated tables.
    db.exec("DROP TABLE IF EXISTS inference_jobs");
    assert.throws(() => ledger.used(db, f.host), /no such table/);
    db.exec("CREATE TABLE inference_jobs(host TEXT,definition TEXT,state TEXT); CREATE TABLE IF NOT EXISTS images(id TEXT PRIMARY KEY,host TEXT,metadata TEXT); CREATE TABLE IF NOT EXISTS image_tasks(host TEXT,state TEXT,reserved_disk INTEGER)");
    db.prepare("INSERT INTO images VALUES (?,?,?)").run(randomUUID(), f.host, JSON.stringify({ bytes: 1 }));
    assert.equal(f.machines.used(db, f.host).diskGiB, 1);
    assert.throws(() => ledger.used(db, f.host), (e: unknown) => e instanceof ServiceError && e.status === 503);
  });
});
