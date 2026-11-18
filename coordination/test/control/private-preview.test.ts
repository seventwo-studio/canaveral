import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import { PrivatePreviewGateway } from "../../src/private-preview.ts";

test("handoff and private assets stay bound to the host, live session and lease", async () => {
  let now = 0, active = true;
  const calls: unknown[] = [];
  const gateway = new PrivatePreviewGateway("previews.example.net", "dashboard.example.org", async (session, id) => {
    assert.equal(session, "dashboard-session");
    assert.equal(id, "preview-id");
    calls.push("resolve");
    return active ? { leaseId: "lease", operationId: "op", leaseKey: "key" } : undefined;
  }, async (binding, method, target) => {
    assert.equal(binding.leaseKey, "key");
    calls.push({ method, target });
    return { authorized: active, status: 200, contentType: "text/javascript",
      body: Buffer.from(method === "HEAD" ? "" : "x"), contentLength: 1 };
  }, () => now);
  const issue = () => new URL(gateway.issue("dashboard-session", "preview-id"));
  const url = issue();
  async function visit(path: string, cookie = "", host = url.host, method = "GET") {
    let status = 0;
    const headers: Record<string, string> = {};
    const request = { url: path, method, headers: { host, cookie, authorization: "foreign", referer: "private" }, resume() {} };
    const response = Object.assign(new EventEmitter(), { setHeader(k: string, v: string) { headers[k] = v; },
      writeHead(code: number, h: Record<string, string>) { status = code; Object.assign(headers, h); }, end() {} });
    await gateway.serve(request as unknown as IncomingMessage, response as unknown as ServerResponse);
    return { status, headers };
  }
  assert.equal((await visit(url.pathname, "", issue().host)).status, 404);
  const attempts = await Promise.all([visit(url.pathname), visit(url.pathname)]);
  assert.deepEqual(attempts.map(r => r.status), [303, 404]);
  const cookie = attempts[0]!.headers["Set-Cookie"]!;
  assert.match(cookie, /^__Host-canaveral_preview=[\w-]{43}; Path=\/; Secure; HttpOnly; SameSite=Lax;/);
  assert.equal(attempts[0]!.headers.Location, "/");
  const credential = cookie.split(";")[0]!;
  assert.equal((await visit("/js/app.js?v=1", credential)).status, 200);
  assert.equal((await visit("/", credential, url.host, "HEAD")).headers["Content-Length"], 1);
  assert.equal((await visit("/", credential, issue().host)).status, 404);
  assert.equal((await visit("/", credential, url.host, "POST")).status, 404);
  assert.equal((await visit("/", credential + ";" + credential)).status, 404);
  assert.deepEqual(calls, ["resolve", "resolve", "resolve", { method: "GET", target: "/js/app.js?v=1" }, "resolve", "resolve", "resolve", { method: "HEAD", target: "/" }, "resolve"]);
  active = false;
  assert.equal((await visit("/", credential)).status, 404);
  const expired = issue();
  now = 30_001;
  assert.equal((await visit(expired.pathname, "", expired.host)).status, 404);
  active = true;
  now = 900_001;
  assert.equal((await visit("/", credential)).status, 404);
});

test("controller reader preserves the asset target and sends only its scoped bearer", async t => {
  const { createServer } = await import("node:http");
  const { controllerPreviewReader } = await import("../../src/private-preview.ts");
  const server = createServer((req, res) => {
    assert.equal(req.url, "/v1/leases/lease/previews/op/asset.js?v=2");
    assert.equal(req.headers.authorization, "Bearer lease-only");
    assert.equal(req.headers.cookie, undefined);
    assert.equal(req.headers.origin, undefined);
    res.writeHead(200, { "Content-Type": "application/javascript", "Set-Cookie": "guest=secret", "Content-Length": 3 });
    res.end(req.method === "HEAD" ? undefined : "abc");
  });
  await new Promise<void>((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const read = controllerPreviewReader(new URL("http://127.0.0.1:" + address.port));
  for (const method of ["GET", "HEAD"] as const) {
    const result = await read({ leaseId: "lease", operationId: "op", leaseKey: "lease-only" }, method, "/asset.js?v=2");
    assert.deepEqual(result, { contentType: "application/javascript", status: 200, contentLength: 3,
      body: Buffer.from(method === "GET" ? "abc" : "") });
  }
});

test("parallel assets from separate handoffs share dispatch and reauthorize at both ends", async () => {
  let now = 0;
  const revoked = new Set<string>();
  const reads: string[] = [];
  let notifyStarted!: () => void, finishRead!: () => void;
  const started = new Promise<void>(resolve => { notifyStarted = resolve; });
  const unblock = new Promise<void>(resolve => { finishRead = resolve; });
  const gateway = new PrivatePreviewGateway("preview.example.net", "dashboard.example.org", async session =>
    revoked.has(session) ? undefined : { leaseId: "lease", operationId: "op", leaseKey: "private" },
  async (_binding, _method, path) => {
    reads.push(path);
    if (path === "/first.js") { notifyStarted(); await unblock; }
    return { status: 200, contentType: "text/plain", body: Buffer.from(path) };
  }, () => now);
  function visit(host: string, url: string, cookie = "") {
    const req = { method: "GET", url, headers: { host, cookie }, resume() {} };
    let status = 0, issuedCookie = "", body = "";
    const res = Object.assign(new EventEmitter(), {
      destroyed: false, setHeader() {},
      writeHead(code: number, headers?: Record<string, string>) {
        status = code;
        issuedCookie = headers?.["Set-Cookie"]?.split(";")[0] ?? "";
      },
      end(value?: Buffer) { body = value?.toString() ?? ""; },
    });
    const done = gateway.serve(req as unknown as IncomingMessage, res as unknown as ServerResponse)
      .then(() => ({ status, issuedCookie, body }));
    return { done, disconnect() { res.destroyed = true; res.emit("close"); } };
  }
  async function open(session: string) {
    const url = new URL(gateway.issue(session, "preview"));
    const { issuedCookie } = await visit(url.host, url.pathname).done;
    return (path: string) => visit(url.host, path, issuedCookie);
  }
  const expired = await open("old");
  now = 1000;
  const firstHost = await open("first"), secondHost = await open("second"), thirdHost = await open("third");
  const first = firstHost("/first.js");
  await started;
  const css = secondHost("/style.css"), gone = thirdHost("/cancel"), stale = expired("/expired"),
    revokedWaiter = firstHost("/revoked"), image = thirdHost("/image.png");
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(reads, ["/first.js"]);
  gone.disconnect();
  await gone.done;
  revoked.add("first");
  now = 900_000;
  finishRead();
  assert.deepEqual(await Promise.all([first, css, stale, revokedWaiter, image].map(async r => (await r.done).status)),
    [404, 200, 404, 404, 200]);
  assert.equal((await first.done).body, "");
  assert.deepEqual(reads, ["/first.js", "/style.css", "/image.png"]);
});
