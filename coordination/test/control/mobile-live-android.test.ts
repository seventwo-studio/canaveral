import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LeaseClient } from "../../src/sdk.ts";
import { MachineLiveClient } from "../../src/video-sdk.ts";
import type { LiveStream } from "../../src/video-sdk.ts";
import { acquire, alive, arch, emulators, harness, skip, sleep, slowEmulatorStop, until } from "./android-fixture.ts";
import type { Harness, HarnessOptions } from "./android-fixture.ts";
import { collect, ordered, stoppedWithin } from "./live-fixture.ts";

/** Live captures through the real Android provider at the points where a capture's cleanup is
 * decided: a viewer that leaves while a run is being opened, and a device that stops while it is
 * watched. A real controller, broker, HostRunner and SDK; adb, the emulator and the encoder are
 * stand-ins, so the provider's own preflight, recorder identity, exact-recorder stop and stop
 * observation run as written, against processes that are not a device. Nothing here is native
 * acceptance: no emulator, screenrecord or FFmpeg runs. */
const LEASE = { cpu: 2, memoryMiB: 2048, diskGiB: 8 };
type Viewer = { id: string; stream: LiveStream; got: ReturnType<typeof collect> };
const media = (viewer: Viewer) => viewer.got.segments.filter(s => s.kind === "media");
const journal = (h: Harness, machine: string, capture: string) => JSON.parse(readFileSync(join(h.root, "runner", "work", "live", `${machine}.${capture}.json`), "utf8")) as { state: string; cleaned?: boolean; hostCleaned?: boolean; deviceStopped?: boolean };

test("a view closed during preflight, recorder spawn, streaming or rollover leaves the capture proven clean", { skip, timeout: 240000 }, async t => {
  // Three-second capture runs, so a rollover is reached quickly (natively a run lasts 180 seconds).
  const options: HarnessOptions = { extra: { cpu: 1, memoryMiB: 256 }, encoder: "fragments", liveEpochSeconds: 3 };
  const h = await harness(t, 1, options), app = await h.application();
  const a = await acquire(h, app, 300), name = `cvm-${a.machineId}`;
  const lease = new LeaseClient({ baseUrl: h.url, leaseId: a.id, leaseKey: a.key, allowLoopbackHttp: true });
  const watch = async (): Promise<Viewer> => { const id = randomUUID(), stream = await lease.live.watch({ id, member: "primary" }, { timeoutMs: 20000 }); return { id, stream, got: collect(stream) }; };
  const recorders = () => h.media.started.get(name) ?? [];
  const provider = h.provider(), openVideo = provider.openVideo.bind(provider);
  let preflight: (() => Promise<void>) | undefined;
  let skipPreflight = false;
  let authorized: Parameters<typeof openVideo>[4];
  t.mock.method(provider, "openVideo", (...[machine, image, folder, video, check, cleanupCheck]: Parameters<typeof openVideo>) => {
    authorized = check;
    const pause = skipPreflight ? undefined : preflight;
    if (!skipPreflight) preflight = undefined;
    skipPreflight = false;
    let firstCheck = true;
    return openVideo(machine, image, folder, video, async () => {
      if (firstCheck) { firstCheck = false; await pause?.(); }
      return check();
    }, cleanupCheck);
  });
  const leave = async (viewer: Viewer, label: string, resume?: () => void): Promise<void> => {
    const capture = viewer.stream.view.captureId, segments = media(viewer).length, left = Date.now();
    viewer.stream.close(); await viewer.got.done;
    if (resume) {
      try { await until(async () => !await authorized(), "the runner to observe the viewer's departure"); }
      finally { resume(); }
    }
    // Positive cleanup, reported by the runner itself: nothing was left for an administrator.
    await until(async () => (await lease.video.inspect(capture)).cleaned === true, `positive cleanup of a capture left ${label}`, 20000);
    t.diagnostic(`left ${label}: ${segments} segment(s) received, clean ${Date.now() - left} ms later, ${recorders().length} recorder(s) started so far`);
    assert.deepEqual([journal(h, a.machineId, capture).state, journal(h, a.machineId, capture).cleaned], ["finished", true], label);
    assert.equal(recorders().some(recorder => recorder.running), false, `no recorder runs after a capture left ${label}`);
    assert.equal(h.media.encodersOpen, 0);
    assert.deepEqual(await h.reserved(), LEASE, `the capture's reservation is released after it was left ${label}`);
    assert.ok(!viewer.got.segments.length || ordered(viewer.got.segments));
  };
  // Hold the provider at its first authorization check or just after the fixture recorder spawns.
  for (const stage of ["preflight", "spawn", "rollover"] as const) {
    const gate = Promise.withResolvers<void>();
    let reached = false;
    const pause = async () => { reached = true; await gate.promise; };
    const before = recorders().length, expectedStarts = before + (stage === "preflight" ? 0 : 1);
    skipPreflight = stage === "rollover";
    if (stage === "spawn") options.afterRecorderSpawn = pause;
    else preflight = pause;
    try {
      const viewer = await watch();
      await until(() => reached, `${stage} fixture gate`);
      assert.equal(recorders().length, expectedStarts);
      assert.equal(recorders().slice(before).some(recorder => recorder.running), stage === "spawn");
      if (stage !== "rollover") assert.equal(media(viewer).length, 0);
      else assert.ok(media(viewer).length > 0, "the first epoch streamed before rollover");
      await leave(viewer, stage, gate.resolve);
      assert.equal(recorders().length, expectedStarts);
    } finally {
      gate.resolve();
      delete options.afterRecorderSpawn;
    }
  }
  for (const received of [1, 2]) {
    const viewer = await watch();
    await until(() => media(viewer).length >= received, `${received} segment(s)`);
    await leave(viewer, `after receiving ${received} segment(s)`);
  }
  // A later view still opens and cleans up normally.
  const again = await watch();
  await until(() => media(again).length >= 3, "segments of a later view");
  await leave(again, "while it was streaming");
});

test("the live capture of an owned Android device that its runner cannot prove stopped settles only when the provider reports the emulator process gone", { skip, timeout: 240000 }, async t => {
  const options: HarnessOptions = { extra: { cpu: 1, memoryMiB: 256 }, encoder: "fragments" };
  const h = await harness(t, 1, options), machine = randomUUID();
  const account = await h.api("POST", "/v1/auth/setup", { username: "admin", password: "correct-horse-battery-staple-fixture" });
  assert.equal(account.status, 200);
  const owner = account.body.token as string;
  // An account-owned device, booted by the runner itself as in production.
  await until(async () => (await h.api("POST", "/v1/machines", { id: machine, name: "watched", templateId: h.image.id, templateRevision: "1", arch }, owner)).status === 200, "placement of an account-owned device");
  const observed = async () => (await h.api("GET", `/v1/machines/${machine}`)).body.observed as string;
  await until(async () => await observed() === "running", "a booted account-owned device", 40000);
  const base = await h.reserved() as { cpu: number; memoryMiB: number };
  const live = new MachineLiveClient({ baseUrl: h.url, credential: owner, allowLoopbackHttp: true });
  const watch = async (): Promise<Viewer> => { const id = randomUUID(), stream = await live.watch(machine, { id }, { timeoutMs: 20000 }); return { id, stream, got: collect(stream) }; };
  const viewer = await watch();
  await until(() => media(viewer).length >= 3, "live segments of an owned device");
  const capture = viewer.stream.view.captureId, emulator = emulators(h.registry)[0]!, recorder = h.media.recorders.get(emulator.name)!;
  const session = async () => (await h.api("GET", `/v1/machines/${machine}/video-sessions/${capture}`)).body as { state: string; cleaned: boolean; hostCleaned: boolean };
  assert.deepEqual([(await h.reserved()).cpu, (await h.reserved()).memoryMiB], [base.cpu + 1, base.memoryMiB + 256]);
  assert.equal(recorder.running, true);
  // The device is stopped while it is watched. Its guest no longer answers the recorder probe, so
  // the runner cannot prove the recorder stopped, and the emulator takes two seconds to exit.
  options.recorderProbe = "uncertain"; slowEmulatorStop(h, 2000);
  assert.equal((await h.api("POST", `/v1/machines/${machine}/desired`, { state: "stopped" })).status, 200);
  const asked = Date.now();
  await viewer.got.done;
  assert.deepEqual(viewer.stream.ended, { reason: "device_stopped", source: "controller" });
  stoppedWithin(t, viewer.got, asked, "device stop");
  // While the provider still reports the emulator process, the capture is not released: the
  // recorder ran inside that process. The session is read before the device, and the device's
  // stop is final, so a device not yet stopped means the session was read before the stop.
  let stopping = 0;
  for (;;) {
    const before = await session(), state = await observed();
    if (state === "stopped") break;
    assert.equal(before.cleaned, false, `the capture was released while the device was ${state}`);
    if (state === "stopping" && alive(emulator.pid)) stopping++;
    assert.ok(Date.now() - asked < 30000, "the device stopped in time");
    await sleep(50);
  }
  assert.ok(stopping > 0, "the device was observed stopping, with its emulator process alive, while the capture was held");
  assert.equal(alive(emulator.pid), false, "the provider reported the device stopped only after its process had exited");
  // The runner reported only its own encoder's exit; the device's observed stop completes the proof.
  await until(async () => (await session()).cleaned === true, "cleanup settled by the device's observed stop");
  assert.equal((await session()).hostCleaned, true);
  await until(() => journal(h, machine, capture).deviceStopped === true, "the runner to retain the proven emulator stop");
  assert.deepEqual([journal(h, machine, capture).state, journal(h, machine, capture).cleaned, journal(h, machine, capture).hostCleaned], ["unknown", false, true]);
  await until(() => recorder.running === false, "the recorder to end with its emulator");
  assert.equal(h.media.encodersOpen, 0);
  await until(async () => { const reserved = await h.reserved(); return reserved.cpu === base.cpu - 2 && reserved.memoryMiB === base.memoryMiB - 2048; }, "neither the stopped device nor its capture reserved");
  // Started again, the device is watched again, and that capture's stop is proven by the runner.
  delete options.recorderProbe; slowEmulatorStop(h, 0);
  assert.equal((await h.api("POST", `/v1/machines/${machine}/desired`, { state: "running" })).status, 200);
  await until(async () => await observed() === "running", "the restarted device", 40000);
  const again = await watch();
  await until(() => media(again).length >= 3, "segments after the restart");
  const next = again.stream.view.captureId;
  assert.notEqual(next, capture);
  again.stream.close(); await again.got.done;
  await until(async () => (await h.api("GET", `/v1/machines/${machine}/video-sessions/${next}`)).body.cleaned === true, "the runner's own recorder proof");
  assert.deepEqual([journal(h, machine, next).state, journal(h, machine, next).cleaned], ["finished", true]);
});
