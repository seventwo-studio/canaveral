import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { appendFileSync, chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { spawn as spawnProcess } from "node:child_process";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startController } from "../../src/main.ts";
import { HostRunner } from "../../src/host.ts";
import type { HostConfig } from "../../src/host.ts";
import { AndroidProvider } from "../../src/providers/android.ts";
import { mobileNativeHelper, nativeLeaseSupervisor } from "../../src/providers/mobile-native.ts";
import type { CommandResult, LeaseSupervisorTransport, MobileTransport, NativePipe, RecordValue, RunOptions } from "../../src/providers/mobile.ts";

/** Disposable Android lease fixtures. A real loopback controller, a real HostRunner with the
 * native continuous lease clock and the real `lease-supervise` helper own stand-in emulator
 * processes (each with a grandchild in its group). adb, avdmanager and qemu-img are fakes. No SDK,
 * emulator or pre-existing device is touched.
 *
 * The stand-in emulator keeps "disk state" in its AVD directory the way a real one does: a base
 * data image, an overlay that holds what was written to the device, and per-launch files. That is
 * enough to prove what a baseline captures and what a clone starts from; it says nothing about
 * whether a real emulator boots from copied user data. */
export const helper = mobileNativeHelper({});
export const unix = ["darwin", "linux"].includes(process.platform);
export const skip = !unix || !existsSync(helper) ? "requires the built canaveral-mobile-native helper" : false;
export const arch = process.arch === "arm64" ? "arm64" : "amd64";
export const systemImage = `system-images;android-35;google_apis;${arch === "arm64" ? "arm64-v8a" : "x86_64"}`;
export const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000" + "1f15c4890000000a49444154789c6300010000050001" + "0d0a2db40000000049454e44ae426082", "hex");
export const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; } };
export const groupAlive = (pgid: number): boolean => { try { process.kill(-pgid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; } };
export async function until(check: () => boolean | Promise<boolean>, label: string, ms = 20000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
  assert.fail(`Timed out waiting for ${label}`);
}

export interface Emulator { name: string; port: number; pid: number; grandchild: number; bootedAt: number; data: string }
export function sdk(root: string): { sdk: string; registry: string; events: string } {
  const sdkRoot = join(root, "sdk"), registry = join(root, "emulators"), events = join(root, "events");
  for (const dir of ["platform-tools", "emulator", "cmdline-tools/latest/bin", ...systemImage.split(";").reduce<string[]>((paths, part) => [...paths, join(paths.at(-1) ?? "", part)], [])]) mkdirSync(join(sdkRoot, dir), { recursive: true });
  mkdirSync(registry); mkdirSync(events);
  for (const tool of ["platform-tools/adb", "cmdline-tools/latest/bin/avdmanager", "emulator/qemu-img"]) writeFileSync(join(sdkRoot, tool), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  // The installed system image's package and build metadata: what a baseline is bound to.
  const imageDirectory = join(sdkRoot, ...systemImage.split(";"));
  writeFileSync(join(imageDirectory, "source.properties"), "Pkg.Desc=Fixture system image\nPkg.Revision=9\n");
  writeFileSync(join(imageDirectory, "build.prop"), "ro.build.fingerprint=fixture/35/9\n");
  // The stand-in emulator registers its console port, keeps a grandchild in its own process
  // group and boots after a short delay. Only the lease supervisor ever signals it.
  const script = join(root, "fake-emulator.mjs");
  writeFileSync(script, `import { spawn } from "node:child_process"; import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2), name = args[args.indexOf("-avd") + 1], port = Number(args[args.indexOf("-port") + 1]);
const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
// Disk state: the base image is created once; everything written to the device lands in the overlay.
// A launch without the SDK environment (a stand-in supervisor that starts it bare) has none.
let data = "";
if (process.env.ANDROID_AVD_HOME) {
  const avd = /^path=(.*)$/m.exec(readFileSync(process.env.ANDROID_AVD_HOME + "/" + name + ".ini", "utf8"))[1];
  if (!existsSync(avd + "/userdata-qemu.img")) writeFileSync(avd + "/userdata-qemu.img", "factory\\n");
  data = existsSync(avd + "/userdata-qemu.img.qcow2") ? readFileSync(avd + "/userdata-qemu.img.qcow2", "utf8") : "";
  appendFileSync(avd + "/userdata-qemu.img.qcow2", "boot:" + name + "\\n");
  // Per-launch files that belong to no baseline.
  writeFileSync(avd + "/hardware-qemu.ini", "avd.name=" + name + "\\n"); writeFileSync(avd + "/multiinstance.lock", String(process.pid));
  mkdirSync(avd + "/snapshots/default_boot", { recursive: true }); writeFileSync(avd + "/snapshots/default_boot/ram.bin", "ram of " + name);
}
writeFileSync(${JSON.stringify(registry)} + "/" + port + ".json", JSON.stringify({ name, port, pid: process.pid, grandchild: grandchild.pid, bootedAt: Date.now() + 300, data }));
process.on("SIGTERM", () => { grandchild.kill("SIGTERM"); process.exit(0); });
setInterval(() => {}, 1000);\n`);
  writeFileSync(join(sdkRoot, "emulator/emulator"), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"\n`, { mode: 0o755 });
  return { sdk: sdkRoot, registry, events };
}
export function emulators(registry: string): Emulator[] {
  return readdirSync(registry).filter(name => name.endsWith(".json")).map(name => JSON.parse(readFileSync(join(registry, name), "utf8")) as Emulator).filter(e => alive(e.pid));
}
/** A guest's view of 10.0.2.2: an isolated guest is refused everywhere; a leaky one really
 * connects to the host loopback port, as an unrestricted emulator would. */
export function reach(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = connect({ host: "127.0.0.1", port }, () => { socket.destroy(); resolve(true); });
    socket.setTimeout(1000, () => { socket.destroy(); resolve(false); });
    socket.once("error", () => resolve(false));
  });
}
export const ENCODER = "/fixture/ffmpeg", BOOT = "6a0e2f31-5b7c-4d8e-9f01-23456789abcd";
export function box(type: string, body = Buffer.alloc(0)): Buffer { const header = Buffer.alloc(8); header.writeUInt32BE(8 + body.length); header.write(type, 4); return Buffer.concat([header, body]); }
// A container envelope proves transport, verification and accounting only; it is not decodable video.
export const MP4 = Buffer.concat([box("ftyp", Buffer.from("isom0000")), box("moov"), box("moof"), box("mdat", Buffer.from("fixture encoded video"))]);
export const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
/** One fake native process: queued stdout, an exit status, bounded reads and waits. */
export class FakePipe implements NativePipe {
  private out: Buffer[] = []; private code: number | undefined; closed = false;
  constructor(private readonly hooks: { write?: (data: Buffer) => Promise<void> | void; end?: () => void; close?: () => void; wait?: () => void } = {}) {}
  push(data: Buffer): void { this.out.push(data); }
  exit(code: number): void { if (this.code === undefined) this.code = code; }
  get exited(): boolean { return this.code !== undefined; }
  async read(count: number, timeoutMs: number): Promise<Uint8Array> {
    const deadline = Date.now() + timeoutMs;
    while (!this.out.length && this.code === undefined && !this.closed) { if (Date.now() > deadline) throw new Error("read timeout"); await sleep(20); }
    const first = this.out[0];
    if (!first) return Buffer.alloc(0);
    if (first.length > count) { this.out[0] = first.subarray(count); return first.subarray(0, count); }
    this.out.shift(); return first;
  }
  async write(data: Uint8Array): Promise<number> { if (this.closed) throw new Error("closed"); await this.hooks.write?.(Buffer.from(data)); return data.length; }
  async end(): Promise<void> { this.hooks.end?.(); }
  async wait(timeoutMs: number): Promise<number> {
    this.hooks.wait?.();
    const deadline = Date.now() + timeoutMs;
    while (this.code === undefined) { if (Date.now() > deadline) throw new Error("wait timeout"); await sleep(20); }
    return this.code;
  }
  async close(): Promise<void> { if (!this.closed) { this.closed = true; this.hooks.close?.(); this.exit(143); } }
}
/** Guest and host media state observed by the fakes, per emulator name. */
export interface Media { recorders: Map<string, { running: boolean; started: number }>; installs: Map<string, Buffer[]>; commits: number; encoders: number; encodersOpen: number }
/** Fake adb/avdmanager. Every device answer comes from the live stand-in process registry. */
export function transport(paths: { sdk: string; registry: string; events: string; devices: string }, counters: Map<string, number>, fixture: HarnessOptions = {}, media?: Media): MobileTransport {
  const ok = (stdout: string | Buffer): CommandResult => ({ stdout, exitCode: 0 });
  return {
    async pipe(argv: readonly string[]): Promise<NativePipe> {
      if (!media) throw new Error("No native pipes in this fixture.");
      if (argv[0] === ENCODER) {
        assert.ok(argv.includes("libx264")); media.encoders++; media.encodersOpen++;
        let open = true;
        const encoder: FakePipe = new FakePipe({ end: () => { encoder.push(MP4); encoder.exit(0); }, close: () => { if (open) { open = false; media.encodersOpen--; } },
          // A wedged encoder never confirms its exit.
          wait: () => { if (fixture.encoder === "stuck") throw new Error("encoder exit unconfirmed"); } });
        return encoder;
      }
      assert.equal(argv[1], "-s");
      const serial = argv[2]!, args = argv.slice(3), live = () => emulators(paths.registry).find(e => `emulator-${e.port}` === serial);
      const device = live(); if (!device) throw new Error("device offline");
      if (args.includes("install-write")) {
        const size = Number(args[args.indexOf("-S") + 1]), received: Buffer[] = [];
        const install: FakePipe = new FakePipe({
          write: async data => {
            // A stalled transfer holds until the emulator is gone.
            while (fixture.installStall && live() && !install.closed) await sleep(50);
            if (!live()) throw new Error("device lost during install");
            received.push(data);
          },
          end: () => { media.installs.set(device.name, received); install.push(Buffer.from(`Success: streamed ${Buffer.concat(received).length === size ? size : 0} bytes\n`)); install.exit(0); },
        });
        return install;
      }
      if (args[0] === "shell" && String(args.at(-1)).includes("exec screenrecord")) {
        const limit = Number(/--time-limit ([0-9]+)/.exec(String(args.at(-1)))![1]), state = { running: true, started: Date.now() };
        media.recorders.set(device.name, state);
        const recorder = new FakePipe();
        recorder.push(Buffer.from(`canaveral-recorder ${BOOT} 4321 (sh) R 812 4321 812 0 -1 4194560 120 0 0 0 0 0 0 0 20 0 1 0 98765 10973184 512 18446744073709551615\n`));
        const timer = setInterval(() => {
          if (!live()) { state.running = false; recorder.exit(255); clearInterval(timer); return; }
          if (!state.running) { recorder.exit(1); clearInterval(timer); return; }
          if (Date.now() - state.started >= limit * 1000) { state.running = false; recorder.exit(0); clearInterval(timer); return; }
          if (!recorder.closed) recorder.push(Buffer.from([0, 0, 0, 1, 0x65, 1, 2, 3]));
        }, 100);
        return recorder;
      }
      throw new Error("Unexpected pipe " + args.join(" "));
    },
    async run(argv: readonly string[], options: RunOptions): Promise<CommandResult> {
      const tool = argv[0]!;
      if (tool.endsWith("avdmanager")) {
        const avd = argv[argv.indexOf("--path") + 1]!, name = argv[argv.indexOf("--name") + 1]!;
        mkdirSync(avd, { recursive: true }); writeFileSync(join(avd, "config.ini"), "hw.lcd.density=420\n");
        writeFileSync(join(options.env.ANDROID_AVD_HOME!, name + ".ini"), "path=" + avd + "\n");
        return ok("");
      }
      if (tool.endsWith("qemu-img")) { fixture.relocations?.push(argv.slice(1)); return ok(""); }
      if (argv[1] === "start-server") return ok("");
      if (argv[1] === "devices") return ok("List of devices attached\n" + emulators(paths.registry).map(e => `emulator-${e.port}\tdevice\n`).join(""));
      assert.equal(argv[1], "-s");
      const serial = argv[2]!, args = argv.slice(3), device = emulators(paths.registry).find(e => `emulator-${e.port}` === serial);
      if (!device) return { stdout: "", exitCode: 1 };
      const key = `${device.name}:${args.join(" ")}`; counters.set(key, (counters.get(key) ?? 0) + 1);
      writeFileSync(join(paths.events, `${Date.now()}-${randomUUID()}.json`), JSON.stringify({ serial, name: device.name, args }));
      if (args.join(" ") === "emu avd name") return ok(device.name + "\nOK");
      if (args.join(" ") === "emu kill") { process.kill(device.pid, "SIGTERM"); return ok("OK: killing emulator, bye bye"); }
      // An operator preparing a device: whatever it does ends up in that device's own overlay.
      if (args[0] === "shell" && args[1]?.startsWith("'prepare' ")) { appendFileSync(join(paths.devices, device.name.slice(4), "device.avd", "userdata-qemu.img.qcow2"), `prepared:${args[1].slice(10).replaceAll("'", "")}\n`); return ok(""); }
      if (args.join(" ") === "shell getprop sys.boot_completed") return ok(Date.now() >= device.bootedAt ? "1" : "");
      if (args.join(" ") === "shell pm path android") return ok("package:/system/framework/framework-res.apk");
      if (args.join(" ") === "shell getprop ro.debuggable") return ok(fixture.guest === "debuggable" ? "1" : "0");
      if (args.join(" ") === "exec-out screencap -p") return ok(PNG);
      if (media && args[0] === "shell" && args[1] === "pm" && args[2] === "install-create") return ok("Success: created install session [77]");
      if (media && args[0] === "shell" && args[1] === "pm" && args[2] === "install-commit") { media.commits++; return ok("Success"); }
      if (media && args[0] === "shell" && args[1] === "pm" && args[2] === "install-abandon") return ok("Success");
      // The exact-recorder probe: signals only the recorder this capture started.
      if (media && args[0] === "shell" && args[1]?.includes("canaveral-recorder") && args[1].includes("boot_id")) {
        const state = media.recorders.get(device.name);
        if (!state?.running) return ok("canaveral-recorder absent");
        if (/kill -(TERM|KILL)/.test(args[1])) state.running = false;
        return ok("canaveral-recorder running");
      }
      if (args[0] === "shell" && args[1]?.includes("canaveral-isolation")) {
        const ports = /for p in ([0-9 ]+); do/.exec(args[1])![1]!.trim().split(" ").map(Number), lines: string[] = [];
        for (const port of ports) {
          const reached = fixture.guest === "leaky" && await reach(port);
          lines.push(reached ? `canaveral-isolation ${port} 0 ` : `canaveral-isolation ${port} 1 nc: connect: Connection refused`);
        }
        return ok(lines.join("\n") + "\ncanaveral-isolation-done\n");
      }
      if (args[0] === "shell" || args[0] === "logcat") return ok("ok");
      return { stdout: "", exitCode: 1 };
    },
    // An account-owned device is launched by the runner itself, unsupervised, as in production.
    async spawn(argv: readonly string[], options: RunOptions & { log: string }) {
      const log = openSync(options.log, "a");
      try {
        const child = spawnProcess(argv[0]!, argv.slice(1), { env: options.env, stdio: ["ignore", log, log], detached: true });
        await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
        return { pid: child.pid!, stopped: async () => child.exitCode !== null || child.signalCode !== null };
      } finally { closeSync(log); }
    },
    async processAbsent(pid) { return !alive(pid); },
    async portPairAvailable(port) { return !emulators(paths.registry).some(e => e.port === port); },
    leases: fixture.leases ?? nativeLeaseSupervisor,
  };
}
export interface HarnessOptions {
  guest?: "isolated" | "leaky" | "debuggable"; leases?: LeaseSupervisorTransport;
  /** Host capacity beyond the emulators, for recording and upload reservations. */
  extra?: { cpu?: number; memoryMiB?: number; diskGiB?: number };
  encoder?: "ok" | "stuck"; installStall?: boolean;
  /** The host's own warm device opt-in and bounds (`leaseWarmPool`). */
  warmPool?: { maxDevices: number; maxAgeSeconds: number };
  /** More lease images beside `lease-phone`. */
  templates?: RecordValue[];
  /** Every qemu-img invocation, as argv after the tool. */
  relocations?: string[][];
}

export interface Harness {
  url: string; admin: string; root: string; image: RecordValue; registry: string; events: string; counters: Map<string, number>; sdk: string; hostId(): string;
  /** Adds a template to the host's configuration; it takes effect when the runner restarts. */
  addTemplate(image: RecordValue, leased?: boolean): void;
  removeTemplate(id: string): void;
  provider(): AndroidProvider;
  runner(): HostRunner; restartRunner(): Promise<void>; stopRunner(): Promise<void>; stopController(): Promise<void>; startController(): Promise<void>;
  api(method: string, route: string, body?: unknown, token?: string): Promise<{ status: number; body: any }>;
  application(resources?: { cpu: number; memoryMiB: number; diskGiB: number }, templates?: RecordValue[]): Promise<string>;
  media: Media;
  storage(machineId: string): string;
  reserved(): Promise<RecordValue>;
}
export async function harness(t: TestContext, capacity = 1, options: HarnessOptions = {}): Promise<Harness> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "android-leases-")));
  const admin = randomBytes(32).toString("base64url"), enrollment = randomBytes(32).toString("base64url");
  writeFileSync(join(root, "admin"), admin, { mode: 0o600 }); writeFileSync(join(root, "enroll"), enrollment, { mode: 0o600 });
  const paths = { ...sdk(root), devices: join(root, "devices") }, counters = new Map<string, number>(), media: Media = { recorders: new Map(), installs: new Map(), commits: 0, encoders: 0, encodersOpen: 0 };
  const image: RecordValue = { id: "lease-phone", revision: "1", os: "android", arch, mode: "device", minimum: { cpu: 2, memoryMiB: 2048, diskGiB: 8 }, device: { systemImage, profile: "pixel_8" } };
  let controller: Awaited<ReturnType<typeof startController>> | undefined, port = 0, runner: HostRunner | undefined;
  const start = async () => {
    controller = await startController({ statePath: join(root, "controller.sqlite"), adminTokenFile: join(root, "admin"), enrollmentTokenFile: join(root, "enroll"), controllerId: "8a4d2f3e-5a7b-4c1d-9e2f-0123456789ab", listen: { host: "127.0.0.1", port } });
    port = controller.address.port;
  };
  await start();
  const url = `http://127.0.0.1:${port}`;
  const config: HostConfig = { url, stateDir: join(root, "runner"), enrollmentToken: enrollment, name: "android-lease-host", provider: "android", storage: join(root, "devices"),
    androidSDK: paths.sdk, templates: [image, ...(options.templates ?? [])], capacity: { cpu: 2 * capacity + (options.extra?.cpu ?? 0), memoryMiB: 2048 * capacity + (options.extra?.memoryMiB ?? 0), diskGiB: 8 * capacity + (options.extra?.diskGiB ?? 0) },
    pollIntervalSeconds: .25, concurrency: 4, videoEncoder: ENCODER,
    leaseClockHelper: helper, leaseSupervisor: helper, leaseProtocol: 1, leaseImages: [image, ...(options.templates ?? [])].map(entry => ({ id: entry.id, revision: entry.revision, arch, runtime: "android" })),
    ...(options.warmPool ? { leaseWarmPool: options.warmPool } : {}) };
  const launch = async () => {
    runner = new HostRunner(config, { providerFactory: (settings, state) => new AndroidProvider({ ...settings, transport: transport(paths, counters, options, media) }, state) });
    await runner.start();
  };
  await launch();
  t.after(async () => {
    await runner?.close().catch(() => {}); await controller?.close().catch(() => {});
    for (const e of readdirSync(paths.registry).map(n => JSON.parse(readFileSync(join(paths.registry, n), "utf8")) as Emulator)) for (const pid of [e.grandchild, e.pid]) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
    for (const file of readdirSync(join(root, "devices")).flatMap(id => { try { return [join(root, "devices", id, "lease-supervisor.json")]; } catch { return []; } }).filter(existsSync)) {
      try { process.kill(Number(JSON.parse(readFileSync(file, "utf8")).supervisorPid), "SIGKILL"); } catch { /* already gone */ }
    }
    // Stored baselines are read-only on disk; make their directories removable again.
    const writable = (dir: string): void => { if (!existsSync(dir)) return; chmodSync(dir, 0o700); for (const entry of readdirSync(dir, { withFileTypes: true })) if (entry.isDirectory()) writable(join(dir, entry.name)); };
    writable(join(root, "devices", "baselines"));
    rmSync(root, { recursive: true, force: true });
  });
  const api = async (method: string, route: string, body?: unknown, token = admin) => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as any };
  };
  return { url, admin, root, image, registry: paths.registry, events: paths.events, counters, api, media, sdk: paths.sdk,
    hostId: () => runner!.identity!.id,
    addTemplate(extra: RecordValue, leased = true) {
      (config.templates as RecordValue[]).push(extra);
      if (leased) (config.leaseImages as RecordValue[]).push({ id: extra.id, revision: extra.revision, arch, runtime: "android" });
    },
    removeTemplate(id: string) {
      config.templates = (config.templates as RecordValue[]).filter(entry => entry.id !== id);
      config.leaseImages = (config.leaseImages as RecordValue[]).filter(entry => entry.id !== id);
    },
    provider: () => runner!.runtimes.get("android") as unknown as AndroidProvider,
    runner: () => runner!,
    async restartRunner() { await runner!.close(); await launch(); },
    async stopRunner() { await runner!.close(); },
    async stopController() { await controller!.close(); },
    async startController() { await start(); },
    async application(resources = { cpu: 16, memoryMiB: 65536, diskGiB: 256 }, templates: RecordValue[] = [image, ...(options.templates ?? [])]) {
      const created = await api("POST", "/v1/consumers", { id: randomUUID(), name: "agents", templates: templates.map(entry => ({ id: entry.id, revision: entry.revision, arch })),
        limits: { resources, activeLeases: 4, defaultTTLSeconds: 60, maxTTLSeconds: 600, maxLifetimeSeconds: 600, provisioningTimeoutSeconds: 120 } });
      assert.equal(created.status, 200, JSON.stringify(created.body)); return created.body.credential as string;
    },
    storage: (machineId: string) => join(root, "devices", machineId),
    async reserved() { const hosts = (await api("GET", "/v1/hosts")).body.hosts as RecordValue[]; return hosts[0]!.reserved as RecordValue; },
  };
}
/** One agent: queue a request, wait for admission and a checked ready device, then mint its scoped key. */
export async function acquire(h: Harness, app: string, ttlSeconds: number, wait = true, templateId = String(h.image.id)): Promise<{ id: string; key: string; machineId: string }> {
  const id = randomUUID(), body = { id, kind: "lease", intent: { templateId, templateRevision: "1", arch, ttlSeconds } };
  const submitted = await h.api("POST", "/v1/requests", body, app);
  assert.equal(submitted.status, 201, JSON.stringify(submitted.body));
  const replay = await h.api("POST", "/v1/requests", body, app);
  assert.equal(replay.status, 200); assert.equal(replay.body.id, id);
  if (!wait) return { id, key: "", machineId: "" };
  return ready(h, app, id);
}
export async function ready(h: Harness, app: string, id: string): Promise<{ id: string; key: string; machineId: string }> {
  await until(async () => (await h.api("GET", `/v1/requests/${id}`, undefined, app)).body.state === "admitted", "admission");
  let lease: any;
  await until(async () => { lease = (await h.api("GET", `/v1/leases/${id}`, undefined, app)).body; return lease.state === "ready"; }, "a booted, checked emulator");
  assert.equal(lease.members[0].ready, true); assert.equal(lease.members[0].state, "running");
  const key = (await h.api("POST", `/v1/leases/${id}/credential`, {}, app)).body.credential as string;
  return { id, key, machineId: lease.members[0].machineId };
}
export async function operate(h: Harness, lease: string, key: string, action: string, args: RecordValue = {}, id = randomUUID()): Promise<{ status: number; body: any }> {
  const submitted = await h.api("POST", `/v1/leases/${lease}/operations`, { id, member: "primary", action, arguments: args }, key);
  if (submitted.status !== 201 && submitted.status !== 200) return submitted;
  let current = submitted;
  await until(async () => { current = await h.api("GET", `/v1/leases/${lease}/operations/${id}`, undefined, key); return current.status !== 200 || current.body.state !== "queued"; }, `${action} receipt`);
  return current;
}
/** Snapshots a receipt as soon as it appears; positive cleanup may remove it moments later. */
export function watchReceipt(t: TestContext, file: string): () => any {
  let value: any;
  const timer = setInterval(() => { if (value === undefined) try { value = JSON.parse(readFileSync(file, "utf8")); } catch { /* not yet written */ } }, 10);
  t.after(() => clearInterval(timer));
  return () => value;
}
export function supervised(h: Harness, machineId: string): { childPid: number; supervisorPid: number } {
  return JSON.parse(readFileSync(join(h.storage(machineId), "lease-supervisor.json"), "utf8"));
}
export async function cleaned(h: Harness, app: string, lease: string): Promise<void> {
  await until(async () => (await h.api("GET", `/v1/leases/${lease}`, undefined, app)).body.cleanup?.state === "complete", "positive cleanup", 30000);
}

