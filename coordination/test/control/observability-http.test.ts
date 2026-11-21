import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import test from "node:test";
import { ConsumerClient, ConsumerServiceError } from "../../src/consumer-client.ts";
import { consumerApiSchema } from "../../src/contracts.ts";
import type { ControllerEvent } from "../../src/consumer-client.ts";
import { EVENT_KINDS, EVENT_TRIGGERS } from "../../src/events.ts";
import { controllerFixture, eventually, key, sleep } from "./observability-controller.test.ts";
import type { Json } from "./observability-controller.test.ts";

const kinds = (events: Json[]) => events.map(event => event.kind as string);

test("every capture trigger installs on the complete controller schema and both workers write stamped events", { timeout: 60_000 }, async t => {
  const f = await controllerFixture(t);
  const installed = f.sql(db => db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'canaveral_event_%'").all().map(row => String(row.name).slice("canaveral_event_".length)));
  // A trigger whose body does not fit the schema is dropped at install, so presence proves every body compiled.
  assert.deepEqual(installed.filter(name => name !== "row_cap").sort(), [...EVENT_TRIGGERS].sort());
  const started = Date.now();
  // Applications are created by the identity worker; hosts and leases by the control worker.
  const app = await f.application(), lease = await f.acquire(app.credential);
  await f.ready(lease);
  await f.call("POST", `/v1/hosts/${f.host}/accepting`, f.admin, { enabled: false });
  await f.call("POST", `/v1/hosts/${f.host}/accepting`, f.admin, { enabled: true });
  await f.call("POST", `/v1/hosts/${f.host}/limits`, f.admin, { limits: { cpu: 32, memoryMiB: 32768, diskGiB: 256 } });
  const drain = randomUUID();
  await f.call("POST", `/v1/hosts/${f.host}/maintenance`, f.admin, { id: drain }, 201);
  // Ledgers whose native flows this fixture cannot drive are written directly; capture is the same trigger either way.
  const session = randomUUID(), job = randomUUID(), rollout = randomUUID(), operation = randomUUID(), machine = lease.members[0].machineId, now = Date.now() / 1000;
  f.sql(db => {
    db.prepare("INSERT INTO mobile_video_sessions (id,machine,host,binding,generation,credential,host_credential,request,state,created,deadline,host_attached,consumer_attached,cleaned,lease,member) VALUES (?,?,?,?,?,?,NULL,'{}','pending',?,?,0,0,0,?,'primary')")
      .run(session, machine, f.host, "binding", randomUUID(), "CREDENTIAL-HASH", now, now + 60, lease.id);
    db.prepare("UPDATE mobile_video_sessions SET state='ready' WHERE id=?").run(session);
    db.prepare("UPDATE mobile_video_sessions SET state='finished',cleaned=1 WHERE id=?").run(session);
    db.prepare("INSERT INTO update_rollouts VALUES (?,?,?)").run(rollout, "{}", now);
    db.prepare("INSERT INTO host_update_jobs (id,rollout,host,target_kind,release,attempt,installation,credential,phase,components,created,updated) VALUES (?,?,?,'host','release-1',?,?,'CREDENTIAL-HASH','queued','{}',?,?)")
      .run(job, rollout, f.host, randomUUID(), randomUUID(), now, now);
    db.prepare("UPDATE host_update_jobs SET phase='downloading' WHERE id=?").run(job);
    db.prepare("UPDATE host_update_jobs SET phase='unknown',uncertain=1,detail='PROVIDER DETAIL TEXT' WHERE id=?").run(job);
    db.prepare("INSERT INTO device_operations (id,machine,host,request,state,result,updated,created) VALUES (?,?,?,?,'queued',NULL,?,?)").run(operation, machine, f.host, JSON.stringify({ id: operation, action: "install-uploaded", arguments: { artifact: "PRIVATE-ARGUMENT" } }), now, now);
    db.prepare("UPDATE device_operations SET state='unknown',result=? WHERE id=?").run(JSON.stringify({ detail: "PRIVATE-RESULT" }), operation);
    db.prepare("INSERT INTO device_operation_resolutions VALUES (?,?,'abandoned',NULL,'OPERATOR FREE TEXT','{}',?)").run(randomUUID(), operation, now);
  });
  const all = await f.events();
  for (const kind of ["controller.started", "application.created", "machine.created", "lease.admitted", "machine.observed", "lease.ready", "host.draining", "host.accepting", "host.limits_changed",
    "host.maintenance_began", "video.session_opened", "video.session_ready", "video.session_ended", "video.session_cleaned", "update.rollout_created", "update.job_queued", "update.job_phase",
    "update.job_uncertain", "install.unknown", "install.resolved"]) assert.ok(kinds(all).includes(kind), kind);
  for (const event of all) {
    assert.ok(Object.hasOwn(EVENT_KINDS, event.kind), event.kind);
    // Every event carries the committing worker's clock, including rows another connection inserted.
    const at = Date.parse(event.at); assert.ok(at >= started - 5000 && at <= Date.now() + 1000, event.at);
  }
  for (let i = 1; i < all.length; i++) assert.ok(all[i]!.sequence > all[i - 1]!.sequence);
  const created = all.find(event => event.kind === "application.created")!;
  assert.equal(created.applicationId, app.id); assert.equal(created.data.name, "Fixture application");
  assert.equal(all.find(event => event.kind === "host.maintenance_began")!.data.drainId, drain);
  assert.equal(all.find(event => event.kind === "video.session_opened")!.applicationId, app.id);
  assert.deepEqual(all.find(event => event.kind === "install.unknown")!.data, { operationId: operation, ledger: "device", action: "install-uploaded", state: "unknown", previous: "queued" });
  const uncertain = all.find(event => event.kind === "update.job_uncertain")!;
  assert.equal(uncertain.hostId, f.host); assert.equal(uncertain.data.uncertain, true); assert.equal(uncertain.data.releaseId, "release-1");
  const encoded = JSON.stringify(all);
  for (const forbidden of ["PRIVATE-ARGUMENT", "PRIVATE-RESULT", "PROVIDER DETAIL TEXT", "OPERATOR FREE TEXT", "CREDENTIAL-HASH", app.credential, f.hostToken, f.admin, f.enrollment]) assert.ok(!encoded.includes(forbidden), forbidden);
  assert.deepEqual((await f.call("GET", "/v1/admin/events/kinds")).kinds.map((entry: Json) => entry.kind), Object.keys(EVENT_KINDS));
});

test("the event stream resumes from a cursor without loss or repetition, in either scope", { timeout: 60_000 }, async t => {
  const f = await controllerFixture(t);
  const mine = await f.application(), theirs = await f.application();
  const live = f.follow("/v1/admin/events/stream?kind=lease.*");
  assert.equal(await live.opened, 200);
  const first = await f.acquire(mine.credential), second = await f.acquire(theirs.credential);
  await eventually(() => live.data(), events => events.length === 2);
  // Without a cursor the stream starts after the newest event: nothing older than the connection is replayed.
  assert.deepEqual(live.data().map(event => [event.kind, event.leaseId]), [["lease.admitted", first.id], ["lease.admitted", second.id]]);
  assert.deepEqual(live.messages.filter(message => message.event === undefined).map(message => message.id), live.data().map(event => String(event.sequence)));
  live.close();
  const cursor = live.data()[0]!.sequence as number;
  // While disconnected: three more lease events, among unrelated kinds.
  await f.ready(first);
  const third = await f.acquire(mine.credential);
  await f.call("POST", `/v1/leases/${first.id}/release`, mine.credential, { id: randomUUID() });
  const expected = (await f.events("kind=lease.*")).filter(event => event.sequence > cursor);
  assert.deepEqual(kinds(expected), ["lease.admitted", "lease.ready", "lease.admitted", "lease.released"]);
  // Last-Event-ID and `after` are the same cursor; each replays exactly what was missed, then stays live.
  const resumed = f.follow("/v1/admin/events/stream?kind=lease.*", f.admin, { "Last-Event-ID": String(cursor) }), queried = f.follow(`/v1/admin/events/stream?kind=lease.*&after=${cursor}`);
  assert.equal(await resumed.opened, 200); assert.equal(await queried.opened, 200);
  await eventually(() => resumed.data(), events => events.length === expected.length);
  await eventually(() => queried.data(), events => events.length === expected.length);
  assert.deepEqual(resumed.data(), expected); assert.deepEqual(queried.data(), expected);
  await f.call("POST", `/v1/leases/${third.id}/release`, mine.credential, { id: randomUUID() });
  await eventually(() => resumed.data(), events => events.length === expected.length + 1);
  assert.equal(resumed.data().at(-1)!.kind, "lease.released"); assert.equal(new Set(resumed.data().map(event => event.sequence)).size, expected.length + 1);
  resumed.close(); queried.close();

  // An application follows only itself, with its own credential.
  const own = f.follow("/v1/events/stream?after=0", mine.credential);
  assert.equal(await own.opened, 200);
  await eventually(() => own.data(), events => events.some(event => event.kind === "lease.released" && event.leaseId === third.id));
  assert.ok(own.data().every(event => event.applicationId === mine.id));
  assert.ok(!JSON.stringify(own.data()).includes(second.id) && !JSON.stringify(own.data()).includes(f.host));
  await f.acquire(theirs.credential); const fourth = await f.acquire(mine.credential);
  await eventually(() => own.data(), events => events.at(-1)?.leaseId === fourth.id);
  assert.ok(own.data().every(event => event.applicationId === mine.id));
  own.close();

  // Refusals are ordinary JSON errors before any stream begins.
  for (const [path, token, status] of [["/v1/admin/events/stream", mine.credential, 401], ["/v1/events/stream", f.admin, 401], ["/v1/events/stream", key(), 401], ["/v1/admin/events/stream?kind=lease.unheard", f.admin, 400],
    ["/v1/admin/events/stream?limit=5", f.admin, 400], ["/v1/events/stream?host=" + f.host, mine.credential, 400], ["/v1/admin/events/stream?after=x", f.admin, 400]] as const) {
    const reply = await f.raw("GET", path, token); assert.equal(reply.status, status, path); assert.ok(reply.type.startsWith("application/json")); assert.equal(typeof reply.body.code, "string");
  }
  assert.equal((await f.raw("GET", "/v1/admin/events/stream", f.admin, undefined, { Origin: "https://example.invalid" })).status, 403);
  assert.equal((await f.raw("GET", "/v1/admin/events/stream?token=" + f.admin, "")).status, 400);
  // A revoked application loses its stream at the next authorization round.
  const doomed = f.follow("/v1/events/stream", theirs.credential);
  assert.equal(await doomed.opened, 200);
  await f.call("POST", `/v1/consumers/${theirs.id}/revoke`, f.admin, {});
  const end = await eventually(() => doomed.messages.find(message => message.event === "end"), message => message !== undefined, 30_000);
  assert.equal(JSON.parse(end!.data).code, "unauthenticated");
});

test("a restart keeps the log, continues the sequence and resumes a follower from its cursor", { timeout: 60_000 }, async t => {
  const f = await controllerFixture(t), app = await f.application();
  const lease = await f.acquire(app.credential);
  const before = await f.events(), cursor = before.at(-1)!.sequence as number;
  // A follower is told why its stream ends before the sockets are dropped.
  const follower = f.follow("/v1/admin/events/stream");
  assert.equal(await follower.opened, 200);
  await eventually(() => follower.messages.filter(message => message.event === "open"), opens => opens.length === 1);
  await f.restart();
  const end = follower.messages.find(message => message.event === "end");
  assert.ok(end, "an end message arrived before the connection closed");
  assert.deepEqual(JSON.parse(end.data), { code: "controller_closing", cursor });
  await f.ready(lease);
  const after = await f.events();
  assert.deepEqual(after.slice(0, before.length), before, "history survives the restart unchanged");
  const fresh = after.slice(before.length);
  assert.equal(fresh[0]!.kind, "controller.started"); assert.equal(fresh[0]!.sequence, cursor + 1);
  assert.equal(kinds(after).filter(kind => kind === "controller.started").length, 2);
  assert.ok(kinds(fresh).includes("lease.ready"));
  const resumed = f.follow(`/v1/admin/events/stream?after=${cursor}`);
  assert.equal(await resumed.opened, 200);
  await eventually(() => resumed.data(), events => events.length === fresh.length);
  assert.deepEqual(resumed.data(), fresh);
  resumed.close();
});

test("an idle controller's timers never open a write connection", { timeout: 60_000 }, async t => {
  const f = await controllerFixture(t);
  // A write connection would recreate the database file. Remove it and let several timer rounds pass, including
  // the one a second after start. A fixture that removes its directory before it closes its controller depends
  // on this: a file that reappears during the removal fails it with ENOTEMPTY.
  unlinkSync(f.config.statePath);
  await sleep(2600);
  assert.deepEqual(readdirSync(dirname(f.config.statePath)).filter(name => name.startsWith("controller.sqlite")), []);
  // Nothing is left running after close either.
  await f.close();
  await sleep(1200);
  assert.deepEqual(readdirSync(dirname(f.config.statePath)).filter(name => name.startsWith("controller.sqlite")), []);
});

test("administrator routes need administrator authority and the consumer SDK reads only its application", { timeout: 60_000 }, async t => {
  const f = await controllerFixture(t), app = await f.application(), other = await f.application();
  const password = "disposable-observability-password";
  const administrator = await f.call("POST", "/v1/auth/setup", f.admin, { username: "administrator", password });
  const user = await f.call("POST", "/v1/users", administrator.token, { id: randomUUID(), username: "reader" });
  const claim = await f.call("POST", `/v1/users/${user.id}/invite`, administrator.token, {});
  const reader = await f.call("POST", "/v1/auth/claim", "", { token: claim.token, password });
  const routes = ["/v1/admin/events", "/v1/admin/events/kinds", "/v1/admin/usage", "/v1/admin/diagnosis", "/v1/admin/alerts/destinations", "/v1/admin/alerts/deliveries"];
  for (const route of routes) {
    assert.equal((await f.raw("GET", route, administrator.token)).status, 200, route);
    assert.equal((await f.raw("GET", route, reader.token)).status, 403, route);
    for (const token of [app.credential, f.hostToken, f.enrollment, key(), ""]) assert.equal((await f.raw("GET", route, token)).status, 401, route);
  }
  assert.equal((await f.raw("POST", "/v1/admin/alerts/destinations", reader.token, { id: randomUUID(), name: "n", type: "slack", url: "https://hooks.example.invalid/x" })).status, 403);
  assert.equal((await f.raw("GET", "/v1/events", administrator.token)).status, 401);
  assert.equal((await f.raw("GET", "/v1/usage", administrator.token)).status, 401);

  const lease = await f.acquire(app.credential); await f.acquire(other.credential);
  const client = new ConsumerClient({ baseUrl: f.url(), applicationKey: app.credential, allowLoopbackHttp: true });
  const page = await client.listEvents({ kinds: ["lease.*"] });
  assert.deepEqual(page.events.map(event => [event.kind, event.leaseId]), [["lease.admitted", lease.id]]);
  assert.equal(page.more, false); assert.ok(page.cursor > page.events[0]!.sequence, "the cursor is the head of the log, past the other application's events");
  assert.deepEqual((await client.listEvents({ after: page.cursor })).events.filter(event => event.kind.startsWith("lease.")), []);
  assert.equal((await client.listEvents({ tail: 1, leaseId: lease.id })).events.length, 1);
  await assert.rejects(client.listEvents({ kinds: ["lease.unheard"] }), (error: unknown) => error instanceof ConsumerServiceError && error.status === 400 && error.code === "event_kind_unknown");
  await assert.rejects(client.listEvents({ after: 1, tail: 1 }), /either after or tail/);
  const abort = new AbortController(), received: ControllerEvent[] = [];
  const following = (async () => { for await (const event of client.followEvents({ after: page.cursor, kinds: ["lease.*"], signal: abort.signal })) { received.push(event); if (event.kind === "lease.released") break; } })();
  await sleep(200);
  await f.ready(lease);
  await f.call("POST", `/v1/leases/${lease.id}/release`, app.credential, { id: randomUUID() });
  await following;
  assert.deepEqual(received.map(event => event.kind), ["lease.ready", "lease.released"]);
  assert.ok(received.every(event => event.applicationId === app.id && !("hostId" in event)));
  const usage = await client.usage({ groupBy: "template" });
  assert.equal(usage.applicationId, app.id); assert.equal(usage.totals.leases.admitted, 1); assert.equal(usage.totals.leases.released, 1);
  assert.deepEqual(usage.rows.map(row => row.key), ["fixture-image@1/amd64"]);
  await assert.rejects(client.usage({ groupBy: "host" as never }), /groupBy/);
  const csv = await f.raw("GET", "/v1/usage?format=csv", app.credential);
  assert.equal(csv.status, 200); assert.equal(csv.type, "text/csv; charset=utf-8");
  assert.ok(csv.text.startsWith("group,key,label,requests_submitted,")); assert.equal(csv.text.trim().split("\r\n").length, 3);
  assert.equal((await f.raw("GET", "/v1/usage?groupBy=host", app.credential)).body.code, "usage_group_unsupported");

  // The packaged OpenAPI document names these routes, and real replies carry exactly the keys its schemas allow.
  const api = consumerApiSchema() as Json, schemas = api.components.schemas;
  const conforms = (value: Json, name: string): void => {
    for (const key of schemas[name].required) assert.ok(Object.hasOwn(value, key), `${name}.${key} is required`);
    for (const key of Object.keys(value)) assert.ok(Object.hasOwn(schemas[name].properties, key), `${name} does not define ${key}`);
  };
  for (const [path, operation] of [["/v1/events", "listEvents"], ["/v1/events/stream", "followEvents"], ["/v1/usage", "usage"]] as const) {
    assert.equal(api.paths[path].get.operationId, operation); assert.deepEqual(api.paths[path].get.security, [{ ApplicationBearer: [] }]);
  }
  const wire = (await f.raw("GET", "/v1/events?limit=500", app.credential)).body;
  conforms(wire, "EventPage"); assert.ok(wire.events.length >= 4);
  for (const event of wire.events) { conforms(event, "Event"); assert.match(event.kind, new RegExp(schemas.Event.properties.kind.pattern)); }
  const report = (await f.raw("GET", "/v1/usage", app.credential)).body;
  conforms(report, "UsageReport");
  assert.deepEqual(Object.keys(report.retention).sort(), [...schemas.UsageReport.properties.retention.required].sort());
  for (const row of [...report.rows, report.totals]) { conforms(row, "UsageRow"); conforms(row.leases.holdSeconds, "UsageDistribution"); conforms(row.requests.waitSeconds, "UsageDistribution"); }
});
