import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { ConsumerClient, ConsumerConfigurationError } from "../../src/consumer-client.ts";
import { ConsumerIdentities } from "../../src/consumers.ts";
import { ControlClient } from "../../src/control/client.ts";
import { createControllerServer, MAX_REQUEST_WAIT_SECONDS } from "../../src/control/http.ts";
import { ServiceError } from "../../src/errors.ts";
import { IdentityClient } from "../../src/identity-client.ts";
import { Requests } from "../../src/requests.ts";
import { SqliteStore } from "../../src/sqlite.ts";
import { failure, leaseFixture } from "./leases-fixture.test.ts";

const key = () => randomBytes(32).toString("base64url");
const envelope = (f: ReturnType<typeof leaseFixture>, extra: Record<string, unknown> = {}) => {
  const { id, ...intent } = f.acquire(); return { id, kind: "lease", intent, ...extra };
};
/** A queue whose admission is a switch: closed refuses with a capacity error, open records the attempt order. */
function switched(f: ReturnType<typeof leaseFixture>) {
  const accepted: string[] = [], state = { open: false };
  const queue = new Requests(f.store, f.apps, (_kind, _application, intent) => {
    if (!state.open) throw new ServiceError("capacity", 503, { code: "capacity_unavailable" });
    accepted.push(String(intent.id));
  }, () => {});
  let ttl = 60;
  // A distinct TTL per request makes a distinct fit group, so a refusal never skips another request.
  const submit = (token: string, priority = 0, extra: Record<string, unknown> = {}) => {
    const request = envelope(f, { priority, ...extra }); request.intent = { ...request.intent, ttlSeconds: ttl++ };
    queue.submit(token, request); return request.id;
  };
  return { queue, accepted, state, submit };
}

test("position is the attempt order: applications take turns, then priority, then arrival", t => {
  const f = leaseFixture(t), a = f.application({ maxRequestPriority: 10 }), b = f.application({ maxRequestPriority: 10 });
  const { queue, accepted, state, submit } = switched(f);
  const a1 = submit(a.credential), a2 = submit(a.credential, 5), a3 = submit(a.credential), b1 = submit(b.credential), b2 = submit(b.credential);
  // Neither application was admitted before, so the one holding the best request leads each round.
  const expected = [a2, b1, a1, b2, a3], mine: string[] = [a1, a2, a3], owner = (id: string) => mine.includes(id) ? a.credential : b.credential;
  const read = () => expected.map(id => queue.inspect(owner(id), id).position);
  assert.deepEqual(read(), [1, 2, 3, 4, 5]);
  // A refused pass leaves every request waiting with a reason and does not change the order.
  queue.pass();
  assert.deepEqual(read(), [1, 2, 3, 4, 5]);
  assert.equal(queue.inspect(a.credential, a2).reason, "capacity_unavailable");
  // A list carries the same positions as single reads, and only the caller's own requests.
  const listed = queue.list(b.credential).requests;
  assert.deepEqual(listed.map(request => request.id).sort(), [b1, b2].sort());
  assert.deepEqual(Object.fromEntries(listed.map(request => [request.id, request.position])), { [b1]: 2, [b2]: 4 });
  state.open = true; queue.pass();
  assert.deepEqual(accepted, expected);
  for (const id of expected) {
    const view = queue.inspect(owner(id), id);
    assert.equal(view.state, "admitted"); assert.equal(view.position, null);
  }
});

test("position matches the admitted order for mixed histories, priorities and backlogs", t => {
  const f = leaseFixture(t), { queue, accepted, state, submit } = switched(f);
  const applications = Array.from({ length: 5 }, () => f.application({ maxRequestPriority: 10, maxWaitingRequests: 1000 }));
  const owners = new Map<string, string>();
  let seed = 7;
  const next = (bound: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % bound; };
  const batch = (count: number) => {
    for (let i = 0; i < count; i++) {
      const application = applications[next(applications.length)]!;
      owners.set(submit(application.credential, next(4)), application.credential);
    }
  };
  // Give three applications an admission history first, so later turns depend on who was admitted least recently.
  state.open = true;
  for (const application of [applications[2]!, applications[0]!, applications[4]!]) { owners.set(submit(application.credential), application.credential); queue.pass(); }
  accepted.length = 0; state.open = false;
  for (let round = 0; round < 3; round++) {
    batch(40);
    const waiting = [...owners].filter(([id, token]) => queue.inspect(token, id).state === "waiting");
    const positions = waiting.map(([id, token]) => ({ id, position: queue.inspect(token, id).position! }));
    assert.deepEqual(positions.map(entry => entry.position).sort((x, y) => x - y), positions.map((_, index) => index + 1), "positions are a gap-free ranking");
    accepted.length = 0; state.open = true; queue.pass(); state.open = false;
    assert.deepEqual(accepted, positions.sort((x, y) => x.position - y.position).map(entry => entry.id), `round ${round}`);
  }
});

test("only waiting lease requests have a position; a request past its deadline has none", async t => {
  const f = leaseFixture(t); f.changeOffer({ leaseProtocol: undefined }); f.beat();
  const due = envelope(f, { deadline: new Date(1010 * 1000).toISOString() }), later = envelope(f);
  f.setNow(1000);
  assert.equal((await f.request("POST", "/v1/requests", due)).position, 1);
  assert.equal((await f.request("POST", "/v1/requests", later)).position, 2);
  // Another application cannot see the request, and learns nothing but its own place.
  await assert.rejects(f.request("GET", `/v1/requests/${later.id}`, {}, f.other.credential), failure(404));
  const foreign = await f.request("POST", "/v1/requests", envelope(f), f.other.credential);
  assert.equal(foreign.state, "waiting"); assert.equal(typeof foreign.position, "number");
  assert.deepEqual(Object.keys(foreign).filter(name => /application|owner|consumer/i.test(name)), []);
  // The queue itself drops an overdue request from the order before the pass has marked it expired.
  f.setNow(1011);
  assert.equal(f.leases.requests.inspect(f.app.credential, due.id).position, null);
  const expired = await f.request("GET", `/v1/requests/${due.id}`);
  assert.equal(expired.state, "expired"); assert.equal(expired.position, null);
  const cancelled = await f.request("POST", `/v1/requests/${later.id}/cancel`);
  assert.equal(cancelled.state, "cancelled"); assert.equal(cancelled.position, null);
});

test("generic lease views return the caller's label, including after the lease ends", async t => {
  const f = leaseFixture(t);
  const named = await f.request("POST", "/v1/leases", f.acquire({ name: "checkout-flow" }));
  assert.equal(named.name, "checkout-flow");
  const defaulted = await f.request("POST", "/v1/leases", f.acquire());
  assert.equal(defaulted.name, `lease-${defaulted.id}`);
  assert.equal((await f.request("GET", `/v1/leases/${named.id}`)).name, "checkout-flow");
  const listed = (await f.request("GET", "/v1/leases")).leases as Array<{ id: string; name: string }>;
  assert.equal(listed.find(lease => lease.id === named.id)!.name, "checkout-flow");
  // The label survives the end of the lease, and a queued request names its lease the same way.
  assert.equal((await f.request("POST", `/v1/leases/${named.id}/release`, { id: randomUUID() })).lease.name, "checkout-flow");
  const queued: Record<string, unknown> = envelope(f); queued.intent = { ...(queued.intent as object), name: "nightly-capture" };
  const admitted = await f.request("POST", "/v1/requests", queued);
  assert.equal(admitted.state, "admitted");
  assert.equal((await f.request("GET", `/v1/leases/${admitted.id}`)).name, "nightly-capture");
});

interface Reply { status: number; body: Record<string, any>; elapsedMs: number }
async function httpFixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "canaveral-request-wait-")), path = join(dir, "state.sqlite");
  const admin = key(), enrollment = key(), controllerId = randomUUID();
  const identity = new IdentityClient({ path, adminToken: admin, controllerId }); await identity.ready;
  const control = new ControlClient({ path, adminToken: admin, enrollmentToken: enrollment, controllerId }); await control.ready;
  const server = createControllerServer(control, identity);
  t.after(async () => {
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
    await Promise.all([control.close(), identity.close()]); rmSync(dir, { recursive: true, force: true });
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); const port = (server.address() as AddressInfo).port;
  const applications = new ConsumerIdentities(new SqliteStore(path));
  const image = { id: "linux", revision: "1", os: "linux", arch: "amd64", mode: "headless", minimum: { cpu: 1, memoryMiB: 1024, diskGiB: 4 } };
  const application = () => applications.create({ id: randomUUID(), name: "Wait fixture", templates: [{ id: image.id, revision: image.revision, arch: image.arch }],
    limits: { resources: { cpu: 8, memoryMiB: 8192, diskGiB: 64 }, activeLeases: 4, defaultTTLSeconds: 120, maxTTLSeconds: 3600, maxLifetimeSeconds: 7200, provisioningTimeoutSeconds: 900 } });
  const call = async (method: string, route: string, token: string, value?: unknown): Promise<Reply> => {
    const data = value === undefined ? undefined : Buffer.from(JSON.stringify(value)), started = performance.now();
    return await new Promise((resolve, reject) => {
      const request = http.request({ host: "127.0.0.1", port, method, path: route, agent: false, timeout: 19_000, headers: {
        Authorization: "Bearer " + token, ...(data ? { "Content-Type": "application/json", "Content-Length": data.length } : {}) } }, response => {
        const chunks: Buffer[] = []; response.on("data", chunk => chunks.push(chunk as Buffer)); response.once("error", reject);
        response.once("end", () => { try { resolve({ status: response.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString()) as Reply["body"], elapsedMs: performance.now() - started }); } catch (error) { reject(error); } });
      });
      request.once("error", reject); request.once("timeout", () => request.destroy(new Error("fixture deadline"))); request.end(data);
    });
  };
  // The only host offers the image without lease execution, so every admission attempt is a temporary capacity
  // refusal and requests keep waiting.
  const enrolled = await call("POST", "/v1/hosts/enroll", enrollment, { id: randomUUID(), credential: key(),
    offer: { name: "portable-fixture-only", provider: "libvirt", capacity: { cpu: 8, memoryMiB: 8192, diskGiB: 100 }, templates: [image] } });
  assert.equal(enrolled.status, 200, JSON.stringify(enrolled.body));
  const submit = async (token: string) => {
    const id = randomUUID(), reply = await call("POST", "/v1/requests", token, { id, kind: "lease", intent: { templateId: image.id, templateRevision: image.revision, arch: image.arch } });
    assert.equal(reply.status, 201, JSON.stringify(reply.body)); assert.equal(reply.body.state, "waiting");
    return id;
  };
  return { port, application, call, submit, revoke: (id: string) => applications.revoke(id) };
}

test("a held read returns when the request changes, and at its limit when nothing does", { timeout: 60_000 }, async t => {
  const f = await httpFixture(t), app = f.application(), other = f.application();
  const first = await f.submit(app.credential), second = await f.submit(app.credential);
  const plain = await f.call("GET", `/v1/requests/${second}`, app.credential);
  assert.equal(plain.status, 200); assert.equal(plain.body.position, 2); assert.ok(plain.elapsedMs < 1500);
  // Nothing changes: the read is held for the requested time and returns the unchanged view.
  const idle = await f.call("GET", `/v1/requests/${second}?wait=2`, app.credential);
  assert.equal(idle.status, 200); assert.equal(idle.body.state, "waiting"); assert.equal(idle.body.position, 2);
  assert.ok(idle.elapsedMs >= 1800 && idle.elapsedMs < 6000, `held ${idle.elapsedMs} ms`);
  // The request ahead leaves the queue: the hold ends early with the new position.
  const moved = f.call("GET", `/v1/requests/${second}?wait=${MAX_REQUEST_WAIT_SECONDS}`, app.credential);
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal((await f.call("POST", `/v1/requests/${first}/cancel`, app.credential, {})).body.state, "cancelled");
  const after = await moved;
  assert.equal(after.status, 200); assert.equal(after.body.position, 1); assert.ok(after.elapsedMs < 8000, `returned after ${after.elapsedMs} ms`);
  // The request itself ends: the hold returns its terminal view.
  const ending = f.call("GET", `/v1/requests/${second}?wait=${MAX_REQUEST_WAIT_SECONDS}`, app.credential);
  await new Promise(resolve => setTimeout(resolve, 300));
  await f.call("POST", `/v1/requests/${second}/cancel`, app.credential, {});
  const ended = await ending;
  assert.equal(ended.body.state, "cancelled"); assert.equal(ended.body.position, null); assert.ok(ended.elapsedMs < 8000);
  // A request that is not waiting is never held.
  const settled = await f.call("GET", `/v1/requests/${second}?wait=${MAX_REQUEST_WAIT_SECONDS}`, app.credential);
  assert.equal(settled.body.state, "cancelled"); assert.ok(settled.elapsedMs < 1500);
  // Refusals are immediate and unchanged: another application, a bad credential, an unknown request.
  const third = await f.submit(app.credential);
  for (const [token, status] of [[other.credential, 404], [key(), 401]] as const) {
    const refused = await f.call("GET", `/v1/requests/${third}?wait=10`, token);
    assert.equal(refused.status, status); assert.ok(refused.elapsedMs < 1500);
  }
  assert.equal((await f.call("GET", `/v1/requests/${randomUUID()}?wait=10`, app.credential)).status, 404);
});

test("wait is bounded, single and only for one request's read", { timeout: 30_000 }, async t => {
  const f = await httpFixture(t), app = f.application(), id = await f.submit(app.credential);
  for (const query of ["wait=0", `wait=${MAX_REQUEST_WAIT_SECONDS + 1}`, "wait=abc", "wait=1.5", "wait=-1", "wait=", "wait=1&wait=2", "wait=01"]) {
    const reply = await f.call("GET", `/v1/requests/${id}?${query}`, app.credential);
    assert.equal(reply.status, 400, query); assert.ok(reply.elapsedMs < 1500, query);
  }
  // Only the single read takes the parameter; the list keeps refusing it rather than silently ignoring it.
  assert.equal((await f.call("GET", "/v1/requests?wait=1", app.credential)).status, 400);
});

test("revoking the application ends a held read with the ordinary refusal", { timeout: 30_000 }, async t => {
  const f = await httpFixture(t), app = f.application(), id = await f.submit(app.credential);
  const held = f.call("GET", `/v1/requests/${id}?wait=${MAX_REQUEST_WAIT_SECONDS}`, app.credential);
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal((await f.call("GET", `/v1/requests/${id}`, app.credential)).body.state, "waiting");
  // Revoked in the controller's own database, as the administrator route does.
  f.revoke(app.id);
  const ended = await held;
  assert.equal(ended.status, 401); assert.ok(ended.elapsedMs < 8000);
});

test("SDK inspectRequest holds one bounded read and validates the wait", { timeout: 30_000 }, async t => {
  const f = await httpFixture(t), app = f.application(), id = await f.submit(app.credential);
  const client = new ConsumerClient({ baseUrl: `http://127.0.0.1:${f.port}`, applicationKey: app.credential, allowLoopbackHttp: true });
  const started = performance.now(), view = await client.inspectRequest(id, { waitSeconds: 1 });
  assert.equal(view.state, "waiting"); assert.equal(view.position, 1); assert.ok(performance.now() - started >= 900);
  assert.equal((await client.inspectRequest(id)).position, 1);
  for (const waitSeconds of [0, 16, 1.5, -1]) await assert.rejects(client.inspectRequest(id, { waitSeconds }), ConsumerConfigurationError);
  // A wait must fit inside the client's own timeout, or the client would report a timeout for a healthy hold.
  const short = new ConsumerClient({ baseUrl: `http://127.0.0.1:${f.port}`, applicationKey: app.credential, allowLoopbackHttp: true, timeoutMs: 3000 });
  await assert.rejects(short.inspectRequest(id, { waitSeconds: 2 }), ConsumerConfigurationError);
  assert.equal((await short.inspectRequest(id, { waitSeconds: 1 })).state, "waiting");
});
