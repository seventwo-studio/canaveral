import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { materializeIosApp } from "../../src/providers/ios-artifact.ts";
import { IosProvider } from "../../src/providers/ios.ts";
import type { Download, RecordValue } from "../../src/providers/mobile.ts";

interface Entry { name: string; data?: string | Buffer; kind?: number; mode?: number; link?: string; size?: number }
function tar(entries: Entry[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    const header = Buffer.alloc(512), data = Buffer.from(entry.data ?? "");
    header.write(entry.name, 0, 100); header.write((entry.mode ?? 0o755).toString(8).padStart(7, "0"), 100);
    header.write("0000000", 108); header.write("0000000", 116); header.write((entry.size ?? data.length).toString(8).padStart(11, "0"), 124); header.write("00000000000", 136);
    header.fill(32, 148, 156); header[156] = entry.kind ?? 48; header.write(entry.link ?? "", 157, 100); header.write("ustar\0", 257); header.write("00", 263);
    const checksum = header.reduce((sum, byte) => sum + byte, 0); header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148);
    parts.push(header, data, Buffer.alloc((512 - data.length % 512) % 512));
  }
  return Buffer.concat([...parts, Buffer.alloc(1024)]);
}
const appEntries: Entry[] = [{ name: "Demo.app/", kind: 53 }, { name: "Demo.app/Info.plist", data: "<plist>simulator</plist>", mode: 0o644 }, { name: "Demo.app/Demo", data: "executable", mode: 0o755 }];
function fixture(t: { after(fn: () => void): void }) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ios-artifact-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const destination = path.join(root, "extracted"); fs.mkdirSync(destination, { mode: 0o700 });
  const archive = path.join(root, "application.tar");
  return { root, destination, archive };
}

test("iOS application archives materialize one complete app and preserve executable ownership permissions", async t => {
  const f = fixture(t), bytes = tar([...appEntries, { name: "Demo.app/Assets/image.png", data: Buffer.alloc(150_000, 7), mode: 0o644 }]); fs.writeFileSync(f.archive, bytes);
  const app = await materializeIosApp(f.archive, f.destination, { maxBytes: bytes.length, authorized: () => true });
  assert.equal(app, path.join(f.destination, "Demo.app")); assert.equal(fs.readFileSync(path.join(app, "Demo"), "utf8"), "executable");
  assert.equal(fs.statSync(path.join(app, "Demo")).mode & 0o777, 0o700); assert.equal(fs.statSync(path.join(app, "Info.plist")).mode & 0o777, 0o600);
  assert.deepEqual(fs.readFileSync(path.join(app, "Assets/image.png")), Buffer.alloc(150_000, 7));
});

test("iOS archive extraction rejects traversal, links, special entries, duplicate paths and multiple apps", async t => {
  const cases: Entry[][] = [
    [{ name: "/Demo.app/Info.plist", data: "x" }], [{ name: "Demo.app/../../outside", data: "x" }], [{ name: "Demo.app/a\\b", data: "x" }],
    [{ name: "Demo.app/./Info.plist", data: "x" }], [{ name: "Demo.app//Info.plist", data: "x" }],
    [...appEntries, { name: "Demo.app/link", kind: 50, link: "../../outside" }], [...appEntries, { name: "Demo.app/hardlink", kind: 49, link: "Demo.app/Demo" }],
    [...appEntries, { name: "Demo.app/device", kind: 51 }], [...appEntries, { name: "Demo.app/pax", kind: 120 }],
    [...appEntries, { name: "Demo.app/Info.plist", data: "replacement" }], [...appEntries, { name: "Other.app/Info.plist", data: "x" }],
    [...appEntries, { name: "Demo.app/suid", data: "x", mode: 0o4755 }], [{ name: "Demo.app", data: "not a directory" }],
  ];
  for (const entries of cases) {
    const f = fixture(t), bytes = tar(entries); fs.writeFileSync(f.archive, bytes);
    await assert.rejects(materializeIosApp(f.archive, f.destination, { maxBytes: bytes.length, authorized: () => true }));
    assert.equal(fs.existsSync(path.join(f.root, "outside")), false);
  }
});

test("iOS archive extraction rejects corrupt/truncated envelopes, missing metadata and unsafe destinations", async t => {
  const valid = tar(appEntries), corrupt = Buffer.from(valid); corrupt[10] = 1;
  for (const bytes of [corrupt, valid.subarray(0, valid.length - 512), Buffer.concat([valid, Buffer.alloc(512, 1)]), tar([{ name: "Demo.app/Demo", data: "x" }]), tar([{ name: "Demo.app/Info.plist", data: "" }]), tar([{ name: "Demo.app/huge", size: 2 ** 35 }])]) {
    const f = fixture(t); fs.writeFileSync(f.archive, bytes);
    await assert.rejects(materializeIosApp(f.archive, f.destination, { maxBytes: bytes.length, authorized: () => true }));
  }
  const f = fixture(t); fs.writeFileSync(f.archive, valid);
  await assert.rejects(materializeIosApp(f.archive, f.destination, { maxBytes: valid.length - 1, authorized: () => true }));
  fs.writeFileSync(path.join(f.destination, "foreign"), "preserve");
  await assert.rejects(materializeIosApp(f.archive, f.destination, { maxBytes: valid.length, authorized: () => true }), /fresh private/);
  assert.equal(fs.readFileSync(path.join(f.destination, "foreign"), "utf8"), "preserve");
});

function providerFixture(t: { after(fn: () => void): void }, bytes = tar(appEntries)) {
  const f = fixture(t), calls: string[][] = [], id = randomUUID(); let closed = false, reads = 0, verified = 0, allowed = true;
  const image: RecordValue = { id: "ios-phone", revision: "1", os: "ios", arch: "arm64", mode: "device", device: { runtime: "com.apple.CoreSimulator.SimRuntime.iOS-27-0", deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-17" } };
  const machine: RecordValue = { id: randomUUID(), template: image, desired: "running", resources: { cpu: 2, memoryMiB: 4096, diskGiB: 12 } };
  const provider = new IosProvider({ storage: path.join(f.root, "storage"), transport: { run: async (argv: string[]) => {
    calls.push([...argv]); assert.deepEqual(argv.slice(0, 4), ["xcrun", "simctl", "install", id]);
    assert.equal(fs.readFileSync(path.join(argv[4]!, "Demo"), "utf8"), "executable"); return { exitCode: 0, stdout: "" };
  } } }, f.root);
  provider.owned = async () => ({ udid: id, state: "Booted" });
  let offset = 0;
  const source: Download = { size: bytes.length, async read(maximum) { reads++; const chunk = bytes.subarray(offset, offset + Math.min(maximum, 317)); offset += chunk.length; return chunk; }, async verify() { verified++; return true; }, async close() { closed = true; } };
  return { ...f, provider, image, machine, source, calls, sha256: createHash("sha256").update(bytes).digest("hex"), check: () => allowed, revoke: () => { allowed = false; }, get closed() { return closed; }, get reads() { return reads; }, get verified() { return verified; } };
}

test("iOS uploaded artifact installation streams, verifies and targets the owned UDID, then removes its stage", async t => {
  const f = providerFixture(t);
  assert.deepEqual(await f.provider.installArtifact(f.machine, f.image, f.root, f.source, f.sha256, f.check), { installed: true, sha256: f.sha256, bytes: f.source.size, artifactCleaned: true });
  assert.equal(f.calls.length, 1); assert.ok(f.reads > 1); assert.equal(f.verified, 2); assert.equal(f.closed, true);
  assert.equal(fs.readdirSync(f.provider.storage(f.machine, f.image)).some(name => name.startsWith(".artifact-")), false);
});

test("iOS uploaded artifact refusal never installs mismatched bytes, revoked transfers or changed source identities", async t => {
  for (const failure of ["digest", "authorization", "source", "malformed"] as const) {
    const f = providerFixture(t, failure === "malformed" ? tar([{ name: "../escape", data: "x" }]) : undefined);
    if (failure === "authorization") { const read = f.source.read; f.source.read = async n => { const result = await read(n); f.revoke(); return result; }; }
    if (failure === "source") f.source.verify = async () => false;
    await assert.rejects(f.provider.installArtifact(f.machine, f.image, f.root, f.source, failure === "digest" ? "0".repeat(64) : f.sha256, f.check));
    assert.equal(f.calls.length, 0); assert.equal(f.closed, true);
    assert.equal(fs.readdirSync(f.provider.storage(f.machine, f.image)).some(name => name.startsWith(".artifact-")), false);
  }
});

test("iOS uploaded artifacts recheck simulator ownership before dispatch and preserve uncertainty after dispatch", async t => {
  for (const transition of ["before", "after"] as const) {
    const f = providerFixture(t), original = await f.provider.owned(f.machine, f.image, "unused"); let observations = 0;
    f.provider.owned = async () => { observations++; return observations >= (transition === "before" ? 2 : 3) ? { ...original, udid: randomUUID() } : original; };
    await assert.rejects(f.provider.installArtifact(f.machine, f.image, f.root, f.source, f.sha256, f.check), error => {
      assert.match((error as Error).message, /identity changed/);
      if (transition === "after") assert.equal((error as { outcome?: string }).outcome, "unknown");
      return true;
    });
    assert.equal(f.calls.length, transition === "before" ? 0 : 1); assert.equal(f.closed, true);
  }
});

test("iOS installation never claims cleaned artifacts when its private stage was replaced", async t => {
  const f = providerFixture(t), run = f.provider.transport!.run;
  f.provider.transport!.run = async (argv, options) => {
    const result = await run(argv, options), stage = path.dirname(path.dirname(argv[4]!));
    fs.renameSync(stage, stage + ".moved"); fs.mkdirSync(stage, { mode: 0o700 }); fs.writeFileSync(path.join(stage, "foreign"), "preserve");
    return result;
  };
  await assert.rejects(f.provider.installArtifact(f.machine, f.image, f.root, f.source, f.sha256, f.check), error => {
    assert.match((error as Error).message, /cleanup is unconfirmed/); assert.equal((error as { outcome?: string }).outcome, "unknown"); return true;
  });
  const storage = f.provider.storage(f.machine, f.image), replacement = fs.readdirSync(storage).find(name => name.startsWith(".artifact-") && !name.endsWith(".moved"))!;
  assert.equal(fs.readFileSync(path.join(storage, replacement, "foreign"), "utf8"), "preserve"); assert.equal(f.closed, true);
});
