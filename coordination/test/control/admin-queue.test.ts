import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { AdminSystem } from "../../src/control/admin-system.ts";
import type { Principal } from "../../src/control/contracts.ts";
import { failure, leaseFixture } from "./leases-fixture.test.ts";

/** The administrator queue view over the real request and lease ledgers, a scripted clock and no native runtime. */
function queueFixture(t: Parameters<typeof leaseFixture>[0]) {
  const f = leaseFixture(t), admin = new AdminSystem(f.leases);
  let principal: Principal = { kind: "operator", user: null, scopes: ["admin"] };
  const handle = (method: string, path: string, body: Record<string, unknown> = {}) => {
    const url = new URL(path, "http://fixture.invalid");
    return admin.handle({ method, path: url.pathname, parts: url.pathname.split("/").filter(Boolean), query: url.searchParams, body, token: f.options.adminToken, principal: () => principal });
  };
  const queue = () => (handle("GET", "/v1/admin/queue") as { body: any }).body;
  let ttl = 60;
  /** A distinct TTL per request makes a distinct fit group, so one refusal never skips another request. */
  const submit = (token: string, extra: Record<string, unknown> = {}, intent: Record<string, unknown> = {}) => {
    const { id, ...rest } = f.acquire({ ttlSeconds: ttl++, ...intent });
    f.leases.requests.submit(token, { id, kind: "lease", intent: rest, ...extra });
    return id;
  };
  return { ...f, handle, queue, submit, setPrincipal: (value: Principal) => { principal = value; } };
}
const iso = (seconds: number) => new Date(seconds * 1000).toISOString();

test("the administrator queue lists every application's waiting requests in the attempt order applications see", t => {
  const f = queueFixture(t), a = f.application({ maxRequestPriority: 10 }), b = f.application({ maxRequestPriority: 10 });
  const a1 = f.submit(a.credential), a2 = f.submit(a.credential, { priority: 5 }, { name: "checkout-flow" }), a3 = f.submit(a.credential);
  const b1 = f.submit(b.credential, { deadline: iso(f.now() + 600), source: { run: "PRIVATE-SOURCE" } }), b2 = f.submit(b.credential);
  const view = f.queue();
  // Neither application was admitted before, so the one holding the best request leads each round.
  assert.deepEqual(view.requests.map((r: any) => r.id), [a2, b1, a1, b2, a3]);
  assert.deepEqual(view.requests.map((r: any) => r.position), [1, 2, 3, 4, 5]);
  // One order, whoever reads it: each application's own view carries the same position for its request.
  for (const row of view.requests) {
    const owner = [a1, a2, a3].includes(row.id) ? a : b;
    assert.equal(row.applicationId, owner.id);
    assert.equal(f.leases.requests.inspect(owner.credential, row.id).position, row.position);
  }
  assert.equal(view.waitingTotal, 5); assert.equal(view.limit, 500); assert.equal(view.observedAt, iso(f.now()));
  const first = view.requests[0];
  assert.deepEqual({ ...first, id: undefined }, { id: undefined, applicationId: a.id, applicationName: "Fixture application", kind: "lease", position: 1, reason: null, priority: 5,
    createdAt: iso(f.now()), deadline: null, label: "checkout-flow", template: { id: f.image.id, revision: "1", arch: "amd64" }, platform: "linux" });
  assert.equal(view.requests[1].deadline, iso(f.now() + 600));
  // An omitted name defaults to the lease's own default label, as the lease view will report it.
  assert.equal(view.requests[2].label, `lease-${a1}`);
  // Identifiers and queue state only: no intent body, resources, source or credential.
  const encoded = JSON.stringify(view);
  for (const forbidden of ["PRIVATE-SOURCE", "ttlSeconds", "requiredCapabilities", "resources", "intent", a.credential, b.credential]) assert.ok(!encoded.includes(forbidden), forbidden);
});

test("the queue reports the last refusal code and follows the order across a refused pass and an admission", async t => {
  const f = queueFixture(t), a = f.application({ activeLeases: 1 }), b = f.application();
  const held = await f.request("POST", "/v1/leases", f.acquire({ name: "holds-the-slot", ttlSeconds: 120 }), a.credential);
  const blocked = f.submit(a.credential), free = f.submit(b.credential);
  assert.deepEqual(f.queue().requests.map((r: any) => [r.id, r.reason]), [[blocked, null], [free, null]]);
  f.leases.requests.pass();
  const view = f.queue();
  // The application at its lease limit keeps waiting with the stable code of its refusal; the other was admitted.
  assert.deepEqual(view.requests.map((r: any) => r.id), [blocked]);
  assert.equal(view.requests[0].position, 1);
  const reason = f.leases.requests.inspect(a.credential, blocked).reason;
  assert.match(String(reason), /^[a-z][a-z0-9_]{0,63}$/);
  assert.equal(view.requests[0].reason, reason);
  assert.equal(view.waitingTotal, 1);
  // Both leases that hold capacity are listed with their holder, label and deadline, soonest expiry first.
  assert.deepEqual(view.leases.map((l: any) => l.id).sort(), [held.id, free].sort());
  assert.equal(view.activeTotal, 2);
  const lease = view.leases.find((l: any) => l.id === held.id);
  assert.deepEqual(lease, { id: held.id, ledger: "generic", applicationId: a.id, applicationName: "Fixture application", name: "holds-the-slot", state: "provisioning",
    createdAt: iso(f.now()), expiresAt: iso(f.now() + 120), template: { id: f.image.id, revision: "1", arch: "amd64" }, platform: "linux" });
  // The same deadline the lease view reports to its holder.
  assert.equal(Date.parse(lease.expiresAt), Date.parse(held.expiresAt));
  for (let i = 1; i < view.leases.length; i++) assert.ok(view.leases[i - 1].expiresAt <= view.leases[i].expiresAt);
  // A lease that ended no longer holds capacity and leaves the list; the freed slot admits the waiting request.
  await f.request("POST", `/v1/leases/${held.id}/release`, { id: randomUUID() }, a.credential);
  assert.ok(!f.queue().leases.some((l: any) => l.id === held.id));
  // An expired lease is not shown as active: the view refreshes lease lifecycle before it reads.
  f.advance(4000);
  assert.deepEqual(f.queue().leases, []);
});

test("model calls and requests past their deadline have no position and follow the ordered requests", t => {
  const f = queueFixture(t), model = randomUUID(), late = randomUUID();
  const waiting = f.submit(f.app.credential);
  f.store.transaction(db => {
    db.prepare("INSERT INTO requests VALUES (?,?,'model-job',?,'{}',0,NULL,NULL,'waiting',900,?,NULL,NULL,?)").run(f.app.id, model, JSON.stringify({ adapter: "fixture", model: "fixture-model", digest: "sha256:" + "a".repeat(64), promptDigest: "sha256:" + "b".repeat(64), maxTokens: 16 }), f.now(), "capacity_unavailable");
    db.prepare("INSERT INTO requests VALUES (?,?,'linux-lease',?,'{}',0,?,NULL,'waiting',901,?,NULL,NULL,'Free text that is not a code')").run(f.other.id, late, JSON.stringify({ templateId: "workspace", templateRevision: "2", arch: "arm64" }), f.now() - 1, f.now() - 30);
  });
  const view = f.queue();
  assert.deepEqual(view.requests.map((r: any) => [r.id, r.position]), [[waiting, 1], [model, null], [late, null]]);
  assert.deepEqual(view.requests[1], { id: model, applicationId: f.app.id, applicationName: "Fixture application", kind: "model-job", position: null, reason: "capacity_unavailable", priority: 0,
    createdAt: iso(f.now()), deadline: null, model: "fixture-model" });
  // A reason that is not a stable code never leaves the ledger; a workspace request is a Linux request.
  assert.equal(view.requests[2].reason, null);
  assert.deepEqual(view.requests[2].template, { id: "workspace", revision: "2", arch: "arm64" });
  assert.equal(view.requests[2].platform, "linux");
  assert.equal(view.requests[2].deadline, iso(f.now() - 1));
  assert.ok(!JSON.stringify(view).includes("promptDigest"));
});

test("the queue view is bounded and says what it left out", t => {
  const f = queueFixture(t);
  f.store.transaction(db => {
    const insert = db.prepare("INSERT INTO requests VALUES (?,?,'lease','{}','{}',0,NULL,NULL,'waiting',?,?,NULL,NULL,NULL)");
    for (let n = 0; n < 503; n++) insert.run(f.app.id, randomUUID(), n + 1, f.now());
  });
  const view = f.queue();
  assert.equal(view.requests.length, 500); assert.equal(view.waitingTotal, 503);
  assert.deepEqual(view.requests.map((r: any) => r.position), Array.from({ length: 500 }, (_, n) => n + 1));
});

test("the queue view needs administrator authority, takes no query and changes nothing", async t => {
  const f = queueFixture(t), waiting = f.submit(f.app.credential);
  f.setPrincipal({ kind: "session", user: { id: randomUUID(), username: "reader", role: "user", status: "active" }, scopes: ["machines:read", "machines:write", "machines:access"] });
  assert.throws(() => f.handle("GET", "/v1/admin/queue"), failure(403));
  // A personal token of an administrator without the admin scope is refused too.
  f.setPrincipal({ kind: "token", user: { id: randomUUID(), username: "admin", role: "admin", status: "active" }, scopes: ["machines:read"] });
  assert.throws(() => f.handle("GET", "/v1/admin/queue"), failure(403));
  f.setPrincipal({ kind: "session", user: { id: randomUUID(), username: "admin", role: "admin", status: "active" }, scopes: ["admin"] });
  assert.equal(f.queue().requests[0].id, waiting);
  assert.throws(() => f.handle("GET", "/v1/admin/queue?application=" + f.app.id), failure(400));
  assert.equal(f.handle("POST", "/v1/admin/queue", { id: randomUUID() }), undefined);
  // Reading is not an admission pass: the request is still waiting and was never attempted.
  const view = f.leases.requests.inspect(f.app.credential, waiting);
  assert.equal(view.state, "waiting"); assert.equal(view.reason, null);
});

test("the system inventory carries lease labels on both ledgers and the controller's clock", async t => {
  const f = queueFixture(t), domain = randomUUID(), linux = randomUUID(), unnamed = randomUUID();
  const lease = await f.request("POST", "/v1/leases", f.acquire({ name: "checkout-flow" }));
  f.store.transaction(db => {
    db.prepare("INSERT INTO resource_domains VALUES (?,?,?,?)").run(domain, "fixture", JSON.stringify({ cpu: 8, memoryMiB: 8192, diskGiB: 80 }), f.now());
    for (const [id, request] of [[linux, { name: "ci-workspace" }], [unnamed, { name: null }]] as const) {
      const reservation = randomUUID();
      const row: Record<string, string | number | null> = { id, application: f.app.id, request: JSON.stringify(request), image_id: "fixture-linux", image_revision: "1", arch: "amd64", backend: "kubevirt", digest: "sha256:" + "ab".repeat(32),
        resources: JSON.stringify({ cpu: 1, memoryMiB: 1024, diskGiB: 4 }), capabilities: "[]", required: "[]", member: randomUUID(), domain, reservation, state: "ready", runtime: "running", cleanup: "notRequested",
        cleanup_id: null, revision: 1, created: f.now(), expires: f.now() + 60, max_expires: f.now() + 7200, provision_deadline: f.now() + 60, credential: null };
      db.prepare(`INSERT INTO linux_leases (${Object.keys(row).join(",")}) VALUES (${Object.keys(row).map(() => "?").join(",")})`).run(...Object.values(row));
      db.prepare("INSERT INTO resource_reservations VALUES (?,?,'linux-lease',?,?,'held',?,NULL)").run(reservation, domain, id, row.resources!, f.now());
    }
  });
  const snapshot = (f.handle("GET", "/v1/admin/system") as { body: any }).body;
  assert.equal(snapshot.observedAt, f.now());
  const byId = (id: string) => snapshot.leases.find((l: any) => l.id === id);
  assert.equal(byId(lease.id).name, "checkout-flow");
  assert.equal(byId(linux).name, "ci-workspace");
  // A workspace lease acquired without a label reports none rather than an invented one.
  assert.equal(Object.hasOwn(byId(unnamed), "name"), false);
  const view = f.queue();
  assert.deepEqual(view.leases.map((l: any) => [l.id, l.ledger, l.name]), [[linux, "linux", "ci-workspace"], [unnamed, "linux", null], [lease.id, "generic", "checkout-flow"]].sort((x, y) => {
    const a = view.leases.find((l: any) => l.id === x[0]).expiresAt, b = view.leases.find((l: any) => l.id === y[0]).expiresAt;
    return a < b ? -1 : a > b ? 1 : String(x[0]) < String(y[0]) ? -1 : 1;
  }));
  assert.deepEqual(view.leases.find((l: any) => l.id === linux).template, { id: "fixture-linux", revision: "1", arch: "amd64" });
  assert.equal(view.leases.find((l: any) => l.id === linux).platform, "linux");
});
