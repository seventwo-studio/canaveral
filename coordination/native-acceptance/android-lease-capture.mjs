// Native Android lease capture trial for the CI and marketing-capture workflow: a job leases
// an emulator, installs its real build (larger than one 512 KiB push) through the lease key,
// drives named screens, takes PNGs and records a 30-second MP4, all through the lease key.
// A second recording then outlives the lease: expiry must end it, cleanup must be proven and
// the reservation released. Creates its own disposable controller, runner, AVD and
// application in a private temporary directory. Never touches pre-existing AVDs or emulators.
//
//   ANDROID_HOME=... node native-acceptance/android-lease-capture.mjs /path/to/large.apk /path/to/ffmpeg
//
// Pauses (waiting for a file named in the output) so an operator can observe the leased
// emulator with external device tools, which see it through adb.
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, openSync, closeSync, writeSync } from "node:fs";
import { mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { startController } from "../dist/src/main.js";
import { HostRunner } from "../dist/src/host.js";
import { LeaseClient } from "../dist/src/sdk.js";

const [apk, ffmpeg] = process.argv.slice(2);
if (!apk || !ffmpeg) throw Error("Pass the trial APK and an absolute ffmpeg path.");
const sdk = process.env.ANDROID_HOME;
if (!sdk) throw Error("Set ANDROID_HOME.");
const ffprobe = join(ffmpeg, "..", "ffprobe");
const helper = fileURLToPath(new URL("../../native/canaveral-mobile-native", import.meta.url));
assert.ok(existsSync(helper), "Build canaveral-mobile-native and run script/prepare_native.mjs first.");
const bundle = "test.canaveral.dashboardtrial", activity = bundle + "/.TrialActivity", label = "Canaveral dashboard install trial";
const stock = join(homedir(), ".android/avd");
const root = await mkdtemp(join(await realpath(tmpdir()), "android-lease-capture-"));
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
const pgrep = pattern => { try { return execFileSync("/usr/bin/pgrep", ["-f", "--", pattern], { encoding: "utf8" }).trim().split("\n").filter(Boolean); } catch { return []; } };
const helpers = () => Object.fromEntries(["netsimd", "crashpad_handler", "qemu-system", "screenrecord", "ffmpeg"].map(name => [name, pgrep(name)]));
const inventory = async () => [
  (await readdir(stock)).sort(),
  await readFile(join(stock, "Pixel_API_36.ini"), "utf8"),
  (await stat(join(stock, "Pixel_API_36.avd"))).ino,
  createHash("sha256").update(await readFile(join(stock, "Pixel_API_36.avd", "config.ini"))).digest("hex"),
];
const png = bytes => ({ bytes: bytes.length, signature: bytes.subarray(0, 8).toString("hex") === "89504e470d0a1a0a", width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) });
function probe(file) {
  const info = JSON.parse(execFileSync(ffprobe, ["-v", "error", "-count_frames", "-show_entries", "format=duration,format_name:stream=codec_name,profile,width,height,nb_read_frames,avg_frame_rate,pix_fmt", "-of", "json", file], { encoding: "utf8" }));
  let decode = "";
  try { decode = execFileSync(ffmpeg, ["-v", "error", "-i", file, "-f", "null", "-"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); } catch (error) { decode = String(error.stderr ?? error); }
  return { format: info.format, stream: info.streams?.[0], decodeErrors: decode.trim() };
}
/** A file writer for the SDK recording sink. */
function fileWriter(file) {
  const fd = openSync(file, "wx", 0o600); let bytes = 0;
  return { write(data) { writeSync(fd, data); bytes += data.length; return data.length; }, close() { closeSync(fd); }, get bytes() { return bytes; } };
}

let controller, runner;
const before = await inventory(), helpersBefore = helpers();
note("baseline-helpers", helpersBefore);
try {
  const admin = randomBytes(32).toString("hex"), enrollment = randomBytes(32).toString("hex");
  await writeFile(join(root, "admin"), admin, { mode: 0o600 }); await writeFile(join(root, "enroll"), enrollment, { mode: 0o600 });
  controller = await startController({ statePath: join(root, "db"), adminTokenFile: join(root, "admin"), enrollmentTokenFile: join(root, "enroll"), controllerId: randomUUID(), listen: { host: "127.0.0.1", port: 0 } });
  const url = "http://127.0.0.1:" + controller.address.port;
  const image = { id: "lease-android", revision: "1", os: "android", arch: "arm64", mode: "device", minimum: { cpu: 2, memoryMiB: 4096, diskGiB: 12 },
    device: { systemImage: "system-images;android-36;google_apis_playstore;arm64-v8a", profile: "pixel_8" } };
  // One emulator, plus one recording (1 CPU, 256 MiB) and one upload's scratch (2 GiB).
  const capacity = { cpu: 3, memoryMiB: 4352, diskGiB: 14 };
  runner = new HostRunner({ url, stateDir: join(root, "runner"), storage: join(root, "devices"), name: "lease-capture-mac", provider: "android", androidSDK: sdk,
    templates: [image], enrollmentToken: enrollment, capacity, pollIntervalSeconds: 1, videoEncoder: ffmpeg,
    leaseClockHelper: helper, leaseSupervisor: helper, leaseProtocol: 1, leaseImages: [{ id: image.id, revision: "1", arch: "arm64", runtime: "android" }] });
  await runner.start();
  const api = async (method, route, body, token = admin) => {
    const response = await fetch(url + route, { method, headers: { Authorization: "Bearer " + token, ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  const reserved = async () => (await api("GET", "/v1/hosts")).body.hosts[0].reserved;
  const created = await api("POST", "/v1/consumers", { id: randomUUID(), name: "ci-capture", templates: [{ id: image.id, revision: "1", arch: "arm64" }],
    limits: { resources: capacity, activeLeases: 1, defaultTTLSeconds: 300, maxTTLSeconds: 900, maxLifetimeSeconds: 900, provisioningTimeoutSeconds: 600 } });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const app = created.body.credential;

  // The job queues a lease request and waits for a booted, checked, isolated emulator.
  const leaseId = randomUUID(), requestBody = { id: leaseId, kind: "lease", intent: { templateId: image.id, templateRevision: "1", arch: "arm64", ttlSeconds: 300 } };
  assert.equal((await api("POST", "/v1/requests", requestBody, app)).status, 201);
  assert.equal((await api("POST", "/v1/requests", requestBody, app)).status, 200, "lost-reply replay");
  const ready = await until(async () => { const view = (await api("GET", "/v1/leases/" + leaseId, undefined, app)).body; if (view.state === "failed") throw Error(JSON.stringify(view)); return view.state === "ready" && view; }, "a booted, checked emulator", 600000);
  const machineId = ready.members[0].machineId, storage = join(root, "devices", machineId);
  const key = (await api("POST", "/v1/leases/" + leaseId + "/credential", {}, app)).body.credential;
  const lease = new LeaseClient({ baseUrl: url, leaseId, leaseKey: key, allowLoopbackHttp: true, timeoutMs: 20000 });
  const supervisor = JSON.parse(await readFile(join(storage, "lease-supervisor.json"), "utf8"));
  note("ready", { lease: leaseId, machineId, expiresAt: ready.expiresAt, emulatorPid: supervisor.childPid, supervisorPid: supervisor.supervisorPid,
    isolation: JSON.parse(await readFile(join(storage, "lease-isolation.json"), "utf8")).isolated });
  const operate = async (action, args = {}) => {
    const id = randomUUID(); await lease.createOperation({ id, member: "primary", action, arguments: args });
    return until(async () => { const current = await lease.operation(id); return current.state !== "queued" && current; }, action + " receipt", 120000);
  };

  // Install the real build through the lease key: chunked, digest-checked, one package session.
  const bytes = await readFile(apk), sha256 = createHash("sha256").update(bytes).digest("hex"), artifact = randomUUID();
  assert.ok(bytes.length > 512 * 1024, "the trial APK must exceed one 512 KiB lease push");
  const uploaded = await lease.uploadApp({ id: artifact, member: "primary", file: apk });
  note("uploaded", { artifact, bytes: uploaded.bytes, sha256: uploaded.sha256, state: uploaded.state, chunks: Math.ceil(uploaded.bytes / uploaded.chunkBytes), reserved: await reserved() });
  const replayUpload = await api("POST", `/v1/leases/${leaseId}/app-artifacts`, { id: artifact, member: "primary", format: "apk", bytes: bytes.length, sha256 }, key);
  const install = randomUUID();
  await lease.installApp({ id: install, member: "primary", artifact });
  const installed = await until(async () => { const current = await lease.operation(install); return current.state !== "queued" && current; }, "install receipt", 600000);
  const replayInstall = await lease.installApp({ id: install, member: "primary", artifact });
  const packages = await operate("apps");
  note("installed", { apkBytes: bytes.length, apkSha256: sha256, receipt: installed.state, result: installed.result, replayUpload: replayUpload.status,
    replayInstall: [replayInstall.created, replayInstall.operation.state], packagePresent: String(packages.result?.output ?? "").includes(bundle) });
  assert.equal(installed.state, "succeeded", JSON.stringify(installed));
  const deleted = await lease.deleteAppArtifact(artifact);
  note("upload-released", { state: deleted.state, reserved: await reserved() });

  // Named screens: the launcher, then the installed app.
  await operate("key", { key: "KEYCODE_HOME" }); await delay(2000);
  const home = await operate("screenshot");
  const homePng = Buffer.from(home.result.data, "base64"); await writeFile(join(root, "screen-launcher-home.png"), homePng);
  await operate("launch", { app: activity }); await delay(3000);
  const hierarchy = await operate("hierarchy");
  const appShot = await operate("screenshot");
  const appPng = Buffer.from(appShot.result.data, "base64"); await writeFile(join(root, "screen-trial-app.png"), appPng);
  note("screens", { "launcher-home": png(homePng), "trial-app": png(appPng), labelVisible: String(hierarchy.result?.output ?? "").includes(label) });

  // A 30-second MP4 through the lease key, with the screen changing throughout.
  const video = randomUUID(), file = join(root, "capture-30s.mp4"), writer = fileWriter(file);
  let driving = true;
  const drive = (async () => { let home = false; while (driving) { await delay(3000); if (!driving) break; await operate(home ? "launch" : "key", home ? { app: activity } : { key: "KEYCODE_HOME" }).catch(() => {}); home = !home; } })();
  const started = Date.now();
  note("recording", { video, reserved: await reserved() });
  const finish = await lease.video.record({ id: video, member: "primary", fps: 30, durationSeconds: 30, bitRate: 4_000_000 }, writer, { timeoutMs: 60000 });
  driving = false; await drive; writer.close();
  const saved = await until(async () => { const view = await lease.video.inspect(video); return view.cleaned && view; }, "recording cleanup", 60000);
  const fileSha = createHash("sha256").update(await readFile(file)).digest("hex");
  note("recorded", { seconds: (Date.now() - started) / 1000, finish, fileBytes: writer.bytes, fileSha256Matches: fileSha === finish.sha256, session: { state: saved.state, cleaned: saved.cleaned, hostCleaned: saved.hostCleaned }, ffprobe: probe(file), reserved: await reserved() });

  await pause("lease", { serial: "emulator-" + JSON.parse(await readFile(join(storage, "endpoint.json"), "utf8")).port, avd: "cvm-" + machineId });

  // A second recording outlives the lease: expiry must end it and cleanup must be proven.
  let view = (await api("GET", "/v1/leases/" + leaseId, undefined, app)).body;
  const remaining = () => (Date.parse(view.expiresAt) - Date.now()) / 1000;
  if (remaining() > 60) { note("waiting-for-expiry-window", { remainingSeconds: remaining() }); await delay((remaining() - 45) * 1000); }
  view = (await api("GET", "/v1/leases/" + leaseId, undefined, app)).body;
  const second = randomUUID(), secondFile = join(root, "capture-expiry.mp4"), secondWriter = fileWriter(secondFile), duration = Math.min(180, Math.ceil(remaining()) + 90);
  let driving2 = true;
  const drive2 = (async () => { let home = false; while (driving2) { await delay(3000); if (!driving2) break; await operate(home ? "launch" : "key", home ? { app: activity } : { key: "KEYCODE_HOME" }).catch(() => {}); home = !home; } })();
  note("second-recording", { video: second, durationSeconds: duration, leaseExpiresAt: view.expiresAt, remainingSeconds: remaining(), reserved: await reserved() });
  let outcome;
  try { outcome = { finish: await lease.video.record({ id: second, member: "primary", fps: 30, durationSeconds: duration, bitRate: 4_000_000 }, secondWriter, { timeoutMs: 60000 }) }; }
  catch (error) { outcome = { error: { code: error.code, message: error.message } }; }
  const endedAt = Date.now(); driving2 = false; await drive2; secondWriter.close();
  view = (await api("GET", "/v1/leases/" + leaseId, undefined, app)).body;
  note("second-recording-ended", { outcome, endedAt: new Date(endedAt).toISOString(), afterExpiryMs: endedAt - Date.parse(view.expiresAt), bytesBeforeEnd: secondWriter.bytes, leaseState: view.state,
    session: await lease.video.inspect(second), reserved: await reserved(), recorderProcesses: pgrep("screenrecord"), encoderProcesses: pgrep(ffmpeg) });
  const stopped = await until(async () => { try { return JSON.parse(await readFile(join(storage, "lease-stopped.json"), "utf8")); } catch { return undefined; } }, "the supervisor's stop receipt", 120000).catch(() => undefined);
  const cleanup = await until(async () => { const current = (await api("GET", "/v1/leases/" + leaseId, undefined, app)).body; return current.cleanup.state === "complete" && current; }, "proven lease cleanup", 300000);
  const settled = await until(async () => { const current = await lease.video.inspect(second); return current.cleaned && current; }, "recording reservation released", 120000);
  const refused = await api("POST", `/v1/leases/${leaseId}/video-sessions`, { id: randomUUID(), member: "primary", fps: 30, durationSeconds: 5, bitRate: 4_000_000 }, key);
  note("second-recording-cleaned", { stopReceipt: stopped && { reason: stopped.reason, groupAbsent: stopped.groupAbsent }, leaseState: cleanup.state, cleanup: cleanup.members[0].cleanup,
    session: { state: settled.state, cleaned: settled.cleaned, hostCleaned: settled.hostCleaned }, reserved: await reserved(), storageRemoved: !existsSync(storage),
    newRecordingAfterExpiry: [refused.status, refused.body.code], processes: pgrep("cvm-" + machineId) });
} catch (error) {
  note("failed", { error: String(error?.stack ?? error) });
  process.exitCode = 1;
} finally {
  await save().catch(() => {});
  await runner?.close().catch(() => {}); await controller?.close().catch(() => {});
  const after = helpers(), newHelpers = Object.fromEntries(Object.entries(after).map(([name, pids]) => [name, pids.filter(pid => !helpersBefore[name].includes(pid))]));
  const leftovers = [...pgrep(join(root, "devices")), ...pgrep("-avd cvm-"), ...Object.values(newHelpers).flat()];
  note("closed", { leftoverProcesses: leftovers, newHelperProcesses: newHelpers });
  const stockNow = await inventory();
  note("baseline", { stockInventoryUnchanged: JSON.stringify(stockNow) === JSON.stringify(before) });
  const keep = process.env.TRIAL_KEEP_DIRECTORY;
  await writeFile(join(tmpdir(), "android-lease-capture-" + Date.now() + ".json"), JSON.stringify(log, null, 2), { mode: 0o600 });
  if (!leftovers.length && !keep) await rm(root, { recursive: true, force: true });
  note("removed", { root, absent: !existsSync(root) });
}
