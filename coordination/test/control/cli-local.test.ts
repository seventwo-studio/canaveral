import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Duplex } from "node:stream";
import test from "node:test";
import { SqliteStore } from "../../src/sqlite.ts";
import { createLocalConnectors } from "../../src/local.ts";
import type { LocalAttachedHost, LocalConnectorOptions, LocalRuntime } from "../../src/local.ts";
import type { StreamAttachment } from "../../src/dashboard.ts";

type Json = Record<string, unknown>;
async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "canaveral-cli-local-"))), id = randomUUID(), hostId = randomUUID();
  const controller = new AbortController(); let now = 100, stopped = false, fenced = false, verified = true, sourceClosed = false;
  let current: Json | undefined = { id, hostId, desired: "running", observed: "running", templateId: "android", resources: { cpu: 1, memoryMiB: 2048, diskGiB: 8 }, template: { id: "android", revision: "1", os: "android", mode: "device", arch: "arm64" } };
  const actions: Json[] = [];
  const runtime: LocalRuntime = {
    kind: "android", control: async (_m, _i, _f, request) => { actions.push(request); if (request.action === "hierarchy") return { output: '<hierarchy><node class="android.widget.Button" text="fixture" clickable="true" bounds="[0,0][50,50]"/></hierarchy>' }; return { value: true }; },
    async streamUpload(_m, _i, _f, _p, _app, reader, size, check) { const data = await reader.read(size); if (!check()) throw new Error("ended"); return { uploaded: data.length, durable: true }; },
    async streamDownload() { return { size: 3, async read() { return Buffer.from("abc"); }, async verify() { return verified; }, close() { sourceClosed = true; } }; },
    async displayDensity() { return 1; },
  };
  const host: LocalAttachedHost = {
    state: root, config: { templates: [] }, offer: { templates: [] }, identity: { id: hostId, credential: "private", orchestrator: "http://127.0.0.1" }, assignments: [], lastContact: 100,
    clock: { now: () => now, suspendAware: true }, guard: { allowed: () => !fenced, beginExecution() { if (fenced) throw new Error("fenced"); } },
    get stopping() { return stopped; }, context(machine) { return { runtime, image: machine.template as Json, folder: join(root, "machines", id) }; }, close() {},
  };
  const store = new SqliteStore(join(root, "db"));
  const options: LocalConnectorOptions = { hosts: () => [host], machine: requested => requested === id ? current : undefined, store, signal: controller.signal,
    async attachShell(request, control, check) { assert.ok(check()); await control({ id: randomUUID(), action: "shell-read", arguments: { session: request.sessionId, offset: 0 } }); },
    async attachDisplay(_request, _factory, attached, check) { assert.equal(attached.host, host); assert.ok(check()); },
  };
  const connectors = createLocalConnectors(options);
  const attachment = (): StreamAttachment => ({ machineId: id, sessionId: randomUUID(), request: {} as StreamAttachment["request"], socket: new Duplex({ read() {}, write(_chunk, _encoding, callback) { callback(); } }), head: Buffer.alloc(0), authorized: async () => true, signal: controller.signal });
  return { id, host, runtime, options, connectors, controller, actions, attachment, mutate: (fn: (value: Json) => void) => fn(current!), setCurrent: (value: Json | undefined) => { current = value; }, stale: () => { now = 121; }, stop: () => { stopped = true; }, fence: () => { fenced = true; }, badDigest: () => { verified = false; }, sourceClosed: () => sourceClosed, close: () => fs.rm(root, { recursive: true, force: true }) };
}
async function withFixture(work: (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>) { const f = await fixture(); try { await work(f); } finally { f.controller.abort(); await f.close(); } }

test("local wires upload, download, desktop, shell and normalized accessibility to an attached runtime", async () => withFixture(async f => {
  assert.ok(await f.connectors.upload!.check(f.id)); assert.ok(await f.connectors.download!.check(f.id)); assert.ok(await f.connectors.desktop!.check(f.id)); assert.ok(await f.connectors.shell!.check(f.id));
  const uploaded = await f.connectors.upload!.write({ machineId: f.id, path: "/fixture", app: undefined, size: 3, reader: { async read() { return Buffer.from("abc"); } } as never, authorized: async () => true });
  assert.deepEqual(uploaded, { uploaded: 3, durable: true });
  const download = await f.connectors.download!.open(f.id, "/fixture", undefined); assert.deepEqual(await download.read(3), Buffer.from("abc")); await download.verify(); await download.close(); assert.ok(f.sourceClosed());
  await f.connectors.desktop!.attach(f.attachment()); await f.connectors.shell!.attach(f.attachment());
  const snapshot = await f.connectors.accessibility!(f.id) as { source: string; nodes: unknown[] };
  assert.equal(snapshot.source, "android-uiautomator"); assert.equal(snapshot.nodes.length, 1); assert.deepEqual(f.actions.map(action => action.action), ["shell-read", "hierarchy"]);
}));
test("local refuses foreign machines, stopping/fenced/stale hosts and changed controller desired state", async () => withFixture(async f => {
  assert.equal(await f.connectors.desktop!.check(randomUUID()), false);
  f.mutate(machine => { machine.hostId = randomUUID(); }); assert.equal(await f.connectors.upload!.check(f.id), false);
  f.mutate(machine => { machine.hostId = f.host.identity!.id; machine.desired = "stopped"; }); assert.equal(await f.connectors.download!.check(f.id), false);
  f.mutate(machine => { machine.desired = "running"; }); f.fence(); assert.equal(await f.connectors.shell!.check(f.id), false);
}));
test("local detects host contact loss and authorization loss after a blocking download read", async () => withFixture(async f => {
  const source = await f.connectors.download!.open(f.id, "/fixture", undefined);
  delete f.runtime.streamDownload;
  f.stale(); await assert.rejects(async () => source.read(3), /authorization ended/); await source.close(); assert.ok(f.sourceClosed());
  assert.equal(await f.connectors.desktop!.check(f.id), false);
}));
test("local never releases an unverified download as complete", async () => withFixture(async f => {
  const source = await f.connectors.download!.open(f.id, "/fixture", undefined); f.badDigest(); await assert.rejects(async () => source.verify(), /identity changed/); await source.close();
}));
test("local upload reauthorizes after a blocking input read", async () => withFixture(async f => {
  let allowed = true;
  await assert.rejects(async () => f.connectors.upload!.write({ machineId: f.id, path: "/fixture", app: undefined, size: 3, authorized: async () => allowed, reader: { async read() { allowed = false; return Buffer.from("abc"); } } as never }), /authorization ended during read/);
}));
test("local guestAccess machines use their attached guest transport for files and shell", async () => withFixture(async f => {
  f.mutate(machine => { machine.template = { ...(machine.template as Json), os: "linux", mode: "desktop", guestAccess: true }; });
  const guest = { control: f.runtime.control!, streamUpload: f.runtime.streamUpload!, streamDownload: f.runtime.streamDownload! };
  Object.defineProperty(f.host, "guestAccess", { value: guest }); delete f.runtime.control; delete f.runtime.streamUpload; delete f.runtime.streamDownload;
  assert.equal(await f.connectors.upload!.check(f.id), true); assert.equal(await f.connectors.shell!.check(f.id), true);
  await f.connectors.shell!.attach(f.attachment()); assert.equal(f.actions.at(-1)!.action, "shell-read");
}));
test("local image importer publishes through controller reservation and immutable host library", async () => withFixture(async f => {
  const { MachineStore } = await import("../../src/control/machines.ts");
  const { secret } = await import("../../src/errors.ts");
  const operator = "o".repeat(43), enrollment = "e".repeat(43);
  const machines = new MachineStore(f.options.store, { adminToken: operator, enrollmentToken: enrollment, controllerId: randomUUID() });
  // The attached importer requires an actual registered online host, but does not invoke its provider.
  const credential = secret("h".repeat(43));
  const offer = { name: "local", provider: "libvirt", capacity: { cpu: 4, memoryMiB: 8192, diskGiB: 64 }, templates: [] };
  const request = { method: "POST", path: "/v1/hosts/enroll", parts: ["v1", "hosts", "enroll"], query: new URLSearchParams(), token: enrollment, body: { id: f.host.identity!.id, credential, offer }, principal: () => ({ kind: "operator" as const, user: null, scopes: [] }) };
  await machines.handle(request);
  const { initializeInference } = await import("../../src/control/inference.ts"); f.options.store.transaction(db => initializeInference(db));
  f.host.config = { ...offer }; f.host.offer = { ...offer, templates: [] };
  const id = randomUUID(), metadata = { id, name: "fixture base", os: "linux", arch: process.arch === "arm64" ? "arm64" : "amd64", mode: "headless", mediaType: "disk", format: "raw", minimum: { cpu: 1, memoryMiB: 1024, diskGiB: 1 } };
  let remaining = 512;
  const result = await f.connectors.imageImport!.write({ hostId: f.host.identity!.id, metadata, size: 512, authorized: async () => true, reader: { async read(n: number) { const size = Math.min(n, remaining); remaining -= size; return Buffer.alloc(size); } } as never }) as Json;
  assert.equal(result.id, id); assert.ok((f.host.config.templates as Json[]).some(template => template.id === id));
  const images = f.options.store.transaction(db => db.prepare("SELECT metadata FROM images WHERE id=?").get(id)); assert.ok(images);
}));

test("default local shell connector upgrades a real socket and forwards input once", async () => withFixture(async f => {
  const { createServer } = await import("node:http");
  const controller = new AbortController(); let completed!: () => void;
  const finished = new Promise<void>(done => { completed = done; });
  const options = { ...f.options }; delete options.attachShell;
  const connectors = createLocalConnectors(options);
  f.runtime.control = async (_m, _i, _f, request) => {
    f.actions.push(request);
    if (request.action === "shell-read") return { data: Buffer.from("fixture-terminal").toString("base64"), offset: 16, truncated: false, exited: true, exitCode: 0 };
    return { written: 1 };
  };
  const server = createServer();
  server.on("upgrade", (request, socket, head) => { void Promise.resolve(connectors.shell!.attach({ ...f.attachment(), request, socket, head, signal: controller.signal })).catch(() => {}).finally(completed); });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as import("node:net").AddressInfo;
  const client = new WebSocket(`ws://127.0.0.1:${port}/shell`); client.binaryType = "arraybuffer";
  const received: Array<string | ArrayBuffer> = [];
  try {
    await new Promise<void>((done, reject) => {
      const timeout = setTimeout(() => reject(new Error("local terminal fixture timed out")), 2000);
      client.addEventListener("open", () => client.send(JSON.stringify({ action: "shell-write", arguments: { text: "x" } })));
      client.addEventListener("message", event => received.push(event.data as string | ArrayBuffer));
      client.addEventListener("close", () => { clearTimeout(timeout); done(); });
      client.addEventListener("error", () => { clearTimeout(timeout); if (received.some(value => typeof value === "string" && value.includes('"exited":true'))) done(); else reject(new Error("local terminal fixture socket failed")); });
    });
    await finished;
    assert.equal(f.actions.filter(request => request.action === "shell-write").length, 1);
    assert.ok(received.some(value => value instanceof ArrayBuffer && Buffer.from(value).toString() === "fixture-terminal"));
  } finally { controller.abort(); client.close(); await new Promise<void>(done => server.close(() => done())); }
}));

test("default local simulator desktop connector serves RFB over a real socket", async () => withFixture(async f => {
  const { createServer } = await import("node:http");
  const options = { ...f.options }; delete options.attachDisplay;
  const connectors = createLocalConnectors(options);
  // PNG header is sufficient for the native-shaped frame adapter fixture; no image decoder runs.
  const png = Buffer.alloc(24); Buffer.from([137,80,78,71,13,10,26,10]).copy(png); png.write("IHDR", 12); png.writeUInt32BE(1, 16); png.writeUInt32BE(1, 20);
  f.runtime.control = async (_m, _i, _f, request) => { f.actions.push(request); return request.action === "screenshot" ? { data: png.toString("base64") } : {}; };
  const controller = new AbortController(); let completed!: () => void;
  const finished = new Promise<void>(done => { completed = done; }); const server = createServer();
  const failures: unknown[] = [];
  server.on("upgrade", (request, socket, head) => { void Promise.resolve(connectors.desktop!.attach({ ...f.attachment(), request, socket, head, signal: controller.signal })).catch((error: unknown) => failures.push(error)).finally(completed); });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as import("node:net").AddressInfo;
  const client = new WebSocket(`ws://127.0.0.1:${port}/desktop`); client.binaryType = "arraybuffer";
  let buffer = Buffer.alloc(0), state = 0; const controls: string[] = [];
  try {
    await new Promise<void>((done, reject) => {
      const timeout = setTimeout(() => reject(new Error("local desktop fixture timed out")), 2000);
      const finish = () => { clearTimeout(timeout); done(); };
      client.addEventListener("message", event => {
        if (typeof event.data === "string") { controls.push(event.data); if (event.data.includes("view-only")) finish(); return; }
        buffer = Buffer.concat([buffer, Buffer.from(event.data as ArrayBuffer)]);
        if (state === 0 && buffer.length >= 12) { assert.equal(buffer.subarray(0,12).toString(), "RFB 003.008\n"); buffer = buffer.subarray(12); state = 1; client.send(Buffer.from("RFB 003.008\n")); }
        if (state === 1 && buffer.length >= 2) { assert.deepEqual(buffer.subarray(0,2), Buffer.from([1,1])); buffer = buffer.subarray(2); state = 2; client.send(Buffer.from([1])); }
        if (state === 2 && buffer.length >= 4) { buffer = buffer.subarray(4); state = 3; client.send(Buffer.from([1])); }
        if (state === 3 && buffer.length >= 24) { assert.equal(buffer.readUInt16BE(), 1); }
      });
      client.addEventListener("error", () => { clearTimeout(timeout); reject(new Error("local desktop fixture socket failed: " + JSON.stringify({ failures: failures.map(error => error instanceof Error ? error.message : String(error)), actions: f.actions, state, controls }))); });
    });
    assert.ok(controls.some(value => value.includes("view-only"))); assert.ok(f.actions.some(action => action.action === "screenshot"));
  } finally { controller.abort(); client.close(); await finished; await new Promise<void>(done => server.close(() => done())); }
}));

test("offline local consolidation retains machine ownership, disk reservations and original backup", async () => withFixture(async f => {
  const { consolidateLocalHost } = await import("../../src/local.ts");
  const { MachineStore, initializeMachines } = await import("../../src/control/machines.ts");
  const { normalizeTemplate } = await import("../../src/control/templates.ts");
  const { legacyDigest } = await import("../../src/control/templates.ts");
  const { DatabaseSync } = await import("node:sqlite");
  const root = f.host.state, path = join(root, "controller.sqlite3"), store = new SqliteStore(path);
  const target = randomUUID(), source = randomUUID(), machineId = randomUUID(), owner = randomUUID(), token = "c".repeat(43);
  const linux = normalizeTemplate({ id: "linux", revision: "1", os: "linux", mode: "headless", arch: "arm64", minimum: { cpu: 2, memoryMiB: 2048, diskGiB: 10 } });
  const android = normalizeTemplate({ id: "android", revision: "1", os: "android", mode: "device", arch: "arm64", device: { systemImage: "system-images;android-35;google_apis;arm64-v8a", profile: "pixel_8" }, minimum: { cpu: 2, memoryMiB: 2048, diskGiB: 8 } });
  const capacity = { cpu: 4, memoryMiB: 8192, diskGiB: 64 };
  const original = { id: machineId, name: "owned", templateId: "linux", resources: { cpu: 2, memoryMiB: 2048, diskGiB: 10 } };
  store.transaction(db => {
    initializeMachines(db);
    db.prepare("INSERT INTO hosts VALUES (?,?,?,?,1)").run(target, legacyDigest("d".repeat(43)), JSON.stringify({ name: "android", provider: "android", capacity, templates: [android] }), store.clock());
    db.prepare("INSERT INTO hosts VALUES (?,?,?,?,1)").run(source, legacyDigest(token), JSON.stringify({ name: "apple", provider: "apple", capacity, templates: [linux] }), store.clock());
    db.prepare("INSERT INTO machines(id,request,host,template,desired,observed,detail,updated,intent,owner) VALUES(?,?,?,?,'running','running','',?,?,?)").run(machineId, JSON.stringify(original), source, JSON.stringify(linux), store.clock(), JSON.stringify(original), owner);
  });
  const a = join(root, "agent"), b = join(root, "linux-agent");
  await fs.mkdir(a, { mode: 0o700 }); await fs.mkdir(b, { mode: 0o700 });
  const definition = { name: "local-macos", provider: "macos", capacity: { cpu: 8, memoryMiB: 16384, diskGiB: 128 }, runtimes: { apple: {}, android: {} }, templates: [linux, android] };
  await consolidateLocalHost(root, [a, b], [{ state: a, id: target }, { state: b, id: source }], definition);
  store.transaction(db => {
    const row = db.prepare("SELECT * FROM machines WHERE id=?").get(machineId)!;
    assert.equal(row.host, target); assert.equal(row.owner, owner); assert.deepEqual(JSON.parse(String(row.request)), original); assert.deepEqual(JSON.parse(String(row.template)), linux);
    assert.equal(db.prepare("SELECT target FROM retired_runners WHERE id=?").get(source)!.target, target);
  });
  const saved = new DatabaseSync(join(root, "before-physical-host.sqlite3"), { readOnly: true });
  try { assert.equal(saved.prepare("SELECT host FROM machines WHERE id=?").get(machineId)!.host, source); } finally { saved.close(); }
  const machines = new MachineStore(store, { adminToken: "o".repeat(43), controllerId: randomUUID() });
  assert.throws(() => machines.authenticateHost(source, token), /retired/);
}));
test("offline consolidation refuses a historical native lock before changing identities", async () => withFixture(async f => {
  const { consolidateLocalHost } = await import("../../src/local.ts");
  const state = join(f.host.state, "legacy"); await fs.mkdir(state, { mode: 0o700 }); await fs.writeFile(join(state, "agent.lock"), "");
  await assert.rejects(consolidateLocalHost(f.host.state, [state], [{ state, id: randomUUID() }], {}), /native runner locks/);
  await fs.stat(join(state, "agent.lock")); await assert.rejects(fs.stat(join(f.host.state, "before-physical-host.sqlite3")));
}));
