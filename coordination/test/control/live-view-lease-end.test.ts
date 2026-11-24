import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MachineStore, machineDigest } from "../../src/control/machines.ts";
import { MobileVideoSessions } from "../../src/control/mobile-video-sessions.ts";
import { MobileLiveViews } from "../../src/control/live-views.ts";
import { initializeLeases } from "../../src/control/leases.ts";
import type { ControlRequest, Principal } from "../../src/control/contracts.ts";
import { object, secret, ServiceError } from "../../src/errors.ts";
import { SqliteStore } from "../../src/sqlite.ts";
import { LIVE_BIT_RATE, LIVE_EPOCH_SECONDS, LIVE_FPS } from "../../src/mobile-live.ts";

/** A leased live view at the controller, with real SQLite and an injected clock, so the order in
 * which the host's and the controller's findings arrive is set by the test, not by scheduling.
 * The host enforces a lease deadline natively, a moment before the controller's clock reaches it:
 * it stops the capture and reports its encoder gone while the controller still holds the lease
 * valid. The lease, its member and its application are rows here; the lease module itself, its
 * routes and its cleanup are covered by the lease fixtures. */
const key = () => randomBytes(32).toString("base64url");
const arch = "arm64";
const phone = { id: "phone", revision: "1", os: "android", arch, mode: "device", minimum: { cpu: 1, memoryMiB: 1024, diskGiB: 4 }, device: { systemImage: "system-images;android-35;google_apis;arm64-v8a", profile: "pixel_8" } };

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "live-view-lease-")); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const options = { adminToken: key(), enrollmentToken: key(), controllerId: randomUUID() };
  let now = 1_000_000;
  const store = new SqliteStore(join(directory, "state.sqlite"), () => now), machines = new MachineStore(store, options);
  const principalHash = (_db: unknown, _hash: string): Principal => { throw new ServiceError("Credential revoked.", 401); };
  const video = new MobileVideoSessions(store, machines, principalHash), views = new MobileLiveViews(store, machines, principalHash, video);
  const host = randomUUID(), hostToken = key();
  const offer = { name: "lease-live-fixture", provider: "android", capacity: { cpu: 32, memoryMiB: 65536, diskGiB: 256 }, templates: [phone], leaseProtocol: 1, leaseImages: [{ id: phone.id, revision: phone.revision, arch, runtime: "android" }] };
  machines.enroll({ id: host, credential: hostToken, offer }, options.enrollmentToken);
  const operator = (method: string, path: string, body: Record<string, unknown> = {}, token = options.adminToken): ControlRequest => ({ method, path, parts: path.split("/").filter(Boolean), body, token, query: new URLSearchParams(),
    principal: () => ({ kind: "operator", user: null, scopes: ["admin"] }) });
  const machine = String(machines.create({ id: randomUUID(), name: "phone", templateId: phone.id, resources: {} }, operator("POST", "/v1/machines")).id);
  const heartbeat = () => object(machines.heartbeat(host, hostToken, { offer, reports: { [machine]: { state: "running", accessReady: true } } }));
  heartbeat();
  // The lease and its live view, as the lease and live-view routes would have created them.
  const lease = randomUUID(), leaseKey = key(), credential = machineDigest(secret(leaseKey)), expires = now + 60;
  const view = randomUUID(), viewGeneration = randomUUID(), capture = randomUUID(), captureGeneration = randomUUID();
  store.transaction(db => {
    initializeLeases(db);
    db.exec("CREATE TABLE IF NOT EXISTS consumers (id TEXT PRIMARY KEY,specification TEXT NOT NULL,credential TEXT NOT NULL UNIQUE,revoked INTEGER NOT NULL DEFAULT 0,created REAL NOT NULL)");
    const consumer = randomUUID();
    db.prepare("INSERT INTO consumers VALUES (?,'{}',?,0,?)").run(consumer, randomUUID(), now);
    db.prepare("INSERT INTO leases (id,consumer,request,state,revision,created,expires,provision_deadline,credential,cleanup) VALUES (?,?,'{}','ready',1,?,?,?,?,'{}')").run(lease, consumer, now, expires, now, credential);
    db.prepare("INSERT INTO lease_members VALUES (?,'primary',?)").run(lease, machine);
    const m = db.prepare("SELECT * FROM machines WHERE id=?").get(machine)!;
    db.prepare(`INSERT INTO mobile_video_sessions (id,machine,host,binding,generation,credential,host_credential,request,state,created,deadline,host_attached,consumer_attached,cleaned,lease,member,host_cleaned,kind)
      VALUES (?,?,?,?,?,?,NULL,?,'pending',?,?,0,0,0,?,'primary',0,'live')`).run(capture, machine, host, machineDigest([m.id, m.host, m.owner, m.template, m.request]), captureGeneration, credential,
      JSON.stringify({ fps: LIVE_FPS, durationSeconds: LIVE_EPOCH_SECONDS, bitRate: LIVE_BIT_RATE }), now, now + 300, lease);
    db.prepare("INSERT INTO mobile_live_views VALUES (?,?,?,?,?,?,?,'primary','pending',NULL,?,?,0,0,120,NULL)").run(view, capture, machine, host, viewGeneration, credential, lease, now, now + 150);
  });
  const command = (value: Record<string, unknown>) => views.command({ sessionId: view, generation: viewGeneration, ...value } as Parameters<MobileLiveViews["command"]>[0]);
  command({ type: "live-views.attach", side: "consumer", ownerId: lease, token: leaseKey });
  command({ type: "live-views.attach", side: "host", ownerId: host, token: hostToken });
  return {
    expires,
    reason: () => store.transaction(db => ({ ...db.prepare("SELECT state,reason FROM mobile_live_views WHERE id=?").get(view) }) as { state: string; reason: string | null }),
    /** The broker's 250 ms check of the view. */
    authorized: () => (command({ type: "live-views.authorized", ready: true }) as { authorized: boolean }).authorized,
    /** The broker saw the host's socket drop. */
    disconnected: () => command({ type: "live-views.disconnect" }),
    /** The runner's receipt: its encoder exited; the fenced guest recorder's stop is the lease's to prove. */
    hostCleaned: () => video.handle(operator("POST", `/v1/hosts/${host}/video-sessions/${capture}/finish`, { generation: captureGeneration, hostCleaned: true }, hostToken)),
    /** The runner stopped the capture itself and proved it: positive cleanup. */
    cleaned: () => video.handle(operator("POST", `/v1/hosts/${host}/video-sessions/${capture}/finish`, { generation: captureGeneration, cleaned: true }, hostToken)),
    /** The lease's own state, as the lease module records a release or a failure. */
    lease: (state: string) => store.transaction(db => { db.prepare("UPDATE leases SET state=? WHERE id=?").run(state, lease); }),
    /** The controller's clock moves on while the host still reports in (each heartbeat refreshes the views). */
    advanceTo: (time: number) => { while (now < time) { now = Math.min(time, now + 1); heartbeat(); } },
    now: () => now,
  };
}

test("a leased view whose capture the host ended at its native deadline ends with the lease, not with its capture", t => {
  const f = fixture(t);
  assert.equal(f.authorized(), true);
  // The host fenced the lease a moment early: its capture is gone and its receipt arrives before
  // the broker noticed the dropped sockets.
  f.advanceTo(f.expires - 1);
  f.hostCleaned();
  assert.equal(f.authorized(), false);
  assert.deepEqual(f.reason(), { state: "ended", reason: "capture_ended" }, "the controller records what it sees first");
  f.disconnected();
  // The controller's own clock reaches the lease's end within the refinement window.
  f.advanceTo(f.expires + 1);
  assert.deepEqual(f.reason(), { state: "ended", reason: "lease_expired" });
});

test("a leased view's capture that ended long before its lease ends stays ended with its capture", t => {
  const f = fixture(t);
  f.advanceTo(f.expires - 10);
  f.hostCleaned();
  assert.equal(f.authorized(), false);
  f.advanceTo(f.expires + 1);
  assert.deepEqual(f.reason(), { state: "ended", reason: "capture_ended" });
});

test("a leased view's capture that the runner stopped with proof keeps its reason, though the lease expires within the window", t => {
  const f = fixture(t);
  f.advanceTo(f.expires - 1);
  // A positive receipt: the runner still held its authority and proved the recorder stopped. No fence did this.
  f.cleaned();
  assert.equal(f.authorized(), false);
  f.advanceTo(f.expires + 1);
  assert.deepEqual(f.reason(), { state: "ended", reason: "capture_ended" });
});

test("a release recorded after a leased view's capture ended does not replace the capture's own ending", t => {
  const f = fixture(t);
  f.advanceTo(f.expires - 20);
  f.hostCleaned();
  assert.equal(f.authorized(), false);
  // The holder releases the lease a second later: the controller records that before any runner acts on it, so it did not end this capture.
  f.advanceTo(f.expires - 19); f.lease("released"); f.advanceTo(f.expires - 18);
  assert.deepEqual(f.reason(), { state: "ended", reason: "capture_ended" });
});

test("a lease that fails just after its runner's host-only capture receipt replaces the capture's ending", t => {
  const f = fixture(t);
  f.advanceTo(f.expires - 20);
  // Supervisor loss: the runner lost the device and could confirm only its encoder's exit.
  f.hostCleaned();
  assert.equal(f.authorized(), false);
  f.advanceTo(f.expires - 19); f.lease("failed"); f.advanceTo(f.expires - 18);
  assert.deepEqual(f.reason(), { state: "ended", reason: "lease_failed" });
});
