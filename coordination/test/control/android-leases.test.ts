import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startController } from "../../src/main.ts";
import { HostRunner, hostOffer } from "../../src/host.ts";
import type { HostConfig } from "../../src/host.ts";
import { AndroidProvider } from "../../src/providers/android.ts";
import { mobileNativeHelper, nativeLeaseSupervisor } from "../../src/providers/mobile-native.ts";
import type { CommandResult, MobileTransport, RecordValue, RunOptions } from "../../src/providers/mobile.ts";

/** Disposable Android lease fixtures. A real loopback controller, a real HostRunner with the
 * native continuous lease clock and the real `lease-supervise` helper own stand-in emulator
 * processes (each with a grandchild in its group). adb and avdmanager are fakes. No SDK,
 * emulator or pre-existing device is touched. */
const helper = mobileNativeHelper({});
const unix = ["darwin", "linux"].includes(process.platform);
const skip = !unix || !existsSync(helper) ? "requires the built canaveral-mobile-native helper" : false;
const arch = process.arch === "arm64" ? "arm64" : "amd64";
const systemImage = `system-images;android-35;google_apis;${arch === "arm64" ? "arm64-v8a" : "x86_64"}`;
const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000" + "1f15c4890000000a49444154789c6300010000050001" + "0d0a2db40000000049454e44ae426082", "hex");
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; } };
const groupAlive = (pgid: number): boolean => { try { process.kill(-pgid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; } };
async function until(check: () => boolean | Promise<boolean>, label: string, ms = 20000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
  assert.fail(`Timed out waiting for ${label}`);
}

interface Emulator { name: string; port: number; pid: number; grandchild: number; bootedAt: number }
function sdk(root: string): { sdk: string; registry: string; events: string } {
  const sdkRoot = join(root, "sdk"), registry = join(root, "emulators"), events = join(root, "events");
  for (const dir of ["platform-tools", "emulator", "cmdline-tools/latest/bin", ...systemImage.split(";").reduce<string[]>((paths, part) => [...paths, join(paths.at(-1) ?? "", part)], [])]) mkdirSync(join(sdkRoot, dir), { recursive: true });
  mkdirSync(registry); mkdirSync(events);
  for (const tool of ["platform-tools/adb", "cmdline-tools/latest/bin/avdmanager"]) writeFileSync(join(sdkRoot, tool), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  // The stand-in emulator registers its console port, keeps a grandchild in its own process
  // group and boots after a short delay. Only the lease supervisor ever signals it.
  const script = join(root, "fake-emulator.mjs");
  writeFileSync(script, `import { spawn } from "node:child_process"; import { writeFileSync } from "node:fs";
const args = process.argv.slice(2), name = args[args.indexOf("-avd") + 1], port = Number(args[args.indexOf("-port") + 1]);
const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
writeFileSync(${JSON.stringify(registry)} + "/" + port + ".json", JSON.stringify({ name, port, pid: process.pid, grandchild: grandchild.pid, bootedAt: Date.now() + 300 }));
process.on("SIGTERM", () => { grandchild.kill("SIGTERM"); process.exit(0); });
setInterval(() => {}, 1000);\n`);
  writeFileSync(join(sdkRoot, "emulator/emulator"), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"\n`, { mode: 0o755 });
  return { sdk: sdkRoot, registry, events };
}
function emulators(registry: string): Emulator[] {
  return readdirSync(registry).filter(name => name.endsWith(".json")).map(name => JSON.parse(readFileSync(join(registry, name), "utf8")) as Emulator).filter(e => alive(e.pid));
}
/** Fake adb/avdmanager. Every device answer comes from the live stand-in process registry. */
function transport(paths: { sdk: string; registry: string; events: string }, counters: Map<string, number>): MobileTransport {
  const ok = (stdout: string | Buffer): CommandResult => ({ stdout, exitCode: 0 });
  return {
    async run(argv: readonly string[], options: RunOptions): Promise<CommandResult> {
      const tool = argv[0]!;
      if (tool.endsWith("avdmanager")) {
        const avd = argv[argv.indexOf("--path") + 1]!, name = argv[argv.indexOf("--name") + 1]!;
        mkdirSync(avd, { recursive: true }); writeFileSync(join(avd, "config.ini"), "hw.lcd.density=420\n");
        writeFileSync(join(options.env.ANDROID_AVD_HOME!, name + ".ini"), "path=" + avd + "\n");
        return ok("");
      }
      if (argv[1] === "start-server") return ok("");
      if (argv[1] === "devices") return ok("List of devices attached\n" + emulators(paths.registry).map(e => `emulator-${e.port}\tdevice\n`).join(""));
      assert.equal(argv[1], "-s");
      const serial = argv[2]!, args = argv.slice(3), device = emulators(paths.registry).find(e => `emulator-${e.port}` === serial);
      if (!device) return { stdout: "", exitCode: 1 };
      const key = `${device.name}:${args.join(" ")}`; counters.set(key, (counters.get(key) ?? 0) + 1);
      writeFileSync(join(paths.events, `${Date.now()}-${randomUUID()}.json`), JSON.stringify({ serial, name: device.name, args }));
      if (args.join(" ") === "emu avd name") return ok(device.name + "\nOK");
      if (args.join(" ") === "shell getprop sys.boot_completed") return ok(Date.now() >= device.bootedAt ? "1" : "");
      if (args.join(" ") === "shell pm path android") return ok("package:/system/framework/framework-res.apk");
      if (args.join(" ") === "exec-out screencap -p") return ok(PNG);
      if (args[0] === "shell" || args[0] === "logcat") return ok("ok");
      return { stdout: "", exitCode: 1 };
    },
    async processAbsent(pid) { return !alive(pid); },
    async portPairAvailable(port) { return !emulators(paths.registry).some(e => e.port === port); },
    leases: nativeLeaseSupervisor,
  };
}

interface Harness {
  url: string; admin: string; root: string; image: RecordValue; registry: string; events: string; counters: Map<string, number>;
  runner(): HostRunner; restartRunner(): Promise<void>; stopRunner(): Promise<void>; stopController(): Promise<void>; startController(): Promise<void>;
  api(method: string, route: string, body?: unknown, token?: string): Promise<{ status: number; body: any }>;
  application(): Promise<string>;
  storage(machineId: string): string;
  reserved(): Promise<RecordValue>;
}
async function harness(t: TestContext, capacity = 1): Promise<Harness> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "android-leases-")));
  const admin = randomBytes(32).toString("base64url"), enrollment = randomBytes(32).toString("base64url");
  writeFileSync(join(root, "admin"), admin, { mode: 0o600 }); writeFileSync(join(root, "enroll"), enrollment, { mode: 0o600 });
  const paths = sdk(root), counters = new Map<string, number>();
  const image: RecordValue = { id: "lease-phone", revision: "1", os: "android", arch, mode: "device", minimum: { cpu: 2, memoryMiB: 2048, diskGiB: 8 }, device: { systemImage, profile: "pixel_8" } };
  let controller: Awaited<ReturnType<typeof startController>> | undefined, port = 0, runner: HostRunner | undefined;
  const start = async () => {
    controller = await startController({ statePath: join(root, "controller.sqlite"), adminTokenFile: join(root, "admin"), enrollmentTokenFile: join(root, "enroll"), controllerId: "8a4d2f3e-5a7b-4c1d-9e2f-0123456789ab", listen: { host: "127.0.0.1", port } });
    port = controller.address.port;
  };
  await start();
  const url = `http://127.0.0.1:${port}`;
  const config: HostConfig = { url, stateDir: join(root, "runner"), enrollmentToken: enrollment, name: "android-lease-host", provider: "android", storage: join(root, "devices"),
    androidSDK: paths.sdk, templates: [image], capacity: { cpu: 2 * capacity, memoryMiB: 2048 * capacity, diskGiB: 8 * capacity }, pollIntervalSeconds: .25, concurrency: 4,
    leaseClockHelper: helper, leaseSupervisor: helper, leaseProtocol: 1, leaseImages: [{ id: image.id, revision: "1", arch, runtime: "android" }] };
  const launch = async () => {
    runner = new HostRunner(config, { providerFactory: (settings, state) => new AndroidProvider({ ...settings, transport: transport(paths, counters) }, state) });
    await runner.start();
  };
  await launch();
  t.after(async () => {
    await runner?.close().catch(() => {}); await controller?.close().catch(() => {});
    for (const e of readdirSync(paths.registry).map(n => JSON.parse(readFileSync(join(paths.registry, n), "utf8")) as Emulator)) for (const pid of [e.grandchild, e.pid]) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
    for (const file of readdirSync(join(root, "devices")).flatMap(id => { try { return [join(root, "devices", id, "lease-supervisor.json")]; } catch { return []; } }).filter(existsSync)) {
      try { process.kill(Number(JSON.parse(readFileSync(file, "utf8")).supervisorPid), "SIGKILL"); } catch { /* already gone */ }
    }
    rmSync(root, { recursive: true, force: true });
  });
  const api = async (method: string, route: string, body?: unknown, token = admin) => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as any };
  };
  return { url, admin, root, image, registry: paths.registry, events: paths.events, counters, api,
    runner: () => runner!,
    async restartRunner() { await runner!.close(); await launch(); },
    async stopRunner() { await runner!.close(); },
    async stopController() { await controller!.close(); },
    async startController() { await start(); },
    async application() {
      const created = await api("POST", "/v1/consumers", { id: randomUUID(), name: "agents", templates: [{ id: image.id, revision: "1", arch }],
        limits: { resources: { cpu: 16, memoryMiB: 65536, diskGiB: 256 }, activeLeases: 4, defaultTTLSeconds: 60, maxTTLSeconds: 600, maxLifetimeSeconds: 600, provisioningTimeoutSeconds: 120 } });
      assert.equal(created.status, 200, JSON.stringify(created.body)); return created.body.credential as string;
    },
    storage: (machineId: string) => join(root, "devices", machineId),
    async reserved() { const hosts = (await api("GET", "/v1/hosts")).body.hosts as RecordValue[]; return hosts[0]!.reserved as RecordValue; },
  };
}
/** One agent: queue a request, wait for admission and a checked ready device, then mint its scoped key. */
async function acquire(h: Harness, app: string, ttlSeconds: number, wait = true): Promise<{ id: string; key: string; machineId: string }> {
  const id = randomUUID(), body = { id, kind: "lease", intent: { templateId: h.image.id, templateRevision: "1", arch, ttlSeconds } };
  const submitted = await h.api("POST", "/v1/requests", body, app);
  assert.equal(submitted.status, 201, JSON.stringify(submitted.body));
  const replay = await h.api("POST", "/v1/requests", body, app);
  assert.equal(replay.status, 200); assert.equal(replay.body.id, id);
  if (!wait) return { id, key: "", machineId: "" };
  return ready(h, app, id);
}
async function ready(h: Harness, app: string, id: string): Promise<{ id: string; key: string; machineId: string }> {
  await until(async () => (await h.api("GET", `/v1/requests/${id}`, undefined, app)).body.state === "admitted", "admission");
  let lease: any;
  await until(async () => { lease = (await h.api("GET", `/v1/leases/${id}`, undefined, app)).body; return lease.state === "ready"; }, "a booted, checked emulator");
  assert.equal(lease.members[0].ready, true); assert.equal(lease.members[0].state, "running");
  const key = (await h.api("POST", `/v1/leases/${id}/credential`, {}, app)).body.credential as string;
  return { id, key, machineId: lease.members[0].machineId };
}
async function operate(h: Harness, lease: string, key: string, action: string, args: RecordValue = {}, id = randomUUID()): Promise<{ status: number; body: any }> {
  const submitted = await h.api("POST", `/v1/leases/${lease}/operations`, { id, member: "primary", action, arguments: args }, key);
  if (submitted.status !== 201 && submitted.status !== 200) return submitted;
  let current = submitted;
  await until(async () => { current = await h.api("GET", `/v1/leases/${lease}/operations/${id}`, undefined, key); return current.status !== 200 || current.body.state !== "queued"; }, `${action} receipt`);
  return current;
}
/** Snapshots a receipt as soon as it appears; positive cleanup may remove it moments later. */
function watchReceipt(t: TestContext, file: string): () => any {
  let value: any;
  const timer = setInterval(() => { if (value === undefined) try { value = JSON.parse(readFileSync(file, "utf8")); } catch { /* not yet written */ } }, 10);
  t.after(() => clearInterval(timer));
  return () => value;
}
function supervised(h: Harness, machineId: string): { childPid: number; supervisorPid: number } {
  return JSON.parse(readFileSync(join(h.storage(machineId), "lease-supervisor.json"), "utf8"));
}
async function cleaned(h: Harness, app: string, lease: string): Promise<void> {
  await until(async () => (await h.api("GET", `/v1/leases/${lease}`, undefined, app)).body.cleanup?.state === "complete", "positive cleanup", 30000);
}

test("leases are gated to supervised Android emulators with a native clock", () => {
  const image = { id: "phone", revision: "1", os: "android", arch, mode: "device", minimum: { cpu: 1, memoryMiB: 1024, diskGiB: 4 }, device: { systemImage, profile: "pixel_8" } };
  const base = { name: "h", provider: "android", capacity: { cpu: 2, memoryMiB: 2048, diskGiB: 8 }, templates: [image] };
  const lease = { leaseProtocol: 1, leaseImages: [{ id: "phone", revision: "1", arch, runtime: "android" }] };
  if (unix) assert.deepEqual(hostOffer({ ...base, ...lease, leaseClockHelper: "/opt/helper", leaseSupervisor: "/opt/helper" }).leaseImages, lease.leaseImages);
  for (const config of [{ ...base, ...lease, leaseSupervisor: "/opt/helper" }, { ...base, ...lease, leaseClockHelper: "/opt/helper" }, { ...base, ...lease, leaseClockHelper: "relative", leaseSupervisor: "/opt/helper" },
    { ...base, leaseProtocol: 1, leaseImages: [{ ...lease.leaseImages[0], runtime: "apple" }], leaseClockHelper: "/opt/helper", leaseSupervisor: "/opt/helper" },
    { ...base, provider: "ios", templates: [], leaseProtocol: 1, leaseImages: [{ id: "phone", revision: "1", arch, runtime: "ios" }], leaseClockHelper: "/opt/helper", leaseSupervisor: "/opt/helper" },
    { ...base, provider: "libvirt", templates: [], ...lease, leaseClockHelper: "/opt/helper", leaseSupervisor: "/opt/helper" }])
    assert.throws(() => hostOffer(config), /cannot advertise lease execution/);
  assert.throws(() => hostOffer({ ...base, ...lease, leaseImages: [{ ...lease.leaseImages[0], id: "other" }], leaseClockHelper: "/opt/helper", leaseSupervisor: "/opt/helper" }), unix ? /offered Android templates/ : /cannot advertise/);
});

test("two agents share a one-emulator host: ready only when checked, scoped control, waiting, expiry in use, proven cleanup, clean hand-over", { skip, timeout: 120000 }, async t => {
  const h = await harness(t), app = await h.application();
  const a = await acquire(h, app, 15);
  assert.ok(h.counters.get(`cvm-${a.machineId}:shell pm path android`), "readiness checked the package manager");
  assert.ok(h.counters.get(`cvm-${a.machineId}:shell getprop sys.boot_completed`), "readiness checked boot completion");
  const first = supervised(h, a.machineId), receipt = watchReceipt(t, join(h.storage(a.machineId), "lease-stopped.json"));
  assert.ok(alive(first.childPid) && groupAlive(first.childPid));
  // Scoped control: screenshot, input, launch and logs through A's lease key only.
  const shot = await operate(h, a.id, a.key, "screenshot");
  assert.equal(shot.body.state, "succeeded"); assert.equal(Buffer.from(shot.body.result.data, "base64").subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.equal((await operate(h, a.id, a.key, "tap", { x: 10, y: 20 })).body.state, "succeeded");
  assert.equal((await operate(h, a.id, a.key, "launch", { app: "test.canaveral.trial/.TrialActivity" })).body.state, "succeeded");
  assert.equal((await operate(h, a.id, a.key, "logs")).body.state, "succeeded");
  // The application key cannot act as the lease key.
  assert.equal((await h.api("POST", `/v1/leases/${a.id}/operations`, { id: randomUUID(), member: "primary", action: "tap", arguments: { x: 1, y: 1 } }, app)).status, 401);
  // Agent B queues while the host is full; nothing is reserved for it.
  const b = await acquire(h, app, 60, false);
  await new Promise(resolve => setTimeout(resolve, 1500));
  assert.equal((await h.api("GET", `/v1/requests/${b.id}`, undefined, app)).body.state, "waiting");
  assert.equal(emulators(h.registry).length, 1);
  // A keeps sending input until its lease expires; the old key is refused immediately afterwards.
  let refused: { status: number; body: any } | undefined;
  await until(async () => { const reply = await operate(h, a.id, a.key, "tap", { x: 5, y: 5 }); if (reply.status === 200 && reply.body.state === "succeeded") return false; refused = reply; return true; }, "expiry while in use", 40000);
  // A tap still in flight at expiry ends unknown (never replayed); later ones are refused or failed.
  assert.ok([401, 409, 410].includes(refused!.status) || ["failed", "unknown"].includes(refused!.body.state), JSON.stringify(refused));
  // The host fences conservatively, slightly before the controller's expiry (409 member_not_ready meanwhile).
  // A fence report that lands first ends the lease as failed rather than expired; both are terminal.
  await until(async () => ["expired", "failed"].includes((await h.api("GET", `/v1/leases/${a.id}`, undefined, app)).body.state), "terminal lease");
  assert.equal((await h.api("POST", `/v1/leases/${a.id}/operations`, { id: randomUUID(), member: "primary", action: "tap", arguments: { x: 1, y: 1 } }, a.key)).status, 410);
  // The supervisor stops the whole group, then cleanup proves removal and releases the reservation.
  await until(() => !alive(first.childPid) && !groupAlive(first.childPid), "supervised group stop");
  await until(() => receipt() !== undefined, "stop receipt"); const stopped = receipt();
  assert.equal(stopped.groupAbsent, true); assert.equal(stopped.childPid, first.childPid);
  await cleaned(h, app, a.id);
  assert.equal(existsSync(h.storage(a.machineId)), false);
  assert.equal(existsSync(join(h.root, "devices", "avds", `cvm-${a.machineId}.ini`)), false);
  // B is admitted to a clean, distinct emulator; A's key cannot reach it.
  const second = await ready(h, app, b.id);
  assert.notEqual(second.machineId, a.machineId);
  assert.equal(emulators(h.registry).length, 1); assert.equal(emulators(h.registry)[0]!.name, `cvm-${second.machineId}`);
  assert.equal((await operate(h, b.id, second.key, "tap", { x: 3, y: 4 })).body.state, "succeeded");
  assert.equal((await h.api("POST", `/v1/leases/${b.id}/operations`, { id: randomUUID(), member: "primary", action: "tap", arguments: { x: 1, y: 1 } }, a.key)).status, 401);
  assert.equal((await h.api("POST", `/v1/leases/${b.id}/release`, { id: randomUUID() }, second.key)).status, 200);
  await cleaned(h, app, b.id);
  assert.deepEqual(await h.reserved(), { cpu: 0, memoryMiB: 0, diskGiB: 0 });
});

test("controller loss: the host enforces the deadline alone, then reports proven cleanup when the controller returns", { skip, timeout: 120000 }, async t => {
  const h = await harness(t), app = await h.application();
  const a = await acquire(h, app, 8), group = supervised(h, a.machineId);
  await h.stopController();
  assert.ok(alive(group.childPid));
  await until(() => !groupAlive(group.childPid), "host-local deadline stop without the controller", 30000);
  assert.ok(existsSync(join(h.storage(a.machineId), "lease-fenced.json")));
  await h.startController();
  // The local fence is conservative and may precede the controller's own expiry slightly.
  await until(async () => ["expired", "failed"].includes((await h.api("GET", `/v1/leases/${a.id}`, undefined, app)).body.state), "terminal lease");
  assert.equal((await h.api("POST", `/v1/leases/${a.id}/operations`, { id: randomUUID(), member: "primary", action: "tap", arguments: { x: 1, y: 1 } }, a.key)).status, 410);
  await cleaned(h, app, a.id);
  assert.deepEqual(await h.reserved(), { cpu: 0, memoryMiB: 0, diskGiB: 0 });
});

test("host loss: the native supervisor stops the emulator at the deadline with no runner; recovery proves cleanup", { skip, timeout: 120000 }, async t => {
  const h = await harness(t), app = await h.application();
  const a = await acquire(h, app, 8), group = supervised(h, a.machineId), receipt = watchReceipt(t, join(h.storage(a.machineId), "lease-stopped.json"));
  await h.stopRunner();
  assert.ok(alive(group.childPid) && alive(group.supervisorPid), "the emulator outlives the runner process");
  await until(() => !groupAlive(group.childPid) && !alive(group.supervisorPid), "native deadline stop without runner or controller", 30000);
  await until(() => receipt() !== undefined, "stop receipt"); assert.equal(receipt().reason, "expired");
  // While the runner is gone the controller keeps the reservation; its restart proves cleanup.
  // The native deadline is conservative: it falls slightly before the controller's expiry.
  await until(async () => ["expired", "failed"].includes((await h.api("GET", `/v1/leases/${a.id}`, undefined, app)).body.state), "terminal lease");
  assert.deepEqual(await h.reserved(), { cpu: 2, memoryMiB: 2048, diskGiB: 8 });
  await h.restartRunner();
  await cleaned(h, app, a.id);
  assert.deepEqual(await h.reserved(), { cpu: 0, memoryMiB: 0, diskGiB: 0 });
});

test("renewal extends the native deadline; lost replies replay by UUID; runner and controller restarts neither relaunch nor replay", { skip, timeout: 120000 }, async t => {
  const h = await harness(t), app = await h.application();
  const a = await acquire(h, app, 6), group = supervised(h, a.machineId);
  // Renewal publishes a newer revision and a later native deadline before the original expires.
  const before = JSON.parse(readFileSync(join(h.storage(a.machineId), "lease-authorization.json"), "utf8"));
  const lease = (await h.api("GET", `/v1/leases/${a.id}`, undefined, app)).body;
  assert.equal((await h.api("POST", `/v1/leases/${a.id}/renew`, { id: randomUUID(), expectedRevision: lease.revision, ttlSeconds: 90 }, app)).status, 200);
  await until(() => { const now = JSON.parse(readFileSync(join(h.storage(a.machineId), "lease-authorization.json"), "utf8")); return now.revision > before.revision && now.deadline > before.deadline + 30 && now.fenced === false; }, "renewed native deadline");
  await new Promise(resolve => setTimeout(resolve, 7000));
  assert.ok(alive(group.childPid), "renewal kept the emulator past its original deadline");
  const operation = randomUUID();
  assert.equal((await operate(h, a.id, a.key, "tap", { x: 7, y: 8 }, operation)).body.state, "succeeded");
  const taps = h.counters.get(`cvm-${a.machineId}:shell 'input' 'tap' '7' '8'`);
  assert.equal(taps, 1);
  // A lost operation reply: the same UUID returns the receipt without running again.
  const replay = await h.api("POST", `/v1/leases/${a.id}/operations`, { id: operation, member: "primary", action: "tap", arguments: { x: 7, y: 8 } }, a.key);
  assert.equal(replay.body.state, "succeeded");
  assert.equal((await h.api("POST", `/v1/leases/${a.id}/operations`, { id: operation, member: "primary", action: "tap", arguments: { x: 9, y: 9 } }, a.key)).status, 409);
  // A lost credential reply: exchange again; the earlier key is revoked.
  const rotated = (await h.api("POST", `/v1/leases/${a.id}/credential`, {}, app)).body.credential as string;
  assert.equal((await h.api("GET", `/v1/leases/${a.id}/operations/${operation}`, undefined, a.key)).status, 401);
  assert.equal((await h.api("GET", `/v1/leases/${a.id}/operations/${operation}`, undefined, rotated)).body.state, "succeeded");
  // Runner restart: the same supervised emulator is recovered, never relaunched.
  await h.restartRunner();
  await new Promise(resolve => setTimeout(resolve, 1000));
  assert.equal(supervised(h, a.machineId).childPid, group.childPid); assert.ok(alive(group.childPid));
  assert.equal(emulators(h.registry).length, 1);
  assert.equal(h.counters.get(`cvm-${a.machineId}:shell 'input' 'tap' '7' '8'`), taps);
  // Controller restart keeps the lease and its device.
  await h.stopController(); await h.startController();
  assert.equal((await h.api("GET", `/v1/leases/${a.id}`, undefined, app)).body.state, "ready");
  assert.equal((await operate(h, a.id, rotated, "screenshot")).body.state, "succeeded");
  assert.equal((await h.api("POST", `/v1/leases/${a.id}/release`, { id: randomUUID() }, rotated)).status, 200);
  await until(() => !groupAlive(group.childPid), "release stops the group");
  await cleaned(h, app, a.id);
});

test("a lease key reaches only its own emulator, and the provider refuses a foreign serial", { skip, timeout: 120000 }, async t => {
  const h = await harness(t, 2), app = await h.application();
  const [a, b] = await Promise.all([acquire(h, app, 60), acquire(h, app, 60)]);
  assert.notEqual(a.machineId, b.machineId);
  assert.equal((await h.api("POST", `/v1/leases/${b.id}/operations`, { id: randomUUID(), member: "primary", action: "tap", arguments: { x: 1, y: 1 } }, a.key)).status, 401);
  assert.equal((await h.api("GET", `/v1/leases/${b.id}`, undefined, a.key)).status, 401);
  assert.equal((await h.api("POST", `/v1/leases/${a.id}/operations`, { id: randomUUID(), member: "other", action: "tap", arguments: { x: 1, y: 1 } }, a.key)).status, 404);
  // Point A's reserved endpoint at B's console port: the launch binding no longer matches, so
  // the provider refuses every command instead of driving B.
  const endpoint = join(h.storage(a.machineId), "endpoint.json"), original = readFileSync(endpoint, "utf8");
  const foreign = JSON.parse(readFileSync(join(h.storage(b.machineId), "endpoint.json"), "utf8"));
  writeFileSync(endpoint, JSON.stringify(foreign));
  const before = readdirSync(h.events).length;
  const refused = await operate(h, a.id, a.key, "tap", { x: 2, y: 2 });
  assert.notEqual(refused.body.state, "succeeded");
  const touched = readdirSync(h.events).slice(before).map(name => JSON.parse(readFileSync(join(h.events, name), "utf8")));
  assert.ok(!touched.some(event => event.name === `cvm-${b.machineId}` && event.args.join(" ").includes("'input' 'tap' '2' '2'")), "A's input never reached the other emulator");
  writeFileSync(endpoint, original);
  for (const lease of [a, b]) assert.equal((await h.api("POST", `/v1/leases/${lease.id}/release`, { id: randomUUID() }, lease.key)).status, 200);
  await cleaned(h, app, a.id); await cleaned(h, app, b.id);
});

test("unprovable cleanup keeps the reservation until the documented operator recovery", { skip, timeout: 120000 }, async t => {
  const h = await harness(t), app = await h.application();
  const a = await acquire(h, app, 60), group = supervised(h, a.machineId);
  // The supervisor is lost abruptly, leaving its emulator group orphaned.
  process.kill(group.supervisorPid, "SIGKILL");
  await until(() => !alive(group.supervisorPid), "supervisor loss");
  assert.ok(alive(group.childPid));
  assert.equal((await h.api("POST", `/v1/leases/${a.id}/release`, { id: randomUUID() }, a.key)).status, 200);
  await until(async () => { const lease = (await h.api("GET", `/v1/leases/${a.id}`, undefined, app)).body; return lease.cleanup.state === "blocked" && lease.members[0].cleanup.reason === "execution_pending"; }, "blocked cleanup");
  await new Promise(resolve => setTimeout(resolve, 3000));
  assert.equal((await h.api("GET", `/v1/leases/${a.id}`, undefined, app)).body.cleanup.state, "blocked");
  assert.deepEqual(await h.reserved(), { cpu: 2, memoryMiB: 2048, diskGiB: 8 });
  assert.ok(existsSync(h.storage(a.machineId)));
  // Documented recovery: the operator stops the process group named in lease-supervisor.json.
  process.kill(-group.childPid, "SIGKILL");
  await cleaned(h, app, a.id);
  assert.deepEqual(await h.reserved(), { cpu: 0, memoryMiB: 0, diskGiB: 0 });
});

test("the native supervisor refuses ended authorization and never relaunches an assignment", { skip, timeout: 30000 }, async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "android-supervisor-"))); chmodSync(root, 0o700);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const identity = { machineId: randomUUID(), leaseId: randomUUID(), bootId: randomUUID() };
  const clock = await nativeLeaseSupervisor.clock(helper);
  const authorize = (deadline: number, fenced = false, revision = 1) => writeFileSync(join(root, "lease-authorization.json"), JSON.stringify({ version: 1, ...identity, bootSessionID: clock.bootSessionID, revision, deadline, fenced }));
  const request = { version: 1, ...identity, executable: "/bin/sh", args: ["-c", "sleep 30 & sleep 30"], env: {}, cwd: root };
  authorize(clock.continuous - 1);
  await assert.rejects(nativeLeaseSupervisor.supervise(helper, root, request), (error: any) => error.supervisorExit === 1);
  assert.equal(existsSync(join(root, "lease-supervisor.json")), false);
  authorize(clock.continuous + 120);
  const child = await nativeLeaseSupervisor.supervise(helper, root, request);
  assert.ok(groupAlive(child.pid));
  // A stale revision cannot extend; a fence stops the group and leaves a sticky marker.
  authorize(clock.continuous + 120, true);
  await until(() => existsSync(join(root, "lease-stopped.json")), "fenced stop");
  assert.equal(groupAlive(child.pid), false); await until(() => child.supervisorExited(), "supervisor exit");
  assert.equal(JSON.parse(readFileSync(join(root, "lease-stopped.json"), "utf8")).reason, "fenced");
  authorize(clock.continuous + 120);
  await assert.rejects(nativeLeaseSupervisor.supervise(helper, root, request));
});
