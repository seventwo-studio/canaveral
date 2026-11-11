import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { LegacyLeases, leaseEligible, legacyLeaseAccess, legacySessionLease, refreshLegacyLeases } from "../../src/control/leases.ts";
import { machineDigest } from "../../src/control/machines.ts";
import { SqliteStore } from "../../src/sqlite.ts";
import { failure, key, leaseFixture } from "./leases-fixture.test.ts";

test("generic acquisition owns one assignment, replays terminal tombstones and separates credentials", async t => {
  const f = leaseFixture(t), intent = f.acquire();
  const first = await f.raw("POST", "/v1/leases", intent); assert.equal(first!.status, 201);
  const lease = first!.body as any, id = lease.id;
  assert.equal(lease.state, "provisioning"); assert.equal(lease.members.length, 1); assert.equal(lease.cleanup.state, "notRequested");
  assert.deepEqual((await f.raw("POST", "/v1/leases", intent))!.body, lease);
  await assert.rejects(f.request("POST", "/v1/leases", { ...intent, ttlSeconds: 121 }), failure(409));
  await assert.rejects(f.request("POST", "/v1/leases", intent, f.other.credential), failure(404));
  await assert.rejects(f.request("GET", `/v1/leases/${id}`, {}, f.other.credential), failure(404));
  assert.deepEqual((await f.request("GET", "/v1/leases", {}, f.other.credential)).leases, []);
  const scoped = await f.scoped(id);
  assert.equal((await f.request("GET", `/v1/leases/${id}`, {}, scoped)).id, id);
  await assert.rejects(f.request("GET", "/v1/leases", {}, scoped), failure(401));
  await assert.rejects(f.request("POST", `/v1/leases/${id}/credential`, {}, scoped), failure(401));
  for (const token of [f.hostToken, f.options.adminToken, key()]) await assert.rejects(f.request("GET", `/v1/leases/${id}`, {}, token), failure(401));
  f.store.transaction(db => {
    assert.equal(legacyLeaseAccess(db, id, f.app.credential).id, id);
    assert.throws(() => legacySessionLease(db, id, f.app.credential), failure(401));
    assert.equal(legacySessionLease(db, id, scoped).id, id);
  });
  const replacement = await f.scoped(id);
  await assert.rejects(f.request("GET", `/v1/leases/${id}`, {}, scoped), failure(401));
  const release = { id: randomUUID() }, ended = await f.request("POST", `/v1/leases/${id}/release`, release, replacement);
  assert.equal(ended.lease.state, "released"); assert.equal(ended.lease.cleanup.state, "pending");
  assert.deepEqual((await f.request("POST", `/v1/leases/${id}/release`, release)).mutation, ended.mutation);
  assert.equal((await f.request("POST", "/v1/leases", intent)).state, "released");
  f.store.transaction(db => {
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM machines").get()!.n, 1);
    const rows = JSON.stringify(db.prepare("SELECT * FROM leases").all());
    assert.ok(!rows.includes(replacement)); assert.ok(rows.includes(machineDigest(replacement)));
  });
});

test("renewal exact expiry, original receipts, monotone deadlines and restart reservation retention", async t => {
  const f = leaseFixture(t), lease = await f.request("POST", "/v1/leases", f.acquire({ ttlSeconds: 60 })), route = `/v1/leases/${lease.id}`;
  f.ready(lease); const ready = await f.request("GET", route); assert.equal(ready.state, "ready");
  f.advance(10);
  const renewal = { id: randomUUID(), expectedRevision: ready.revision, ttlSeconds: 120 };
  const receipt = await f.request("POST", route + "/renew", renewal);
  assert.equal(receipt.lease.expiresAt, "1970-01-01T00:18:50Z");
  const shorter = await f.request("POST", route + "/renew", { id: randomUUID(), expectedRevision: receipt.lease.revision, ttlSeconds: 1 });
  assert.equal(shorter.lease.expiresAt, receipt.lease.expiresAt);
  const replay = await f.request("POST", route + "/renew", renewal);
  assert.deepEqual(replay.mutation, receipt.mutation); assert.equal(replay.lease.revision, shorter.lease.revision);
  await assert.rejects(f.request("POST", route + "/renew", { ...renewal, ttlSeconds: 121 }), failure(409));
  await assert.rejects(f.request("POST", route + "/renew", { ...renewal, id: randomUUID() }), failure(409));
  f.setNow(1130);
  await assert.rejects(f.request("POST", route + "/renew", { id: randomUUID(), expectedRevision: shorter.lease.revision, ttlSeconds: 120 }), failure(409));
  const restored = new SqliteStore(f.store.path, f.now); new LegacyLeases(restored, f.options);
  const expired = await f.request("GET", route); assert.equal(expired.state, "expired"); assert.equal(expired.runtimeState, "unknown");
  f.beat({ reports: { [lease.members[0].machineId]: { state: "stopped" } } });
  assert.equal((await f.request("GET", route)).state, "expired");
  f.store.transaction(db => assert.deepEqual(f.leases.machines.used(db, f.host), { cpu: 1, memoryMiB: 1024, diskGiB: 4 }));
  assert.deepEqual((await f.request("POST", route + "/renew", renewal)).mutation, receipt.mutation);
});

test("admission rollback, active quotas and held resource quotas through cleanup", async t => {
  const f = leaseFixture(t), app = f.application({ activeLeases: 1 }), intent = f.acquire();
  const result = await Promise.allSettled([f.request("POST", "/v1/leases", intent, app.credential), f.request("POST", "/v1/leases", f.acquire(), app.credential)]);
  assert.equal(result.filter(r => r.status === "fulfilled").length, 1);
  assert.ok(result.some(r => r.status === "rejected" && failure(429)(r.reason)));
  const limited = f.application({ resources: { cpu: 2, memoryMiB: 2048, diskGiB: 4 } });
  const lease = await f.request("POST", "/v1/leases", f.acquire(), limited.credential), route = `/v1/leases/${lease.id}`;
  await f.request("POST", route + "/release", { id: randomUUID() }, limited.credential);
  f.beat({ reports: { [lease.members[0].machineId]: { state: "stopped" } } });
  await assert.rejects(f.request("POST", "/v1/leases", f.acquire(), limited.credential), failure(429));
  f.store.transaction(db => assert.equal(db.prepare("SELECT COUNT(*) AS n FROM machines").get()!.n, 2));
  const ended = await f.request("GET", route, {}, limited.credential), cleanup = ended.members[0].cleanup;
  f.beat({ reports: { [lease.members[0].machineId]: { state: "stopped", leaseCleanup: { id: cleanup.id, leaseId: lease.id, state: "complete", attempt: 1,
    executionStopped: true, storageRemoved: true, credentialsErased: true } } } });
  assert.equal((await f.request("GET", route, {}, limited.credential)).cleanup.state, "complete");
  assert.equal((await f.request("POST", "/v1/leases", f.acquire(), limited.credential)).state, "provisioning");
});

test("explicit image eligibility, readiness, revocation, provisioning failure and fence receipts", async t => {
  const f = leaseFixture(t);
  const catalogue = await f.request("GET", "/v1/environments/templates");
  assert.equal(catalogue.templates[0].available, true); assert.equal(catalogue.templates[0].hostId, undefined);
  await assert.rejects(f.request("POST", "/v1/leases", f.acquire({ requiredCapabilities: ["displayStream"] })), failure(409, "capability_unsupported"));
  for (const patch of [{ leaseImages: [] }, { leaseProtocol: undefined }]) {
    f.changeOffer(patch); f.beat();
    assert.equal((await f.request("GET", "/v1/environments/templates")).templates[0].available, false);
    await assert.rejects(f.request("POST", "/v1/leases", f.acquire()), failure(503, "capacity_unavailable"));
  }
  f.changeOffer({ leaseProtocol: 1, leaseImages: [{ id: f.image.id, revision: "1", arch: "amd64", runtime: "libvirt" }] }); f.beat();
  const failed = await f.request("POST", "/v1/leases", f.acquire({ ttlSeconds: 1800 }));
  f.advance(900); assert.equal((await f.request("GET", `/v1/leases/${failed.id}`)).state, "failed"); f.beat();
  const revoked = await f.request("POST", "/v1/leases", f.acquire()), token = await f.scoped(revoked.id);
  f.apps.revoke(f.app.id);
  await assert.rejects(f.request("GET", `/v1/leases/${revoked.id}`, {}, token), failure(401));
  f.store.transaction(db => assert.equal(db.prepare("SELECT state FROM leases WHERE id=?").get(revoked.id)!.state, "released"));
  const fenced = await f.request("POST", "/v1/leases", f.acquire(), f.other.credential);
  f.beat({ reports: { [fenced.members[0].machineId]: { state: "unknown", leaseFenced: true } } });
  assert.equal((await f.request("GET", `/v1/leases/${fenced.id}`, {}, f.other.credential)).state, "failed");
});

test("eligibility compares full pinned definitions and separate architecture/runtime selectors", t => {
  const f = leaseFixture(t), normalized = f.store.transaction(db => JSON.parse(String(db.prepare("SELECT offer FROM hosts WHERE id=?").get(f.host)!.offer)));
  const image = normalized.templates[0]; assert.equal(leaseEligible(normalized, image), true);
  for (const changed of [{ ...image, revision: "2" }, { ...image, arch: "arm64" }, { ...image, minimum: { ...image.minimum, cpu: 2 } }]) assert.equal(leaseEligible(normalized, changed), false);
  assert.equal(leaseEligible({ ...normalized, leaseProtocol: undefined }, image), false);
  assert.equal(leaseEligible({ ...normalized, leaseImages: [{ ...normalized.leaseImages[0], runtime: "apple" }] }, image), false);
  f.store.transaction(db => refreshLegacyLeases(db, f.now()));
});

test("lease readiness follows current image eligibility without releasing held capacity", async t => {
  const f = leaseFixture(t), lease = await f.request("POST", "/v1/leases", f.acquire());
  const route = `/v1/leases/${lease.id}`, selectors = f.offer().leaseImages;
  f.changeOffer({ leaseImages: [] });
  f.ready(lease);
  let view = await f.request("GET", route);
  assert.equal(view.runtimeState, "running");
  assert.equal(view.state, "provisioning");
  assert.equal(view.members[0].ready, false);
  f.changeOffer({ leaseImages: selectors }); f.beat();
  view = await f.request("GET", route);
  assert.equal(view.state, "ready"); assert.equal(view.members[0].ready, true);
  const revision = view.revision;
  f.changeOffer({ leaseImages: [] }); f.beat();
  view = await f.request("GET", route);
  assert.equal(view.state, "ready"); assert.equal(view.revision, revision);
  assert.equal(view.members[0].ready, false);
  assert.equal(view.cleanup.state, "notRequested");
  assert.equal((await f.request("GET", "/v1/leases")).leases[0].members[0].ready, false);
  f.store.transaction(db => assert.deepEqual(f.leases.machines.used(db, f.host), { cpu: 1, memoryMiB: 1024, diskGiB: 4 }));
  f.changeOffer({ leaseImages: selectors }); f.beat();
  assert.equal((await f.request("GET", route)).members[0].ready, true);
  f.advance(30);
  view = await f.request("GET", route);
  assert.equal(view.runtimeState, "unknown"); assert.equal(view.members[0].ready, false);
});

test("disabled hosts and stopped intent cannot promote a lease from a running report", async t => {
  for (const condition of ["disabled", "stopped"] as const) {
    const f = leaseFixture(t), lease = await f.request("POST", "/v1/leases", f.acquire());
    const route = `/v1/leases/${lease.id}`;
    f.store.transaction(db => {
      if (condition === "disabled") db.prepare("UPDATE hosts SET enabled=0 WHERE id=?").run(f.host);
      else db.prepare("UPDATE machines SET desired='stopped' WHERE id=?").run(lease.members[0].machineId);
    });
    f.ready(lease);
    const view = await f.request("GET", route);
    assert.equal(view.state, "provisioning", condition);
    assert.equal(view.members[0].ready, false, condition);
    f.store.transaction(db => {
      if (condition === "disabled") db.prepare("UPDATE hosts SET enabled=1 WHERE id=?").run(f.host);
      else db.prepare("UPDATE machines SET desired='running' WHERE id=?").run(lease.members[0].machineId);
    });
    const restored = await f.request("GET", route);
    assert.equal(restored.state, "ready", condition);
    assert.equal(restored.members[0].ready, true, condition);
  }
});

test("UUID pagination and generic/Linux route ownership never depend on credential success", async t => {
  const f = leaseFixture(t), ids: string[] = [];
  for (let i = 0; i < 101; ++i) ids.push((await f.request("POST", "/v1/leases", f.acquire())).id);
  ids.sort(); const page = await f.request("GET", "/v1/leases");
  assert.deepEqual(page.leases.map((l: any) => l.id), ids.slice(0, 100)); assert.equal(page.nextCursor, ids[99]);
  assert.deepEqual((await f.request("GET", `/v1/leases?after=${page.nextCursor}`)).leases.map((l: any) => l.id), ids.slice(100));
  const id = randomUUID();
  assert.equal(await f.raw("GET", `/v1/leases/${id}`, {}, key()), undefined);
  const generic = ids[0]!;
  await assert.rejects(f.raw("GET", `/v1/leases/${generic}`, {}, key()), failure(401));
  await assert.rejects(f.request("POST", `/v1/leases/${generic}/renew`, { id: randomUUID(), expectedRevision: true, ttlSeconds: 1 }), failure(400));
});

test("public schema rejects nulls, booleans, unknown fields and retains fractional controller deadlines", async t => {
  const f = leaseFixture(t);
  for (const extra of [{ ttlSeconds: null }, { ttlSeconds: true }, { requiredCapabilities: null }, { resources: null }, { name: null },
    { templateRevision: null }, { arch: null }, { hostId: randomUUID() }, { requiredCapabilities: ["pty", "pty"] }, { resources: { cpu: true } }]) {
    await assert.rejects(f.request("POST", "/v1/leases", f.acquire(extra)), failure(400));
  }
  f.setNow(1000.123456); f.beat();
  const lease = await f.request("POST", "/v1/leases", f.acquire({ ttlSeconds: 1 }));
  assert.equal(lease.createdAt, "1970-01-01T00:16:40.123456Z"); assert.equal(lease.expiresAt, "1970-01-01T00:16:41.123456Z");
  f.setNow(1001.123455); assert.equal((await f.request("GET", `/v1/leases/${lease.id}`)).state, "provisioning");
  f.setNow(1001.123456); assert.equal((await f.request("GET", `/v1/leases/${lease.id}`)).state, "expired");
});
