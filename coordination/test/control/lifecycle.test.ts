import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { ServiceError } from "../../src/errors.ts";
import { SqliteStore } from "../../src/sqlite.ts";
import type { ControlRequest, Principal } from "../../src/control/contracts.ts";
import {
  cleanupView, computeReserved, createModule, deletion, ensureLeaseCleanup, hasPendingPowerOff,
  initializeLifecycle, isDeleted, leaseCleanup, lifecycleAssignment, refreshLeaseCleanup, reportLifecycle,
} from "../../src/control/lifecycle.ts";

const options = { adminToken: "fixture-operator", controllerId: randomUUID() };
const operator: Principal = { kind: "operator", user: null, scopes: [] };
function human(id: string, scopes = ["machines:write"], role: "user" | "admin" = "user"): Principal {
  return { kind: "token", user: { id, username: "fixture", role, status: "active" }, scopes };
}
function status(operation: () => unknown, code: number): void {
  assert.throws(operation, (error: unknown) => error instanceof ServiceError && error.status === code);
}

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "canaveral-lifecycle-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let now = 1_000;
  const store = new SqliteStore(join(directory, "controller.sqlite3"), () => now);
  const host = randomUUID(), owner = randomUUID();
  // Legacy machine/host/member schemas are fixtures, not a native runtime.
  store.transaction(db => {
    db.exec(`
      CREATE TABLE hosts (id TEXT PRIMARY KEY,credential TEXT NOT NULL,offer TEXT NOT NULL,seen REAL NOT NULL,enabled INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE machines (id TEXT PRIMARY KEY,request TEXT NOT NULL,host TEXT NOT NULL,template TEXT NOT NULL,desired TEXT NOT NULL,observed TEXT NOT NULL,detail TEXT NOT NULL,updated REAL NOT NULL,owner TEXT,intent TEXT,preparation_hash TEXT,prepared_at REAL NOT NULL DEFAULT 0,preparation_state TEXT NOT NULL DEFAULT 'pending',access_ready INTEGER);
      CREATE TABLE leases (id TEXT PRIMARY KEY,consumer TEXT NOT NULL,request TEXT NOT NULL,state TEXT NOT NULL,revision INTEGER NOT NULL,created REAL NOT NULL,expires REAL NOT NULL,provision_deadline REAL NOT NULL,credential TEXT,cleanup TEXT NOT NULL);
      CREATE TABLE lease_members (lease TEXT NOT NULL,name TEXT NOT NULL,machine TEXT NOT NULL UNIQUE,PRIMARY KEY(lease,name));
      CREATE TABLE image_tasks (id TEXT PRIMARY KEY,machine TEXT,state TEXT);
    `);
    db.prepare("INSERT INTO hosts VALUES (?,?,?, ?,1)").run(host, "hashed-host-credential", JSON.stringify({ provider: "apple" }), now);
  });
  let module = createModule(store, options);
  let principal: Principal = human(owner);
  function request(machineId: string, action: string, body: Record<string, unknown>): ControlRequest {
    const path = `/v1/machines/${machineId}/${action}`;
    return { method: "POST", path, parts: path.split("/").filter(Boolean), query: new URLSearchParams(), token: "fixture", body, principal: () => principal };
  }
  function post(machineId: string, action: string, body: Record<string, unknown>) {
    const result = module.handle(request(machineId, action, body));
    assert.ok(result && !("then" in result));
    return result.body as { id: string; machineId: string; state: string };
  }
  function addMachine(stopped = false, machineOwner: string | null = owner, id = randomUUID()) {
    store.transaction(db => db.prepare("INSERT INTO machines (id,request,host,template,desired,observed,detail,updated,owner,intent) VALUES (?,?,?,?,?,?,?, ?,?,?)")
      .run(id, JSON.stringify({ id, resources: { cpu: 2, memoryMiB: 512, diskGiB: 10 } }), host, JSON.stringify({ os: "linux" }),
        stopped ? "stopped" : "running", stopped ? "stopped" : "running", "", now, machineOwner, "{}"));
    return id;
  }
  function report(machineId: string, value: Record<string, unknown>, reportHost: string = host): boolean {
    return store.transaction(db => {
      const apply = reportLifecycle(db, reportHost, machineId, value, now);
      // Same ordering required of machines.ts: stale/completed cleanup cannot restore readiness.
      if (apply) db.prepare("UPDATE machines SET observed=?,updated=? WHERE id=?").run(String(value.state), now, machineId);
      return apply;
    });
  }
  function resources() {
    return store.transaction(db => {
      const reserved = { cpu: 0, memoryMiB: 0, diskGiB: 0 };
      for (const row of db.prepare("SELECT id,desired,observed FROM machines").all()) {
        const machine = { id: String(row.id), desired: String(row.desired), observed: String(row.observed) };
        if (isDeleted(db, machine.id)) continue;
        reserved.diskGiB += 10;
        if (computeReserved(db, machine)) { reserved.cpu += 2; reserved.memoryMiB += 512; }
      }
      return reserved;
    });
  }
  function assignment(id: string) {
    return store.transaction(db => lifecycleAssignment(db, { id, ready: true }));
  }
  function addLease(machineId: string, state = "released", id = randomUUID(), name = "primary") {
    store.transaction(db => {
      db.prepare("INSERT OR IGNORE INTO leases VALUES (?,?,?, ?,1,?,?,?,NULL,'pending')").run(id, "consumer", "{}", state, now, now + 60, now + 30);
      db.prepare("INSERT INTO lease_members VALUES (?,?,?)").run(id, name, machineId);
      if (["released", "failed", "expired"].includes(state)) refreshLeaseCleanup(db, now);
    });
    return id;
  }
  function receipt(machineId: string, state = "complete", attempt = 1): Record<string, unknown> {
    const intent = assignment(machineId).leaseCleanup;
    assert.ok(intent);
    return { state: "stopped", leaseCleanup: { id: intent.id, leaseId: intent.leaseId, state, attempt,
      ...(state === "complete" ? { executionStopped: true, storageRemoved: true, credentialsErased: true } : {}) } };
  }
  return { store, host, owner, post, request, addMachine, report, resources, assignment, addLease, receipt,
    now: () => now, advance: (seconds: number) => { now += seconds; },
    principal: (value: Principal) => { principal = value; },
    module: () => module,
    restart: () => { module = createModule(new SqliteStore(store.path, () => now), options); },
  };
}

test("power-off requires matching stop ACK, holds compute during uncertainty and retains storage", t => {
  const f = fixture(t), id = f.addMachine(), intent = { id: randomUUID() };
  assert.equal(f.post(id, "power-off", intent).state, "queued");
  assert.equal(f.assignment(id).powerOffRequest, intent.id);
  assert.equal(f.store.transaction(db => db.prepare("SELECT desired FROM machines WHERE id=?").get(id)?.desired), "stopped");
  f.report(id, { state: "stopped" });
  assert.deepEqual(f.resources(), { cpu: 2, memoryMiB: 512, diskGiB: 10 });
  f.report(id, { state: "unknown", powerOffId: intent.id });
  assert.equal(f.post(id, "power-off", intent).state, "unknown");
  status(() => f.post(id, "power-off", { id: randomUUID() }), 409);
  status(() => f.post(id, "delete", { id: randomUUID() }), 409);
  status(() => f.report(id, { state: "stopped", powerOffId: randomUUID() }), 403);
  f.restart();
  assert.equal(f.post(id, "power-off", intent).state, "unknown");
  f.report(id, { state: "stopped", powerOffId: intent.id });
  assert.equal(f.post(id, "power-off", intent).state, "succeeded");
  assert.equal(f.assignment(id).powerOffRequest, undefined);
  assert.deepEqual(f.resources(), { cpu: 0, memoryMiB: 0, diskGiB: 10 });
  f.store.transaction(db => db.prepare("UPDATE machines SET desired='running' WHERE id=?").run(id));
  assert.equal(f.post(id, "power-off", intent).state, "succeeded");
  assert.equal(f.store.transaction(db => db.prepare("SELECT desired FROM machines WHERE id=?").get(id)?.desired), "running");
  f.report(id, { state: "unknown", powerOffId: intent.id });
  assert.equal(f.post(id, "power-off", intent).state, "succeeded");
});

test("nonterminal and error power receipts do not invent stop evidence", t => {
  const f = fixture(t), id = f.addMachine(), intent = { id: randomUUID() };
  f.post(id, "power-off", intent);
  for (const state of ["starting", "running", "stopping"]) {
    f.report(id, { state, powerOffId: intent.id });
    assert.equal(f.post(id, "power-off", intent).state, "queued");
  }
  f.report(id, { state: "error", powerOffId: intent.id });
  assert.equal(f.post(id, "power-off", intent).state, "unknown");
  assert.equal(f.resources().cpu, 2);
});

test("receipt IDs hide foreign ownership before machine or operation comparison", t => {
  const f = fixture(t), foreignOwner = randomUUID(), foreign = f.addMachine(true, foreignOwner), own = f.addMachine(true);
  f.principal(human(foreignOwner));
  const power = { id: randomUUID() }, removal = { id: randomUUID() };
  f.post(foreign, "power-off", power);
  f.report(foreign, { state: "stopped", powerOffId: power.id });
  f.post(foreign, "delete", removal);
  f.principal(human(f.owner));
  for (const target of [foreign, own, randomUUID()]) {
    for (const intent of [power, removal]) for (const action of ["power-off", "delete"]) status(() => f.post(target, action, intent), 404);
  }
  status(() => f.post(foreign, "power-off", { id: randomUUID() }), 404);
  f.principal(operator);
  status(() => f.post(own, "power-off", power), 409);
  status(() => f.post(own, "delete", removal), 409);
});

test("current credential scope, account role and machine ownership govern mutation and replay", t => {
  const f = fixture(t), id = f.addMachine(), intent = { id: randomUUID() };
  const req = f.request(id, "power-off", intent);
  f.principal(human(f.owner, ["machines:read"]));
  status(() => f.module().handle(req), 403);
  f.principal(human(f.owner));
  f.module().handle(req);
  f.principal(human(randomUUID()));
  status(() => f.module().handle(req), 404);
  f.principal(human(randomUUID(), ["admin"], "admin"));
  f.module().handle(req);
  // The same token/request after demotion cannot use its former admin role.
  f.principal(human(randomUUID(), ["admin"], "user"));
  status(() => f.module().handle(req), 403);
  const unowned = f.addMachine(false, null);
  f.principal(human(f.owner));
  status(() => f.post(unowned, "power-off", { id: randomUUID() }), 404);
  f.principal(operator);
  assert.equal(f.post(unowned, "power-off", { id: randomUUID() }).state, "queued");
});

test("power/delete UUIDs cannot change operation, and inputs/routes are strict", t => {
  const f = fixture(t), id = f.addMachine(true), intent = { id: randomUUID() };
  f.post(id, "power-off", intent);
  f.report(id, { state: "stopped", powerOffId: intent.id });
  status(() => f.post(id, "delete", intent), 409);
  for (const action of ["power-off", "delete"]) for (const body of [{}, { id: "bad" }, { id: randomUUID(), force: true }, { id: null }]) {
    status(() => f.post(id, action, body), 400);
  }
  const req = f.request(id, "desired", {});
  assert.equal(f.module().handle(req), undefined);
  assert.equal(f.module().handle({ ...f.request(id, "power-off", intent), method: "GET" }), undefined);
  assert.equal(f.module().handle({ ...req, parts: ["api", "machines", id, "delete"] }), undefined);
});

test("new operations require a connected supported runtime; durable replays survive host loss", t => {
  const f = fixture(t), first = f.addMachine(), stopped = f.addMachine(true), intent = { id: randomUUID() };
  f.post(first, "power-off", intent);
  f.advance(30);
  status(() => f.post(first, "power-off", { id: randomUUID() }), 409);
  status(() => f.post(stopped, "delete", { id: randomUUID() }), 409);
  assert.equal(f.post(first, "power-off", intent).state, "queued");
  f.store.transaction(db => db.prepare("UPDATE hosts SET seen=?,offer=? WHERE id=?").run(f.now(), JSON.stringify({ provider: "libvirt" }), f.host));
  assert.throws(() => f.post(stopped, "delete", { id: randomUUID() }), (e: unknown) => e instanceof ServiceError && e.code === "capability_unsupported");
  assert.throws(() => f.post(stopped, "power-off", { id: randomUUID() }), (e: unknown) => e instanceof ServiceError && e.code === "capability_unsupported");
  f.store.transaction(db => {
    db.prepare("UPDATE hosts SET offer=? WHERE id=?").run(JSON.stringify({ provider: "macos" }), f.host);
    db.prepare("UPDATE machines SET template=? WHERE id=?").run(JSON.stringify({ os: "android" }), stopped);
  });
  status(() => f.post(stopped, "power-off", { id: randomUUID() }), 409);
  f.store.transaction(db => db.prepare("UPDATE machines SET template=? WHERE id=?").run(JSON.stringify({ os: "macos" }), stopped));
  assert.equal(f.post(stopped, "delete", { id: randomUUID() }).state, "queued");
});

test("pending capture blocks power/deletion, while completed captures do not", t => {
  const f = fixture(t), id = f.addMachine(true), capture = randomUUID();
  for (const state of ["queued", "running", "unknown"]) {
    f.store.transaction(db => db.prepare("INSERT OR REPLACE INTO image_tasks VALUES (?,?,?)").run(capture, id, state));
    for (const action of ["power-off", "delete"]) status(() => f.post(id, action, { id: randomUUID() }), 409);
  }
  f.store.transaction(db => db.prepare("UPDATE image_tasks SET state='succeeded' WHERE id=?").run(capture));
  assert.equal(f.post(id, "delete", { id: randomUUID() }).state, "queued");
});

test("deletion retains disks through missing/blocked receipts and persists its tombstone", t => {
  const f = fixture(t), id = f.addMachine(true), intent = { id: randomUUID() };
  assert.equal(f.post(id, "delete", intent).state, "queued");
  assert.deepEqual(f.assignment(id).deletion, { ...intent, state: "queued" });
  assert.equal(f.assignment(id).ready, false);
  f.report(id, { state: "stopped" });
  assert.equal(f.resources().diskGiB, 10);
  status(() => f.report(id, { state: "stopped", deletion: { id: randomUUID(), state: "complete" } }), 403);
  f.report(id, { state: "unknown", deletion: { ...intent, state: "blocked" } });
  assert.equal(f.resources().diskGiB, 10);
  assert.equal(f.post(id, "delete", intent).state, "blocked");
  f.restart();
  assert.equal(f.post(id, "delete", intent).state, "blocked");
  assert.equal(f.report(id, { state: "stopped", deletion: { ...intent, state: "complete" } }), false);
  assert.deepEqual(f.resources(), { cpu: 0, memoryMiB: 0, diskGiB: 0 });
  assert.equal(f.report(id, { state: "running", deletion: { ...intent, state: "blocked" } }), false);
  assert.equal(f.post(id, "delete", intent).state, "complete");
  assert.equal(f.store.transaction(db => db.prepare("SELECT id FROM machines WHERE id=?").get(id)?.id), id);
  f.restart();
  assert.equal(f.post(id, "delete", intent).state, "complete");
  status(() => f.post(id, "delete", { id: randomUUID() }), 409);
  status(() => f.post(id, "power-off", { id: randomUUID() }), 409);
});

test("deletion refuses unconfirmed shutdown and active completion, preserving reservations", t => {
  const f = fixture(t), id = f.addMachine(), intent = { id: randomUUID() };
  status(() => f.post(id, "delete", intent), 409);
  f.store.transaction(db => db.prepare("UPDATE machines SET desired='stopped' WHERE id=?").run(id));
  status(() => f.post(id, "delete", intent), 409);
  f.report(id, { state: "stopped" });
  f.post(id, "delete", intent);
  for (const state of ["running", "unknown", "error"]) status(() => f.report(id, { state, deletion: { ...intent, state: "complete" } }), 409);
  for (const state of [["complete"], true, 1, null]) status(() => f.report(id, { state: "stopped", deletion: { ...intent, state } }), 400);
  status(() => f.report(id, { state: "stopped", deletion: { ...intent, state: "complete", storageRemoved: true } }), 400);
  assert.equal(f.resources().diskGiB, 10);
  assert.equal(f.store.transaction(db => deletion(db, id)?.state), "queued");
});

test("every receipt is bound to its machine and authenticated host assignment", t => {
  const f = fixture(t), a = f.addMachine(true), b = f.addMachine(true), power = { id: randomUUID() }, removal = { id: randomUUID() };
  f.post(a, "power-off", power);
  f.post(b, "delete", removal);
  status(() => f.report(b, { state: "stopped", powerOffId: power.id }), 403);
  status(() => f.report(a, { state: "stopped", deletion: { ...removal, state: "complete" } }), 403);
  status(() => f.report(a, { state: "stopped", powerOffId: power.id }, randomUUID()), 403);
  status(() => f.report(b, { state: "stopped", deletion: { ...removal, state: "complete" } }, randomUUID()), 403);
  status(() => f.report(randomUUID(), { state: "stopped" }), 403);
  assert.equal(f.resources().diskGiB, 20);
  assert.equal(f.store.transaction(db => hasPendingPowerOff(db, a)), true);
});

test("lease-owned assignments retain all resources while stopped and cannot use admin operations", t => {
  const f = fixture(t), id = f.addMachine(true);
  f.addLease(id, "ready");
  for (const action of ["power-off", "delete"]) status(() => f.post(id, action, { id: randomUUID() }), 409);
  assert.deepEqual(f.resources(), { cpu: 2, memoryMiB: 512, diskGiB: 10 });
  status(() => f.store.transaction(db => ensureLeaseCleanup(db, String(db.prepare("SELECT lease FROM lease_members WHERE machine=?").get(id)?.lease), f.now())), 409);
  assert.equal(f.assignment(id).leaseCleanup, undefined);
});

test("matching cleanup acknowledgement frees all resources and erases controller preparation credentials", t => {
  const f = fixture(t), id = f.addMachine(true), leaseId = f.addLease(id), first = f.assignment(id).leaseCleanup;
  assert.ok(first);
  assert.equal(first.state, "pending");
  assert.equal(f.assignment(id).ready, false);
  f.store.transaction(db => db.prepare("UPDATE machines SET preparation_hash='sensitive-hash',prepared_at=?,access_ready=1 WHERE id=?").run(f.now(), id));
  f.report(id, { state: "stopped" });
  assert.equal(f.resources().cpu, 2);
  f.restart();
  assert.equal(f.assignment(id).leaseCleanup?.id, first.id);
  assert.equal(f.report(id, f.receipt(id)), false);
  assert.deepEqual(f.resources(), { cpu: 0, memoryMiB: 0, diskGiB: 0 });
  f.store.transaction(db => {
    assert.equal(db.prepare("SELECT cleanup FROM leases WHERE id=?").get(leaseId)?.cleanup, "complete");
    const row = db.prepare("SELECT preparation_hash,prepared_at,access_ready FROM machines WHERE id=?").get(id);
    assert.deepEqual({ ...row }, { preparation_hash: null, prepared_at: 0, access_ready: 0 });
    assert.equal(db.prepare("SELECT count(*) AS n FROM lease_members WHERE machine=?").get(id)?.n, 1);
  });
  assert.equal(f.report(id, { state: "running", preparation: { state: "ready", tokenHash: "stale" } }), false);
  status(() => f.report(id, { state: "running" }, randomUUID()), 403);
  assert.equal(f.assignment(id).leaseCleanup?.state, "complete");
});

test("cleanup completion requires exact IDs, terminal lease, and literal positive proof flags", t => {
  const f = fixture(t), id = f.addMachine(true), leaseId = f.addLease(id);
  for (const key of ["id", "leaseId"]) {
    const report = f.receipt(id), receipt = report.leaseCleanup as Record<string, unknown>;
    receipt[key] = randomUUID();
    status(() => f.report(id, report), 403);
  }
  status(() => f.report(id, f.receipt(id), randomUUID()), 403);
  for (const key of ["executionStopped", "storageRemoved", "credentialsErased"]) {
    for (const value of [undefined, false, "true", 1]) {
      const report = f.receipt(id), receipt = report.leaseCleanup as Record<string, unknown>;
      if (value === undefined) delete receipt[key]; else receipt[key] = value;
      status(() => f.report(id, report), typeof value === "string" || typeof value === "number" ? 400 : 409);
    }
  }
  status(() => f.report(id, { ...f.receipt(id), state: "running" }), 409);
  f.store.transaction(db => db.prepare("UPDATE leases SET state='ready' WHERE id=?").run(leaseId));
  status(() => f.report(id, f.receipt(id)), 409);
  assert.deepEqual(f.resources(), { cpu: 2, memoryMiB: 512, diskGiB: 10 });
});

test("stale cleanup cannot overwrite a newer blocked attempt or push retry later", t => {
  const f = fixture(t), id = f.addMachine(true);
  f.addLease(id);
  const blocked = f.receipt(id, "blocked", 2);
  (blocked.leaseCleanup as Record<string, unknown>).reason = "storage_removal";
  f.report(id, blocked);
  const first = f.store.transaction(db => cleanupView(leaseCleanup(db, id)!));
  assert.equal(first.retryAt, f.now() + 4);
  f.advance(10);
  f.report(id, blocked);
  assert.equal(f.store.transaction(db => leaseCleanup(db, id)?.next_retry), first.retryAt);
  assert.equal(f.report(id, f.receipt(id, "complete", 1)), false);
  assert.equal(f.report(id, f.receipt(id, "running", 2)), false);
  assert.equal(f.assignment(id).leaseCleanup?.state, "blocked");
  f.restart();
  assert.equal(f.store.transaction(db => leaseCleanup(db, id)?.next_retry), first.retryAt);
  const later = f.receipt(id, "blocked", 10);
  (later.leaseCleanup as Record<string, unknown>).reason = "credential_erasure";
  f.report(id, later);
  assert.equal(f.store.transaction(db => leaseCleanup(db, id)?.next_retry), f.now() + 60);
  assert.equal(f.resources().cpu, 2);
  assert.equal(f.report(id, f.receipt(id, "complete", 11)), false);
  assert.equal(f.resources().diskGiB, 0);
});

test("cleanup aggregate completes only after every member; foreign member receipts never reclaim peers", t => {
  const f = fixture(t), a = f.addMachine(true), b = f.addMachine(true), leaseId = f.addLease(a);
  f.addLease(b, "released", leaseId, "companion");
  const receiptB = f.receipt(b);
  status(() => f.report(a, receiptB), 403);
  f.report(a, f.receipt(a));
  assert.equal(f.resources().diskGiB, 10);
  assert.equal(f.store.transaction(db => db.prepare("SELECT cleanup FROM leases WHERE id=?").get(leaseId)?.cleanup), "running");
  const blocked = f.receipt(b, "blocked");
  (blocked.leaseCleanup as Record<string, unknown>).reason = "unsupported";
  f.report(b, blocked);
  assert.equal(f.store.transaction(db => db.prepare("SELECT cleanup FROM leases WHERE id=?").get(leaseId)?.cleanup), "blocked");
  f.report(b, f.receipt(b, "complete", 2));
  assert.equal(f.store.transaction(db => db.prepare("SELECT cleanup FROM leases WHERE id=?").get(leaseId)?.cleanup), "complete");
  assert.equal(f.resources().diskGiB, 0);
});

test("cleanup refuses malformed attempts, flags, states and unbounded reasons", t => {
  const f = fixture(t), id = f.addMachine(true);
  f.addLease(id);
  for (const attempt of [0, -1, true, "1", 1.5, 2 ** 31 + 1]) {
    const report = f.receipt(id);
    (report.leaseCleanup as Record<string, unknown>).attempt = attempt;
    status(() => f.report(id, report), 400);
  }
  for (const state of [["complete"], true, 1, null]) {
    const report = f.receipt(id);
    (report.leaseCleanup as Record<string, unknown>).state = state;
    status(() => f.report(id, report), 400);
  }
  for (const reason of [undefined, "native secret /private/path", 42]) {
    const report = f.receipt(id, "blocked");
    if (reason !== undefined) (report.leaseCleanup as Record<string, unknown>).reason = reason;
    status(() => f.report(id, report), 400);
  }
  const extra = f.receipt(id);
  (extra.leaseCleanup as Record<string, unknown>).extra = true;
  status(() => f.report(id, extra), 400);
  status(() => f.report(id, { ...f.receipt(id), state: "deleted" }), 400);
  assert.equal(f.resources().diskGiB, 10);
});

test("receipt rejection rolls back earlier power acknowledgement in the same transaction", t => {
  const f = fixture(t), id = f.addMachine(), intent = { id: randomUUID() };
  f.post(id, "power-off", intent);
  status(() => f.report(id, { state: "stopped", powerOffId: intent.id, deletion: { id: randomUUID(), state: "complete" } }), 403);
  assert.equal(f.post(id, "power-off", intent).state, "queued");
  assert.equal(f.resources().cpu, 2);
});

test("legacy queued and uncertain rows survive lifecycle initialization unchanged", t => {
  const f = fixture(t), id = f.addMachine(true), intent = randomUUID();
  f.store.transaction(db => db.prepare("INSERT INTO machine_power_offs VALUES (?,?,'unknown',?)").run(intent, id, 100));
  f.restart();
  f.store.transaction(db => {
    initializeLifecycle(db);
    assert.equal(db.prepare("SELECT state FROM machine_power_offs WHERE id=?").get(intent)?.state, "unknown");
    assert.equal(computeReserved(db, { id, desired: "stopped", observed: "stopped" }), true);
  });
  f.report(id, { state: "stopped", powerOffId: intent });
  assert.equal(f.resources().cpu, 0);
});

test("cleanup rejects mismatched durable assignment ownership rather than replacing its intent", t => {
  const f = fixture(t), id = f.addMachine(true), leaseId = f.addLease(id), original = f.assignment(id).leaseCleanup?.id;
  f.store.transaction(db => db.prepare("UPDATE lease_members SET lease=? WHERE machine=?").run(randomUUID(), id));
  status(() => f.report(id, f.receipt(id)), 403);
  f.store.transaction(db => db.prepare("UPDATE lease_members SET lease=? WHERE machine=?").run(leaseId, id));
  f.store.transaction(db => db.prepare("UPDATE lease_cleanup_members SET id=? WHERE machine=?").run(randomUUID(), id));
  status(() => f.store.transaction(db => ensureLeaseCleanup(db, leaseId, f.now())), 409);
  assert.notEqual(f.assignment(id).leaseCleanup?.id, original);
  assert.equal(f.resources().diskGiB, 10);
});

test("cleanup UUIDs match the legacy UUIDv5 namespace and restart recreates only missing intents", t => {
  const f = fixture(t), id = f.addMachine(true, f.owner, "00000000-0000-0000-0000-000000000001");
  const leaseId = f.addLease(id, "expired", "6ba7b810-9dad-11d1-80b4-00c04fd430c8");
  // SHA-1(namespace bytes + UTF-8 name), with RFC UUID version/variant bits.
  const expected = "82981428-18e2-5965-a835-78aca17d6734";
  assert.equal(f.assignment(id).leaseCleanup?.id, expected);
  f.store.transaction(db => {
    db.prepare("DELETE FROM lease_cleanup_members WHERE machine=?").run(id);
    db.prepare("UPDATE leases SET state='failed' WHERE id=?").run(leaseId);
  });
  f.restart();
  assert.equal(f.assignment(id).leaseCleanup?.id, expected);
  assert.equal(f.resources().cpu, 2);
});
