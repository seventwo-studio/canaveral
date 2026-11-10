import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import http from "node:http";
import type { IncomingHttpHeaders, OutgoingHttpHeaders } from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { createControllerServer, createControllerUpgradeHandler } from "../../src/control/http.ts";
import type { HttpCommand } from "../../src/control/client.ts";
import type { ControlResponse } from "../../src/control/contracts.ts";
import { ServiceError } from "../../src/errors.ts";
import type { IdentityClient } from "../../src/identity-client.ts";
import type { IdentityCommand } from "../../src/identity-protocol.ts";

interface Reply { status: number; body: Record<string, unknown>; headers: IncomingHttpHeaders }
async function fixture(t: { after(fn: () => Promise<void>): void }, dispatch: (command: HttpCommand) => Promise<ControlResponse | undefined> = async () => undefined) {
  const identityCommands: IdentityCommand[] = [], controls: HttpCommand[] = [];
  const identities = { async request(command: IdentityCommand) {
    identityCommands.push(command);
    if (command.type === "authorize") return { authorized: true };
    if (command.type === "applications.create") return { id: (command.body as { id: string }).id };
    return { consumers: [] };
  } } as unknown as IdentityClient;
  const server = createControllerServer({ async authorizeHost() {}, async request(command) { controls.push(command); return await dispatch(command); } }, identities);
  t.after(async () => { await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  function raw(path: string, method = "GET", data?: Buffer, headers: OutgoingHttpHeaders = {}): Promise<Reply> {
    return new Promise((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port, path, method, headers, agent: false, timeout: 5000 }, res => {
        const chunks: Buffer[] = [];
        res.on("data", chunk => chunks.push(chunk as Buffer));
        res.once("error", reject);
        res.once("end", () => {
          try { resolve({ status: res.statusCode!, headers: res.headers, body: JSON.parse(Buffer.concat(chunks).toString()) as Reply["body"] }); }
          catch (error) { reject(error); }
        });
      });
      req.once("error", reject); req.once("timeout", () => req.destroy(new Error("fixture deadline"))); req.end(data);
    });
  }
  function post(path: string, value: unknown, headers: OutgoingHttpHeaders = {}) {
    const data = Buffer.from(JSON.stringify(value));
    return raw(path, "POST", data, { "Content-Type": "application/json", "Content-Length": data.length, ...headers });
  }
  return { raw, post, controls, identityCommands, server, port };
}

test("composite parses once, gives control first refusal and preserves legacy identity mutations", async t => {
  const f = await fixture(t, async req => req.path === "/v1/machines" ? { status: 201, body: { created: req.body.id } } : undefined);
  const id = randomUUID();
  assert.deepEqual((await f.post("/v1/machines", { id })).body, { created: id });
  assert.equal(f.identityCommands.length, 0);
  const identity = await f.post("/v1/consumers", { id });
  assert.equal(identity.status, 200);
  assert.deepEqual(identity.body, { id });
  assert.deepEqual(f.identityCommands.map(command => command.type), ["authorize", "applications.create"]);
  assert.deepEqual(f.controls.map(command => command.path), ["/v1/machines", "/v1/consumers"]);
});

test("account routes cannot fall through to legacy authentication", async t => {
  const f = await fixture(t);
  for (const route of ["/v1/auth/status", "/v1/auth/unknown", "/v1/users", "/v1/admin/tokens"]) {
    assert.equal((await f.raw(route)).status, 404);
  }
  assert.equal(f.identityCommands.length, 0);
});

test("Python credential boundary: Origin, Cookie, URL proofs and duplicate authorization fail before dispatch", async t => {
  const f = await fixture(t), token = randomBytes(32).toString("base64url");
  const results = await Promise.all([
    f.raw("/healthz", "GET", undefined, { Origin: "https://other.invalid" }),
    f.raw("/healthz", "GET", undefined, { Cookie: "session=" + token }),
    f.raw("/v1/machines?%74oKeN=" + token),
    f.raw("/v1/machines?access_token=" + token),
    f.raw("/v1/machines?credential=" + token),
    f.raw("/v1/machines", "GET", undefined, { Authorization: ["Bearer " + token, "Bearer " + token] }),
  ]);
  assert.deepEqual(results.map(result => result.status), [403, 400, 400, 400, 400, 400]);
  for (const result of results) {
    assert.equal(result.headers["cache-control"], "no-store");
    assert.equal(result.body.retryable, false);
    assert.equal(typeof result.body.requestId, "string");
    assert.equal(JSON.stringify(result.body).includes(token), false);
  }
  assert.equal(f.controls.length, 0); assert.equal(f.identityCommands.length, 0);
});

test("invalid targets, malformed JSON/UTF-8, non-object bodies and framing cannot mutate", async t => {
  const f = await fixture(t);
  const results = await Promise.all([
    f.raw("//v1/machines"), f.raw("/v1/../machines"), f.raw("/v1/%2e%2e/machines"), f.raw("/v1%2fmachines"),
    f.raw("/v1/machines", "GET", undefined, { "Content-Length": "1" }),
    f.raw("/v1/machines", "POST", Buffer.from("{}"), { "Transfer-Encoding": "chunked" }),
    f.raw("/v1/machines", "POST", Buffer.from("[]"), { "Content-Length": 2 }),
    f.raw("/v1/machines", "POST", Buffer.from("no-json"), { "Content-Length": 7 }),
    f.raw("/v1/machines", "POST", Buffer.from([0xff]), { "Content-Length": 1 }),
    f.raw("/v1/machines", "POST", undefined, { "Content-Length": 1_048_577 }),
    f.raw("/v1/machines", "POST", undefined, { "Content-Length": 0 }),
    f.post("/v1/machines", {}, { Expect: "100-continue" }),
  ]);
  assert.deepEqual(results.map(result => result.status), [400, 400, 400, 400, 400, 400, 400, 400, 400, 413, 413, 400]);
  assert.equal(f.controls.length, 0);
});

test("unexpected failures redact provider details and preserve mutation uncertainty", async t => {
  const secret = randomBytes(32).toString("base64url");
  const f = await fixture(t, async () => { throw new Error("provider password=" + secret); });
  const failed = await f.post("/v1/machines", {});
  assert.equal(failed.status, 503); assert.equal(failed.body.outcome, "unknown");
  assert.equal(failed.body.retryable, false); assert.equal(JSON.stringify(failed.body).includes(secret), false);
  const read = await f.raw("/v1/machines");
  assert.equal(read.body.outcome, undefined);
  assert.deepEqual((await f.raw("/healthz")).body, { ok: true });
});

test("HTTP worker accounting caps pending requests and health remains available after release", async t => {
  let unblock!: () => void, announce!: () => void;
  const barrier = new Promise<void>(resolve => { unblock = resolve; });
  const started = new Promise<void>(resolve => { announce = resolve; });
  let count = 0;
  const f = await fixture(t, async () => { if (++count === 64) announce(); await barrier; return { body: {} }; });
  const pending = Array.from({ length: 64 }, () => f.raw("/v1/machines"));
  try {
    await started;
    assert.equal((await f.raw("/v1/machines")).status, 429);
    assert.equal(count, 64);
  } finally { unblock(); await Promise.all(pending); }
  assert.deepEqual((await f.raw("/healthz")).body, { ok: true });
});

test("malformed WebSocket upgrades are refused without claiming a peer", async t => {
  const f = await fixture(t);
  let admissions = 0;
  f.server.on("upgrade", createControllerUpgradeHandler((_req, socket) => { admissions++; socket.end(); }));
  const path = `/v1/leases/${randomUUID()}/sessions/${randomUUID()}/${randomUUID()}`;
  async function upgrade(target: string, extra: string) {
    const socket = net.connect(f.port, "127.0.0.1");
    await once(socket, "connect");
    socket.write(`GET ${target} HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Protocol: canaveral-session-v1\r\n${extra}\r\n`);
    let value = "";
    for await (const chunk of socket) value += String(chunk);
    return value;
  }
  for (const [target, extra, status] of [
    [path, "Origin: https://other.invalid\r\n", 403],
    [path, "Cookie: private\r\n", 400],
    [path + "?credential=private", "", 400],
    [path, "Content-Length: 0\r\n", 400],
    [path, "Sec-WebSocket-Extensions: permessage-deflate\r\n", 400],
  ] as const) {
    assert.match(await upgrade(target, extra), new RegExp(`^HTTP/1.1 ${status} `));
  }
  assert.equal(admissions, 0);
});

test("explicit pre-effect refusals keep their status and do not invent uncertain outcomes", async t => {
  const f = await fixture(t, async () => { throw new ServiceError("Credential rejected.", 401); });
  const result = await f.post("/v1/machines", {});
  assert.equal(result.status, 401); assert.equal(result.body.outcome, undefined);
});
