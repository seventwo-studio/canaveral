import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { LegacyLeases } from "../../src/control/leases.ts";
import { operationRequest, reportDeviceOperations } from "../../src/control/devices.ts";
import { SqliteStore } from "../../src/sqlite.ts";
import { failure, key, leaseFixture } from "./leases-fixture.test.ts";

async function operationFixture(t: Parameters<typeof leaseFixture>[0], system = "android", mode = "device") {
  const f = leaseFixture(t, system, mode), lease = await f.request("POST", "/v1/leases", f.acquire()), token = await f.scoped(lease.id), route = `/v1/leases/${lease.id}/operations`;
  const command = (extra: Record<string, unknown> = {}) => ({ id: randomUUID(), member: "primary", action: "tap", arguments: { x: 10, y: 20 }, ...extra });
  const submit = (body: Record<string, unknown>, credential = token) => f.raw("POST", route, body, credential);
  const inspect = async (id: string, credential = token) => f.request("GET", `${route}/${id}`, {}, credential);
  return { ...f, lease, token, route, command, submit, inspect };
}

test("durable consumer FIFO dispatch, restart replay, safe receipts and first terminal outcome", async t => {
  const f = await operationFixture(t); f.ready(f.lease);
  const first = f.command(), second = f.command({ action: "shell", arguments: { argv: ["printf", "hello"] } });
  const queued = await f.submit(first); assert.equal(queued!.status, 201); assert.equal((queued!.body as any).state, "queued");
  const replay = await f.submit(first); assert.equal(replay!.status ?? 200, 200); assert.deepEqual(replay!.body, queued!.body);
  await assert.rejects(f.submit({ ...first, arguments: { x: 11, y: 20 } }), failure(409));
  await f.submit(second);
  let response = f.beat(); assert.equal(response.deviceOperations.length, 1); assert.equal(response.deviceOperations[0].id, first.id);
  assert.equal(response.deviceOperations[0].leaseId, f.lease.id); assert.equal(response.deviceOperations[0].expiresAt, 1120);
  const store = new SqliteStore(f.store.path, f.now); new LegacyLeases(store, f.options);
  assert.deepEqual(await f.inspect(first.id), queued!.body);
  response = f.beat({ deviceReports: { [first.id]: { state: "unknown", result: { detail: "fixture interrupted effect" } } } });
  assert.equal(response.deviceOperations[0].id, second.id);
  f.beat({ deviceReports: { [first.id]: { state: "succeeded", result: { unexpected: true } } } });
  const receipt = await f.inspect(first.id); assert.equal(receipt.state, "unknown"); assert.deepEqual(receipt.result, { detail: "fixture interrupted effect" });
  assert.equal(receipt.machineId, undefined); assert.equal(receipt.hostId, undefined);
  for (const secret of [f.token, f.hostToken, f.options.adminToken]) assert.ok(!JSON.stringify(receipt).includes(secret));
});

test("scoped credential, member, action, shape and global operation identity boundaries", async t => {
  const f = await operationFixture(t), request = f.command();
  for (const token of [f.app.credential, f.other.credential, f.hostToken, f.options.adminToken, key()]) await assert.rejects(f.submit(request, token), failure(401));
  await assert.rejects(f.submit(request), failure(409, "member_not_ready"));
  f.ready(f.lease);
  for (const [bad, status] of [[{ ...request, member: "absent" }, 404], [{ ...request, action: "install", arguments: { artifact: "fixture" } }, 409],
    [{ ...request, hostId: f.host }, 400], [{ ...request, arguments: { x: true, y: 2 } }, 400], [{ ...request, arguments: null }, 400]] as const) {
    await assert.rejects(f.submit(bad), failure(status));
  }
  await f.submit(request);
  const other = await f.request("POST", "/v1/leases", f.acquire(), f.other.credential), otherToken = await f.scoped(other.id, f.other.credential);
  await assert.rejects(f.raw("POST", `/v1/leases/${other.id}/operations`, request, otherToken), failure(404));
  await assert.rejects(f.request("GET", `/v1/leases/${other.id}/operations/${request.id}`, {}, otherToken), failure(404));
  const administrative = operationRequest({ id: randomUUID(), action: "tap", arguments: { x: 1, y: 2 } });
  f.store.transaction(db => db.prepare("INSERT INTO device_operations VALUES (?,?,?,?,'succeeded',NULL,?,?)").run(administrative.id, f.lease.members[0].machineId, f.host, JSON.stringify(administrative), f.now(), f.now()));
  await assert.rejects(f.submit({ ...administrative, member: "primary" }), failure(404));
});

test("release distinguishes dispatched uncertainty from never-dispatched failure and cannot resurrect", async t => {
  const f = await operationFixture(t); f.ready(f.lease);
  const first = f.command(), second = f.command(); await f.submit(first); await f.submit(second); f.beat();
  await f.request("POST", `/v1/leases/${f.lease.id}/release`, { id: randomUUID() }, f.token);
  assert.equal((await f.inspect(first.id)).state, "unknown"); assert.equal((await f.inspect(second.id)).state, "failed");
  assert.equal((await f.submit(first))!.status ?? 200, 200);
  await assert.rejects(f.submit(f.command()), failure(410));
  assert.deepEqual(f.beat({ deviceReports: { [first.id]: { state: "succeeded" } } }).deviceOperations, []);
  assert.equal((await f.inspect(first.id)).state, "unknown");
});

test("credential rotation, eligibility withdrawal and readiness loss close operation authority", async t => {
  const f = await operationFixture(t); f.ready(f.lease);
  const first = f.command(); await f.submit(first); f.beat();
  const token = await f.scoped(f.lease.id);
  await assert.rejects(f.inspect(first.id), failure(401));
  assert.equal((await f.inspect(first.id, token)).state, "unknown");
  const second = f.command(); await f.submit(second, token);
  f.changeOffer({ leaseImages: [] });
  const response = f.beat({ deviceReports: { [second.id]: { state: "succeeded" } } });
  assert.deepEqual(response.deviceOperations, []); assert.equal((await f.inspect(second.id, token)).state, "failed");
  f.changeOffer({ leaseImages: [{ id: f.image.id, revision: "1", arch: "amd64", runtime: "android" }] }); f.beat();
  assert.equal((await f.submit(second, token))!.status ?? 200, 200); assert.equal((await f.inspect(second.id, token)).state, "failed");
  const third = f.command(); await f.submit(third, token);
  f.beat({ reports: { [f.lease.members[0].machineId]: { state: "stopped" } }, deviceReports: { [third.id]: { state: "succeeded" } } });
  assert.equal((await f.inspect(third.id, token)).state, "failed");
});

test("exact 120-second command start window survives renewal and wrong-host/late reports", async t => {
  const f = await operationFixture(t); f.ready(f.lease); const op = f.command(); await f.submit(op); f.beat();
  f.store.transaction(db => assert.throws(() => reportDeviceOperations(db, randomUUID(), { [op.id]: { state: "succeeded" } }, f.now()), failure(403)));
  const current = await f.request("GET", `/v1/leases/${f.lease.id}`, {}, f.token);
  await f.request("POST", `/v1/leases/${f.lease.id}/renew`, { id: randomUUID(), expectedRevision: current.revision, ttlSeconds: 300 }, f.token);
  for (const now of [1020, 1040, 1060, 1080, 1100]) { f.setNow(now); f.beat(); }
  f.setNow(1120);
  assert.equal((await f.inspect(op.id)).state, "unknown");
  assert.equal((await f.request("GET", `/v1/leases/${f.lease.id}`, {}, f.token)).state, "ready");
  assert.deepEqual(f.beat({ deviceReports: { [op.id]: { state: "succeeded", result: {} } } }).deviceOperations, []);
  assert.equal((await f.inspect(op.id)).state, "unknown");
});

test("queue bound 32, revocation and headless/iOS capability denial", async t => {
  const f = await operationFixture(t); f.ready(f.lease);
  for (let i = 0; i < 32; i++) await f.submit(f.command());
  await assert.rejects(f.submit(f.command()), failure(429));
  const first = f.beat().deviceOperations[0];
  f.beat({ deviceReports: { [first.id]: { state: "succeeded", result: {} } } });
  await f.submit(f.command());
  f.apps.revoke(f.app.id);
  await assert.rejects(f.inspect(first.id), failure(401));
  f.store.transaction(db => assert.equal(db.prepare("SELECT count(*) AS n FROM device_operations WHERE state='queued'").get()!.n, 0));
  const headless = await operationFixture(t, "linux", "headless"); headless.ready(headless.lease);
  await assert.rejects(headless.submit(headless.command()), failure(409, "capability_unsupported"));
  assert.equal(((await headless.submit(headless.command({ action: "shell", arguments: { argv: ["printf", "guest-only"] } })))!.body as any).state, "queued");
  const ios = await operationFixture(t, "ios"); ios.ready(ios.lease);
  await assert.rejects(ios.submit(ios.command({ action: "shell", arguments: { argv: ["host-must-not-run"] } })), failure(409, "capability_unsupported"));
  assert.equal(((await ios.submit(ios.command({ action: "list-files", arguments: { path: "/", app: "com.example.fixture" } })))!.body as any).state, "queued");
});
