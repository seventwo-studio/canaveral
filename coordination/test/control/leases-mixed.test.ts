import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { RunnerEnrollment } from "../../src/enrollment.ts";
import { ResourceDomains } from "../../src/resource-domains.ts";
import { failure, key, leaseFixture } from "./leases-fixture.test.ts";

function mixedFixture(t: Parameters<typeof leaseFixture>[0]) {
  const f = leaseFixture(t), linux = f.leases.linux, domains = new ResourceDomains();
  const image = { id: "linux-slice", revision: "1", arch: "amd64", os: "linux", mode: "headless", backend: "kubevirt", digest: "sha256:" + "cd".repeat(32),
    resources: { cpu: 1, memoryMiB: 1024, diskGiB: 4 }, capabilities: ["command", "files", "pty"] };
  linux.image(image);
  const domain = randomUUID();
  f.store.transaction(db => domains.define(db, { id: domain, name: "disposable domain", capacity: { cpu: 512, memoryMiB: 1048576, diskGiB: 4096 } }, f.now()));
  const runners = new RunnerEnrollment(f.store, f.options.controllerId), binding = { controllerId: f.options.controllerId, runnerId: randomUUID(), generation: 1, incarnationId: randomUUID() };
  const enrollmentId = randomUUID(), credential = key();
  const issued = runners.issue({ id: enrollmentId, ...binding, ttlSeconds: 60 }) as { enrollmentToken: string };
  runners.consume(issued.enrollmentToken, { id: enrollmentId, ...binding, credential });
  linux.approve({ binding, domainId: domain, backend: image.backend, images: [{ id: image.id, revision: "1", arch: "amd64", digest: image.digest }] });
  const grant = (app: { id: string }) => linux.grant({ applicationId: app.id, imageId: image.id, revision: "1", arch: "amd64", digest: image.digest });
  const intent = () => ({ id: randomUUID(), templateId: image.id, templateRevision: "1", arch: "amd64", ttlSeconds: 120 });
  const createLinux = (token = f.app.credential) => linux.acquire(token, intent()).lease as any;
  grant(f.app); grant(f.other);
  return { ...f, linux, runners, binding, credential, grant, intent, createLinux, domain };
}

test("one active application lease limit is shared bidirectionally across both admission ledgers", async t => {
  const f = mixedFixture(t);
  const genericFirst = f.application({ activeLeases: 1 }); f.grant(genericFirst);
  await f.request("POST", "/v1/leases", f.acquire(), genericFirst.credential);
  assert.throws(() => f.createLinux(genericFirst.credential), failure(429));
  const linuxFirst = f.application({ activeLeases: 1 }); f.grant(linuxFirst);
  f.createLinux(linuxFirst.credential);
  await assert.rejects(f.request("POST", "/v1/leases", f.acquire(), linuxFirst.credential), failure(429));
  // Each application's own slot remains independent of the other's usage.
  const separate = f.application({ activeLeases: 1 }); f.grant(separate);
  assert.equal(f.createLinux(separate.credential).state, "provisioning");
  f.store.transaction(db => {
    assert.equal(db.prepare("SELECT count(*) AS n FROM machines").get()!.n, 1);
    assert.equal(db.prepare("SELECT count(*) AS n FROM linux_leases").get()!.n, 2);
  });
});

test("held terminal reservations count against both application quota paths until matching cleanup", async t => {
  const f = mixedFixture(t), limits = { resources: { cpu: 1, memoryMiB: 1024, diskGiB: 4 } };
  const genericOwner = f.application(limits); f.grant(genericOwner);
  const generic = await f.request("POST", "/v1/leases", f.acquire(), genericOwner.credential);
  await f.request("POST", `/v1/leases/${generic.id}/release`, { id: randomUUID() }, genericOwner.credential);
  f.beat({ reports: { [generic.members[0].machineId]: { state: "stopped" } } });
  assert.throws(() => f.createLinux(genericOwner.credential), failure(429));
  const pending = await f.request("GET", `/v1/leases/${generic.id}`, {}, genericOwner.credential);
  f.beat({ reports: { [generic.members[0].machineId]: { state: "stopped", leaseCleanup: { id: pending.members[0].cleanup.id, leaseId: generic.id, state: "complete", attempt: 1,
    executionStopped: true, storageRemoved: true, credentialsErased: true } } } });
  assert.equal(f.createLinux(genericOwner.credential).state, "provisioning");

  const linuxOwner = f.application(limits); f.grant(linuxOwner);
  const native = f.createLinux(linuxOwner.credential);
  // Claim every queued Linux fixture assignment so this lease has a real held execution reservation.
  let claimed = false;
  for (let i = 0; i < 3 && !claimed; i++) {
    const result = f.linux.claim(f.credential, { binding: f.binding, claimId: randomUUID() }) as { assignment: { leaseId: string } | null };
    claimed = result.assignment?.leaseId === native.id;
  }
  assert.equal(claimed, true);
  f.linux.mutate(linuxOwner.credential, native.id, "release", { id: randomUUID() });
  await assert.rejects(f.request("POST", "/v1/leases", f.acquire(), linuxOwner.credential), failure(429));
  f.store.transaction(db => assert.equal(db.prepare("SELECT state FROM resource_reservations WHERE owner=?").get(native.id)!.state, "held"));
  // Never-claimed terminal Linux reservations are positively released and do not keep charging quotas.
  const unstarted = f.application(limits); f.grant(unstarted);
  const lease = f.createLinux(unstarted.credential);
  f.linux.mutate(unstarted.credential, lease.id, "release", { id: randomUUID() });
  assert.equal((await f.request("POST", "/v1/leases", f.acquire(), unstarted.credential)).state, "provisioning");
});

test("mixed application UUID pages expose both ledgers and tombstones without foreign receipts", async t => {
  const f = mixedFixture(t), ids: string[] = [];
  for (let i = 0; i < 101; ++i) {
    const lease = i % 2 ? f.createLinux() : await f.request("POST", "/v1/leases", f.acquire());
    ids.push(lease.id);
  }
  f.createLinux(f.other.credential);
  await f.request("POST", "/v1/leases", f.acquire(), f.other.credential);
  const firstId = ids[0]!;
  await f.request("POST", `/v1/leases/${firstId}/release`, { id: randomUUID() });
  ids.sort();
  const first = await f.request("GET", "/v1/leases");
  assert.deepEqual(first.leases.map((lease: any) => lease.id), ids.slice(0, 100));
  assert.equal(first.nextCursor, ids[99]);
  const last = await f.request("GET", `/v1/leases?after=${first.nextCursor}`);
  assert.deepEqual(last.leases.map((lease: any) => lease.id), ids.slice(100)); assert.equal(last.nextCursor, null);
  assert.deepEqual(f.linux.list(f.app.credential, undefined), first);
  assert.equal((await f.request("GET", "/v1/leases", {}, f.other.credential)).leases.length, 2);
  assert.throws(() => f.linux.acquire(f.app.credential, { ...f.intent(), id: firstId }), failure(409));
  // Same generic HTTP path and request shape must fall through to the existing Linux controller.
  assert.equal(await f.raw("POST", "/v1/leases", f.intent()), undefined);
  const recovered = first.leases.find((lease: any) => lease.id === firstId) ?? last.leases.find((lease: any) => lease.id === firstId);
  assert.equal(recovered.state, "released");
});

test("mixed catalogues include both permitted namespaces and overlapping images resolve from app policy", async t => {
  const f = mixedFixture(t);
  const catalogue = await f.request("GET", "/v1/environments/templates");
  assert.deepEqual(catalogue.templates.map((image: any) => image.id), [f.image.id, "linux-slice"]);
  // Installed generic inventory for another application's image does not mask a Linux-only grant.
  const overlapping = { id: f.image.id, revision: "1", arch: "amd64", os: "linux", mode: "headless", backend: "kubevirt", digest: "sha256:" + "ef".repeat(32),
    resources: { cpu: 1, memoryMiB: 1024, diskGiB: 4 }, capabilities: ["command"] };
  f.linux.image(overlapping);
  const linuxOnly = f.application({}, []);
  f.linux.grant({ applicationId: linuxOnly.id, imageId: overlapping.id, revision: "1", arch: "amd64", digest: overlapping.digest });
  assert.equal(await f.raw("POST", "/v1/leases", f.acquire(), linuxOnly.credential), undefined);
  // An app permitted by both incompatible image contracts needs explicit operator resolution.
  f.linux.grant({ applicationId: f.app.id, imageId: overlapping.id, revision: "1", arch: "amd64", digest: overlapping.digest });
  await assert.rejects(f.raw("POST", "/v1/leases", f.acquire()), failure(409));
  await assert.rejects(f.request("GET", "/v1/environments/templates"), failure(409));
});
