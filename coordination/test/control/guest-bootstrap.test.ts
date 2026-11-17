import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";
import { AppleProvider, assignmentFingerprint, ensureGuestLaunch, guestLaunchReceipt, readRecord, saveRecord, validateBootstrapISO, verifyLaunchPin, type Data, type CommandOptions } from "../../src/providers/apple.ts";
import { guestAssignment, guestBindingMAC } from "../../src/guest/binding.ts";
import { buildLaunchTLS, validateLaunchTLS } from "../../src/providers/guest-tls.ts";
// Portable ISO utility stand-in. No host utility/mount/VM is executed.
function iso(payload: Buffer, primaryName = "ASSIGNMENT.JSON;1", jolietName = "assignment.json"): Buffer {
  const b = Buffer.alloc(24 * 2048);
  for (const joliet of [false, true]) {
    const v = b.subarray((joliet ? 17 : 16) * 2048), root = joliet ? 21 : 20;
    v[0] = joliet ? 2 : 1; v.write("CD001", 1); v[6] = 1;
    if (joliet) { Buffer.from("CANAVERAL_BOOT  ", "utf16le").swap16().copy(v, 40); v.write("%/E", 88); }
    else { v.fill(32, 40, 72); v.write("CANAVERAL_BOOT", 40); }
    v.writeUInt32LE(root, 158); v.writeUInt32LE(2048, 166);
    const name = joliet ? Buffer.from(jolietName, "utf16le").swap16() : Buffer.from(primaryName), r = b.subarray(root * 2048);
    r[0] = 34 + name.length; r[32] = name.length; name.copy(r, 33); r.writeUInt32LE(22, 2); r.writeUInt32LE(payload.length, 10);
  }
  const end = b.subarray(18 * 2048); end[0] = 255; end.write("CD001", 1); end[6] = 1;
  payload.copy(b, 22 * 2048); return b;
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
  saveRecord(join(f.storage, "guest-launch.json"), { version: 2, state: "planned", assignment, credential }, true);
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
  const original = f.config.command as (args: string[], opts: CommandOptions) => Promise<string>;
  f.config.command = async (args: string[], opts: CommandOptions) => { assert.notEqual(args[1], "prepare"); return original(args, opts); };
  let launched = false; f.config.launch = async () => { launched = true; };
  const image = { os: "macos", _leaseAuthorization: () => ({ leaseID: (f.machine.lease as Data).id, revision: 1, remainingSeconds: 60, fenced: false }) };
  assert.equal((await f.provider.reconcile(f.machine, image, f.folder)).state, "unknown"); assert.equal(launched, false);
  assert.deepEqual(guestLaunchReceipt(f.storage, f.machine), receipt); assert.equal(f.builds(), 1);
});
test("assigned runner reports fresh status and publishes fences without preparing or relaunching", async t => {
  const f = fixture(t), original = f.config.command as (args: string[], opts: CommandOptions) => Promise<string>, bootSessionID = randomUUID();
  let locked = false, launches = 0, auth = { leaseID: (f.machine.lease as Data).id, revision: 1, remainingSeconds: 60, fenced: false };
  f.config.now = () => 1000; f.config.runtimeProof = async () => ({}); f.config.launch = async () => { launches++; };
  f.config.command = async (args: string[], opts: CommandOptions) => args[1] === "inspect" ? JSON.stringify({ locked }) : args[1] === "lease-clock" ? JSON.stringify({ version: 1, continuous: 1, bootSessionID }) : original(args, opts);
  const image = { os: "macos", mode: "desktop", image: "/fixture/base.raw", _leaseAuthorization: () => auth };
  assert.equal((await f.provider.reconcile(f.machine, image, f.folder)).state, "starting"); locked = true;
  for (const phase of ["Running", "Starting"]) {
    saveRecord(join(f.native, "status.json"), { phase, updatedAt: 1000 - 978307200 });
    assert.equal((await f.provider.reconcile(f.machine, image, f.folder)).state, phase.toLowerCase());
  }
  auth = { ...auth, revision: 2, remainingSeconds: 0, fenced: true };
  saveRecord(join(f.native, "status.json"), { phase: "Running", updatedAt: 1000 - 978307200 });
  assert.equal((await f.provider.reconcile(f.machine, image, f.folder)).state, "running");
  assert.equal(readRecord(join(f.native, "lease-authorization.json")).fenced, true);
  locked = false; assert.equal((await f.provider.reconcile(f.machine, image, f.folder)).state, "unknown");
  locked = true; saveRecord(join(f.native, "status.json"), { phase: "Running", updatedAt: 990 - 978307200 });
  assert.equal((await f.provider.reconcile(f.machine, image, f.folder)).state, "unknown");
  assert.equal(f.builds(), 1); assert.equal(launches, 1);
});
test("both ISO trees, canonical Joliet names and matching payloads are required", () => {
  const payload = Buffer.from("{}"), valid = iso(payload); validateBootstrapISO(valid, payload);
  const primaryOnly = Buffer.from(valid); valid.subarray(18 * 2048, 19 * 2048).copy(primaryOnly, 17 * 2048);
  assert.throws(() => validateBootstrapISO(primaryOnly, payload), /incomplete/);
  for (const name of ["Assignment.Json", "ASSIGNMENT.JSON", "assignment.json.extra"]) assert.throws(() => validateBootstrapISO(iso(payload, "ASSIGNMENT.JSON;1", name), payload), /contents/);
  assert.throws(() => validateBootstrapISO(iso(payload, "Assignment.Json", "assignment.json"), payload), /contents/);
  const escapes = Buffer.from(valid); escapes.write("%/X", 17 * 2048 + 88); assert.throws(() => validateBootstrapISO(escapes, payload), /Joliet/);
  const wrongBytes = Buffer.from(valid); wrongBytes[22 * 2048] = wrongBytes[22 * 2048]! ^ 1; assert.throws(() => validateBootstrapISO(wrongBytes, payload), /bytes/);
  const extra = Buffer.from(valid), entry = extra.subarray(21 * 2048, 21 * 2048 + extra[21 * 2048]!); entry.copy(extra, 21 * 2048 + entry.length);
  assert.throws(() => validateBootstrapISO(extra, payload), /bytes/);
});
test("local staging failures stay cleanable and identical staged input resumes before dispatch", async t => {
  const f = fixture(t), directory = join(f.storage, "guest-bootstrap"); writeFileSync(directory, "local obstruction");
  await assert.rejects(ensureGuestLaunch(f.config, f.machine, f.storage), /staging directory/);
  const receipt = readRecord(join(f.storage, "guest-launch.json")); assert.equal(receipt.state, "planned"); assert.equal(f.builds(), 0);
  unlinkSync(directory); mkdirSync(directory, { mode: 0o700 }); mkdirSync(join(directory, "content"), { mode: 0o700 });
  const tlsDirectory = join(directory, "tls"); mkdirSync(tlsDirectory, { mode: 0o700 });
  saveRecord(join(f.storage, "guest-launch.json"), { ...receipt, state: "tls-building" });
  const tls = await buildLaunchTLS(tlsDirectory, String((receipt.assignment as Data).launchId));
  const staged = { ...receipt, tls }; saveRecord(join(f.storage, "guest-launch.json"), staged);
  const source = join(directory, "content", "assignment.json"); writeFileSync(source, "{}", { mode: 0o600 });
  const before = readFileSync(join(f.storage, "guest-launch.json"));
  await assert.rejects(ensureGuestLaunch(f.config, f.machine, f.storage), /staging payload differs/);
  assert.deepEqual(readFileSync(join(f.storage, "guest-launch.json")), before); assert.equal(f.builds(), 0);
  const payload = Buffer.from(JSON.stringify({ version: 2, assignment: receipt.assignment, credential: receipt.credential, tls: { pkcs12: tls.pkcs12 } }));
  writeFileSync(source, payload);
  const sealed = await ensureGuestLaunch(f.config, f.machine, f.storage);
  assert.deepEqual(sealed.assignment, receipt.assignment); assert.equal(sealed.credential, receipt.credential); assert.equal(f.builds(), 1);
  assert.deepEqual(readFileSync(source), payload);
});
test("injected removal retains runtime ownership and repeats media proof before delegation", async t => {
  const f = fixture(t); await ensureGuestLaunch(f.config, f.machine, f.storage); f.machine.desired = "stopped";
  mkdirSync(f.native); saveRecord(join(f.native, "runner-launch.json"), { attemptedAt: 1 }); saveRecord(join(f.native, "status.json"), { phase: "Stopped", updatedAt: 1000 - 978307200 });
  f.config.runtimeProof = async () => ({ boot: 1, processExited: true, runtimeUnlocked: true, diskHandlesClosed: true });
  let held = false, removals = 0, probes = 0;
  f.config.withRuntimeLock = async (_: string, consume: () => Promise<unknown>) => { held = true; try { return await consume(); } finally { held = false; } };
  f.config.probeCommand = async () => { probes++; return { exitCode: 1, stdout: "", stderr: "" }; };
  f.config.removeOwnedStorage = async () => { assert.equal(held, true); assert.ok(probes >= 4); removals++; return { state: "complete" }; };
  assert.equal((await f.provider.removeOwnedStorage(f.machine, {}, f.folder, randomUUID())).state, "complete"); assert.equal(removals, 1); assert.equal(held, false);
  f.config.probeCommand = async () => ({ exitCode: held ? 0 : 1, stdout: held ? "p123\n" : "", stderr: "" });
  await assert.rejects(f.provider.removeOwnedStorage(f.machine, {}, f.folder, randomUUID()), /handles/); assert.equal(removals, 1);
});

test("v2 identity has explicit payload margin and exact retained profile; v1 is cleanup-only", async t => {
  const f = fixture(t), receipt = await ensureGuestLaunch(f.config, f.machine, f.storage);
  const payload = readFileSync(join(f.storage, "guest-bootstrap/content/assignment.json"));
  assert.ok(payload.length <= 3584, `bootstrap must retain at least 512 bytes of margin: ${payload.length}`);
  assert.equal(JSON.parse(payload.toString()).version, 2);
  const tls = receipt.tls as Data;
  const { X509Certificate, createHash } = await import("node:crypto");
  const cert = new X509Certificate(Buffer.from(String(tls.leafDER), "base64url"));
  assert.equal(cert.ca, false); assert.equal(cert.checkHost(String(tls.serverName)), tls.serverName);
  assert.equal(createHash("sha256").update(cert.raw).digest("hex"), tls.sha256);
  assert.equal(Buffer.from(String(tls.pkcs12), "base64url").toString("base64url"), tls.pkcs12);
  const before = Buffer.from(payload);
  await ensureGuestLaunch(f.config, f.machine, f.storage); assert.deepEqual(payload, before);
  saveRecord(join(f.storage, "guest-launch.json"), { ...receipt, version: 1 });
  await assert.rejects(ensureGuestLaunch(f.config, f.machine, f.storage), /cleanup-only/);
});
test("TLS signing and packing interruption retain durable hold against replacement and cleanup", async t => {
  const { spawnSync } = await import("node:child_process");
  for (const failAt of [1, 2, 3]) {
    const f = fixture(t); let calls = 0;
    f.config.tlsCommand = async (argv: string[]) => {
      assert.equal(readRecord(join(f.storage, "guest-launch.json")).state, "tls-building");
      const credential = String(readRecord(join(f.storage, "guest-launch.json")).credential);
      assert.equal(argv.join(" ").includes(credential), false); assert.equal(argv.join(" ").includes("canaveral-launch-v2"), false);
      if (++calls === failAt) throw new Error("interrupted TLS fixture");
      const result = spawnSync(argv[0]!, argv.slice(1), { env: {}, stdio: "ignore" }); assert.equal(result.status, 0);
    };
    await assert.rejects(ensureGuestLaunch(f.config, f.machine, f.storage), /interrupted TLS/);
    const before = readFileSync(join(f.storage, "guest-launch.json"));
    await assert.rejects(ensureGuestLaunch(f.config, f.machine, f.storage), /uncertain/);
    assert.deepEqual(readFileSync(join(f.storage, "guest-launch.json")), before);
    f.machine.desired = "stopped";
    await assert.rejects(f.provider.removeOwnedStorage(f.machine, {}, f.folder, randomUUID(), true), /exclusion/);
  }
});
test("shared native MAC vectors", async () => {
  const { guestMAC } = await import("../../src/providers/guest-tls.ts");
  const vectors = JSON.parse(readFileSync(new URL("../../../../fixtures/guest-mac.json", import.meta.url), "utf8"));
  for (const row of vectors) assert.equal(guestMAC(row.machineId), row.mac);
});
test("reused PKCS12 must contain the pinned leaf even when both identities are valid", async t => {
  const f = fixture(t), receipt = await ensureGuestLaunch(f.config, f.machine, f.storage), launchId = String((receipt.assignment as Data).launchId);
  const directory = join(f.root, "other-tls"); mkdirSync(directory, { mode: 0o700 });
  const other = await buildLaunchTLS(directory, launchId), original = validateLaunchTLS(receipt.tls, launchId);
  assert.notEqual(other.sha256, original.sha256);
  const mixed = { ...other, pkcs12: original.pkcs12 };
  assert.throws(() => validateLaunchTLS(mixed, launchId), /PKCS12 leaf differs/);
  assert.throws(() => validateLaunchTLS({ ...original, pkcs12: other.pkcs12 }, launchId), /PKCS12 leaf differs/);
  saveRecord(join(f.storage, "guest-launch.json"), { ...receipt, tls: mixed });
  const before = readFileSync(join(f.storage, "guest-launch.json"));
  await assert.rejects(ensureGuestLaunch(f.config, f.machine, f.storage), /PKCS12 leaf differs/);
  assert.deepEqual(readFileSync(join(f.storage, "guest-launch.json")), before); assert.equal(f.builds(), 1);
});
test("certificate clocks gate reuse without blocking expired custody inspection for cleanup", async t => {
  const f = fixture(t), receipt = await ensureGuestLaunch(f.config, f.machine, f.storage);
  const { X509Certificate } = await import("node:crypto");
  const cert = new X509Certificate(Buffer.from(String((receipt.tls as Data).leafDER), "base64url"));
  const before = readFileSync(join(f.storage, "guest-launch.json"));
  for (const time of [Date.parse(cert.validFrom) - 1, Date.parse(cert.validTo)]) {
    const clock = t.mock.method(Date, "now", () => time);
    try {
      await assert.rejects(ensureGuestLaunch(f.config, f.machine, f.storage), /not currently valid/);
      assert.deepEqual(guestLaunchReceipt(f.storage, f.machine), receipt);
    } finally { clock.mock.restore(); }
  }
  assert.deepEqual(readFileSync(join(f.storage, "guest-launch.json")), before); assert.equal(f.builds(), 1);
});
test("provider refuses wrong certificate profile and replaced private key without publishing", async t => {
  const { spawnSync } = await import("node:child_process");
  const { generateKeyPairSync } = await import("node:crypto");
  const { openSync, closeSync } = await import("node:fs");
  for (const variant of ["ca", "usage", "eku", "san", "key"]) {
    const f = fixture(t);
    f.config.tlsCommand = async (argv: string[], output?: string) => {
      if (argv[1] === "req") {
        const profile = argv[argv.indexOf("-config") + 1]!;
        let text = readFileSync(profile, "utf8");
        if (variant === "ca") text = text.replace("CA:false", "CA:true");
        if (variant === "usage") text = text.replace("critical,digitalSignature", "critical,keyEncipherment");
        if (variant === "eku") text = text.replace("serverAuth", "clientAuth");
        if (variant === "san") text = text.replace("subjectAltName=DNS:", "subjectAltName=DNS:wrong-");
        writeFileSync(profile, text);
        if (variant === "key") writeFileSync(argv[argv.indexOf("-key") + 1]!, generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ type: "pkcs8", format: "pem" }));
      }
      const fd = output === undefined ? undefined : openSync(output, "wx", 0o600);
      try { const result = spawnSync(argv[0]!, argv.slice(1), { env: {}, stdio: ["ignore", fd ?? "ignore", "ignore"] }); assert.equal(result.status, 0); }
      finally { if (fd !== undefined) closeSync(fd); }
    };
    await assert.rejects(ensureGuestLaunch(f.config, f.machine, f.storage), /TLS.*(profile|usage)/);
    assert.equal(readRecord(join(f.storage, "guest-launch.json")).state, "tls-building");
    assert.equal(f.builds(), 0);
  }
});
