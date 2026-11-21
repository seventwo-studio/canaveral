import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { once } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { ALERT_BACKOFF_SECONDS, ALERT_COOLDOWN_SECONDS, ALERT_MAX_ATTEMPTS, AlertDelivery, MAX_ALERT_DESTINATIONS } from "../../src/alerts.ts";
import type { SendResult } from "../../src/alerts.ts";
import { Observability } from "../../src/control/observability.ts";
import { ATTENTION_KINDS, recordEvent } from "../../src/events.ts";
import { ServiceError } from "../../src/errors.ts";
import { SqliteStore } from "../../src/sqlite.ts";
import { failure, leaseFixture } from "./leases-fixture.test.ts";
import { controllerFixture, eventually } from "./observability-controller.test.ts";
import { observabilityFixture } from "./observability-fixture.test.ts";

const SECRET = "fixture-signing-secret-with-enough-entropy-0123456789";
const SLACK = "https://hooks.slack.example/services/T000/B000/PRIVATE-SLACK-PATH";
const webhook = (extra: Record<string, unknown> = {}) => ({ id: randomUUID(), name: "Operations webhook", type: "webhook", url: "https://alerts.example.invalid/hook?team=PRIVATE-QUERY", secret: SECRET, ...extra });
const raise = (f: ReturnType<typeof observabilityFixture>, kind: string, subject: string) => f.store.transaction(db => recordEvent(db, kind, { host: subject, subject, data: { state: "fixture" } }));
const deliveries = async (f: ReturnType<typeof observabilityFixture>, query = "") => (await f.admin("/v1/admin/alerts/deliveries" + query)).deliveries as any[];

test("destinations are bounded, validated, idempotent and never return their URL path or secret", async t => {
  const f = observabilityFixture(t);
  const intent = webhook({ kinds: ["host.offline", "lease.cleanup_blocked"] });
  const created = await f.call("POST", "/v1/admin/alerts/destinations", intent);
  assert.equal(created.status, 201);
  assert.deepEqual(created.body, { id: intent.id, name: "Operations webhook", type: "webhook", endpoint: "https://alerts.example.invalid", signed: true, kinds: ["host.offline", "lease.cleanup_blocked"],
    createdAt: new Date(1000 * 1000).toISOString(), deliveries: { pending: 0, delivered: 0, failed: 0 } });
  // The same UUID and intent replays; any difference under that UUID conflicts, and nothing leaks either way.
  const replay = await f.call("POST", "/v1/admin/alerts/destinations", intent);
  assert.equal(replay.status, 200); assert.deepEqual(replay.body, created.body);
  for (const changed of [{ ...intent, name: "Other" }, { ...intent, secret: SECRET + "x" }, { ...intent, url: "https://alerts.example.invalid/other" }, { ...intent, kinds: ["host.offline"] }]) {
    await assert.rejects(f.call("POST", "/v1/admin/alerts/destinations", changed), failure(409, "alert_destination_conflict"));
  }
  const slack = await f.call("POST", "/v1/admin/alerts/destinations", { id: randomUUID(), name: "Slack", type: "slack", url: SLACK });
  assert.equal((slack.body as any).signed, false); assert.equal((slack.body as any).endpoint, "https://hooks.slack.example");
  assert.deepEqual((slack.body as any).kinds, [...ATTENTION_KINDS].sort(), "an omitted selection takes the attention kinds");
  const listed = await f.admin("/v1/admin/alerts/destinations");
  assert.equal(listed.limit, MAX_ALERT_DESTINATIONS); assert.deepEqual(listed.destinations.map((d: any) => d.id).sort(), [intent.id, (slack.body as any).id].sort());
  for (const view of [created.body, slack.body, listed, await f.events(), await deliveries(f)]) for (const hidden of [SECRET, "PRIVATE-SLACK-PATH", "PRIVATE-QUERY", "invalid/hook", "/services/"]) assert.ok(!JSON.stringify(view).includes(hidden), hidden);
  assert.deepEqual((await f.events("kind=alert.destination_added")).map(event => [event.data.destinationId, event.data.type, event.data.actor]), [[intent.id, "webhook", "operator"], [(slack.body as any).id, "slack", "operator"]]);

  const refuse = (body: Record<string, unknown>, code: string) => assert.rejects(f.call("POST", "/v1/admin/alerts/destinations", body), failure(400, code), JSON.stringify(body).slice(0, 120));
  // HTTPS is required; plain HTTP is accepted only for loopback.
  for (const url of ["http://alerts.example.invalid/hook", "http://10.0.0.5/hook", "http://[::ffff:127.0.0.1]/hook", "ftp://alerts.example.invalid/hook"]) await refuse(webhook({ url }), "alert_destination_insecure");
  for (const url of ["https://user:password@alerts.example.invalid/hook", "https://alerts.example.invalid/hook#fragment", "not a url", "https://alerts.example.invalid/a b", ""]) await refuse(webhook({ url }), "alert_destination_invalid");
  for (const url of ["http://127.0.0.1:9/hook", "http://localhost:9/hook", "http://[::1]:9/hook"]) assert.equal((await f.call("POST", "/v1/admin/alerts/destinations", webhook({ url }))).status, 201);
  await refuse(webhook({ secret: "short" }), "alert_destination_invalid"); await refuse({ ...webhook(), secret: undefined }, "alert_destination_invalid");
  await refuse(webhook({ secret: "line\nbreak-".repeat(4) }), "alert_destination_invalid");
  await refuse({ id: randomUUID(), name: "Slack", type: "slack", url: SLACK, secret: SECRET }, "alert_destination_invalid");
  await refuse(webhook({ type: "email" }), "alert_destination_invalid"); await refuse(webhook({ name: "" }), "alert_destination_invalid"); await refuse(webhook({ extra: true }), "alert_destination_invalid");
  for (const kinds of [["host.unheard"], [], ["host.offline", "host.offline"], "host.offline"]) await refuse(webhook({ kinds }), "event_kind_unknown");

  // The destination count is bounded; removal frees a slot, erases the URL and secret, and keeps the UUID retired.
  for (let n = listed.destinations.length + 3; n < MAX_ALERT_DESTINATIONS; n++) await f.call("POST", "/v1/admin/alerts/destinations", webhook());
  await assert.rejects(f.call("POST", "/v1/admin/alerts/destinations", webhook()), failure(409, "alert_destination_limit"));
  assert.deepEqual((await f.call("POST", `/v1/admin/alerts/destinations/${intent.id}/remove`)).body, { id: intent.id, removed: true });
  assert.deepEqual((await f.call("POST", `/v1/admin/alerts/destinations/${intent.id}/remove`)).body, { id: intent.id, removed: true });
  f.store.transaction(db => assert.deepEqual({ ...db.prepare("SELECT url,secret FROM alert_destinations WHERE id=?").get(intent.id) }, { url: "", secret: null }));
  await assert.rejects(f.call("POST", "/v1/admin/alerts/destinations", intent), failure(409, "alert_destination_conflict"));
  assert.equal((await f.call("POST", "/v1/admin/alerts/destinations", webhook())).status, 201);
  await assert.rejects(f.call("POST", `/v1/admin/alerts/destinations/${randomUUID()}/remove`), failure(404));
  await assert.rejects(f.call("POST", `/v1/admin/alerts/destinations/${intent.id}/remove`, { unexpected: true }), failure(400));
  assert.equal((await f.events("kind=alert.destination_removed")).length, 1);
});

test("an alert is queued with its event and signed over the exact body; a rolled-back change queues nothing", async t => {
  const f = observabilityFixture(t), signed = webhook({ kinds: ["lease.cleanup_blocked", "operation.unknown", "request.waiting_long"] });
  await f.call("POST", "/v1/admin/alerts/destinations", signed);
  const slack = (await f.call("POST", "/v1/admin/alerts/destinations", { id: randomUUID(), name: "Slack", type: "slack", url: SLACK, kinds: ["lease.cleanup_blocked"] })).body as any;
  // Cleanup blocked: the runner's receipt, the lease's cleanup state, its event and both deliveries are one transaction.
  const lease = await f.request("POST", "/v1/leases", f.acquire()), machine = lease.members[0].machineId; f.ready(lease);
  await f.request("POST", `/v1/leases/${lease.id}/release`, { id: randomUUID() });
  const cleanup = (await f.request("GET", `/v1/leases/${lease.id}`)).members[0].cleanup;
  f.beat({ reports: { [machine]: { state: "stopped", leaseCleanup: { id: cleanup.id, leaseId: lease.id, state: "blocked", attempt: 1, reason: "credential_erasure" } } } });
  // Operation outcome unknown.
  const operation = randomUUID();
  f.store.transaction(db => {
    db.prepare("INSERT INTO device_operations VALUES (?,?,?,?,'queued',NULL,?,?)").run(operation, machine, f.host, JSON.stringify({ id: operation, action: "tap", arguments: { x: 1, y: 2 } }), f.now(), f.now());
    db.prepare("UPDATE device_operations SET state='unknown' WHERE id=?").run(operation);
  });
  // A change that does not commit leaves neither an event nor a delivery.
  assert.throws(() => f.store.transaction(db => { db.prepare("UPDATE device_operations SET state='queued' WHERE id=?").run(operation); db.prepare("UPDATE device_operations SET state='unknown' WHERE id=?").run(operation); throw new ServiceError("abandon", 409); }), failure(409));
  // A request that waits past the configured threshold.
  const waiting = f.application({ activeLeases: 1, maxWaitingRequests: 5 });
  await f.request("POST", "/v1/leases", f.acquire(), waiting.credential);
  const request = f.leases.requests.submit(waiting.credential, { id: randomUUID(), kind: "lease", intent: { templateId: f.image.id, templateRevision: "1", arch: "amd64" } }).request.id;
  f.leases.requests.pass();
  assert.equal(f.observability.observe(), 0, "not yet past the threshold");
  f.advance(601); f.beat();
  assert.equal(f.observability.observe(), 1); assert.equal(f.observability.observe(), 0, "one event per long wait");
  const queued = await deliveries(f);
  assert.deepEqual(queued.map(d => [d.kind, d.state, d.attempts]).sort(), [["lease.cleanup_blocked", "pending", 0], ["lease.cleanup_blocked", "pending", 0], ["operation.unknown", "pending", 0], ["request.waiting_long", "pending", 0]]);
  assert.equal(f.sent.length, 0, "nothing is sent inside the transaction that queued it");

  assert.equal(await f.observability.alerts.deliverDue(), 4);
  assert.equal(f.sent.length, 4);
  const hooks = f.sent.filter(alert => alert.url.startsWith("https://alerts.example.invalid/")), chat = f.sent.filter(alert => alert.url === SLACK);
  assert.equal(hooks.length, 3); assert.equal(chat.length, 1);
  for (const alert of hooks) {
    assert.equal(alert.url, signed.url);
    assert.equal(alert.headers["X-Canaveral-Signature"], "sha256=" + createHmac("sha256", SECRET).update(alert.body).digest("hex"));
    assert.equal(alert.headers["Content-Length"], String(alert.body.length)); assert.equal(alert.headers["Content-Type"], "application/json");
    const body = JSON.parse(alert.body.toString());
    assert.equal(alert.headers["X-Canaveral-Delivery"], body.id); assert.equal(body.type, "canaveral.alert"); assert.equal(body.controllerId, f.options.controllerId);
    assert.equal(body.attempt, 1); assert.equal(body.event.kind, body.kind); assert.equal(body.event.sequence, body.sequence); assert.equal(body.occurredAt, body.event.at);
    assert.ok(!alert.body.toString().includes(SECRET));
  }
  const bodies = Object.fromEntries(hooks.map(alert => { const body = JSON.parse(alert.body.toString()); return [body.kind, body]; }));
  assert.equal(bodies["lease.cleanup_blocked"].event.leaseId, lease.id); assert.equal(bodies["lease.cleanup_blocked"].event.data.reason, "credential_erasure");
  assert.match(bodies["lease.cleanup_blocked"].summary, /cleanup is blocked.*reason credential_erasure/);
  assert.equal(bodies["operation.unknown"].event.data.operationId, operation); assert.equal(bodies["operation.unknown"].event.data.action, "tap");
  assert.ok(!JSON.stringify(bodies["operation.unknown"]).includes('"x"'), "operation arguments are not part of an alert");
  assert.equal(bodies["request.waiting_long"].event.requestId, request); assert.equal(bodies["request.waiting_long"].event.data.reason, "limit_exceeded");
  assert.equal(bodies["request.waiting_long"].event.data.thresholdSeconds, 600);
  // Slack receives its incoming-webhook shape, unsigned.
  assert.deepEqual(Object.keys(JSON.parse(chat[0]!.body.toString())), ["text"]);
  assert.match(JSON.parse(chat[0]!.body.toString()).text, /^Canaveral lease\.cleanup_blocked: /);
  assert.equal(chat[0]!.headers["X-Canaveral-Signature"], undefined);
  assert.ok((await deliveries(f)).every(d => d.state === "delivered" && d.attempts === 1 && d.status === 204));
  assert.equal(await f.observability.alerts.deliverDue(), 0); assert.equal(f.sent.length, 4, "a delivered alert is never sent again");
  const view = (await f.admin("/v1/admin/alerts/destinations")).destinations.find((d: any) => d.id === slack.id);
  assert.deepEqual(view.deliveries, { pending: 0, delivered: 1, failed: 0 }); assert.equal(view.lastAttempt.state, "delivered");
});

test("failed deliveries back off, stop after a bounded number of attempts and are reported once", async t => {
  const f = observabilityFixture(t), destination = webhook({ kinds: ["host.offline", "host.checks_failed", "alert.delivery_failed"] });
  await f.call("POST", "/v1/admin/alerts/destinations", destination);
  const outcomes: SendResult[] = [];
  f.respond(() => outcomes.shift() ?? { ok: false, status: 503, outcome: "http_error" });
  raise(f, "host.offline", "host-a");
  assert.equal(await f.observability.alerts.deliverDue(), 1);
  let [delivery] = await deliveries(f);
  assert.deepEqual([delivery.state, delivery.attempts, delivery.status, delivery.outcome, delivery.maxAttempts], ["pending", 1, 503, "http_error", ALERT_MAX_ATTEMPTS]);
  assert.equal(Date.parse(delivery.nextAttemptAt) / 1000, f.now() + ALERT_BACKOFF_SECONDS[0]!);
  // Each retry waits for its scheduled time; nothing is sent early.
  for (let attempt = 2; attempt <= ALERT_MAX_ATTEMPTS; attempt++) {
    f.advance(ALERT_BACKOFF_SECONDS[attempt - 2]! - 1); assert.equal(await f.observability.alerts.deliverDue(), 0);
    f.advance(1); assert.equal(await f.observability.alerts.deliverDue(), 1);
    assert.equal(JSON.parse(f.sent.at(-1)!.body.toString()).attempt, attempt);
  }
  [delivery] = await deliveries(f, "?state=failed");
  assert.deepEqual([delivery.state, delivery.attempts, delivery.outcome], ["failed", ALERT_MAX_ATTEMPTS, "http_error"]); assert.equal(Object.hasOwn(delivery, "nextAttemptAt"), false);
  assert.equal(f.sent.length, ALERT_MAX_ATTEMPTS);
  f.advance(86400); await f.observability.alerts.deliverDue();
  // The exhausted delivery is recorded as an event and alerted once; that alert's own failure is not reported again.
  const failed = await f.events("kind=alert.delivery_failed");
  assert.deepEqual(failed.map(event => [event.data.kind, event.data.attempts, event.data.outcome]), [["host.offline", ALERT_MAX_ATTEMPTS, "http_error"]]);
  for (let round = 0; round < 8; round++) { f.advance(1000); await f.observability.alerts.deliverDue(); }
  assert.equal((await f.events("kind=alert.delivery_failed")).length, 1);
  assert.equal(f.sent.length, 2 * ALERT_MAX_ATTEMPTS);
  // Every stable id is reused across the retries of one delivery, so a receiver can de-duplicate.
  assert.equal(new Set(f.sent.slice(0, ALERT_MAX_ATTEMPTS).map(alert => alert.headers["X-Canaveral-Delivery"])).size, 1);

  // A delivery that succeeds on a later attempt stops there; timeouts, refused redirects and connection failures all retry.
  f.sent.length = 0; outcomes.push({ ok: false, outcome: "timeout" }, { ok: false, status: 302, outcome: "redirect_refused" }, { ok: false, outcome: "connection_failed" }, { ok: true, status: 200, outcome: "delivered" });
  raise(f, "host.checks_failed", "host-b");
  for (const wait of [0, ...ALERT_BACKOFF_SECONDS.slice(0, 3)]) { f.advance(wait); await f.observability.alerts.deliverDue(); }
  const [recovered] = await deliveries(f, "?state=delivered");
  assert.deepEqual([recovered.kind, recovered.attempts, recovered.status], ["host.checks_failed", 4, 200]);
  f.advance(86400); await f.observability.alerts.deliverDue(); assert.equal(f.sent.length, 4);

  // A sender that throws is a failed attempt, never a crashed controller.
  f.respond(() => { throw new Error("socket exploded"); });
  raise(f, "host.offline", "host-c"); await f.observability.alerts.deliverDue();
  assert.equal((await deliveries(f, "?state=pending"))[0].outcome, "connection_failed");
});

test("a flapping condition alerts once per cooldown, and removal cancels what was not sent", async t => {
  const f = observabilityFixture(t), destination = webhook({ kinds: ["host.offline", "host.online"] });
  await f.call("POST", "/v1/admin/alerts/destinations", destination);
  for (let flap = 0; flap < 5; flap++) { raise(f, "host.offline", "host-a"); raise(f, "host.online", "host-a"); f.advance(10); }
  raise(f, "host.offline", "host-b");
  assert.deepEqual((await deliveries(f)).map(d => d.kind).sort(), ["host.offline", "host.offline", "host.online"], "one per kind and subject, plus the other host");
  f.advance(ALERT_COOLDOWN_SECONDS); raise(f, "host.offline", "host-a");
  assert.equal((await deliveries(f)).filter(d => d.kind === "host.offline").length, 3);
  assert.equal((await f.events("kind=host.offline")).length, 7, "every transition stays in the event log");
  await f.call("POST", `/v1/admin/alerts/destinations/${destination.id}/remove`);
  assert.ok((await deliveries(f)).every(d => d.state === "cancelled" && d.outcome === "destination_removed"));
  assert.equal(await f.observability.alerts.deliverDue(), 0); assert.equal(f.sent.length, 0);
  raise(f, "host.offline", "host-z");
  assert.equal((await deliveries(f)).length, 4, "a removed destination selects nothing");
  await assert.rejects(f.admin("/v1/admin/alerts/deliveries?state=lost"), failure(400));
  await assert.rejects(f.admin("/v1/admin/alerts/deliveries?limit=201"), failure(400));
  // Settled deliveries are pruned after a week; pending ones are kept.
  await f.call("POST", "/v1/admin/alerts/destinations", webhook({ kinds: ["host.offline"] })); raise(f, "host.offline", "host-y");
  f.advance(8 * 86400); f.observability.maintain(true);
  assert.deepEqual((await deliveries(f)).map(d => d.state), ["pending"]);
});

test("a restart keeps pending alerts, never repeats a delivered one and bounds an interrupted one", async t => {
  const f = observabilityFixture(t), destination = webhook({ kinds: ["host.offline"] });
  await f.call("POST", "/v1/admin/alerts/destinations", destination);
  raise(f, "host.offline", "host-delivered"); await f.observability.alerts.deliverDue();
  raise(f, "host.offline", "host-pending");
  raise(f, "host.offline", "host-interrupted");
  // The controller stops after claiming an attempt and before recording its outcome: the send never reports back.
  const interrupted: string[] = [];
  const hung = new AlertDelivery(f.store, f.options.controllerId, (_url, headers) => { interrupted.push(headers["X-Canaveral-Delivery"]!); return new Promise(() => {}); });
  void hung.deliverDue();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(interrupted.length, 2);
  // A new process on the same database: its own store, modules and sender.
  const restart = () => { const sent: string[] = []; const delivery = new AlertDelivery(new SqliteStore(f.store.path, f.now), f.options.controllerId, async (_url, headers) => { sent.push(headers["X-Canaveral-Delivery"]!); return { ok: true, status: 200, outcome: "delivered" }; }); return { sent, delivery }; };
  let next = restart();
  assert.equal(await next.delivery.deliverDue(), 0, "a claimed attempt is not repeated before its scheduled retry");
  f.advance(ALERT_BACKOFF_SECONDS[0]!);
  assert.equal(await next.delivery.deliverDue(), 2);
  assert.deepEqual([...next.sent].sort(), [...interrupted].sort(), "both unsettled alerts are sent again after the restart, under the same ids");
  assert.deepEqual((await deliveries(f)).map(d => [d.state, d.attempts]).sort(), [["delivered", 1], ["delivered", 2], ["delivered", 2]]);
  f.advance(86400); next = restart(); assert.equal(await next.delivery.deliverDue(), 0); assert.equal(f.sent.length, 1, "the delivered alert was sent exactly once");

  // A controller that dies during every attempt still stops: the attempt is counted before it is sent.
  raise(f, "host.offline", "host-unlucky");
  let sends = 0;
  for (let crash = 0; crash < 3 * ALERT_MAX_ATTEMPTS; crash++) {
    const dying = new AlertDelivery(new SqliteStore(f.store.path, f.now), f.options.controllerId, () => { sends++; return new Promise(() => {}); });
    void dying.deliverDue(); await new Promise(resolve => setImmediate(resolve));
    f.advance(ALERT_BACKOFF_SECONDS.at(-1)!);
  }
  assert.equal(sends, ALERT_MAX_ATTEMPTS);
  const [unlucky] = await deliveries(f, "?state=failed");
  assert.deepEqual([unlucky.state, unlucky.attempts, unlucky.outcome], ["failed", ALERT_MAX_ATTEMPTS, "interrupted"]);
});

test("a test delivery is one recorded attempt: it reports the receiver's answer and is never retried", async t => {
  const f = observabilityFixture(t), destination = webhook();
  await f.call("POST", "/v1/admin/alerts/destinations", destination);
  const id = randomUUID(), route = `/v1/admin/alerts/destinations/${destination.id}/test`;
  const delivered = (await f.call("POST", route, { id })).body as any;
  assert.deepEqual([delivered.delivery.id, delivered.delivery.kind, delivered.delivery.state, delivered.delivery.attempts, delivered.delivery.maxAttempts, delivered.delivery.status], [id, "alert.test", "delivered", 1, 1, 204]);
  const body = JSON.parse(f.sent[0]!.body.toString());
  assert.equal(body.kind, "alert.test"); assert.equal(body.id, id); assert.equal(Object.hasOwn(body, "sequence"), false);
  assert.equal(f.sent[0]!.headers["X-Canaveral-Signature"], "sha256=" + createHmac("sha256", SECRET).update(f.sent[0]!.body).digest("hex"));
  assert.deepEqual((await f.call("POST", route, { id })).body, delivered, "the same UUID returns its record without sending again"); assert.equal(f.sent.length, 1);
  f.respond(() => ({ ok: false, status: 500, outcome: "http_error" }));
  const refused = ((await f.call("POST", route, { id: randomUUID() })).body as any).delivery;
  assert.deepEqual([refused.state, refused.attempts, refused.status], ["failed", 1, 500]);
  f.advance(86400); assert.equal(await f.observability.alerts.deliverDue(), 0); assert.equal(f.sent.length, 2);
  assert.equal((await f.events("kind=alert.delivery_failed")).length, 0, "a failed test is its own answer, not an incident");
  await assert.rejects(f.call("POST", `/v1/admin/alerts/destinations/${randomUUID()}/test`, { id: randomUUID() }), failure(404));
  await assert.rejects(f.call("POST", route, {}), failure(400)); await assert.rejects(f.call("POST", route, { id: randomUUID(), extra: 1 }), failure(400));
  const other = webhook(); await f.call("POST", "/v1/admin/alerts/destinations", other);
  await assert.rejects(f.call("POST", `/v1/admin/alerts/destinations/${other.id}/test`, { id }), failure(409, "alert_destination_conflict"));
});

/** A loopback receiver that records what actually crossed the socket. */
async function receiver(t: Parameters<typeof leaseFixture>[0], answer: (path: string) => number = () => 204) {
  const received: Array<{ path: string; headers: http.IncomingHttpHeaders; body: Buffer }> = [];
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", chunk => chunks.push(chunk as Buffer));
    request.on("end", () => {
      received.push({ path: request.url ?? "", headers: request.headers, body: Buffer.concat(chunks) });
      const status = answer(request.url ?? "");
      response.writeHead(status, status === 302 ? { Location: "/elsewhere" } : {}); response.end();
    });
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  return { received, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server };
}

test("the wire request is signed over its received bytes, follows no redirect and classifies failures", async t => {
  const f = leaseFixture(t), observability = new Observability(f.store, f.options, f.apps); observability.installCapture();
  const hook = await receiver(t, path => path === "/redirect" ? 302 : path === "/broken" ? 500 : 204);
  const call = async (method: string, path: string, body: Record<string, unknown> = {}) => (await observability.handle({ method, path, parts: path.split("/").filter(Boolean), query: new URLSearchParams(), body, token: f.options.adminToken,
    principal: () => ({ kind: "operator", user: null, scopes: ["admin"] }) }))!.body as any;
  const add = async (path: string) => (await call("POST", "/v1/admin/alerts/destinations", webhook({ url: hook.url + path }))).id as string;
  const check = async (path: string) => (await call("POST", `/v1/admin/alerts/destinations/${await add(path)}/test`, { id: randomUUID() })).delivery;
  const delivered = await check("/hook?team=ops");
  assert.deepEqual([delivered.state, delivered.status, delivered.outcome], ["delivered", 204, "delivered"]);
  const seen = hook.received[0]!;
  assert.equal(seen.path, "/hook?team=ops");
  assert.equal(seen.headers["x-canaveral-signature"], "sha256=" + createHmac("sha256", SECRET).update(seen.body).digest("hex"));
  assert.equal(seen.headers["x-canaveral-delivery"], delivered.id); assert.equal(seen.headers["content-type"], "application/json"); assert.equal(seen.headers["user-agent"], "Canaveral-alerts/1");
  assert.equal(seen.headers.authorization, undefined); assert.equal(JSON.parse(seen.body.toString()).id, delivered.id);
  assert.deepEqual([(await check("/redirect")).outcome, hook.received.length], ["redirect_refused", 2], "the redirect target is never requested");
  assert.deepEqual((({ state, status, outcome }) => [state, status, outcome])(await check("/broken")), ["failed", 500, "http_error"]);
  const closed = await receiver(t); await new Promise<void>(resolve => { closed.server.close(() => resolve()); });
  const unreachable = (await call("POST", `/v1/admin/alerts/destinations/${(await call("POST", "/v1/admin/alerts/destinations", webhook({ url: closed.url + "/hook" }))).id}/test`, { id: randomUUID() })).delivery;
  assert.deepEqual([unreachable.state, unreachable.outcome], ["failed", "connection_failed"]);
});

test("a running controller delivers alerts off the request path and keeps a pending alert across a restart", { timeout: 90_000 }, async t => {
  const f = await controllerFixture(t);
  let accept = false;
  const hook = await receiver(t, () => accept ? 204 : 500);
  const destination = webhook({ url: hook.url + "/hook", kinds: ["host.draining", "host.accepting"] });
  await f.call("POST", "/v1/admin/alerts/destinations", f.admin, destination, 201);
  // The mutation returns at once; delivery follows on the controller's timer.
  await f.call("POST", `/v1/hosts/${f.host}/accepting`, f.admin, { enabled: false });
  await eventually(() => hook.received.length, count => count === 1);
  const first = JSON.parse(hook.received[0]!.body.toString());
  assert.equal(first.kind, "host.draining"); assert.equal(first.event.hostId, f.host); assert.equal(first.attempt, 1);
  assert.equal(hook.received[0]!.headers["x-canaveral-signature"], "sha256=" + createHmac("sha256", SECRET).update(hook.received[0]!.body).digest("hex"));
  const pending = (await f.call("GET", "/v1/admin/alerts/deliveries")).deliveries;
  assert.deepEqual(pending.map((d: any) => [d.kind, d.state, d.attempts, d.status]), [["host.draining", "pending", 1, 500]]);
  // The receiver recovers while the controller is down; the retry happens after the restart, once.
  await f.restart(); accept = true;
  await f.call("POST", `/v1/hosts/${f.host}/accepting`, f.admin, { enabled: true });
  await eventually(() => hook.received.length, count => count === 3, 30_000);
  const kinds = hook.received.slice(1).map(request => JSON.parse(request.body.toString())).map(body => [body.kind, body.attempt, body.id === first.id]).sort();
  assert.deepEqual(kinds, [["host.accepting", 1, false], ["host.draining", 2, true]]);
  const settled = await eventually(async () => (await f.call("GET", "/v1/admin/alerts/deliveries")).deliveries as any[], list => list.every(d => d.state === "delivered"));
  assert.deepEqual(settled.map(d => [d.kind, d.attempts]).sort(), [["host.accepting", 1], ["host.draining", 2]]);
  await new Promise(resolve => setTimeout(resolve, 1500));
  assert.equal(hook.received.length, 3, "nothing is repeated once delivered");
  assert.deepEqual((await f.call("POST", `/v1/admin/alerts/destinations/${destination.id}/test`, f.admin, { id: randomUUID() })).delivery.state, "delivered");
  for (const view of [await f.call("GET", "/v1/admin/alerts/destinations"), await f.events()]) assert.ok(!JSON.stringify(view).includes(SECRET) && !JSON.stringify(view).includes("/hook"));
});
