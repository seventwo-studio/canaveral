import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";
import { AppleProvider, assignmentFingerprint, ensureGuestLaunch, guestLaunchReceipt, readRecord, saveRecord, validateBootstrapISO, verifyLaunchPin, type Data, type CommandOptions } from "../../src/providers/apple.ts";
import { guestAssignment, guestBindingMAC } from "../../src/guest/binding.ts";
// Portable ISO utility stand-in. No host utility/mount/VM is executed.
function iso(payload: Buffer): Buffer {
  const b = Buffer.alloc(24 * 2048), v = b.subarray(16 * 2048, 17 * 2048);
  v[0] = 1; v.write("CD001", 1); v[6] = 1; v.fill(32, 40, 72); v.write("CANAVERAL_BOOT", 40);
  v.writeUInt32LE(20, 158); v.writeUInt32LE(2048, 166);
  const end = b.subarray(17 * 2048); end[0] = 255; end.write("CD001", 1); end[6] = 1;
  const name = "ASSIGNMENT.JSON;1", r = b.subarray(20 * 2048); r[0] = 34 + name.length; r[32] = name.length; r.write(name, 33); r.writeUInt32LE(21, 2); r.writeUInt32LE(payload.length, 10); payload.copy(b, 21 * 2048); return b;
}
function fixture(t: { after(f: () => void): void }, exchange = "") {
  const root = exchange ? dirname(dirname(exchange)) : mkdtempSync(join(realpathSync(tmpdir()), "bootstrap-")); mkdirSync(root, { recursive: true }); if (!exchange) t.after(() => rmSync(root, { recursive: true, force: true }));
  const machine: Data = { id: exchange ? basename(exchange) : randomUUID(), lease: { id: randomUUID() }, name: "fixture", template: { id: "mac", revision: "1" }, resources: { cpu: 2, memoryMiB: 1024, diskGiB: 8 }, desired: "running" };
  const folder = join(root, "assignment"); mkdirSync(folder); saveRecord(join(folder, "assignment.json"), { fingerprint: assignmentFingerprint(machine), leaseId: (machine.lease as Data).id });
  let builds = 0;
  const config: Data = { storage: join(root, "storage"), runner: "/fixture/runner", withFileLock: async (_: string, f: () => unknown) => f(), command: async (args: string[], opts: CommandOptions) => {
    if (args[0] === "hdiutil") { builds++; const receipt = readRecord(join(storage, "guest-launch.json")); assert.equal(receipt.state, "building"); assert.ok(!JSON.stringify(args).includes(String(receipt.credential))); const payload = readFileSync(join(args.at(-1)!, "assignment.json")); writeFileSync(args[args.indexOf("-o") + 1]!, iso(payload), { mode: 0o600 }); return ""; }
    if (args[1] === "prepare") { const request = JSON.parse(opts.input!); assert.equal(request.seedISO, undefined); mkdirSync(native); saveRecord(join(native, "machine.json"), { executionLeaseID: (machine.lease as Data).id }); writeFileSync(join(native, "native-prepared"), ""); return ""; }
    if (args[1] === "lease-clock") return JSON.stringify({ version: 1, continuous: 1, bootSessionID: randomUUID() });
    return '{"locked":false}';
  }, launch: async () => {} };
  const provider = new AppleProvider(config, root), storage = provider.storage(machine), native = join(storage, String(machine.id).toUpperCase());
  return { root, machine, folder, config, provider, storage, native, builds: () => builds };
}
test("real provider builds private media then dispatches native launch exactly once", async t => {
  const f = fixture(t, process.env.CANAVERAL_BOOTSTRAP_EXCHANGE); let launches = 0; f.config.launch = async () => { launches++; assert.ok(readRecord(join(f.native, "runner-launch.json")).launchId); };
  const image = { os: "macos", mode: "desktop", image: "/fixture/base.raw", _leaseAuthorization: () => ({ leaseID: (f.machine.lease as Data).id, revision: 1, remainingSeconds: 60, fenced: false }) };
  assert.equal((await f.provider.reconcile(f.machine, image, f.folder)).state, "starting");
  const receipt = guestLaunchReceipt(f.storage, f.machine)!; assert.equal(receipt.state, "sealed"); assert.equal(lstatSync(join(f.storage, "guest-launch.json")).mode & 0o777, 0o600);
  assert.equal(JSON.stringify(readRecord(join(f.native, "guest-launch-pin.json"))).includes(String(receipt.credential)), false);
  assert.equal((await f.provider.reconcile(f.machine, image, f.folder)).state, "unknown"); assert.equal(f.builds(), 1); assert.equal(launches, 1);

});
test("planned resumes without regenerating; uncertain building blocks rebuild and cleanup", async t => {
  const f = fixture(t); f.config.command = async () => { throw new Error("lost builder"); };
  await assert.rejects(ensureGuestLaunch(f.config, f.machine, f.storage), /lost builder/);
  const before = readFileSync(join(f.storage, "guest-launch.json"));
  await assert.rejects(ensureGuestLaunch(f.config, f.machine, f.storage), /uncertain/); assert.deepEqual(readFileSync(join(f.storage, "guest-launch.json")), before);
  f.machine.desired = "stopped"; await assert.rejects(f.provider.removeOwnedStorage(f.machine, {}, f.folder, randomUUID(), true), /exclusion/);
});
test("sealed resume validates pins; substitutions, links and conflicts are refused", async t => {
  const f = fixture(t), first = await ensureGuestLaunch(f.config, f.machine, f.storage);
  assert.deepEqual(await ensureGuestLaunch(f.config, f.machine, f.storage), first); assert.equal(f.builds(), 1);
  const pin = first.pin as Data, path = String(pin.path); chmodSync(path, 0o600); writeFileSync(path, "substitution"); chmodSync(path, 0o400);
  assert.throws(() => verifyLaunchPin(pin, f.storage)); unlinkSync(path); symlinkSync("content/assignment.json", path); assert.throws(() => verifyLaunchPin(pin, f.storage));
  await assert.rejects(ensureGuestLaunch(f.config, { ...f.machine, lease: { id: randomUUID() } }, f.storage), /differs/);
});
test("deadline refusal has no bootstrap effects; ISO rejects wrong label/extra content", async t => {
  const f = fixture(t); await assert.rejects(f.provider.reconcile(f.machine, { os: "macos", _leaseAuthorization: () => ({ fenced: true, remainingSeconds: 0 }) }, f.folder), /ended/);
  assert.equal(f.builds(), 0); const payload = Buffer.from("{}"), bytes = iso(payload); validateBootstrapISO(bytes, payload);
  bytes[16 * 2048 + 40] = 88; assert.throws(() => validateBootstrapISO(bytes, payload));
});
test("Swift bound bridge proof is checked using expected private custody only", t => {
  const exchange = process.env.CANAVERAL_BOOTSTRAP_EXCHANGE; if (!exchange || !process.env.CANAVERAL_BOOTSTRAP_VERIFY) { t.skip("Run script/check_guest_bootstrap.mjs for the provider/Swift/proof roundtrip."); return; }
  const receipt = readRecord(join(exchange, "guest-launch.json")); const expected = () => guestAssignment(receipt.assignment);
  const response = guestAssignment(JSON.parse(readFileSync(join(exchange, "identity.json"), "utf8")), true) as ReturnType<typeof guestAssignment> & { nonce: string; proof: string; incarnation: string };
  for (const [k, v] of Object.entries(expected())) assert.equal((response as unknown as Data)[k], v);
  assert.equal(response.proof, guestBindingMAC(String(receipt.credential), expected(), "identity-response", response.nonce, response.incarnation));
});
test("durable planned intent resumes with identical launch and secret before any dispatch", async t => {
  const f = fixture(t), assignment = { version: 1, machineId: f.machine.id, leaseId: (f.machine.lease as Data).id, fingerprint: assignmentFingerprint(f.machine), launchId: randomUUID() }, credential = Buffer.alloc(32, 9).toString("base64url");
  saveRecord(join(f.storage, "guest-launch.json"), { version: 1, state: "planned", assignment, credential }, true);
  const receipt = await ensureGuestLaunch(f.config, f.machine, f.storage);
  assert.deepEqual(receipt.assignment, assignment); assert.equal(receipt.credential, credential); assert.equal(f.builds(), 1);
});
test("successful utility exit with invalid output remains building and blocks replacement", async t => {
  const f = fixture(t); let commands = 0;
  f.config.command = async (args: string[]) => { commands++; writeFileSync(args[args.indexOf("-o") + 1]!, Buffer.alloc(32768)); return ""; };
  await assert.rejects(ensureGuestLaunch(f.config, f.machine, f.storage), /ISO/);
  const retained = readRecord(join(f.storage, "guest-launch.json")); assert.equal(retained.state, "building");
  await assert.rejects(ensureGuestLaunch(f.config, f.machine, f.storage), /uncertain/); assert.equal(commands, 1);
});
test("sealed bootstrap cleanup holds on receipt or media handles without PID exclusions", async t => {
  const f = fixture(t); await ensureGuestLaunch(f.config, f.machine, f.storage); f.machine.desired = "stopped";
  let observed: string[] = [];
  f.config.probeCommand = async (argv: string[]) => { observed = argv; return { exitCode: 0, stdout: "p123\n", stderr: "" }; };
  await assert.rejects(f.provider.removeOwnedStorage(f.machine, {}, f.folder, randomUUID(), true), /handles/);
  assert.equal(observed.includes("-p"), false); assert.equal(observed.includes(join(f.storage, "guest-launch.json")), true);
  f.config.probeCommand = async (argv: string[]) => ({ exitCode: argv.includes("+D") ? 0 : 1, stdout: argv.includes("+D") ? "p123\n" : "", stderr: "" });
  await assert.rejects(f.provider.removeOwnedStorage(f.machine, {}, f.folder, randomUUID(), true), /handles/);
});
test("boot-request cut without runner receipt holds sealed custody and cannot relaunch", async t => {
  const f = fixture(t), receipt = await ensureGuestLaunch(f.config, f.machine, f.storage);
  saveRecord(join(f.folder, "apple-boot-request.json"), { machineId: f.machine.id, attemptedAt: 1 });
  let launched = false; f.config.launch = async () => { launched = true; };
  const image = { os: "macos", _leaseAuthorization: () => ({ leaseID: (f.machine.lease as Data).id, revision: 1, remainingSeconds: 60, fenced: false }) };
  assert.equal((await f.provider.reconcile(f.machine, image, f.folder)).state, "unknown"); assert.equal(launched, false);
  assert.deepEqual(guestLaunchReceipt(f.storage, f.machine), receipt); assert.equal(f.builds(), 1);
});
