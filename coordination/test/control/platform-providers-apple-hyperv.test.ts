import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AppleProvider, assignmentFingerprint, ensureSeed, legacyDigest, readRecord, saveRecord } from "../../src/providers/apple.ts";
import type { CommandOptions, Data } from "../../src/providers/apple.ts";
import { HypervProvider, HYPERV_SCRIPT } from "../../src/providers/hyperv.ts";
import { object } from "../../src/errors.ts";

const SWIFT = 978307200;
const image: Data = { os: "linux", arch: "arm64", mode: "headless", image: "/installed/linux.raw" };
function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "platform-apple-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const machine: Data = { id: randomUUID(), name: "fixture", template: { id: "linux", revision: "1" }, resources: { cpu: 2, memoryMiB: 1024, diskGiB: 8 }, desired: "running" };
  const folder = join(root, "assignment"); mkdirSync(folder); saveRecord(join(folder, "assignment.json"), { fingerprint: assignmentFingerprint(machine) });
  const config: Data = { storage: join(root, "storage"), runner: "/fixture/CanaveralVMRunner", now: () => 1000, withFileLock: async (_path: string, consume: () => Promise<unknown>) => consume(), command: async () => '{"locked":false}' };
  const provider = new AppleProvider(config, root); const storage = provider.storage(machine); const path = join(storage, String(machine.id).toUpperCase());
  function prepared() { mkdirSync(path); saveRecord(join(path, "machine.json"), { id: machine.id, ...(machine.lease ? { executionLeaseID: object(machine.lease).id } : {}) }); writeFileSync(join(path, "native-prepared"), ""); writeFileSync(join(path, "disk.img"), "fixture disk"); }
  return { root, machine, folder, config, provider, storage, path, prepared };
}
function status(path: string, phase: string, at = 1000, extra: Data = {}) { saveRecord(join(path, "status.json"), { phase, updatedAt: at - SWIFT, detail: "fixture status", ...extra }); }
function proof(boot = 999): Data { return { boot, processExited: true, runtimeUnlocked: true, diskHandlesClosed: true }; }

test("receipt digest preserves sorted Python JSON, ASCII escapes and separators", () => {
  const expected = createHash("sha256").update('{"a": [true, null, "\\u00e9"], "z": 1}').digest("hex"); assert.equal(legacyDigest({ z: 1, a: [true, null, "é"] }), expected);
});

test("Apple fresh Swift status requires the runtime lock and stale state cannot relaunch", async t => {
  const f = fixture(t); f.prepared(); saveRecord(join(f.path, "runner-launch.json"), { attemptedAt: 999 }); status(f.path, "Running"); let launches = 0;
  f.config.command = async () => '{"locked":true}'; f.config.launch = async () => { launches++; }; assert.equal((await f.provider.reconcile(f.machine, image, f.folder)).state, "running");
  status(f.path, "Running", 980); assert.equal((await f.provider.reconcile(f.machine, image, f.folder)).state, "unknown"); assert.equal(launches, 0);
  f.config.command = async () => '{"locked":false}'; status(f.path, "Running"); assert.equal((await f.provider.reconcile(f.machine, image, f.folder)).state, "unknown");
});

test("Apple preparation and launch receipts precede effects and lost launch never duplicates a job", async t => {
  const f = fixture(t); let preparations = 0; let launches = 0;
  f.config.command = async (args: string[], options: CommandOptions) => { if (args[1] === "prepare") { preparations++; assert.ok(existsSync(join(f.storage, "apple-prepare.json"))); assert.equal(object(JSON.parse(options.input!)).directory, f.storage); f.prepared(); return ""; } return '{"locked":false}'; };
  f.config.launch = async () => { launches++; assert.equal(readRecord(join(f.path, "runner-launch.json")).attemptedAt, 1000); throw new Error("lost launch response"); };
  await assert.rejects(f.provider.reconcile(f.machine, image, f.folder), /lost launch/);
  assert.equal((await f.provider.reconcile(f.machine, image, f.folder)).state, "unknown"); assert.equal(preparations, 1); assert.equal(launches, 1);
});

test("Apple lost preparation reply blocks repeated prepare; incomplete native machine cannot boot", async t => {
  const f = fixture(t); let prepares = 0; f.config.command = async () => { prepares++; throw new Error("lost prepare"); };
  await assert.rejects(f.provider.reconcile(f.machine, image, f.folder), /lost prepare/); await assert.rejects(f.provider.reconcile(f.machine, image, f.folder), /automatic retry/); assert.equal(prepares, 1);
  mkdirSync(f.path); saveRecord(join(f.path, "machine.json"), {}); f.config.command = async () => '{"locked":false}'; await assert.rejects(f.provider.reconcile(f.machine, image, f.folder), /preparation is incomplete/);
});

test("Apple graceful and explicit power-off requests bind current assignment and native boot", async t => {
  const f = fixture(t); f.prepared(); saveRecord(join(f.path, "runner-launch.json"), { attemptedAt: 999 }); status(f.path, "Running", 1000, { runnerProtocol: 1 }); f.config.command = async () => '{"locked":true}'; f.machine.desired = "stopped";
  assert.equal((await f.provider.reconcile(f.machine, image, f.folder)).state, "stopping"); assert.ok(existsSync(join(f.path, "shutdown.request")));
  f.machine.powerOffRequest = randomUUID(); assert.equal((await f.provider.reconcile(f.machine, image, f.folder)).state, "stopping"); assert.deepEqual(readRecord(join(f.path, "power-off.request")), { id: f.machine.powerOffRequest, boot: 999 });
  saveRecord(join(f.folder, "assignment.json"), { fingerprint: "foreign" }); await assert.rejects(f.provider.reconcile(f.machine, image, f.folder), /Assignment ownership/);
});

test("Apple stale stop marker, live process, held lock or open disk cannot release resources or restart", async t => {
  const f = fixture(t); f.prepared(); saveRecord(join(f.path, "runner-launch.json"), { attemptedAt: 999 }); f.machine.desired = "stopped";
  status(f.path, "Stopped", 998); assert.equal(f.provider.confirmedStopped(f.path), false); status(f.path, "Stopped", 1000);
  for (const field of ["processExited", "runtimeUnlocked", "diskHandlesClosed"]) { f.config.runtimeProof = async () => ({ ...proof(), [field]: false }); assert.equal((await f.provider.reconcile(f.machine, image, f.folder)).state, "unknown", field); }
  f.config.runtimeProof = async () => proof(998); assert.equal((await f.provider.reconcile(f.machine, image, f.folder)).state, "unknown");
  f.config.runtimeProof = async () => proof(); assert.equal((await f.provider.reconcile(f.machine, image, f.folder)).state, "stopped");
  f.machine.desired = "running"; let starts = 0; f.config.launch = async () => { starts++; }; assert.equal((await f.provider.reconcile(f.machine, image, f.folder)).state, "starting"); assert.equal(starts, 1);
});

test("Apple ownership, deletion tombstone and symlink boundaries block effects", async t => {
  const f = fixture(t); f.prepared(); saveRecord(join(f.folder, "deletion.json"), { state: "planned" }); await assert.rejects(f.provider.reconcile(f.machine, image, f.folder), /deletion intent/);
  unlinkSync(join(f.folder, "deletion.json")); saveRecord(join(f.storage, "canaveral-owner.json"), { fingerprint: "foreign" }); await assert.rejects(f.provider.reconcile(f.machine, image, f.folder), /another assignment/);
  saveRecord(join(f.storage, "canaveral-owner.json"), { fingerprint: assignmentFingerprint(f.machine) }); symlinkSync(join(f.root, "foreign"), join(f.path, "status.json")); await assert.rejects(f.provider.reconcile(f.machine, image, f.folder), /symbolic links/);
});

test("Apple native lease IDs prevent administrative adoption in either direction", async t => {
  const f = fixture(t); f.prepared(); f.machine.lease = { id: randomUUID() }; await assert.rejects(f.provider.reconcile(f.machine, image, f.folder), /adoption was refused/);
  saveRecord(join(f.path, "machine.json"), { executionLeaseID: object(f.machine.lease).id }); delete f.machine.lease; await assert.rejects(f.provider.reconcile(f.machine, image, f.folder), /adoption was refused/);
});

test("Apple lease authorization never extends same revision, moves backwards or revives a fence", async t => {
  const f = fixture(t); f.machine.lease = { id: randomUUID() }; f.prepared(); saveRecord(join(f.path, "runner-launch.json"), { attemptedAt: 999 });
  const auth = { leaseID: object(f.machine.lease).id, revision: 1, remainingSeconds: 10, fenced: false }; const template = { ...image, _leaseAuthorization: () => auth };
  f.config.command = async () => JSON.stringify({ version: 1, bootSessionID: randomUUID(), continuous: 500 });
  const first = await f.provider.publishAuthorization(f.machine, template, f.path); assert.ok(Number(first.deadline) <= 509.75 && Number(first.deadline) > 509);
  auth.remainingSeconds = 100; assert.equal((await f.provider.publishAuthorization(f.machine, template, f.path)).deadline, first.deadline);
  auth.revision = 2; assert.ok(Number((await f.provider.publishAuthorization(f.machine, template, f.path)).deadline) > Number(first.deadline));
  assert.equal((await f.provider.publishAuthorization(f.machine, template, f.path, true)).fenced, true); auth.revision = 3; assert.equal((await f.provider.publishAuthorization(f.machine, template, f.path)).fenced, true);
  auth.revision = 2; await assert.rejects(f.provider.publishAuthorization(f.machine, template, f.path), /backwards/);
  saveRecord(join(f.path, "runner-launch.json"), { attemptedAt: 1001 }); await assert.rejects(f.provider.publishAuthorization(f.machine, template, f.path), /another identity or boot/);
});

test("Apple refresh creates no missing storage and updates only matching owned lease binding", async t => {
  const f = fixture(t); f.machine.lease = { id: randomUUID() }; const auth = { leaseID: object(f.machine.lease).id, revision: 1, remainingSeconds: 10, fenced: false };
  assert.equal(await f.provider.refreshExecution(f.machine, image, f.folder, () => auth), null); assert.equal(existsSync(f.path), false);
  f.prepared(); saveRecord(join(f.path, "runner-launch.json"), { attemptedAt: 999 }); let samples = 0;
  f.config.command = async () => { samples++; return JSON.stringify({ version: 1, bootSessionID: randomUUID(), continuous: 500 }); };
  await f.provider.refreshExecution(f.machine, image, f.folder, () => auth); await f.provider.refreshExecution(f.machine, image, f.folder, () => auth); assert.equal(samples, 1);
  f.machine.desired = "stopped"; assert.equal((await f.provider.refreshExecution(f.machine, image, f.folder, () => auth))?.state, "stopping"); assert.equal(samples, 2);
  saveRecord(join(f.folder, "assignment.json"), { fingerprint: "different" }); await assert.rejects(f.provider.refreshExecution(f.machine, image, f.folder, () => auth), /ownership/);
});

test("Apple capture holds native lock, preserves disk and distinguishes consistency", async t => {
  const f = fixture(t); f.prepared(); saveRecord(join(f.path, "runner-launch.json"), { attemptedAt: 999 }); status(f.path, "Stopped", 1000, { stopReason: "guest" }); f.config.runtimeProof = async () => proof();
  let held = false; f.config.withRuntimeLock = async (_path: string, consume: () => Promise<unknown>) => { held = true; try { return await consume(); } finally { held = false; } };
  assert.equal(await f.provider.captureSource(f.machine, image, f.folder, async (path, format) => { assert.equal(held, true); assert.equal(format, "raw"); return readFileSync(path, "utf8"); }), "fixture disk"); assert.equal(f.provider.captureConsistency(f.machine, image, f.folder), "guest-shutdown");
  status(f.path, "Stopped", 1000, { stopReason: "forced" }); assert.equal(f.provider.captureConsistency(f.machine, image, f.folder), "crash-consistent");
});

test("seed builder ports NoCloud identity/network metadata and refuses mismatched reuse", async t => {
  const f = fixture(t); const seedImage = { ...image, _userData: "#cloud-config\nsecret: fixture", cloneIdentity: "linux-cloud-init", prepare: { driver: "cloud-init" } }; let runs = 0;
  f.config.platform = "darwin"; f.config.command = async (args: string[]) => { runs++; assert.equal(args[0], "hdiutil"); const content = args.at(-1)!; const metadata = object(JSON.parse(readFileSync(join(content, "meta-data"), "utf8"))); assert.equal(metadata["instance-id"], f.machine.id); const network = object(JSON.parse(readFileSync(join(content, "network-config"), "utf8"))); assert.equal(network.version, 2); writeFileSync(args[args.indexOf("-o") + 1]!, Buffer.alloc(32768)); return ""; };
  const path = await ensureSeed(f.config, seedImage, f.machine, f.storage); assert.ok(path); assert.equal(await ensureSeed(f.config, seedImage, f.machine, f.storage), path); assert.equal(runs, 1);
  await assert.rejects(ensureSeed(f.config, { ...seedImage, _userData: "changed" }, f.machine, f.storage), /differs/); assert.equal(runs, 1);
});

test("native checks validate platform and local templates using only injected commands", async t => {
  const f = fixture(t); const base = join(f.root, "linux.raw"); writeFileSync(base, "image"); let calls = 0;
  f.config.platform = "linux"; f.config.templates = [{ ...image, image: base }]; await assert.rejects(f.provider.check(), /physical Mac/);
  f.config.platform = "darwin"; f.config.arch = "arm64"; f.config.command = async (args: string[]) => { calls++; assert.deepEqual(args, ["/fixture/CanaveralVMRunner", "check"]); return "ok"; }; assert.equal(await f.provider.check(), "ok"); assert.equal(calls, 1);
  f.config.templates = [{ os: "macos", arch: "arm64", mode: "headless", image: base }]; await assert.rejects(f.provider.check(), /desktop mode/);
});

test("Hyper-V creation pins VM ID and disk before boot and lost boot reply is inspect-only", async t => {
  const f = fixture(t); const vmId = randomUUID(); const values: Data[] = []; const hyper = new HypervProvider({ storage: f.config.storage, switch: "guests", command: async (args: string[], options: CommandOptions) => {
    assert.equal(Buffer.from(args.at(-1)!, "base64").toString("utf16le"), HYPERV_SCRIPT); const v = object(JSON.parse(options.env!.CANAVERAL_OPERATION!)); values.push(v);
    if (v.operation === "inspect") return JSON.stringify({ state: "Running", vmId, disk: v.disk });
    if (!v.vmId) return JSON.stringify({ state: "prepared", vmId, disk: v.disk });
    assert.equal(readRecord(join(f.folder, "hyperv-owner.json")).vmId, vmId); throw new Error("lost boot reply");
  } }, f.root);
  await assert.rejects(hyper.reconcile(f.machine, image, f.folder), /lost boot reply/);
  assert.equal((await hyper.reconcile(f.machine, image, f.folder)).state, "running"); assert.equal(values.length, 3); assert.equal(values[2]!.operation, "inspect");
  assert.equal(values[0]!.memoryBytes, 1024 * 1048576); assert.equal(values[0]!.diskBytes, 8 * 1073741824);
});

test("Hyper-V uncertain creation cannot adopt same-name VMs or repeat disk conversion", async t => {
  const f = fixture(t); let calls = 0; const hyper = new HypervProvider({ storage: f.config.storage, switch: "guests", command: async () => { calls++; throw new Error("uncertain creation"); } }, f.root);
  await assert.rejects(hyper.reconcile(f.machine, image, f.folder), /uncertain creation/); assert.equal((await hyper.reconcile(f.machine, image, f.folder)).state, "unknown"); assert.equal(calls, 1);
  f.machine.desired = "stopped"; assert.equal((await hyper.reconcile(f.machine, image, f.folder)).state, "unknown"); assert.equal(calls, 1);
});

test("Hyper-V pending intents refuse replaced VM/disk, and lease creation is disabled", async t => {
  const f = fixture(t); const vmId = randomUUID(); let mutation = false; const config: Data = { storage: f.config.storage, switch: "guests", command: async (_args: string[], options: CommandOptions) => { const v = object(JSON.parse(options.env!.CANAVERAL_OPERATION!)); if (v.operation === "inspect") return JSON.stringify({ state: "Running", vmId: randomUUID(), disk: v.disk }); if (!v.vmId) return JSON.stringify({ state: "prepared", vmId, disk: v.disk }); mutation = true; return JSON.stringify({ state: "starting", vmId, disk: v.disk }); } }; const hyper = new HypervProvider(config, f.root);
  assert.equal((await hyper.reconcile(f.machine, image, f.folder)).state, "starting"); assert.equal(mutation, true); assert.equal((await hyper.reconcile(f.machine, image, f.folder)).state, "unknown");
  f.machine.lease = { id: randomUUID() }; await assert.rejects(hyper.reconcile(f.machine, image, f.folder), /independent native deadline fencing/);
  assert.ok(HYPERV_SCRIPT.includes("$vm.Id")); assert.ok(HYPERV_SCRIPT.includes("Get-VMHardDiskDrive")); assert.ok(HYPERV_SCRIPT.includes("MicrosoftUEFICertificateAuthority"));
});

test("default Apple stop proof requires process exit plus a held runtime lock and clean lsof exit 1", async t => {
  const f = fixture(t); f.prepared(); saveRecord(join(f.path, "runner-launch.json"), { attemptedAt: 999 }); status(f.path, "Stopped", 1000, { pid: 12345 }); f.machine.desired = "stopped";
  let held = false; let absent = false; let result: Data = { exitCode: 1, stdout: "", stderr: "" };
  f.config.processAbsent = () => absent; f.config.withRuntimeLock = async (_path: string, consume: () => Promise<unknown>) => { held = true; try { return await consume(); } finally { held = false; } };
  f.config.probeCommand = async (argv: string[]) => { assert.equal(held, true); assert.deepEqual(argv, ["/usr/sbin/lsof", "-F", "p", "--", join(f.path, "disk.img")]); return result; };
  assert.equal((await f.provider.reconcile(f.machine, image, f.folder)).state, "unknown"); absent = true;
  for (const bad of [{ exitCode: 0, stdout: "p12345", stderr: "" }, { exitCode: 1, stdout: "", stderr: "permission denied" }, { exitCode: 2, stdout: "", stderr: "" }]) { result = bad; assert.equal((await f.provider.reconcile(f.machine, image, f.folder)).state, "unknown"); }
  result = { exitCode: 1, stdout: "", stderr: "" }; assert.equal((await f.provider.reconcile(f.machine, image, f.folder)).state, "stopped");
  assert.equal(await f.provider.captureSource(f.machine, image, f.folder, async path => { assert.equal(held, true); return readFileSync(path, "utf8"); }), "fixture disk");
});

test("default Apple quarantine/removal journal survives lost replies and prevents recreation", async t => {
  const f = fixture(t); f.prepared(); f.machine.desired = "stopped"; saveRecord(join(f.path, "runner-launch.json"), { attemptedAt: 999 }); status(f.path, "Stopped", 1000, { pid: 12345 });
  f.config.processAbsent = () => true; f.config.probeCommand = async () => ({ exitCode: 1, stdout: "", stderr: "" });
  const request = randomUUID(); const quarantine = join(String(f.config.storage), `.removing-${f.machine.id}-${request}`); let moves = 0; let erases = 0;
  f.config.command = async (args: string[]) => {
    const journal = readRecord(join(f.folder, "deletion.json")); assert.equal(journal.id, request); assert.match(args[0]!, /apple-native-helper$/);
    if (args[1] === "quarantine") { assert.equal(journal.state, "planned"); moves++; const { renameSync } = await import("node:fs"); renameSync(f.storage, quarantine); throw new Error("lost quarantine response"); }
    assert.equal(args[1], "erase"); assert.equal(journal.state, "removing"); erases++;
    if (erases === 1) { unlinkSync(join(quarantine, "canaveral-owner.json")); throw new Error("interrupted erasure"); }
    assert.equal(args.at(-1), ""); rmSync(quarantine, { recursive: true }); return "";
  };
  await assert.rejects(f.provider.removeOwnedStorage(f.machine, image, f.folder, request), /lost quarantine/); assert.equal(existsSync(f.storage), false); assert.equal(existsSync(quarantine), true);
  await assert.rejects(f.provider.removeOwnedStorage(f.machine, image, f.folder, request), /interrupted erasure/);
  assert.equal((await f.provider.removeOwnedStorage(f.machine, image, f.folder, request)).state, "complete"); assert.equal(moves, 1); assert.equal(erases, 2);
  assert.equal((await f.provider.removeOwnedStorage(f.machine, image, f.folder, request)).state, "complete"); assert.equal(erases, 2);
  await assert.rejects(f.provider.removeOwnedStorage(f.machine, image, f.folder, randomUUID()), /another intent/);
  await assert.rejects(f.provider.reconcile({ ...f.machine, desired: "running" }, image, f.folder), /deletion intent/); assert.equal(existsSync(f.storage), false);
});

test("default Apple removal refuses wrong assignment, open disk and replaced quarantine inode", async t => {
  const f = fixture(t); f.prepared(); f.machine.desired = "stopped"; saveRecord(join(f.path, "runner-launch.json"), { attemptedAt: 999 }); status(f.path, "Stopped", 1000, { pid: 12345 }); f.config.processAbsent = () => true;
  let calls = 0; f.config.command = async () => { calls++; return ""; }; f.config.probeCommand = async () => ({ exitCode: 0, stdout: "p12345", stderr: "" }); const request = randomUUID();
  await assert.rejects(f.provider.removeOwnedStorage(f.machine, image, f.folder, request), /closed disk handles/); assert.equal(calls, 0); assert.equal(existsSync(join(f.folder, "deletion.json")), false);
  saveRecord(join(f.storage, "canaveral-owner.json"), { fingerprint: "different" }); await assert.rejects(f.provider.removeOwnedStorage(f.machine, image, f.folder, request), /another assignment/); assert.equal(calls, 0);
  saveRecord(join(f.storage, "canaveral-owner.json"), { fingerprint: assignmentFingerprint(f.machine) });
  const root = lstatSync(String(f.config.storage), { bigint: true }); const storage = lstatSync(f.storage, { bigint: true });
  saveRecord(join(f.folder, "deletion.json"), { id: request, machineId: f.machine.id, fingerprint: assignmentFingerprint(f.machine), state: "planned", rootDev: String(root.dev), rootIno: String(root.ino), storageDev: String(storage.dev), storageIno: String(storage.ino + 1n), ownerHex: "00" });
  await assert.rejects(f.provider.removeOwnedStorage(f.machine, image, f.folder, request), /pinned identity/); assert.equal(calls, 0);
});

test("pre-boot lease erasure requires positive preparing journal and no contradictory execution records", async t => {
  const f = fixture(t); f.machine.desired = "stopped"; f.machine.lease = { id: randomUUID() }; const leaseId = object(f.machine.lease).id; const fingerprint = assignmentFingerprint(f.machine);
  saveRecord(join(f.folder, "assignment.json"), { fingerprint, leaseId }); saveRecord(join(f.folder, "provisioning.json"), { version: 1, machineId: f.machine.id, leaseId, fingerprint, phase: "preparing" });
  f.config.probeCommand = async () => ({ exitCode: 1, stdout: "", stderr: "" }); const request = randomUUID(); const quarantine = join(String(f.config.storage), `.removing-${f.machine.id}-${request}`);
  f.config.command = async (args: string[]) => { if (args[1] === "quarantine") { const { renameSync } = await import("node:fs"); renameSync(f.storage, quarantine); } else rmSync(quarantine, { recursive: true }); return ""; };
  mkdirSync(f.path); saveRecord(join(f.path, "runner-launch.json"), { attemptedAt: 999 }); await assert.rejects(f.provider.removeOwnedStorage(f.machine, image, f.folder, request, true), /possible native execution/);
  unlinkSync(join(f.path, "runner-launch.json")); const result = await f.provider.removeOwnedStorage(f.machine, image, f.folder, request, true); assert.equal(result.state, "complete"); assert.equal(result.evidence, "preboot"); assert.equal(result.leaseId, leaseId);
});

test("legacy Apple power-off persists birth identity before signal and never repeats an uncertain signal", async t => {
  const f = fixture(t); f.prepared(); f.machine.desired = "stopped"; f.machine.powerOffRequest = randomUUID(); const runner = join(f.root, "legacy-runner"); writeFileSync(runner, "fixture executable"); f.config.runner = runner;
  saveRecord(join(f.path, "runner-launch.json"), { attemptedAt: 999 }); status(f.path, "Running", 1000, { pid: 12345 }); let absent = false; let signals = 0;
  f.config.processAbsent = () => absent; f.config.probeCommand = async () => ({ exitCode: 1, stdout: "", stderr: "" });
  f.config.command = async (args: string[]) => {
    if (args[1] === "inspect") return JSON.stringify({ locked: !absent });
    if (args[1] === "process") return JSON.stringify({ pid: 12345, uid: process.getuid?.(), seconds: 999, micros: 1, executableHex: Buffer.from(runner).toString("hex"), argvHex: [runner, "run", f.path].map(v => Buffer.from(v).toString("hex")) });
    assert.equal(args[1], "terminate"); signals++; assert.equal(readRecord(join(f.path, `legacy-power-off-${f.machine.powerOffRequest}.json`)).pid, 12345); throw new Error("lost signal response");
  };
  await assert.rejects(f.provider.reconcile(f.machine, image, f.folder), /lost signal/); assert.equal((await f.provider.reconcile(f.machine, image, f.folder)).state, "unknown"); assert.equal(signals, 1);
  absent = true; assert.equal((await f.provider.reconcile(f.machine, image, f.folder)).state, "stopped"); assert.equal(f.provider.captureConsistency(f.machine, image, f.folder), "crash-consistent"); assert.equal(signals, 1);
  assert.equal((await f.provider.reconcile(f.machine, image, f.folder)).state, "stopped");
});

test("Apple process resources bind executable, boot, assignment and post-sample PID birth", async t => {
  const f = fixture(t); f.prepared(); const runner = join(f.root, "runner"); writeFileSync(runner, "fixture"); f.config.runner = runner;
  saveRecord(join(f.path, "runner-launch.json"), { attemptedAt: 999 }); status(f.path, "Running", 1000, { pid: 12345 }); f.config.processAbsent = () => false;
  const sample = { pid: 12345, uid: process.getuid?.(), seconds: 999, micros: 1, executableHex: Buffer.from(runner).toString("hex"), argvHex: [runner, "run", f.path].map(v => Buffer.from(v).toString("hex")), userNanoseconds: 1000000000, systemNanoseconds: 500000000, rssBytes: 1048576 };
  f.config.processSnapshot = () => sample;
  const values = await f.provider.resourceProcesses(f.machine, image, f.folder); const observed = object(values[0]); assert.equal(observed.userSeconds, 1); assert.equal(observed.systemSeconds, .5); assert.equal((observed.verify as () => boolean)(), true);
  sample.micros = 2; assert.equal((observed.verify as () => boolean)(), false);
  saveRecord(join(f.folder, "assignment.json"), { fingerprint: "foreign" }); await assert.rejects(f.provider.resourceProcesses(f.machine, image, f.folder), /ownership/);
});
