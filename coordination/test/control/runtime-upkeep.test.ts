import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { Principal } from "../../src/control/contracts.ts";
import { createModule as updatesModule } from "../../src/control/updates.ts";
import { ServiceError } from "../../src/errors.ts";
import { IosProvider } from "../../src/providers/ios.ts";
import { parseSdkManagerList } from "../../src/providers/mobile-runtimes.ts";
import { ANDROID_AVAILABLE, ANDROID_INSTALLED, ANDROID_UNUSED, IOS_AVAILABLE, IOS_DEVICE_TYPE, IOS_INSTALLED, IOS_UNUSED, failure, upkeepHarness } from "./upkeep-fixture.test.ts";

/** Portable evidence only: every tool is a stand-in process. Nothing here shows that a real
 * sdkmanager or Xcode accepts these command lines, downloads or removes anything. */
const installed = (f: { sdk: string }, name: string): boolean => existsSync(join(f.sdk, ...name.split(";"), "source.properties"));
const platform = (view: any, name: string): any => view.platforms.find((entry: any) => entry.platform === name);

test("list reports installed and available runtimes with the templates and devices that use each", async t => {
  const f = await upkeepHarness(t);
  // Nothing is listed until an operator asks; reading the view runs no tool.
  const empty = (await f.request("GET", f.hostPath + "/runtimes")).body;
  assert.equal(empty.supported, true); assert.deepEqual(empty.platforms.map((entry: any) => [entry.platform, entry.listedAt]), [["android", null], ["ios", null]]);
  assert.equal(f.tools.calls("sdkmanager").length, 0);
  const machine = await f.createMachine("android-phone");

  const android = await f.run("runtime-list", { platform: "android" });
  assert.equal(android.state, "succeeded");
  assert.deepEqual(android.result.installed.map((image: any) => image.identifier), [ANDROID_UNUSED, ANDROID_INSTALLED]);
  assert.equal(android.result.available.state, "listed");
  assert.deepEqual(android.result.available.entries.map((entry: any) => [entry.identifier, entry.installed, entry.compatible]),
    [[ANDROID_INSTALLED, true, true], [ANDROID_AVAILABLE, false, true], ["system-images;android-36;google_apis;x86_64", false, false]]);
  const view = platform((await f.request("GET", f.hostPath + "/runtimes")).body, "android");
  assert.equal(view.operationId, android.id);
  const used = view.installed.find((image: any) => image.identifier === ANDROID_INSTALLED).usedBy;
  assert.deepEqual(used.templates, [{ id: "android-phone", revision: "1", arch: "arm64", offered: true }]);
  assert.deepEqual(used.machines.map((entry: any) => [entry.id, entry.leased]), [[machine.id, false]]);
  assert.deepEqual(view.installed.find((image: any) => image.identifier === ANDROID_UNUSED).usedBy, { templates: [], machines: [] });

  // An offline host still reports what is installed.
  f.tools.update(state => { state.android.offline = true; });
  const offline = await f.run("runtime-list", { platform: "android" });
  assert.equal(offline.state, "succeeded"); assert.deepEqual(offline.result.available, { state: "unavailable" }); assert.equal(offline.result.installed.length, 2);

  f.tools.update(state => { state.ios.devices[IOS_UNUSED] = [{ udid: randomUUID().toUpperCase(), name: "personal iPhone", state: "Shutdown", isAvailable: true, deviceTypeIdentifier: IOS_DEVICE_TYPE }]; });
  const ios = await f.run("runtime-list", { platform: "ios" });
  assert.equal(ios.state, "succeeded");
  assert.deepEqual(ios.result.installed.map((runtime: any) => [runtime.identifier, runtime.version, runtime.usable, runtime.devices, runtime.images[0].deletable]),
    [[IOS_INSTALLED, "27.0", true, 0, true], [IOS_UNUSED, "26.4", true, 1, true]]);
  // Xcode names only the runtime its own SDK selects; other versions are installed by identifier.
  assert.deepEqual(ios.result.available, { state: "listed", scope: "selected-xcode-default", entries: [{ identifier: IOS_AVAILABLE, version: "27.2", build: "24B8118", source: "xcode-default", installed: false }] });
  assert.deepEqual(platform((await f.request("GET", f.hostPath + "/runtimes")).body, "ios").installed[0].usedBy.templates, [{ id: "ios-phone", revision: "1", arch: "arm64", offered: true }]);
  // No private host path leaves the host.
  assert.ok(!JSON.stringify([android, ios]).includes(f.root));
});

test("an Android install runs only on an acknowledged request, reports progress and replays by UUID", async t => {
  const f = await upkeepHarness(t);
  f.tools.update(state => { state.android.hold = true; });
  // Without the licence acknowledgement nothing is queued and no tool runs.
  await assert.rejects(f.request("POST", f.hostPath + "/operations", { id: randomUUID(), kind: "runtime-install", arguments: { platform: "android", identifier: ANDROID_AVAILABLE } }), failure(400, "license_acknowledgement_required"));
  await assert.rejects(f.request("POST", f.hostPath + "/operations", { id: randomUUID(), kind: "runtime-install", arguments: { platform: "android", identifier: ANDROID_AVAILABLE, acceptLicenses: false } }), failure(400));
  assert.deepEqual((await f.request("GET", f.hostPath + "/operations")).body.operations, []);
  // Creating a device never downloads: provisioning uses avdmanager only.
  const machine = await f.createMachine("android-phone");
  await f.pump(() => f.tools.calls("avdmanager").length === 1, "the device to be provisioned");
  assert.equal(f.tools.calls("sdkmanager").length, 0); assert.equal(installed(f, ANDROID_AVAILABLE), false);

  const id = randomUUID(), body = { id, kind: "runtime-install", arguments: { platform: "android", identifier: ANDROID_AVAILABLE, acceptLicenses: true } };
  const queued = await f.request("POST", f.hostPath + "/operations", body);
  assert.equal(queued.status, 201); assert.equal(queued.body.state, "queued"); assert.equal(queued.body.requestedBy, "operator");
  assert.deepEqual(queued.body.arguments, { platform: "android", identifier: ANDROID_AVAILABLE, acceptLicenses: true, timeoutSeconds: 3600 });
  // The stand-in installer holds after its first progress line, so the running receipt is observable.
  await f.pump(async () => (await f.receipt(id)).progress?.percent !== undefined, "progress on the running receipt");
  const running = await f.receipt(id);
  assert.deepEqual([running.state, running.progress.phase, running.progress.percent, running.result], ["running", "downloading", 10, undefined]);
  assert.ok(running.progress.updatedAt >= running.createdAt);
  f.tools.update(state => { state.android.hold = false; });
  await f.pump(async () => (await f.receipt(id)).state === "succeeded", "the install to finish");
  const done = await f.receipt(id);
  assert.deepEqual(done.result, { platform: "android", identifier: ANDROID_AVAILABLE, installed: true });
  assert.equal(installed(f, ANDROID_AVAILABLE), true);
  // The acknowledgement reached the installer as answers on stdin, once.
  const installs = f.tools.calls("sdkmanager").filter(call => call.args.includes("--install") && call.phase === "start");
  assert.equal(installs.length, 1); assert.ok(installs[0]!.answers! > 0); assert.equal(installs[0]!.args.at(-1), ANDROID_AVAILABLE);

  // The same UUID and request returns the receipt; a changed request is a conflict. Neither runs again.
  const replay = await f.request("POST", f.hostPath + "/operations", body);
  assert.equal(replay.status, 200); assert.equal(replay.body.state, "succeeded");
  await assert.rejects(f.request("POST", f.hostPath + "/operations", { ...body, arguments: { ...body.arguments, identifier: ANDROID_UNUSED } }), failure(409));
  await assert.rejects(f.request("POST", f.hostPath + "/operations", { ...body, arguments: { platform: "android", identifier: ANDROID_AVAILABLE } }), failure(409));
  await f.poll(); await f.runner().step(); await f.poll();
  assert.equal(f.tools.calls("sdkmanager").filter(call => call.args.includes("--install") && call.phase === "start").length, 1);
  // Installing what is already present runs no installer.
  const again = await f.run("runtime-install", { platform: "android", identifier: ANDROID_AVAILABLE, acceptLicenses: true });
  assert.deepEqual([again.state, again.result.alreadyInstalled], ["succeeded", true]);
  assert.equal(f.tools.calls("sdkmanager").filter(call => call.args.includes("--install")).length, 2);
  // The listed view now shows it, unused; the device created earlier is untouched.
  const listed = await f.run("runtime-list", { platform: "android" });
  assert.ok(listed.result.installed.some((image: any) => image.identifier === ANDROID_AVAILABLE));
  assert.equal((await f.request("GET", `/v1/machines/${machine.id}`)).body.desired, "running");
});

test("one install runs per host and platform; another platform and a listing are not held up", async t => {
  const f = await upkeepHarness(t);
  f.tools.update(state => { state.android.hold = true; state.android.available.push("system-images;android-33;google_apis;arm64-v8a"); });
  const first = randomUUID();
  await f.operation("runtime-install", { platform: "android", identifier: ANDROID_AVAILABLE, acceptLicenses: true }, first);
  const second = { id: randomUUID(), kind: "runtime-install", arguments: { platform: "android", identifier: "system-images;android-33;google_apis;arm64-v8a", acceptLicenses: true } };
  await assert.rejects(f.request("POST", f.hostPath + "/operations", second), failure(409, "host_operation_busy"));
  await assert.rejects(f.request("POST", f.hostPath + "/operations", { id: randomUUID(), kind: "runtime-remove", arguments: { platform: "android", identifier: ANDROID_UNUSED } }), failure(409, "host_operation_busy"));
  await f.pump(async () => (await f.receipt(first)).state === "running", "the install to start");
  await assert.rejects(f.request("POST", f.hostPath + "/operations", second), failure(409, "host_operation_busy"));
  // iOS has its own lane, and a listing never waits for a change.
  const ios = randomUUID(), list = randomUUID();
  await f.operation("runtime-install", { platform: "ios", identifier: IOS_AVAILABLE }, ios);
  await f.operation("runtime-list", { platform: "android" }, list);
  await f.pump(async () => (await f.receipt(list)).state === "succeeded" && (await f.receipt(ios)).state === "succeeded", "the listing and the iOS install");
  // Both finished while the held Android install was still running.
  assert.equal((await f.receipt(first)).state, "running");
  assert.deepEqual(f.tools.calls("xcodebuild").find(call => call.phase === "start")!.args, ["-downloadPlatform", "iOS", "-buildVersion", "27.2"]);
  assert.ok(f.tools.read().ios.runtimes.some(runtime => runtime.identifier === IOS_AVAILABLE));
  f.tools.update(state => { state.android.hold = false; });
  await f.pump(async () => (await f.receipt(first)).state === "succeeded", "the first install");
  // With the lane free the second install is accepted, and the two never overlapped.
  assert.equal((await f.request("POST", f.hostPath + "/operations", second)).status, 201);
  await f.pump(async () => (await f.receipt(second.id)).state === "succeeded", "the second install");
  const calls = f.tools.calls("sdkmanager").filter(call => call.args.includes("--install"));
  assert.deepEqual(calls.map(call => [call.phase, call.args.at(-1)]), [["start", ANDROID_AVAILABLE], ["end", ANDROID_AVAILABLE], ["start", second.arguments.identifier], ["end", second.arguments.identifier]]);
});

test("a lost outcome is unknown, is never replayed and must be re-inspected before another change", async t => {
  const f = await upkeepHarness(t);
  f.tools.update(state => { state.android.hang = true; });
  const lost = randomUUID();
  await f.operation("runtime-install", { platform: "android", identifier: ANDROID_AVAILABLE, acceptLicenses: true }, lost);
  await f.pump(() => f.tools.calls("sdkmanager").some(call => call.phase === "start"), "the installer to start");
  // The runner dies mid-install. What a crash leaves on disk is the journal's started record and
  // no report, so those are restored after the fixture's orderly stop.
  const journal = join(f.state, "work", "hostOperations", `${lost}.json`), reports = join(f.state, "host-reports.json");
  const crashed = [readFileSync(journal), readFileSync(reports)];
  assert.equal(JSON.parse(crashed[0]!.toString()).state, "started");
  await f.stopRunner();
  writeFileSync(journal, crashed[0]!); writeFileSync(reports, crashed[1]!);
  f.tools.update(state => { state.android.hang = false; });
  await f.startRunner();
  await f.pump(async () => (await f.receipt(lost)).state === "unknown", "the unknown receipt");
  const receipt = await f.receipt(lost);
  assert.match(receipt.result.detail, /not replayed/);
  for (let round = 0; round < 5; round++) { await f.poll(); await f.runner().step(); await delay(20); }
  assert.equal(f.tools.calls("sdkmanager").filter(call => call.args.includes("--install") && call.phase === "start").length, 1);
  assert.equal(installed(f, ANDROID_AVAILABLE), false);
  // The same UUID still returns the unknown receipt.
  assert.equal((await f.operation("runtime-install", { platform: "android", identifier: ANDROID_AVAILABLE, acceptLicenses: true }, lost)).state, "unknown");
  const view = platform((await f.request("GET", f.hostPath + "/runtimes")).body, "android");
  assert.equal(view.inspectionRequired, true);
  // A new change is refused until a listing re-inspects the host; iOS is not affected.
  const retry = { id: randomUUID(), kind: "runtime-install", arguments: { platform: "android", identifier: ANDROID_AVAILABLE, acceptLicenses: true } };
  await assert.rejects(f.request("POST", f.hostPath + "/operations", retry), failure(409, "host_inspection_required"));
  assert.equal((await f.run("runtime-list", { platform: "ios" })).state, "succeeded");
  await assert.rejects(f.request("POST", f.hostPath + "/operations", retry), failure(409, "host_inspection_required"));
  const listed = await f.run("runtime-list", { platform: "android" });
  assert.ok(!listed.result.installed.some((image: any) => image.identifier === ANDROID_AVAILABLE));
  assert.ok((await f.receipt(lost)).acknowledgedAt > 0);
  assert.equal((await f.receipt(lost)).state, "unknown");
  assert.equal((await f.request("POST", f.hostPath + "/operations", retry)).status, 201);
  await f.pump(async () => (await f.receipt(retry.id)).state === "succeeded", "the new install");
  assert.equal(installed(f, ANDROID_AVAILABLE), true);
});

test("the controller bounds every operation: undelivered work fails, silent work becomes unknown", async t => {
  const f = await upkeepHarness(t);
  // Never collected by the host: it provably did not start.
  f.setConnected(false);
  const undelivered = await f.operation("runtime-install", { platform: "android", identifier: ANDROID_AVAILABLE, acceptLicenses: true, timeoutSeconds: 60 });
  f.advance(121);
  assert.deepEqual([(await f.receipt(undelivered.id)).state, (await f.receipt(undelivered.id)).result.code], ["failed", "expired"]);
  f.setConnected(true); await f.poll();
  // Collected, then the host goes silent: the outcome is unknown at the bounded deadline.
  f.tools.update(state => { state.android.hang = true; });
  const silent = await f.operation("runtime-install", { platform: "android", identifier: ANDROID_AVAILABLE, acceptLicenses: true, timeoutSeconds: 60 });
  assert.equal(silent.deadline - silent.startBy, 180);
  await f.pump(async () => (await f.receipt(silent.id)).state === "running", "the install to start");
  f.setConnected(false);
  f.advance(299);
  assert.equal((await f.receipt(silent.id)).state, "running");
  f.advance(2);
  assert.deepEqual([(await f.receipt(silent.id)).state, (await f.receipt(silent.id)).result.code], ["unknown", "outcome_unknown"]);
  // An offline host takes no new operation.
  await assert.rejects(f.request("POST", f.hostPath + "/operations", { id: randomUUID(), kind: "runtime-list", arguments: { platform: "android" } }), failure(409));
});

test("the provider classifies installer outcomes: timeout and unverified are unknown, a refused licence is failed", async t => {
  const f = await upkeepHarness(t), provider = f.providers.android;
  const context = (timeoutSeconds: number, authorized = () => true) => ({ authorized, timeoutSeconds, progress: () => {}, uses: () => [] });
  f.tools.update(state => { state.android.hang = true; });
  const timedOut = await provider.runtimeOperation("runtime-install", { identifier: ANDROID_AVAILABLE, acceptLicenses: true }, context(1));
  assert.deepEqual([timedOut.state, timedOut.result.code], ["unknown", "timeout"]);
  // Lost authorization closes the retained installer; that outcome is uncertain too.
  let allowed = true; setTimeout(() => { allowed = false; }, 400);
  const interrupted = await provider.runtimeOperation("runtime-install", { identifier: ANDROID_AVAILABLE, acceptLicenses: true }, context(30, () => allowed));
  assert.deepEqual([interrupted.state, interrupted.result.code], ["unknown", "interrupted"]);
  f.tools.update(state => { state.android.hang = false; state.android.vanish = true; });
  const unverified = await provider.runtimeOperation("runtime-install", { identifier: ANDROID_AVAILABLE, acceptLicenses: true }, context(30));
  assert.deepEqual([unverified.state, unverified.result.code], ["unknown", "not_verified"]);
  f.tools.update(state => { state.android.vanish = false; state.android.fail = true; });
  const failed = await provider.runtimeOperation("runtime-install", { identifier: ANDROID_AVAILABLE, acceptLicenses: true }, context(30));
  assert.deepEqual([failed.state, failed.result.code, failed.result.exitCode], ["failed", "installer_failed", 1]);
  // The host itself never answers a licence prompt without the request's acknowledgement.
  const before = f.tools.calls("sdkmanager").length;
  const unacknowledged = await provider.runtimeOperation("runtime-install", { identifier: ANDROID_AVAILABLE }, context(30));
  assert.deepEqual([unacknowledged.state, unacknowledged.result.code], ["failed", "license_acknowledgement_required"]);
  assert.equal(f.tools.calls("sdkmanager").length, before);
  assert.equal(installed(f, ANDROID_AVAILABLE), false);
  // No raw installer text is reported.
  assert.ok(!JSON.stringify([timedOut, interrupted, unverified, failed]).includes("Warning"));
  // A listing changes nothing, so a host that cannot read its inventory reports a definite failure.
  const broken = new IosProvider({ ...f.providers.ios.config, xcrun: join(f.bin, "missing-xcrun"), transport: f.providers.ios.transport }, f.state);
  const unreadable = await broken.runtimeOperation("runtime-list", {}, context(30));
  assert.deepEqual([unreadable.state, unreadable.result.code], ["failed", "inventory_unavailable"]);
  const unchanged = await broken.runtimeOperation("runtime-remove", { identifier: IOS_UNUSED }, context(30));
  assert.deepEqual([unchanged.state, unchanged.result.code], ["failed", "tool_unavailable"]);
  assert.deepEqual(parseSdkManagerList("Available Packages:\n  Path | Version | Description\n  system-images;android-35;default;arm64-v8a | 2 | ARM 64 v8a System Image\n  platforms;android-35 | 2 | Android SDK Platform 35\n", "arm64-v8a"),
    [{ identifier: "system-images;android-35;default;arm64-v8a", version: "2", description: "ARM 64 v8a System Image", compatible: true }]);
});

test("removal is refused while a template, device, lease or simulator uses the runtime", async t => {
  const f = await upkeepHarness(t);
  const remove = (name: string, target = "android") => ({ id: randomUUID(), kind: "runtime-remove", arguments: { platform: target, identifier: name } });
  // An advertised template pins it: refused by the controller, and nothing is queued.
  await assert.rejects(f.request("POST", f.hostPath + "/operations", remove(ANDROID_INSTALLED)), failure(409, "runtime_in_use"));
  await assert.rejects(f.request("POST", f.hostPath + "/operations", remove(IOS_INSTALLED, "ios")), failure(409, "runtime_in_use"));
  assert.deepEqual((await f.request("GET", f.hostPath + "/operations")).body.operations, []);
  // A device left on the host pins an image no template offers: the host itself refuses.
  const stray = { id: randomUUID(), template: { ...f.images.android, device: { systemImage: ANDROID_UNUSED, profile: "pixel_8" } }, resources: { cpu: 2, memoryMiB: 2048, diskGiB: 8 }, desired: "stopped" };
  const strayStorage = f.providers.android.storage(stray, stray.template);
  const held = await f.run("runtime-remove", { platform: "android", identifier: ANDROID_UNUSED });
  assert.deepEqual([held.state, held.result.code, held.result.usedBy], ["failed", "runtime_in_use", ["device-storage"]]);
  assert.equal(f.tools.calls("sdkmanager").filter(call => call.args.includes("--uninstall")).length, 0);
  assert.equal(installed(f, ANDROID_UNUSED), true); assert.ok(existsSync(strayStorage));
  // The listing shows that device beside the image.
  assert.equal((await f.run("runtime-list", { platform: "android" })).result.installed.find((image: any) => image.identifier === ANDROID_UNUSED).devices, 1);

  // iOS: a simulator Canaveral did not create still uses its runtime, and deleting the runtime would shut it down.
  const personal = randomUUID().toUpperCase();
  f.tools.update(state => { state.ios.devices[IOS_UNUSED] = [{ udid: personal, name: "personal iPhone", state: "Booted", isAvailable: true, deviceTypeIdentifier: IOS_DEVICE_TYPE }]; });
  const simulator = await f.run("runtime-remove", { platform: "ios", identifier: IOS_UNUSED });
  assert.deepEqual([simulator.state, simulator.result.code, simulator.result.usedBy], ["failed", "runtime_in_use", ["simulator"]]);
  assert.ok(!f.tools.calls("xcrun").some(call => call.args.includes("delete")));
  assert.deepEqual(f.tools.read().ios.devices[IOS_UNUSED]!.map(device => [device.udid, device.state]), [[personal, "Booted"]]);

  // Unused: removed and verified, by the exact disk image the listing named.
  f.tools.update(state => { state.ios.devices = {}; });
  const removed = await f.run("runtime-remove", { platform: "ios", identifier: IOS_UNUSED });
  assert.deepEqual([removed.state, removed.result], ["succeeded", { platform: "ios", identifier: IOS_UNUSED, removed: true }]);
  assert.deepEqual(f.tools.calls("xcrun").filter(call => call.args[1] === "runtime" && call.args[2] === "delete" && call.phase === "start").map(call => call.args[3]), ["B62A22A7-EBA8-4197-AB4F-67796AC63FEE"]);
  assert.deepEqual(f.tools.read().ios.runtimes.map(runtime => runtime.identifier), [IOS_INSTALLED]);
  // A removal the host cannot verify is unknown, never reported as done.
  f.tools.update(state => { state.ios.keepImages = true; state.ios.runtimes.push({ identifier: IOS_UNUSED, version: "26.4", buildversion: "23E200", isAvailable: true, name: "iOS 26.4", imageId: "B62A22A7-EBA8-4197-AB4F-67796AC63FEE", deletable: true }); });
  const unverified = await f.run("runtime-remove", { platform: "ios", identifier: IOS_UNUSED });
  assert.deepEqual([unverified.state, unverified.result.code], ["unknown", "not_verified"]);

  // Android, once the stray device is gone.
  rmSync(strayStorage, { recursive: true });
  const gone = await f.run("runtime-remove", { platform: "android", identifier: ANDROID_UNUSED });
  assert.deepEqual([gone.state, gone.result.removed], ["succeeded", true]);
  assert.equal(installed(f, ANDROID_UNUSED), false); assert.equal(installed(f, ANDROID_INSTALLED), true);
});

test("a device or live lease placed on the host holds its runtime after its template is withdrawn", async t => {
  const f = await upkeepHarness(t);
  const machine = await f.createMachine("android-phone");
  await f.poll();
  // Even with no template in the ledger, the placed device still pins the image.
  f.store.transaction(db => { db.prepare("UPDATE hosts SET offer=json_set(offer,'$.templates',json('[]')) WHERE id=?").run(f.hostId); db.prepare("DELETE FROM host_image_inventory WHERE host=?").run(f.hostId); });
  await assert.rejects(f.request("POST", f.hostPath + "/operations", { id: randomUUID(), kind: "runtime-remove", arguments: { platform: "android", identifier: ANDROID_INSTALLED } }), failure(409, "runtime_in_use"));
  // A leased device counts the same way.
  f.store.transaction(db => { db.exec("CREATE TABLE IF NOT EXISTS lease_members (lease TEXT NOT NULL,name TEXT NOT NULL,machine TEXT NOT NULL UNIQUE,PRIMARY KEY(lease,name))"); db.prepare("INSERT INTO lease_members VALUES (?,?,?)").run(randomUUID(), "primary", machine.id); });
  await assert.rejects(f.request("POST", f.hostPath + "/operations", { id: randomUUID(), kind: "runtime-remove", arguments: { platform: "android", identifier: ANDROID_INSTALLED } }), failure(409, "runtime_in_use"));
});

test("only administrators reach runtime and upkeep routes, and requests are validated before anything is queued", async t => {
  const f = await upkeepHarness(t);
  const routes: [string, string, Record<string, unknown>][] = [["GET", f.hostPath + "/runtimes", {}], ["GET", f.hostPath + "/upkeep", {}], ["GET", f.hostPath + "/operations", {}],
    ["GET", `/v1/host-operations/${randomUUID()}`, {}], ["POST", f.hostPath + "/operations", { id: randomUUID(), kind: "runtime-list", arguments: { platform: "android" } }]];
  // Application, lease, enrollment, host and guest credentials are not accounts: no principal resolves.
  const stranger = (): Principal => { throw new ServiceError("Credential rejected.", 401); };
  // A signed-in user, or an administrator's token without the admin scope, is refused too.
  const user = (): Principal => ({ kind: "session", user: { id: randomUUID(), username: "owner", role: "user", status: "active" }, scopes: ["machines:read", "machines:write", "machines:access"] });
  const scoped = (): Principal => ({ kind: "token", user: { id: randomUUID(), username: "admin", role: "admin", status: "active" }, scopes: ["machines:read", "machines:write", "machines:access"] });
  for (const [method, path, body] of routes) {
    await assert.rejects(f.request(method, path, body, stranger), failure(401));
    await assert.rejects(f.request(method, path, body, user), failure(403));
    await assert.rejects(f.request(method, path, body, scoped), failure(403));
  }
  assert.deepEqual((await f.request("GET", f.hostPath + "/operations")).body.operations, []);
  const admin = (): Principal => ({ kind: "token", user: { id: "6f0c7d0e-1c1b-4a55-9a52-0d3a3c0f8f11", username: "admin", role: "admin", status: "active" }, scopes: ["admin"] });
  const accepted = await f.request("POST", f.hostPath + "/operations", { id: randomUUID(), kind: "runtime-list", arguments: { platform: "android" } }, admin);
  assert.equal(accepted.body.requestedBy, "token:6f0c7d0e-1c1b-4a55-9a52-0d3a3c0f8f11");

  const submit = (kind: unknown, args: unknown, extra: Record<string, unknown> = {}) => f.request("POST", f.hostPath + "/operations", { id: randomUUID(), kind, arguments: args, ...extra } as Record<string, unknown>);
  for (const [kind, args] of [["runtime-download", { platform: "android" }], ["runtime-list", { platform: "tvos" }], ["runtime-list", { platform: "android", force: true }],
    ["runtime-install", { platform: "android", identifier: "platform-tools", acceptLicenses: true }], ["runtime-install", { platform: "android", identifier: "system-images;android-36;google_apis;arm64-v8a;../x", acceptLicenses: true }],
    ["runtime-install", { platform: "ios", identifier: IOS_AVAILABLE, acceptLicenses: true }], ["runtime-install", { platform: "ios", identifier: "com.apple.CoreSimulator.SimRuntime.tvOS-27-2" }],
    ["runtime-install", { platform: "android", identifier: ANDROID_AVAILABLE, acceptLicenses: true, timeoutSeconds: 10 }], ["runtime-remove", { platform: "android", identifier: "--all" }],
    ["storage-inspect", { path: "/" }], ["storage-purge", { inspection: randomUUID(), entries: ["../etc"] }], ["storage-purge", { inspection: randomUUID(), entries: [] }]] as [string, unknown][]) {
    await assert.rejects(submit(kind, args), failure(400), `${kind} ${JSON.stringify(args)}`);
  }
  await assert.rejects(submit("runtime-list", { platform: "android" }, { hostId: f.hostId }), failure(400));
  await assert.rejects(f.request("POST", `/v1/hosts/${randomUUID()}/operations`, { id: randomUUID(), kind: "runtime-list", arguments: { platform: "android" } }), failure(404));
  await assert.rejects(f.request("GET", `/v1/host-operations/${randomUUID()}`), failure(404));
  assert.equal((await f.request("GET", f.hostPath + "/operations")).body.operations.length, 1);
});

test("a host cannot report another host's operation, and only what a heartbeat delivers counts as collected", async t => {
  const f = await upkeepHarness(t), other = f.standIn();
  const listing = await f.operation("runtime-list", { platform: "android" });
  // The operation belongs to the fixture's real host. Another host's credential cannot settle it.
  for (const report of [{ state: "succeeded", result: { platform: "android", installed: [] } }, { state: "running" }, { state: "failed", result: {} }])
    assert.throws(() => other.beat({ hostOperationReports: { [listing.id]: report } }), failure(403));
  assert.throws(() => other.beat({ hostOperationReports: { [randomUUID()]: { state: "succeeded", result: {} } } }), failure(403));
  assert.equal((await f.receipt(listing.id)).state, "queued");
  // The refused heartbeat changed nothing else either: the other host still gets none of it.
  assert.deepEqual(other.beat().hostOperations, []);

  // One heartbeat delivers at most eight operations. The ninth was never collected, so it fails
  // as never started; the eight that were collected and then lost end unknown.
  const queued: string[] = [];
  for (let index = 0; index < 9; index++) queued.push(((await f.request("POST", other.path + "/operations", { id: randomUUID(), kind: "runtime-list", arguments: { platform: "android" } })).body as { id: string }).id);
  assert.deepEqual((other.beat().hostOperations as { id: string }[]).map(operation => operation.id), queued.slice(0, 8));
  f.advance(121);
  assert.deepEqual([(await f.receipt(queued[8]!)).state, (await f.receipt(queued[8]!)).result.code], ["failed", "expired"]);
  assert.deepEqual(await Promise.all(queued.slice(0, 8).map(async id => (await f.receipt(id)).state)), Array(8).fill("queued"));
  f.advance(420);
  assert.deepEqual(await Promise.all(queued.slice(0, 8).map(async id => (await f.receipt(id)).state)), Array(8).fill("unknown"));
});

test("a listing acknowledges an unknown change only when it was submitted after the change ended", async t => {
  const f = await upkeepHarness(t), other = f.standIn();
  const submit = async (kind: string, args: Record<string, unknown>) => (await f.request("POST", other.path + "/operations", { id: randomUUID(), kind, arguments: args })).body as { id: string };
  const install = await submit("runtime-install", { platform: "android", identifier: ANDROID_AVAILABLE, acceptLicenses: true });
  // Submitted while the install was still running: whatever it lists, it says nothing about how the install ended.
  const early = await submit("runtime-list", { platform: "android" });
  assert.equal(other.beat().hostOperations.length, 2);
  other.beat({ hostOperationReports: { [install.id]: { state: "unknown", result: { code: "timeout", detail: "fixture" } } } });
  const listed = { state: "succeeded", result: { platform: "android", installed: [], available: { state: "unavailable" } } };
  other.beat({ hostOperationReports: { [early.id]: listed } });
  assert.equal((await f.receipt(early.id)).state, "succeeded");
  assert.equal((await f.receipt(install.id)).acknowledgedAt, undefined);
  const retry = { id: randomUUID(), kind: "runtime-install", arguments: { platform: "android", identifier: ANDROID_AVAILABLE, acceptLicenses: true } };
  await assert.rejects(f.request("POST", other.path + "/operations", retry), failure(409, "host_inspection_required"));
  // A storage inspection is about storage, not runtimes.
  const inspection = await submit("storage-inspect", {});
  other.beat(); other.beat({ hostOperationReports: { [inspection.id]: { state: "succeeded", result: { complete: true, entries: [] } } } });
  await assert.rejects(f.request("POST", other.path + "/operations", retry), failure(409, "host_inspection_required"));
  const later = await submit("runtime-list", { platform: "android" });
  other.beat(); other.beat({ hostOperationReports: { [later.id]: listed } });
  assert.ok((await f.receipt(install.id)).acknowledgedAt > 0);
  assert.equal((await f.request("POST", other.path + "/operations", retry)).status, 201);
});

test("what a runner advertised does not outlive it: no upkeep report, no operations", async t => {
  const f = await upkeepHarness(t), other = f.standIn();
  const queued = (await f.request("POST", other.path + "/operations", { id: randomUUID(), kind: "runtime-list", arguments: { platform: "android" } })).body as { id: string };
  // The runner is replaced by one that advertises no upkeep: an older build, or a host file without mobile runtimes.
  assert.deepEqual(other.beat({}, null).hostOperations, []);
  assert.deepEqual((await f.request("GET", other.path + "/runtimes")).body, { hostId: other.id, supported: false, platforms: [] });
  await assert.rejects(f.request("POST", other.path + "/operations", { id: randomUUID(), kind: "runtime-list", arguments: { platform: "android" } }), failure(409, "upkeep_unsupported"));
  await assert.rejects(f.request("POST", other.path + "/operations", { id: randomUUID(), kind: "storage-inspect", arguments: {} }), failure(409, "upkeep_unsupported"));
  // What was queued for the old runner is never handed to the new one, and fails as never started.
  f.advance(121); other.beat({}, null);
  assert.deepEqual([(await f.receipt(queued.id)).state, (await f.receipt(queued.id)).result.code], ["failed", "expired"]);
  // A runner that drops one platform keeps the other.
  const both = f.standIn(["android", "ios"]);
  both.beat({}, { version: 1, platforms: ["ios"], idleStop: { defaultSeconds: null, templates: {} }, busy: [] });
  await assert.rejects(f.request("POST", both.path + "/operations", { id: randomUUID(), kind: "runtime-list", arguments: { platform: "android" } }), failure(409, "upkeep_unsupported"));
  assert.equal((await f.request("POST", both.path + "/operations", { id: randomUUID(), kind: "runtime-list", arguments: { platform: "ios" } })).status, 201);
});

test("an unknown change blocks drain resume until it is re-inspected or an administrator records a decision", async t => {
  const f = await upkeepHarness(t);
  f.tools.update(state => { state.android.vanish = true; });
  const lost = await f.run("runtime-install", { platform: "android", identifier: ANDROID_AVAILABLE, acceptLicenses: true });
  assert.deepEqual([lost.state, lost.result.code], ["unknown", "not_verified"]);
  const drain = (await f.request("POST", f.hostPath + "/maintenance", { id: randomUUID() })).body as { id: string };
  const status = async (): Promise<any> => (await f.request("GET", f.hostPath + "/maintenance")).body;
  await f.pump(async () => (await status()).blockers.every((blocker: any) => blocker.id === lost.id), "the drain to settle on the unknown install");
  const blocked = await status();
  assert.deepEqual(blocked.blockers.map((blocker: any) => [blocker.kind, blocker.id, blocker.state, blocker.blocks]), [["uncertainOperation", lost.id, "unknown", ["powerOff", "resume"]]]);
  assert.deepEqual([blocked.safeToPowerOff, blocked.readyToResume], [false, false]);
  const refused = await f.request("POST", `${f.hostPath}/maintenance/${drain.id}/resume`, { requestId: randomUUID() });
  assert.deepEqual([refused.status, refused.body.code], [409, "maintenance_blocked"]);

  // Only an administrator may decide, with a stated decision and reason.
  const route = `/v1/host-operations/${lost.id}/resolve`, decision = { id: randomUUID(), decision: "abandoned", reason: "Android was removed from this host; nothing can list it." };
  const user = (): Principal => ({ kind: "session", user: { id: randomUUID(), username: "owner", role: "user", status: "active" }, scopes: ["machines:read", "machines:write", "machines:access"] });
  await assert.rejects(f.request("POST", route, decision, user), failure(403));
  await assert.rejects(f.request("POST", route, decision, () => { throw new ServiceError("Credential rejected.", 401); }), failure(401));
  for (const invalid of [{ ...decision, decision: "retry" }, { ...decision, reason: "" }, { ...decision, reason: "x".repeat(1001) }, { id: decision.id, decision: "abandoned" }, { ...decision, force: true }])
    await assert.rejects(f.request("POST", route, invalid), failure(400));
  await assert.rejects(f.request("POST", `/v1/host-operations/${randomUUID()}/resolve`, decision), failure(404));
  assert.equal((await f.receipt(lost.id)).acknowledgedAt, undefined);
  const administrator = (): Principal => ({ kind: "token", user: { id: "0d7a1b0e-52a4-4a55-8f3e-6f0c7d0e1c1b", username: "operator-on-call", role: "admin", status: "active" }, scopes: ["admin"] });
  const resolved = await f.request("POST", route, decision, administrator);
  assert.equal(resolved.status, 201);
  // The receipt keeps its outcome: nothing is retried or rewritten, only acknowledged.
  assert.deepEqual([resolved.body.state, resolved.body.result.code, resolved.body.acknowledgedAt > 0], ["unknown", "not_verified", true]);
  assert.deepEqual({ ...resolved.body.resolution, decidedAt: null }, { id: decision.id, decision: "abandoned", reason: decision.reason, decidedAt: null,
    decidedBy: { kind: "token", userId: "0d7a1b0e-52a4-4a55-8f3e-6f0c7d0e1c1b", username: "operator-on-call" } });
  // A lost reply is safe to repeat; a changed or second decision is a conflict.
  const replay = await f.request("POST", route, decision);
  assert.deepEqual([replay.status, replay.body.resolution], [200, resolved.body.resolution]);
  await assert.rejects(f.request("POST", route, { ...decision, reason: "Another reason." }), failure(409));
  await assert.rejects(f.request("POST", route, { ...decision, decision: "inspected" }), failure(409));
  await assert.rejects(f.request("POST", route, { ...decision, id: randomUUID() }), failure(409));
  assert.deepEqual((await f.receipt(lost.id)).resolution, resolved.body.resolution);
  assert.equal(f.tools.calls("sdkmanager").filter(call => call.args.includes("--install") && call.phase === "start").length, 1);

  // The drain can now be resumed, and the platform accepts changes again.
  await f.pump(async () => (await status()).readyToResume === true, "the drain to become resumable");
  assert.deepEqual((await status()).blockers, []);
  const resumed = await f.request("POST", `${f.hostPath}/maintenance/${drain.id}/resume`, { requestId: randomUUID() });
  assert.deepEqual([resumed.status, resumed.body.phase], [200, "resumed"]);
  f.tools.update(state => { state.android.vanish = false; });
  const again = await f.run("runtime-install", { platform: "android", identifier: ANDROID_AVAILABLE, acceptLicenses: true });
  assert.equal(again.state, "succeeded");
  // Only an unknown change that nothing has acknowledged can be resolved.
  await assert.rejects(f.request("POST", `/v1/host-operations/${again.id}/resolve`, { ...decision, id: randomUUID() }), failure(409));
  const listed = await f.run("runtime-list", { platform: "android" });
  await assert.rejects(f.request("POST", `/v1/host-operations/${listed.id}/resolve`, { ...decision, id: randomUUID() }), failure(409));
  f.tools.update(state => { state.android.vanish = true; });
  const second = await f.run("runtime-install", { platform: "android", identifier: "system-images;android-33;google_apis;arm64-v8a", acceptLicenses: true });
  assert.equal(second.state, "unknown");
  await f.run("runtime-list", { platform: "android" });
  // Already acknowledged by the listing: no decision is needed, and none is recorded.
  await assert.rejects(f.request("POST", `/v1/host-operations/${second.id}/resolve`, { ...decision, id: randomUUID() }), failure(409));
  assert.equal((await f.receipt(second.id)).resolution, undefined);
});

test("a decision can be recorded for a host that can no longer be listed", async t => {
  const f = await upkeepHarness(t), other = f.standIn();
  const install = (await f.request("POST", other.path + "/operations", { id: randomUUID(), kind: "runtime-install", arguments: { platform: "android", identifier: ANDROID_AVAILABLE, acceptLicenses: true } })).body as { id: string };
  other.beat(); other.beat({ hostOperationReports: { [install.id]: { state: "unknown", result: { code: "timeout", detail: "fixture" } } } });
  // The operator removes Android from the host file. No listing can be submitted for it any more.
  other.beat({}, null);
  await assert.rejects(f.request("POST", other.path + "/operations", { id: randomUUID(), kind: "runtime-list", arguments: { platform: "android" } }), failure(409, "upkeep_unsupported"));
  assert.deepEqual((await f.request("GET", other.path + "/upkeep")).body.pending.map((operation: any) => [operation.id, operation.state]), [[install.id, "unknown"]]);
  const resolved = await f.request("POST", `/v1/host-operations/${install.id}/resolve`, { id: randomUUID(), decision: "inspected", reason: "Checked the SDK directory over SSH: the image is not installed." });
  assert.deepEqual([resolved.status, resolved.body.resolution.decision, resolved.body.resolution.decidedBy], [201, "inspected", { kind: "operator", userId: null, username: null }]);
  assert.deepEqual((await f.request("GET", other.path + "/upkeep")).body.pending, []);
  assert.deepEqual((await f.request("GET", other.path + "/operations")).body.operations[0].resolution, resolved.body.resolution);
});

test("a runner that will not start an operation says so: a missed start window and an update fence fail as never started", async t => {
  const f = await upkeepHarness(t);
  // Collected, but the runner gets to it only after the start window.
  const late = await f.operation("runtime-install", { platform: "android", identifier: ANDROID_AVAILABLE, acceptLicenses: true });
  await f.poll();
  f.advance(121);
  assert.equal((await f.receipt(late.id)).state, "queued");
  await f.poll(); await f.runner().step(); await f.poll();
  assert.deepEqual([(await f.receipt(late.id)).state, (await f.receipt(late.id)).result.code], ["failed", "expired"]);
  // A runner fenced for an update declines at once instead of holding the operation to its deadline.
  f.runner().fenceUpdateAdmission();
  const fenced = await f.operation("runtime-install", { platform: "android", identifier: ANDROID_AVAILABLE, acceptLicenses: true });
  const listing = await f.operation("runtime-list", { platform: "android" });
  await f.poll(); await f.runner().step(); await f.poll();
  for (const id of [fenced.id, listing.id]) assert.deepEqual([(await f.receipt(id)).state, (await f.receipt(id)).result.code], ["failed", "update_fenced"]);
  // A failed change needs no re-inspection, and the runner holds nothing that would keep it from quiescing.
  await f.poll();
  assert.deepEqual((f.lastBeat.hostOperationReports as Record<string, unknown>), {});
  assert.deepEqual((await f.runner().updateIdle()), { idle: true, workloadsStopped: true });
  assert.equal(f.tools.calls("sdkmanager").length, 0);
  assert.equal(installed(f, ANDROID_AVAILABLE), false);
  f.runner().resumeUpdateAdmission();
  assert.equal((await f.run("runtime-list", { platform: "android" })).state, "succeeded");

  // The controller refuses new operations for a host that is draining for a runtime update.
  updatesModule(f.store, f.settings);
  f.store.transaction(db => db.prepare(`INSERT INTO host_update_jobs (id,rollout,host,target_kind,release,attempt,installation,credential,phase,components,created,updated)
    VALUES (?,?,?,'host','fixture-release',?,?,'fixture','draining','[]',0,0)`).run(randomUUID(), randomUUID(), f.hostId, randomUUID(), randomUUID()));
  for (const [kind, args] of [["runtime-list", { platform: "android" }], ["runtime-install", { platform: "android", identifier: ANDROID_AVAILABLE, acceptLicenses: true }], ["storage-inspect", {}]] as [string, Record<string, unknown>][])
    await assert.rejects(f.request("POST", f.hostPath + "/operations", { id: randomUUID(), kind, arguments: args }), failure(409, "host_draining"));
  f.store.transaction(db => db.exec("UPDATE host_update_jobs SET phase='succeeded'"));
  assert.equal((await f.request("POST", f.hostPath + "/operations", { id: randomUUID(), kind: "runtime-list", arguments: { platform: "android" } })).status, 201);
});
