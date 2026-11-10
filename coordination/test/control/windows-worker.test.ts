import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { WindowsProcessWorker, PacketDecoder, packet } from "../../src/guest/windows/ipc.ts";
import { WindowsGuestWorker } from "../../src/guest/windows/worker.ts";
import { WindowsInspections, type UIADetails, type WindowsUIAAPI } from "../../src/guest/windows/accessibility.ts";
import { ConPTY, WindowsTerminalWorker, type TerminalAPI } from "../../src/guest/windows/terminal.ts";
import { nativeTransport } from "../../src/guest/windows/native.ts";
const fixture = resolve(import.meta.dirname, "../../../src/guest/windows/protocol-fixture.mjs");
function transport(mode = "normal", timeoutMs = 1000, authorized = () => true) { return new WindowsProcessWorker({ command: [process.execPath, fixture, mode], timeoutMs, authorized }); }
test("executable bridge framing handles split/coalesced messages and refuses malformed packets", () => {
  const decoder = new PacketDecoder(100), raw = packet({ result: "😀" }, 100);
  assert.deepEqual(decoder.push(raw.subarray(0, 3)), []); assert.deepEqual(decoder.push(Buffer.concat([raw.subarray(3), raw])), [{ result: "😀" }, { result: "😀" }]); decoder.end();
  assert.throws(() => new PacketDecoder(1).push(raw)); const partial = new PacketDecoder(); partial.push(raw.subarray(0, 5)); assert.throws(() => partial.end());
});
test("real child executes Windows native daemon protocol through file worker to verified receipt", async () => {
  const pipe = transport(), worker = new WindowsGuestWorker({ authorized: () => true, transport: pipe, files: { drive: "C:", prefix: [], resolve: path => { assert.equal(path, "/data"); return ["data"]; } } });
  try {
    const id = randomUUID(), request = (route: string, body: object) => worker.request("POST", `/v1/files/${route}`, { id, ...body }) as Promise<Record<string, unknown>>;
    assert.equal((await request("download/begin", { path: "/data" })).state, "reading"); assert.equal(Buffer.from((await request("download/chunk", { offset: 0 })).data as string, "base64").toString(), "hello"); assert.equal((await request("download/finish", {})).state, "verified"); assert.equal(await worker.close(), true);
  } finally { await pipe.close(); }
});
test("executable bridge retains UIA references and refuses replay at guest dispatch", async () => {
  const pipe = transport(), worker = new WindowsGuestWorker({ authorized: () => true, inputAuthorized: () => true, transport: pipe });
  try { const snapshot = await worker.request("POST", "/v1/accessibility/inspect", {}) as { snapshotId: string; nodes: { id: string }[] }; const request = { snapshotId: snapshot.snapshotId, nodeId: snapshot.nodes[1]!.id, nativeAction: "invoke" }; assert.deepEqual(await worker.request("POST", "/v1/accessibility/invoke", request), { status: "posted" }); await assert.rejects(worker.request("POST", "/v1/accessibility/invoke", request), { code: "input_rejected" }); }
  finally { assert.equal(await worker.close(), true); }
});
test("worker lanes allow out-of-order replies and busy refusals without queuing input", async () => {
  const pipe = transport(); try { const slow = pipe.request("delayed", { value: 1 }, { lane: "input", effect: true }); await assert.rejects(pipe.request("echo", {}, { lane: "input" }), { code: "input_busy" }); assert.deepEqual(await pipe.request("echo", { value: 2 }, { lane: "read" }), { value: 2 }); assert.deepEqual(await slow, { value: 1 }); } finally { await pipe.close(); }
});
test("timeouts, bad correlation and oversized acknowledgements fence the owned child", async () => {
  for (const mode of ["hang", "wrong-id", "oversized"]) { const pipe = transport(mode, 100); await assert.rejects(pipe.request("effect", {}, { effect: true }), { outcome: "unknown" }); await assert.rejects(pipe.request("echo", {}), { status: 410 }); assert.equal(await pipe.close(), true); }
});
test("active and idle revocation are sticky and cannot recreate a process", async () => {
  let active = true; const pipe = transport("normal", 1000, () => active); await pipe.request("echo", {}); active = false; await new Promise(r => setTimeout(r, 80)); active = true; await assert.rejects(pipe.request("echo", {}), { status: 410 }); assert.equal(await pipe.close(), true);
});
test("production constructors never fall back to this host on non-Windows", () => { if (process.platform !== "win32") assert.throws(() => nativeTransport(() => true), { code: "capability_unsupported" }); });
function uiaFixture() {
  type Element = { id: number; name: string; children: Element[]; parent?: Element; password?: boolean };
  const button: Element = { id: 2, name: "Save", children: [] }, root: Element = { id: 1, name: "Desktop", children: [button] }; button.parent = root;
  let invoked = 0; let failed = false;
  const api: WindowsUIAAPI<Element> = {
    root: () => root, firstChild: e => e.children[0] ?? null, nextSibling: e => e.parent?.children[(e.parent.children.indexOf(e)) + 1] ?? null, same: (a, b) => a === b,
    describe: e => ({ role: "button", name: e.name, identifier: String(e.id), states: { enabled: true, offscreen: false, password: e.password ?? false }, actions: ["invoke"], bounds: { x: -20, y: 30, width: 120, height: 40 }, properties: { runtimeId: [42, e.id], helpText: e.name, value: e.name } }),
    invoke: () => { invoked++; if (failed) throw new Error("private provider failure"); },
  };
  return { api, root, button, invoked: () => invoked, fail: () => { failed = true; } };
}
test("UIA recycled runtime IDs cannot replace retained native targets", async () => {
  const f = uiaFixture(), inspections = new WindowsInspections(f.api, () => true), snapshot = await inspections.inspect(); f.root.children[0] = { ...f.button };
  await assert.rejects(inspections.invoke({ snapshotId: snapshot.snapshotId, nodeId: "ax-2", nativeAction: "invoke" }), { code: "input_rejected" }); assert.equal(f.invoked(), 0);
});
test("protected UIA nodes redact content and omit protected descendants", async () => {
  const f = uiaFixture(); f.button.password = true; f.button.name = "SECRET"; f.button.children.push({ id: 3, name: "SECRET_CHILD", children: [] }); const snapshot = await new WindowsInspections(f.api, () => true).inspect(); assert.equal(snapshot.nodes.length, 2); assert(!JSON.stringify(snapshot).includes("SECRET"));
});
test("UIA action consumes context on expiry, mutation and uncertain invocation", async () => {
  const f = uiaFixture(); let now = 100; const inspections = new WindowsInspections(f.api, () => true, () => now); let s = await inspections.inspect(); now += 15; await assert.rejects(inspections.invoke({ snapshotId: s.snapshotId, nodeId: "ax-2", nativeAction: "invoke" })); assert.equal(f.invoked(), 0);
  s = await inspections.inspect(); f.fail(); await assert.rejects(inspections.invoke({ snapshotId: s.snapshotId, nodeId: "ax-2", nativeAction: "invoke" }), { outcome: "unknown" }); await assert.rejects(inspections.invoke({ snapshotId: s.snapshotId, nodeId: "ax-2", nativeAction: "invoke" })); assert.equal(f.invoked(), 1);
});
test("terminal binds session and exact write receipt; uncertain input does not replay", async () => {
  const session = randomUUID(); let writes = 0;
  const api: TerminalAPI = { open: binding => ({ session: binding.session }), read: () => ({ session, data: "eA==", offset: 1, truncated: false, exited: false, exitCode: null }), write: () => { writes++; return { written: 0 }; }, resize: () => ({ resized: true }), close: () => ({ closed: true }) };
  const terminal = new ConPTY({ session, executable: "C:\\Windows\\System32\\cmd.exe", argv: ["C:\\Windows\\System32\\cmd.exe"], directory: "C:\\workspace" }, api, () => true);
  await terminal.request("/v1/shell/open", { session, cols: 80, rows: 24 }); await assert.rejects(terminal.request("/v1/shell/write", { session, text: "x" }), { outcome: "unknown" }); await assert.rejects(terminal.request("/v1/shell/write", { session, text: "x" })); assert.equal(writes, 1); assert.equal((await terminal.request("/v1/shell/read", { session, offset: 0 })).data, "eA=="); assert.deepEqual(await terminal.request("/v1/shell/close", { session }), { closed: true });
});
test("forced terminal worker exit never claims native job cleanup", async () => {
  const pipe = transport("hang", 100), session = randomUUID(); const worker = new WindowsTerminalWorker({ session, executable: "C:\\cmd.exe", argv: ["C:\\cmd.exe"], directory: "C:\\workspace" }, pipe, () => true);
  await assert.rejects(worker.request("/v1/shell/open", { session, cols: 80, rows: 24 }), { outcome: "unknown" }); assert.equal(await worker.shutdown(), false); assert.equal(worker.cleanupConfirmed, false);
});
test("Windows server boot authenticates HTTP and drives the executable native daemon fixture", async () => {
  const { startWindowsGuestServer } = await import("../../src/guest/windows/server.ts");
  const pipe = transport(), worker = new WindowsGuestWorker({ authorized: () => true, transport: pipe, files: { drive: "C:", prefix: [], resolve: () => ["data"] } });
  const token = "assignment-scoped-test-token-123456789", service = await startWindowsGuestServer({ worker, token });
  try {
    const url = `http://127.0.0.1:${service.port}`;
    assert.equal((await fetch(`${url}/healthz`)).status, 401);
    assert.deepEqual(await (await fetch(`${url}/healthz`, { headers: { Authorization: `Bearer ${token}` } })).json(), { ok: true });
    const id = randomUUID(), response = await fetch(`${url}/v1/files/download/begin`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ id, path: "/data" }) });
    assert.equal(response.status, 200); assert.equal((await response.json() as { state: string }).state, "reading");
    const unsupported = await fetch(`${url}/v1/files/upload/begin`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: "{}" }); assert.equal(unsupported.status, 409); assert.equal((await unsupported.json() as { code: string }).code, "capability_unsupported");
  } finally { assert.equal(await service.close(), true); }
});
test("owned native publication preserves parent, defaults to no-replace, and returns explicit collision", async () => {
  const { Win32Files } = await import("../../src/guest/windows/native.ts");
  const calls: { action: string; args: Record<string, unknown> }[] = [];
  const api = new Win32Files({ request: async (action, args) => { calls.push({ action, args }); return action === "files.exists" ? true : args.replace ? "published" : "exists"; }, close: async () => true });
  assert.equal(await api.exists("parent-handle", "dangling-link"), true);
  assert.equal(await api.publishOwned("stage-handle", "parent-handle", "target"), "exists"); assert.deepEqual(calls[1], { action: "files.publishOwned", args: { handle: "stage-handle", parent: "parent-handle", name: "target", replace: false } });
  assert.equal(await api.publishOwned("stage-handle", "parent-handle", "target", true), "published"); await assert.rejects(api.exists("parent-handle", "a:b")); assert.equal(calls.length, 3);
});
test("Windows guest requires fresh frame and monotonic input sequence; cleanup can reconcile revocation", async () => {
  let active = true, now = 100, posted = 0;
  const saved: unknown[] = [];
  const worker = new WindowsGuestWorker({ authorized: () => active, cleanupAuthorized: () => true, inputAuthorized: () => true, clock: () => now,
    desktop: { capture: () => ({ bounds: [0, 0, 100, 100], png: Buffer.from("fixture") }), post: async () => { posted++; return { posted: true }; }, close: () => true },
    held: { resolve: () => ({ codes: [[0, 30, 8]] }), save: value => { saved.push(value); return true; } },
  });
  const frame = await worker.request("POST", "/v1/display/capture", {}) as { id: string };
  await worker.request("POST", "/v1/input/key", { frameId: frame.id, sequence: 1, keysym: 65, down: true });
  await assert.rejects(worker.request("POST", "/v1/input/key", { frameId: frame.id, sequence: 1, keysym: 65, down: true }), { code: "input_stale" });
  now += 15; await assert.rejects(worker.request("POST", "/v1/input/key", { frameId: frame.id, sequence: 2, keysym: 65, down: false }), { code: "input_stale" }); assert.equal(posted, 1);
  active = false; await assert.rejects(worker.request("GET", "/healthz")); assert.deepEqual(await worker.request("POST", "/v1/input/reset", {}), { released: true }); assert.equal(posted, 2); assert.equal(saved.length, 4); assert.equal(await worker.close(), true); assert.equal(await worker.close(), true);
});
test("unknown occupancy acknowledgement keeps native cleanup explicitly unconfirmed", async () => {
  const { Win32Files } = await import("../../src/guest/windows/native.ts");
  const { ServiceError } = await import("../../src/errors.ts");
  const api = new Win32Files({ request: async () => { throw new ServiceError("interrupted", 503, { outcome: "unknown" }); }, close: async () => true });
  await assert.rejects(api.exists("parent", "target"), { outcome: "unknown" }); assert.equal(api.cleanupUncertain, true);
});
test("terminal retains positive native cleanup receipt while process-stop confirmation is retried", async () => {
  let closes = 0, stops = 0; const session = randomUUID();
  const pipe = { request: async (action: string) => { assert.equal(action, "terminal.close"); closes++; return { closed: true }; }, close: async () => ++stops > 1 };
  const terminal = new WindowsTerminalWorker({ session, executable: "C:\\cmd.exe", argv: ["C:\\cmd.exe"], directory: "C:\\workspace" }, pipe, () => true);
  assert.equal(await terminal.shutdown(), false); assert.equal(await terminal.shutdown(), true); assert.equal(closes, 1); assert.equal(stops, 2);
});
test("explicit cleanup authority permits only cleanup IPC after idle ordinary revocation", async () => {
  let active = true; const pipe = new WindowsProcessWorker({ command: [process.execPath, fixture], authorized: () => active, cleanupAuthorized: () => true, timeoutMs: 1000 });
  try { await pipe.request("echo", {}); active = false; await new Promise(r => setTimeout(r, 60)); await assert.rejects(pipe.request("echo", {}), { status: 410 }); assert.deepEqual(await pipe.request("echo", { released: true }, { cleanup: true }), { released: true }); active = true; await assert.rejects(pipe.request("echo", {}), { status: 410 }); }
  finally { assert.equal(await pipe.close(), true); }
});
