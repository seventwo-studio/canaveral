import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { CapacityLedger } from "../src/capacity.ts";
import { SqliteStore } from "../src/sqlite.ts";
import { ServiceError } from "../src/errors.ts";


const { capacitySchema } = await import(new URL("../../../fixtures/migration/capacity_reference.ts", import.meta.url).href) as { capacitySchema(db: DatabaseSync): void };
const capacity = { cpu: 8, memoryMiB: 8192, diskGiB: 100 };
const size = { cpu: 2, memoryMiB: 1024, diskGiB: 8 };
function fixture(t: { after: (callback: () => void) => void }) {
  const directory = mkdtempSync(join(tmpdir(), "canaveral-capacity-parity-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "controller.sqlite");
  const store = new SqliteStore(path, () => 80000);
  store.transaction(db => capacitySchema(db));
  const ledger = new CapacityLedger(store);
  const hosts = [randomUUID(), randomUUID()];
  store.transaction(db => {
    for (const host of hosts) db.prepare("INSERT INTO hosts VALUES (?,?,?,80000,1)").run(host, "synthetic-fixture-credential", JSON.stringify({ name: "Host", provider: "libvirt", capacity, templates: [] }));
  });
  function machine(host: string, desired = "stopped", observed = "stopped") {
    const id = randomUUID();
    store.transaction(db => db.prepare("INSERT INTO machines (id,request,host,template,desired,observed,detail,updated) VALUES (?,?,?,'{}',?,?, '',80000)").run(id, JSON.stringify({ resources: size }), host, desired, observed));
    return id;
  }
  return { path, store, ledger, hosts, machine };
}

test("stopped disks, lease members, unconfirmed power-off and positive cleanup retain distinct reservations", t => {
  const { store, ledger, hosts, machine } = fixture(t), host = hosts[0]!;
  const stopped = machine(host), leased = machine(host), uncertain = machine(host);
  store.transaction(db => {
    db.prepare("INSERT INTO lease_members VALUES (?,'primary',?)").run(randomUUID(), leased);
    db.prepare("INSERT INTO machine_power_offs VALUES (?,?, 'unknown',80000)").run(randomUUID(), uncertain);
  });
  assert.deepEqual(store.transaction(db => ledger.used(db, host)), { cpu: 4, memoryMiB: 2048, diskGiB: 24 });
  store.transaction(db => db.prepare("INSERT INTO machine_deletions VALUES (?,?,'complete',80000)").run(randomUUID(), stopped));
  assert.deepEqual(store.transaction(db => ledger.used(db, host)), { cpu: 4, memoryMiB: 2048, diskGiB: 16 });
  store.transaction(db => db.prepare("INSERT INTO lease_cleanup_members VALUES (?,?,?,'complete',NULL,0,0,80000)").run(randomUUID(), leased, randomUUID()));
  assert.deepEqual(store.transaction(db => ledger.used(db, host)), size);
  assert.deepEqual(store.transaction(db => ledger.used(db, host, uncertain)), { cpu: 0, memoryMiB: 0, diskGiB: 0 });
});

test("image aliases share one hash/format charge; unresolved tasks and active inference retain their charge", t => {
  const { store, ledger, hosts } = fixture(t), host = hosts[0]!;
  store.transaction(db => {
    for (const format of ["raw", "raw", "qcow2"]) {
      const id = randomUUID(), metadata = { id, sha256: "a".repeat(64), format, bytes: 1_073_741_825 };
      db.prepare("INSERT INTO images VALUES (?,?,?)").run(id, host, JSON.stringify(metadata));
    }
    db.prepare("INSERT INTO image_tasks VALUES (?,?,NULL,'{}','unknown',NULL,80000,80000,3)").run(randomUUID(), host);
    for (const state of ["unknown", "cancelled"]) db.prepare("INSERT INTO inference_jobs VALUES (?,'{}',?,?,'running',?,'',NULL,80000,80000)").run(randomUUID(), host, JSON.stringify({ resources: size }), state);
  });
  assert.deepEqual(store.transaction(db => ledger.used(db, host)), { cpu: 2, memoryMiB: 1024, diskGiB: 15 });
});

test("host limits constrain only their host, survive reloads and preserve existing reservations", t => {
  const { store, ledger, hosts, machine } = fixture(t);
  machine(hosts[0]!, "running", "unknown"); machine(hosts[1]!, "running", "running");
  const limits = { ...capacity, cpu: 1, diskGiB: 5 };
  ledger.save(hosts[0]!, { limits });
  assert.deepEqual(store.transaction(db => ledger.remaining(db, hosts[0]!)), { cpu: 0, memoryMiB: 7168, diskGiB: 0 });
  assert.deepEqual(store.transaction(db => ledger.remaining(db, hosts[1]!)), { cpu: 6, memoryMiB: 7168, diskGiB: 92 });
  assert.equal(store.transaction(db => db.prepare("SELECT count(*) AS n FROM machines").get()!.n), 2);
  const restored = new SqliteStore(store.path), restoredLedger = new CapacityLedger(restored);
  assert.deepEqual(restored.transaction(db => restoredLedger.hostLimits(db, hosts[0]!)), limits);
});

test("invalid host limit changes are rejected atomically", t => {
  const { store, ledger, hosts } = fixture(t), host = hosts[0]!;
  ledger.save(host, { limits: capacity });
  assert.throws(() => ledger.save(randomUUID(), { limits: capacity }), (e: unknown) => e instanceof ServiceError && e.status === 404);
  assert.throws(() => ledger.save(host, { limits: { ...capacity, cpu: 0 } }));
  assert.throws(() => ledger.save(host, { limits: capacity, extra: true }));
  assert.deepEqual(store.transaction(db => ledger.hostLimits(db, host)), capacity);
});

test("persisted host limits and reservations survive direct SQLite edits and reopen", t => {
  const { path, store, ledger, hosts, machine } = fixture(t), host = hosts[0]!;
  const id = machine(host, "running", "unknown"); machine(hosts[1]!);
  const limits = { ...capacity, cpu: 3 };
  assert.deepEqual(ledger.save(host, { limits }), {hostId:host,limits});
  const db = new DatabaseSync(path);
  try {
    assert.deepEqual(JSON.parse(String(db.prepare("SELECT limits FROM host_limits WHERE host=?").get(host)!.limits)), limits);
    db.prepare("UPDATE host_limits SET limits=? WHERE host=?").run(JSON.stringify({...limits,diskGiB:5}),host);
  } finally {db.close();}
  const reopened = new CapacityLedger(new SqliteStore(path));
  assert.deepEqual(store.transaction(db => reopened.hostLimits(db,host)), {...limits,diskGiB:5});
  assert.deepEqual(store.transaction(db => reopened.used(db,host,id)), {cpu:0,memoryMiB:0,diskGiB:0});
  assert.deepEqual(store.transaction(db => reopened.remaining(db,host)), {cpu:1,memoryMiB:7168,diskGiB:0});
});

test("two independent SQLite admission workers cannot spend the same host capacity", { timeout: 30_000 }, async t => {
  const { path, ledger, hosts, store } = fixture(t);
  ledger.save(hosts[0]!, { limits: { ...capacity, cpu: 2 } });
  const workers = [hosts[0]!, hosts[0]!].map(host => {
    const worker = new Worker(new URL("./capacity-worker.js", import.meta.url), { workerData: { path, host, id: randomUUID() } });
    t.after(async () => { await worker.terminate(); });
    let ready!: () => void, rejectReady!: (error: Error) => void, done!: (value: string) => void, fail!: (error: Error) => void;
    const started = new Promise<void>((resolve, reject) => { ready = resolve; rejectReady = reject; });
    const result = new Promise<string>((resolve, reject) => { done = resolve; fail = reject; });
    worker.on("error", error => { rejectReady(error); fail(error); });
    worker.on("exit", code => { const error = new Error(`Capacity fixture worker exited (${code}).`); rejectReady(error); fail(error); });
    worker.on("message", (message: string) => message === "ready" ? ready() : done(message));
    return { worker, started, result };
  });
  const [, results] = await Promise.all([
    Promise.all(workers.map(w => w.started)).then(() => { for (const { worker } of workers) worker.postMessage("admit"); }),
    Promise.all(workers.map(w => w.result)),
  ]);
  assert.deepEqual(results.sort(), ["full", "reserved"]);
  assert.equal(store.transaction(db => db.prepare("SELECT count(*) AS n FROM machines").get()!.n), 1);
});

test("invalid persisted amounts fail closed and accounting cannot run outside a transaction", t => {
  const { path, store, ledger, hosts, machine } = fixture(t), host = hosts[0]!;
  const db = new DatabaseSync(path);
  try { assert.throws(() => ledger.remaining(db, host), /admission transaction/); }
  finally { db.close(); }
  const id = machine(host);
  store.transaction(db => db.prepare("UPDATE machines SET request=? WHERE id=?").run(JSON.stringify({ resources: { ...size, diskGiB: -1 } }), id));
  assert.throws(() => store.transaction(db => ledger.used(db, host)), (e: unknown) => e instanceof ServiceError && e.status === 503);
});

test("host limit input validation matches fixed resource boundary expectations", t => {
  const { ledger, hosts } = fixture(t), host = hosts[0]!;
  for (const [cpu, expected] of [[0,400], [-1,400], [0.5,400], [1,200], [1_048_577,400]] as const) {
    const limits = { ...capacity, cpu };
    let status = 200;
    try { ledger.save(host, { limits }); } catch (error) { if (!(error instanceof ServiceError)) throw error; status = error.status; }
    assert.equal(status, expected);
  }
});
