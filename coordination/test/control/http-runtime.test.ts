import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { TestContext } from "node:test";
import { ControlClient } from "../../src/control/client.ts";
import type { HttpCommand } from "../../src/control/client.ts";
import { createControllerServer } from "../../src/control/http.ts";
import { ServiceError } from "../../src/errors.ts";
import { IdentityClient } from "../../src/identity-client.ts";
import { parseControllerConfig, startController } from "../../src/main.ts";
const key = () => randomBytes(32).toString("base64url"), password = "runtime-fixture-password";
interface Reply { status: number; body: Record<string, any> }
async function fixture(t: TestContext, timeout = 20_000) {
  const dir = mkdtempSync(join(tmpdir(), "canaveral-control-http-")), path = join(dir, "state.sqlite");
  const admin = key(), enrollment = key(), controllerId = randomUUID();
  const identity = new IdentityClient({ path, adminToken: admin, controllerId }); await identity.ready;
  const control = new ControlClient({ path, adminToken: admin, enrollmentToken: enrollment, controllerId, requestTimeoutMs: timeout }); await control.ready;
  const server = createControllerServer(control, identity);
  t.after(async () => {
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
    await Promise.all([control.close(), identity.close()]); rmSync(dir, { recursive: true, force: true });
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); const port = (server.address() as AddressInfo).port;
  const command = (method: string, route: string, token = admin, body: Record<string, unknown> = {}): HttpCommand => ({ type: "http", method, path: route, query: "", token, body });
  return { path, port, admin, enrollment, control, command, request: (method: string, path: string, value?: unknown, token?: string) => call(port, method, path, value, token) };
}
async function call(port: number, method: string, path: string, value?: unknown, token?: string): Promise<Reply> {
  const data = value === undefined ? undefined : Buffer.from(JSON.stringify(value));
  return await new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path, agent: false, timeout: 5000, headers: {
      ...(data ? { "Content-Type": "application/json", "Content-Length": data.length } : {}), ...(token ? { Authorization: "Bearer " + token } : {}),
    } }, res => {
      const chunks: Buffer[] = []; res.on("data", chunk => chunks.push(chunk as Buffer)); res.once("error", reject);
      res.once("end", () => { try { resolve({ status: res.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString()) as Reply["body"] }); } catch (error) { reject(error); } });
    });
    req.once("error", reject); req.once("timeout", () => req.destroy(new Error("fixture deadline"))); req.end(data);
  });
}

test("controller config preserves strict fields and accepts only explicit enrollment token paths", () => {
  const base = { statePath: "/tmp/fixture.sqlite", adminTokenFile: "/tmp/admin.token", controllerId: randomUUID(), listen: { host: "127.0.0.1", port: 0 } };
  assert.deepEqual(parseControllerConfig(base), base);
  assert.equal(parseControllerConfig({ ...base, enrollmentTokenFile: "/tmp/enrollment.token" }).enrollmentTokenFile, "/tmp/enrollment.token");
  for (const input of [{ ...base, enrollmentTokenFile: "relative" }, { ...base, enrollmentTokenFile: null }, { ...base, enrollmentToken: key() },
    { ...base, listen: { host: "0.0.0.0", port: 0 } }, { ...base, listen: { host: "localhost", port: 0 } },
    { ...base, listen: { host: "127.0.0.1", port: NaN } }, { ...base, tls: { certFile: "/tmp/cert", keyFile: "/tmp/key", insecure: true } },
  ]) assert.throws(() => parseControllerConfig(input));
});

test("one listener reaches all control inventories and legacy identity consumer routes", async t => {
  const f = await fixture(t);
  const setup = await f.request("POST", "/v1/auth/setup", { username: "admin", password }, f.admin);
  assert.equal(setup.status, 200); assert.equal(setup.body.user.role, "admin"); const token = setup.body.token as string;
  for (const [route, field] of [["/v1/machines", "machines"], ["/v1/hosts", "hosts"], ["/v1/templates", "templates"], ["/v1/images", "images"],
    ["/v1/image-tasks", "tasks"], ["/v1/connection-setups", "setups"], ["/v1/models", "models"], ["/v1/jobs", "jobs"], ["/v1/users", "users"], ["/v1/consumers", "consumers"]]) {
    const result = await f.request("GET", route!, undefined, token); assert.equal(result.status, 200, `${route}: ${JSON.stringify(result.body)}`); assert.ok(Array.isArray(result.body[field!]));
  }
  const app = await f.request("POST", "/v1/consumers", { id: randomUUID(), name: "fixture", templates: [], limits: { resources: { cpu: 1, memoryMiB: 1, diskGiB: 1 }, activeLeases: 1 } }, token);
  assert.equal(app.status, 200); assert.equal(typeof app.body.credential, "string");
  assert.equal((await f.request("GET", "/v1/machines", undefined, app.body.credential)).status, 401);
});

test("runtime current authorization separates ordinary users, personal tokens, enrollment and administrator roles", async t => {
  const f = await fixture(t), first = await f.request("POST", "/v1/auth/setup", { username: "admin", password }, f.admin), administrator = first.body.token as string;
  const pending = await f.request("POST", "/v1/users", { id: randomUUID(), username: "alice" }, administrator); assert.equal(pending.status, 200);
  const invite = await f.request("POST", `/v1/users/${pending.body.id}/invite`, {}, administrator);
  const alice = await f.request("POST", "/v1/auth/claim", { token: invite.body.token, password }); assert.equal(alice.status, 200); const session = alice.body.token as string;
  assert.equal((await f.request("GET", "/v1/machines", undefined, session)).status, 200);
  assert.equal((await f.request("GET", "/v1/consumers", undefined, session)).status, 401);
  assert.equal((await f.request("GET", "/v1/users", undefined, session)).status, 403);
  assert.equal((await f.request("GET", "/v1/machines", undefined, f.enrollment)).status, 401);
  const minted = await f.request("POST", "/v1/auth/tokens", { id: randomUUID(), name: "read only", scopes: ["machines:read"] }, session); assert.equal(minted.status, 200); const pat = minted.body.token as string;
  assert.equal((await f.request("GET", "/v1/machines", undefined, pat)).status, 200);
  assert.equal((await f.request("GET", "/v1/auth/session", undefined, pat)).status, 401);
  assert.equal((await f.request("POST", "/v1/machines", {}, pat)).status, 403);
  assert.equal((await f.request("POST", `/v1/auth/tokens/${minted.body.id}/revoke`, {}, session)).status, 200);
  assert.equal((await f.request("GET", "/v1/machines", undefined, pat)).status, 401);
  assert.equal((await f.request("POST", `/v1/users/${pending.body.id}/update`, { status: "disabled" }, administrator)).status, 200);
  assert.equal((await f.request("GET", "/v1/machines", undefined, session)).status, 401);
});

test("control SQLite lock leaves HTTP health responsive; lost mutation acknowledgement is never replayed", async t => {
  const f = await fixture(t), lock = new DatabaseSync(f.path); lock.exec("BEGIN IMMEDIATE");
  const accepted = once(f.control, "accepted"), mutation = f.control.request(f.command("POST", "/v1/auth/bootstrap"));
  const rejected = assert.rejects(mutation, (error: unknown) => error instanceof ServiceError && error.outcome === "unknown" && !error.retryable);
  let closing: Promise<void> | undefined;
  try { await accepted; assert.deepEqual((await f.request("GET", "/healthz")).body, { ok: true }); closing = f.control.close(); await rejected; }
  finally { lock.exec("ROLLBACK"); lock.close(); await closing; }
  await assert.rejects(f.control.request(f.command("GET", "/v1/machines")), (error: unknown) => error instanceof ServiceError && error.status === 503);
});

test("unauthenticated heartbeat is refused before its large declared envelope is read", async t => {
  const f = await fixture(t);
  const result = await new Promise<number>((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port: f.port,
        method: "POST", path: `/v1/hosts/${randomUUID()}/heartbeat`, timeout: 2000,
        headers: { "Content-Length": 8 * 1_048_576, Authorization: "Bearer " + key() },
      }, res => {
        res.resume(); res.once("end", () => resolve(res.statusCode!));
      });
      req.once("error", reject);
      req.once("timeout", () => req.destroy(new Error("Heartbeat body was read before authentication")));
      req.flushHeaders();
  });
  assert.equal(result, 401);
});

test("worker deadlines fence late responses and malformed clone requests remain pre-effect", async t => {
  const f = await fixture(t, 250);
  await assert.rejects(f.control.request(f.command("POST", "/v1/auth/setup", f.admin, { password: () => "invalid" })), (error: unknown) => error instanceof ServiceError && error.status === 400 && error.outcome === undefined);
  assert.deepEqual((await f.control.request(f.command("GET", "/v1/auth/status")))?.body, { setupRequired: true });
  const lock = new DatabaseSync(f.path); lock.exec("BEGIN IMMEDIATE");
  try { await assert.rejects(f.control.request(f.command("POST", "/v1/auth/bootstrap")), (error: unknown) => error instanceof ServiceError && error.outcome === "unknown" && !error.retryable); }
  finally { lock.exec("ROLLBACK"); lock.close(); }
  assert.equal((await f.request("GET", "/v1/auth/status")).status, 503); assert.equal((await f.request("GET", "/healthz")).status, 200);
});

test("startController uses configured enrollment credential and closes idempotently", async t => {
  const dir = mkdtempSync(join(tmpdir(), "canaveral-start-controller-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const admin = key(), enrollment = key(), adminTokenFile = join(dir, "admin.token"), enrollmentTokenFile = join(dir, "enrollment.token");
  writeFileSync(adminTokenFile, admin + "\n", { mode: 0o600 }); writeFileSync(enrollmentTokenFile, enrollment + "\n", { mode: 0o600 });
  const config = { statePath: join(dir, "state.sqlite"), adminTokenFile, enrollmentTokenFile, controllerId: randomUUID(), listen: { host: "127.0.0.1", port: 0 } };
  const controller = await startController(config); t.after(() => controller.close());
  assert.deepEqual((await call(controller.address.port, "GET", "/healthz")).body, { ok: true });
  const host = randomUUID(), credential = key();
  const offer = { name: "fixture", provider: "apple", capacity: { cpu: 4, memoryMiB: 4096, diskGiB: 40 }, templates: [{ id: "linux", revision: "1", os: "linux", arch: "amd64", mode: "headless", minimum: { cpu: 1, memoryMiB: 1024, diskGiB: 4 } }] };
  const enrollmentRequest = { id: host, credential, offer };
  assert.equal((await call(controller.address.port, "POST", "/v1/hosts/enroll", enrollmentRequest, admin)).status, 401);
  assert.equal((await call(controller.address.port, "POST", "/v1/hosts/enroll", enrollmentRequest, enrollment)).status, 200);
  assert.equal((await call(controller.address.port, "POST", `/v1/hosts/${host}/heartbeat`, { offer, reports: {} }, credential)).status, 200);
  await Promise.all([controller.close(), controller.close()]); writeFileSync(enrollmentTokenFile, admin + "\n");
  await assert.rejects(startController(config), /must differ/);
});
