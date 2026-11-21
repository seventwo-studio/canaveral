import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { ControlModule, ControlRequest, Principal } from "../../src/control/contracts.ts";
import { createModule as devicesModule } from "../../src/control/devices.ts";
import { createModule as lifecycleModule } from "../../src/control/lifecycle.ts";
import { MachineStore } from "../../src/control/machines.ts";
import { createModule as upkeepModule } from "../../src/control/upkeep.ts";
import { object, ServiceError } from "../../src/errors.ts";
import { HostRunner } from "../../src/host.ts";
import type { HostConfig, HostTransport } from "../../src/host.ts";
import { AndroidProvider } from "../../src/providers/android.ts";
import { IosProvider } from "../../src/providers/ios.ts";
import { createNodeMobileTransport } from "../../src/providers/mobile-native.ts";
import type { MobileTransport } from "../../src/providers/mobile.ts";
import type { RecordValue } from "../../src/runtime-process.ts";
import { SqliteStore } from "../../src/sqlite.ts";

/** Disposable upkeep fixtures. Real controller modules and a real HostRunner drive the real
 * Android and iOS providers, whose tools are stand-in processes: `sdkmanager`, `avdmanager`,
 * `adb`, `xcrun simctl` and `xcodebuild` are one scripted Node program behind shell wrappers.
 * No SDK, Xcode, runtime, emulator or simulator of this machine is read or changed. */
export const ANDROID_INSTALLED = "system-images;android-35;google_apis;arm64-v8a";
export const ANDROID_AVAILABLE = "system-images;android-36;google_apis;arm64-v8a";
export const ANDROID_UNUSED = "system-images;android-34;google_apis;arm64-v8a";
export const IOS_INSTALLED = "com.apple.CoreSimulator.SimRuntime.iOS-27-0";
export const IOS_UNUSED = "com.apple.CoreSimulator.SimRuntime.iOS-26-4";
export const IOS_AVAILABLE = "com.apple.CoreSimulator.SimRuntime.iOS-27-2";
export const IOS_DEVICE_TYPE = "com.apple.CoreSimulator.SimDeviceType.iPhone-17";

const TOOLS = String.raw`import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const root = dirname(fileURLToPath(import.meta.url)), [tool, ...args] = process.argv.slice(2);
const statePath = join(root, "tools.json"), read = () => JSON.parse(readFileSync(statePath, "utf8"));
const write = state => { const temporary = statePath + "." + randomUUID(); writeFileSync(temporary, JSON.stringify(state)); renameSync(temporary, statePath); };
const log = entry => appendFileSync(join(root, "calls.jsonl"), JSON.stringify({ tool, args, at: Date.now(), ...entry }) + "\n");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const input = async () => { let data = ""; for await (const chunk of process.stdin) data += chunk; return data; };
const json = value => { process.stdout.write(JSON.stringify(value)); };
if (tool === "sdkmanager") {
  const sdk = args.find(arg => arg.startsWith("--sdk_root=")).slice(11), state = read().android;
  if (args.includes("--list")) {
    log({ phase: "list" });
    if (state.offline) { console.error("Warning: Failed to download any source lists!"); process.exit(1); }
    console.log("Installed packages:\n  Path | Version | Description | Location\n  ------- | ------- | ------- | -------\n  platform-tools | 36.0.0 | Android SDK Platform-Tools | platform-tools\n");
    console.log("Available Packages:\n  Path | Version | Description\n  ------- | ------- | -------\n  build-tools;36.0.0 | 36.0.0 | Android SDK Build-Tools 36");
    for (const name of state.available) console.log("  " + name + " | 9 | Google APIs System Image");
    console.log("\nAvailable Updates:\n  ID | Installed | Available\n  platform-tools | 36.0.0 | 36.0.1");
    process.exit(0);
  }
  const name = args.at(-1), directory = join(sdk, ...name.split(";"));
  if (args.includes("--uninstall")) { log({ phase: "start" }); rmSync(directory, { recursive: true, force: true }); log({ phase: "end" }); process.exit(0); }
  const answers = (await input()).split("\n").filter(line => line.trim() === "y").length;
  log({ phase: "start", answers });
  if (state.hang) await sleep(600000);
  if (!answers) { console.log("Accept? (y/N): Skipping following packages as the license is not accepted:\n" + name + "\nThe following packages can not be installed since their licenses or those of the packages they depend on were not accepted:\n  " + name); process.exit(1); }
  if (state.fail) { console.log("Warning: Failed to find package " + name); process.exit(1); }
  const report = percent => process.stdout.write("[=====        ] " + percent + "% Downloading " + name.replaceAll(";", "-") + ".zip...\r");
  report(10);
  // A held install stays at its first progress line until the test releases it.
  while (read().android.hold) await sleep(25);
  for (const percent of [45, 80, 100]) { report(percent); await sleep(state.installMs / 4); }
  if (!state.vanish) { mkdirSync(directory, { recursive: true }); writeFileSync(join(directory, "source.properties"), "Pkg.Revision=9\nPkg.Desc=Fixture\n"); }
  log({ phase: "end" }); process.exit(0);
}
if (tool === "avdmanager") {
  const name = args[args.indexOf("--name") + 1], directory = args[args.indexOf("--path") + 1];
  mkdirSync(directory, { recursive: true }); writeFileSync(join(directory, "config.ini"), "hw.lcd.density=420\n");
  writeFileSync(join(process.env.ANDROID_AVD_HOME, name + ".ini"), "path=" + directory + "\n");
  log({}); process.exit(0);
}
if (tool === "adb") {
  const state = read(), devices = state.android.devices;
  if (args[0] === "start-server") process.exit(0);
  if (args[0] === "devices") { console.log("List of devices attached\n" + Object.keys(devices).map(serial => serial + "\tdevice").join("\n")); process.exit(0); }
  const serial = args[1], rest = args.slice(2).join(" ");
  if (!(serial in devices)) process.exit(1);
  log({});
  if (rest === "emu avd name") console.log(devices[serial] + "\nOK");
  else if (rest === "shell getprop sys.boot_completed") console.log("1");
  else if (rest === "emu kill") { delete devices[serial]; write(state); console.log("OK"); }
  else console.log("ok");
  process.exit(0);
}
if (tool === "xcodebuild") {
  const state = read(), version = args[args.indexOf("-buildVersion") + 1];
  log({ phase: "start" });
  if (args[0] !== "-downloadPlatform" || args[1] !== "iOS" || !version) process.exit(64);
  if (state.ios.hang) await sleep(600000);
  if (state.ios.fail) { console.log("xcodebuild: error: Unable to download"); process.exit(70); }
  for (const percent of ["12.5", "63.0", "100.0"]) { console.log("Downloading iOS " + version + " Simulator: " + percent + "% (1.2 GB of 8.3 GB)"); await sleep(state.ios.downloadMs / 3); }
  const next = read();
  next.ios.runtimes.push({ identifier: "com.apple.CoreSimulator.SimRuntime.iOS-" + version.replaceAll(".", "-"), version, buildversion: "24B8118", isAvailable: true, name: "iOS " + version, imageId: randomUUID().toUpperCase(), deletable: true });
  write(next); log({ phase: "end" }); process.exit(0);
}
if (tool === "xcrun" && args[0] === "simctl") {
  const state = read(), ios = state.ios, command = args.slice(1).join(" ");
  if (command === "list runtimes --json") json({ runtimes: ios.runtimes.map(runtime => ({ identifier: runtime.identifier, version: runtime.version, buildversion: runtime.buildversion, isAvailable: runtime.isAvailable, name: runtime.name, platform: "iOS" })) });
  else if (command === "list devicetypes --json") json({ devicetypes: [{ identifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-17", name: "iPhone 17" }] });
  else if (command === "list devices --json") json({ devices: ios.devices });
  else if (command === "runtime list -j") {
    if (ios.noImages) process.exit(1);
    json(Object.fromEntries(ios.runtimes.filter(runtime => runtime.imageId).map(runtime => [runtime.imageId, { identifier: runtime.imageId, runtimeIdentifier: runtime.identifier, build: runtime.buildversion, version: runtime.version,
      state: "Ready", deletable: runtime.deletable, sizeBytes: 8315434484, kind: "Patchable Cryptex Disk Image", platformIdentifier: "com.apple.platform.iphonesimulator" }])));
  } else if (command === "runtime match list -j") json({ ["iphoneos" + ios.sdkVersion]: { chosenRuntimeBuild: "24B8117", defaultBuild: "24B8118", platform: "com.apple.platform.iphoneos", sdkBuild: "24B8118", sdkVersion: ios.sdkVersion },
    ["watchos" + ios.sdkVersion]: { chosenRuntimeBuild: "24S118", defaultBuild: "24S118", platform: "com.apple.platform.watchos", sdkBuild: "24S118", sdkVersion: ios.sdkVersion } });
  else if (args[1] === "runtime" && args[2] === "delete") {
    log({ phase: "start" });
    if (!ios.keepImages) { ios.runtimes = ios.runtimes.filter(runtime => runtime.imageId !== args[3]); write(state); }
    log({ phase: "end" });
  } else if (args[1] === "delete") {
    log({}); for (const runtime of Object.keys(ios.devices)) ios.devices[runtime] = ios.devices[runtime].filter(device => device.udid.toLowerCase() !== args[2].toLowerCase()); write(state);
  } else if (args[1] === "create") {
    const udid = randomUUID().toUpperCase();
    (ios.devices[args[4]] ??= []).push({ udid, name: args[2], state: "Shutdown", isAvailable: true, deviceTypeIdentifier: args[3] }); write(state); log({}); process.stdout.write(udid);
  } else { log({}); process.stdout.write("ok"); }
  process.exit(0);
}
process.exit(0);
`;

export interface Tools {
  android: { available: string[]; devices: Record<string, string>; installMs: number; hold?: boolean; hang?: boolean; fail?: boolean; vanish?: boolean; offline?: boolean };
  ios: { runtimes: { identifier: string; version: string; buildversion: string; isAvailable: boolean; name: string; imageId?: string; deletable?: boolean }[];
    devices: Record<string, { udid: string; name: string; state: string; isAvailable: boolean; deviceTypeIdentifier: string }[]>; sdkVersion: string; downloadMs: number; hang?: boolean; fail?: boolean; noImages?: boolean; keepImages?: boolean };
}
export interface Call { tool: string; args: string[]; at: number; phase?: string; answers?: number }
export type Reply<T = any> = { status: number; body: T };
export const operator: Principal = { kind: "operator", user: null, scopes: ["admin"] };
export const failure = (status: number, code?: string) => (error: unknown) => error instanceof ServiceError && error.status === status && (code === undefined || error.code === code);

export interface HarnessOptions { upkeep?: RecordValue; templates?: RecordValue[]; capacity?: { cpu: number; memoryMiB: number; diskGiB: number } }
export async function upkeepHarness(t: TestContext, options: HarnessOptions = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "canaveral-upkeep-"))), sdk = join(root, "sdk"), bin = join(root, "bin");
  const runners = new Set<HostRunner>();
  t.after(async () => { try { await Promise.all([...runners].map(runner => runner.close().catch(() => {}))); } finally { rmSync(root, { recursive: true, force: true }); } });
  writeFileSync(join(root, "tools.mjs"), TOOLS);
  const wrapper = (file: string, tool: string): void => { mkdirSync(join(file, ".."), { recursive: true }); writeFileSync(file, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(root, "tools.mjs"))} ${tool} "$@"\n`, { mode: 0o755 }); };
  wrapper(join(sdk, "cmdline-tools/latest/bin/sdkmanager"), "sdkmanager"); wrapper(join(sdk, "cmdline-tools/latest/bin/avdmanager"), "avdmanager");
  wrapper(join(sdk, "platform-tools/adb"), "adb"); wrapper(join(sdk, "emulator/emulator"), "emulator");
  for (const tool of ["xcrun", "xcodebuild", "idb", "idb_companion"]) wrapper(join(bin, tool), tool);
  const installImage = (name: string): void => { const directory = join(sdk, ...name.split(";")); mkdirSync(directory, { recursive: true }); writeFileSync(join(directory, "source.properties"), "Pkg.Revision=8\n"); };
  installImage(ANDROID_INSTALLED); installImage(ANDROID_UNUSED);
  const initial: Tools = { android: { available: [ANDROID_INSTALLED, ANDROID_AVAILABLE, "system-images;android-36;google_apis;x86_64"], devices: {}, installMs: 0 },
    ios: { runtimes: [{ identifier: IOS_INSTALLED, version: "27.0", buildversion: "24A100", isAvailable: true, name: "iOS 27.0", imageId: "6E111F04-4F34-47C6-9596-93E106DDEE95", deletable: true },
      { identifier: IOS_UNUSED, version: "26.4", buildversion: "23E200", isAvailable: true, name: "iOS 26.4", imageId: "B62A22A7-EBA8-4197-AB4F-67796AC63FEE", deletable: true }], devices: {}, sdkVersion: "27.2", downloadMs: 0 } };
  writeFileSync(join(root, "tools.json"), JSON.stringify(initial)); writeFileSync(join(root, "calls.jsonl"), "");
  const tools = {
    read: (): Tools => JSON.parse(readFileSync(join(root, "tools.json"), "utf8")) as Tools,
    // Replaced atomically: the stand-in processes read this file while they run.
    update(change: (state: Tools) => void): void { const state = tools.read(), temporary = join(root, `tools.json.${randomUUID()}`); change(state); writeFileSync(temporary, JSON.stringify(state)); renameSync(temporary, join(root, "tools.json")); },
    calls: (tool?: string): Call[] => readFileSync(join(root, "calls.jsonl"), "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line) as Call).filter(call => !tool || call.tool === tool),
    installImage,
  };

  // Real time flows for the stand-in processes; `advance` jumps both clocks for expiry and idle time.
  const started = performance.now(); let offset = 0;
  const elapsed = (): number => 1000 + (performance.now() - started) / 1000 + offset;
  const clock = { now: elapsed, wall: () => 1_700_000_000 + elapsed(), suspendAware: true };
  const settings = { adminToken: randomBytes(32).toString("base64url"), enrollmentToken: randomBytes(32).toString("base64url"), controllerId: randomUUID() };
  const store = new SqliteStore(join(root, "controller.sqlite"), clock.wall);
  const machines = new MachineStore(store, settings);
  const modules: ControlModule[] = [machines, lifecycleModule(store, settings), devicesModule(store, settings), upkeepModule(store, settings)];
  async function request<T = any>(method: string, target: string, body: RecordValue = {}, principal: () => Principal = () => operator): Promise<Reply<T>> {
    const url = new URL(target, "http://fixture.invalid");
    const req: ControlRequest = { method, path: url.pathname, parts: url.pathname.split("/").filter(Boolean), body: JSON.parse(JSON.stringify(body)) as RecordValue, query: url.searchParams, token: settings.adminToken, principal };
    for (const module of modules) { const reply = await module.handle(req); if (reply !== undefined) return { status: reply.status ?? 200, body: JSON.parse(JSON.stringify(reply.body)) as T }; }
    return assert.fail(`No controller route for ${method} ${target}`);
  }

  const node = createNodeMobileTransport({});
  const processes: MobileTransport = { run: node.run, pipe: node.pipe!, processAbsent: node.processAbsent!, portPairAvailable: async () => true,
    executableAvailable: async name => existsSync(join(bin, basename(name))),
    // Device boots are scripted through the stand-in adb; no emulator process is started.
    spawn: async () => ({ pid: 2 ** 22 + 7, stopped: async () => true }) };
  const android: RecordValue = { id: "android-phone", revision: "1", os: "android", arch: "arm64", mode: "device", minimum: { cpu: 2, memoryMiB: 2048, diskGiB: 8 }, device: { systemImage: ANDROID_INSTALLED, profile: "pixel_8" } };
  const ios: RecordValue = { id: "ios-phone", revision: "1", os: "ios", arch: "arm64", mode: "device", minimum: { cpu: 2, memoryMiB: 2048, diskGiB: 8 }, device: { runtime: IOS_INSTALLED, deviceType: IOS_DEVICE_TYPE } };
  const config: HostConfig = { name: "upkeep-host", provider: "macos", storage: join(root, "storage"), stateDir: join(root, "state"), capacity: options.capacity ?? { cpu: 16, memoryMiB: 32768, diskGiB: 200 },
    hostArch: "arm64", hostPlatform: "darwin", runtimes: { android: { androidSDK: sdk }, ios: { xcrun: join(bin, "xcrun"), xcodebuild: join(bin, "xcodebuild"), idb: join(bin, "idb"), runtimePollMilliseconds: 25 } },
    templates: options.templates ?? [android, ios], url: "http://127.0.0.1:1", enrollmentToken: settings.enrollmentToken, pollIntervalSeconds: 0.25,
    // Fixtures never read this machine's memory or disk pressure.
    pressure: { enabled: false }, ...(options.upkeep ? { upkeep: options.upkeep } : {}) };
  let connected = true, lastBeat: RecordValue = {};
  const transport: HostTransport = { async request(method, path, body, token, signal) {
    signal?.throwIfAborted();
    if (!connected) throw new Error("fixture transport offline");
    if (path.endsWith("/heartbeat")) lastBeat = structuredClone(body);
    const req: ControlRequest = { method, path, parts: path.split("/").filter(Boolean), body: JSON.parse(JSON.stringify(body)) as RecordValue, query: new URLSearchParams(), token, principal: () => { throw new ServiceError("Host credentials are not accounts.", 401); } };
    for (const module of modules) { const reply = await module.handle(req); if (reply !== undefined) return object(JSON.parse(JSON.stringify(reply.body))); }
    throw new ServiceError("Unknown endpoint.", 404);
  } };
  const providers: { android?: AndroidProvider; ios?: IosProvider } = {};
  async function startRunner(enroll: boolean): Promise<HostRunner> {
    const saved = { ...config }; if (!enroll) delete saved.enrollmentToken;
    const runner = new HostRunner(saved, { clock, transport, providerFactory: (provider, state) => {
      if (provider.provider === "android") return providers.android = new AndroidProvider({ ...provider, transport: processes }, state);
      return providers.ios = new IosProvider({ ...provider, transport: processes }, state);
    } });
    runners.add(runner);
    await runner.initializeProviders(); await runner.connect(); await runner.checkEnvironment();
    return runner;
  }
  let runner = await startRunner(true);
  const hostId = runner.identity!.id, hostPath = `/v1/hosts/${hostId}`;
  const poll = (): Promise<void> => runner.poll();
  /** Heartbeat and step the runner until the condition holds. */
  async function pump(done: () => boolean | Promise<boolean>, label: string, ms = 20_000): Promise<void> {
    const deadline = performance.now() + ms;
    for (;;) {
      await poll(); await runner.step();
      if (await done()) return;
      if (performance.now() > deadline) assert.fail(`Timed out waiting for ${label}`);
      await delay(30);
    }
  }
  const receipt = async (id: string): Promise<any> => (await request("GET", `/v1/host-operations/${id}`)).body;
  async function operation(kind: string, args: RecordValue, id: string = randomUUID()): Promise<any> {
    const reply = await request("POST", hostPath + "/operations", { id, kind, arguments: args });
    assert.ok([200, 201].includes(reply.status)); return reply.body;
  }
  /** Submit and run to a terminal receipt. */
  async function run(kind: string, args: RecordValue, id: string = randomUUID()): Promise<any> {
    await operation(kind, args, id);
    await pump(async () => ["succeeded", "failed", "unknown"].includes((await receipt(id)).state), `${kind} to finish`);
    await poll(); // The host learns its receipt was recorded and forgets it.
    return receipt(id);
  }
  await poll();
  return { root, sdk, bin, storage: { android: join(root, "storage", "android"), ios: join(root, "storage", "ios") }, state: join(root, "state"), hostId, hostPath, store, machines, tools, clock, images: { android, ios },
    request, operation, run, receipt, poll, pump, providers: providers as { android: AndroidProvider; ios: IosProvider },
    runner: () => runner, get lastBeat() { return lastBeat; }, setConnected(value: boolean) { connected = value; }, advance(seconds: number) { offset += seconds; },
    async stopRunner(): Promise<void> { await runner.close().catch(() => {}); runners.delete(runner); },
    async startRunner(): Promise<void> { runner = await startRunner(false); },
    async createMachine(templateId: string): Promise<any> { return (await request("POST", "/v1/machines", { id: randomUUID(), name: "fixture " + templateId, templateId })).body; },
  };
}
export type UpkeepHarness = Awaited<ReturnType<typeof upkeepHarness>>;
