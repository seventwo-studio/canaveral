import { strict as assert } from "node:assert";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SqliteStore } from "../../src/sqlite.ts";
import { ServiceError } from "../../src/errors.ts";
import { assignedDeviceOperations, createModule, deviceDefinition, deviceExecutionReceipt, executeDeviceOperation, importDeviceExecutionReceipt, MAX_RESULT, operationRequest, platformArguments, reportDeviceOperations } from "../../src/control/devices.ts";
import type { OperationAssignment, OperationReceipt } from "../../src/control/devices.ts";
import type { ControlRequest, ControlOptions, Principal } from "../../src/control/contracts.ts";
import { initializeLifecycle } from "../../src/control/lifecycle.ts";
import { MachineStore } from "../../src/control/machines.ts";
import { legacyDigest } from "../../src/control/templates.ts";

const options: ControlOptions = { adminToken: "a".repeat(43), controllerId: randomUUID() };
const ownerId = randomUUID();
const owner: Principal = { kind: "token", user: { id: ownerId, role: "user", status: "active", username: "owner" }, scopes: ["machines:access"] };
const admin: Principal = { kind: "operator", user: null, scopes: ["admin"] };
const mobile = { os: "android", arch: "arm64", mode: "device" };
const operation = (action = "screenshot", args: Record<string, unknown> = {}) => ({ id: randomUUID(), action, arguments: args });
function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), "canaveral-ts-device-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let now = 1000;
  const path = join(root, "state.sqlite"), store = new SqliteStore(path, () => now);
  const host = randomUUID(), mid = randomUUID();
  store.transaction(db => {
    db.exec("CREATE TABLE hosts(id TEXT PRIMARY KEY,seen REAL NOT NULL,enabled INTEGER NOT NULL); CREATE TABLE machines(id TEXT PRIMARY KEY,host TEXT NOT NULL,owner TEXT,template TEXT NOT NULL,desired TEXT NOT NULL,observed TEXT NOT NULL)");
    db.prepare("INSERT INTO hosts VALUES(?,?,1)").run(host, now);
    db.prepare("INSERT INTO machines VALUES(?,?,?,?,'running','running')").run(mid, host, ownerId, JSON.stringify(mobile));
  });
  const module = createModule(store, options);
  const request = (method: string, path: string, body: Record<string, unknown> = {}, principal = owner): ControlRequest => ({ method, path, parts: path.split("/").filter(Boolean), query: new URLSearchParams(), body, token: "fixture", principal: () => principal });
  const submit = async (body = operation(), principal = owner, machine = mid) => (await module.handle(request("POST", `/v1/machines/${machine}/operations`, body, principal)))!.body as OperationReceipt;
  const read = async (id: string, principal = owner) => (await module.handle(request("GET", `/v1/operations/${id}`, {}, principal)))!.body as OperationReceipt;
  const assign = () => store.transaction(db => assignedDeviceOperations(db, host, now));
  const report = (id: string, state = "succeeded", result: unknown = {}) => store.transaction(db => reportDeviceOperations(db, host, { [id]: { state, result } }, now));
  return { store, path, mid, host, submit, read, assign, report, request, module, setNow(value: number) { now = value; } };
}
const status = (code: number) => (error: unknown) => error instanceof ServiceError && error.status === code;

test("Python device cases: FIFO, semantic idempotency, restart and first unknown receipt wins", async t => {
  const f = fixture(t), first = operation("tap", { x: 10, y: 20 }), second = operation();
  await f.submit(first); await f.submit(second);
  const replay = createModule(new SqliteStore(f.path, () => 1000), options);
  assert.equal((await replay.handle(f.request("POST", `/v1/machines/${f.mid}/operations`, { ...first, arguments: { y: 20, x: 10 } })))!.body && (await f.read(first.id)).state, "queued");
  assert.equal(f.assign()[0]!.id, first.id);
  await assert.rejects(f.submit({ ...first, arguments: { x: 30, y: 20 } }), status(409));
  f.report(first.id, "unknown", { detail: "Interrupted tap" });
  assert.equal(f.assign()[0]!.id, second.id);
  f.report(first.id, "succeeded");
  assert.equal((await f.read(first.id)).state, "unknown");
});

test("current scope and machine ownership protect receipts including conflicting identities", async t => {
  const f = fixture(t), request = operation(); await f.submit(request);
  const foreign = { ...owner, user: { ...owner.user!, id: randomUUID() } };
  await assert.rejects(f.read(request.id, foreign), status(404));
  await assert.rejects(f.submit(request, foreign, randomUUID()), status(404));
  await assert.rejects(f.read(request.id, { ...owner, scopes: ["machines:read"] }), status(403));
  assert.equal((await f.read(request.id, admin)).id, request.id);
  let revoked = false;
  const req = f.request("POST", `/v1/machines/${f.mid}/operations`, operation());
  req.principal = () => { revoked = true; throw new ServiceError("Revoked", 401); };
  assert.throws(() => f.module.handle(req), status(401)); assert.equal(revoked, true);
});

test("foreign host reports and invalid results roll back inventory in the heartbeat transaction", async t => {
  const f = fixture(t), request = operation(); await f.submit(request);
  assert.throws(() => f.store.transaction(db => reportDeviceOperations(db, randomUUID(), { [request.id]: { state: "succeeded" } }, 1000)), status(403));
  assert.throws(() => f.store.transaction(db => {
    db.prepare("UPDATE machines SET observed='stopped' WHERE id=?").run(f.mid);
    reportDeviceOperations(db, f.host, { [request.id]: { state: "bogus" } }, 1000);
  }), status(400));
  f.store.transaction(db => assert.equal(db.prepare("SELECT observed FROM machines WHERE id=?").get(f.mid)!.observed, "running"));
  for (const result of [{ value: NaN }, { value: Infinity }, { output: "x".repeat(MAX_RESULT) }]) assert.throws(() => f.report(request.id, "succeeded", result), ServiceError);
  assert.throws(() => f.store.transaction(db => reportDeviceOperations(db, f.host, { [request.id]: { state: "succeeded" }, [randomUUID()]: {} }, 1000)), status(400));
  assert.equal((await f.read(request.id)).state, "queued");
});

test("queue, offline, stopped, iOS shell and unsafe paths are refused", async t => {
  const f = fixture(t);
  f.setNow(1030); await assert.rejects(f.submit(), status(409)); f.setNow(1000);
  f.store.transaction(db => db.prepare("UPDATE machines SET desired='stopped'").run());
  await assert.rejects(f.submit(), status(409));
  f.store.transaction(db => db.prepare("UPDATE machines SET desired='running',template=?").run(JSON.stringify({ os: "ios" })));
  await assert.rejects(f.submit(operation("shell", { argv: ["ls"] })), status(400));
  await assert.rejects(f.submit(operation("pull", { path: "../escape", app: "com.example" })), status(400));
  await assert.rejects(f.submit(operation("pull", { path: "data" })), status(400));
  f.store.transaction(db => db.prepare("UPDATE machines SET template=?").run(JSON.stringify(mobile)));
  for (let n = 0; n < 32; n++) await f.submit();
  await assert.rejects(f.submit(), status(429));
});

test("expired or stopped dispatched work is unknown; undispatched work fails and frees queue", async t => {
  const f = fixture(t), first = operation(), second = operation();
  await f.submit(first); await f.submit(second); f.assign(); f.setNow(1120);
  assert.deepEqual(f.assign(), []);
  assert.equal((await f.read(first.id)).state, "unknown"); assert.equal((await f.read(second.id)).state, "failed");
  f.report(first.id); assert.equal((await f.read(first.id)).state, "unknown");
});

test("upgrade from Python's administrative queue preserves ambiguous dispatch as unknown without redelivery", async t => {
  for (const expired of [true, false]) {
    const f = fixture(t), request = operation("tap", { x: 10, y: 20 });
    await f.submit(request);
    // Python had only device_operations: a dispatched operation still looked queued.
    // No dispatch/pending ledger may be manufactured as evidence of non-execution.
    f.store.transaction(db => db.exec("DROP TABLE control_device_dispatch; DROP TABLE control_device_pending"));
    const now = expired ? 1201 : 1001;
    const upgraded = new SqliteStore(f.path, () => now), module = createModule(upgraded, options);
    const migrated = (await module.handle(f.request("GET", `/v1/operations/${request.id}`)))!.body as OperationReceipt;
    assert.equal(migrated.state, "unknown", expired ? "expired legacy operation" : "unexpired legacy operation");
    assert.deepEqual(upgraded.transaction(db => assignedDeviceOperations(db, f.host, now)), []);
    upgraded.transaction(db => reportDeviceOperations(db, f.host, { [request.id]: { state: "succeeded" } }, now));
    assert.equal(((await module.handle(f.request("GET", `/v1/operations/${request.id}`)))!.body as OperationReceipt).state, "unknown");
  }
});

test("scoped eligibility withdrawal, rotation, readiness and expiry close before late success or delivery", async t => {
  for (const change of ["image", "credential", "expired", "readiness", "revoked", "offline", "disabled", "undispatched"]) {
    const f = fixture(t), request = operation(), lease = randomUUID(), consumer = randomUUID();
    await f.submit(request);
    const image = { ...mobile, id: "phone", revision: "1" };
    const offer = { provider: "android", leaseProtocol: 1, templates: [image], leaseImages: [{ id: "phone", revision: "1", arch: "arm64", runtime: "android" }] };
    f.store.transaction(db => {
      initializeLifecycle(db);
      db.exec("ALTER TABLE hosts ADD COLUMN offer TEXT; ALTER TABLE machines ADD COLUMN prepared_at REAL DEFAULT 0; ALTER TABLE machines ADD COLUMN access_ready INTEGER; CREATE TABLE consumers(id TEXT PRIMARY KEY,revoked INTEGER); CREATE TABLE leases(id TEXT PRIMARY KEY,state TEXT,credential TEXT,expires REAL,consumer TEXT); CREATE TABLE consumer_operations(id TEXT PRIMARY KEY,lease TEXT,member TEXT,credential TEXT,dispatched INTEGER)");
      db.prepare("UPDATE hosts SET offer=?").run(JSON.stringify(offer));
      db.prepare("UPDATE machines SET template=?").run(JSON.stringify(image));
      db.prepare("INSERT INTO consumers VALUES(?,0)").run(consumer);
      db.prepare("INSERT INTO leases VALUES(?,'ready','scoped',1100,?)").run(lease, consumer);
      db.prepare("INSERT INTO consumer_operations VALUES(?,?,'primary','scoped',0)").run(request.id, lease);
    });
    if (change !== "undispatched") {
      const delivered = f.assign()[0]!; assert.equal(delivered.leaseId, lease); assert.equal(delivered.expiresAt, 1100);
    }
    f.store.transaction(db => {
      if (change === "image" || change === "undispatched") db.prepare("UPDATE hosts SET offer=?").run(JSON.stringify({ ...offer, leaseImages: [] }));
      if (change === "credential") db.prepare("UPDATE leases SET credential='rotated'").run();
      if (change === "expired") db.prepare("UPDATE leases SET expires=1000").run();
      if (change === "readiness") db.prepare("UPDATE machines SET observed='stopped'").run();
      if (change === "revoked") db.prepare("UPDATE consumers SET revoked=1").run();
      if (change === "offline") db.prepare("UPDATE hosts SET seen=970").run();
      if (change === "disabled") db.prepare("UPDATE hosts SET enabled=0").run();
      // Simulate one authenticated heartbeat's updated offer/inventory followed by its report.
      reportDeviceOperations(db, f.host, { [request.id]: { state: "succeeded", result: { late: true } } }, 1000);
    });
    assert.equal((await f.read(request.id)).state, change === "undispatched" ? "failed" : "unknown", change);
    assert.deepEqual(f.assign(), [], change);
  }
});

test("real machine heartbeat integrates FIFO delivery and rolls back observations on invalid report", async t => {
  const root = mkdtempSync(join(tmpdir(), "canaveral-ts-device-heartbeat-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new SqliteStore(join(root, "state"), () => 1000), host = randomUUID(), mid = randomUUID();
  const settings = { ...options, enrollmentToken: "e".repeat(43) }, machines = new MachineStore(store, settings), devices = createModule(store, settings);
  const image = { id: "phone", revision: "1", ...mobile, device: { systemImage: "system-images;android-35;google_apis;arm64-v8a", profile: "pixel_8" }, minimum: { cpu: 2, memoryMiB: 2048, diskGiB: 8 } };
  const offer = { name: "test-host", provider: "android", capacity: { cpu: 4, memoryMiB: 8192, diskGiB: 64 }, templates: [image] };
  const credential = "h".repeat(43);
  machines.enroll({ id: host, credential, offer }, settings.enrollmentToken);
  const request = (method: string, path: string, body: Record<string, unknown>): ControlRequest => ({ method, path, parts: path.split("/").filter(Boolean), query: new URLSearchParams(), body, token: options.adminToken, principal: () => admin });
  machines.create({ id: mid, name: "phone", templateId: "phone" }, request("POST", "/v1/machines", {}));
  machines.heartbeat(host, credential, { offer, reports: { [mid]: { state: "running" } } });
  const first = operation(), second = operation();
  await devices.handle(request("POST", `/v1/machines/${mid}/operations`, first)); await devices.handle(request("POST", `/v1/machines/${mid}/operations`, second));
  let heartbeat = machines.heartbeat(host, credential, { offer });
  assert.equal((heartbeat.deviceOperations as OperationAssignment[])[0]!.id, first.id);
  assert.throws(() => machines.heartbeat(host, credential, { offer, reports: { [mid]: { state: "stopped" } }, deviceReports: { [first.id]: { state: "invalid" } } }), status(400));
  store.transaction(db => assert.equal(db.prepare("SELECT observed FROM machines WHERE id=?").get(mid)!.observed, "running"));
  heartbeat = machines.heartbeat(host, credential, { offer, deviceReports: { [first.id]: { state: "unknown" } } });
  assert.equal((heartbeat.deviceOperations as OperationAssignment[])[0]!.id, second.id);
});

test("operation argument validation ports meaningful Python negatives and preserves literal argv", () => {
  const invalid = [operation("tap", { x: true, y: 1 }), operation("tap", { x: 1, y: 2, serial: "foreign" }), operation("location", { latitude: NaN, longitude: 0 }), operation("push", { path: "/x", data: "???" }), operation("install", { artifact: "--help" }), operation("shell", { argv: ["echo", "a\0b"] }), operation("shell-read", { session: randomUUID(), offset: 2 ** 53 }), operation("shell-resize", { session: randomUUID(), rows: 0, cols: 80 }), operation("constructor")];
  for (const value of invalid) assert.throws(() => operationRequest(value), status(400));
  const args = ["echo", "hi; $(touch /tmp/no)", ""];
  assert.deepEqual(operationRequest(operation("shell", { argv: args })).arguments.argv, args);
  assert.deepEqual(operationRequest(operation("text", { text: "" })).arguments, { text: "" });
  assert.throws(() => platformArguments({ os: "ios" }, operationRequest(operation("list-files", { path: "." }))), status(400));
});

test("device definition rejects runtime/ABI mismatch and arbitrary SDK identifiers", () => {
  const device = { systemImage: "system-images;android-35;google_apis;arm64-v8a", profile: "pixel_8" };
  assert.deepEqual(deviceDefinition(device, "android", "arm64"), device);
  assert.throws(() => deviceDefinition(device, "android", "amd64"), status(400));
  assert.throws(() => deviceDefinition({ ...device, profile: "--help" }, "android", "arm64"), status(400));
  assert.throws(() => deviceDefinition({ runtime: "iOS", deviceType: "iPhone" }, "ios", "arm64"), status(400));
});

test("runner private receipts survive restart and never replay crash, timeout or concurrent delivery", async t => {
  const f = fixture(t), machine = { id: f.mid, desired: "running", template: mobile };
  const assignment: OperationAssignment = { ...operation("tap", { x: 1, y: 2 }), machineId: f.mid, expiresAt: 1120 };
  let calls = 0;
  const provider = { async control() { calls++; return { output: "tapped" }; } };
  const first = await executeDeviceOperation(f.store, machine, assignment, provider, () => true);
  assert.equal(first.state, "succeeded");
  assert.deepEqual(await executeDeviceOperation(new SqliteStore(f.path, () => 1000), machine, assignment, provider, () => true), first); assert.equal(calls, 1);
  await assert.rejects(executeDeviceOperation(f.store, machine, { ...assignment, arguments: { x: 3, y: 2 } }, provider, () => true), status(409));
  const failed = { ...assignment, id: randomUUID() };
  const timedOut = { async control() { calls++; throw new Error("timeout"); } };
  assert.equal((await executeDeviceOperation(f.store, machine, failed, timedOut, () => true)).state, "unknown");
  assert.equal((await executeDeviceOperation(f.store, machine, failed, provider, () => true)).state, "unknown"); assert.equal(calls, 2);
  const crash = { ...assignment, id: randomUUID() };
  // Canonical fingerprint matching the Python started-receipt recovery case.
  const canonical = `{"action":"tap","arguments":{"x":1,"y":2},"id":"${crash.id}","machine":"${f.mid}"}`;
  f.store.transaction(db => db.prepare("INSERT INTO control_device_execution VALUES (?,?,NULL)").run(crash.id, createHash("sha256").update(canonical).digest("hex")));
  assert.equal((await executeDeviceOperation(f.store, machine, crash, provider, () => true)).state, "unknown"); assert.equal(calls, 2);
});

test("native unsupported, expiry, cancellation, revocation and escaped result envelope stay truthful", async t => {
  const f = fixture(t), machine = { id: f.mid, desired: "running", template: mobile };
  const assignment = () => ({ ...operation(), machineId: f.mid, expiresAt: 1120 });
  const unsupported = await executeDeviceOperation(f.store, machine, assignment(), undefined, () => true);
  assert.equal(unsupported.state, "failed"); assert.equal((unsupported.result as { code: string }).code, "capability_unsupported");
  let calls = 0;
  const provider = { async control() { calls++; return {}; } };
  assert.equal((await executeDeviceOperation(f.store, machine, { ...assignment(), expiresAt: 1000 }, provider, () => true)).state, "failed"); assert.equal(calls, 0);
  assert.equal((await executeDeviceOperation(f.store, machine, assignment(), { async control() { return { output: "\n".repeat(4 * 1048576) }; } }, () => true)).state, "unknown");
  let allowed = true;
  assert.equal((await executeDeviceOperation(f.store, machine, assignment(), { async control() { allowed = false; return {}; } }, () => allowed)).state, "unknown");
  const controller = new AbortController(), request = assignment();
  const running = executeDeviceOperation(f.store, machine, request, { async control() { controller.abort(); return new Promise(() => {}); } }, () => true, controller.signal);
  assert.equal((await running).state, "unknown");
  assert.equal((await executeDeviceOperation(f.store, machine, request, provider, () => true)).state, "unknown"); assert.equal(calls, 0);
});

test("legacy started/completed receipts import without replay and concurrent delivery cannot repeat a provider effect", async t => {
  const f = fixture(t), machine = { id: f.mid, desired: "running", template: mobile };
  let calls = 0;
  const provider = { async control() { calls++; return {}; } };
  for (const started of [true, false]) {
    const request = operation("text", { text: "é" });
    const saved = { fingerprint: legacyDigest({ machine: f.mid, ...request }), ...(started ? { started: true } : { report: { state: "unknown", result: { detail: "old interrupted action" } } }) };
    importDeviceExecutionReceipt(f.store, f.mid, request, saved);
    assert.equal(deviceExecutionReceipt(f.store, request.id).state, "unknown");
    assert.equal((await executeDeviceOperation(f.store, machine, { ...request, machineId: f.mid, expiresAt: 1120 }, provider, () => true)).state, "unknown");
    assert.throws(() => importDeviceExecutionReceipt(f.store, randomUUID(), request, saved), status(409));
  }
  assert.equal(calls, 0);
  const request = { ...operation(), machineId: f.mid, expiresAt: 1120 };
  let finish!: (result: unknown) => void;
  const first = executeDeviceOperation(f.store, machine, request, { async control() { calls++; return new Promise(resolve => { finish = resolve; }); } }, () => true);
  assert.equal((await executeDeviceOperation(f.store, machine, request, provider, () => true)).state, "unknown");
  finish({ complete: true }); assert.equal((await first).state, "succeeded"); assert.equal(calls, 1);
  assert.equal(deviceExecutionReceipt(f.store, request.id).state, "succeeded");
});

test("controller extension recognizes only its exact routes", () => {
  const root = mkdtempSync(join(tmpdir(), "canaveral-ts-device-route-"));
  try {
    const module = createModule(new SqliteStore(join(root, "state")), options);
    assert.equal(module.handle({ method: "GET", path: "/v1/elsewhere", parts: ["v1", "elsewhere"], query: new URLSearchParams(), token: "", body: {}, principal: () => { throw new Error("unowned route authenticated"); } }), undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
