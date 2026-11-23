import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { LeaseClient } from "../../src/sdk.ts";
import { LeaseLiveClient } from "../../src/video-sdk.ts";
import type { LiveStream } from "../../src/video-sdk.ts";
import { LIVE_BIT_RATE } from "../../src/mobile-live.ts";
import { acquire, alive, cleaned, harness, operate, skip, supervised, until } from "./android-fixture.ts";
import type { Harness } from "./android-fixture.ts";
import { collect, ordered, schemaValid } from "./live-fixture.ts";
import { consumerApiSchema } from "../../src/contracts.ts";

/** Live views of leased Android emulators, on the disposable lease harness: a real controller,
 * broker, HostRunner, native lease supervisor and SDK, with stand-in adb, emulator and encoder
 * processes. The encoder stand-in streams real fragmented MP4 boxes around opaque payloads, so
 * these prove authority, sharing, ordering, limits and reservation proof. They do not prove that
 * a real encoder's stream decodes, its frame rate or its latency: no device or FFmpeg runs. */
const LEASE = { cpu: 2, memoryMiB: 2048, diskGiB: 8 }, WITH_CAPTURE = { cpu: 3, memoryMiB: 2304, diskGiB: 8 };
const VIDEO = { fps: 30 as const, bitRate: 4_000_000 };
function client(h: Harness, lease: { id: string; key: string }): LeaseClient { return new LeaseClient({ baseUrl: h.url, leaseId: lease.id, leaseKey: lease.key, allowLoopbackHttp: true }); }
function sink(): { chunks: Buffer[]; write(bytes: Uint8Array): number } { const chunks: Buffer[] = []; return { chunks, write(bytes) { chunks.push(Buffer.from(bytes)); return bytes.length; } }; }
const media = (stream: ReturnType<typeof collect>) => stream.segments.filter(s => s.kind === "media");
async function watching(h: Harness, lease: { id: string; key: string }, request: { ttlSeconds?: number } = {}, options: Parameters<LeaseLiveClient["watch"]>[1] = {}): Promise<{ id: string; stream: LiveStream; got: ReturnType<typeof collect> }> {
  const id = randomUUID(), stream = await client(h, lease).live.watch({ id, member: "primary", ...request }, { timeoutMs: 20000, ...options });
  return { id, stream, got: collect(stream) };
}

test("a lease key watches its own emulator live: ordered segments, one shared capture that stops with the last viewer, and no other credential", { skip, timeout: 180000 }, async t => {
  const h = await harness(t, 2, { extra: { cpu: 1, memoryMiB: 256 }, encoder: "fragments" }), app = await h.application();
  const a = await acquire(h, app, 300), name = `cvm-${a.machineId}`, live = client(h, a).live;
  assert.deepEqual(await h.reserved(), LEASE);
  // The first view admits the device's live capture: one host slot and a recording's reservation.
  const first = await watching(h, a);
  await until(() => media(first.got).length >= 6, "live segments");
  assert.deepEqual(await h.reserved(), WITH_CAPTURE);
  const view = await live.inspect(first.id);
  assert.deepEqual([view.state, view.leaseId, view.member, view.capability, view.mediaType, view.codec, view.fps, view.bitRate], ["ready", a.id, "primary", "live", "video/mp4", "avc1", 30, LIVE_BIT_RATE]);
  assert.equal(first.got.segments[0]!.kind, "init"); assert.equal(media(first.got)[0]!.keyframe, true); assert.equal(media(first.got)[0]!.sequence, 0);
  // The response is the one the packaged OpenAPI document publishes.
  const api = consumerApiSchema() as Record<string, any>;
  assert.equal(schemaValid(api, api.components.schemas.LiveView, view), true, JSON.stringify(view));
  // A replayed intent returns the same view; a changed one conflicts.
  const replay = await h.api("POST", `/v1/leases/${a.id}/live-views`, { id: first.id, member: "primary" }, a.key);
  assert.equal(replay.status, 200); assert.equal(replay.body.generation, view.generation);
  assert.equal((await h.api("POST", `/v1/leases/${a.id}/live-views`, { id: first.id, member: "primary", ttlSeconds: 30 }, a.key)).status, 409);
  // A second viewer joins the same capture: no second recorder, encoder or reservation.
  const second = await watching(h, a);
  await until(() => media(second.got).length >= 6, "segments for the second viewer");
  assert.equal(h.media.started.get(name)!.length, 1); assert.equal(h.media.encoders, 1);
  assert.deepEqual(await h.reserved(), WITH_CAPTURE);
  assert.equal((await live.inspect(second.id)).captureId, view.captureId);
  // It starts on a key frame, and both viewers receive the very same segments.
  assert.equal(media(second.got)[0]!.keyframe, true);
  // (Under load one viewer's relay can trail the other's by a moment; wait for the same segments.)
  const shared = media(second.got).slice(0, 4);
  await until(() => shared.every(s => media(first.got).some(f => f.sequence === s.sequence)), "the same segments for the first viewer");
  for (const s of shared) assert.deepEqual(s.data, media(first.got).find(f => f.sequence === s.sequence)!.data);
  // The capture is an ordinary video session of the lease, visible to its key as such.
  const capture = await client(h, a).video.inspect(view.captureId);
  assert.deepEqual([capture.leaseId, capture.state, capture.cleaned], [a.id, "ready", false]);
  // The application key, the operator and another lease's key reach none of it.
  const b = await acquire(h, app, 300);
  for (const token of [app, h.admin, b.key]) {
    assert.equal((await h.api("POST", `/v1/leases/${a.id}/live-views`, { id: randomUUID(), member: "primary" }, token)).status, 401);
    assert.equal((await h.api("GET", `/v1/leases/${a.id}/live-views/${first.id}`, undefined, token)).status, 401);
    assert.equal((await h.api("POST", `/v1/leases/${a.id}/live-views/${first.id}/close`, {}, token)).status, 401);
    // Nor can they attach to the existing view's stream.
    await assert.rejects(new LeaseLiveClient({ baseUrl: h.url, leaseId: a.id, leaseKey: token, allowLoopbackHttp: true }).connect(view, { timeoutMs: 5000 }));
  }
  assert.equal((await h.api("GET", `/v1/leases/${b.id}/live-views/${first.id}`, undefined, b.key)).status, 404);
  // No operator or owner view of a leased device exists: the machine route refuses it.
  assert.equal((await h.api("POST", `/v1/machines/${a.machineId}/live-views`, { id: randomUUID() }, h.admin)).status, 409);
  assert.equal((await h.api("GET", `/v1/machines/${a.machineId}/live-views/${first.id}`, undefined, h.admin)).status, 404);
  assert.equal((await h.api("POST", `/v1/leases/${a.id}/live-views`, { id: randomUUID(), member: "other" }, a.key)).status, 404);
  // At most four viewers per device.
  const extra = [await watching(h, a), await watching(h, a)];
  const over = await h.api("POST", `/v1/leases/${a.id}/live-views`, { id: randomUUID(), member: "primary" }, a.key);
  assert.equal(over.status, 429); assert.equal(over.body.code, "live_view_limit");
  for (const viewer of extra) { viewer.stream.close(); await viewer.got.done; }
  // Input stays beside the stream, on the lease's durable operations: touch, keys and orientation,
  // one at a time under the device's assignment lock. The stream itself carries none.
  for (const [action, args] of [["tap", { x: 10, y: 20 }], ["swipe", { x: 10, y: 20, toX: 10, toY: 200, durationMs: 200 }], ["key", { key: "KEYCODE_HOME" }], ["rotate", { orientation: "LANDSCAPE_LEFT" }]] as const)
    assert.equal((await operate(h, a.id, a.key, action, args)).body.state, "succeeded", action);
  assert.ok([...h.counters.keys()].some(command => command.startsWith(`${name}:shell `) && /wm\W+user-rotation\W+lock\W+1/.test(command)), "the rotation reached the lease's own emulator");
  assert.equal((await h.api("POST", `/v1/leases/${a.id}/operations`, { id: randomUUID(), member: "primary", action: "rotate", arguments: { orientation: "PORTRAIT" } }, b.key)).status, 401);
  assert.equal(first.stream.ended, undefined); assert.equal(second.stream.ended, undefined);
  // One viewer leaving does not stop the capture for the other.
  first.stream.close(); await first.got.done;
  assert.deepEqual(first.stream.ended, { reason: "closed", source: "client" });
  assert.ok(ordered(first.got.segments));
  const before = media(second.got).length;
  await until(() => media(second.got).length >= before + 4, "segments after the first viewer left");
  assert.equal(h.media.recorders.get(name)!.running, true);
  // The last viewer leaving stops it: the exact guest recorder is stopped and proven, the encoder exits.
  second.stream.close(); await second.got.done;
  assert.ok(ordered(second.got.segments));
  await until(async () => (await client(h, a).video.inspect(view.captureId)).cleaned === true, "positive live capture cleanup");
  assert.equal(h.media.recorders.get(name)!.running, false); assert.equal(h.media.encodersOpen, 0);
  assert.deepEqual(await h.reserved(), { cpu: 4, memoryMiB: 4096, diskGiB: 16 });
  const closed = await live.inspect(second.id);
  assert.equal(closed.state, "ended"); assert.equal(schemaValid(api, api.components.schemas.LiveView, closed), true, JSON.stringify(closed));
  // A new view starts a new capture; nothing of the old one is repeated.
  const again = await watching(h, a);
  await until(() => media(again.got).length >= 2, "segments of a new capture");
  assert.notEqual((await live.inspect(again.id)).captureId, view.captureId);
  assert.equal(h.media.started.get(name)!.length, 2); assert.equal(h.media.peak, 1);
  again.stream.close(); await again.got.done;
  for (const lease of [a, b]) assert.equal((await h.api("POST", `/v1/leases/${lease.id}/release`, { id: randomUUID() }, lease.key)).status, 200);
  await cleaned(h, app, a.id); await cleaned(h, app, b.id);
  assert.deepEqual(await h.reserved(), { cpu: 0, memoryMiB: 0, diskGiB: 0 });
});

test("a view lives while its viewer renews it, expires when it does not, and closes on request", { skip, timeout: 120000 }, async t => {
  const h = await harness(t, 1, { extra: { cpu: 1, memoryMiB: 256 }, encoder: "fragments" }), app = await h.application();
  const a = await acquire(h, app, 300), live = client(h, a).live;
  for (const ttlSeconds of [9, 121, 10.5]) assert.equal((await h.api("POST", `/v1/leases/${a.id}/live-views`, { id: randomUUID(), member: "primary", ttlSeconds }, a.key)).status, 400);
  // Two ten-second views of one capture: one renews as it is consumed, the other never does.
  const kept = await watching(h, a, { ttlSeconds: 10 }), idle = await watching(h, a, { ttlSeconds: 10 }, { autoRenew: false });
  await until(() => media(kept.got).length >= 2 && media(idle.got).length >= 2, "segments for both viewers");
  const initial = Date.parse((await live.inspect(kept.id)).authorizationDeadline);
  await idle.got.done;
  assert.deepEqual(idle.stream.ended, { reason: "view_expired", source: "controller" });
  assert.deepEqual([(await live.inspect(idle.id)).state, (await live.inspect(idle.id)).endReason], ["ended", "view_expired"]);
  // The renewed view outlived its original deadline and still streams; renewal never touched the lease.
  assert.equal(kept.stream.ended, undefined);
  const renewed = await live.inspect(kept.id);
  assert.equal(renewed.state, "ready"); assert.ok(Date.parse(renewed.authorizationDeadline) > initial + 3000);
  assert.ok(Date.parse(kept.stream.authorizationDeadline) > initial);
  assert.ok(Date.now() > initial, "the original lifetime has passed");
  const expires = (await h.api("GET", `/v1/leases/${a.id}`, undefined, a.key)).body.expiresAt;
  const count = media(kept.got).length;
  await until(() => media(kept.got).length >= count + 3, "segments after the other view expired");
  assert.equal((await h.api("GET", `/v1/leases/${a.id}`, undefined, a.key)).body.expiresAt, expires);
  // The holder closes a view through its route; the viewer learns why from the controller.
  assert.equal((await live.close(kept.id)).endReason, "closed");
  await kept.got.done;
  assert.deepEqual(kept.stream.ended, { reason: "closed", source: "controller" });
  await until(async () => (await client(h, a).video.inspect(renewed.captureId)).cleaned === true, "capture cleanup after the last view closed");
  assert.deepEqual(await h.reserved(), LEASE);
});

test("a live view ends with its lease at expiry, and its capture is released only after the lease proves the emulator gone", { skip, timeout: 120000 }, async t => {
  const h = await harness(t, 1, { extra: { cpu: 1, memoryMiB: 256 }, encoder: "fragments" }), app = await h.application();
  const a = await acquire(h, app, 12), name = `cvm-${a.machineId}`, lease = client(h, a);
  const provider = h.provider(), stop = provider.stopForCleanup.bind(provider);
  let releaseProof!: () => void;
  const proof = new Promise<void>(resolve => { releaseProof = resolve; });
  t.mock.method(provider, "stopForCleanup", async (...args: Parameters<typeof stop>) => {
    await proof;
    return stop(...args);
  });
  try {
    const viewer = await watching(h, a);
    await until(() => media(viewer.got).length >= 3, "live segments");
    assert.deepEqual(await h.reserved(), WITH_CAPTURE);
    const view = await lease.live.inspect(viewer.id);
    // The lease expires while the view is watched: the stream ends, and says why.
    await viewer.got.done;
    assert.equal(viewer.got.failure(), undefined);
    assert.ok(["lease_expired", "lease_failed"].includes(viewer.stream.ended!.reason), JSON.stringify(viewer.stream.ended));
    t.diagnostic(`stream end at expiry: ${JSON.stringify(viewer.stream.ended)}`);
    assert.ok(ordered(viewer.got.segments));
    await until(async () => ["expired", "failed"].includes((await h.api("GET", `/v1/leases/${a.id}`, undefined, app)).body.state), "terminal lease");
    assert.ok(Date.now() - h.media.recorders.get(name)!.started < 30000, "the capture ended with the lease, not at its time limit");
    // The runner's encoder exited; the fenced guest's recorder is proven gone only by the lease's cleanup.
    await until(async () => (await lease.video.inspect(view.captureId)).hostCleaned === true, "host encoder cleanup", 30000);
    assert.equal(h.media.encodersOpen, 0);
    assert.equal((await lease.video.inspect(view.captureId)).cleaned, false);
    assert.deepEqual(await h.reserved(), WITH_CAPTURE);
    releaseProof();
    await cleaned(h, app, a.id);
    await until(async () => (await lease.video.inspect(view.captureId)).cleaned === true, "capture settled by lease cleanup");
    assert.deepEqual(await h.reserved(), { cpu: 0, memoryMiB: 0, diskGiB: 0 });
    // The ended lease reads its view but cannot watch again.
    await until(async () => (await lease.live.inspect(viewer.id)).state === "ended", "settled view");
    assert.equal((await h.api("POST", `/v1/leases/${a.id}/live-views`, { id: randomUUID(), member: "primary" }, a.key)).status, 410);
  } finally { releaseProof(); }
});

test("key rotation and release each end a live view; the runner's exact-recorder proof or the lease's cleanup releases its capture", { skip, timeout: 120000 }, async t => {
  const h = await harness(t, 1, { extra: { cpu: 1, memoryMiB: 256 }, encoder: "fragments" }), app = await h.application();
  const a = await acquire(h, app, 120), name = `cvm-${a.machineId}`;
  // Rotation: the old key's view ends while the lease and emulator stay live, so the runner
  // stops and proves the exact guest recorder itself.
  const first = await watching(h, a);
  await until(() => media(first.got).length >= 3, "live segments");
  const key = (await h.api("POST", `/v1/leases/${a.id}/credential`, {}, app)).body.credential as string, lease = client(h, { id: a.id, key });
  await first.got.done;
  // The rotated key can no longer read why; the current key can.
  assert.deepEqual(first.stream.ended, { reason: "credential_rejected", source: "controller" });
  const ended = await lease.live.inspect(first.id);
  assert.deepEqual([ended.state, ended.endReason], ["ended", "key_rotated"]);
  await until(async () => (await lease.video.inspect(ended.captureId)).cleaned === true, "runner recorder proof");
  assert.equal(h.media.recorders.get(name)!.running, false);
  assert.deepEqual(await h.reserved(), LEASE);
  assert.equal((await h.api("POST", `/v1/leases/${a.id}/live-views`, { id: randomUUID(), member: "primary" }, a.key)).status, 401);
  // Release: the lease ends, the view with it, and the reservation follows the cleanup proof.
  const second = await watching(h, { id: a.id, key });
  await until(() => media(second.got).length >= 3, "segments under the new key");
  const capture = (await lease.live.inspect(second.id)).captureId;
  assert.equal((await h.api("POST", `/v1/leases/${a.id}/release`, { id: randomUUID() }, key)).status, 200);
  await second.got.done;
  assert.deepEqual(second.stream.ended, { reason: "lease_released", source: "controller" });
  await cleaned(h, app, a.id);
  await until(async () => (await lease.video.inspect(capture)).cleaned === true, "capture released after proof");
  assert.deepEqual(await h.reserved(), { cpu: 0, memoryMiB: 0, diskGiB: 0 });
});

test("supervisor loss mid-view ends the stream, fails the lease and holds the capture's reservation until operator recovery", { skip, timeout: 120000 }, async t => {
  const h = await harness(t, 1, { extra: { cpu: 1, memoryMiB: 256 }, encoder: "fragments" }), app = await h.application();
  const a = await acquire(h, app, 120), group = supervised(h, a.machineId), lease = client(h, a);
  const viewer = await watching(h, a);
  await until(() => media(viewer.got).length >= 3, "live segments");
  const capture = (await lease.live.inspect(viewer.id)).captureId, killed = Date.now();
  process.kill(group.supervisorPid, "SIGKILL");
  // The capture's native check sees the free supervisor lock within about a second.
  await viewer.got.done;
  assert.ok(Date.now() - killed < 10000, "the stream ended promptly");
  assert.ok(["capture_failed", "lease_failed", "device_stopped", "host_unavailable", "disconnected"].includes(viewer.stream.ended!.reason), JSON.stringify(viewer.stream.ended));
  t.diagnostic(`stream end at supervisor loss after ${Date.now() - killed} ms: ${JSON.stringify(viewer.stream.ended)}`);
  await until(async () => (await h.api("GET", `/v1/leases/${a.id}`, undefined, app)).body.state === "failed", "failed lease", 15000);
  await until(async () => { const session = await lease.video.inspect(capture); return session.hostCleaned === true || session.cleaned === true; }, "capture teardown", 30000);
  await until(async () => (await h.api("GET", `/v1/leases/${a.id}`, undefined, app)).body.cleanup.state === "blocked", "blocked cleanup");
  // Unless the runner proved the exact recorder stopped, the capture and the emulator stay reserved.
  const held = await lease.video.inspect(capture);
  assert.deepEqual(await h.reserved(), held.cleaned ? LEASE : WITH_CAPTURE);
  assert.ok(alive(group.childPid));
  // Documented recovery: the operator stops the process group named in lease-supervisor.json.
  process.kill(-group.childPid, "SIGKILL");
  await cleaned(h, app, a.id);
  await until(async () => (await lease.video.inspect(capture)).cleaned === true, "capture settled");
  assert.deepEqual(await h.reserved(), { cpu: 0, memoryMiB: 0, diskGiB: 0 });
});

test("a wedged encoder keeps the live capture reserved, blocks another capture of the device and is released only by administrator abandonment", { skip, timeout: 180000 }, async t => {
  const h = await harness(t, 1, { extra: { cpu: 1, memoryMiB: 256 }, encoder: "fragments-stuck" }), app = await h.application();
  const a = await acquire(h, app, 300), lease = client(h, a);
  const viewer = await watching(h, a);
  await until(() => media(viewer.got).length >= 3, "live segments");
  const capture = (await lease.live.inspect(viewer.id)).captureId;
  viewer.stream.close(); await viewer.got.done;
  // The view is gone, but the encoder's exit is unconfirmed: no receipt, so nothing is released.
  await until(async () => (await lease.video.inspect(capture)).state === "disconnected", "ended capture");
  await new Promise(resolve => setTimeout(resolve, 8000));
  const held = await lease.video.inspect(capture);
  assert.deepEqual([held.cleaned, held.hostCleaned], [false, false]);
  assert.deepEqual(await h.reserved(), WITH_CAPTURE);
  // Neither a new view nor a recording may start on a device whose capture is unproven.
  const again = await h.api("POST", `/v1/leases/${a.id}/live-views`, { id: randomUUID(), member: "primary" }, a.key);
  assert.equal(again.status, 409); assert.equal(again.body.code, "capture_cleanup_pending");
  assert.equal((await h.api("POST", `/v1/leases/${a.id}/video-sessions`, { id: randomUUID(), member: "primary", durationSeconds: 2, ...VIDEO }, a.key)).status, 409);
  // Lease cleanup proves the emulator gone, but not this host's encoder: still held.
  assert.equal((await h.api("POST", `/v1/leases/${a.id}/release`, { id: randomUUID() }, a.key)).status, 200);
  await cleaned(h, app, a.id);
  await new Promise(resolve => setTimeout(resolve, 2000));
  assert.deepEqual(await h.reserved(), { cpu: 1, memoryMiB: 256, diskGiB: 0 });
  // Abandonment needs administrator authority and the capture's deadline, a minute after it ended.
  assert.equal((await h.api("POST", `/v1/machines/${a.machineId}/video-sessions/${capture}/abandon`, { reason: "encoder wedged" }, a.key)).status, 401);
  await until(async () => (await h.api("POST", `/v1/machines/${a.machineId}/video-sessions/${capture}/abandon`, { reason: "encoder wedged; host inspected" }, h.admin)).status === 200, "abandonment after the deadline", 90000);
  assert.deepEqual(await h.reserved(), { cpu: 0, memoryMiB: 0, diskGiB: 0 });
});

test("a recording takes the device's one native capture and feeds the live viewers: both are complete and no second recorder ever runs", { skip, timeout: 180000 }, async t => {
  let viewerSawRecording = false;
  const h = await harness(t, 1, {
    extra: { cpu: 2, memoryMiB: 512 }, encoder: "fragments",
    allowRecorderEof: run => run !== 2 || viewerSawRecording,
  }), app = await h.application();
  const a = await acquire(h, app, 300), name = `cvm-${a.machineId}`, lease = client(h, a);
  const inits = (got: ReturnType<typeof collect>) => got.segments.filter(s => s.kind === "init").map(s => s.epoch);
  // A viewer is watching its own live capture when a recording starts.
  const viewer = await watching(h, a);
  await until(() => media(viewer.got).length >= 4, "live segments");
  const out = sink(), recording = lease.video.record({ id: randomUUID(), member: "primary", durationSeconds: 3, ...VIDEO }, out, { timeoutMs: 30000 });
  const recordingSegments = () => media(viewer.got).filter(s => s.epoch === inits(viewer.got)[1]);
  try {
    // Hold the fake recorder's EOF until the viewer has actually consumed the tee.
    await Promise.race([
      until(() => recordingSegments().length >= 3, "the viewer's recording segments"),
      recording.then(() => assert.fail("the recording ended before the handover was observed")),
    ]);
    assert.equal(h.media.started.get(name)!.length, 2);
    assert.deepEqual(await h.reserved(), WITH_CAPTURE);
    assert.equal(h.media.started.get(name)!.filter(recorder => recorder.running).length, 1);
  } finally {
    viewerSawRecording = true;
  }
  const finish = await recording, recorded = Buffer.concat(out.chunks);
  // The recording is exactly what it would have been alone: verified bytes, digest and cleanup.
  assert.deepEqual(finish, { type: "finish", bytes: recorded.length, sha256: createHash("sha256").update(recorded).digest("hex"), cleaned: true });
  // The viewer stayed attached: its own capture, then the recording's stream, then its own again.
  await until(() => inits(viewer.got).length >= 3 && media(viewer.got).filter(s => s.epoch === inits(viewer.got)[2]).length >= 2, "the viewer's capture resumed");
  assert.equal(viewer.stream.ended, undefined); assert.ok(ordered(viewer.got.segments));
  const during = recordingSegments();
  assert.ok(during.length >= 3, "the viewer watched the recording's stream");
  for (const segment of during) assert.ok(recorded.includes(segment.data), "a viewer segment is a fragment of the recording");
  assert.equal(h.media.started.get(name)!.length, 3); assert.equal(h.media.peak, 1);
  await until(async () => (await h.reserved()).cpu === 3, "the live capture retained its reservation after recording");
  // The other order: a viewer joins a recording already in progress.
  viewer.stream.close(); await viewer.got.done;
  await until(async () => (await h.reserved()).cpu === 2, "the live capture's reservation released");
  const second = sink(), long = lease.video.record({ id: randomUUID(), member: "primary", durationSeconds: 20, ...VIDEO }, second, { timeoutMs: 45000 });
  await Promise.race([
    until(() => h.media.started.get(name)!.length === 4 && second.chunks.length > 0, "a recording in progress"),
    long.then(() => assert.fail("the recording ended before the viewer could join")),
  ]);
  const late = await watching(h, a);
  await until(() => media(late.got).length >= 3, "segments from the recording in progress");
  assert.equal(h.media.started.get(name)!.length, 4, "the viewer started no capture of its own");
  assert.equal(media(late.got)[0]!.keyframe, true);
  const done = await long, bytes = Buffer.concat(second.chunks);
  assert.equal(done.sha256, createHash("sha256").update(bytes).digest("hex"));
  for (const segment of media(late.got).filter(s => s.epoch === inits(late.got)[0])) assert.ok(bytes.includes(segment.data));
  // When the recording ends, the viewer's own capture takes over.
  await until(() => inits(late.got).length >= 2 && media(late.got).filter(s => s.epoch === inits(late.got)[1]).length >= 2, "the viewer's own capture");
  assert.ok(ordered(late.got.segments)); assert.equal(h.media.peak, 1);
  late.stream.close(); await late.got.done;
  await until(async () => (await h.reserved()).cpu === 2, "every capture released");
  assert.equal(h.media.encodersOpen, 0);
});

test("a long view continues across capture runs, and the live capture counts against the application's limits", { skip, timeout: 120000 }, async t => {
  // The native run is 180 seconds (Android screenrecord's limit); two seconds here.
  const h = await harness(t, 2, { extra: { cpu: 1, memoryMiB: 256 }, encoder: "fragments", liveEpochSeconds: 2 });
  const app = await h.application(), a = await acquire(h, app, 300), name = `cvm-${a.machineId}`;
  const viewer = await watching(h, a);
  const inits = () => viewer.got.segments.filter(s => s.kind === "init");
  await until(() => inits().length >= 3 && media(viewer.got).filter(s => s.epoch === inits()[2]!.epoch).length >= 2, "three capture runs", 30000);
  assert.equal(viewer.stream.ended, undefined); assert.ok(ordered(viewer.got.segments));
  // Each run opens with its own header and a key frame; runs never overlap on the device.
  for (const init of inits().slice(0, 3)) assert.deepEqual([media(viewer.got).find(s => s.epoch === init.epoch)!.sequence, media(viewer.got).find(s => s.epoch === init.epoch)!.keyframe], [0, true]);
  assert.ok(h.media.started.get(name)!.length >= 3); assert.equal(h.media.peak, 1);
  const capture = (await client(h, a).live.inspect(viewer.id)).captureId;
  viewer.stream.close(); await viewer.got.done;
  await until(async () => (await client(h, a).video.inspect(capture)).cleaned === true, "positive cleanup after several runs");
  assert.deepEqual(await h.reserved(), LEASE);
  // An application whose resources its lease already uses cannot add a live capture.
  const tight = await h.application({ cpu: 2, memoryMiB: 4096, diskGiB: 8 }), b = await acquire(h, tight, 300);
  assert.equal((await h.api("POST", `/v1/leases/${b.id}/live-views`, { id: randomUUID(), member: "primary" }, b.key)).status, 429);
  assert.deepEqual(await h.reserved(), { cpu: 4, memoryMiB: 4096, diskGiB: 16 });
});
