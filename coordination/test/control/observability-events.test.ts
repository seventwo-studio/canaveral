import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { dropEventTriggers, EVENT_KINDS, installEventTriggers, pruneEvents, recordEvent, ROUTINE_KINDS } from "../../src/events.ts";
import { ServiceError } from "../../src/errors.ts";
import { failure } from "./leases-fixture.test.ts";
import { observabilityFixture } from "./observability-fixture.test.ts";

const kinds = (events: Array<{ kind: string }>) => events.map(event => event.kind);

test("lease lifecycle events are ordered, attributed and stamped with the transaction that changed the ledger", async t => {
  const f = observabilityFixture(t);
  assert.ok(f.captured.includes("lease_changed") && f.captured.includes("request_changed") && f.captured.includes("machine_changed"));
  const lease = await f.request("POST", "/v1/leases", f.acquire()), machine = lease.members[0].machineId;
  f.advance(10); f.ready(lease);
  f.advance(5);
  const ready = await f.request("GET", `/v1/leases/${lease.id}`);
  await f.request("POST", `/v1/leases/${lease.id}/renew`, { id: randomUUID(), expectedRevision: ready.revision, ttlSeconds: 600 });
  f.advance(20);
  await f.request("POST", `/v1/leases/${lease.id}/release`, { id: randomUUID() });
  const cleanup = (await f.request("GET", `/v1/leases/${lease.id}`)).members[0].cleanup;
  f.advance(2);
  f.beat({ reports: { [machine]: { state: "stopped", leaseCleanup: { id: cleanup.id, leaseId: lease.id, state: "blocked", attempt: 1, reason: "storage_removal" } } } });
  f.advance(3);
  f.beat({ reports: { [machine]: { state: "stopped", leaseCleanup: { id: cleanup.id, leaseId: lease.id, state: "complete", attempt: 2, executionStopped: true, storageRemoved: true, credentialsErased: true } } } });
  const all = await f.events(), about = all.filter(event => event.leaseId === lease.id && event.kind.startsWith("lease."));
  assert.deepEqual(kinds(about), ["lease.admitted", "lease.ready", "lease.renewed", "lease.released", "lease.cleanup_blocked", "lease.cleanup_proven"]);
  assert.deepEqual(about.map(event => Date.parse(event.at) / 1000), [1000, 1010, 1015, 1035, 1037, 1040]);
  for (let i = 1; i < all.length; i++) assert.ok(all[i]!.sequence > all[i - 1]!.sequence);
  const admitted = about[0]!;
  assert.equal(admitted.applicationId, f.app.id); assert.equal(admitted.hostId, f.host); assert.equal(admitted.machineId, machine);
  assert.deepEqual(admitted.data, { ledger: "generic", member: "primary", templateId: f.image.id, templateRevision: "1", arch: "amd64", platform: "linux", expiresAt: "1970-01-01T00:18:40.000Z" });
  assert.equal(about[4]!.data.reason, "storage_removal"); assert.equal(about[4]!.data.attempts, 1);
  // The machine was placed before its lease row existed and observed running in the heartbeat that made the lease ready.
  const created = all.find(event => event.kind === "machine.created" && event.machineId === machine)!, running = all.find(event => event.kind === "machine.observed" && event.data.observed === "running")!;
  assert.ok(created.sequence < admitted.sequence); assert.ok(running.sequence < about[1]!.sequence);
  assert.equal(running.leaseId, lease.id); assert.equal(running.applicationId, f.app.id);
  // Nothing sensitive is captured: no credential, hash, command argument or result text.
  const scoped = await f.scoped(lease.id).catch(() => "");
  const encoded = JSON.stringify(all);
  for (const forbidden of [f.app.credential, f.hostToken, f.options.adminToken, ...(scoped ? [scoped] : [])]) assert.ok(!encoded.includes(forbidden));
  for (const event of all) assert.ok(Object.hasOwn(EVENT_KINDS, event.kind), event.kind);
});

test("a refused acquisition and a rolled-back change leave no ledger event", async t => {
  const f = observabilityFixture(t), small = f.application({ activeLeases: 1 });
  const first = await f.request("POST", "/v1/leases", f.acquire(), small.credential);
  const before = (await f.events()).length;
  await assert.rejects(f.request("POST", "/v1/leases", f.acquire(), small.credential), failure(429));
  const after = (await f.events()).slice(before);
  // The second machine and lease were rolled back with their events; only the refusal itself is recorded.
  assert.deepEqual(kinds(after), ["lease.refused"]);
  assert.equal(after[0]!.applicationId, small.id); assert.equal(after[0]!.data.code, "limit_exceeded"); assert.equal(after[0]!.data.status, 429);
  await assert.rejects(f.request("POST", "/v1/leases", f.acquire(), small.credential), failure(429));
  assert.equal((await f.events()).length, before + 1, "one refusal per application and code per minute");
  f.advance(61);
  await assert.rejects(f.request("POST", "/v1/leases", f.acquire(), small.credential), failure(429));
  assert.equal((await f.events("kind=lease.refused")).length, 2);
  // An unauthenticated or malformed acquisition is not recorded at all.
  await assert.rejects(f.request("POST", "/v1/leases", f.acquire(), f.hostToken), failure(401));
  await assert.rejects(f.request("POST", "/v1/leases", { ...f.acquire(), arch: "riscv" }, small.credential), failure(400));
  assert.equal((await f.events("kind=lease.refused")).length, 2);
  const count = (await f.events()).length;
  assert.throws(() => f.store.transaction(db => {
    db.prepare("UPDATE leases SET state='failed' WHERE id=?").run(first.id);
    assert.equal(db.prepare("SELECT count(*) AS n FROM events WHERE kind='lease.failed'").get()!.n, 1);
    throw new ServiceError("abandon this change", 409);
  }), failure(409));
  assert.equal((await f.events()).length, count);
  assert.equal((await f.request("GET", `/v1/leases/${first.id}`, {}, small.credential)).state, "provisioning");
});

test("waiting requests record submission, admission, cancellation, expiry and rejection with their reasons", async t => {
  const f = observabilityFixture(t), app = f.application({ activeLeases: 1, maxWaitingRequests: 10 });
  const intent = { templateId: f.image.id, templateRevision: "1", arch: "amd64" };
  const submit = (extra: Record<string, unknown> = {}, credential = app.credential) => f.leases.requests.submit(credential, { id: randomUUID(), kind: "lease", intent, ...extra }).request.id;
  const admitted = submit(); f.leases.requests.pass();
  const waiting = submit(), expiring = submit({ deadline: new Date((f.now() + 30) * 1000).toISOString() }); f.leases.requests.pass();
  f.leases.requests.cancel(app.credential, waiting, {});
  f.advance(31); f.leases.requests.pass();
  // An image the application may not use is a permanent rejection with the acquisition's stable code.
  const denied = f.application({}, []), rejected = submit({}, denied.credential); f.leases.requests.pass();
  const events = await f.events("kind=request.*");
  const of = (id: string) => events.filter(event => event.requestId === id).map(event => [event.kind, event.data.reason ?? null]);
  assert.deepEqual(of(admitted), [["request.submitted", null], ["request.admitted", null]]);
  assert.deepEqual(of(waiting), [["request.submitted", null], ["request.cancelled", "consumer_cancelled"]]);
  assert.deepEqual(of(expiring), [["request.submitted", null], ["request.expired", "deadline"]]);
  assert.deepEqual(of(rejected), [["request.submitted", null], ["request.rejected", "forbidden"]]);
  const admission = events.find(event => event.kind === "request.admitted")!;
  assert.equal(admission.leaseId, admitted); assert.equal(admission.data.target, admitted);
  // Admission and the lease it created are one transaction: consecutive events with one timestamp.
  const lease = (await f.events("kind=lease.admitted")).find(event => event.leaseId === admitted)!;
  assert.equal(lease.at, admission.at); assert.ok(lease.sequence < admission.sequence);
  // A capacity or quota refusal keeps the request waiting and records nothing.
  assert.equal(events.filter(event => event.requestId === waiting).length, 2);
});

test("an application reads only its own events and never host inventory", async t => {
  const f = observabilityFixture(t);
  const mine = await f.request("POST", "/v1/leases", f.acquire()), theirs = await f.request("POST", "/v1/leases", f.acquire(), f.other.credential);
  f.ready(mine); f.beat({ reports: { [theirs.members[0].machineId]: { state: "running", accessReady: true } } });
  const own = await f.own(f.app.credential), other = await f.own(f.other.credential);
  assert.ok(own.length >= 3 && other.length >= 3);
  assert.ok(own.every(event => event.applicationId === f.app.id)); assert.ok(other.every(event => event.applicationId === f.other.id));
  assert.ok(own.some(event => event.leaseId === mine.id && event.kind === "lease.ready"));
  assert.ok(!JSON.stringify(own).includes(theirs.id)); assert.ok(!JSON.stringify(other).includes(mine.id));
  // The placement host is operator inventory.
  assert.ok(!JSON.stringify(own).includes(f.host));
  const page = (await f.call("GET", "/v1/events", {}, f.app.credential, undefined)).body as any;
  assert.equal(Object.hasOwn(page, "latestSequence"), false); assert.equal(Object.hasOwn(page, "oldestSequence"), false);
  // Naming another application's lease, or asking for an operator filter, yields nothing or a refusal.
  assert.deepEqual(await f.own(f.app.credential, `lease=${theirs.id}`), []);
  await assert.rejects(f.call("GET", `/v1/events?application=${f.other.id}`, {}, f.app.credential, undefined), failure(400));
  await assert.rejects(f.call("GET", `/v1/events?host=${f.host}`, {}, f.app.credential, undefined), failure(400));
  // Only the application credential is accepted: not a lease key, host key or operator credential.
  const scoped = await f.scoped(mine.id);
  for (const token of [scoped, f.hostToken, f.options.adminToken]) await assert.rejects(f.call("GET", "/v1/events", {}, token, undefined), failure(401));
  // The operator view is not open to an application credential.
  await assert.rejects(f.call("GET", "/v1/admin/events", {}, f.app.credential), (error: any) => error.status === 401);
  const admin = await f.events();
  assert.ok(admin.some(event => event.leaseId === mine.id) && admin.some(event => event.leaseId === theirs.id));
  assert.ok(admin.some(event => event.hostId === f.host));
});

test("cursor, tail, kind and subject filters page the log and refuse unknown kinds", async t => {
  const f = observabilityFixture(t);
  const leases = [];
  for (let i = 0; i < 4; i++) leases.push(await f.request("POST", "/v1/leases", f.acquire()));
  const all = await f.events();
  const first = await f.admin("/v1/admin/events?limit=3");
  assert.equal(first.events.length, 3); assert.equal(first.more, true); assert.equal(first.cursor, first.events[2].sequence); assert.equal(first.truncated, false);
  assert.equal(first.latestSequence, all.at(-1)!.sequence);
  const rest = await f.admin(`/v1/admin/events?limit=500&after=${first.cursor}`);
  assert.equal(rest.more, false); assert.deepEqual([...first.events, ...rest.events].map((e: any) => e.sequence), all.map(e => e.sequence));
  assert.deepEqual((await f.admin(`/v1/admin/events?after=${rest.cursor}`)).events, []);
  const tail = await f.admin("/v1/admin/events?tail=2&kind=lease.admitted");
  assert.deepEqual(tail.events.map((e: any) => e.leaseId), leases.slice(2).map(l => l.id)); assert.equal(tail.cursor, first.latestSequence);
  // A filtered read that reaches the end moves the cursor to the head, so a follower does not rescan what cannot match.
  const sparse = await f.admin("/v1/admin/events?kind=host.offline&after=1");
  assert.deepEqual([sparse.events.length, sparse.more, sparse.cursor, sparse.truncated], [0, false, first.latestSequence, false]);
  assert.deepEqual(kinds(await f.events("kind=lease.*")), ["lease.admitted", "lease.admitted", "lease.admitted", "lease.admitted"]);
  assert.deepEqual((await f.events(`kind=lease.admitted,machine.created&lease=${leases[1].id}`)).map(e => e.kind), ["lease.admitted"]);
  assert.equal((await f.events(`machine=${leases[0].members[0].machineId}`)).length, 2);
  assert.equal((await f.events(`since=${new Date((f.now() + 1) * 1000).toISOString()}`)).length, 0);
  for (const query of ["kind=lease.unheard", "kind=nothing.*", "limit=501", "limit=0", "after=-1", "after=1&tail=1", "since=yesterday", "unexpected=1", "after=1&after=2"]) {
    await assert.rejects(f.admin("/v1/admin/events?" + query), failure(400), query);
  }
  await assert.rejects(f.admin("/v1/admin/events?kind=lease.unheard"), failure(400, "event_kind_unknown"));
});

test("retention bounds the log by age, by a schema row cap and by a separate routine tier", async t => {
  const f = observabilityFixture(t, { eventRetentionSeconds: 3600, eventMaxRows: 1000 });
  const fill = (kind: string, n: number) => f.store.transaction(db => { for (let i = 0; i < n; i++) recordEvent(db, kind, { subject: String(i) }); });
  fill("host.enrolled", 5); f.advance(3000); fill("host.online", 5); f.advance(1000);
  f.observability.maintain(true);
  assert.deepEqual([...new Set(kinds(await f.events()))], ["host.online"], "events older than the age limit are removed, newer ones kept");
  // The cap is a trigger on insert: it holds inside the writing transaction, for any writer.
  fill("host.accepting", 1500);
  f.store.transaction(db => assert.equal(db.prepare("SELECT count(*) AS n FROM events").get()!.n, 1000));
  const page = await f.admin("/v1/admin/events?after=1&limit=1");
  assert.equal(page.truncated, true, "a cursor older than retained history is reported, not silently skipped");
  assert.ok(page.oldestSequence > 2);
  // Routine successes are capped at a tenth of the log so they cannot displace everything else.
  assert.deepEqual(ROUTINE_KINDS, ["lease.refused", "operation.succeeded"]);
  fill("operation.succeeded", 400);
  f.observability.maintain(true);
  f.store.transaction(db => {
    assert.equal(db.prepare("SELECT count(*) AS n FROM events WHERE kind='operation.succeeded'").get()!.n, 100);
    assert.equal(db.prepare("SELECT count(*) AS n FROM events WHERE kind='host.accepting'").get()!.n, 600);
    assert.equal(pruneEvents(db, f.now(), { maxAgeSeconds: 3600, maxRows: 1000, routineMaxRows: 100 }), 0);
  });
  // A sequence is never reused, even after the newest rows are removed.
  const latest = (await f.admin("/v1/admin/events?tail=1")).cursor;
  f.store.transaction(db => db.exec("DELETE FROM events"));
  fill("host.online", 1);
  assert.equal((await f.events())[0]!.sequence, latest + 1);
});

test("capture survives reinstall, skips tables this database lacks and tolerates foreign rows", async t => {
  const f = observabilityFixture(t), lease = await f.request("POST", "/v1/leases", f.acquire());
  f.store.transaction(db => {
    const again = installEventTriggers(db);
    assert.deepEqual(again, f.captured);
    assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='trigger' AND name LIKE 'canaveral_event_%'").get()!.n, again.length + 1);
    // Tables another module would create are absent here: their triggers are not installed, and nothing fails.
    assert.ok(!again.includes("update_job_changed") && !again.includes("video_session_changed"));
    // Rows that are not the controller's JSON still pass through capture without failing their write.
    db.prepare("INSERT INTO device_operations VALUES (?,?,?,?,'queued',NULL,?,?)").run("op-1", "m", f.host, "not json", f.now(), f.now());
    db.prepare("UPDATE device_operations SET state='unknown' WHERE id='op-1'").run();
    db.prepare("INSERT INTO host_health(host,report,received) VALUES (?,?,?) ON CONFLICT(host) DO UPDATE SET report=excluded.report").run(f.host, "{broken", f.now());
  });
  const unknown = (await f.events("kind=operation.unknown"))[0]!;
  assert.equal(unknown.data.operationId, "op-1"); assert.equal(Object.hasOwn(unknown.data, "action"), false);
  // A trigger pins the columns it reads. A migration drops capture first; a trigger that no longer fits is left out at reinstall.
  // The schema change is made inside a transaction that is abandoned, so the fixture's own modules keep their columns.
  assert.throws(() => f.store.transaction(db => {
    assert.throws(() => db.exec("ALTER TABLE leases DROP COLUMN cleanup"), /error in trigger canaveral_event_lease_changed/);
    dropEventTriggers(db);
    assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='trigger' AND name LIKE 'canaveral_event_%'").get()!.n, 0);
    db.exec("ALTER TABLE lease_cleanup_members DROP COLUMN reason");
    const fitted = installEventTriggers(db);
    assert.deepEqual(f.captured.filter(name => !fitted.includes(name)), ["lease_changed"], "only the trigger whose body reads the dropped column is left out");
    // Writes to that table keep working without capture; every other table is still captured.
    const before = Number(db.prepare("SELECT count(*) AS n FROM events").get()!.n);
    db.prepare("UPDATE leases SET state='failed' WHERE id=?").run(lease.id);
    assert.equal(db.prepare("SELECT count(*) AS n FROM events").get()!.n, before);
    db.prepare("UPDATE hosts SET enabled=0 WHERE id=?").run(f.host);
    assert.equal(db.prepare("SELECT kind FROM events ORDER BY seq DESC LIMIT 1").get()!.kind, "host.draining");
    throw new ServiceError("restore the schema", 409);
  }), failure(409));
  f.store.transaction(db => assert.deepEqual(installEventTriggers(db), f.captured));
});
