import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createGuestServer, acceptDashboardSocket, attachShell, serveTerminal } from "../../src/guest/server.ts";
import type { GuestServerServices } from "../../src/guest/server.ts";
import type { SessionChannel, SessionMessage } from "../../src/control/session-protocol.ts";
import { GuestAccess, guestHost, guestReady, guestRecipe, prepareRecipe } from "../../src/guest/access.ts";

async function listening(server: ReturnType<typeof createServer>): Promise<number> { await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); const address = server.address(); assert.ok(address && typeof address !== "string"); return address.port; }
async function close(server: ReturnType<typeof createServer>): Promise<void> { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
async function call(port: number, method: string, path: string, body?: string, headers: Record<string, string> = {}): Promise<{ status: number; body: Buffer; complete: boolean }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, agent: false, headers: { ...(body === undefined ? {} : { "Content-Length": String(Buffer.byteLength(body)) }), ...headers } }, response => {
      const chunks: Buffer[] = [];
      response.on("data", part => chunks.push(part as Buffer));
      const done = () => resolve({ status: response.statusCode!, body: Buffer.concat(chunks), complete: response.complete });
      response.on("end", done); response.on("error", done);
    }); req.once("error", reject); req.end(body);
  });
}
test("guest HTTP authenticates mutations, isolates terminal lanes and enforces headless refusal", async () => {
  const token = "s".repeat(43), auth = { Authorization: `Bearer ${token}` }, calls: string[] = [];
  let releaseUI!: () => void;
  const services: GuestServerServices = {
    ready: () => true,
    async control(action) { calls.push(action); if (action === "accessibility") await new Promise<void>(resolve => { releaseUI = resolve; }); return { done: action }; },
    async download() { assert.fail("unused"); },
    async upload(_path, reader, size) { const data = await reader.read(65536); assert.equal(data.length, size); return { uploaded: size, durable: true }; },
  };
  const server = createGuestServer({ mode: "desktop", token, services }), port = await listening(server);
  try {
    assert.equal((await call(port, "GET", "/healthz")).status, 200);
    assert.equal((await call(port, "POST", "/control", '{"action":"shell-write","arguments":{}}')).status, 401); assert.equal(calls.length, 0);
    const ui = call(port, "POST", "/control", '{"action":"accessibility","arguments":{}}', auth);
    while (!releaseUI) await new Promise(resolve => setImmediate(resolve));
    const shell = await call(port, "POST", "/control", '{"action":"shell-read","arguments":{}}', auth); assert.equal(shell.status, 200);
    releaseUI(); await ui;
    const upload = await call(port, "PUT", "/file", "abc", { ...auth, "X-Canaveral-Path": encodeURIComponent("/file ; literal") }); assert.deepEqual(JSON.parse(upload.body.toString()), { uploaded: 3, durable: true });
    assert.equal((await call(port, "POST", "/control", '{"action":"health","arguments":{}}', { ...auth, Origin: "http://evil.invalid" })).status, 401);
  } finally { releaseUI?.(); await close(server); }
  const headless = createGuestServer({ mode: "headless", token, services }), p = await listening(headless);
  try {
    const result = await call(p, "POST", "/control", '{"action":"screenshot","arguments":{}}', auth);
    assert.equal(result.status, 409); assert.equal(JSON.parse(result.body.toString()).code, "capability_unsupported"); assert.equal(calls.includes("screenshot"), false);
  } finally { await close(headless); }
});
test("guest HTTP pins final download block and verifies empty sources before success headers", async () => {
  const token = "s".repeat(43), auth = { Authorization: `Bearer ${token}`, "X-Canaveral-Path": "/file" }; let size = 3, changed = false, closes = 0;
  const services: GuestServerServices = {
    ready: () => true, async control() { return {}; }, async upload() { assert.fail("unused"); },
    async download() {
      let reads = 0, checks = 0;
      return { size, identity: "f".repeat(64), read: async () => { reads++; return Buffer.from("abc"); }, verify: async () => { checks++; return !(changed && (reads > 0 || checks > 1)); }, close: () => { closes++; } };
    },
  };
  const server = createGuestServer({ mode: "headless", token, services }), port = await listening(server);
  try {
    assert.equal((await call(port, "GET", "/file", undefined, auth)).body.toString(), "abc");
    changed = true;
    await assert.rejects(call(port, "GET", "/file", undefined, auth), { code: "ECONNRESET" });
    size = 0;
    const empty = await call(port, "GET", "/file", undefined, auth); assert.equal(empty.status, 409);
    assert.equal(closes, 3);
  } finally { await close(server); }
});
test("browser WebSocket offers are declined without negotiating compression; per-message revocation closes the stream", async () => {
  let allowed = true, checks = 0, channel: SessionChannel | undefined;
  const stop = new AbortController();
  const server = createServer();
  server.on("upgrade", (request, socket, head) => {
    void (async () => {
      channel = await acceptDashboardSocket({ machineId: randomUUID(), sessionId: undefined, request, socket, head, signal: stop.signal, authorized: async () => { checks++; return allowed; } }, () => true);
      const first = await channel.receive(2); assert.deepEqual(first, { type: "hello" }); await channel.sendControl({ ok: true });
      await channel.receive(2); assert.fail("revoked message must never be delivered");
    })().catch(() => { channel?.close(); socket.destroy(); });
  });
  const port = await listening(server), ws = new WebSocket(`ws://127.0.0.1:${port}/desktop`);
  try {
    await once(ws, "open"); assert.equal(ws.extensions, "");
    ws.send(JSON.stringify({ type: "hello" })); const [event] = await once(ws, "message"); assert.deepEqual(JSON.parse((event as MessageEvent).data as string), { ok: true });
    assert.ok(checks >= 4); allowed = false; const ended = once(ws, "close"); ws.send(JSON.stringify({ type: "private" })); await ended;
  } finally { allowed = false; stop.abort(); channel?.close(); ws.close(); await close(server); }
});
test("attached terminal socket preserves independent byte cursors and no input replay", async () => {
  const stop = new AbortController(), session = randomUUID(); let live = true, writes = 0, resize = 0, reads = 0;
  const server = createServer();
  server.on("upgrade", (request, socket, head) => {
    void attachShell({ machineId: randomUUID(), sessionId: session, request, socket, head, signal: stop.signal, authorized: async () => live }, async req => {
      const args = req.arguments as Record<string, unknown>; assert.equal(args.session, session);
      if (req.action === "shell-write") { writes++; if (args.text === "lost") throw new Error("Lost input response"); return { written: Buffer.byteLength(args.text as string) }; }
      if (req.action === "shell-resize") { resize++; return { resized: true }; }
      assert.equal(req.action, "shell-read"); reads++;
      return { data: "", offset: 0, truncated: false, exited: false, exitCode: null };
    }, () => true).catch(() => socket.destroy());
  });
  const port = await listening(server), ws = new WebSocket(`ws://127.0.0.1:${port}/shell`);
  try {
    await once(ws, "open"); ws.send(JSON.stringify({ action: "shell-resize", arguments: { cols: 100, rows: 30 } }));
    ws.send(JSON.stringify({ action: "shell-write", arguments: { text: "lost" } })); const ended = once(ws, "close"); await ended;
    assert.equal(resize, 1); assert.equal(writes, 1); assert.ok(reads >= 1);
  } finally { live = false; stop.abort(); ws.close(); await close(server); }
});
test("terminal revocation after blocking output read does not release late bytes", async () => {
  let live = true; const output: SessionMessage[] = [];
  const channel: SessionChannel = { receive: async () => null, sendBytes: async v => { output.push(v); }, sendControl: async v => { output.push(v); }, close() {} };
  await serveTerminal(channel, randomUUID(), async () => { live = false; return { data: "c2VjcmV0", offset: 6, truncated: false, exited: false, exitCode: null }; }, () => live);
  assert.deepEqual(output, []);
});
test("guest address and recipe ports preserve ownership and never mutate captured recipes", () => {
  const id = "00112233-4455-6677-8899-aabbccddeeff";
  assert.equal(guestHost(id, "192.168.3.7", "apple"), "192.168.3.7"); assert.throws(() => guestHost(id, "host.invalid", "apple"));
  assert.equal(guestHost(id, undefined, "apple", `{ hw_address=1,2:0:11:22:33:44 ip_address=192.168.64.2 }`), "192.168.64.2");
  assert.throws(() => guestHost(id, undefined, "apple", `{ name=cvm-${id} ip_address=8.8.8.8 }`));
  assert.equal(guestReady({ ready: true }, { mode: "headless" }), false); assert.equal(guestReady({ ready: true }, { mode: "desktop" }), true); assert.equal(guestReady({ ready: true, mode: "headless" }, { mode: "headless" }), true);
  const files = [{ path: "/opt/canaveral/server.mjs", content: "import './guest-service.mjs';", mode: "0644" }], recipe = guestRecipe("ssh-ed25519 Zml4dHVyZQ==", "headless", files), original = structuredClone(recipe);
  const prepared = prepareRecipe(recipe, id, "x".repeat(43), "private fixture", "ssh-ed25519 public fixture", files);
  assert.deepEqual(recipe, original); assert.ok(prepared.commands.at(-1)!.includes(`/var/lib/canaveral/${id}/complete`)); assert.ok(recipe.files.some(f => f.content.includes("/usr/bin/node /opt/canaveral/server.mjs")));
  assert.throws(() => guestRecipe("ssh-ed25519 Zml4dHVyZQ==", "headless", []));
  const legacy = structuredClone(recipe);
  legacy.files.push({ path: "/opt/canaveral/server.py", content: "legacy fixture", mode: "0644" });
  legacy.files.find(f => f.path.endsWith("canaveral-headless.service"))!.content = "legacy fixture";
  const refreshed = prepareRecipe(legacy, id, "x".repeat(43), "private fixture", "ssh-ed25519 public fixture", files);
  assert.equal(refreshed.files.some(f => f.path === "/opt/canaveral/server.py"), false);
  assert.ok(refreshed.files.find(f => f.path.endsWith("canaveral-headless.service"))!.content.includes("--guest-confirmed"));
  assert.equal(legacy.files.some(f => f.path === "/opt/canaveral/server.py"), true);
});
test("host guest access shutdown permanently fences and waits for a late owned binding to close", async () => {
  let releaseResolve!: () => void, releaseClose!: () => void, closed = false, closeDone = false, resolutions = 0;
  const pending = new Promise<void>(resolve => { releaseResolve = resolve; }), closing = new Promise<void>(resolve => { releaseClose = resolve; });
  const access = new GuestAccess(async () => { resolutions++; await pending; return { port: 1, credential: "s".repeat(43), authorized: () => true, close: async () => { await closing; closed = true; } }; });
  const request = access.control({ id: randomUUID() }, { mode: "headless" }, "/unused", { action: "health", arguments: {} }); void request.catch(() => {});
  const stop = access.close().then(() => { closeDone = true; }); releaseResolve(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(closeDone, false); releaseClose(); await stop; await assert.rejects(request); assert.equal(closed, true);
  await assert.rejects(access.control({ id: randomUUID() }, { mode: "headless" }, "/unused", { action: "health", arguments: {} })); assert.equal(resolutions, 1);
});
