import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer, request as httpRequest } from "node:http";
import type { IncomingHttpHeaders, Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes, randomUUID } from "node:crypto";
import { AuthorizedChannel, AuthorizedReader, AuthorizedRemote, createDashboardServer, startDashboard } from "../../src/dashboard.ts";
import type { DashboardConnectors } from "../../src/dashboard.ts";

const operator = randomBytes(32).toString("base64url"), session = randomBytes(32).toString("base64url");
const machine = randomUUID(), foreignMachine = randomUUID(), host = randomUUID();
type Reply = { status: number; headers: IncomingHttpHeaders; data: Buffer; json(): Record<string, unknown> };
async function listen(server: Server): Promise<string> {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); });
}
function fetch(url: string, path: string, options: { method?: string; token?: string; body?: unknown; raw?: Buffer; headers?: Record<string, string>; omitBody?: boolean } = {}): Promise<Reply> {
  const data = options.raw ?? (options.body === undefined ? undefined : Buffer.from(JSON.stringify(options.body)));
  return new Promise((resolve, reject) => {
    const request = httpRequest(new URL(path, url), {
      method: options.method ?? (data ? "POST" : "GET"), headers: {
        ...(data ? { "Content-Type": "application/json", "Content-Length": String(data.length) } : {}),
        ...(options.token === undefined ? {} : { Authorization: `Bearer ${options.token}` }), ...options.headers,
      },
    }, response => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("error", reject);
      response.on("end", () => { const data = Buffer.concat(chunks); resolve({ status: response.statusCode!, headers: response.headers, data, json: () => JSON.parse(data.toString()) as Record<string, unknown> }); });
    });
    request.on("error", reject); request.end(options.omitBody ? undefined : data);
  });
}
async function fixture(connectors: DashboardConnectors = {}, intervalMs = 1000) {
  const calls: { method: string; path: string; token: string; body: Record<string, unknown>; origin: string | undefined; cookie: string | undefined }[] = [];
  const state = { revoked: false, mismatch: false, authorization: true, brokenMutation: false, admin: true };
  const mutations = new Map<string, Record<string, unknown>>();
  const upstream = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown> : {};
      const token = request.headers.authorization?.slice(7) ?? "";
      calls.push({ method: request.method!, path: request.url!, token, body, origin: request.headers.origin, cookie: request.headers.cookie });
      function send(status: number, value: unknown) { response.writeHead(status, { "Content-Type": "application/json" }); response.end(JSON.stringify(value)); }
      if (request.url === "/v1/auth/status") { send(200, { setupRequired: true }); return; }
      if (["/v1/auth/login", "/v1/auth/claim", "/v1/auth/setup"].includes(request.url!)) { send(200, { token: session, user: { id: "alice", role: "user" } }); return; }
      if (request.url === "/v1/auth/claim/info") { send(200, { kind: "invite" }); return; }
      if (![operator, session].includes(token) || state.revoked) { send(401, { error: "Credential rejected." }); return; }
      if (request.url === "/v1/auth/session") { send(200, { user: { id: "alice", role: "user" } }); return; }
      if (request.url === "/v1/hosts" && !state.admin) { send(403, { error: "Admin required." }); return; }
      if (request.url?.endsWith("/authorize")) {
        if (request.url.includes(foreignMachine)) { send(404, { error: "Unknown machine." }); return; }
        if (!state.authorization) { send(403, { error: "Scope rejected." }); return; }
        send(200, { authorized: true, machineId: state.mismatch ? foreignMachine : machine, action: "access" }); return;
      }
      if (request.method === "POST" && request.url === "/v1/machines") {
        if (state.brokenMutation) { response.destroy(); return; }
        const id = String(body.id), existing = mutations.get(id);
        if (existing && JSON.stringify(existing) !== JSON.stringify(body)) { send(409, { error: "Conflicting intent." }); return; }
        mutations.set(id, body); send(200, { ...body, observed: "pending", ready: false }); return;
      }
      if (request.url === "/v1/auth/logout") state.revoked = true;
      send(200, request.url === "/v1/machines" ? { machines: [...mutations.values()] } : { ok: true });
    })().catch(() => response.destroy());
  });
  const upstreamUrl = await listen(upstream);
  const dashboard = await startDashboard({ orchestratorUrl: upstreamUrl, listen: { host: "127.0.0.1", port: 0 }, bootstrapToken: operator, connectors, reauthorizeMs: intervalMs });
  const url = `http://127.0.0.1:${dashboard.address.port}`;
  return { url, calls, state, mutations, async close() { await dashboard.close(); await close(upstream); } };
}

test("exact static assets use fresh CSP nonces and never contain bootstrap credentials", async () => {
  const f = await fixture();
  try {
    const nonces = [];
    for (let i = 0; i < 2; i++) {
      const reply = await fetch(f.url, "/"); assert.equal(reply.status, 200);
      const nonce = /name="csp-nonce" content="([^"]+)"/.exec(reply.data.toString())?.[1];
      assert.ok(nonce); assert.notEqual(nonce, "CANAVERAL_CSP_NONCE"); nonces.push(nonce);
      assert.ok(reply.headers["content-security-policy"]?.includes(`'nonce-${nonce}'`));
      assert.ok(reply.headers["content-security-policy"]?.includes("script-src 'self';"));
    }
    assert.notEqual(nonces[0], nonces[1]);
    for (const path of ["/", "/app.js", "/style.css", "/favicon.svg", "/launch.jpg", "/geist-mono.woff2", "/licenses.txt"]) {
      const reply = await fetch(f.url, path); assert.equal(reply.status, 200); assert.equal(reply.headers["cache-control"], "no-store");
      assert.equal(reply.headers["x-content-type-options"], "nosniff"); assert.equal(reply.headers["set-cookie"], undefined);
      assert.equal(reply.data.includes(operator), false); assert.ok(reply.headers["content-security-policy"]?.includes("frame-ancestors 'none'"));
    }
    for (const path of ["/../package.json", "/%2e%2e/package.json", "/api/v1/hosts/enroll", `/api/v1/machines/${machine}/prepared`]) assert.equal((await fetch(f.url, path, { token: operator })).status, 404);
    assert.equal((await fetch(f.url, "/api/v1/hosts?url=https://example.com", { token: operator })).status, 400);
    assert.equal((await fetch(f.url, "/healthz")).status, 200);
  } finally { await f.close(); }
});

test("cookie login/claim credentials remain server side, current authorization and same-origin writes", async () => {
  const f = await fixture();
  try {
    for (const route of ["/api/v1/auth/login", "/api/v1/auth/claim", "/api/v1/auth/setup"]) {
      const reply = await fetch(f.url, route, { body: { username: "alice", password: "private fixture password" } });
      assert.equal(reply.status, 200); assert.equal(reply.json().token, undefined);
      assert.ok(reply.headers["set-cookie"]?.[0]?.includes(`canaveral_session=${session}`));
      assert.ok(reply.headers["set-cookie"]?.[0]?.includes("HttpOnly; SameSite=Strict; Max-Age=2592000"));
    }
    assert.equal(f.calls.find(call => call.path === "/v1/auth/setup")?.token, operator);
    assert.ok(f.calls.every(call => call.origin === undefined && call.cookie === undefined));
    const cookie = { Cookie: `canaveral_session=${session}` };
    assert.equal((await fetch(f.url, "/api/v1/machines", { body: {}, headers: cookie })).status, 403);
    assert.equal((await fetch(f.url, "/api/v1/machines", { token: operator, headers: cookie })).status, 400);
    assert.equal((await fetch(f.url, "/api/v1/machines", { headers: cookie })).status, 200);
    const status = await fetch(f.url, "/api/v1/auth/status", { headers: cookie });
    assert.equal(status.json().setupAllowed, true); assert.deepEqual(status.json().user, { id: "alice", role: "user" });
    const logout = await fetch(f.url, "/api/v1/auth/logout", { body: {}, headers: { ...cookie, Origin: f.url } });
    assert.equal(logout.status, 200); assert.ok(logout.headers["set-cookie"]?.[0]?.includes("Max-Age=0"));
    assert.equal((await fetch(f.url, "/api/v1/machines", { headers: cookie })).status, 401);
    const expired = await fetch(f.url, "/api/v1/auth/status", { headers: cookie });
    assert.equal(expired.status, 200); assert.ok(expired.headers["set-cookie"]?.[0]?.includes("Max-Age=0"));
  } finally { await f.close(); }
});

test("remote Host blocks local setup and marks cookies Secure; cross origins and bad credentials are denied", async () => {
  const f = await fixture();
  try {
    for (const token of [undefined, "bad", randomBytes(32).toString("base64url")]) assert.equal((await fetch(f.url, "/api/v1/hosts", token === undefined ? {} : { token })).status, 401);
    for (const origin of ["null", "https://example.com", f.url + ".example.com"]) assert.equal((await fetch(f.url, "/api/v1/hosts", { token: operator, headers: { Origin: origin } })).status, 403);
    for (const site of ["same-site", "cross-site"]) assert.equal((await fetch(f.url, "/api/v1/hosts", { token: operator, headers: { "Sec-Fetch-Site": site } })).status, 403);
    assert.equal((await fetch(f.url, "/api/v1/hosts", { token: operator, headers: { Origin: f.url } })).status, 200);
    const headers = { Host: "dashboard.example", "X-Forwarded-Host": "localhost", "X-Forwarded-For": "127.0.0.1" };
    assert.equal((await fetch(f.url, "/api/v1/auth/setup", { headers, body: {} })).status, 403);
    assert.equal((await fetch(f.url, "/api/v1/auth/status", { headers })).json().setupAllowed, false);
    const login = await fetch(f.url, "/api/v1/auth/login", { headers, body: {} });
    assert.ok(login.headers["set-cookie"]?.[0]?.endsWith("; Secure"));
    assert.equal((await fetch(f.url, "/api/v1/auth/claim/info", { body: {} })).headers["set-cookie"], undefined);
  } finally { await f.close(); }
});

test("malformed bodies never reach upstream; retries retain intent and unconfirmed mutations are uncertain", async () => {
  const f = await fixture();
  try {
    for (const raw of ["[]", "null", "{broken"]) assert.equal((await fetch(f.url, "/api/v1/machines", { token: operator, raw: Buffer.from(raw) })).status, 400);
    assert.equal((await fetch(f.url, "/api/v1/machines", { token: operator, body: {}, headers: { "Content-Type": "text/plain" } })).status, 415);
    assert.equal((await fetch(f.url, "/api/v1/machines", { method: "POST", token: operator, omitBody: true, headers: { "Content-Type": "application/json", "Content-Length": "1048577" } })).status, 413);
    assert.equal(f.calls.length, 0);
    const body = { id: randomUUID(), name: "Private machine" };
    for (let i = 0; i < 2; i++) { const made = await fetch(f.url, "/api/v1/machines", { token: operator, body }); assert.equal(made.status, 200); assert.equal(made.json().ready, false); }
    assert.equal(f.mutations.size, 1);
    assert.equal((await fetch(f.url, "/api/v1/machines", { token: operator, body: { ...body, name: "Changed" } })).status, 409);
    f.state.brokenMutation = true;
    const uncertain = await fetch(f.url, "/api/v1/machines", { token: operator, body: { id: randomUUID() } });
    assert.equal(uncertain.status, 503); assert.equal(uncertain.json().outcome, "unknown"); assert.equal(uncertain.json().retryable, false);
    assert.equal(f.calls.filter(call => call.body.id === uncertain.json().id).length, 0);
  } finally { await f.close(); }
});

test("all guest connectors authorize the exact machine before any side effect and refuse mismatched authorization", async () => {
  let touches = 0;
  const check = () => { touches++; return true; };
  const f = await fixture({
    upload: { check, write: () => { touches++; return {}; } },
    download: { check, open: () => { touches++; return { size: 0, read: () => Buffer.alloc(0), verify() {}, close() {} }; } },
    accessibility: () => { touches++; return {}; },
    desktop: { check, attach() { touches++; } }, shell: { check, attach() { touches++; } },
    imageImport: { check, write: () => { touches++; return {}; } },
  });
  const encoded = Buffer.from(JSON.stringify({ path: "/private" })).toString("base64url");
  try {
    for (const id of [foreignMachine, machine]) {
      if (id === machine) f.state.mismatch = true;
      for (const suffix of ["accessibility", `files/download/${encoded}`, "files/upload", "desktop", `shells/${randomUUID()}/stream`]) {
        const options = suffix === "files/upload" ? { token: session, body: {} } : { token: session };
        assert.equal((await fetch(f.url, `/api/v1/machines/${id}/${suffix}`, options)).status, id === foreignMachine ? 404 : 403);
      }
    }
    f.state.admin = false;
    assert.equal((await fetch(f.url, `/api/v1/hosts/${host}/images/import`, { token: session, body: {} })).status, 403);
    assert.equal(touches, 0);
    f.state.mismatch = false; f.state.authorization = false;
    assert.equal((await fetch(f.url, `/api/v1/machines/${machine}/accessibility`, { token: session })).status, 403);
    assert.equal(touches, 0);
  } finally { await f.close(); }
});

test("streaming upload bypasses the JSON cap and late publication never receives success", async () => {
  let captured = Buffer.alloc(0), revokeOnAck = false;
  let revoke: () => void = () => {};
  const f = await fixture({ upload: { check: () => true, async write({ reader, size, path, app }) {
    assert.equal(path, "/home/fixture.bin"); assert.equal(app, undefined);
    const chunks: Uint8Array[] = []; let received = 0;
    while (received < size) { const data = await reader.read(65536); received += data.length; chunks.push(data); }
    captured = Buffer.concat(chunks);
    if (revokeOnAck) revoke();
    return { uploaded: size };
  } } });
  revoke = () => { f.state.revoked = true; };
  try {
    const payload = Buffer.alloc(2 * 1048576 + 13, "x");
    const options = { token: operator, raw: payload, headers: { "Content-Type": "application/octet-stream", "X-Canaveral-Path": "%2Fhome%2Ffixture.bin" } };
    const reply = await fetch(f.url, `/api/v1/machines/${machine}/files/upload`, options);
    assert.equal(reply.status, 200); assert.equal(reply.json().uploaded, payload.length); assert.deepEqual(captured, payload);
    revokeOnAck = true;
    const uncertain = await fetch(f.url, `/api/v1/machines/${machine}/files/upload`, { ...options, raw: Buffer.from("late") });
    assert.equal(uncertain.status, 503); assert.equal(uncertain.json().outcome, "unknown"); assert.equal(uncertain.json().retryable, false);
  } finally { await f.close(); }
});

test("inspection checks again after provider return; absent native transports fail closed", async () => {
  let inspect: () => void = () => {};
  const f = await fixture({ accessibility: () => { inspect(); return { nodes: [], source: "fixture" }; } });
  try {
    assert.equal((await fetch(f.url, `/api/v1/machines/${machine}/accessibility`, { token: operator })).status, 200);
    for (const suffix of ["desktop", `shells/${randomUUID()}/stream`]) assert.equal((await fetch(f.url, `/api/v1/machines/${machine}/${suffix}`, { token: operator })).status, 409);
    inspect = () => { f.state.revoked = true; };
    const denied = await fetch(f.url, `/api/v1/machines/${machine}/accessibility`, { token: operator });
    assert.equal(denied.status, 401); assert.equal(denied.data.includes("nodes"), false);
  } finally { await f.close(); }
});

test("I/O wrappers fence late bytes and prevent display writes after revocation", async () => {
  let allowed = true, sends = 0;
  const authorized = async () => allowed;
  const reader = new AuthorizedReader({ read() { allowed = false; return Buffer.from("private"); } }, authorized);
  await assert.rejects(reader.read(10), /authorization ended/);
  allowed = true;
  const remote = new AuthorizedRemote({ recv() { allowed = false; return Buffer.from("private"); }, sendall() { sends++; } }, authorized);
  await assert.rejects(remote.recv(10), /authorization ended/); await assert.rejects(remote.sendall(Buffer.from("private")), /authorization ended/);
  const channel = new AuthorizedChannel({ sendBytes() { sends++; }, sendControl() { sends++; }, receive() { sends++; } }, authorized);
  await assert.rejects(channel.sendBytes(Buffer.from("private")), /authorization ended/);
  await assert.rejects(channel.sendControl({ private: true }), /authorization ended/);
  await assert.rejects(channel.receive(), /authorization ended/); assert.equal(sends, 0);
});

test("invalid upstream origins are rejected before reading assets", () => {
  for (const orchestratorUrl of ["http://remote-host:8765", "https://user:pass@example.com", "https://example.com/path", "https://example.com?", "file:///tmp/controller"]) {
    assert.throws(() => createDashboardServer({ orchestratorUrl }));
  }
});

test("download verifies before headers, holds the final block, and closes sources once", async () => {
  let verifyCount = 0, closes = 0, revokeAfterRead = false, changed = false;
  let revoke: () => void = () => {};
  const f = await fixture({ download: { check: () => true, open: () => ({
    size: 7,
    read() { if (revokeAfterRead) revoke(); return Buffer.from("private"); },
    verify() { verifyCount++; if (changed && verifyCount % 2 === 0) throw new Error("Source changed."); },
    close() { closes++; },
  }) } });
  revoke = () => { f.state.revoked = true; };
  const path = `/api/v1/machines/${machine}/files/download/` + Buffer.from(JSON.stringify({ path: "/home/fixture name.txt" })).toString("base64url");
  try {
    const ok = await fetch(f.url, path, { token: operator });
    assert.equal(ok.status, 200); assert.equal(ok.data.toString(), "private"); assert.equal(verifyCount, 2); assert.equal(closes, 1);
    assert.equal(ok.headers["content-disposition"], "attachment; filename*=UTF-8''fixture%20name.txt");
    changed = true;
    await assert.rejects(fetch(f.url, path, { token: operator }));
    assert.equal(verifyCount, 4); assert.equal(closes, 2);
    changed = false; revokeAfterRead = true;
    await assert.rejects(fetch(f.url, path, { token: operator }));
    assert.equal(closes, 3);
  } finally { await f.close(); }
});

test("empty downloads verify and reauthorize before delivering success headers", async () => {
  let opens = 0, verifies = 0, closes = 0;
  let revoke: () => void = () => {};
  const f = await fixture({ download: { check: () => true, open: () => {
    opens++; return { size: 0, read: () => { throw new Error("Empty source cannot be read."); }, verify() { verifies++; revoke(); }, close() { closes++; } };
  } } });
  const path = `/api/v1/machines/${machine}/files/download/` + Buffer.from(JSON.stringify({ path: "/empty" })).toString("base64url");
  try {
    assert.equal((await fetch(f.url, path, { token: operator })).status, 200);
    revoke = () => { f.state.revoked = true; };
    assert.equal((await fetch(f.url, path, { token: operator })).status, 401);
    assert.equal(opens, 2); assert.equal(verifies, 2); assert.equal(closes, 2);
  } finally { await f.close(); }
});

test("periodic reauthorization terminates a blocked upload without acknowledging success", async () => {
  let revoke: () => void = () => {};
  const f = await fixture({ upload: { check: () => true, write() {
    revoke(); return new Promise<never>(() => {});
  } } }, 5);
  revoke = () => { f.state.revoked = true; };
  try {
    const reply = await fetch(f.url, `/api/v1/machines/${machine}/files/upload`, { token: operator, raw: Buffer.from("private"), headers: { "X-Canaveral-Path": "/private" } });
    assert.equal(reply.status, 503); assert.equal(reply.json().outcome, "unknown");
    assert.ok(f.calls.filter(call => call.path.endsWith("/authorize")).length >= 3);
  } finally { await f.close(); }
});

test("image imports enforce admin checks and bounded metadata while streaming the raw file", async () => {
  let received = 0;
  const f = await fixture({ imageImport: { check: () => true, async write({ reader, size, metadata, hostId }) {
    assert.equal(hostId, host); assert.equal(metadata.name, "fixture");
    while (received < size) received += (await reader.read(65536)).length;
    return { imported: received };
  } } });
  try {
    const reply = await fetch(f.url, `/api/v1/hosts/${host}/images/import`, {
      token: operator, raw: Buffer.alloc(1024), headers: { "Content-Type": "application/octet-stream", "X-Canaveral-Image": encodeURIComponent(JSON.stringify({ name: "fixture" })) },
    });
    assert.equal(reply.status, 200); assert.equal(reply.json().imported, 1024);
    assert.equal((await fetch(f.url, `/api/v1/hosts/${host}/images/import`, { token: operator, raw: Buffer.alloc(1024), headers: { "Content-Type": "application/octet-stream", "X-Canaveral-Image": "%bad" } })).status, 400);
  } finally { await f.close(); }
});

test("idle attached WebSockets reauthorize and terminate on revocation; native transport remains injected", async () => {
  let attached = 0, cancellations = 0;
  const f = await fixture({ desktop: { check: () => true, attach({ socket, signal }) {
    attached++;
    socket.write("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n");
    return new Promise<void>(resolve => signal.addEventListener("abort", () => { cancellations++; resolve(); }, { once: true }));
  } } }, 5);
  try {
    await new Promise<void>((resolve, reject) => {
      const request = httpRequest(`${f.url}/api/v1/machines/${machine}/desktop`, { headers: {
        Authorization: `Bearer ${operator}`, Origin: f.url, Connection: "Upgrade", Upgrade: "websocket",
        "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": randomBytes(16).toString("base64"),
      } });
      request.on("error", reject);
      request.on("response", response => { response.resume(); reject(new Error(`Unexpected upgrade refusal: ${response.statusCode}`)); });
      request.on("upgrade", (_response, socket) => {
        f.state.revoked = true;
        socket.on("error", () => {}); socket.once("close", () => resolve()); socket.resume();
      });
      request.end();
    });
    assert.equal(attached, 1); assert.equal(cancellations, 1);
    assert.ok(f.calls.filter(call => call.path.endsWith("/authorize")).length >= 3);
  } finally { await f.close(); }
});
