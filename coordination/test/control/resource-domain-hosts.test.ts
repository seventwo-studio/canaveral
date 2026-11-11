import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { CapacityLedger } from "../../src/capacity.ts";
import { ResourceDomains } from "../../src/resource-domains.ts";
import { failure, leaseFixture } from "./leases-fixture.test.ts";

const amount = { cpu: 1, memoryMiB: 1024, diskGiB: 4 };
function setup(t: Parameters<typeof leaseFixture>[0], capacity = amount) {
  const f = leaseFixture(t), domains = new ResourceDomains(f.now), ledger = new CapacityLedger(f.store), domain = randomUUID();
  f.store.transaction(db => domains.define(db, { id: domain, name: "shared fixture", capacity }, f.now()));
  const bind = () => f.store.transaction(db => domains.bindHost(db, { hostId: f.host, domainId: domain }, f.now()));
  const reserve = () => f.store.transaction(db => domains.reserve(db, { id: randomUUID(), domain, kind: "model-job", owner: randomUUID(), resources: amount }, f.now()));
  const view = () => f.store.transaction(db => domains.view(db, domain));
  return { ...f, domains, ledger, domain, bind, reserve, view };
}

test("bound host leases and runner reservations cannot spend the same capacity in either order", async t => {
  for (const hostFirst of [true, false]) {
    const f = setup(t); f.bind();
    if (hostFirst) {
      await f.request("POST", "/v1/leases", f.acquire());
      assert.equal(f.reserve(), false);
    } else {
      assert.equal(f.reserve(), true);
      await assert.rejects(f.request("POST", "/v1/leases", f.acquire()), failure(503, "capacity_unavailable"));
    }
    assert.deepEqual(f.view().reserved, amount);
    assert.deepEqual(f.store.transaction(db => f.ledger.used(db, f.host)), amount);
    assert.deepEqual(f.store.transaction(db => f.leases.machines.used(db, f.host)), amount);
    assert.deepEqual(f.view().available, { cpu: 0, memoryMiB: 0, diskGiB: 0 });
  }
});

test("binding includes existing reservations, replays exactly and rejects moving or overcommitting them", async t => {
  const f = setup(t); await f.request("POST", "/v1/leases", f.acquire());
  assert.equal(f.reserve(), true, "unbound ledgers are still independent");
  assert.throws(f.bind, failure(409));
  f.store.transaction(db => assert.equal(db.prepare("SELECT count(*) AS n FROM resource_domain_hosts").get()!.n, 0));
  f.store.transaction(db => {
    const reservation = db.prepare("SELECT id,owner FROM resource_reservations WHERE domain=?").get(f.domain)!;
    f.domains.release(db, String(reservation.id), String(reservation.owner), f.now());
  });
  const binding = f.bind(); assert.deepEqual(f.bind(), binding);
  assert.deepEqual(f.view().reserved, amount);
  f.store.transaction(db => {
    const second = randomUUID(); f.domains.define(db, { id: second, name: "other", capacity: amount }, f.now());
    assert.throws(() => f.domains.bindHost(db, { hostId: f.host, domainId: second }, f.now()), failure(409));
    assert.throws(() => f.domains.bindHost(db, { hostId: randomUUID(), domainId: f.domain }, f.now()), failure(409));
    assert.throws(() => f.domains.bindHost(db, { hostId: f.host, domainId: f.domain, extra: true }, f.now()), failure(400));
  });
});

test("bound runner admission respects live host headroom, offline state, draining and health", t => {
  const f = setup(t, { cpu: 10, memoryMiB: 10240, diskGiB: 40 }); f.bind();
  f.ledger.save(f.host, { limits: amount });
  assert.deepEqual(f.view().capacity, amount);
  assert.equal(f.reserve(), true); assert.equal(f.reserve(), false);
  f.store.transaction(db => {
    const row = db.prepare("SELECT id,owner FROM resource_reservations WHERE domain=?").get(f.domain)!;
    f.domains.release(db, String(row.id), String(row.owner), f.now());
  });
  f.advance(30); assert.equal(f.reserve(), false); assert.deepEqual(f.view().reserved, { cpu: 0, memoryMiB: 0, diskGiB: 0 });
  f.beat();
  f.store.transaction(db => db.prepare("UPDATE hosts SET enabled=0 WHERE id=?").run(f.host));
  assert.equal(f.reserve(), false);
  f.store.transaction(db => {
    db.prepare("UPDATE hosts SET enabled=1 WHERE id=?").run(f.host);
    db.exec("CREATE TABLE host_update_jobs (host TEXT, phase TEXT)");
    db.prepare("INSERT INTO host_update_jobs VALUES (?,'activating')").run(f.host);
  });
  assert.equal(f.reserve(), false);
  assert.deepEqual(f.store.transaction(db => f.ledger.remaining(db, f.host)), { cpu: 0, memoryMiB: 0, diskGiB: 0 }, "drain also blocks new host-side image reservations");
  assert.deepEqual(f.bind(), { hostId: f.host, domainId: f.domain }, "replaying the binding is not new admission");
  f.store.transaction(db => db.prepare("UPDATE host_update_jobs SET phase='succeeded'").run());
  f.beat({ health: { status: "failed", checkedAt: f.now() } });
  assert.equal(f.reserve(), false);
  f.beat({ health: { status: "passed", checkedAt: f.now() } });
  assert.equal(f.reserve(), true);
  f.store.transaction(db => db.prepare("DELETE FROM hosts WHERE id=?").run(f.host));
  assert.equal(f.reserve(), false); assert.deepEqual(f.view().reserved, amount, "host disappearance never releases runner reservations");
  f.store.transaction(db => {
    const row = db.prepare("SELECT id,owner FROM resource_reservations WHERE domain=? AND state='held'").get(f.domain)!;
    f.domains.release(db, String(row.id), String(row.owner), f.now());
  });
  assert.deepEqual(f.view().reserved, { cpu: 0, memoryMiB: 0, diskGiB: 0 });
});

test("terminal host lease reservations stay shared until positive cleanup", async t => {
  const f = setup(t); f.bind();
  const lease = await f.request("POST", "/v1/leases", f.acquire()); f.ready(lease);
  const ended = await f.request("POST", `/v1/leases/${lease.id}/release`, { id: randomUUID() });
  assert.equal(f.reserve(), false);
  const cleanup = ended.lease.members[0].cleanup;
  f.beat({ reports: { [lease.members[0].machineId]: { state: "stopped", leaseCleanup: { id: cleanup.id, leaseId: lease.id, state: "complete", attempt: 1,
    executionStopped: true, storageRemoved: true, credentialsErased: true } } } });
  assert.equal(f.reserve(), true);
});
