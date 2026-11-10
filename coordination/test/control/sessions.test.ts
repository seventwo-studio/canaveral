import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { connect as netConnect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AccessSessions, createSessionUpgradeHandler, SessionConnection, SqliteSessionReceipts } from "../../src/control/sessions.ts";
import type { SessionView } from "../../src/control/sessions.ts";
import type { RunnerSessionJob } from "../../src/control/session-protocol.ts";
import { initializeMachines } from "../../src/control/machines.ts";
import { initializeLeases } from "../../src/control/leases.ts";
import { legacyDigest } from "../../src/control/templates.ts";
import { ServiceError } from "../../src/errors.ts";
import { SqliteStore } from "../../src/sqlite.ts";
const key = (): string => randomBytes(32).toString("base64url");
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "sessions-port-")); let now = 1_800_000_000;
  const store = new SqliteStore(join(dir, "state.sqlite"), () => now);
  store.transaction(db => { initializeMachines(db); initializeLeases(db); });
  const options = { controllerId: randomUUID(), adminToken: key() }, sessions = new AccessSessions(store, options);
  const app = sessions.applications.create({ id: randomUUID(), name: "session fixture", templates: [], limits: { activeLeases: 10, resources: { cpu: 10, memoryMiB: 32000, diskGiB: 100 } } });
  const host = randomUUID(), hostToken = key(), lease = randomUUID(), token = key(), machine = randomUUID();
  const image = { id: "fixture-android", revision: "1", arch: "arm64", os: "android", mode: "device", runtime: "android", device: { systemImage: "system-images;android-35;google_apis;arm64-v8a", profile: "pixel" }, minimum: { cpu: 1, memoryMiB: 1024, diskGiB: 5 }, preparationDriver: "none" };
  const offer = { provider: "android", leaseProtocol: 1, templates: [image], leaseImages: [{ id: image.id, revision: image.revision, arch: image.arch, runtime: "android" }] };
  store.transaction(db => {
    db.prepare("INSERT INTO hosts VALUES (?,?,?,?,1)").run(host, legacyDigest(hostToken), JSON.stringify(offer), now);
    db.prepare("INSERT INTO machines (id,request,host,template,desired,observed,detail,updated,preparation_state,prepared_at,owner) VALUES (?,?,?,?,'running','running','',?,'ready',?,NULL)")
      .run(machine, JSON.stringify({ id: machine, resources: image.minimum }), host, JSON.stringify(image), now, now);
    db.prepare("INSERT INTO leases VALUES (?,?,?,'ready',1,?,?,?,?,'notRequested')").run(lease, app.id, "{}", now, now + 120, now + 60, legacyDigest(token));
    db.prepare("INSERT INTO lease_members VALUES (?,'primary',?)").run(lease, machine);
  });
  const request = (capability = "pty") => ({ id: randomUUID(), member: "primary", capability });
  const create = (capability = "pty") => sessions.create(lease, token, request(capability)).session;
  const attach = (s: SessionView, side: "host" | "consumer" = "consumer", more = {}) => sessions.sessionCommand({ type: "sessions.attach", sessionId: s.id, generation: s.generation, side, ownerId: side === "host" ? host : lease, token: side === "host" ? hostToken : token, ...more }) as SessionView;
  return { store, options, sessions, app, host, hostToken, lease, token, machine, offer, request, create, attach,
    advance: (n: number) => { now += n; }, refresh: () => store.transaction(db => { db.prepare("UPDATE hosts SET seen=? WHERE id=?").run(now, host); }),
    cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
function status(code: number) { return (e: unknown): boolean => e instanceof ServiceError && e.status === code; }
test("legacy admission, scoped role, exact member/capability, replay and terminal tombstones", t => {
  const f = fixture(); t.after(f.cleanup);
  const r = f.request(), first = f.sessions.create(f.lease, f.token, r);
  assert.equal(first.created, true); assert.deepEqual(f.sessions.create(f.lease, f.token, r), { created: false, session: first.session });
  assert.throws(() => f.sessions.create(f.lease, f.app.credential, r));
  assert.throws(() => f.sessions.create(f.lease, f.options.adminToken, r));
  assert.throws(() => f.sessions.create(f.lease, f.token, { ...r, capability: "upload" }), status(409));
  assert.throws(() => f.sessions.create(f.lease, f.token, { ...f.request(), member: "other" }), status(404));
  assert.throws(() => f.sessions.create(f.lease, f.token, { ...f.request(), capability: "host-shell" }), status(400));
  for (const capability of ["display", "upload", "download", "accessibility"]) assert.equal(f.create(capability).capability, capability);
  const serialized = JSON.stringify(first.session); for (const secret of [f.host, f.hostToken, f.token, f.machine]) assert.ok(!serialized.includes(secret));
  assert.equal(f.sessions.inspect(f.lease, r.id, f.token, true).state, "closed");
  assert.equal(f.sessions.create(f.lease, f.token, r).session.state, "closed");
  assert.throws(() => f.attach(first.session), status(410));
});
test("peer ownership/generation, duplicate claims, rotation, exact deadlines and restart fencing", t => {
  const f = fixture(); t.after(f.cleanup); const s = f.create();
  assert.throws(() => f.attach(s, "host", { ownerId: randomUUID() }));
  assert.throws(() => f.attach(s, "consumer", { generation: randomUUID() }), status(409));
  assert.equal(f.attach(s).state, "attaching"); assert.throws(() => f.attach(s), status(409));
  assert.equal(f.attach(s, "host").state, "ready");
  assert.deepEqual(f.sessions.sessionCommand({ type: "sessions.authorized", sessionId: s.id, generation: s.generation, ready: true }), { authorized: true });
  const nextToken = key(); f.store.transaction(db => db.prepare("UPDATE leases SET credential=? WHERE id=?").run(legacyDigest(nextToken), f.lease));
  assert.equal(f.sessions.inspect(f.lease, s.id, nextToken).state, "revoked");
  assert.throws(() => f.sessions.inspect(f.lease, s.id, f.token));
  const pending = f.sessions.create(f.lease, nextToken, f.request()).session; f.advance(30); f.refresh();
  assert.equal(f.sessions.inspect(f.lease, pending.id, nextToken).state, "expired");
  const ready = f.sessions.create(f.lease, nextToken, f.request()).session;
  f.sessions.sessionCommand({ type: "sessions.attach", sessionId: ready.id, generation: ready.generation, side: "consumer", ownerId: f.lease, token: nextToken });
  f.attach(ready, "host");
  const restarted = new AccessSessions(f.store, f.options); assert.equal(restarted.inspect(f.lease, ready.id, nextToken).state, "disconnected");
  assert.throws(() => restarted.sessionCommand({ type: "sessions.attach", sessionId: ready.id, generation: ready.generation, side: "host", ownerId: f.host, token: f.hostToken }), status(410));
  const text = f.store.transaction(db => JSON.stringify(db.prepare("SELECT * FROM control_access_sessions").all()));
  assert.ok(!text.includes(nextToken)); assert.ok(!text.includes(f.hostToken));
});
test("lease renewal, host loss, explicit protocol withdrawal and expiry terminate authority", t => {
  const f = fixture(); t.after(f.cleanup); const s = f.create(); f.attach(s); f.attach(s, "host");
  f.store.transaction(db => db.prepare("UPDATE leases SET expires=expires+60 WHERE id=?").run(f.lease));
  assert.ok(f.sessions.inspect(f.lease, s.id, f.token).authorizationDeadline > s.authorizationDeadline);
  f.advance(30); assert.equal(f.sessions.inspect(f.lease, s.id, f.token).state, "disconnected");
  f.refresh(); const other = f.create(); f.attach(other); f.attach(other, "host");
  f.store.transaction(db => db.prepare("UPDATE hosts SET offer=? WHERE id=?").run(JSON.stringify({ ...f.offer, leaseProtocol: undefined }), f.host));
  assert.deepEqual(f.sessions.sessionCommand({ type: "sessions.authorized", sessionId: other.id, generation: other.generation }), { authorized: false });
  assert.throws(() => f.create(), status(409));
});
test("existing Python session receipts migrate preserving terminal and disconnected replay identities", t => {
  const f = fixture(); t.after(f.cleanup); const closed = f.request(), live = f.request(), generations = [randomUUID(), randomUUID()];
  f.store.transaction(db => {
    db.exec("CREATE TABLE access_sessions (id TEXT PRIMARY KEY,lease TEXT,machine TEXT,host TEXT,request TEXT,generation TEXT,credential TEXT,state TEXT,created REAL,attach_deadline REAL,deadline REAL,consumer_attached INTEGER,host_attached INTEGER)");
    for (const [i, request] of [closed, live].entries()) db.prepare("INSERT INTO access_sessions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)").run(request.id, f.lease, f.machine, f.host, JSON.stringify(request), generations[i]!, legacyDigest(f.token), i === 0 ? "closed" : "ready", 1800000000, 1800000030, 1800000120, 1, 1);
  });
  const restored = new AccessSessions(f.store, f.options);
  assert.equal(restored.inspect(f.lease, closed.id, f.token).state, "closed");
  assert.equal(restored.create(f.lease, f.token, closed).created, false);
  assert.equal(restored.create(f.lease, f.token, closed).session.generation, generations[0]);
  assert.equal(restored.inspect(f.lease, live.id, f.token).state, "disconnected");
  const again = new AccessSessions(f.store, f.options); assert.equal(again.inspect(f.lease, closed.id, f.token).state, "closed");
  assert.throws(() => again.sessionCommand({ type: "sessions.attach", sessionId: live.id, generation: generations[1]!, side: "consumer", ownerId: f.lease, token: f.token }), status(410));
});
test("durable runner attempts refuse reconnect after active/unknown outcomes and changed binding", t => {
  const f = fixture(); t.after(f.cleanup);
  const receipts = new SqliteSessionReceipts(f.store), job: RunnerSessionJob = { id: randomUUID(), generation: randomUUID(), leaseId: f.lease, machineId: f.machine, capability: "pty" };
  assert.equal(receipts.claim(job), true); receipts.update(job, "unknown", "unknown");
  assert.equal(new SqliteSessionReceipts(f.store).claim(job), false);
  assert.throws(() => receipts.claim({ ...job, generation: randomUUID() }), status(409));
  const prior = { ...job, id: randomUUID() };
  const directory = mkdtempSync(join(tmpdir(), "session-old-attempt-")); t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, prior.id + ".json"), "uncertain legacy receipt");
  assert.equal(new SqliteSessionReceipts(f.store, directory).claim(prior), false);
});
test("real loopback broker ready/ordered forwarding, binary direction rejection and disconnected no-replay", async t => {
  const f = fixture(); t.after(f.cleanup);
  const broker = createSessionUpgradeHandler({ request: async command => f.sessions.sessionCommand(command) });
  const server = createServer(); server.on("upgrade", (req, socket, head) => { void broker.handle(req, socket, head); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { broker.close(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); assert.ok(address && typeof address === "object"); const origin = `http://127.0.0.1:${address.port}`;
  const s = f.create(), consumer = await SessionConnection.connect(origin, `/v1/leases/${f.lease}/sessions/${s.id}/${s.generation}`, f.token), host = await SessionConnection.connect(origin, `/v1/hosts/${f.host}/sessions/${s.id}/${s.generation}`, f.hostToken);
  t.after(() => { consumer.close(); host.close(); });
  for (const c of [consumer, host]) assert.deepEqual(await c.receive(), { type: "ready", sessionId: s.id, generation: s.generation, capability: "pty" });
  const command = { action: "shell-write", arguments: { text: "fixture text" } };
  await consumer.sendControl(command); assert.deepEqual(await host.receive(), command);
  await host.sendBytes(Buffer.from("hello\r\n")); assert.equal(Buffer.from(await consumer.receive() as Uint8Array).toString(), "hello\r\n");
  await consumer.sendBytes(Buffer.from("forbidden input")); await assert.rejects(host.receive());
  assert.equal(f.sessions.inspect(f.lease, s.id, f.token).state, "disconnected");
  await assert.rejects(SessionConnection.connect(origin, `/v1/hosts/${f.host}/sessions/${s.id}/${s.generation}`, f.hostToken));
});

test("Linux sessions reuse current runner binding and readiness without legacy credential crossover", t => {
  const f = fixture(); t.after(f.cleanup);
  const s = f.sessions, domain = randomUUID(), runnerToken = key(), binding = { controllerId: f.options.controllerId, runnerId: randomUUID(), generation: 1, incarnationId: randomUUID() };
  const enrollmentId = randomUUID(), enrollment = s.runners.issue({ id: enrollmentId, ...binding, ttlSeconds: 60 }) as { enrollmentToken: string };
  s.runners.consume(enrollment.enrollmentToken, { id: enrollmentId, ...binding, credential: runnerToken });
  const digest = "sha256:" + "ab".repeat(32), image = { id: "session-linux", revision: "1", arch: "amd64", os: "linux", mode: "headless", backend: "kubevirt", digest, resources: { cpu: 1, memoryMiB: 1024, diskGiB: 5 }, capabilities: ["pty", "files"] };
  s.leases.image(image); f.store.transaction(db => s.leases.domains.define(db, { id: domain, name: "fixture", capacity: { cpu: 10, memoryMiB: 32000, diskGiB: 100 } }, f.store.clock()));
  s.leases.approve({ binding, domainId: domain, backend: "kubevirt", images: [{ id: image.id, revision: "1", arch: "amd64", digest }] });
  s.leases.grant({ applicationId: f.app.id, imageId: image.id, revision: "1", arch: "amd64", digest });
  const leaseId = randomUUID();
  const lease = s.leases.acquire(f.app.credential, { id: leaseId, templateId: image.id, templateRevision: "1", arch: "amd64", requiredCapabilities: ["pty"], ttlSeconds: 120 }).lease as { members: { machineId: string }[] };
  const token = (s.leases.credential(f.app.credential, leaseId, {}) as { credential: string }).credential;
  const request = f.request(); assert.throws(() => s.create(leaseId, token, request), status(409));
  const claim = s.leases.claim(runnerToken, { binding, claimId: randomUUID() }) as { assignment: { id: string } };
  const receipt = { leaseId, memberId: lease.members[0]!.machineId, backend: "kubevirt", imageDigest: digest, observedRevision: 1, runtimeState: "running", ready: { command: false, pty: true, files: true }, failure: null, executionStopped: false, storageRemoved: false, credentialsErased: false, cleanup: "pending" };
  s.leases.report(runnerToken, { binding, assignmentId: claim.assignment.id, sequence: 1, receipt });
  const session = s.create(leaseId, token, request).session;
  assert.throws(() => s.create(leaseId, f.token, f.request()));
  assert.throws(() => s.create(f.lease, token, f.request()));
  assert.throws(() => s.create(leaseId, token, f.request("display")), status(409));
  s.sessionCommand({ type: "sessions.attach", sessionId: session.id, generation: session.generation, side: "consumer", ownerId: leaseId, token });
  assert.throws(() => s.sessionCommand({ type: "sessions.attach", sessionId: session.id, generation: session.generation, side: "host", ownerId: binding.runnerId, token: runnerToken }), status(401));
  const ready = s.sessionCommand({ type: "sessions.attach", sessionId: session.id, generation: session.generation, side: "host", ownerId: binding.runnerId, token: runnerToken, binding }) as SessionView;
  assert.equal(ready.state, "ready");
  s.leases.report(runnerToken, { binding, assignmentId: claim.assignment.id, sequence: 2, receipt: { ...receipt, ready: { ...receipt.ready, pty: false } } });
  assert.deepEqual(s.sessionCommand({ type: "sessions.authorized", sessionId: session.id, generation: session.generation, ready: true }), { authorized: false });
});

test("slow readers backpressure bounded uploads while controller work and close stay responsive", async t => {
  const f = fixture(); t.after(f.cleanup);
  const broker = createSessionUpgradeHandler({ request: async command => f.sessions.sessionCommand(command) });
  const server = createServer(); server.on("upgrade", (req, socket, head) => { void broker.handle(req, socket, head); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { broker.close(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); assert.ok(address && typeof address === "object"); const origin = `http://127.0.0.1:${address.port}`;
  const s = f.create("upload"), consumer = await SessionConnection.connect(origin, `/v1/leases/${f.lease}/sessions/${s.id}/${s.generation}`, f.token), host = await SessionConnection.connect(origin, `/v1/hosts/${f.host}/sessions/${s.id}/${s.generation}`, f.hostToken);
  t.after(() => { consumer.close(); host.close(); });
  await consumer.receive(); await host.receive();
  let complete = false, sent = 0;
  const work = (async () => { try { const block = Buffer.alloc(65536); for (; sent < 512; sent++) await consumer.sendBytes(block); complete = true; } catch { /* close interrupts a bounded pending write */ } })();
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(complete, false); assert.ok(sent < 512);
  assert.equal(f.sessions.inspect(f.lease, s.id, f.token).state, "ready");
  f.sessions.inspect(f.lease, s.id, f.token, true);
  await Promise.race([work, new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("blocked sender was not interrupted")), 2000).unref())]);
  assert.equal(f.sessions.inspect(f.lease, s.id, f.token).state, "closed");
});

test("GuestHelperAccess requires macOS binding and preserves native inspection and shell ownership", async t => {
  const { GuestHelperAccess, GuestHelperBinding } = await import("../../src/control/sessions.ts");
  const calls: string[] = [], id = randomUUID(); let allowed = true;
  const native = { snapshotId: randomUUID(), capturedAt: 1, source: "macos-accessibility", coordinateSpace: "screen-points", nodes: [], truncated: false, coverage: "fixture" };
  const binding = new GuestHelperBinding(async (path, body) => { calls.push(path); return path === "/v1/accessibility" ? native : path === "/v1/shell/open" ? { session: body!.session } : { written: Buffer.byteLength(body!.text as string) }; }, () => allowed);
  const helper = new GuestHelperAccess(() => binding), machine = { id }, image = { os: "macos" };
  assert.deepEqual(await helper.inspect(machine, image, "/fixture"), native);
  assert.deepEqual(await helper.control(machine, image, "/fixture", { action: "shell-open", arguments: { session: id } }), { session: id });
  assert.deepEqual(await helper.control(machine, image, "/fixture", { action: "shell-write", arguments: { session: id, text: "é" } }), { written: 2 });
  const before = calls.length;
  await assert.rejects(helper.control(machine, image, "/fixture", { action: "tap", arguments: { x: 1, y: 2 } }), status(409));
  await assert.rejects(helper.inspect(machine, { os: "linux" }, "/fixture"), status(409));
  await assert.rejects(helper.streamDownload(machine, image, "/fixture", "/tmp/file", "simulator-app"), status(400));
  assert.equal(calls.length, before); allowed = false;
  await assert.rejects(helper.inspect(machine, image, "/fixture"), status(410)); assert.equal(calls.length, before);
});

test("invalid upgrades leave claims pending; fragmented frames preserve bytes and unmasked frames close", async t => {
  const f = fixture(); t.after(f.cleanup);
  const broker = createSessionUpgradeHandler({ request: async command => f.sessions.sessionCommand(command) });
  const server = createServer(); server.on("upgrade", (req, socket, head) => { void broker.handle(req, socket, head); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { broker.close(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); assert.ok(address && typeof address === "object");
  const port = address.port;
  const s = f.create(), path = `/v1/leases/${f.lease}/sessions/${s.id}/${s.generation}`;
  function request(target: string, token: string, extra = ""): string {
    return `GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAuthorization: Bearer ${token}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Protocol: canaveral-session-v1\r\n${extra}\r\n`;
  }
  for (const [target, extra] of [[path, "Origin: https://untrusted.example\r\n"], [path + "?credential=forbidden", ""], [path, "Authorization: Bearer duplicate\r\n"], [path, "Sec-WebSocket-Extensions: permessage-deflate\r\n"], [path, "Content-Length: 5\r\n"]]) {
    const response = await new Promise<string>((resolve, reject) => {
      const socket = netConnect(address.port, "127.0.0.1"); socket.setTimeout(2000, () => socket.destroy(new Error("timeout")));
      socket.once("error", reject); socket.once("data", data => { resolve(data.toString()); socket.destroy(); }); socket.once("connect", () => socket.write(request(target!, f.token, extra)));
    });
    assert.ok(/^HTTP\/1.1 (400|403)/.test(response)); assert.equal(f.sessions.inspect(f.lease, s.id, f.token).state, "pending");
  }
  const consumer = await SessionConnection.connect(`http://127.0.0.1:${address.port}`, path, f.token); t.after(() => consumer.close());
  const raw = netConnect(address.port, "127.0.0.1"); raw.on("error", () => {}); t.after(() => raw.destroy());
  const accepted = new Promise<void>((resolve, reject) => { raw.once("data", data => { if (!data.toString().startsWith("HTTP/1.1 101")) reject(new Error("upgrade failed")); else resolve(); }); raw.once("error", reject); });
  raw.write(request(`/v1/hosts/${f.host}/sessions/${s.id}/${s.generation}`, f.hostToken)); await accepted; await consumer.receive();
  function masked(opcode: number, final: boolean, bytes: number[]): Buffer { const mask = [1, 2, 3, 4]; return Buffer.from([(final ? 128 : 0) | opcode, 128 | bytes.length, ...mask, ...bytes.map((n, i) => n ^ mask[i % 4]!)]); }
  raw.write(Buffer.concat([masked(2, false, [0xc3]), masked(0, true, [0xa9])]));
  assert.equal(Buffer.from(await consumer.receive() as Uint8Array).toString(), "é");
  raw.write(Buffer.from([0x81, 0x01, 0x7b])); await assert.rejects(consumer.receive());
  assert.equal(f.sessions.inspect(f.lease, s.id, f.token).state, "disconnected");
});
