import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { ServiceError } from "../src/errors.ts";
import { IdentityClient } from "../src/identity-client.ts";
import { createIdentityServer } from "../src/http.ts";

const password = "synthetic-http-account-password";
type Result = { status: number; headers: http.IncomingHttpHeaders; body: Record<string, unknown> };
async function fixture(t: { after: (callback: () => Promise<void>) => void }, timeout = 20_000) {
  const directory = mkdtempSync(join(tmpdir(), "canaveral-coordinator-http-"));
  const path = join(directory, "controller.sqlite");
  const admin = randomBytes(32).toString("base64url");
  const controllerId = randomUUID();
  const client = new IdentityClient({ path, adminToken: admin, controllerId, requestTimeoutMs: timeout });
  const server = createIdentityServer(client);
  t.after(async () => {
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
    await client.close(); rmSync(directory, { recursive: true, force: true });
  });
  await client.ready;
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  function request(route: string, value?: unknown, token?: string, headers: http.OutgoingHttpHeaders = {}): Promise<Result> {
    const data = value === undefined ? undefined : Buffer.from(JSON.stringify(value));
    return raw(route, data, { ...(data ? { "Content-Type": "application/json", "Content-Length": data.length } : {}),
      ...(token ? { Authorization: "Bearer " + token } : {}), ...headers });
  }
  function raw(route: string, data?: Buffer, headers: http.OutgoingHttpHeaders = {}): Promise<Result> {
    return new Promise<Result>((resolve, reject) => {
      const request = http.request({ host: "127.0.0.1", port, path: route, method: data ? "POST" : "GET", headers, timeout: 5000 }, response => {
        const chunks: Buffer[] = [];
        response.on("data", chunk => chunks.push(chunk as Buffer));
        response.on("error", reject);
        response.on("end", () => {
          try { resolve({ status: response.statusCode!, headers: response.headers, body: JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown> }); }
          catch (error) { reject(error); }
        });
      });
      request.once("error", reject);
      request.once("timeout", () => request.destroy(new Error("Fixture request timed out")));
      request.end(data);
    });
  }
  return { client, server, path, admin, controllerId, request, raw };
}

test("controller first-run, login, session and logout keep administrator proof separate", async t => {
  const { request, admin } = await fixture(t);
  assert.deepEqual((await request("/healthz")).body, { ok: true });
  assert.deepEqual((await request("/v1/auth/status")).body, { setupRequired: true });
  assert.equal((await request("/v1/auth/setup", { username: "admin", password })).status, 401);
  const created = await request("/v1/auth/setup", { username: "ADMIN", password }, admin);
  assert.equal(created.status, 200);
  const user = created.body.user as { id: string; username: string; role: string; status: string; createdAt: number };
  assert.equal(user.username, "admin");
  assert.equal(user.role, "admin");
  assert.equal(user.status, "active");
  assert.match(user.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.equal(typeof user.createdAt, "number");
  const token = created.body.token as string;
  assert.equal((await request("/v1/auth/setup", { username: "other", password }, token)).status, 401);
  assert.equal((await request("/v1/auth/setup", { username: "other", password }, admin)).status, 409);
  const session = await request("/v1/auth/session", undefined, token);
  assert.deepEqual(session.body.user, user);
  assert.equal("token" in session.body, false);
  assert.equal((await request("/v1/consumers", undefined, token)).status, 200);
  assert.equal((await request("/v1/auth/session", undefined, admin)).status, 401);
  assert.equal((await request("/v1/auth/logout", {}, token)).status, 200);
  assert.equal((await request("/v1/auth/session", undefined, token)).status, 401);
  const login = await request("/v1/auth/login", { username: "ADMIN", password });
  assert.equal(login.status, 200);
  assert.equal((await request("/v1/auth/session", undefined, login.body.token as string)).status, 200);
});

test("application routes require administrator role and preserve one-time credentials and revocation", async t => {
  const { request, admin } = await fixture(t);
  const spec = { id: "11111111-2222-4333-8444-555555555555", name: "Build agent", templates: [],
    limits: { resources: { cpu: 4, memoryMiB: 8192, diskGiB: 96 }, activeLeases: 2 } };
  assert.equal((await request("/v1/consumers", spec)).status, 401);
  const created = await request("/v1/consumers", spec, admin);
  assert.equal(created.status, 200);
  assert.equal((await request("/v1/consumers", undefined, created.body.credential as string)).status, 401);
  assert.equal((await request("/v1/auth/setup", { username: "admin", password }, created.body.credential as string)).status, 401);
  const inventory = await request("/v1/consumers", undefined, admin);
  assert.equal(JSON.stringify(inventory.body).includes(created.body.credential as string), false);
  assert.equal((await request("/v1/consumers", spec, admin)).status, 409);
  assert.equal((await request(`/v1/consumers/${spec.id}/credential`, { extra: true }, admin)).status, 400);
  const rotated = await request(`/v1/consumers/${spec.id}/credential`, {}, admin);
  assert.equal(rotated.status, 200);
  assert.notEqual(rotated.body.credential, created.body.credential);
  assert.equal((await request(`/v1/consumers/${spec.id}/revoke`, {}, admin)).status, 200);
  assert.equal((await request(`/v1/consumers/${spec.id}/credential`, {}, admin)).status, 409);
});

test("origin, ambiguous authorization, malformed JSON and body framing fail before effects", async t => {
  const { request, raw, admin } = await fixture(t);
  const cases = await Promise.all([
    request("/healthz", undefined, undefined, { Origin: "https://other.invalid" }),
    request("/v1/consumers", undefined, undefined, { Authorization: ["Bearer " + admin, "Bearer " + admin] }),
    raw("/v1/auth/setup", Buffer.from("not-json"), { Authorization: "Bearer " + admin, "Content-Length": 8 }),
    request("/v1/auth/setup", [], admin),
    raw("/v1/auth/setup", Buffer.from("{}"), { Authorization: "Bearer " + admin, "Transfer-Encoding": "chunked" }),
  ]);
  assert.deepEqual(cases.map(result => result.status), [403, 400, 400, 400, 400]);
  for (const response of cases) {
    assert.equal(response.headers["cache-control"], "no-store");
    assert.equal(response.body.retryable, false);
    assert.equal(typeof response.body.requestId, "string");
    assert.equal(JSON.stringify(response.body).includes(admin), false);
  }
  assert.deepEqual((await request("/v1/auth/status")).body, { setupRequired: true });
});

test("throttling keeps controller error envelopes and Retry-After without exposing passwords", async t => {
  const { request } = await fixture(t);
  for (let i = 0; i < 10; i++) assert.equal((await request("/v1/auth/login", { username: "?", password: "" })).status, 401);
  const limited = await request("/v1/auth/login", { username: "admin", password });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers["retry-after"], "60");
  assert.equal(limited.body.code, "limit_exceeded");
  assert.equal(JSON.stringify(limited.body).includes(password), false);
});

test("HTTP remains responsive while the persistence worker is blocked on a real SQLite write lock", async t => {
  const { request, client, path, admin } = await fixture(t);
  const lock = new DatabaseSync(path);
  lock.exec("BEGIN IMMEDIATE");
  const accepted = once(client, "accepted");
  const pending = client.request({ type: "applications.list", token: admin });
  let settled = false; void pending.then(() => { settled = true; }, () => {});
  try {
    await accepted;
    const health = await request("/healthz");
    assert.equal(health.status, 200);
    assert.equal(settled, false);
  } finally { lock.exec("ROLLBACK"); lock.close(); }
  assert.deepEqual(await pending, { consumers: [] });
});

test("interrupted in-flight mutations become unknown and the worker is never automatically replaced", async t => {
  const { client, path, admin } = await fixture(t);
  const lock = new DatabaseSync(path);
  lock.exec("BEGIN IMMEDIATE");
  const accepted = once(client, "accepted");
  const pending = client.request({ type: "applications.create", token: admin, body: {
    id: "11111111-2222-4333-8444-555555555555", name: "Build agent", templates: [],
    limits: { resources: { cpu: 1, memoryMiB: 1024, diskGiB: 8 }, activeLeases: 1 },
  } });
  const rejected = assert.rejects(pending, error => error instanceof ServiceError && error.outcome === "unknown" && !error.retryable);
  await accepted;
  const closing = client.close();
  try { await rejected; }
  finally { lock.exec("ROLLBACK"); lock.close(); await closing; }
  await assert.rejects(client.request({ type: "status" }), error => error instanceof ServiceError && error.status === 503);
  const check = new DatabaseSync(path);
  try { assert.ok(Number(check.prepare("SELECT count(*) AS n FROM consumers").get()!.n) <= 1); }
  finally { check.close(); }
});

test("worker request deadlines fence late mutation acknowledgements without replay", async t => {
  const { client, path, admin, request } = await fixture(t, 500);
  const lock = new DatabaseSync(path);
  lock.exec("BEGIN IMMEDIATE");
  try {
    await assert.rejects(client.request({ type: "applications.create", token: admin, body: {
      id: "11111111-2222-4333-8444-555555555555", name: "Build agent", templates: [],
      limits: { resources: { cpu: 1, memoryMiB: 1024, diskGiB: 8 }, activeLeases: 1 },
    } }), error => error instanceof ServiceError && error.outcome === "unknown" && !error.retryable);
  } finally { lock.exec("ROLLBACK"); lock.close(); }
  assert.equal((await request("/healthz")).status, 200);
  assert.equal((await request("/v1/auth/status")).status, 503);
});

test("uncloneable commands are pre-effect refusals and do not poison the owned worker", async t => {
  const { client, admin } = await fixture(t);
  await assert.rejects(client.request({ type: "setup", token: admin, body: { username: "admin", password: () => "invalid" } }),
    error => error instanceof ServiceError && error.status === 400 && error.outcome === undefined);
  assert.deepEqual(await client.request({ type: "status" }), { setupRequired: true });
});


test("runner HTTP routes separate administrator, enrollment and consumer proofs", async t => {
  const { request, admin, controllerId } = await fixture(t);
  const account = await request("/v1/auth/setup", { username: "admin", password }, admin);
  const session = account.body.token as string;
  const consumer = await request("/v1/consumers", { id: randomUUID(), name: "fixture", templates: [], limits: { resources: { cpu: 1, memoryMiB: 1, diskGiB: 1 }, activeLeases: 1 } }, session);
  const b = { controllerId, runnerId: randomUUID(), generation: 1, incarnationId: randomUUID() };
  const spec = { id: randomUUID(), ...b, ttlSeconds: 60 };
  const credential = randomBytes(32).toString("base64url"), consume = { id: spec.id, ...b, credential };
  for (const token of [undefined, consumer.body.credential as string]) {
    assert.equal((await request("/v1/runner-enrollments", spec, token)).status, 401);
    assert.equal((await request("/v1/runner-enrollments/consume", consume, token)).status, 401);
    assert.equal((await request("/v1/runners/revoke", b, token)).status, 401);
  }
  const issued = await request("/v1/runner-enrollments", spec, session);
  assert.equal(issued.status, 200);
  const enrollment = issued.body.enrollmentToken as string;
  for (const token of [consumer.body.credential as string, enrollment, credential]) {
    assert.equal((await request(`/v1/runner-enrollments/${spec.id}`, undefined, token)).status, 401);
    assert.equal((await request("/v1/runner-enrollments", { ...spec, id: randomUUID() }, token)).status, 401);
  }
  assert.equal((await request("/v1/runner-enrollments/consume", { ...consume, runnerId: randomUUID() }, enrollment)).status, 401);
  assert.equal((await request("/v1/runner-enrollments/consume", { ...consume, controllerId: randomUUID() }, enrollment)).status, 403);
  assert.equal((await request("/v1/runner-enrollments/consume", consume, admin)).status, 401);
  assert.equal((await request("/v1/runner-enrollments/consume", consume, enrollment)).status, 200);
  assert.equal((await request("/v1/runner-enrollments/consume", consume, enrollment)).status, 200);
  assert.equal((await request("/v1/runners/authenticate", b, credential)).status, 200);
  assert.equal((await request("/v1/runners/authenticate", b, enrollment)).status, 401);
  assert.equal((await request("/v1/runners/credential", { ...b, credentialRevision: 2, credential }, credential)).status, 401);
  const rotated = randomBytes(32).toString("base64url"), rotation = { ...b, credentialRevision: 2, credential: rotated };
  assert.equal((await request("/v1/runners/credential", rotation, session)).status, 200);
  assert.equal((await request("/v1/runners/credential", rotation, session)).status, 200);
  assert.equal((await request("/v1/runners/authenticate", b, credential)).status, 401);
  assert.equal((await request("/v1/runners/authenticate", b, rotated)).status, 200);
  const inspected = await request(`/v1/runner-enrollments/${spec.id}`, undefined, session);
  assert.equal(inspected.body.state, "consumed");
  assert.equal(JSON.stringify(inspected).includes(enrollment), false);
  assert.equal((await request(`/v1/runner-enrollments/${spec.id}/revoke`, {}, session)).status, 200);
  assert.equal((await request("/v1/runners/authenticate", b, rotated)).status, 200);
  assert.equal((await request("/v1/runners/revoke", b, session)).status, 200);
  assert.equal((await request("/v1/runners/revoke", b, session)).status, 200);
  assert.equal((await request("/v1/runners/authenticate", b, rotated)).status, 401);
});
