import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { MobileProvider, MAX_RESULT, canonical, decodeData, deviceDefinition, digest, locked, operationRequest, readJson, saveJson } from "../../src/providers/mobile.ts";
import { AndroidProvider } from "../../src/providers/android.ts";
import { IosProvider } from "../../src/providers/ios.ts";
import type { RecordValue } from "../../src/providers/mobile.ts";

function fixture(t: { after(fn: () => void): void }) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mobile-contract-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root;
}
function image(system = "android"): RecordValue { return { id: system + "-phone", revision: "1", os: system, mode: "device", arch: "arm64", device: system === "android" ? { systemImage: "system-images;android-35;google_apis;arm64-v8a", profile: "pixel_8" } : { runtime: "com.apple.CoreSimulator.SimRuntime.iOS-27-0", deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-17" }, minimum: { cpu: 2, memoryMiB: 2048, diskGiB: 8 } }; }
function machine(template = image()): RecordValue { return { id: randomUUID(), template, resources: { cpu: 2, memoryMiB: 2048, diskGiB: 8 }, desired: "running", ownerUserId: randomUUID(), hostId: randomUUID() }; }
function operation(action = "tap", args: RecordValue = { x: 1, y: 2 }): RecordValue { return { id: randomUUID(), action, arguments: args, expiresAt: Date.now() / 1000 + 120 }; }

test("mobile device definitions preserve pinned architecture and exact SDK identifiers", () => {
  for (const os of ["android", "ios"]) assert.deepEqual(deviceDefinition(image(os).device, os, "arm64"), image(os).device);
  for (const value of [{ ...image().device as RecordValue, serial: "foreign" }, { systemImage: "system-images;android-35;google_apis;x86_64", profile: "pixel" }, { systemImage: "../../escape", profile: "pixel" }]) assert.throws(() => deviceDefinition(value, "android", "arm64"));
  assert.throws(() => deviceDefinition({ runtime: "iOS-27", deviceType: "iPhone" }, "ios", "arm64"));
});

test("device operation validation rejects native target selection, injection and invalid envelopes", () => {
  const invalid = [
    ["tap", { x: true, y: 1 }], ["tap", { x: 1, y: 2, serial: "foreign" }], ["location", { latitude: NaN, longitude: 0 }], ["location", { latitude: Infinity, longitude: 0 }], ["push", { path: "/tmp/a", data: "???" }], ["install", { artifact: "--help" }], ["shell", { argv: ["echo", "a\0b"] }], ["shell", { argv: ["--help"] }], ["swipe", { x: 1, y: 2, toX: 3, toY: 4, durationMs: 0 }], ["shell-resize", { session: randomUUID(), rows: 0, cols: 80 }], ["shell-read", { session: "../../escape", offset: 0 }], ["rotate", { orientation: "random" }], ["permission", { app: "com.example", permission: "camera", state: "all" }], ["pull", { path: "/tmp/a", app: "a;rm" }], ["constructor", {}],
  ] as const;
  for (const [action, args] of invalid) assert.throws(() => operationRequest({ id: randomUUID(), action, arguments: args }), action);
  assert.deepEqual(decodeData(""), Buffer.alloc(0)); assert.throws(() => decodeData(Buffer.alloc(524289).toString("base64")));
  assert.equal(operationRequest({ id: randomUUID().toUpperCase(), action: "text", arguments: { text: "" } }).arguments.text, "");
});

test("mobile storage binds the complete template, resources, owner, host, lease and runtime instance", t => {
  const root = fixture(t), img = image(), m = machine(img), settings = { storage: path.join(root, "storage"), androidSDK: "/fixture/sdk" };
  const provider = new AndroidProvider(settings, root);
  const storage = provider.storage(m, img);
  assert.equal(fs.statSync(storage).mode & 0o777, 0o700);
  assert.equal(provider.storage({ ...m, desired: "stopped" }, img), storage);
  const mutations: RecordValue[] = [
    { ...m, resources: { cpu: 3, memoryMiB: 2048, diskGiB: 8 } },
    { ...m, template: { ...img, revision: "2" } },
    { ...m, template: { ...img, device: { ...img.device as RecordValue, profile: "pixel_9" } } },
    { ...m, ownerUserId: randomUUID() }, { ...m, hostId: randomUUID() }, { ...m, lease: { id: randomUUID() } },
  ];
  for (const mutated of mutations) assert.throws(() => provider.storage(mutated, mutated.template as RecordValue));
  assert.throws(() => new AndroidProvider(settings, path.join(root, "another-runner")).storage(m, img));
  assert.throws(() => new IosProvider({ storage: settings.storage }, root).storage(m, img));
  const changed = { ...img, minimum: { cpu: 4 } };
  assert.throws(() => provider.storage(m, changed));
});

test("unowned, copied and symlinked storage never becomes an adopted assignment", t => {
  const root = fixture(t), img = image(), m = machine(img), provider = new AndroidProvider({ storage: path.join(root, "storage"), androidSDK: "/sdk" }, root);
  const storage = provider.storage(m, img), clone = machine(img), destination = path.join(root, "storage", clone.id as string);
  fs.cpSync(storage, destination, { recursive: true }); assert.throws(() => provider.storage(clone, img));
  const unowned = machine(img), foreign = path.join(root, "storage", unowned.id as string); fs.mkdirSync(foreign); fs.writeFileSync(path.join(foreign, "foreign-data"), "keep");
  assert.throws(() => provider.storage(unowned, img));
  assert.equal(fs.readFileSync(path.join(foreign, "foreign-data"), "utf8"), "keep");
  fs.renameSync(storage, storage + "-old"); fs.symlinkSync(storage + "-old", storage); assert.throws(() => provider.storage(m, img));
});

test("actions use durable idempotency, conflict detection, crash and expiry receipts", async t => {
  const root = fixture(t), img = image(), m = machine(img), provider = new MobileProvider({ storage: path.join(root, "storage") }, root), request = operation();
  let calls = 0;
  const handle = async () => { calls++; return { output: "tapped" }; };
  const first = await provider.operate(m, img, root, request, () => true, handle);
  assert.equal(first.state, "succeeded"); assert.deepEqual(await provider.operate(m, img, root, request, () => true, handle), first); assert.equal(calls, 1);
  await assert.rejects(provider.operate(m, img, root, { ...request, arguments: { x: 2, y: 3 } }, () => true, handle), /conflicts/);
  const receipt = path.join(provider.storage(m, img), "operations", request.id + ".json"), saved = readJson(receipt)!;
  saveJson(receipt, { fingerprint: saved.fingerprint, started: true });
  assert.equal((await provider.operate(m, img, root, request, () => true, handle)).state, "unknown"); assert.equal(calls, 1);
  assert.equal((await provider.operate(m, img, root, { ...operation(), expiresAt: 0 }, () => true, handle)).state, "failed");
  assert.equal((await provider.operate({ ...m, desired: "stopped" }, img, root, operation(), () => true, handle)).state, "failed");
  const timed = operation();
  assert.equal((await provider.operate(m, img, root, timed, () => true, async () => { calls++; throw new Error("timeout"); })).state, "unknown");
  assert.equal((await provider.operate(m, img, root, timed, () => true, handle)).state, "unknown"); assert.equal(calls, 2);
});

test("concurrent operations cannot replay effects or reclaim unexplained locks", async t => {
  const root = fixture(t), img = image(), m = machine(img), provider = new MobileProvider({ storage: path.join(root, "storage") }, root), request = operation();
  let finish!: () => void; const pending = new Promise<void>(resolve => { finish = resolve; });
  const running = provider.operate(m, img, root, request, () => true, async () => { await pending; return {}; });
  await assert.rejects(provider.operate(m, img, root, request, () => true, async () => ({})), /busy/);
  finish(); await running;
  const stale = path.join(root, "unresolved.lock"); fs.writeFileSync(stale, ""); await assert.rejects(locked(stale, async () => true), /unresolved/); assert.ok(fs.existsSync(stale));
});

test("revocation and escaped oversized output never become successful or replayed actions", async t => {
  const root = fixture(t), img = image(), m = machine(img), provider = new MobileProvider({ storage: path.join(root, "storage") }, root);
  let allowed = true, calls = 0;
  const revoked = operation();
  const result = await provider.operate(m, img, root, revoked, () => allowed, async () => { calls++; allowed = false; return {}; });
  assert.equal(result.state, "unknown"); allowed = true; await provider.operate(m, img, root, revoked, () => allowed, async () => { calls++; return {}; }); assert.equal(calls, 1);
  const oversized = await provider.operate(m, img, root, operation("logs", {}), () => true, async () => ({ output: "\n".repeat(4 * 1048576) }));
  assert.equal(oversized.state, "unknown"); assert.ok(Buffer.byteLength(canonical(oversized.result)) < MAX_RESULT);
  await assert.rejects(provider.operate(m, img, root, operation(), () => false, async () => ({})), /authorization/);
});

test("native defaults run a harmless fixture and mobile consumer leases fail closed", async t => {
  const root = fixture(t), img = image(), m = machine(img), android = new AndroidProvider({ storage: path.join(root, "storage"), androidSDK: "/sdk" }, root);
  assert.equal((await android.run([process.execPath, "-e", "process.stdout.write('fixture')"])).toString(), "fixture");
  await assert.rejects(android.run([path.join(root, "missing-fixture-executable")]), /unavailable/);
  await assert.rejects(android.reconcile({ ...m, lease: { id: randomUUID() } }, img, root), /fencing/);
  assert.equal(digest({ a: 1, b: { d: 2, c: true } }), digest({ b: { c: true, d: 2 }, a: 1 }));
});
