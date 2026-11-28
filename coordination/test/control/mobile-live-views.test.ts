import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tokenHash } from "../../src/accounts.ts";
import { MachineStore } from "../../src/control/machines.ts";
import { MobileVideoSessions } from "../../src/control/mobile-video-sessions.ts";
import { LIVE_VIEWS_PER_CREDENTIAL, LIVE_VIEWS_PER_MACHINE, MobileLiveViews } from "../../src/control/live-views.ts";
import type { ControlRequest, Principal } from "../../src/control/contracts.ts";
import { object, ServiceError } from "../../src/errors.ts";
import { SqliteStore } from "../../src/sqlite.ts";

/** The controller's live-view module against real SQLite with an injected clock: the lifetimes,
 * windows and limits that the end-to-end fixtures cannot wait for. No host, broker or device. */
type View = { id: string; generation: string; state: string; endReason?: string; captureId: string; machineId: string; authorizationDeadline: string; ttlSeconds: number };
const key = () => randomBytes(32).toString("base64url");
const refused = (status: number, code?: string) => (error: unknown) => error instanceof ServiceError && error.status === status && (code === undefined || error.code === code);
const phone = { id: "phone", revision: "1", os: "android", arch: "arm64", mode: "device", minimum: { cpu: 1, memoryMiB: 1024, diskGiB: 4 }, device: { systemImage: "system-images;android-35;google_apis;arm64-v8a", profile: "pixel_8" } };

function fixture(t: TestContext, devices = 1) {
  const directory = mkdtempSync(join(tmpdir(), "live-views-")); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, "state.sqlite"), options = { adminToken: key(), enrollmentToken: key(), controllerId: randomUUID() };
  let now = 1_000_000;
  const account = (role: "user" | "admin" = "user"): Principal => ({ kind: "session", user: { id: randomUUID(), username: role, role, status: "active" }, scopes: ["machines:read", "machines:write", "machines:access", ...(role === "admin" ? ["admin"] : [])] });
  const credentials = new Map<string, Principal>(), ownerToken = key(), secondToken = key(), adminToken = key(), owner = account();
  credentials.set(tokenHash(ownerToken), owner); credentials.set(tokenHash(secondToken), owner); credentials.set(tokenHash(adminToken), account("admin"));
  const principalHash = (_db: unknown, hash: string) => { const p = credentials.get(hash); if (!p) throw new ServiceError("Credential revoked.", 401); return p; };
  let store = new SqliteStore(file, () => now), machines = new MachineStore(store, options), video = new MobileVideoSessions(store, machines, principalHash), views = new MobileLiveViews(store, machines, principalHash, video);
  const host = randomUUID(), hostToken = key(), offer = { name: "live-fixture", provider: "android", capacity: { cpu: 32, memoryMiB: 65536, diskGiB: 256 }, templates: [phone] };
  machines.enroll({ id: host, credential: hostToken, offer }, options.enrollmentToken);
  const req = (method: string, path: string, body: Record<string, unknown> = {}, token = ownerToken): ControlRequest => ({ method, path, parts: path.split("/").filter(Boolean), body, token, query: new URLSearchParams(),
    principal: () => token === options.adminToken ? { kind: "operator", user: null, scopes: ["admin"] } : principalHash(undefined, tokenHash(token)) });
  const ids = Array.from({ length: devices }, () => String(machines.create({ id: randomUUID(), name: "phone", templateId: phone.id, resources: {} }, req("POST", "/v1/machines")).id));
  const states = new Map(ids.map(id => [id, "running"]));
  const heartbeat = (captureJournalsReady?: boolean) => object(machines.heartbeat(host, hostToken, {
    offer, reports: Object.fromEntries([...states].map(([id, state]) => [id, { state }])),
    ...(captureJournalsReady === undefined ? {} : { health: { status: "passed", checkedAt: now, capabilities: { captureJournalsReady } } }),
  }));
  heartbeat();
  const call = (method: string, path: string, body: Record<string, unknown> = {}, token = ownerToken) => { const response = views.handle(req(method, path, body, token)); assert.ok(response); return object(response.body) as unknown as View; };
  const base = (machine = ids[0]!) => `/v1/machines/${machine}/live-views`;
  return { ids, host, hostToken, ownerToken, secondToken, adminToken, operator: options.adminToken, heartbeat, call, req, base,
    report: (machine: string, state: string) => { states.set(machine, state); heartbeat(); },
    clearOwner: (machine: string) => store.transaction(db => db.prepare("UPDATE machines SET owner=NULL WHERE id=?").run(machine)),
    get machines() { return machines; }, get video() { return video; },
    create: (body: Record<string, unknown> = {}, token = ownerToken, machine = ids[0]!) => call("POST", base(machine), { id: randomUUID(), ...body }, token),
    read: (view: View, token = ownerToken) => call("GET", `${base(view.machineId)}/${view.id}`, {}, token),
    close: (view: View, token = ownerToken) => call("POST", `${base(view.machineId)}/${view.id}/close`, {}, token),
    attach: (view: View, side: "host" | "consumer", token = ownerToken) => views.command({ type: "live-views.attach", sessionId: view.id, generation: view.generation, side,
      ownerId: side === "host" ? host : view.machineId, token: side === "host" ? hostToken : token }) as View,
    authorized: (view: View) => (views.command({ type: "live-views.authorized", sessionId: view.id, generation: view.generation, ready: true }) as { authorized: boolean }).authorized,
    renew: (view: View) => views.command({ type: "live-views.renew", sessionId: view.id, generation: view.generation }) as { renewed: boolean; authorizationDeadline: string },
    disconnect: (view: View) => views.command({ type: "live-views.disconnect", sessionId: view.id, generation: view.generation }),
    capture: (view: View, token = ownerToken) => object(video.handle(req("GET", `/v1/machines/${view.machineId}/video-sessions/${view.captureId}`, {}, token))!.body),
    reserved: () => { const hosts = machines.hosts({ principal: () => ({ kind: "operator", user: null, scopes: ["admin"] }) }) as { reserved: { cpu: number; memoryMiB: number } }[]; return hosts[0]!.reserved; },
    desired: (machine: string, state: string) => machines.handle(req("POST", `/v1/machines/${machine}/desired`, { state })),
    // Time passes with the host still reporting in, so only the lifetime under test lapses.
    advance: (seconds: number) => { for (let left = seconds; left > 0;) { const step = Math.min(10, left); now += step; left -= step; heartbeat(); } }, now: () => now,
    restart: () => { store = new SqliteStore(file, () => now); machines = new MachineStore(store, options); video = new MobileVideoSessions(store, machines, principalHash); views = new MobileLiveViews(store, machines, principalHash, video); },
  };
}
const at = (iso: string) => Date.parse(iso) / 1000;

test("a view's lifetime runs from readiness, only a ready view renews, and an unrenewed view expires with its capture", t => {
  const f = fixture(t), before = f.reserved(), view = f.create({ ttlSeconds: 20 });
  assert.deepEqual([view.state, view.ttlSeconds], ["pending", 20]);
  // Until readiness the deadline is the attach window plus the lifetime.
  assert.equal(at(view.authorizationDeadline), f.now() + 50);
  assert.deepEqual(f.reserved(), { ...before, cpu: before.cpu + 1, memoryMiB: before.memoryMiB + 256 }, "the first view admits the capture's reservation");
  assert.deepEqual([f.capture(view).kind, f.capture(view).state, f.capture(view).cleaned], ["live", "pending", false]);
  assert.equal(f.renew(view).renewed, false, "an unattached view cannot be kept alive");
  f.advance(10); f.attach(view, "consumer"); assert.equal(f.attach(view, "host").state, "ready");
  assert.equal(at(f.read(view).authorizationDeadline), f.now() + 20, "the lifetime starts at readiness");
  assert.equal(f.capture(view).state, "ready");
  f.advance(15); assert.equal(f.authorized(view), true);
  const renewal = f.renew(view);
  assert.deepEqual([renewal.renewed, at(renewal.authorizationDeadline)], [true, f.now() + 20]);
  f.advance(15); assert.equal(f.authorized(view), true, "the renewal carried the view past its first deadline");
  f.advance(6); assert.equal(f.authorized(view), false);
  assert.deepEqual([f.read(view).state, f.read(view).endReason], ["ended", "view_expired"]);
  assert.deepEqual(f.renew(view), { renewed: false, authorizationDeadline: f.read(view).authorizationDeadline }, "an ended view is never revived");
  // The capture ended with its last view, but its host had attached: the reservation waits for proof.
  assert.deepEqual([f.capture(view).state, f.capture(view).cleaned], ["disconnected", false]);
  assert.equal(f.reserved().cpu, before.cpu + 1);
  const generation = String(f.capture(view).generation);
  assert.throws(() => f.video.handle(f.req("POST", `/v1/hosts/${f.host}/video-sessions/${view.captureId}/finish`, { generation, cleaned: true }, f.ownerToken)), "only the host reports cleanup");
  f.video.handle(f.req("POST", `/v1/hosts/${f.host}/video-sessions/${view.captureId}/finish`, { generation, cleaned: true }, f.hostToken));
  assert.deepEqual([f.capture(view).state, f.capture(view).cleaned], ["finished", true]);
  assert.deepEqual(f.reserved(), before);
});

test("account administrators and the operator cannot admit a live view of an operator-created machine", t => {
  const f = fixture(t), request = f.req("POST", "/v1/machines", {}, f.operator);
  const machine = String(f.machines.create({ id: randomUUID(), name: "unowned", templateId: phone.id, resources: {} }, request).id);
  f.report(machine, "running");
  for (const token of [f.adminToken, f.operator]) assert.throws(() => f.create({}, token, machine), refused(404));
  assert.equal(f.reserved().cpu, 2, "the unowned device holds no capture reservation");
});

test("a view that never attaches times out, and a capture whose host never attached frees its reservation at once", t => {
  const f = fixture(t), before = f.reserved(), view = f.create();
  f.attach(view, "consumer");
  f.advance(29); assert.equal(f.read(view).state, "attaching");
  f.advance(2);
  assert.deepEqual([f.read(view).state, f.read(view).endReason], ["ended", "attach_timeout"]);
  assert.deepEqual([f.capture(view).state, f.capture(view).cleaned], ["disconnected", true]);
  assert.deepEqual(f.reserved(), before);
  assert.throws(() => f.attach(view, "host"), refused(410));
});

test("an ended view stays readable for five minutes after it ended, however long it ran", t => {
  const f = fixture(t), view = f.create();
  f.attach(view, "consumer"); f.attach(view, "host");
  for (let i = 0; i < 6; i++) { f.advance(100); assert.equal(f.renew(view).renewed, true); f.heartbeat(); }
  assert.equal(f.close(view).endReason, "closed");
  f.advance(200); f.heartbeat();
  assert.equal(f.read(view).endReason, "closed", "a viewer of a long view can still learn why it ended");
  f.advance(101); f.heartbeat();
  assert.throws(() => f.read(view), refused(404));
});

test("a draining host takes no new view and no renewal, so its viewers leave within one lifetime", t => {
  const f = fixture(t, 2), view = f.create({ ttlSeconds: 30 });
  f.attach(view, "consumer"); f.attach(view, "host");
  assert.ok(f.machines.handle(f.req("POST", `/v1/hosts/${f.host}/maintenance`, { id: randomUUID() }, f.operator)));
  assert.throws(() => f.create({}, f.ownerToken, f.ids[1]), refused(409, "host_draining"));
  assert.throws(() => f.create(), refused(409, "host_draining"), "not even another viewer of a watched device");
  f.advance(10);
  assert.deepEqual(f.renew(view), { renewed: false, authorizationDeadline: f.read(view).authorizationDeadline });
  assert.equal(f.authorized(view), true, "the view keeps the lifetime it already had");
  f.advance(21); assert.equal(f.authorized(view), false);
  assert.equal(f.read(view).endReason, "view_expired");
});

test("a dropped socket is recorded as disconnected unless the view's own authority ended within three seconds", t => {
  const f = fixture(t, 4), ready = (machine: string) => { const view = f.create({}, f.ownerToken, machine); f.attach(view, "consumer"); f.attach(view, "host"); return view; };
  // The viewer simply left.
  const left = ready(f.ids[0]!); f.disconnect(left);
  f.advance(1); assert.equal(f.read(left).endReason, "disconnected");
  // The host dropped the view a moment before the controller saw the device stop.
  const stopped = ready(f.ids[1]!); f.disconnect(stopped);
  assert.equal(f.read(stopped).endReason, "disconnected");
  f.advance(2); f.desired(f.ids[1]!, "stopped");
  assert.equal(f.read(stopped).endReason, "device_stopped");
  // The same finding after the window is another event, not the cause.
  const late = ready(f.ids[2]!); f.disconnect(late);
  f.advance(4); f.desired(f.ids[2]!, "stopped");
  assert.equal(f.read(late).endReason, "disconnected");
  // The controller's own finding is recorded at once when it already holds at the drop.
  const direct = ready(f.ids[3]!); f.desired(f.ids[3]!, "stopped"); f.disconnect(direct);
  assert.equal(f.read(direct).endReason, "device_stopped");
  assert.equal(f.read(left).endReason, "disconnected", "an earlier ending is never rewritten later");
});

test("views are bounded per device and per credential, and a create-and-close loop cannot grow the table", t => {
  const f = fixture(t, 3);
  const open = (machine: string, token = f.ownerToken) => f.create({}, token, machine);
  for (let i = 0; i < LIVE_VIEWS_PER_MACHINE; i++) open(f.ids[0]!);
  assert.throws(() => open(f.ids[0]!), refused(429, "live_view_limit"));
  assert.throws(() => open(f.ids[0]!, f.adminToken), refused(429, "live_view_limit"), "the device's bound holds across credentials");
  for (let i = 0; i < LIVE_VIEWS_PER_MACHINE; i++) open(f.ids[1]!);
  assert.equal(LIVE_VIEWS_PER_CREDENTIAL, 2 * LIVE_VIEWS_PER_MACHINE);
  assert.throws(() => open(f.ids[2]!), refused(429, "live_view_limit"), "one credential holds at most eight views");
  // Another credential of the same owner, and an administrator, still have their own bound.
  const second = open(f.ids[2]!, f.secondToken), admin = open(f.ids[2]!, f.adminToken);
  assert.equal(second.captureId, admin.captureId);
  // Views are bearer-bound: the owner's other credential cannot read or close them.
  assert.throws(() => f.read(second, f.ownerToken), refused(404));
  assert.throws(() => f.close(admin, f.secondToken), refused(404));
  f.close(second, f.secondToken); f.close(admin, f.adminToken);
  // Sixty-four rows per device within the retention window.
  let made = 2;
  for (; made < 64; made++) f.close(f.create({}, f.secondToken, f.ids[2]!), f.secondToken);
  assert.throws(() => open(f.ids[2]!, f.secondToken), refused(429, "live_view_limit"));
  f.advance(301); f.heartbeat();
  assert.equal(open(f.ids[2]!, f.secondToken).state, "pending");
});

test("an unversioned runner gets exclusive admissions in pending, attached and ready phases", t => {
  const f = fixture(t), machine = f.ids[0]!, path = `/v1/machines/${machine}/video-sessions`;
  const before = f.reserved();
  const record = () => object(f.video.handle(f.req("POST", path, { id: randomUUID(), fps: 30, durationSeconds: 30, bitRate: 4_000_000 }))!.body);
  const recording = record();
  const attach = { type: "video-sessions.attach", sessionId: String(recording.id), generation: String(recording.generation) } as const;
  assert.throws(() => f.create(), refused(409, "device_recording_active"));
  f.heartbeat(false);
  assert.throws(() => f.create(), { code: "capture_journal_uncertain", retryable: false });
  f.heartbeat(true);
  f.video.command({ ...attach, side: "host", ownerId: f.host, token: f.hostToken });
  assert.throws(() => f.create(), refused(409, "device_recording_active"));
  f.video.command({ ...attach, side: "consumer", ownerId: machine, token: f.ownerToken });
  assert.throws(() => f.create(), refused(409, "device_recording_active"));
  f.video.handle(f.req("POST", `${path}/${recording.id}/close`, {}));
  assert.throws(() => f.create(), refused(409, "device_recording_active"));
  assert.deepEqual(f.reserved(), { ...before, cpu: before.cpu + 1, memoryMiB: before.memoryMiB + 256 });
  f.advance(91);
  f.video.handle(f.req("POST", `${path}/${recording.id}/abandon`, { reason: "Recorder stop remains unproven." }, f.adminToken));
  f.heartbeat();
  assert.throws(() => f.create(), refused(409, "device_recording_active"));
  assert.equal(f.reserved().cpu, before.cpu + 1);
  f.video.handle(f.req("POST", `/v1/hosts/${f.host}/video-sessions/${recording.id}/finish`, { generation: recording.generation, cleaned: true }, f.hostToken));
  const view = f.create(), capture = f.capture(view);
  assert.throws(() => record(), refused(409, "device_live_view_active"));
  f.attach(view, "host");
  assert.throws(() => record(), refused(409, "device_live_view_active"));
  f.attach(view, "consumer");
  assert.throws(() => record(), refused(409, "device_live_view_active"));
  // Live captures have no recording broker peers of their own.
  const identity = { sessionId: view.captureId, generation: String(capture.generation) };
  assert.throws(() => f.video.command({ type: "video-sessions.attach", ...identity, side: "host", ownerId: f.host, token: f.hostToken }), refused(409));
  assert.deepEqual(f.video.command({ type: "video-sessions.authorized", ...identity }), { authorized: false });
  f.video.handle(f.req("POST", `${path}/${view.captureId}/close`, {}));
  assert.deepEqual([f.read(view).state, f.read(view).endReason], ["ended", "capture_ended"]);
});

test("beside a live capture that ended without cleanup proof, both paths remain blocked through abandonment", t => {
  const f = fixture(t), machine = f.ids[0]!;
  const record = () => object(f.video.handle(f.req("POST", `/v1/machines/${machine}/video-sessions`, { id: randomUUID(), fps: 30, durationSeconds: 30, bitRate: 4_000_000 }))!.body) as { state: string };
  const told = (code: string, retryable: boolean) => (error: unknown) => error instanceof ServiceError && error.status === 409 && error.code === code && error.retryable === retryable;
  const view = f.create(); f.attach(view, "consumer"); f.attach(view, "host"); f.close(view);
  assert.deepEqual([f.capture(view).state, f.capture(view).cleaned], ["disconnected", false]);
  // The runner has a minute from the capture's end to report that it stopped: waiting may help.
  f.advance(50);
  assert.throws(() => f.create(), told("capture_cleanup_pending", true));
  assert.throws(() => record(), refused(409, "device_live_view_active"));
  // After that minute nothing a caller can wait for clears the device.
  f.advance(11);
  assert.throws(() => f.create(), told("capture_cleanup_unproven", false));
  assert.throws(() => record(), refused(409, "device_live_view_active"));
  // Abandonment claims no cleanup, so it changes neither answer.
  f.video.handle(f.req("POST", `/v1/machines/${machine}/video-sessions/${view.captureId}/abandon`, { reason: "The runner never reported this capture's stop." }, f.adminToken));
  assert.equal(object(f.capture(view).resolution).decision, "abandoned");
  assert.throws(() => f.create(), told("capture_cleanup_unproven", false));
  assert.throws(() => record(), refused(409, "device_live_view_active"));
  // Only positive proof does, however late it arrives.
  f.video.handle(f.req("POST", `/v1/hosts/${f.host}/video-sessions/${view.captureId}/finish`, { generation: String(f.capture(view).generation), cleaned: true }, f.hostToken));
  assert.equal(record().state, "pending");
});

test("a controller restart ends every view, and runners are told of views and held captures separately from recordings", t => {
  const f = fixture(t), view = f.create();
  f.attach(view, "consumer");
  const queued = f.heartbeat();
  assert.deepEqual((queued.liveViews as { id: string; captureId: string; state: string }[]).map(v => [v.id, v.captureId, v.state]), [[view.id, view.captureId, "attaching"]]);
  assert.deepEqual((queued.liveCaptures as { id: string }[]).map(c => c.id), [view.captureId]);
  assert.deepEqual(queued.videoSessions, [], "a runner that predates live views is never handed a live capture as a recording");
  f.attach(view, "host");
  f.restart();
  assert.deepEqual([f.read(view).state, f.read(view).endReason], ["ended", "controller_restarted"]);
  assert.deepEqual([f.capture(view).state, f.capture(view).cleaned], ["disconnected", false], "an attached capture still awaits its cleanup proof");
  assert.deepEqual(f.heartbeat().liveViews, []);
  assert.deepEqual((f.heartbeat().liveCaptures as { id: string }[]).map(c => c.id), [view.captureId]);
});

test("a ready administrator view loses stream authority when its machine has no owner", t => {
  const f = fixture(t), view = f.create({}, f.adminToken);
  f.attach(view, "consumer", f.adminToken); f.attach(view, "host");
  assert.equal(f.authorized(view), true);
  f.clearOwner(view.machineId);
  assert.equal(f.authorized(view), false);
  assert.equal(f.read(view, f.adminToken).endReason, "access_revoked");
});
