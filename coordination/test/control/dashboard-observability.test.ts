import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { startDashboard } from "../../src/dashboard.ts";
import { controllerFixture, eventually, IMAGE } from "./observability-controller.test.ts";
import type { Json } from "./observability-controller.test.ts";

/** The production gateway in front of a real controller on loopback: account sessions, the administrator
 * queue, events and usage reads, and the administrator cancel. Fixture hosts only; no native runtime. */
test("administrators read the queue, events and usage through the gateway; other accounts and ended sessions cannot", { timeout: 60_000 }, async t => {
  const f = await controllerFixture(t);
  const dashboard = await startDashboard({ orchestratorUrl: f.url(), listen: { host: "127.0.0.1", port: 0 }, bootstrapToken: f.admin });
  t.after(() => dashboard.close());
  const base = `http://127.0.0.1:${dashboard.address.port}`;
  async function api(path: string, body?: unknown, cookie = "") {
    const response = await fetch(base + "/api" + path, { method: body === undefined ? "GET" : "POST",
      headers: { ...(body === undefined ? {} : { "Content-Type": "application/json", Origin: base }), ...(cookie ? { Cookie: cookie } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15_000) });
    const text = await response.text(), type = response.headers.get("content-type") ?? "";
    return { status: response.status, type, text, headers: response.headers, body: type.startsWith("application/json") ? JSON.parse(text) as Json : {} as Json };
  }
  const session = (reply: Awaited<ReturnType<typeof api>>) => { assert.equal(reply.status, 200, reply.text); return reply.headers.get("set-cookie")!.split(";", 1)[0]!; };
  const admin = session(await api("/v1/auth/setup", { username: "admin", password: "disposable admin password" }));
  const reader = (await api("/v1/users", { id: randomUUID(), username: "reader" }, admin)).body;
  const invitation = await api(`/v1/users/${reader.id as string}/invite`, {}, admin);
  const user = session(await api("/v1/auth/claim", { token: invitation.body.token, password: "disposable reader password" }));

  // One application at its lease limit: its lease holds the slot and its two requests wait behind it.
  const app = await f.application({ activeLeases: 1 }), held = await f.acquire(app.credential, { name: "holds-the-slot" });
  const submit = async (name: string) => (await f.call("POST", "/v1/requests", app.credential, { id: randomUUID(), kind: "lease",
    intent: { templateId: IMAGE.id, templateRevision: "1", arch: "amd64", ttlSeconds: 120, name } }, 201)).id as string;
  const first = await submit("first-in-line"), second = await submit("second-in-line");

  const reads = ["/v1/admin/queue", "/v1/admin/events?tail=50", "/v1/admin/events/kinds", "/v1/admin/usage?groupBy=application", "/v1/admin/usage?format=csv"];
  await t.test("an administrator session reads each page's data", async () => {
    const queue = (await api("/v1/admin/queue", undefined, admin)).body;
    assert.deepEqual(queue.requests.map((r: Json) => [r.id, r.position, r.label, r.applicationId]), [[first, 1, "first-in-line", app.id], [second, 2, "second-in-line", app.id]]);
    // The reason is the stable code of the last refusal, the same one the application reads for its own request.
    const own = await f.call("GET", `/v1/requests/${first}`, app.credential);
    assert.equal(queue.requests[0].reason, own.reason); assert.equal(typeof own.reason, "string"); assert.equal(own.position, 1);
    assert.deepEqual(queue.leases.map((l: Json) => [l.id, l.name, l.applicationName]), [[held.id, "holds-the-slot", "Fixture application"]]);
    assert.ok(Date.parse(queue.leases[0].expiresAt) > Date.parse(queue.observedAt));
    const events = (await api(`/v1/admin/events?tail=50&kind=request.*&kind=lease.admitted&application=${app.id}`, undefined, admin)).body;
    assert.deepEqual(events.events.map((e: Json) => e.kind), ["lease.admitted", "request.submitted", "request.submitted"]);
    assert.equal(typeof events.latestSequence, "number");
    // The cursor of one read is the `after` of the next: nothing is repeated and nothing is missed.
    const tail = (await api("/v1/admin/events?tail=1", undefined, admin)).body;
    assert.deepEqual((await api(`/v1/admin/events?after=${tail.cursor as number}&limit=500`, undefined, admin)).body.events, []);
    const kinds = (await api("/v1/admin/events/kinds", undefined, admin)).body.kinds as Json[];
    assert.equal(kinds.find(kind => kind.kind === "lease.failed")!.attention, true);
    assert.equal(kinds.find(kind => kind.kind === "lease.admitted")!.attention, false);
    const usage = (await api("/v1/admin/usage?groupBy=application", undefined, admin)).body;
    assert.equal(usage.rows[0].key, app.id); assert.equal(usage.rows[0].requests.waiting, 2); assert.equal(usage.rows[0].leases.active, 1);
    assert.equal(typeof usage.retention.leaseLedgerStartedAt, "string");
    const hosts = (await api("/v1/admin/usage?groupBy=host", undefined, admin)).body;
    assert.equal(hosts.rows[0].key, f.host); assert.equal(Object.hasOwn(hosts.rows[0], "requests"), false);
    const csv = await api("/v1/admin/usage?groupBy=application&format=csv", undefined, admin);
    assert.equal(csv.status, 200); assert.equal(csv.type, "text/csv; charset=utf-8");
    assert.match(csv.headers.get("content-disposition") ?? "", /^attachment; filename="canaveral-usage\.csv"$/);
    const lines = csv.text.split("\r\n");
    assert.ok(lines[0]!.startsWith("group,key,label,requests_submitted,")); assert.ok(lines[1]!.startsWith(`application,${app.id},Fixture application,2,`)); assert.ok(lines[2]!.startsWith("application,total,"));
  });
  await t.test("an ordinary account, a signed-out browser and a bearer application key read none of it", async () => {
    for (const path of reads) {
      const refused = await api(path, undefined, user);
      assert.equal(refused.status, 403, path);
      assert.deepEqual(Object.keys(refused.body).sort(), ["code", "error", "retryable"]);
      assert.equal((await api(path)).status, 401, path);
      // An application credential is not administrator authority, on these routes or any other.
      const borrowed = await fetch(base + "/api" + path, { headers: { Authorization: `Bearer ${app.credential}` } });
      assert.equal(borrowed.status, 401, path); await borrowed.arrayBuffer();
    }
    assert.equal((await api(`/v1/admin/requests/${first}/cancel`, { id: randomUUID(), applicationId: app.id }, user)).status, 403);
    assert.equal((await f.call("GET", `/v1/requests/${first}`, app.credential)).state, "waiting");
  });
  await t.test("the administrator cancel names one request, replays under its mutation UUID and is recorded", async () => {
    const mutation = { id: randomUUID(), applicationId: app.id };
    const receipt = await api(`/v1/admin/requests/${first}/cancel`, mutation, admin);
    assert.equal(receipt.status, 200);
    assert.deepEqual(receipt.body, { id: first, requestId: mutation.id, action: "cancel", state: "cancelled", applicationId: app.id });
    // A lost reply is recovered with the same UUID: the same receipt, and no second effect.
    assert.deepEqual((await api(`/v1/admin/requests/${first}/cancel`, mutation, admin)).body, receipt.body);
    assert.equal((await api(`/v1/admin/requests/${second}/cancel`, mutation, admin)).status, 409);
    const queue = (await api("/v1/admin/queue", undefined, admin)).body;
    assert.deepEqual(queue.requests.map((r: Json) => [r.id, r.position]), [[second, 1]]);
    assert.equal((await f.call("GET", `/v1/requests/${first}`, app.credential)).reason, "administrator_cancelled");
    const recorded = await eventually(async () => (await api(`/v1/admin/events?tail=20&kind=request.cancelled&kind=admin.intervention`, undefined, admin)).body.events as Json[], events => events.length >= 2);
    assert.deepEqual(recorded.map(event => event.kind).sort(), ["admin.intervention", "request.cancelled"]);
    assert.equal(recorded.find(event => event.kind === "request.cancelled")!.requestId, first);
  });
  await t.test("reads end with the session", async () => {
    assert.equal((await api("/v1/auth/logout", {}, admin)).status, 200);
    for (const path of reads) assert.equal((await api(path, undefined, admin)).status, 401, path);
  });
});
