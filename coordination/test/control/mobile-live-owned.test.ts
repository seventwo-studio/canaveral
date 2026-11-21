import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startController } from "../../src/main.ts";
import { startDashboard } from "../../src/dashboard.ts";
import { HostRunner } from "../../src/host.ts";
import type { HostConfig } from "../../src/host.ts";
import { MobileProvider } from "../../src/providers/mobile.ts";
import type { Authorized, NativePipe, RecordValue } from "../../src/providers/mobile.ts";
import { MachineLiveClient, MobileVideoClient } from "../../src/video-sdk.ts";
import type { LiveStream } from "../../src/video-sdk.ts";
import { ConsumerServiceError } from "../../src/consumer-client.ts";
import { FragmentEncoder, collect, ordered } from "./live-fixture.ts";
import { liveSegmentValid } from "../../src/mobile-live.ts";

/** Live views of account-owned devices: a real controller, broker, dashboard gateway, HostRunner
 * and SDK around a device-free provider whose capture source and encoder are in-process
 * stand-ins. The runner reaches the controller only outbound, as a remote host does. These prove
 * ownership, sharing, limits, endings and reservation proof; no simulator, emulator, idb or
 * FFmpeg runs, so nothing here establishes native capture, frame rate or decoding. */
const key = () => randomBytes(32).toString("base64url");
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean | Promise<boolean>, label: string, ms = 20000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (await check()) return; await sleep(50); }
  assert.fail(`Timed out waiting for ${label}`);
}
interface Stats { captures: number; open: number; peak: number; encoders: number; encodersOpen: number }
interface Options {
  os?: "android" | "ios";
  /** Host configuration beyond the defaults, for example the iOS live view opt-in. */
  config?: RecordValue;
  /** The native source cannot be proven stopped after an early end. */
  stop?: "unprovable";
}
interface Fixture {
  url: string; admin: string; hostId: string; stats: Stats; runner: HostRunner; image: RecordValue; root: string;
  api(method: string, route: string, body?: unknown, token?: string): Promise<{ status: number; body: any }>;
  account(username: string): Promise<{ session: string; id: string }>;
  device(owner: string): Promise<string>;
  reserved(): Promise<RecordValue>;
  watch(token: string, machineId: string, request?: { ttlSeconds?: number }): Promise<{ id: string; stream: LiveStream; got: ReturnType<typeof collect> }>;
}
async function fixture(t: TestContext, options: Options = {}): Promise<Fixture> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mobile-live-"))), admin = key(), enrollment = key(), os = options.os ?? "android";
  writeFileSync(join(root, "admin"), admin, { mode: 0o600 }); writeFileSync(join(root, "enroll"), enrollment, { mode: 0o600 });
  const controller = await startController({ statePath: join(root, "controller.sqlite"), adminTokenFile: join(root, "admin"), enrollmentTokenFile: join(root, "enroll"), controllerId: randomUUID(), listen: { host: "127.0.0.1", port: 0 } });
  const url = `http://127.0.0.1:${controller.address.port}`, stats: Stats = { captures: 0, open: 0, peak: 0, encoders: 0, encodersOpen: 0 };
  const image: RecordValue = os === "android"
    ? { id: "live-phone", revision: "1", os, arch: "arm64", mode: "device", minimum: { cpu: 1, memoryMiB: 1024, diskGiB: 4 }, device: { systemImage: "system-images;android-35;google_apis;arm64-v8a", profile: "pixel_8" } }
    : { id: "live-iphone", revision: "1", os, arch: "arm64", mode: "device", minimum: { cpu: 1, memoryMiB: 1024, diskGiB: 4 }, device: { runtime: "com.apple.CoreSimulator.SimRuntime.iOS-18-0", deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-16" } };
  class Device extends MobileProvider {
    override readonly kind = os;
    async check() { return { ready: true, nativeAcceptance: false }; }
    async reconcile(machine: RecordValue) { return { state: machine.desired }; }
    /** A frame every 40 ms until the run's time limit, then a clean end, as a native source does. */
    async openVideo(_machine: RecordValue, _image: RecordValue, _folder: string, video: { fps: number; durationSeconds: number; bitRate: number }, check: Authorized, cleanupCheck?: Authorized): Promise<NativePipe> {
      assert.equal(video.fps, 30); assert.ok(await check());
      stats.captures++; stats.open++; stats.peak = Math.max(stats.peak, stats.open);
      const started = Date.now(); let completed = false, frame = 0, closing: Promise<void> | undefined;
      const stopped = () => { if (stats.open > 0) stats.open--; };
      return {
        async read() {
          for (;;) {
            if (closing) throw new Error("capture closed");
            if (!await check()) throw new Error("capture authorization ended");
            if (Date.now() - started >= video.durationSeconds * 1000) { if (!completed) { completed = true; stopped(); } return Buffer.alloc(0); }
            await sleep(40);
            if (!closing) return Buffer.from([0, 0, 0, 1, 0x65, frame++ & 0xff]);
          }
        },
        async wait() { if (!completed) throw new Error("capture did not end by itself"); return 0; },
        async write() { throw new Error("no source input"); },
        async end() { /* no input channel */ },
        close() {
          closing ??= (async () => {
            if (completed) return;
            // An Android guest recorder is stopped only under the assignment that started it; an
            // iOS source is a host process, stopped by its own protocol.
            if (options.stop === "unprovable" || os === "android" && !(cleanupCheck && await cleanupCheck())) throw new Error("capture stop is unproven");
            stopped();
          })();
          return closing;
        },
      };
    }
    override async pipe(argv: readonly string[]): Promise<NativePipe> {
      assert.equal(argv[0], "/fixture/ffmpeg"); assert.ok(argv.includes("libx264"));
      stats.encoders++; stats.encodersOpen++;
      let open = true;
      return new FragmentEncoder({ close: () => { if (open) { open = false; stats.encodersOpen--; } } });
    }
  }
  const config: HostConfig = { url, stateDir: join(root, "runner"), enrollmentToken: enrollment, name: "remote-device-host", provider: os, storage: join(root, "devices"),
    videoEncoder: "/fixture/ffmpeg", templates: [image], capacity: { cpu: 8, memoryMiB: 8192, diskGiB: 32 }, pollIntervalSeconds: .25, concurrency: 4, ...options.config };
  const runner = new HostRunner(config, { providerFactory: (settings, state) => new Device({ ...settings, transport: { run: async () => { throw new Error("Native SDK execution is forbidden in this fixture."); } } }, state) });
  await runner.start();
  t.after(async () => { await runner.close().catch(() => {}); await controller.close().catch(() => {}); rmSync(root, { recursive: true, force: true }); });
  const api = async (method: string, route: string, body?: unknown, token = admin) => {
    const response = await fetch(url + route, { method, headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as any };
  };
  const password = randomBytes(24).toString("hex");
  const manager = (await api("POST", "/v1/auth/setup", { username: "admin", password })).body.token as string;
  return { url, admin: manager, hostId: runner.identity!.id, stats, runner, image, api, root,
    async account(username) {
      const user = (await api("POST", "/v1/users", { id: randomUUID(), username }, manager)).body, invite = (await api("POST", `/v1/users/${user.id}/invite`, {}, manager)).body;
      return { session: (await api("POST", "/v1/auth/claim", { token: invite.token, password }, "")).body.token as string, id: user.id as string };
    },
    async device(owner) {
      const id = randomUUID(), request = { id, name: `device-${id.slice(0, 8)}`, templateId: image.id, resources: {} };
      // The host is placeable once its first environment check has been reported.
      await until(async () => (await api("GET", "/v1/hosts", undefined, manager)).body.hosts[0]?.placementReady === true, "a placeable host");
      const created = await api("POST", "/v1/machines", request, owner);
      assert.ok([200, 201].includes(created.status), JSON.stringify(created.body));
      await until(async () => { const m = (await api("GET", "/v1/machines", undefined, owner)).body.machines.find((item: RecordValue) => item.id === id); return m?.observed === "running"; }, "a running device");
      return id;
    },
    async reserved() { return ((await api("GET", "/v1/hosts", undefined, manager)).body.hosts as RecordValue[])[0]!.reserved as RecordValue; },
    async watch(token, machineId, request = {}) {
      const id = randomUUID(), stream = await new MachineLiveClient({ baseUrl: url, credential: token, allowLoopbackHttp: true }).watch(machineId, { id, ...request }, { timeoutMs: 20000 });
      return { id, stream, got: collect(stream) };
    },
  };
}
const media = (stream: ReturnType<typeof collect>) => stream.segments.filter(s => s.kind === "media");

test("an owner and an administrator watch an owned device through its remote host; another account cannot, and viewers share one capture", { timeout: 120000 }, async t => {
  const f = await fixture(t), owner = await f.account("owner"), other = await f.account("other");
  const machineId = await f.device(owner.session), base = await f.reserved();
  const live = new MachineLiveClient({ baseUrl: f.url, credential: owner.session, allowLoopbackHttp: true });
  const mine = await f.watch(owner.session, machineId);
  await until(() => media(mine.got).length >= 5, "live segments for the owner");
  const view = await live.inspect(machineId, mine.id);
  assert.deepEqual([view.state, view.machineId, view.capability, view.leaseId], ["ready", machineId, "live", undefined]);
  assert.deepEqual(await f.reserved(), { ...base, cpu: Number(base.cpu) + 1, memoryMiB: Number(base.memoryMiB) + 256 });
  assert.equal(mine.got.segments[0]!.kind, "init"); assert.ok(mine.got.segments.every(s => liveSegmentValid(s.kind, s.data)));
  // An administrator watches the same device under their own credential: one capture, no new reservation.
  const admin = await f.watch(f.admin, machineId);
  await until(() => media(admin.got).length >= 5, "live segments for the administrator");
  assert.equal(f.stats.captures, 1); assert.equal(f.stats.encoders, 1);
  assert.equal((await new MachineLiveClient({ baseUrl: f.url, credential: f.admin, allowLoopbackHttp: true }).inspect(machineId, admin.id)).captureId, view.captureId);
  assert.deepEqual(await f.reserved(), { ...base, cpu: Number(base.cpu) + 1, memoryMiB: Number(base.memoryMiB) + 256 });
  for (const s of media(admin.got).slice(0, 3)) assert.deepEqual(media(mine.got).find(m => m.sequence === s.sequence)?.data ?? (await until(() => media(mine.got).some(m => m.sequence === s.sequence), "the same segment"), media(mine.got).find(m => m.sequence === s.sequence)!.data), s.data);
  // Another account sees no such device: it can neither create, read, close nor attach.
  assert.equal((await f.api("POST", `/v1/machines/${machineId}/live-views`, { id: randomUUID() }, other.session)).status, 404);
  assert.equal((await f.api("GET", `/v1/machines/${machineId}/live-views/${mine.id}`, undefined, other.session)).status, 404);
  assert.equal((await f.api("POST", `/v1/machines/${machineId}/live-views/${mine.id}/close`, {}, other.session)).status, 404);
  await assert.rejects(new MachineLiveClient({ baseUrl: f.url, credential: other.session, allowLoopbackHttp: true }).connect(view, { timeoutMs: 5000 }));
  // Views are bound to the credential that opened them: the administrator's is not the owner's to read or end.
  assert.equal((await f.api("GET", `/v1/machines/${machineId}/live-views/${admin.id}`, undefined, owner.session)).status, 404);
  // A token without machine access, and a host credential, are refused.
  const readOnly = (await f.api("POST", "/v1/auth/tokens", { id: randomUUID(), name: "read", scopes: ["machines:read"], expiresInSeconds: 600 }, owner.session)).body.token as string;
  assert.equal((await f.api("POST", `/v1/machines/${machineId}/live-views`, { id: randomUUID() }, readOnly)).status, 403);
  assert.equal((await f.api("POST", `/v1/machines/${machineId}/live-views`, { id: randomUUID() }, f.runner.identity!.credential)).status, 401);
  // Exact bodies and bounded lifetimes only.
  for (const body of [{}, { id: randomUUID(), member: "primary" }, { id: randomUUID(), ttlSeconds: 5 }, { id: "not-a-uuid" }]) assert.equal((await f.api("POST", `/v1/machines/${machineId}/live-views`, body, owner.session)).status, 400);
  // At most four viewers per device, whoever they are.
  const more = [await f.watch(owner.session, machineId), await f.watch(owner.session, machineId)];
  const over = await f.api("POST", `/v1/machines/${machineId}/live-views`, { id: randomUUID() }, f.admin);
  assert.equal(over.status, 429); assert.equal(over.body.code, "live_view_limit");
  // The capture stops when the last viewer has left, and its reservation follows the cleanup proof.
  for (const viewer of [...more, admin]) { viewer.stream.close(); await viewer.got.done; }
  await sleep(1000); assert.equal(f.stats.open, 1, "the capture still runs for the remaining viewer");
  mine.stream.close(); await mine.got.done;
  assert.ok(ordered(mine.got.segments)); assert.ok(ordered(admin.got.segments));
  await until(async () => f.stats.open === 0 && f.stats.encodersOpen === 0, "the capture to stop");
  await until(async () => (await f.api("GET", `/v1/machines/${machineId}/video-sessions/${view.captureId}`, undefined, owner.session)).body.cleaned === true, "positive capture cleanup");
  assert.deepEqual(await f.reserved(), base);
  assert.equal(f.stats.captures, 1); assert.equal(f.stats.peak, 1);
});

test("stopping a watched device ends its views, and its capture and compute are released", { timeout: 120000 }, async t => {
  const f = await fixture(t), owner = await f.account("owner");
  const machineId = await f.device(owner.session), base = await f.reserved();
  const viewer = await f.watch(owner.session, machineId);
  await until(() => media(viewer.got).length >= 3, "live segments");
  const capture = (await new MachineLiveClient({ baseUrl: f.url, credential: owner.session, allowLoopbackHttp: true }).inspect(machineId, viewer.id)).captureId;
  const session = () => f.api("GET", `/v1/machines/${machineId}/video-sessions/${capture}`, undefined, owner.session);
  // A deletion is refused while the device's capture is live.
  assert.equal((await f.api("POST", `/v1/machines/${machineId}/delete`, { id: randomUUID() }, owner.session)).status, 409);
  assert.equal((await f.api("POST", `/v1/machines/${machineId}/desired`, { state: "stopped" }, owner.session)).status, 200);
  await viewer.got.done;
  assert.deepEqual(viewer.stream.ended, { reason: "device_stopped", source: "controller" });
  // Whichever came first, the runner's own recorder proof or the device's proven stop, releases it.
  await until(async () => (await session()).body.cleaned === true, "capture cleanup");
  assert.equal(f.stats.encodersOpen, 0);
  await until(async () => { const reserved = await f.reserved(); return reserved.cpu === Number(base.cpu) - 1 && reserved.memoryMiB === Number(base.memoryMiB) - 1024; }, "neither the stopped device's compute nor its capture reserved");
  // A stopped device has no live view.
  assert.equal((await f.api("POST", `/v1/machines/${machineId}/live-views`, { id: randomUUID() }, owner.session)).status, 409);
});

test("an Android capture whose recorder stop is unproven stays reserved until its device is proven stopped, then the device can be watched again", { timeout: 120000 }, async t => {
  const f = await fixture(t, { stop: "unprovable" }), owner = await f.account("owner");
  const machineId = await f.device(owner.session), base = await f.reserved();
  const viewer = await f.watch(owner.session, machineId);
  await until(() => media(viewer.got).length >= 3, "live segments");
  const capture = (await new MachineLiveClient({ baseUrl: f.url, credential: owner.session, allowLoopbackHttp: true }).inspect(machineId, viewer.id)).captureId;
  const session = () => f.api("GET", `/v1/machines/${machineId}/video-sessions/${capture}`, undefined, owner.session);
  viewer.stream.close(); await viewer.got.done;
  // The runner could not prove the guest recorder stopped: it reports only its own encoder's exit.
  await until(async () => (await session()).body.hostCleaned === true, "the runner's encoder receipt");
  const journal = JSON.parse(readFileSync(join(f.root, "runner", "work", "live", `${capture}.json`), "utf8"));
  assert.deepEqual([journal.state, journal.cleaned, journal.hostCleaned], ["unknown", false, true]);
  // That alone releases nothing while the device, and so possibly its recorder, still runs.
  await sleep(2000);
  assert.deepEqual([(await session()).body.state, (await session()).body.cleaned], ["disconnected", false]);
  assert.deepEqual(await f.reserved(), { ...base, cpu: Number(base.cpu) + 1, memoryMiB: Number(base.memoryMiB) + 256 });
  const blocked = await f.api("POST", `/v1/machines/${machineId}/live-views`, { id: randomUUID() }, owner.session);
  assert.equal(blocked.status, 409); assert.equal(blocked.body.code, "capture_cleanup_pending"); assert.equal(blocked.body.retryable, true);
  // The device's own proven stop is the recorder's proof: no administrator is needed.
  assert.equal((await f.api("POST", `/v1/machines/${machineId}/desired`, { state: "stopped" }, owner.session)).status, 200);
  await until(async () => (await session()).body.cleaned === true, "cleanup settled by the device's stop");
  // Started again, the device can be watched again.
  assert.equal((await f.api("POST", `/v1/machines/${machineId}/desired`, { state: "running" }, owner.session)).status, 200);
  await until(async () => (await f.api("GET", "/v1/machines", undefined, owner.session)).body.machines.find((m: RecordValue) => m.id === machineId)?.observed === "running", "the restarted device");
  const again = await f.watch(owner.session, machineId);
  await until(() => media(again.got).length >= 2, "segments after the restart");
  again.stream.close(); await again.got.done;
});

test("a view ends when its credential is revoked, and an unprovable capture stop holds the reservation and blocks the device", { timeout: 180000 }, async t => {
  const f = await fixture(t, { os: "ios", config: { liveView: true }, stop: "unprovable" }), owner = await f.account("owner");
  const machineId = await f.device(owner.session), base = await f.reserved();
  const issued = (await f.api("POST", "/v1/auth/tokens", { id: randomUUID(), name: "viewer", scopes: ["machines:access"], expiresInSeconds: 600 }, owner.session)).body;
  const viewer = await f.watch(issued.token as string, machineId);
  await until(() => media(viewer.got).length >= 3, "live segments");
  assert.equal((await f.api("POST", `/v1/auth/tokens/${issued.id}/revoke`, {}, owner.session)).status, 200);
  await viewer.got.done;
  // The revoked token can no longer read why its view ended.
  assert.deepEqual(viewer.stream.ended, { reason: "credential_rejected", source: "controller" });
  await until(() => f.stats.encodersOpen === 0, "the encoder to exit");
  // This iOS source could not be proven stopped (as idb's stop cannot on some installations): the
  // capture stays reserved. A device stop does not settle it, because the source is a host process.
  const captures = (await f.api("GET", "/v1/admin/system", undefined, f.admin)).body.sessions.filter((s: RecordValue) => s.machineId === machineId);
  assert.equal(captures.length, 1);
  const capture = captures[0].id as string, session = () => f.api("GET", `/v1/machines/${machineId}/video-sessions/${capture}`, undefined, owner.session);
  await until(async () => (await session()).body.state === "disconnected", "the ended capture");
  await sleep(3000);
  assert.deepEqual([(await session()).body.cleaned, (await session()).body.kind], [false, "live"]);
  assert.deepEqual(await f.reserved(), { ...base, cpu: Number(base.cpu) + 1, memoryMiB: Number(base.memoryMiB) + 256 });
  const refused = await f.api("POST", `/v1/machines/${machineId}/live-views`, { id: randomUUID() }, owner.session);
  assert.equal(refused.status, 409); assert.equal(refused.body.code, "capture_cleanup_pending");
  assert.equal((await f.api("POST", `/v1/machines/${machineId}/video-sessions`, { id: randomUUID(), fps: 30, durationSeconds: 2, bitRate: 4_000_000 }, owner.session)).status, 409);
  assert.equal((await f.api("POST", `/v1/machines/${machineId}/desired`, { state: "stopped" }, owner.session)).status, 200);
  await until(async () => (await f.api("GET", "/v1/machines", undefined, owner.session)).body.machines.find((m: RecordValue) => m.id === machineId)?.observed === "stopped", "a stopped device");
  assert.equal((await session()).body.cleaned, false);
  // The owner cannot abandon it; an administrator can, once its deadline has passed.
  assert.equal((await f.api("POST", `/v1/machines/${machineId}/video-sessions/${capture}/abandon`, { reason: "idb stop unconfirmed" }, owner.session)).status, 403);
  await until(async () => (await f.api("POST", `/v1/machines/${machineId}/video-sessions/${capture}/abandon`, { reason: "idb stop unconfirmed; host inspected" }, f.admin)).status === 200, "abandonment after the deadline", 90000);
  assert.equal((await session()).body.cleaned, false, "abandonment claims no cleanup");
});

test("iOS live view is off unless the host opts in, and a host without an encoder refuses without holding a reservation", { timeout: 60000 }, async t => {
  const f = await fixture(t, { os: "ios" }), owner = await f.account("owner");
  const machineId = await f.device(owner.session), base = await f.reserved();
  const client = new MachineLiveClient({ baseUrl: f.url, credential: owner.session, allowLoopbackHttp: true });
  const view = await client.create(machineId, { id: randomUUID() });
  // The host answers that it has no live capture for this device; nothing native ran.
  await assert.rejects(client.connect(view, { timeoutMs: 20000 }), (error: any) => error.code === "capability_unsupported");
  assert.equal(f.stats.captures, 0); assert.equal(f.stats.encoders, 0);
  await until(async () => (await f.api("GET", `/v1/machines/${machineId}/video-sessions/${view.captureId}`, undefined, owner.session)).body.cleaned === true, "the unused capture released");
  assert.deepEqual(await f.reserved(), base);
});

test("an opted-in iOS host streams an owned simulator, and a recording shares the device's one capture with its viewers", { timeout: 120000 }, async t => {
  const f = await fixture(t, { os: "ios", config: { liveView: true } }), owner = await f.account("owner");
  const machineId = await f.device(owner.session), base = await f.reserved();
  const viewer = await f.watch(owner.session, machineId);
  await until(() => media(viewer.got).length >= 3, "live segments");
  // The owner records while watching: the recording takes the capture and the viewer follows it.
  const video = new MobileVideoClient({ baseUrl: f.url, credential: owner.session, allowLoopbackHttp: true });
  const session = await video.create(machineId, { id: randomUUID(), fps: 30, durationSeconds: 2, bitRate: 2_000_000 });
  const chunks: Buffer[] = [], finish = await (await video.connect(session, { timeoutMs: 20000 })).record({ write(bytes) { chunks.push(Buffer.from(bytes)); return bytes.length; } });
  assert.equal(finish.bytes, Buffer.concat(chunks).length); assert.equal(finish.cleaned, true);
  const inits = () => viewer.got.segments.filter(s => s.kind === "init").map(s => s.epoch);
  await until(() => inits().length >= 3 && media(viewer.got).some(s => s.epoch === inits()[2]), "the viewer's own capture resumed");
  const during = media(viewer.got).filter(s => s.epoch === inits()[1]);
  assert.ok(during.length >= 2); for (const segment of during) assert.ok(Buffer.concat(chunks).includes(segment.data));
  assert.equal(f.stats.peak, 1, "never two native captures of one device"); assert.ok(ordered(viewer.got.segments));
  viewer.stream.close(); await viewer.got.done;
  await until(async () => JSON.stringify(await f.reserved()) === JSON.stringify(base), "every reservation released");
  // The host reaches the SDK only through the controller: a host credential opens no view.
  await assert.rejects(new MachineLiveClient({ baseUrl: f.url, credential: f.runner.identity!.credential, allowLoopbackHttp: true }).create(machineId, { id: randomUUID() }), (error: unknown) => error instanceof ConsumerServiceError && error.status === 401);
});

test("the dashboard relays an owned live view to a same-origin cookie session, including in-band renewal", { timeout: 60000 }, async t => {
  const f = await fixture(t), owner = await f.account("owner"), other = await f.account("other");
  const machineId = await f.device(owner.session);
  const dashboard = await startDashboard({ orchestratorUrl: f.url, listen: { host: "127.0.0.1", port: 0 } });
  t.after(() => dashboard.close());
  const home = `http://127.0.0.1:${dashboard.address.port}`, cookie = (token: string) => ({ Cookie: `canaveral_session=${token}`, Origin: home });
  const created = await fetch(`${home}/api/v1/machines/${machineId}/live-views`, { method: "POST", headers: { ...cookie(owner.session), "Content-Type": "application/json" }, body: JSON.stringify({ id: randomUUID(), ttlSeconds: 30 }) });
  assert.equal(created.status, 201);
  const view = await created.json() as { id: string; generation: string }, path = `/api/v1/machines/${machineId}/live-views/${view.id}/${view.generation}`;
  const open = (headers: Record<string, string>) => {
    const socket = new WebSocket(home.replace("http:", "ws:") + path, { protocols: ["canaveral-session-v1"], headers } as unknown as string[]);
    socket.binaryType = "arraybuffer";
    const inbox: (string | Buffer)[] = [];
    socket.onmessage = event => { inbox.push(typeof event.data === "string" ? event.data : Buffer.from(event.data as ArrayBuffer)); };
    return { socket, inbox, opened: new Promise<boolean>(resolve => { socket.onopen = () => resolve(true); socket.onerror = () => resolve(false); }) };
  };
  // No Origin, a foreign Origin, a bearer header and another account are refused; a plain GET is not a route.
  for (const headers of [{ Cookie: `canaveral_session=${owner.session}` }, { ...cookie(owner.session), Origin: "http://attacker.example" }, { Authorization: `Bearer ${owner.session}`, Origin: home }, cookie(other.session)]) assert.equal(await open(headers).opened, false);
  assert.equal((await fetch(home + path, { headers: cookie(owner.session) })).status, 404);
  const page = open(cookie(owner.session));
  assert.equal(await page.opened, true);
  const controls = () => page.inbox.filter((m): m is string => typeof m === "string").map(m => JSON.parse(m) as RecordValue);
  await until(() => controls().some(c => c.type === "segment") && page.inbox.some(m => Buffer.isBuffer(m)), "segments in the browser");
  assert.deepEqual(controls().slice(0, 3).map(c => c.type), ["ready", "live", "init"]);
  assert.deepEqual(controls()[1], { type: "live", mediaType: "video/mp4", codec: "avc1", fps: 30 });
  // The page renews through the same socket; the broker answers and the host never sees it.
  const ready = await (await fetch(`${home}/api/v1/machines/${machineId}/live-views/${view.id}`, { headers: cookie(owner.session) })).json() as { state: string; authorizationDeadline: string };
  assert.equal(ready.state, "ready");
  await sleep(1500);
  page.socket.send(JSON.stringify({ type: "renew" }));
  await until(() => controls().some(c => c.type === "renewal"), "a renewal reply");
  const renewal = controls().find(c => c.type === "renewal")!;
  assert.equal(renewal.renewed, true); assert.ok(Date.parse(String(renewal.authorizationDeadline)) > Date.parse(ready.authorizationDeadline));
  // Any other viewer message ends the session.
  page.socket.send(JSON.stringify({ type: "ack" }));
  await until(() => page.socket.readyState === WebSocket.CLOSED, "the relay to close");
  const closed = await fetch(`${home}/api/v1/machines/${machineId}/live-views/${view.id}/close`, { method: "POST", headers: { ...cookie(owner.session), "Content-Type": "application/json" }, body: "{}" });
  assert.equal(closed.status, 200); assert.equal((await closed.json() as { state: string }).state, "ended");
  assert.equal((await fetch(`${home}/api/v1/machines/${machineId}/live-views/${view.id}`, { headers: cookie(owner.session) })).status, 200);
});

test("live captures and recordings share the host's four video session slots", { timeout: 120000 }, async t => {
  const f = await fixture(t, { config: { capacity: { cpu: 16, memoryMiB: 16384, diskGiB: 64 } } }), owner = await f.account("owner");
  const devices: string[] = [];
  for (let i = 0; i < 5; i++) devices.push(await f.device(owner.session));
  // Three watched devices and one recording fill the host's four slots.
  const viewers = [];
  for (const machineId of devices.slice(0, 3)) viewers.push(await f.watch(owner.session, machineId));
  const video = new MobileVideoClient({ baseUrl: f.url, credential: owner.session, allowLoopbackHttp: true });
  const session = await video.create(devices[3]!, { id: randomUUID(), fps: 30, durationSeconds: 20, bitRate: 4_000_000 });
  for (const viewer of viewers) await until(() => media(viewer.got).length >= 2, "segments on every watched device");
  assert.equal(f.stats.captures, 3);
  // A new live capture cannot displace one already holding a slot.
  assert.equal((await f.api("POST", `/v1/machines/${devices[4]}/live-views`, { id: randomUUID() }, owner.session)).status, 429);
  // More viewers of an already watched device need no slot.
  const joined = await f.watch(owner.session, devices[0]!);
  await until(() => media(joined.got).length >= 2, "segments for a joining viewer");
  assert.equal(f.stats.captures, 3);
  // The next recording displaces the oldest live capture. Both pending recordings still
  // need a viewer before opening a native source.
  const priority = await video.create(devices[4]!, { id: randomUUID(), fps: 30, durationSeconds: 2, bitRate: 4_000_000 });
  await viewers[0]!.got.done;
  const live = new MachineLiveClient({ baseUrl: f.url, credential: owner.session, allowLoopbackHttp: true });
  assert.equal((await live.inspect(devices[0]!, viewers[0]!.id)).endReason, "preempted_by_recording");
  await video.close(devices[4]!, priority.id);
  await until(async () => (await video.inspect(devices[4]!, priority.id)).cleaned === true, "the priority recording's slot");
  // Closing the first recording also frees its slot after the runner confirms cleanup.
  await video.close(devices[3]!, session.id);
  await until(async () => (await video.inspect(devices[3]!, session.id)).cleaned === true, "the closed recording's slot");
  const fifth = await f.watch(owner.session, devices[4]!);
  await until(() => media(fifth.got).length >= 2, "segments once a slot is free");
  for (const viewer of [...viewers, joined, fifth]) { viewer.stream.close(); await viewer.got.done; }
  await until(async () => Number((await f.reserved()).cpu) === 5, "every capture released");
  assert.ok(f.stats.peak <= 4);
});
