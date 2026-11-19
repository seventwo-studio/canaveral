// Native two-agent Android lease trial. Creates its own disposable controller, runner,
// AVDs and applications in a private temporary directory, on a host sized for exactly
// one emulator. Never touches pre-existing AVDs or emulators.
//
//   node native-acceptance/android-lease-agents.mjs /path/to/trial.apk
//
// Pauses (waiting for a file named in the output) so an operator can observe each
// leased emulator with external device tools, which see it through adb.
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { startController } from "../dist/src/main.js";
import { HostRunner } from "../dist/src/host.js";

const apk = process.argv[2];
if (!apk) throw Error("Pass the trial APK path.");
const sdk = process.env.ANDROID_HOME;
if (!sdk) throw Error("Set ANDROID_HOME.");
const helper = fileURLToPath(new URL("../../native/canaveral-mobile-native", import.meta.url));
assert.ok(existsSync(helper), "Build canaveral-mobile-native and run script/prepare_native.mjs first.");
const bundle = "test.canaveral.dashboardtrial", activity = bundle + "/.TrialActivity", label = "Canaveral dashboard install trial";
const stock = join(homedir(), ".android/avd");
const root = await mkdtemp(join(await realpath(tmpdir()), "android-lease-agents-"));
const log = [];
const note = (event, data = {}) => { const entry = { at: new Date().toISOString(), event, ...data }; log.push(entry); console.log(JSON.stringify(entry)); };
const save = () => writeFile(join(root, "trial.json"), JSON.stringify(log, null, 2), { mode: 0o600 });
async function until(check, description, ms = 300000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await delay(250); }
  throw Error("Timed out waiting for " + description);
}
async function pause(name, data) {
  const file = join(root, "continue-" + name);
  note("observe", { name, continueFile: file, ...data }); await save();
  await until(() => existsSync(file), "operator observation " + name, 3600000);
}
const pgrep = pattern => { try { return execFileSync("/usr/bin/pgrep", ["-f", pattern], { encoding: "utf8" }).trim().split("\n").filter(Boolean); } catch { return []; } };
const inventory = async () => [
  (await readdir(stock)).sort(),
  await readFile(join(stock, "Pixel_API_36.ini"), "utf8"),
  (await stat(join(stock, "Pixel_API_36.avd"))).ino,
  createHash("sha256").update(await readFile(join(stock, "Pixel_API_36.avd", "config.ini"))).digest("hex"),
];

let controller, runner;
const before = await inventory();
try {
  const admin = randomBytes(32).toString("hex"), enrollment = randomBytes(32).toString("hex");
  await writeFile(join(root, "admin"), admin, { mode: 0o600 }); await writeFile(join(root, "enroll"), enrollment, { mode: 0o600 });
  controller = await startController({ statePath: join(root, "db"), adminTokenFile: join(root, "admin"), enrollmentTokenFile: join(root, "enroll"), controllerId: randomUUID(), listen: { host: "127.0.0.1", port: 0 } });
  const url = "http://127.0.0.1:" + controller.address.port;
  const image = { id: "lease-android", revision: "1", os: "android", arch: "arm64", mode: "device", minimum: { cpu: 2, memoryMiB: 4096, diskGiB: 12 },
    device: { systemImage: "system-images;android-36;google_apis_playstore;arm64-v8a", profile: "pixel_8" } };
  runner = new HostRunner({ url, stateDir: join(root, "runner"), storage: join(root, "devices"), name: "lease-trial-mac", provider: "android", androidSDK: sdk,
    templates: [image], enrollmentToken: enrollment, capacity: { cpu: 2, memoryMiB: 4096, diskGiB: 12 }, pollIntervalSeconds: 1,
    leaseClockHelper: helper, leaseSupervisor: helper, leaseProtocol: 1, leaseImages: [{ id: image.id, revision: "1", arch: "arm64", runtime: "android" }] });
  await runner.start();
  const api = async (method, route, body, token = admin) => {
    const response = await fetch(url + route, { method, headers: { Authorization: "Bearer " + token, ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  const application = async name => {
    const created = await api("POST", "/v1/consumers", { id: randomUUID(), name, templates: [{ id: image.id, revision: "1", arch: "arm64" }],
      limits: { resources: { cpu: 2, memoryMiB: 4096, diskGiB: 12 }, activeLeases: 1, defaultTTLSeconds: 240, maxTTLSeconds: 900, maxLifetimeSeconds: 900, provisioningTimeoutSeconds: 600 } });
    assert.equal(created.status, 200, JSON.stringify(created.body)); return created.body.credential;
  };
  const request = async (app, ttlSeconds) => {
    const id = randomUUID(), body = { id, kind: "lease", intent: { templateId: image.id, templateRevision: "1", arch: "arm64", ttlSeconds }, deadline: new Date(Date.now() + 1800000).toISOString() };
    const submitted = await api("POST", "/v1/requests", body, app);
    assert.equal(submitted.status, 201, JSON.stringify(submitted.body));
    assert.equal((await api("POST", "/v1/requests", body, app)).status, 200, "lost-reply replay");
    return id;
  };
  const ready = async (app, id) => {
    await until(async () => (await api("GET", "/v1/requests/" + id, undefined, app)).body.state === "admitted", "admission");
    note("admitted", { lease: id });
    const lease = await until(async () => { const view = (await api("GET", "/v1/leases/" + id, undefined, app)).body; if (view.state === "failed") throw Error(JSON.stringify(view)); return view.state === "ready" && view; }, "a booted, checked emulator", 600000);
    const key = (await api("POST", "/v1/leases/" + id + "/credential", {}, app)).body.credential;
    note("ready", { lease: id, machineId: lease.members[0].machineId, member: lease.members[0] });
    return { id, key, machineId: lease.members[0].machineId };
  };
  const operate = async (lease, key, action, args = {}) => {
    const id = randomUUID(), submitted = await api("POST", `/v1/leases/${lease}/operations`, { id, member: "primary", action, arguments: args }, key);
    if (submitted.status >= 300) return submitted;
    return until(async () => { const current = await api("GET", `/v1/leases/${lease}/operations/${id}`, undefined, key); return current.body.state !== "queued" && current; }, action + " receipt", 120000);
  };
  const appA = await application("agent-a"), appB = await application("agent-b");

  // Agent A acquires the only emulator, installs the real APK and drives it.
  const a = await ready(appA, await request(appA, 240));
  const storageA = join(root, "devices", a.machineId), recordA = JSON.parse(await readFile(join(storageA, "lease-supervisor.json"), "utf8"));
  note("supervised", { lease: a.id, emulatorPid: recordA.childPid, supervisorPid: recordA.supervisorPid, processes: pgrep("cvm-" + a.machineId).length });
  const bytes = await readFile(apk);
  const push = await operate(a.id, a.key, "push", { path: "/data/local/tmp/canaveral-trial.apk", data: bytes.toString("base64") });
  const install = await operate(a.id, a.key, "shell", { argv: ["pm", "install", "-r", "/data/local/tmp/canaveral-trial.apk"] });
  const launch = await operate(a.id, a.key, "launch", { app: activity });
  await delay(3000);
  const hierarchy = await operate(a.id, a.key, "hierarchy");
  const screenshot = await operate(a.id, a.key, "screenshot");
  if (screenshot.body.state === "succeeded") await writeFile(join(root, "agent-a.png"), Buffer.from(screenshot.body.result.data, "base64"));
  const tap = await operate(a.id, a.key, "tap", { x: 540, y: 1200 });
  const logs = await operate(a.id, a.key, "logs");
  note("agent-a-drove", { apkBytes: bytes.length, apkSha256: createHash("sha256").update(bytes).digest("hex"), push: push.body.state, install: [install.body.state, install.body.result?.output],
    launch: launch.body.state, labelVisible: String(hierarchy.body.result?.output ?? "").includes(label), screenshot: screenshot.body.state, tap: tap.body.state, logs: logs.body.state });

  // Agent B's request waits: the host is full.
  const requestB = await request(appB, 240);
  await delay(5000);
  note("agent-b-waiting", { request: (await api("GET", "/v1/requests/" + requestB, undefined, appB)).body.state, reserved: (await api("GET", "/v1/hosts")).body.hosts[0].reserved });
  await pause("a", { serial: "emulator-" + JSON.parse(await readFile(join(storageA, "endpoint.json"), "utf8")).port, avd: "cvm-" + a.machineId });

  // Agent A disconnects: no renewal, no release, no further calls until its lease expires.
  note("agent-a-disconnected", { expiresAt: (await api("GET", "/v1/leases/" + a.id, undefined, appA)).body.expiresAt });
  const stoppedA = await until(async () => { try { return JSON.parse(await readFile(join(storageA, "lease-stopped.json"), "utf8")); } catch { return undefined; } }, "the supervisor's stop receipt", 900000);
  note("supervisor-stopped", { receipt: stoppedA, emulatorAlive: (() => { try { process.kill(recordA.childPid, 0); return true; } catch { return false; } })(), processes: pgrep("cvm-" + a.machineId) });
  await until(async () => (await api("GET", "/v1/leases/" + a.id, undefined, appA)).body.state === "expired", "controller expiry");
  const refusedTap = await api("POST", `/v1/leases/${a.id}/operations`, { id: randomUUID(), member: "primary", action: "tap", arguments: { x: 540, y: 1200 } }, a.key);
  const refusedShot = await api("POST", `/v1/leases/${a.id}/operations`, { id: randomUUID(), member: "primary", action: "screenshot", arguments: {} }, a.key);
  note("agent-a-refused", { tap: [refusedTap.status, refusedTap.body.code], screenshot: [refusedShot.status, refusedShot.body.code] });
  const cleanupA = await until(async () => { const view = (await api("GET", "/v1/leases/" + a.id, undefined, appA)).body; return view.cleanup.state === "complete" && view; }, "proven cleanup", 300000);
  note("agent-a-cleaned", { cleanup: cleanupA.members[0].cleanup, storageRemoved: !existsSync(storageA), avdRegistration: existsSync(join(root, "devices", "avds", `cvm-${a.machineId}.ini`)), processes: pgrep("cvm-" + a.machineId) });

  // Agent B is admitted to a clean, usable emulator.
  const b = await ready(appB, requestB);
  const packages = await operate(b.id, b.key, "apps");
  const shotB = await operate(b.id, b.key, "screenshot");
  if (shotB.body.state === "succeeded") await writeFile(join(root, "agent-b.png"), Buffer.from(shotB.body.result.data, "base64"));
  const tapB = await operate(b.id, b.key, "tap", { x: 540, y: 1200 });
  const crossA = await api("POST", `/v1/leases/${b.id}/operations`, { id: randomUUID(), member: "primary", action: "tap", arguments: { x: 1, y: 1 } }, a.key);
  note("agent-b-clean", { machineId: b.machineId, distinct: b.machineId !== a.machineId, trialPackagePresent: String(packages.body.result?.output ?? "").includes(bundle), apps: packages.body.state, screenshot: shotB.body.state, tap: tapB.body.state, agentAKeyOnB: crossA.status });
  await pause("b", { serial: "emulator-" + JSON.parse(await readFile(join(root, "devices", b.machineId, "endpoint.json"), "utf8")).port, avd: "cvm-" + b.machineId });

  assert.equal((await api("POST", `/v1/leases/${b.id}/release`, { id: randomUUID() }, b.key)).status, 200);
  const cleanupB = await until(async () => { const view = (await api("GET", "/v1/leases/" + b.id, undefined, appB)).body; return view.cleanup.state === "complete" && view; }, "B cleanup", 300000);
  note("agent-b-cleaned", { cleanup: cleanupB.members[0].cleanup, reserved: (await api("GET", "/v1/hosts")).body.hosts[0].reserved, processes: pgrep("cvm-" + b.machineId) });
} catch (error) {
  note("failed", { error: String(error?.stack ?? error) });
  process.exitCode = 1;
} finally {
  await save().catch(() => {});
  await runner?.close().catch(() => {}); await controller?.close().catch(() => {});
  // Supervisors carry their private storage path; emulators carry their owned AVD name.
  const leftovers = [...pgrep(join(root, "devices")), ...pgrep("-avd cvm-")];
  note("closed", { leftoverProcesses: leftovers });
  const after = await inventory();
  note("baseline", { stockInventoryUnchanged: JSON.stringify(after) === JSON.stringify(before) });
  await writeFile(join(tmpdir(), "android-lease-agents-" + Date.now() + ".json"), JSON.stringify(log, null, 2), { mode: 0o600 });
  if (!leftovers.length) await rm(root, { recursive: true, force: true });
  note("removed", { root, absent: !existsSync(root) });
}
