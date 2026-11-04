import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import {
  ConsumerClient, ConsumerConfigurationError, ConsumerProtocolError, ConsumerServiceError, ConsumerTransportError, LeaseClient,
} from "../src/consumer-client.ts";
import type { AcquireRequest } from "../src/consumer-client.ts";

const appKey = randomBytes(32).toString("base64url");
const leaseKey = randomBytes(32).toString("base64url");
const leaseId = randomUUID();
const capabilities = { command: true, pty: true, files: true, screenshot: false, displayStream: false, input: false, hierarchy: false };
const resources = { cpu: 2, memoryMiB: 2048, diskGiB: 20 };
const lease = (revision = 1, state = "ready") => ({
  id: leaseId, state, runtimeState: "running", revision, createdAt: "2026-01-01T00:00:00Z", expiresAt: "2026-01-01T01:00:00Z",
  cleanup: { state: "notRequested" },
  members: [{ name: "primary", machineId: randomUUID(), state: "running", ready: true, capabilities, resources }],
  capabilities,
});
const image = {
  id: "linux-base", revision: "1", os: "linux", arch: "amd64", mode: "headless", minimum: resources, defaults: resources,
  memoryStepMiB: 256, available: true, capabilities,
};
const acquire: AcquireRequest = {
  id: leaseId, templateId: "linux-base", templateRevision: "1", arch: "amd64", name: "job", ttlSeconds: 600,
  resources: { cpu: 2 }, requiredCapabilities: ["command", "files"],
};

interface Seen { method: string; url: string; headers: http.IncomingHttpHeaders; body: string }
type Handler = (request: http.IncomingMessage, response: http.ServerResponse, seen: Seen) => void;
function json(response: http.ServerResponse, status: number, value: unknown, headers: http.OutgoingHttpHeaders = {}) {
  const data = Buffer.from(JSON.stringify(value));
  response.writeHead(status, { "Content-Type": "application/json", "Content-Length": data.length, ...headers });
  response.end(data);
}
async function server(t: TestContext, handler: Handler, tlsOptions?: https.ServerOptions) {
  const seen: Seen[] = [];
  const listener: http.RequestListener = (request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", chunk => chunks.push(chunk as Buffer));
    request.on("end", () => {
      const entry = { method: request.method!, url: request.url!, headers: request.headers, body: Buffer.concat(chunks).toString() };
      seen.push(entry); handler(request, response, entry);
    });
  };
  const instance = tlsOptions ? https.createServer(tlsOptions, listener) : http.createServer(listener);
  instance.on("tlsClientError", () => undefined);
  await new Promise<void>(resolve => instance.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => { instance.close(() => resolve()); instance.closeAllConnections(); }));
  const port = (instance.address() as AddressInfo).port;
  return { seen, url: `${tlsOptions ? "https" : "http"}://127.0.0.1:${port}` };
}
const plain = (url: string) => ({ baseUrl: url, allowLoopbackHttp: true });
const app = (url: string, extra = {}) => new ConsumerClient({ ...plain(url), applicationKey: appKey, ...extra });
const scoped = (url: string, extra = {}) => new LeaseClient({ ...plain(url), leaseId, leaseKey, ...extra });

test("application client covers catalogue, paging, acquire, inspect, renew and release", async t => {
  const renewId = randomUUID(); const releaseId = randomUUID(); const cursor = randomUUID();
  const { seen, url } = await server(t, (request, response) => {
    const path = request.url!;
    if (path === "/v1/environments/templates") json(response, 200, { templates: [image], limits: { activeLeases: 2 } });
    else if (path === `/v1/leases?after=${cursor}`) json(response, 200, { leases: [lease()], nextCursor: null });
    else if (path === "/v1/leases" && request.method === "GET") json(response, 200, { leases: [lease()], nextCursor: cursor });
    else if (path === "/v1/leases") json(response, seen.filter(s => s.url === "/v1/leases" && s.method === "POST").length === 1 ? 201 : 200, lease(1, "provisioning"));
    else if (path === `/v1/leases/${leaseId}`) json(response, 200, lease(2));
    else if (path.endsWith("/renew")) json(response, 200, { mutation: { id: renewId, state: "ready", revision: 2, expiresAt: "2026-01-01T02:00:00Z" }, lease: lease(2) });
    else if (path.endsWith("/release")) json(response, 200, { mutation: { id: releaseId, state: "released", revision: 3, expiresAt: "2026-01-01T02:00:00Z" }, lease: lease(3, "released") });
    else json(response, 404, { error: "x", message: "x", code: "not_found", requestId: randomUUID(), retryable: false });
  });
  const client = app(url);
  assert.equal((await client.catalogue()).templates[0]?.id, "linux-base");
  const first = await client.listLeases();
  assert.equal(first.nextCursor, cursor);
  assert.equal((await client.listLeases({ after: first.nextCursor! })).nextCursor, null);
  const created = await client.acquireLease(acquire);
  assert.equal(created.created, true);
  const replay = await client.acquireLease(acquire);
  assert.equal(replay.created, false);
  assert.equal((await client.inspectLease(leaseId)).revision, 2);
  const renewed = await client.renewLease(leaseId, { id: renewId, expectedRevision: 1, ttlSeconds: 900 });
  assert.equal(renewed.mutation.revision, 2);
  const released = await client.releaseLease(leaseId, { id: releaseId });
  assert.equal(released.lease.state, "released");
  for (const entry of seen) {
    assert.equal(entry.headers.authorization, "Bearer " + appKey);
    assert.equal(entry.headers.origin, undefined);
    assert.equal(entry.headers.cookie, undefined);
  }
  assert.deepEqual(seen.map(s => `${s.method} ${s.url.split("?")[0]}`), [
    "GET /v1/environments/templates", "GET /v1/leases", "GET /v1/leases", "POST /v1/leases", "POST /v1/leases",
    `GET /v1/leases/${leaseId}`, `POST /v1/leases/${leaseId}/renew`, `POST /v1/leases/${leaseId}/release`,
  ]);
});

test("caller-owned identity and body are sent unchanged and identically on explicit replay", async t => {
  const { seen, url } = await server(t, (_request, response) => json(response, 200, lease()));
  const client = app(url);
  await client.acquireLease(acquire);
  await client.acquireLease({ ...acquire });
  assert.equal(seen[0]!.body, seen[1]!.body);
  assert.deepEqual(JSON.parse(seen[0]!.body), {
    id: acquire.id, templateId: "linux-base", templateRevision: "1", arch: "amd64", name: "job",
    resources: { cpu: 2 }, ttlSeconds: 600, requiredCapabilities: ["command", "files"],
  });
  assert.equal(seen[0]!.headers["content-type"], "application/json");
  assert.equal(seen[0]!.headers["content-length"], String(Buffer.byteLength(seen[0]!.body)));
});

test("lease client uses only the lease credential on lease routes and cannot act as the application", async t => {
  const renewId = randomUUID();
  const { seen, url } = await server(t, (request, response) => {
    if (request.method === "GET") json(response, 200, lease());
    else {
      json(response, 200, { mutation: { id: renewId, state: "ready", revision: 2, expiresAt: "2026-01-01T02:00:00Z" }, lease: lease(2) });
    }
  });
  const client = scoped(url);
  await client.inspect();
  await client.renew({ id: renewId, expectedRevision: 1, ttlSeconds: 60 });
  await client.release({ id: renewId });
  assert.ok(seen.every(s => s.headers.authorization === "Bearer " + leaseKey && s.url.startsWith(`/v1/leases/${leaseId}`)));
  for (const name of ["catalogue", "listLeases", "acquireLease", "rotate", "rotateLeaseCredential"]) {
    assert.equal((client as unknown as Record<string, unknown>)[name], undefined);
  }
  assert.ok(!seen.some(s => s.headers.authorization?.includes(appKey)));
});

test("invalid requests and configuration fail before any request or credential use", async t => {
  const { seen, url } = await server(t, (_request, response) => json(response, 200, lease()));
  const client = app(url);
  await assert.rejects(client.acquireLease({ ...acquire, id: "not-a-uuid" }), ConsumerConfigurationError);
  await assert.rejects(client.acquireLease({ ...acquire, idempotencyKey: "x" } as AcquireRequest), ConsumerConfigurationError);
  await assert.rejects(client.acquireLease({ ...acquire, requiredCapabilities: ["command", "command"] }), ConsumerConfigurationError);
  await assert.rejects(client.renewLease(leaseId, { id: randomUUID(), expectedRevision: 0, ttlSeconds: 5 }), ConsumerConfigurationError);
  await assert.rejects(client.inspectLease("../../admin"), ConsumerConfigurationError);
  await assert.rejects(client.listLeases({ after: "x" }), ConsumerConfigurationError);
  assert.equal(seen.length, 0);
  const bad = (options: Record<string, unknown>) => () => new ConsumerClient({ applicationKey: appKey, baseUrl: url, ...options } as never);
  assert.throws(bad({ allowLoopbackHttp: false }), ConsumerConfigurationError);
  assert.throws(bad({ baseUrl: "http://example.com", allowLoopbackHttp: true }), ConsumerConfigurationError);
  assert.throws(bad({ baseUrl: "http://localhost:1", allowLoopbackHttp: true }), ConsumerConfigurationError);
  assert.throws(bad({ baseUrl: "https://user:pw@example.com" }), ConsumerConfigurationError);
  assert.throws(bad({ baseUrl: "https://example.com/?key=" + appKey }), ConsumerConfigurationError);
  assert.throws(bad({ allowLoopbackHttp: true, ca: "x" }), ConsumerConfigurationError);
  assert.throws(bad({ applicationKey: "short" , allowLoopbackHttp: true }), ConsumerConfigurationError);
  assert.throws(bad({ baseUrl: "https://example.com", ca: "not a pem" }), ConsumerConfigurationError);
  assert.throws(bad({ baseUrl: "https://example.com", caFile: "/nonexistent/ca.pem" }), ConsumerConfigurationError);
  assert.throws(bad({ allowLoopbackHttp: true, timeoutMs: 0 }), ConsumerConfigurationError);
});

test("structured and legacy service errors keep status, code and conservative mutation outcome", async t => {
  const requestId = randomUUID();
  let mode = 0;
  const { url } = await server(t, (_request, response) => {
    mode++;
    if (mode === 1) json(response, 409, { error: "Conflict", message: `Bad ${appKey}`, code: "conflict", requestId, retryable: false });
    else if (mode === 2) json(response, 429, { error: "Limit", message: "slow", code: "limit_exceeded", requestId, retryable: true }, { "Retry-After": "60" });
    else if (mode === 3) json(response, 503, { error: "Orchestrator storage or service unavailable." });
    else json(response, 503, { error: "Orchestrator storage or service unavailable." });
  });
  const client = app(url);
  const conflict = await client.acquireLease(acquire).then(() => assert.fail(), e => e);
  assert.ok(conflict instanceof ConsumerServiceError);
  assert.equal(conflict.status, 409); assert.equal(conflict.code, "conflict"); assert.equal(conflict.requestId, requestId);
  assert.equal(conflict.outcome, undefined);
  assert.ok(!conflict.message.includes(appKey));
  const limited = await client.acquireLease(acquire).then(() => assert.fail(), e => e);
  assert.ok(limited instanceof ConsumerServiceError);
  assert.equal(limited.retryAfterSeconds, 60); assert.equal(limited.retryable, true); assert.equal(limited.outcome, undefined);
  const down = await client.releaseLease(leaseId, { id: requestId }).then(() => assert.fail(), e => e);
  assert.ok(down instanceof ConsumerServiceError);
  assert.equal(down.status, 503); assert.equal(down.outcome, "unknown"); assert.equal(down.requestId, requestId);
  const read = await client.inspectLease(leaseId).then(() => assert.fail(), e => e);
  assert.equal(read.outcome, undefined);
});

test("non-JSON, malformed, wrong-shape and oversized replies are protocol errors without retry", async t => {
  const replies: Array<(response: http.ServerResponse) => void> = [
    response => { response.writeHead(200, { "Content-Type": "text/html" }); response.end("<html>proxy</html>"); },
    response => { response.writeHead(200, { "Content-Type": "application/json" }); response.end("{not json"); },
    response => json(response, 200, { id: leaseId }),
    response => { response.writeHead(502, { "Content-Type": "text/html" }); response.end("bad gateway"); },
    response => json(response, 202, lease()),
    response => json(response, 200, { ...lease(), padding: "x".repeat(5000) }),
    response => { response.writeHead(200, { "Content-Type": "application/json" }); response.write("{\"padding\":\""); response.write("x".repeat(5000)); response.end("\"}"); },
    response => { response.writeHead(200, { "Content-Type": "text/plain" }); response.end("read"); },
  ];
  let index = 0;
  const { seen, url } = await server(t, (_request, response) => replies[index++]!(response));
  const client = app(url, { maxResponseBytes: 2048 });
  const codes = ["content_type_invalid", "response_invalid", "response_invalid", "content_type_invalid", "response_invalid", "response_too_large", "response_too_large"];
  for (const code of codes) {
    const error = await client.acquireLease(acquire).then(() => assert.fail("accepted"), e => e);
    assert.ok(error instanceof ConsumerProtocolError, String(error));
    assert.equal(error.code, code); assert.equal(error.outcome, "unknown"); assert.equal(error.requestId, acquire.id);
  }
  assert.equal(seen.length, codes.length);
  const reads = await app(url).inspectLease(leaseId).then(() => assert.fail(), e => e);
  assert.equal(reads.outcome, undefined);
});

test("dropped replies, truncated bodies and timeouts leave an unknown outcome and never retry", async t => {
  let mode = 0;
  const { seen, url } = await server(t, (request, response) => {
    mode++;
    if (mode === 1) request.socket.destroy();
    else if (mode === 2) { response.writeHead(200, { "Content-Type": "application/json", "Content-Length": 500 }); response.write("{\"id\":"); setTimeout(() => request.socket.destroy(), 20); }
    else { /* never answer */ }
  });
  const client = app(url, { timeoutMs: 300 });
  for (const code of ["connection_failed", "connection_failed", "timeout"]) {
    const error = await client.renewLease(leaseId, { id: acquire.id, expectedRevision: 1, ttlSeconds: 60 }).then(() => assert.fail(), e => e);
    assert.ok(error instanceof ConsumerTransportError);
    assert.equal(error.code, code); assert.equal(error.outcome, "unknown"); assert.equal(error.retryable, false);
    assert.equal(error.requestId, acquire.id);
  }
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.equal(seen.length, 3);
  assert.equal(seen[0]!.body, seen[2]!.body);
  const read = await client.inspectLease(leaseId).then(() => assert.fail(), e => e);
  assert.equal(read.code, "timeout"); assert.equal(read.outcome, undefined);
});

test("redirects are refused and the bearer never reaches the target", async t => {
  const target = await server(t, (_request, response) => json(response, 200, lease()));
  const origin = await server(t, (_request, response) => {
    response.writeHead(307, { Location: target.url + "/v1/leases", "Content-Length": 0 }); response.end();
  });
  const client = app(origin.url);
  const error = await client.acquireLease(acquire).then(() => assert.fail(), e => e);
  assert.ok(error instanceof ConsumerProtocolError);
  assert.equal(error.code, "redirect_refused"); assert.equal(error.outcome, "unknown");
  assert.ok(!error.message.includes(appKey) && !error.message.includes(target.url));
  await assert.rejects(client.catalogue(), (e: ConsumerProtocolError) => e.code === "redirect_refused" && e.outcome === undefined);
  assert.equal(target.seen.length, 0);
});

// Verified HTTPS with generated private authorities.
function authority(directory: string, name: string, san: string) {
  const run = (...args: string[]) => {
    const result = spawnSync("openssl", args, { cwd: directory, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  };
  run("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", `${name}-ca.key`, "-out", `${name}-ca.pem`, "-days", "2",
    "-subj", `/CN=${name} test CA`);
  writeFileSync(join(directory, `${name}.ext`), `subjectAltName=${san}\nbasicConstraints=CA:FALSE\n`);
  run("req", "-newkey", "rsa:2048", "-nodes", "-keyout", `${name}.key`, "-out", `${name}.csr`, "-subj", "/CN=fixture");
  run("x509", "-req", "-in", `${name}.csr`, "-CA", `${name}-ca.pem`, "-CAkey", `${name}-ca.key`, "-CAcreateserial",
    "-out", `${name}.pem`, "-days", "2", "-extfile", `${name}.ext`);
  return { ca: join(directory, `${name}-ca.pem`), cert: readFileSync(join(directory, `${name}.pem`)), key: readFileSync(join(directory, `${name}.key`)) };
}

test("HTTPS verifies the chain and hostname and accepts an explicit custom CA", async t => {
  const directory = mkdtempSync(join(tmpdir(), "canaveral-consumer-sdk-tls-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const good = authority(directory, "good", "IP:127.0.0.1");
  const other = authority(directory, "other", "IP:127.0.0.1");
  const wrongName = authority(directory, "wrongname", "DNS:elsewhere.example");
  const trusted = await server(t, (_request, response) => json(response, 200, { templates: [], limits: {} }), { cert: good.cert, key: good.key });
  const mismatched = await server(t, (_request, response) => json(response, 200, { templates: [], limits: {} }), { cert: wrongName.cert, key: wrongName.key });

  assert.deepEqual((await new ConsumerClient({ baseUrl: trusted.url, applicationKey: appKey, caFile: good.ca }).catalogue()).templates, []);
  assert.deepEqual((await new ConsumerClient({ baseUrl: trusted.url, applicationKey: appKey, ca: readFileSync(good.ca) }).catalogue()).templates, []);
  assert.equal(trusted.seen[0]!.headers.authorization, "Bearer " + appKey);
  const before = trusted.seen.length;
  const refused = [
    new ConsumerClient({ baseUrl: trusted.url, applicationKey: appKey }),                       // not in default trust
    new ConsumerClient({ baseUrl: trusted.url, applicationKey: appKey, caFile: other.ca }),     // unrelated CA
    new ConsumerClient({ baseUrl: mismatched.url, applicationKey: appKey, caFile: wrongName.ca }), // hostname mismatch
  ];
  for (const client of refused) {
    await assert.rejects(client.acquireLease(acquire), (e: ConsumerTransportError) =>
      e.code === "tls_verification_failed" && e.outcome === undefined && !e.message.includes(appKey));
  }
  assert.equal(trusted.seen.length, before);
  assert.equal(mismatched.seen.length, 0);
  // Plain HTTP to a TLS port is not silently upgraded or downgraded.
  const downgrade = new ConsumerClient({ ...plain(trusted.url.replace("https", "http")), applicationKey: appKey });
  await assert.rejects(downgrade.catalogue());
});

test("mutation confirmations bind lease and caller mutation identity without retry", async t => {
  let wrong = "lease";
  const mutationId = randomUUID();
  const { url, seen } = await server(t, (request, response) => {
    const view = { ...lease(), id: wrong === "lease" ? randomUUID() : leaseId };
    if (request.url === "/v1/leases") json(response, 201, view);
    else json(response, 200, { mutation: { id: wrong === "mutation" ? randomUUID() : mutationId,
      state: "ready", revision: 2, expiresAt: "2026-01-01T02:00:00Z" }, lease: view });
  });
  const client = app(url);
  const unknown = (e: unknown) => e instanceof ConsumerProtocolError && e.outcome === "unknown";
  await assert.rejects(client.acquireLease(acquire), unknown);
  for (wrong of ["lease", "mutation"]) {
    await assert.rejects(client.renewLease(leaseId, { id: mutationId, expectedRevision: 1, ttlSeconds: 60 }), unknown);
    await assert.rejects(client.releaseLease(leaseId, { id: mutationId }), unknown);
  }
  assert.equal(seen.length, 5);
  await assert.rejects(client.inspectLease(leaseId + "\n"), ConsumerConfigurationError);
  assert.throws(() => new ConsumerClient({ ...plain(url), applicationKey: appKey + "\n" }), ConsumerConfigurationError);
  assert.equal(seen.length, 5);
});

test("typed lifecycle and capability fields reject malformed success replies", async t => {
  let reply: unknown;
  const { url } = await server(t, (_request, response) => json(response, 200, reply));
  const client = app(url);
  for (const changed of [{ state: "not-a-state" }, { revision: 0 }, { cleanup: { state: "invented" } }, { capabilities: { command: "false" } }]) {
    reply = { ...lease(), ...changed };
    await assert.rejects(client.inspectLease(leaseId), e => e instanceof ConsumerProtocolError && e.outcome === undefined);
  }
});
