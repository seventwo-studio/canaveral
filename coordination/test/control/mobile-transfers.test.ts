import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { AndroidProvider, loadHelper } from "../../src/providers/android.ts";
import { mobileNativeHelper, nativeContainerFiles } from "../../src/providers/mobile-native.ts";
import { atomicUpload, confined, writeAll } from "../../src/providers/mobile.ts";
import type { ByteReader, MobileTransport, NativePipe, RecordValue } from "../../src/providers/mobile.ts";

function temporary(t: { after(fn: () => void): void }) { const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mobile-transfer-"))); t.after(() => fs.rmSync(root, { force: true, recursive: true })); return root; }
function reader(data: Buffer): ByteReader { let offset = 0; return { read: async count => { const chunk = data.subarray(offset, offset + count); offset += chunk.length; return chunk; } }; }
function artifact(root: string) {
  const bytes = Buffer.alloc(128); Buffer.from("7f454c460201", "hex").copy(bytes); bytes.writeUInt16LE(3, 16); bytes.writeUInt16LE(183, 18);
  const sha256 = createHash("sha256").update(bytes).digest("hex"), file = path.join(root, "canaveral-transfer-arm64"), manifestPath = path.join(root, "manifest.json"); fs.writeFileSync(file, bytes);
  const manifest = { schemaVersion: 1, protocol: "CANAVERAL_TRANSFER_V1", minimumAPI: 26, artifacts: { arm64: { file: "canaveral-transfer-arm64", bytes: bytes.length, sha256 } } }; fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  return { bytes, sha256, file, manifestPath, manifest };
}
function fixture(t: { after(fn: () => void): void }) {
  const root = temporary(t), helper = artifact(root), image: RecordValue = { id: "android-phone", revision: "1", os: "android", arch: "arm64", mode: "device", device: { systemImage: "system-images;android-35;google_apis;arm64-v8a", profile: "pixel_8" } }, machine: RecordValue = { id: randomUUID(), template: image, resources: { cpu: 2, memoryMiB: 2048, diskGiB: 8 }, desired: "running" };
  let allowed = true, mode = "normal", committed = false, pipeClosed = false, calls: string[][] = [], data = Buffer.alloc(0), id = "", size = 0, stagedRead = false, committedRead = false;
  const transport: MobileTransport = {
    run: async argv => { calls.push([...argv]); const command = argv.at(-1)!; let stdout = "";
      if (command.includes("mkdir -m 700")) { id = /\.canaveral-transfer-([a-f0-9-]{36})/.exec(command)![1]!; stdout = "CREATED " + id; }
      else if (command.includes("sha256sum")) stdout = helper.sha256 + "  /data/local/tmp/.canaveral-transfer-" + id + "/helper";
      return { stdout, exitCode: 0 };
    },
    pipe: async argv => { size = Number(/ upload '[^']*' ([0-9]+) /.exec(argv.at(-1)!)![1]);
      const pipe: NativePipe = {
        read: async () => { if (!stagedRead) { stagedRead = true; if (mode === "revoke-before") allowed = false; return Buffer.from(`CANAVERAL_TRANSFER_V1 ${mode === "bad-stage" ? "WRONG" : "STAGED"} ${id} ${size}\n`); }
          if (!committedRead) { committedRead = true; if (mode === "revoke-after") allowed = false; return Buffer.from(`CANAVERAL_TRANSFER_V1 ${mode === "lost-ack" ? "WRONG" : "COMMITTED"} ${id} ${size}\n`); } return Buffer.alloc(0); },
        write: async bytes => { if (data.length < size) { data = Buffer.concat([data, bytes]); } else { assert.equal(Buffer.from(bytes).toString(), `COMMIT ${id}\n`); committed = true; } return bytes.length; },
        end: async () => {}, wait: async () => 0, close: async () => { pipeClosed = true; },
      }; return pipe;
    },
  };
  const provider = new AndroidProvider({ storage: path.join(root, "storage"), androidSDK: "/fixture/sdk", transferHelperManifest: helper.manifestPath, transport }, root);
  provider.endpoint = async (_machine, _storage, check = () => true) => { if (!await check()) throw new Error("unauthorized"); return "fixture-serial"; };
  provider.owned = async () => { if (!allowed) throw new Error("ownership unavailable after revocation"); };
  return { root, helper, provider, machine, image, calls, setMode: (value: string) => { mode = value; }, revoke: () => { allowed = false; }, get committed() { return committed; }, get data() { return data; }, get closed() { return pipeClosed; }, upload: (value: Buffer) => provider.streamUpload(machine, image, root, "/data/local/tmp/target", undefined, reader(value), value.length, () => allowed) };
}

test("Android helper snapshots validate hash, ELF architecture, API, metadata types and test hooks", t => {
  const root = temporary(t), helper = artifact(root), image: RecordValue = { arch: "arm64", device: { systemImage: "system-images;android-35;google_apis;arm64-v8a" } };
  assert.deepEqual(loadHelper({ transferHelperManifest: helper.manifestPath }, image).data, helper.bytes);
  for (const mutation of ["hash", "architecture", "api", "hooks", "boolean-version", "traversal"] as const) {
    const manifest = structuredClone(helper.manifest) as RecordValue, bytes = Buffer.from(helper.bytes), img = structuredClone(image); let payload = bytes;
    if (mutation === "hash") bytes[127] = 1;
    if (mutation === "architecture") bytes.writeUInt16LE(62, 18);
    if (mutation === "api") (img.device as RecordValue).systemImage = "system-images;android-25;google_apis;arm64-v8a";
    if (mutation === "hooks") payload = Buffer.concat([bytes, Buffer.from("CANAVERAL_TRANSFER_TEST_FAIL")]);
    if (mutation === "boolean-version") manifest.schemaVersion = true;
    const entry = ((manifest.artifacts as RecordValue).arm64 as RecordValue);
    if (mutation === "traversal") entry.file = "../outside";
    if (["architecture", "hooks"].includes(mutation)) { entry.bytes = payload.length; entry.sha256 = createHash("sha256").update(payload).digest("hex"); }
    fs.writeFileSync(helper.file, payload); fs.writeFileSync(helper.manifestPath, JSON.stringify(manifest));
    assert.throws(() => loadHelper({ transferHelperManifest: helper.manifestPath }, img), { code: "transfer_helper_invalid" });
  }
});

test("Android multi-chunk and empty uploads require exact staged/committed receipts", async t => {
  for (const bytes of [Buffer.alloc(0), Buffer.from([0, 13, 10, 255]), Buffer.alloc(1200000, 173)]) {
    const f = fixture(t); assert.deepEqual(await f.upload(bytes), { uploaded: bytes.length, durable: true }); assert.deepEqual(f.data, bytes); assert.ok(f.committed && f.closed);
    assert.ok(f.calls.some(c => c.at(-1)!.startsWith("rm -f -- "))); assert.ok(f.calls.every(c => !c.join(" ").includes("rm -rf")));
  }
});

test("Android precommit revocation and bad staging never commit or run unauthorized cleanup", async t => {
  for (const mode of ["revoke-before", "bad-stage"]) {
    const f = fixture(t); f.setMode(mode); await assert.rejects(f.upload(Buffer.from("new")), error => (error as { code: string }).code !== "upload_publication_uncertain"); assert.ok(!f.committed); assert.ok(f.closed);
    if (mode === "revoke-before") assert.ok(!f.calls.some(c => c.at(-1)!.startsWith("rm -f -- ")));
  }
});

test("Android lost commit receipt and postcommit revocation stay uncertain without rollback", async t => {
  for (const mode of ["lost-ack", "revoke-after"]) { const f = fixture(t); f.setMode(mode); await assert.rejects(f.upload(Buffer.from("new")), { code: "upload_publication_uncertain", outcome: "unknown" }); assert.ok(f.committed && f.closed); }
});

test("Android revoked and unsupported durable uploads refuse before guest mutation", async t => {
  const f = fixture(t); f.revoke(); await assert.rejects(f.upload(Buffer.from("new")), /authorization/); assert.deepEqual(f.calls, []);
  assert.throws(() => new AndroidProvider({ storage: f.root, androidSDK: "/fixture/sdk", transport: {} }, f.root).requireDurableUpload(f.image), { code: "capability_unsupported" });
});

test("native transfer short writes are completed and invalid counts fail", async () => {
  const chunks: Buffer[] = []; await writeAll({ write: async data => { chunks.push(Buffer.from(data.subarray(0, 3))); return Math.min(data.length, 3); } }, Buffer.from("abcdefg"), () => true); assert.equal(Buffer.concat(chunks).toString(), "abcdefg");
  for (const count of [0, -1, 999, NaN]) await assert.rejects(writeAll({ write: async () => count }, Buffer.from("x"), () => true));
});

const native = mobileNativeHelper({});
test("native container adapter pins renamed parents and refuses traversal, symlinks and no-replace collisions", { skip: !fs.existsSync(native) }, async t => {
  const root = temporary(t), container = path.join(root, "container"); fs.mkdirSync(container); fs.symlinkSync(root, path.join(container, "escape"));
  const files = nativeContainerFiles(native), dir = await files.openRoot(container);
  try {
    await assert.rejects(dir.directory("escape")); await assert.rejects(dir.directory(".."));
    fs.symlinkSync("missing", path.join(container, "dangling")); assert.equal(await dir.exists("dangling"), true); assert.equal(await dir.exists("absent"), false);
    const stage = await dir.createExclusive(".owned-stage"); await stage.write(Buffer.from("new")); await stage.sync(); await stage.close();
    assert.equal(await dir.publishOwned(".owned-stage", "dangling", false), "exists"); assert.equal(fs.readlinkSync(path.join(container, "dangling")), "missing");
    fs.renameSync(container, container + "-moved"); fs.mkdirSync(container);
    assert.equal(await dir.publishOwned(".owned-stage", "target", false), "published"); await dir.sync(); await dir.removeOwned(".owned-stage");
    assert.equal(fs.readFileSync(path.join(container + "-moved", "target"), "utf8"), "new"); assert.ok(!fs.existsSync(path.join(container, "target")));
  } finally { await dir.close(); }
});

test("native container downloads detect inode replacement and foreign upload stages are preserved", { skip: !fs.existsSync(native) }, async t => {
  const root = temporary(t), files = nativeContainerFiles(native), dir = await files.openRoot(root);
  try {
    fs.writeFileSync(path.join(root, "source"), "old"); const download = await dir.download("source");
    try { await download.verify(); fs.renameSync(path.join(root, "source"), path.join(root, "old-source")); fs.writeFileSync(path.join(root, "source"), "old"); await assert.rejects(download.verify()); } finally { await download.close(); }
    const stage = await dir.createExclusive(".stage"); await stage.write(Buffer.from("owned")); await stage.close(); fs.renameSync(path.join(root, ".stage"), path.join(root, ".original")); fs.writeFileSync(path.join(root, ".stage"), "foreign");
    await assert.rejects(dir.publishOwned(".stage", "destination", true)); await dir.removeOwned(".stage"); assert.equal(fs.readFileSync(path.join(root, ".stage"), "utf8"), "foreign");
  } finally { await dir.close(); }
});

test("native iOS-style streaming upload is durable and rechecks authorization at publication", { skip: !fs.existsSync(native) }, async t => {
  const root = temporary(t), files = nativeContainerFiles(native), bytes = Buffer.alloc(1300000, 91);
  const result = await confined(files, root, "target", (parent, name) => atomicUpload(parent, name, reader(bytes), bytes.length, () => true));
  assert.deepEqual(result, { uploaded: bytes.length, durable: true }); assert.deepEqual(fs.readFileSync(path.join(root, "target")), bytes);
  await assert.rejects(confined(files, root, "../escape", async () => true));
  let allowed = true; const source = reader(Buffer.from("new"));
  await assert.rejects(confined(files, root, "target", (parent, name) => atomicUpload(parent, name, { read: async n => { const data = await source.read(n); allowed = false; return data; } }, 3, () => allowed)), /authorization/);
  assert.deepEqual(fs.readFileSync(path.join(root, "target")), bytes);
});

test("Android downloads exclude completion markers and reject altered metadata, extra bytes and missing receipts", async t => {
  const root = temporary(t), image: RecordValue = { id: "android", revision: "1", os: "android", mode: "device", arch: "arm64", device: { systemImage: "system-images;android-35;google_apis;arm64-v8a", profile: "pixel_8" } }, machine: RecordValue = { id: randomUUID(), template: image, desired: "running", resources: { cpu: 2, memoryMiB: 2048, diskGiB: 8 } }, payload = Buffer.from("\0original\r\n\xff");
  for (const mode of ["normal", "missing", "extra", "metadata"]) {
    let closed = false, altered = false;
    const transport: MobileTransport = { run: async () => ({ stdout: "", exitCode: 0 }), pipe: async argv => {
      const markerName = /canaveral-download-complete-[a-f0-9]{32}/.exec(argv.at(-1)!)![0];
      const bytes = Buffer.concat([payload, Buffer.from(mode === "missing" ? "" : "\n" + markerName + "\n"), Buffer.from(mode === "extra" ? "extra" : "")]); let offset = 0;
      return { read: async count => { const data = bytes.subarray(offset, offset + count); offset += data.length; return data; }, write: async data => data.length, end: async () => {}, wait: async () => 0, close: async () => { closed = true; } };
    } };
    const provider = new AndroidProvider({ storage: path.join(root, mode), androidSDK: "/fixture/sdk", transport }, root);
    provider.endpoint = async () => "fixture"; provider.owned = async () => {};
    const metadata = (inode: number) => `1|${inode}|81a4|${payload.length}|2026-11-10 01:02:03.123456789 +0000|2026-11-10 01:02:03.123456789 +0000`;
    provider.adb = async () => metadata(altered ? 3 : 2);
    const source = await provider.streamDownload(machine, image, root, "/tmp/file';$(touch sentinel)");
    await source.verify(); assert.deepEqual(await source.read(payload.length), payload); altered = mode === "metadata";
    if (mode === "normal") { assert.equal(await source.verify(), true); assert.equal(await source.verify(), true); }
    else await assert.rejects(source.verify());
    await source.close(); await source.close(); assert.ok(closed);
  }
});

test("Android direct legacy upload remains explicitly nondurable while consumer preflight refuses it", async t => {
  const root = temporary(t), image: RecordValue = { id: "android", revision: "1", os: "android", mode: "device", arch: "arm64", device: { systemImage: "system-images;android-35;google_apis;arm64-v8a", profile: "pixel_8" } }, machine: RecordValue = { id: randomUUID(), template: image, desired: "running", resources: { cpu: 2, memoryMiB: 2048, diskGiB: 8 } }, calls: string[][] = [], chunks: Buffer[] = [];
  const provider = new AndroidProvider({ storage: path.join(root, "storage"), androidSDK: "/fixture/sdk", transport: { run: async (argv: string[]) => { calls.push(argv); return { stdout: "", exitCode: 0 }; }, pipe: async () => ({ read: async () => Buffer.alloc(0), write: async (bytes: Uint8Array) => { chunks.push(Buffer.from(bytes)); return bytes.length; }, end: async () => {}, wait: async () => 0, close: async () => {} }) } }, root);
  provider.endpoint = async () => "fixture"; provider.owned = async () => {};
  const payload = Buffer.from("legacy bytes"); assert.deepEqual(await provider.streamUpload(machine, image, root, "/tmp/target", undefined, reader(payload), payload.length, () => true), { uploaded: payload.length, durable: false });
  assert.deepEqual(Buffer.concat(chunks), payload); assert.ok(calls.some(argv => argv.at(-1)!.startsWith("mv -f -- "))); assert.throws(() => provider.requireDurableUpload(image), { code: "capability_unsupported" });
});
