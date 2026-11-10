import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { AndroidProvider } from "../../src/providers/android.ts";
import { IosProvider } from "../../src/providers/ios.ts";
import { digest, operationRequest, readJson, saveJson } from "../../src/providers/mobile.ts";
import type { MobileTransport, NativeChild, RecordValue, RunOptions } from "../../src/providers/mobile.ts";

function fixture(t: { after(fn: () => void): void }, system = "android") {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mobile-provider-"))); t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const image: RecordValue = { id: system + "-phone", revision: "1", os: system, arch: "arm64", mode: "device", device: system === "android" ? { systemImage: "system-images;android-35;google_apis;arm64-v8a", profile: "pixel_8" } : { runtime: "com.apple.CoreSimulator.SimRuntime.iOS-27-0", deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-17" } };
  const machine: RecordValue = { id: randomUUID(), template: image, desired: "running", resources: { cpu: 2, memoryMiB: 2048, diskGiB: 8 } };
  return { root, image, machine };
}
function androidFixture(t: { after(fn: () => void): void }) {
  const f = fixture(t), calls: string[][] = []; let devices: Record<string, string> = {}, avdName = "cvm-" + f.machine.id, stopped = false, failedShutdown = false, spawned = 0;
  const child: NativeChild = { pid: 1234567, stopped: async () => stopped };
  const transport: MobileTransport = {
    run: async (argv, _options) => {
      calls.push([...argv]); let stdout = "";
      if (argv.includes("create") && argv.includes("avd")) { const dir = argv[argv.indexOf("--path") + 1]!; fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, "config.ini"), "hw.device.name=pixel\n"); }
      else if (argv.at(-1) === "devices") stdout = "List of devices attached\n" + Object.entries(devices).map(([serial, state]) => serial + "\t" + state).join("\n");
      else if (argv.slice(-3).join(" ") === "emu avd name") stdout = avdName + "\nOK";
      else if (argv.at(-1) === "sys.boot_completed") stdout = "1";
      else if (argv.slice(-2).join(" ") === "emu kill") { if (failedShutdown) throw new Error("lost shutdown"); devices = {}; }
      else stdout = "fixture";
      return { stdout, exitCode: 0 };
    },
    spawn: async argv => { calls.push([...argv]); spawned++; return child; }, portPairAvailable: async () => true, processAbsent: async () => stopped,
  };
  const provider = new AndroidProvider({ storage: path.join(f.root, "storage"), androidSDK: "/fixture/sdk", transport }, f.root);
  return { ...f, calls, provider, get spawned() { return spawned; }, setDevices: (v: Record<string, string>) => { devices = v; }, setName: (v: string) => { avdName = v; }, setStopped: () => { stopped = true; }, failShutdown: () => { failedShutdown = true; } };
}

test("Android creates a private AVD once, applies disk sizing and records exact launch identity", async t => {
  const f = androidFixture(t);
  assert.equal((await f.provider.reconcile(f.machine, f.image, f.root)).state, "starting");
  const storage = f.provider.storage(f.machine, f.image), launch = readJson(path.join(storage, "launch.json"))!;
  assert.equal(launch.version, 2); assert.equal(launch.machineId, f.machine.id); assert.equal(launch.fingerprint, digest(f.provider.binding(f.machine, f.image)));
  assert.deepEqual(launch.argv, f.provider.launchArguments(f.machine, 5554));
  assert.match(fs.readFileSync(path.join(storage, "device.avd", "config.ini"), "utf8"), /disk.dataPartition.size=8G/);
  await f.provider.reconcile(f.machine, f.image, f.root); assert.equal(f.spawned, 1);
  assert.equal(f.calls.filter(c => c.includes("create")).length, 1); assert.ok(f.calls.every(c => !c.includes("--force")));
  assert.equal(f.provider.environment().ANDROID_AVD_HOME, path.join(f.root, "storage", "avds"));
});

test("Android refuses foreign/offline serials and contradictory immutable launch arguments", async t => {
  const f = androidFixture(t); await f.provider.reconcile(f.machine, f.image, f.root); f.setDevices({ "emulator-5554": "device" }); f.setName("personal-phone");
  await assert.rejects(f.provider.reconcile(f.machine, f.image, f.root), /another AVD/);
  f.setDevices({ "emulator-5554": "offline" }); const before = f.calls.length; await assert.rejects(f.provider.reconcile(f.machine, f.image, f.root), /offline/); assert.equal(f.calls.length, before + 1);
  const storage = f.provider.storage(f.machine, f.image), launch = readJson(path.join(storage, "launch.json"))!; saveJson(path.join(storage, "launch.json"), { ...launch, argv: ["foreign"] });
  await assert.rejects(f.provider.reconcile(f.machine, f.image, f.root), /contradictory/);
});

test("Android uncertain launch and failed shutdown never relaunch or release reservations", async t => {
  const f = androidFixture(t); await f.provider.reconcile(f.machine, f.image, f.root);
  const storage = f.provider.storage(f.machine, f.image), launch = readJson(path.join(storage, "launch.json"))!; saveJson(path.join(storage, "launch.json"), { ...launch, startedAt: 0 });
  assert.equal((await f.provider.reconcile(f.machine, f.image, f.root)).state, "unknown"); assert.equal(f.spawned, 1);
  f.setDevices({ "emulator-5554": "device" }); f.failShutdown();
  await assert.rejects(f.provider.reconcile({ ...f.machine, desired: "stopped" }, f.image, f.root));
  f.setDevices({}); f.setStopped(); assert.equal((await f.provider.reconcile({ ...f.machine, desired: "stopped" }, f.image, f.root)).state, "unknown"); assert.ok(fs.existsSync(path.join(storage, "launch.json")));
});

test("Android acknowledged stop waits for child exit, preserves data and reuses its AVD", async t => {
  const f = androidFixture(t); await f.provider.reconcile(f.machine, f.image, f.root); f.setDevices({ "emulator-5554": "device" });
  const storage = f.provider.storage(f.machine, f.image); fs.writeFileSync(path.join(storage, "keep-app-data"), "keep");
  assert.equal((await f.provider.reconcile({ ...f.machine, desired: "stopped" }, f.image, f.root)).state, "stopping");
  assert.equal((await f.provider.reconcile({ ...f.machine, desired: "stopped" }, f.image, f.root)).state, "stopping");
  f.setStopped(); assert.equal((await f.provider.reconcile({ ...f.machine, desired: "stopped" }, f.image, f.root)).state, "stopped"); assert.equal(fs.readFileSync(path.join(storage, "keep-app-data"), "utf8"), "keep");
  await f.provider.reconcile(f.machine, f.image, f.root); assert.equal(f.calls.filter(c => c.includes("create")).length, 1);
});

test("Android port reservation excludes other assignments and literal guest shell input stays quoted", async t => {
  const f = androidFixture(t), other = { ...f.machine, id: randomUUID() };
  await f.provider.reconcile(f.machine, f.image, f.root); await f.provider.reconcile(other, f.image, f.root);
  assert.equal(readJson(path.join(f.provider.storage(other, f.image), "endpoint.json"))!.port, 5556);
  f.setDevices({ "emulator-5554": "device" });
  const request = operationRequest({ id: randomUUID(), action: "shell", arguments: { argv: ["echo", "a';$(touch sentinel)"] } });
  await f.provider.control(f.machine, f.image, f.root, request);
  assert.equal(f.calls.at(-1)!.at(-1), "'echo' 'a'\"'\"';$(touch sentinel)'");
  assert.ok(!f.calls.some(c => c.includes("kill-server") || c.includes("-a")));
});

function iosFixture(t: { after(fn: () => void): void }) {
  const f = fixture(t, "ios"), calls: { argv: string[]; options: RunOptions }[] = [], udid = randomUUID(); let inventory: RecordValue[] = [], loseCreate = false;
  const device = { udid, name: "cvm-" + f.machine.id, state: "Shutdown", isAvailable: true, deviceTypeIdentifier: (f.image.device as RecordValue).deviceType };
  const transport: MobileTransport = { run: async (argv, options) => {
    calls.push({ argv: [...argv], options }); let stdout = "fixture";
    if (argv.includes("devices")) stdout = JSON.stringify({ devices: { [(f.image.device as RecordValue).runtime as string]: inventory } });
    else if (argv.includes("create")) { inventory = [device]; if (loseCreate) throw new Error("lost create"); stdout = udid; }
    else if (argv.includes("boot")) device.state = "Booted";
    else if (argv.includes("shutdown")) device.state = "Shutdown";
    else if (argv.includes("get_app_container")) stdout = f.root;
    return { stdout, exitCode: 0 };
  } };
  const provider = new IosProvider({ storage: path.join(f.root, "storage"), transport }, f.root);
  return { ...f, calls, udid, device, provider, setInventory: (v: RecordValue[]) => { inventory = v; }, loseCreate: () => { loseCreate = true; } };
}

test("iOS create, boot, control and shutdown always target the same saved UDID", async t => {
  const f = iosFixture(t); assert.equal((await f.provider.reconcile(f.machine, f.image, f.root)).state, "running");
  assert.ok(f.calls.some(c => c.argv.slice(-2).join(" ") === "boot " + f.udid));
  await f.provider.control(f.machine, f.image, f.root, operationRequest({ id: randomUUID(), action: "text", arguments: { text: "--udid personal ;$(touch sentinel)" } }));
  assert.deepEqual(f.calls.at(-1)!.argv.slice(-4), ["--udid", f.udid, "--", "--udid personal ;$(touch sentinel)"]);
  assert.equal((await f.provider.reconcile({ ...f.machine, desired: "stopped" }, f.image, f.root)).state, "stopping");
  assert.equal((await f.provider.reconcile({ ...f.machine, desired: "stopped" }, f.image, f.root)).state, "stopped");
  assert.equal(readJson(path.join(f.provider.storage(f.machine, f.image), "simulator.json"))!.udid, f.udid);
});

test("iOS never adopts foreign names, lost creates, replaced UDIDs or altered runtime identities", async t => {
  const f = iosFixture(t); f.setInventory([f.device]); await assert.rejects(f.provider.reconcile(f.machine, f.image, f.root), /without an owner receipt/); assert.ok(!f.calls.some(c => c.argv.includes("create")));
  f.setInventory([]); f.loseCreate(); await assert.rejects(f.provider.reconcile(f.machine, f.image, f.root));
  const createCount = f.calls.filter(c => c.argv.includes("create")).length;
  await assert.rejects(f.provider.reconcile(f.machine, f.image, f.root), /uncertain/); assert.equal(f.calls.filter(c => c.argv.includes("create")).length, createCount);
  const storage = f.provider.storage(f.machine, f.image); saveJson(path.join(storage, "simulator.json"), { udid: f.udid, fingerprint: digest(f.provider.binding(f.machine, f.image)) });
  f.setInventory([{ ...f.device, name: "personal" }]); await assert.rejects(f.provider.owned(f.machine, f.image, storage), /differs/);
  f.setInventory([{ ...f.device, udid: randomUUID() }]); await assert.rejects(f.provider.owned(f.machine, f.image, storage), /missing/);
});

test("iOS rejects container traversal before file adapter access", async t => {
  const f = iosFixture(t); await f.provider.reconcile(f.machine, f.image, f.root);
  for (const value of ["../../secret", "/etc/passwd", "a/../secret"]) await assert.rejects(f.provider.control(f.machine, f.image, f.root, operationRequest({ id: randomUUID(), action: "pull", arguments: { app: "com.example.app", path: value } })), /relative/);
});
