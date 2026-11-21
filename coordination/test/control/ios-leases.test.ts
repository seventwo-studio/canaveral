import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startController } from "../../src/main.ts";
import { HostRunner, hostOffer } from "../../src/host.ts";
import type { HostConfig } from "../../src/host.ts";
import { IosProvider, IOS_LEASE_ISOLATION } from "../../src/providers/ios.ts";
import { mobileNativeHelper, nativeContainerFiles, nativeLeaseSupervisor } from "../../src/providers/mobile-native.ts";
import type { CommandResult, LeaseSupervisorTransport, MobileTransport, RecordValue, RunOptions } from "../../src/providers/mobile.ts";
import { normalizeOperatorTemplate } from "../../src/control/templates.ts";
import { validateOffer } from "../../src/control/machines.ts";
import { ConsumerClient, LeaseClient } from "../../src/sdk.ts";

/** Disposable iOS simulator lease fixtures. A real loopback controller, a real HostRunner with
 * the native continuous lease clock and the real `lease-supervise` helper drive a stand-in
 * `simctl`. Its `boot` leaves a detached stand-in `launchd_sim` (with one child) that is not
 * the supervisor's child, as CoreSimulator does through launchd. idb and the control companion
 * are stand-ins too. No Xcode, CoreSimulator service or real simulator is touched, so nothing
 * here establishes native acceptance. */
const helper = mobileNativeHelper({});
const unix = ["darwin", "linux"].includes(process.platform);
const skip = !unix || !existsSync(helper) ? "requires the built canaveral-mobile-native helper" : false;
const arch = process.arch === "arm64" ? "arm64" : "amd64";
const DEVICE = { runtime: "com.apple.CoreSimulator.SimRuntime.iOS-27-0", deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-17" };
const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000" + "1f15c4890000000a49444154789c6300010000050001" + "0d0a2db40000000049454e44ae426082", "hex");
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; } };
const groupAlive = (pgid: number): boolean => { try { process.kill(-pgid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; } };
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean | Promise<boolean>, label: string, ms = 20000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (await check()) return; await sleep(50); }
  assert.fail(`Timed out waiting for ${label}`);
}

/** One simulator of the stand-in CoreSimulator: `set` is its device set ("default" for the
 * account's own set), `pid` its stand-in launchd_sim and `child` that process's child. */
interface Simulator { udid: string; name: string; set: string; runtime: string; deviceType: string; pid?: number; child?: number; bootedAt?: number; apps: string[] }
interface Paths { registry: string; companions: string; xcrun: string; companion: string }
function tools(root: string): Paths {
  const registry = join(root, "simulators"), companions = join(root, "companions");
  mkdirSync(registry); mkdirSync(companions);
  // The stand-in launchd_sim names its device's bootstrap path, as the real one does, keeps one
  // child that names nothing and records both. SIGTERM is a clean shutdown.
  const launchd = join(root, "fake-launchd-sim.mjs");
  writeFileSync(launchd, `import { spawn } from "node:child_process"; import { readFileSync, renameSync, writeFileSync } from "node:fs";
const file = process.argv[3], child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
// Published by rename: the stand-in simctl and the fixture read this record while it changes.
writeFileSync(file + ".tmp", JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), pid: process.pid, child: child.pid, bootedAt: Date.now() + 300 }));
renameSync(file + ".tmp", file);
process.on("SIGTERM", () => { child.kill("SIGKILL"); process.exit(0); });
setInterval(() => {}, 1000);\n`);
  // The supervisor runs this as \`xcrun simctl --set <set> boot|shutdown <udid>\`. Only a device of
  // exactly that set is touched. \`boot\` detaches the stand-in launchd_sim into its own session.
  const simctl = join(root, "fake-simctl.mjs");
  writeFileSync(simctl, `import { spawn } from "node:child_process"; import { existsSync, readFileSync } from "node:fs";
const [tool, flag, set, verb, udid] = process.argv.slice(2), file = ${JSON.stringify(registry)} + "/" + udid + ".json";
if (tool !== "simctl" || flag !== "--set" || !existsSync(file)) process.exit(64);
const read = () => JSON.parse(readFileSync(file, "utf8")), gone = pid => { try { process.kill(pid, 0); return false; } catch { return true; } };
const wait = async done => { for (let i = 0; i < 200 && !done(); i++) await new Promise(r => setTimeout(r, 25)); return done(); };
if (read().set !== set) process.exit(65);
if (verb === "boot") {
  if (existsSync(${JSON.stringify(join(root, "boot-fails"))})) process.exit(1);
  spawn(process.execPath, [${JSON.stringify(launchd)}, set + "/" + udid + "/data/var/run/launchd_bootstrap.plist", file], { detached: true, stdio: "ignore" }).unref();
  process.exit(await wait(() => typeof read().pid === "number") ? 0 : 1);
}
if (verb === "shutdown") {
  if (existsSync(${JSON.stringify(join(root, "shutdown-fails"))})) process.exit(1);
  const pid = read().pid;
  if (typeof pid === "number" && !gone(pid)) { process.kill(pid, "SIGTERM"); process.exit(await wait(() => gone(pid)) ? 0 : 1); }
  process.exit(0);
}
process.exit(64);\n`);
  const xcrun = join(root, "xcrun");
  writeFileSync(xcrun, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(simctl)} "$@"\n`, { mode: 0o755 });
  // The stand-in companion records the device set and socket it was started for, then serves.
  const companionScript = join(root, "fake-idb-companion.mjs");
  writeFileSync(companionScript, `import { renameSync, writeFileSync } from "node:fs";
const record = ${JSON.stringify(companions)} + "/" + process.pid;
writeFileSync(record + ".tmp", JSON.stringify({ pid: process.pid, args: process.argv.slice(2) }));
renameSync(record + ".tmp", record + ".json");
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1000);\n`);
  const companion = join(root, "idb_companion");
  writeFileSync(companion, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(companionScript)} "$@"\n`, { mode: 0o755 });
  return { registry, companions, xcrun, companion };
}
function simulators(registry: string): Simulator[] {
  return readdirSync(registry).filter(name => name.endsWith(".json")).map(name => JSON.parse(readFileSync(join(registry, name), "utf8")) as Simulator);
}
const booted = (s: Simulator): boolean => typeof s.pid === "number" && alive(s.pid);
function save(registry: string, s: Simulator): void {
  const file = join(registry, s.udid + ".json");
  writeFileSync(file + ".tmp", JSON.stringify(s)); renameSync(file + ".tmp", file);
}

interface Harness {
  url: string; admin: string; root: string; image: RecordValue; paths: Paths; calls: string[][];
  runner(): HostRunner; provider(): IosProvider; restartRunner(): Promise<void>; stopRunner(): Promise<void>;
  api(method: string, route: string, body?: unknown, token?: string): Promise<{ status: number; body: any }>;
  application(templates?: RecordValue[]): Promise<string>;
  storage(machineId: string): string;
  reserved(): Promise<RecordValue>;
  /** The simulator created for one leased machine, if any. */
  simulator(machineId: string): Simulator | undefined;
}
interface HarnessOptions { leases?: LeaseSupervisorTransport }
/** Stand-in simctl and idb. Every answer comes from the registry and the live stand-in processes.
 * A command without \`--set\` reaches only the account's default device set. */
function transport(paths: Paths, calls: string[][], options: HarnessOptions): MobileTransport {
  const ok = (stdout: string | Buffer): CommandResult => ({ stdout, exitCode: 0 }), failed: CommandResult = { stdout: "", exitCode: 1 };
  return {
    async run(argv: readonly string[], _options: RunOptions): Promise<CommandResult> {
      calls.push([...argv]);
      if (argv[0] === "/fixture/idb") {
        // idb reaches a leased simulator only through its own companion's socket.
        if (argv[1] !== "--companion") return failed;
        const companion = readdirSync(paths.companions).filter(name => name.endsWith(".json")).map(name => JSON.parse(readFileSync(join(paths.companions, name), "utf8")) as { pid: number; args: string[] })
          .find(c => alive(c.pid) && c.args[c.args.indexOf("--grpc-domain-sock") + 1] === argv[2]);
        const device = companion && simulators(paths.registry).find(s => s.udid === companion.args[companion.args.indexOf("--udid") + 1] && s.set === companion.args[companion.args.indexOf("--device-set-path") + 1]);
        if (!device) return failed;
        const args = argv.slice(3);
        if (args.join(" ") === "describe --json") return ok(JSON.stringify({ udid: device.udid, name: device.name, state: booted(device) ? "Booted" : "Shutdown", type: "simulator", screen_dimensions: { width: 1206, height: 2622, density: 3 } }));
        if (!booted(device)) return failed;
        if (args.join(" ") === "ui describe-all --json") return ok(JSON.stringify([{ AXLabel: "Continue", type: "Button", frame: { x: 10, y: 20, width: 100, height: 40 }, enabled: true }]));
        return args[0] === "ui" ? ok("") : failed;
      }
      assert.equal(argv[1], "simctl");
      const scoped = argv[2] === "--set", set = scoped ? argv[3]! : "default", args = argv.slice(scoped ? 4 : 2);
      const inSet = () => simulators(paths.registry).filter(s => s.set === set);
      if (args.join(" ") === "list runtimes --json") return ok(JSON.stringify({ runtimes: [{ identifier: DEVICE.runtime, isAvailable: true }] }));
      if (args.join(" ") === "list devicetypes --json") return ok(JSON.stringify({ devicetypes: [{ identifier: DEVICE.deviceType }] }));
      if (args.join(" ") === "list devices --json") {
        const devices: Record<string, unknown[]> = {};
        for (const s of inSet()) (devices[s.runtime] ??= []).push({ udid: s.udid, name: s.name, state: booted(s) ? "Booted" : "Shutdown", isAvailable: true, deviceTypeIdentifier: s.deviceType, dataPath: scoped ? join(s.set, s.udid, "data") : "/fixture/default/" + s.udid + "/data" });
        return ok(JSON.stringify({ devices }));
      }
      if (args[0] === "create") {
        const udid = randomUUID().toUpperCase();
        mkdirSync(join(set, udid, "data"), { recursive: true });
        save(paths.registry, { udid, name: args[1]!, set, deviceType: args[2]!, runtime: args[3]!, apps: [] });
        return ok(udid + "\n");
      }
      const verb = args[0] === "io" || args[0] === "spawn" ? args[0] : args[0]!, udid = args[1]!;
      const device = inSet().find(s => s.udid === udid);
      if (!device) return failed;
      if (verb === "delete") { if (booted(device)) return failed; rmSync(join(paths.registry, udid + ".json")); if (scoped) rmSync(join(set, udid), { recursive: true, force: true }); return ok(""); }
      if (!booted(device)) return failed;
      if (verb === "bootstatus") return Date.now() >= (device.bootedAt ?? Infinity) ? ok("Device already booted, nothing to do.") : failed;
      if (verb === "listapps") return ok(`{\n${device.apps.map(app => `    "${app}" = { CFBundleIdentifier = "${app}"; };`).join("\n")}\n    "com.apple.Preferences" = { ApplicationType = System; };\n}`);
      if (verb === "spawn") return ok(args[2] === "launchctl" ? "com.apple.SpringBoard = { state = running }" : "2026-11-21 10:00:00.000 Df fixture[1:1] launched");
      if (verb === "io") { writeFileSync(args.at(-1)!, PNG); return ok(""); }
      if (verb === "install") { const bundle = readFileSync(join(args[2]!, "Info.plist"), "utf8"); save(paths.registry, { ...device, apps: [...device.apps, /<string>([^<]+)<\/string>/.exec(bundle)![1]!] }); return ok(""); }
      if (verb === "uninstall") { save(paths.registry, { ...device, apps: device.apps.filter(app => app !== args[2]) }); return ok(""); }
      if (verb === "get_app_container") {
        if (!device.apps.includes(args[2]!)) return failed;
        const container = join(set, udid, "data", "Containers", "Data", "Application", args[2]!);
        mkdirSync(container, { recursive: true }); return ok(container + "\n");
      }
      if (["launch", "terminate", "openurl"].includes(verb)) return ok(`${args[2]}: 4242`);
      return failed;
    },
    async processAbsent(pid) { return !alive(pid); },
    async executableAvailable() { return true; },
    files: nativeContainerFiles(helper),
    leases: options.leases ?? nativeLeaseSupervisor,
  };
}
async function harness(t: TestContext, capacity = 1, options: HarnessOptions = {}): Promise<Harness> {
  // macOS limits a Unix socket path to 104 bytes, so the companion socket needs a short storage path.
  const root = realpathSync(mkdtempSync(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "ios-leases-")));
  const admin = randomBytes(32).toString("base64url"), enrollment = randomBytes(32).toString("base64url");
  writeFileSync(join(root, "admin"), admin, { mode: 0o600 }); writeFileSync(join(root, "enroll"), enrollment, { mode: 0o600 });
  const paths = tools(root), calls: string[][] = [];
  // A simulator in the account's default device set. No lease may read, change or delete it.
  save(paths.registry, { udid: "0F1E2D3C-4B5A-4978-8695-A4B3C2D1E0F9", name: "Personal iPhone", set: "default", ...DEVICE, apps: [] });
  const image: RecordValue = { id: "lease-iphone", revision: "1", os: "ios", arch, mode: "device", minimum: { cpu: 2, memoryMiB: 2048, diskGiB: 8 }, device: DEVICE };
  const controller = await startController({ statePath: join(root, "controller.sqlite"), adminTokenFile: join(root, "admin"), enrollmentTokenFile: join(root, "enroll"), controllerId: "8a4d2f3e-5a7b-4c1d-9e2f-0123456789ab", listen: { host: "127.0.0.1", port: 0 } });
  const url = `http://127.0.0.1:${controller.address.port}`;
  const config: HostConfig = { url, stateDir: join(root, "runner"), enrollmentToken: enrollment, name: "ios-lease-host", provider: "ios", storage: join(root, "d"),
    xcrun: paths.xcrun, idb: "/fixture/idb", idbCompanion: paths.companion, templates: [image],
    capacity: { cpu: 2 * capacity, memoryMiB: 2048 * capacity, diskGiB: 8 * capacity + 8 }, pollIntervalSeconds: .25, concurrency: 4,
    leaseClockHelper: helper, leaseSupervisor: helper, leaseProtocol: 1, leaseImages: [{ id: image.id, revision: "1", arch, runtime: "ios", isolation: IOS_LEASE_ISOLATION }] };
  let runner: HostRunner | undefined, provider: IosProvider | undefined;
  const launch = async () => {
    // The lease gate judges macOS; a portable fixture injects the platform in code only.
    runner = new HostRunner(config, { platform: "darwin", providerFactory: (settings, state) => (provider = new IosProvider({ ...settings, hostPlatform: "darwin", hostArch: arch, transport: transport(paths, calls, options) }, state)) });
    await runner.start();
  };
  await launch();
  t.after(async () => {
    await runner?.close().catch(() => {}); await controller.close().catch(() => {});
    const stray = [...simulators(paths.registry).flatMap(s => [s.child, s.pid]), ...readdirSync(paths.companions).map(name => Number(name.replace(/\.(json|tmp)$/, "")))];
    for (const dir of existsSync(join(root, "d")) ? readdirSync(join(root, "d")) : []) { try { stray.push(Number(JSON.parse(readFileSync(join(root, "d", dir, "lease-supervisor.json"), "utf8")).supervisorPid)); } catch { /* no supervisor record */ } }
    for (const pid of stray) if (typeof pid === "number" && pid > 1) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
    rmSync(root, { recursive: true, force: true });
  });
  const api = async (method: string, route: string, body?: unknown, token = admin) => {
    const response = await fetch(`${url}${route}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as any };
  };
  return { url, admin, root, image, paths, calls, api,
    runner: () => runner!, provider: () => provider!,
    async restartRunner() { await runner!.close(); await launch(); },
    async stopRunner() { await runner!.close(); },
    async application(templates = [{ id: image.id, revision: "1", arch }]) {
      const created = await api("POST", "/v1/consumers", { id: randomUUID(), name: "agents", templates,
        limits: { resources: { cpu: 16, memoryMiB: 65536, diskGiB: 256 }, activeLeases: 4, defaultTTLSeconds: 60, maxTTLSeconds: 600, maxLifetimeSeconds: 600, provisioningTimeoutSeconds: 120 } });
      assert.equal(created.status, 200, JSON.stringify(created.body)); return created.body.credential as string;
    },
    storage: (machineId: string) => join(root, "d", machineId),
    async reserved() { const hosts = (await api("GET", "/v1/hosts")).body.hosts as RecordValue[]; return hosts[0]!.reserved as RecordValue; },
    simulator: (machineId: string) => simulators(paths.registry).find(s => s.name === `cvm-${machineId}`),
  };
}
type Leased = { id: string; key: string; machineId: string };
/** What the runner and supervisor left on disk for one machine, for a failed fixture run. */
function evidence(h: Harness, machineId: string | undefined): RecordValue {
  if (!machineId || !existsSync(h.storage(machineId))) return { machine: (h.runner() as any).reports?.get(machineId ?? "") ?? null };
  const dir = h.storage(machineId), read = (name: string) => { try { return readFileSync(join(dir, name), "utf8").slice(-2000); } catch { return undefined; } };
  return { report: (h.runner() as any).reports?.get(machineId) ?? null, files: readdirSync(dir), launch: read("launch.json"), supervisor: read("lease-supervisor.json"), stopped: read("lease-stopped.json"), fenced: read("lease-fenced.json"), simulator: read("simulator.log"), companion: read("companion.log") };
}
/** One agent: queue a request, wait for admission and a checked ready simulator, then mint its scoped key. */
async function acquire(h: Harness, app: string, ttlSeconds: number, wait = true): Promise<Leased> {
  const id = randomUUID(), body = { id, kind: "lease", intent: { templateId: h.image.id, templateRevision: "1", arch, ttlSeconds } };
  const submitted = await h.api("POST", "/v1/requests", body, app);
  assert.equal(submitted.status, 201, JSON.stringify(submitted.body));
  const replay = await h.api("POST", "/v1/requests", body, app);
  assert.equal(replay.status, 200); assert.equal(replay.body.id, id);
  return wait ? ready(h, app, id) : { id, key: "", machineId: "" };
}
async function ready(h: Harness, app: string, id: string): Promise<Leased> {
  await until(async () => (await h.api("GET", `/v1/requests/${id}`, undefined, app)).body.state === "admitted", "admission");
  let lease: any;
  try { await until(async () => { lease = (await h.api("GET", `/v1/leases/${id}`, undefined, app)).body; return lease.state === "ready" || !["provisioning", "ready"].includes(lease.state); }, "a booted, checked simulator", 40000); }
  finally { if (lease?.state !== "ready") console.error("lease never became ready:", JSON.stringify(lease), JSON.stringify(evidence(h, lease?.members?.[0]?.machineId))); }
  assert.equal(lease.state, "ready");
  assert.equal(lease.members[0].ready, true); assert.equal(lease.members[0].state, "running");
  const key = (await h.api("POST", `/v1/leases/${id}/credential`, {}, app)).body.credential as string;
  return { id, key, machineId: lease.members[0].machineId };
}
function client(h: Harness, lease: Leased): LeaseClient {
  return new LeaseClient({ baseUrl: h.url, leaseId: lease.id, leaseKey: lease.key, allowLoopbackHttp: true, timeoutMs: 20000 });
}
/** Submits one lease-key operation through the SDK and waits for its receipt. */
async function operate(h: Harness, lease: Leased, action: string, args: RecordValue = {}, id = randomUUID()): Promise<any> {
  const sdk = client(h, lease);
  await sdk.createOperation({ id, member: "primary", action, arguments: args });
  let current: any;
  await until(async () => { current = await sdk.operation(id); return current.state !== "queued"; }, `${action} receipt`, 30000);
  return current;
}
const refusedStatus = async (h: Harness, leaseId: string, token: string, action = "tap", args: RecordValue = { x: 1, y: 1 }): Promise<{ status: number; body: any }> =>
  h.api("POST", `/v1/leases/${leaseId}/operations`, { id: randomUUID(), member: "primary", action, arguments: args }, token);
function supervised(h: Harness, machineId: string): { childPid: number; supervisorPid: number; simulator: { deviceSet: string; udid: string } } {
  return JSON.parse(readFileSync(join(h.storage(machineId), "lease-supervisor.json"), "utf8"));
}
/** Snapshots a receipt as soon as it appears; positive cleanup may remove it moments later. */
function watchReceipt(t: TestContext, file: string): () => any {
  let value: any;
  const timer = setInterval(() => { if (value === undefined) try { value = JSON.parse(readFileSync(file, "utf8")); } catch { /* not yet written */ } }, 10);
  t.after(() => clearInterval(timer));
  return () => value;
}
async function cleaned(h: Harness, app: string, lease: string): Promise<void> {
  await until(async () => (await h.api("GET", `/v1/leases/${lease}`, undefined, app)).body.cleanup?.state === "complete", "positive cleanup", 40000);
}
/** No command ever reached the account's default device set, and its simulator is untouched. */
function defaultSetUntouched(h: Harness): void {
  const outside = h.calls.filter(argv => argv[1] === "simctl" && argv[2] !== "--set" && !["list runtimes --json", "list devicetypes --json"].includes(argv.slice(2).join(" ")));
  assert.deepEqual(outside, [], "every leased simctl call named its own device set");
  assert.ok(h.calls.filter(argv => argv[0] === "/fixture/idb").every(argv => argv[1] === "--companion" && !argv.includes("--udid")), "every leased idb call used its own companion");
  assert.deepEqual(simulators(h.paths.registry).filter(s => s.set === "default").map(s => s.name), ["Personal iPhone"]);
}
// An iOS Simulator app as an uncompressed POSIX ustar archive, as the upload contract requires.
function tar(entries: { name: string; data?: Buffer | string; kind?: number; mode?: number }[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    const header = Buffer.alloc(512), data = Buffer.from(entry.data ?? "");
    header.write(entry.name, 0, 100); header.write((entry.mode ?? 0o755).toString(8).padStart(7, "0"), 100);
    header.write("0000000", 108); header.write("0000000", 116); header.write(data.length.toString(8).padStart(11, "0"), 124); header.write("00000000000", 136);
    header.fill(32, 148, 156); header[156] = entry.kind ?? 48; header.write("ustar\0", 257); header.write("00", 263);
    const checksum = header.reduce((sum, byte) => sum + byte, 0); header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148);
    parts.push(header, data, Buffer.alloc((512 - data.length % 512) % 512));
  }
  return Buffer.concat([...parts, Buffer.alloc(1024)]);
}
function appArchive(h: Harness, bundle: string): { file: string; payload: Buffer; sha256: string } {
  const payload = tar([{ name: "Trial.app/", kind: 53 }, { name: "Trial.app/Info.plist", data: `<plist><string>${bundle}</string></plist>`, mode: 0o644 },
    { name: "Trial.app/Trial", data: "executable" }, { name: "Trial.app/Assets.car", data: randomBytes(700_000), mode: 0o644 }]);
  const file = join(h.root, `Trial-${randomUUID()}.app.tar`);
  writeFileSync(file, payload, { mode: 0o600 });
  return { file, payload, sha256: createHash("sha256").update(payload).digest("hex") };
}

test("iOS leases are refused without the explicit shared-host declaration, off macOS or without the supervisor and companion", () => {
  const image = { id: "iphone", revision: "1", os: "ios", arch, mode: "device", minimum: { cpu: 1, memoryMiB: 1024, diskGiB: 4 }, device: DEVICE };
  const base = { name: "h", provider: "ios", capacity: { cpu: 2, memoryMiB: 2048, diskGiB: 8 }, templates: [image], leaseClockHelper: "/opt/helper", leaseSupervisor: "/opt/helper", idbCompanion: "/opt/idb_companion", leaseProtocol: 1 };
  const selector = { id: "iphone", revision: "1", arch, runtime: "ios" }, declared = { ...selector, isolation: "shared-host" };
  assert.deepEqual(hostOffer({ ...base, leaseImages: [declared] }, "darwin").leaseImages, [declared]);
  // The declaration has no default: a selector without it, or with any other class, is refused whatever else is configured.
  for (const leaseImages of [[selector], [{ ...selector, isolation: "isolated" }], [{ ...selector, isolation: true }], [{ ...declared, extra: 1 }]])
    assert.throws(() => hostOffer({ ...base, leaseImages }, "darwin"), /cannot advertise lease execution for an iOS simulator without the explicit shared-host isolation declaration/);
  // Nothing outside the lease image itself supplies it: not a host-level key, and not the environment.
  process.env.CANAVERAL_IOS_LEASE_ISOLATION = "shared-host";
  try { assert.throws(() => hostOffer({ ...base, isolation: "shared-host", leaseIsolation: "shared-host", leaseImages: [selector] }, "darwin"), /without the explicit shared-host isolation declaration/); }
  finally { delete process.env.CANAVERAL_IOS_LEASE_ISOLATION; }
  // macOS only, with the native clock, the native supervisor and an absolute companion.
  for (const platform of ["linux", "win32"] as const) assert.throws(() => hostOffer({ ...base, leaseImages: [declared] }, platform), /cannot advertise lease execution/);
  for (const change of [{ leaseSupervisor: undefined }, { leaseSupervisor: "relative" }, { idbCompanion: undefined }, { idbCompanion: "idb_companion" }, { leaseClockHelper: undefined }, { xcrun: "xcrun" }])
    assert.throws(() => hostOffer({ ...base, ...change, leaseImages: [declared] }, "darwin"), /cannot advertise lease execution/);
  assert.throws(() => hostOffer({ ...base, leaseImages: [{ ...declared, id: "other" }] }, "darwin"), /offered iOS templates/);
  // A physical Mac host declares it the same way, per image, beside its Android selectors.
  const phone = { id: "pixel", revision: "1", os: "android", arch, mode: "device", minimum: { cpu: 1, memoryMiB: 1024, diskGiB: 4 }, device: { systemImage: `system-images;android-35;google_apis;${arch === "arm64" ? "arm64-v8a" : "x86_64"}`, profile: "pixel_8" } };
  const mac = { name: "mac", provider: "macos", capacity: base.capacity, storage: "/ABS/devices", templates: [image, phone], leaseClockHelper: "/opt/helper", leaseProtocol: 1,
    runtimes: { ios: { leaseSupervisor: "/opt/helper", idbCompanion: "/opt/idb_companion" }, android: { androidSDK: "/ABS/sdk", leaseSupervisor: "/opt/helper" } } };
  const android = { id: "pixel", revision: "1", arch, runtime: "android" };
  assert.deepEqual(hostOffer({ ...mac, leaseImages: [declared, android] }, "darwin").leaseImages, [declared, android]);
  assert.throws(() => hostOffer({ ...mac, leaseImages: [selector, android] }, "darwin"), /shared-host isolation declaration/);
  // The class belongs to iOS alone: an Android selector that names one is refused, as before.
  assert.throws(() => hostOffer({ ...mac, leaseImages: [{ ...android, isolation: "shared-host" }] }, "darwin"), /cannot advertise lease execution/);
  // The controller applies the same gate to the offer a runner reports.
  const offer = { name: "h", provider: "ios", capacity: base.capacity, templates: [normalizeOperatorTemplate(image)], leaseProtocol: 1 };
  assert.deepEqual(validateOffer({ ...offer, leaseImages: [declared] }).leaseImages, [declared]);
  for (const leaseImages of [[selector], [{ ...selector, isolation: "none" }]]) assert.throws(() => validateOffer({ ...offer, leaseImages }), /must declare the shared-host isolation class/);
});

test("the host refuses leased execution for an iOS template whose selector it did not advertise, and stops it instead", { skip, timeout: 30000 }, async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ios-lease-gate-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const leased = { id: "lease-iphone", revision: "1", os: "ios", arch, mode: "device", minimum: { cpu: 1, memoryMiB: 1024, diskGiB: 4 }, device: DEVICE }, other = { ...leased, id: "plain-iphone" };
  const calls: RecordValue[] = [];
  const runtime = { kind: "ios", reconcile: async (machine: RecordValue) => { calls.push(machine); return { state: machine.desired === "running" ? "starting" : "stopped" }; }, refreshExecution: async () => null, check: async () => ({ ready: true }) };
  const settings = { url: "http://127.0.0.1:9", stateDir: join(root, "runner"), name: "gate", provider: "ios", storage: join(root, "devices"), templates: [leased, other], capacity: { cpu: 2, memoryMiB: 2048, diskGiB: 8 },
    leaseClockHelper: helper, leaseSupervisor: helper, idbCompanion: "/opt/idb_companion", leaseProtocol: 1, leaseImages: [{ id: leased.id, revision: "1", arch, runtime: "ios", isolation: IOS_LEASE_ISOLATION }] };
  // Constructing the runner on any other operating system is refused outright.
  assert.throws(() => new HostRunner({ ...settings, stateDir: join(root, "elsewhere") }, { platform: "linux", providerFactory: () => runtime as any }), /cannot advertise lease execution/);
  const runner = new HostRunner(settings, { platform: "darwin", providerFactory: () => runtime as any });
  await runner.initializeProviders();
  const now = (runner as any).clock.wall() as number;
  const machine = (image: RecordValue): RecordValue => ({ id: randomUUID(), templateId: image.id, template: normalizeOperatorTemplate(image), desired: "running",
    resources: { cpu: 1, memoryMiB: 1024, diskGiB: 4 }, lease: { id: randomUUID(), state: "ready", revision: 1, authorizationDeadline: now + 600, controllerNow: now } });
  const eligible = machine(leased), unlisted = machine(other);
  runner.guard.observe([eligible, unlisted], 0);
  assert.equal(runner.leaseEligible(eligible), true);
  assert.equal((await runner.reconcile(eligible)).state, "starting");
  assert.equal(runner.leaseEligible(unlisted), false);
  const refused = await runner.reconcile(unlisted);
  assert.equal(refused.state, "error"); assert.match(String(refused.detail), /does not offer leased execution/);
  assert.equal(calls.at(-1)!.desired, "stopped"); assert.equal(calls.at(-1)!.id, unlisted.id);
  // An advertised entry that lost its declaration no longer counts, whatever the controller asks.
  (runner.offer.leaseImages as RecordValue[])[0] = { id: leased.id, revision: "1", arch, runtime: "ios" };
  assert.equal(runner.leaseEligible(eligible), false);
  assert.equal((await runner.reconcile(eligible)).state, "error");
  await runner.close();
});

test("two agents share a one-simulator host: allowlist, shared-host class, queue then admit, lease-key control and install, scoped keys, release, expiry in use, proven removal", { skip, timeout: 240000 }, async t => {
  const h = await harness(t), app = await h.application(), sdk = new ConsumerClient({ baseUrl: h.url, applicationKey: app, allowLoopbackHttp: true });
  // The isolation class is in the consumer's catalogue and in the host's own offer for the operator.
  // The class is stated whether or not a host is available yet; availability follows the host's health check.
  assert.deepEqual((await sdk.catalogue()).templates.map(t => [t.id, t.os, t.isolation]), [["lease-iphone", "ios", "shared-host"]]);
  await until(async () => (await sdk.catalogue()).templates[0]!.available, "a healthy lease-capable host");
  const catalogue = await sdk.catalogue();
  assert.deepEqual([catalogue.templates[0]!.capabilities.command, catalogue.templates[0]!.capabilities.pty, catalogue.templates[0]!.capabilities.files], [false, false, true]);
  assert.deepEqual((await h.api("GET", "/v1/hosts")).body.hosts[0].leaseImages, [{ id: "lease-iphone", revision: "1", arch, runtime: "ios", isolation: "shared-host" }]);
  // An application whose immutable policy does not allowlist the template cannot lease it, directly or queued.
  const outsider = await h.application([]);
  const direct = await h.api("POST", "/v1/leases", { id: randomUUID(), templateId: h.image.id, templateRevision: "1", arch, ttlSeconds: 30 }, outsider);
  assert.equal(direct.status, 403, JSON.stringify(direct.body));
  const queued = randomUUID();
  assert.equal((await h.api("POST", "/v1/requests", { id: queued, kind: "lease", intent: { templateId: h.image.id, templateRevision: "1", arch, ttlSeconds: 30 } }, outsider)).status, 201);
  await until(async () => (await h.api("GET", `/v1/requests/${queued}`, undefined, outsider)).body.state === "rejected", "rejection of the unlisted application");
  assert.equal(simulators(h.paths.registry).filter(s => s.set !== "default").length, 0, "nothing was created for a refused application");

  const a = await acquire(h, app, 300), lease = client(h, a), storage = h.storage(a.machineId);
  // Agent B queues at once: the host is full, so it waits behind A for the rest of A's lease.
  const b = await acquire(h, app, 20, false);
  // One simulator, created for this lease, in its own private device set inside its own storage.
  const device = h.simulator(a.machineId)!, record = supervised(h, a.machineId), set = join(storage, "device-set");
  assert.equal(device.set, set); assert.deepEqual(record.simulator, { deviceSet: set, udid: device.udid });
  assert.deepEqual(simulators(h.paths.registry).filter(s => s.set === set).map(s => s.udid), [device.udid]);
  assert.ok(booted(device) && alive(device.child!) && groupAlive(record.childPid));
  // Ready only after boot finished and the install, launch and control services answered. No network probe exists for this class.
  const readiness = JSON.parse(readFileSync(join(storage, "lease-ready.json"), "utf8"));
  assert.deepEqual([readiness.isolation, readiness.networkIsolation, readiness.udid], ["shared-host", "not-probed", device.udid]);
  assert.deepEqual(readiness.checks, ["booted", "owned", "boot-finished", "install-service", "launch-service", "control-companion"]);
  for (const probe of ["bootstatus", "listapps", "spawn"]) assert.ok(h.calls.some(argv => argv[2] === "--set" && argv[3] === set && argv[4] === probe), `readiness ran ${probe}`);
  assert.ok(!h.calls.some(argv => argv.includes("-b")), "the runner never boots a leased simulator itself");
  const companion = JSON.parse(readFileSync(join(h.paths.companions, `${record.childPid}.json`), "utf8")).args as string[];
  assert.deepEqual(companion.slice(0, 6), ["--udid", device.udid, "--device-set-path", set, "--grpc-domain-sock", join(storage, "idb.sock")]);
  // The lease view states the class to its consumer; the operator's lease list states it too.
  const view = await lease.inspect();
  assert.equal(view.isolation, "shared-host"); assert.equal(view.members[0]!.isolation, "shared-host");
  assert.equal((await h.api("GET", "/v1/admin/system")).body.leases.find((l: any) => l.id === a.id).isolation, "shared-host");

  // Lease-key control through the SDK: screens, input, hierarchy.
  const shot = await operate(h, a, "screenshot");
  assert.equal(shot.state, "succeeded"); assert.equal(Buffer.from(shot.result.data, "base64").subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.equal((await operate(h, a, "tap", { x: 10, y: 20 })).state, "succeeded");
  assert.equal((await operate(h, a, "swipe", { x: 1, y: 2, toX: 3, toY: 4, durationMs: 100 })).state, "succeeded");
  assert.equal((await operate(h, a, "text", { text: "hello" })).state, "succeeded");
  assert.equal((await operate(h, a, "key", { key: "HOME" })).state, "succeeded");
  assert.match((await operate(h, a, "hierarchy")).result.output, /Continue/);
  assert.equal((await operate(h, a, "accessibility")).state, "succeeded");
  assert.ok(h.calls.some(argv => argv.join(" ") === `/fixture/idb --companion ${join(storage, "idb.sock")} ui tap 10 20`));
  // The simulator `.app` archive goes through the lease app-artifact path: chunked, digest-checked, installed once.
  const build = appArchive(h, "test.canaveral.trial"), artifact = randomUUID();
  const uploaded = await lease.uploadApp({ id: artifact, member: "primary", file: build.file, format: "ios-app-tar" });
  assert.deepEqual([uploaded.state, uploaded.format, uploaded.bytes, uploaded.sha256, uploaded.leaseId], ["ready", "ios-app-tar", build.payload.length, build.sha256, a.id]);
  assert.ok(build.payload.length > 524288, "more than one chunk");
  assert.equal((await h.api("POST", `/v1/leases/${a.id}/app-artifacts`, { id: randomUUID(), member: "primary", format: "apk", bytes: 4096, sha256: build.sha256 }, a.key)).status, 400, "an iOS member takes no APK");
  const install = randomUUID();
  assert.equal((await lease.installApp({ id: install, member: "primary", artifact })).created, true);
  let installed: any;
  await until(async () => { installed = await lease.operation(install); return installed.state !== "queued"; }, "install receipt", 30000);
  assert.equal(installed.state, "succeeded", JSON.stringify(installed));
  assert.deepEqual(installed.result, { installed: true, sha256: build.sha256, bytes: build.payload.length, artifactCleaned: true });
  assert.deepEqual(h.simulator(a.machineId)!.apps, ["test.canaveral.trial"]);
  assert.equal(readdirSync(storage).filter(name => name.startsWith(".artifact-")).length, 0, "the private stage was removed");
  const replay = await lease.installApp({ id: install, member: "primary", artifact });
  assert.equal(replay.created, false); assert.equal(replay.operation.state, "succeeded");
  await sleep(500); assert.equal(h.calls.filter(argv => argv[4] === "install").length, 1, "a replayed install never runs again");
  // App lifecycle, logs and app-container files, with no shell.
  assert.match((await operate(h, a, "apps")).result.output, /test\.canaveral\.trial/);
  for (const [action, args] of [["launch", { app: "test.canaveral.trial" }], ["open-url", { url: "trial://screen/2" }], ["terminate", { app: "test.canaveral.trial" }], ["logs", {}]] as const)
    assert.equal((await operate(h, a, action, args)).state, "succeeded", action);
  assert.equal((await operate(h, a, "push", { path: "Documents.txt", app: "test.canaveral.trial", data: Buffer.from("lease data").toString("base64") })).state, "succeeded");
  assert.equal(Buffer.from((await operate(h, a, "pull", { path: "Documents.txt", app: "test.canaveral.trial" })).result.data, "base64").toString(), "lease data");
  assert.deepEqual((await operate(h, a, "list-files", { path: ".", app: "test.canaveral.trial" })).result.entries, [{ name: "Documents.txt", kind: "file" }]);
  assert.equal(readFileSync(join(set, device.udid, "data", "Containers", "Data", "Application", "test.canaveral.trial", "Documents.txt"), "utf8"), "lease data");
  assert.equal((await operate(h, a, "uninstall", { app: "test.canaveral.trial" })).state, "succeeded");
  assert.deepEqual(h.simulator(a.machineId)!.apps, []);
  // iOS has no shell, the host-artifact install and device settings stay administrative, and recording stays refused.
  for (const [action, args] of [["shell", { argv: ["id"] }], ["shell-open", { session: randomUUID() }], ["install", { artifact: "development" }], ["permission", { app: "a.b", permission: "photos", state: "grant" }], ["location", { latitude: 1, longitude: 2 }]] as const) {
    const refused = await refusedStatus(h, a.id, a.key, action, args);
    assert.deepEqual([refused.status, refused.body.code], [409, "capability_unsupported"], action);
  }
  const video = await h.api("POST", `/v1/leases/${a.id}/video-sessions`, { id: randomUUID(), member: "primary", fps: 30, durationSeconds: 2, bitRate: 4_000_000 }, a.key);
  assert.deepEqual([video.status, video.body.code], [409, "capability_unsupported"]);
  // Operations are durable: the same UUID replays its receipt, a changed body conflicts.
  const tap = randomUUID();
  assert.equal((await operate(h, a, "tap", { x: 7, y: 8 }, tap)).state, "succeeded");
  assert.equal((await h.api("POST", `/v1/leases/${a.id}/operations`, { id: tap, member: "primary", action: "tap", arguments: { x: 7, y: 8 } }, a.key)).body.state, "succeeded");
  assert.equal((await h.api("POST", `/v1/leases/${a.id}/operations`, { id: tap, member: "primary", action: "tap", arguments: { x: 9, y: 9 } }, a.key)).status, 409);
  assert.equal(h.calls.filter(argv => argv.slice(3).join(" ") === "ui tap 7 8").length, 1);

  // B is still waiting while the host is full; nothing was created or reserved for it.
  assert.equal((await h.api("GET", `/v1/requests/${b.id}`, undefined, app)).body.state, "waiting");
  assert.deepEqual(await h.reserved(), { cpu: 2, memoryMiB: 2048, diskGiB: 8 + 2 }, "A's simulator and its upload's host scratch only");
  assert.equal(simulators(h.paths.registry).filter(s => s.set !== "default").length, 1);
  // Lease-key routes accept only this lease's current key: not the application, the operator or an unknown key.
  for (const token of [app, h.admin, randomBytes(32).toString("base64url")]) {
    assert.equal((await refusedStatus(h, a.id, token)).status, 401);
    assert.equal((await h.api("GET", `/v1/leases/${a.id}/operations/${tap}`, undefined, token)).status, 401);
    assert.equal((await h.api("POST", `/v1/leases/${a.id}/app-artifacts`, { id: randomUUID(), member: "primary", format: "ios-app-tar", bytes: build.payload.length, sha256: build.sha256 }, token)).status, 401);
    assert.equal((await h.api("GET", `/v1/leases/${a.id}/app-artifacts/${artifact}`, undefined, token)).status, 401);
  }
  // The administrative machine routes refuse a leased simulator.
  assert.equal((await h.api("POST", `/v1/machines/${a.machineId}/app-artifacts`, { id: randomUUID(), format: "ios-app-tar", bytes: build.payload.length, sha256: build.sha256 }, h.admin)).status, 409);

  // A releases. Its key is refused at once, the supervisor stops the companion's group and
  // shuts the simulator down, then proves the device set's tree gone.
  const receipt = watchReceipt(t, join(storage, "lease-stopped.json"));
  assert.equal((await lease.release({ id: randomUUID() })).lease.state, "released");
  assert.equal((await refusedStatus(h, a.id, a.key)).status, 410);
  await until(() => !booted(device) && !alive(device.child!) && !groupAlive(record.childPid), "supervised stop");
  await until(() => receipt() !== undefined, "stop receipt"); const stopped = receipt();
  assert.deepEqual([stopped.reason, stopped.groupAbsent, stopped.treeAbsent, stopped.treeForced, stopped.shutdownStatus], ["fenced", true, true, false, 0]);
  assert.deepEqual(stopped.simulator, { deviceSet: set, udid: device.udid });
  // Cleanup deletes the simulator through CoreSimulator, then removes the storage and credentials.
  await cleaned(h, app, a.id);
  assert.ok(h.calls.some(argv => argv.slice(2).join(" ") === `--set ${set} delete ${device.udid}`));
  assert.equal(existsSync(storage), false); assert.equal(h.simulator(a.machineId), undefined);
  // A's ended key still reads its own terminal lease, as the lease contract allows, and nothing else.
  assert.equal((await lease.inspect()).cleanup.state, "complete");

  // B is admitted to a distinct, freshly created simulator in its own device set; A's key cannot reach it.
  const second = await ready(h, app, b.id), other = h.simulator(second.machineId)!, otherRecord = supervised(h, second.machineId);
  assert.notEqual(second.machineId, a.machineId); assert.notEqual(other.udid, device.udid);
  assert.equal(other.set, join(h.storage(second.machineId), "device-set")); assert.deepEqual(other.apps, [], "nothing of A's install reached B's simulator");
  assert.equal((await operate(h, second, "tap", { x: 3, y: 4 })).state, "succeeded");
  assert.equal((await refusedStatus(h, b.id, a.key)).status, 401);
  // B keeps sending input until its 20-second lease expires; nothing renews it.
  const expiry = watchReceipt(t, join(h.storage(second.machineId), "lease-stopped.json"));
  let ended: { status: number; body: any } | undefined;
  await until(async () => {
    const submitted = await refusedStatus(h, b.id, second.key, "tap", { x: 5, y: 5 });
    if (submitted.status === 201) { await sleep(300); return false; }
    ended = submitted; return true;
  }, "expiry while in use", 60000);
  // The host fences conservatively, slightly before the controller's expiry (409 member_not_ready meanwhile).
  assert.ok([409, 410].includes(ended!.status), JSON.stringify(ended));
  // A fence report that lands first ends the lease as failed rather than expired; both are terminal.
  await until(async () => ["expired", "failed"].includes((await h.api("GET", `/v1/leases/${b.id}`, undefined, app)).body.state), "terminal lease");
  assert.equal((await refusedStatus(h, b.id, second.key)).status, 410);
  // Expiry stops the simulator and removes it on the same proof.
  await until(() => !booted(other) && !alive(other.child!) && !groupAlive(otherRecord.childPid), "expiry stops the simulator");
  await until(() => expiry() !== undefined, "expiry stop receipt");
  assert.deepEqual([expiry().groupAbsent, expiry().treeAbsent, expiry().simulator.udid], [true, true, other.udid]);
  await cleaned(h, app, b.id);
  assert.equal(existsSync(h.storage(second.machineId)), false); assert.equal(h.simulator(second.machineId), undefined);
  assert.deepEqual(await h.reserved(), { cpu: 0, memoryMiB: 0, diskGiB: 0 });
  defaultSetUntouched(h);
});

test("a lease key reaches only its own simulator; renewal extends the native deadline; a runner restart recovers the live simulator without relaunch", { skip, timeout: 180000 }, async t => {
  const h = await harness(t, 2), app = await h.application(), admitted = Date.now();
  const [a, b] = await Promise.all([acquire(h, app, 20), acquire(h, app, 120)]);
  // Renewal publishes a newer revision and a later native deadline before the original expires.
  const authorization = () => JSON.parse(readFileSync(join(h.storage(a.machineId), "lease-authorization.json"), "utf8"));
  const original = authorization(), current = await client(h, a).inspect();
  const renewed = await client(h, a).renew({ id: randomUUID(), expectedRevision: current.revision, ttlSeconds: 120 });
  assert.equal(renewed.lease.state, "ready");
  await until(() => { const now = authorization(); return now.revision > original.revision && now.deadline > original.deadline + 60 && now.fenced === false; }, "renewed native deadline");
  const mine = h.simulator(a.machineId)!, theirs = h.simulator(b.machineId)!, group = supervised(h, a.machineId);
  assert.notEqual(mine.udid, theirs.udid); assert.notEqual(mine.set, theirs.set);
  // Another lease's key is refused on every lease-key route, in both directions.
  for (const [lease, key] of [[a, b.key], [b, a.key]] as const) {
    assert.equal((await refusedStatus(h, lease.id, key)).status, 401);
    assert.equal((await h.api("GET", `/v1/leases/${lease.id}`, undefined, key)).status, 401);
    assert.equal((await h.api("POST", `/v1/leases/${lease.id}/app-artifacts`, { id: randomUUID(), member: "primary", format: "ios-app-tar", bytes: 4096, sha256: "0".repeat(64) }, key)).status, 401);
  }
  assert.equal((await h.api("POST", `/v1/leases/${a.id}/operations`, { id: randomUUID(), member: "other", action: "tap", arguments: { x: 1, y: 1 } }, a.key)).status, 404);
  // Each command names its own device set and companion only.
  const before = h.calls.length;
  assert.equal((await operate(h, a, "tap", { x: 2, y: 2 })).state, "succeeded");
  assert.equal((await operate(h, a, "screenshot")).state, "succeeded");
  const mineCalls = h.calls.slice(before).filter(argv => argv.join(" ").includes("ui tap 2 2") || argv.includes("io"));
  assert.ok(mineCalls.length >= 2 && mineCalls.every(argv => argv.includes(argv[0] === "/fixture/idb" ? join(h.storage(a.machineId), "idb.sock") : mine.set) && !argv.join(" ").includes(b.machineId)));
  // Runner restart during the lease: the supervisor keeps enforcing; the same simulator is recovered.
  const creates = h.calls.filter(argv => argv.includes("create")).length;
  await h.stopRunner();
  assert.ok(booted(mine) && alive(group.supervisorPid) && groupAlive(group.childPid), "the simulator and its supervisor outlive the runner");
  await sleep(Math.max(0, admitted + 23000 - Date.now()));
  assert.ok(booted(mine) && alive(group.supervisorPid), "renewal kept the simulator past its original 20-second deadline, with no runner");
  await h.restartRunner();
  await until(async () => (await h.api("GET", `/v1/leases/${a.id}`, undefined, app)).body.members[0].ready === true, "recovered ready member");
  assert.equal(supervised(h, a.machineId).supervisorPid, group.supervisorPid);
  assert.equal(h.simulator(a.machineId)!.pid, mine.pid, "the same launchd_sim");
  assert.equal(h.calls.filter(argv => argv.includes("create")).length, creates, "nothing was created again");
  assert.equal(simulators(h.paths.registry).filter(s => s.set !== "default").length, 2);
  assert.equal((await operate(h, a, "tap", { x: 6, y: 6 })).state, "succeeded");
  for (const lease of [a, b]) assert.equal((await client(h, lease).release({ id: randomUUID() })).lease.state, "released");
  await cleaned(h, app, a.id); await cleaned(h, app, b.id);
  assert.deepEqual(await h.reserved(), { cpu: 0, memoryMiB: 0, diskGiB: 0 });
  defaultSetUntouched(h);
});

test("supervisor loss ends device access at once, fails the lease and holds the reservation until the simulator's tree is proven gone", { skip, timeout: 120000 }, async t => {
  const h = await harness(t), app = await h.application();
  const a = await acquire(h, app, 120), group = supervised(h, a.machineId), device = h.simulator(a.machineId)!, storage = h.storage(a.machineId);
  assert.equal((await operate(h, a, "tap", { x: 4, y: 4 })).state, "succeeded");
  const taps = h.calls.filter(argv => argv.join(" ").includes("ui tap 4 4")).length;
  // The supervisor is lost abruptly. The simulator and the companion keep running, unsupervised.
  process.kill(group.supervisorPid, "SIGKILL");
  await until(() => !alive(group.supervisorPid), "supervisor loss");
  assert.ok(booted(device) && groupAlive(group.childPid));
  // Its lifetime lock is free, so the provider refuses device access immediately, whatever the runner believes.
  const machine = h.runner().assignments.find(m => m.id === a.machineId)!;
  await assert.rejects(h.provider().ready(machine, h.runner().context(machine).image), (error: any) => error.status === 410);
  // The runner reports the loss and the lease fails long before its 120-second TTL.
  await until(async () => (await h.api("GET", `/v1/leases/${a.id}`, undefined, app)).body.state === "failed", "failed lease", 15000);
  assert.equal((await refusedStatus(h, a.id, a.key, "tap", { x: 4, y: 4 })).status, 410);
  assert.equal(h.calls.filter(argv => argv.join(" ").includes("ui tap 4 4")).length, taps);
  assert.equal(JSON.parse(readFileSync(join(storage, "lease-authorization.json"), "utf8")).fenced, true);
  const blocked = async () => { const lease = (await h.api("GET", `/v1/leases/${a.id}`, undefined, app)).body; return lease.cleanup.state === "blocked" && lease.members[0].cleanup.reason === "execution_pending"; };
  await until(blocked, "blocked cleanup");
  await sleep(3000);
  assert.ok(await blocked());
  assert.deepEqual(await h.reserved(), { cpu: 2, memoryMiB: 2048, diskGiB: 8 });
  assert.ok(existsSync(storage) && booted(device), "nothing is removed and nothing is signalled without proof");
  assert.ok(!h.calls.some(argv => argv.includes("delete")), "the simulator is never deleted while it may run");
  // Stopping only the companion is not enough: the simulator's tree still names the device set.
  process.kill(-group.childPid, "SIGKILL");
  await sleep(3000);
  assert.ok(await blocked() && existsSync(storage));
  // Documented recovery: the operator shuts the lease's own simulator down in its own device set.
  process.kill(device.pid!, "SIGTERM");
  await cleaned(h, app, a.id);
  assert.equal(existsSync(storage), false);
  assert.deepEqual(await h.reserved(), { cpu: 0, memoryMiB: 0, diskGiB: 0 });
  defaultSetUntouched(h);
});

test("an administrative release stops the simulator, and cleanup stays blocked while stop proof is unavailable, even after the supervisor's own receipt", { skip, timeout: 120000 }, async t => {
  // The host's own process inventory is unavailable for a while: the receipt alone removes nothing.
  let inventory: "ok" | "failing" | "unknown" = "ok";
  const leases: LeaseSupervisorTransport = { ...nativeLeaseSupervisor, async simulatorTree(helperPath, storage, set) {
    if (inventory === "failing") throw new Error("process inventory unavailable");
    return inventory === "unknown" ? "unknown" : nativeLeaseSupervisor.simulatorTree(helperPath, storage, set);
  } };
  const h = await harness(t, 1, { leases }), app = await h.application();
  const a = await acquire(h, app, 120), device = h.simulator(a.machineId)!, storage = h.storage(a.machineId);
  inventory = "failing";
  // The operator releases the lease through the administrative route; a lost reply replays by UUID.
  const mutation = randomUUID(), released = await h.api("POST", `/v1/admin/leases/${a.id}/release`, { id: mutation });
  assert.deepEqual([released.status, released.body.state], [200, "released"]);
  assert.deepEqual((await h.api("POST", `/v1/admin/leases/${a.id}/release`, { id: mutation })).body, released.body);
  assert.equal((await refusedStatus(h, a.id, a.key)).status, 410, "the lease key is refused at once");
  await until(() => existsSync(join(storage, "lease-stopped.json")), "the supervisor's stop receipt");
  assert.ok(!booted(device));
  const blocked = async () => { const lease = (await h.api("GET", `/v1/leases/${a.id}`, undefined, app)).body; return lease.cleanup.state === "blocked"; };
  await until(blocked, "blocked cleanup");
  // A tree record that lost members is not proof either.
  inventory = "unknown";
  await sleep(3000);
  assert.ok(await blocked());
  assert.ok(existsSync(join(storage, "device-set", device.udid)) && h.simulator(a.machineId), "the simulator and its storage are retained");
  assert.deepEqual(await h.reserved(), { cpu: 2, memoryMiB: 2048, diskGiB: 8 });
  inventory = "ok";
  await cleaned(h, app, a.id);
  assert.equal(existsSync(storage), false);
  assert.deepEqual(await h.reserved(), { cpu: 0, memoryMiB: 0, diskGiB: 0 });
});

test("a simulator that cannot boot, and a device set that gains a foreign simulator, never reach a lease holder", { skip, timeout: 120000 }, async t => {
  const h = await harness(t), app = await h.application();
  // The boot command fails: the supervisor ends in its stop receipt and the lease fails without becoming ready.
  writeFileSync(join(h.root, "boot-fails"), "");
  const failing = await acquire(h, app, 60, false), views: string[] = [];
  await until(async () => { const lease = (await h.api("GET", `/v1/leases/${failing.id}`, undefined, app)).body; views.push(lease.state); return lease.state === "failed"; }, "failed lease", 40000);
  assert.ok(!views.includes("ready"));
  await cleaned(h, app, failing.id);
  assert.equal(simulators(h.paths.registry).filter(s => s.set !== "default").length, 0, "the created simulator was deleted");
  rmSync(join(h.root, "boot-fails"));
  // A second simulator appears in a ready lease's private device set: the lease is fenced, not served.
  const a = await acquire(h, app, 120), device = h.simulator(a.machineId)!;
  save(h.paths.registry, { udid: randomUUID().toUpperCase(), name: "intruder", set: device.set, ...DEVICE, apps: [] });
  await until(async () => (await h.api("GET", `/v1/leases/${a.id}`, undefined, app)).body.state === "failed", "fenced lease", 30000);
  assert.equal((await refusedStatus(h, a.id, a.key)).status, 410);
  await until(() => !booted(device), "the fenced simulator stops");
  // Removal refuses a device set that holds a simulator the lease did not create.
  await until(async () => { const lease = (await h.api("GET", `/v1/leases/${a.id}`, undefined, app)).body; return lease.cleanup.state === "blocked" && lease.members[0].cleanup.reason === "ownership"; }, "ownership-blocked cleanup");
  assert.ok(simulators(h.paths.registry).some(s => s.name === "intruder") && existsSync(h.storage(a.machineId)), "nothing was deleted");
  rmSync(join(h.paths.registry, simulators(h.paths.registry).find(s => s.name === "intruder")!.udid + ".json"));
  await cleaned(h, app, a.id);
  assert.deepEqual(await h.reserved(), { cpu: 0, memoryMiB: 0, diskGiB: 0 });
  defaultSetUntouched(h);
});
