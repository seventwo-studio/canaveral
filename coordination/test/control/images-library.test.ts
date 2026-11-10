import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs, { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { checksum, ImageLibrary, prepareImage } from "../../src/control/images.ts";
import type { CaptureProvider, CaptureTask, ImageReader } from "../../src/control/images.ts";
import { legacyJson } from "../../src/control/templates.ts";
import { ServiceError } from "../../src/errors.ts";

const hash = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
const spec = (extra = {}) => ({ id: randomUUID(), name: "Fixture disk", os: "linux", arch: "amd64", mode: "headless", mediaType: "disk", format: "raw", minimum: { cpu: 1, memoryMiB: 1024, diskGiB: 4 }, ...extra });
function reader(data: Uint8Array): ImageReader { let position = 0; return { read(count) { const result = data.subarray(position, position + count); position += result.length; return result; } }; }
function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "image-library-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const library = new ImageLibrary(join(root, "state")); return { root, library };
}
function captureFixture(t: test.TestContext, exit?: (library: ImageLibrary, task: CaptureTask, disk: string) => void) {
  const { root, library } = fixture(t), disk = join(root, "source.raw"); writeFileSync(disk, Buffer.alloc(2_097_152, 1));
  const machineId = randomUUID(), task: CaptureTask = { id: randomUUID(), machineId, name: "Configured fixture", machine: { id: machineId, desired: "stopped", observed: "stopped", resources: { cpu: 1, memoryMiB: 1024, diskGiB: 4 } } };
  const image = { os: "linux", arch: "amd64", mode: "headless" }; let calls = 0;
  const provider: CaptureProvider = { async withCaptureSource(_m, _i, _f, consume) { calls++; const value = await consume(disk, "raw"); exit?.(library, task, disk); return value; } };
  return { root, library, disk, task, image, provider, calls: () => calls };
}

test("sparse import has immutable independent bytes, private bindings and acknowledgement gating", async t => {
  const { library } = fixture(t), metadata = spec(), payload = Buffer.alloc(2_097_152);
  const result = await library.importStream(metadata, reader(payload), payload.length, () => true);
  assert.equal(result.sha256, hash(payload)); assert.deepEqual(library.definitions(), []);
  assert.ok(!JSON.stringify(result).includes(library.root));
  library.acknowledge({ [metadata.id]: "b".repeat(64) }); assert.deepEqual(library.definitions(), []);
  library.acknowledge({ [metadata.id]: result.sha256 });
  const definition = library.definitions()[0]!; assert.equal(checksum(String(definition.image)), result.sha256);
  assert.equal(lstatSync(String(definition.image)).size, payload.length);
  if (process.platform !== "win32") assert.equal(lstatSync(library.root).mode & 0o777, 0o700);
  assert.deepEqual(await library.importStream(metadata, reader(payload), payload.length, () => true), result);
  await assert.rejects(library.importStream(metadata, reader(Buffer.alloc(512, 9)), 512, () => true));
  assert.equal(library.records().length, 1);
  library.verifyDefinition(definition); library.verifyDefinition(definition);
  chmodSync(String(definition.image), 0o600); writeFileSync(String(definition.image), Buffer.alloc(payload.length, 2));
  assert.throws(() => library.verifyDefinition(definition), /checksum|changed/);
  // An identical UUID retry returns its receipt, without blessing changed stored bytes.
  assert.deepEqual(await library.importStream(metadata, reader(payload), payload.length, () => true), result);
  await assert.rejects(library.importStream(spec(), reader(payload), payload.length, () => true), /checksum/);
});

test("interrupted, revoked, oversized chunks, backing disks and wrong media never publish", async t => {
  const { library } = fixture(t);
  await assert.rejects(library.importStream(spec(), reader(Buffer.alloc(512)), 1024, () => true));
  await assert.rejects(library.importStream(spec(), reader(Buffer.alloc(512)), 512, () => false));
  await assert.rejects(library.importStream(spec(), { read: () => Buffer.alloc(1024) }, 512, () => true));
  let authorized = true;
  await assert.rejects(library.importStream(spec(), { read: count => { authorized = false; return Buffer.alloc(count); } }, 512, () => authorized));
  await assert.rejects(library.importStream(spec({ mediaType: "installer", format: "iso" }), reader(Buffer.alloc(512)), 512, () => true));
  const backing = Buffer.alloc(512); backing.set([81, 70, 73, 251, 0, 0, 0, 3]); backing[15] = 1;
  await assert.rejects(library.importStream(spec({ format: "qcow2" }), reader(backing), 512, () => true), /backing/);
  await assert.rejects(library.importStream(spec(), reader(Buffer.alloc(512)), 512, () => true, { expectedSha256: "a".repeat(64) }), /checksum/);
  await assert.rejects(library.importStream(spec({ guestAccess: true }), reader(Buffer.alloc(512)), 512, () => true), /preparation/);
  assert.deepEqual(library.records(), []); assert.deepEqual(readdirSync(library.root), []);
});

test("nonregular artifacts and symlink roots are refused without overwriting them", { skip: process.platform === "win32" }, async t => {
  const { root, library } = fixture(t), payload = Buffer.alloc(512, 1), target = join(library.root, `${hash(payload)}.raw`), retained = join(root, "retained"); writeFileSync(retained, payload);
  for (const kind of ["symlink", "directory", "fifo"]) {
    if (kind === "symlink") symlinkSync(retained, target);
    else if (kind === "directory") mkdirSync(target);
    else assert.equal(spawnSync("mkfifo", [target]).status, 0);
    const inode = lstatSync(target).ino;
    assert.throws(() => checksum(target));
    assert.throws(() => library.verifyDefinition({ image: target, artifactSha256: hash(payload) }));
    await assert.rejects(library.importStream(spec(), reader(payload), payload.length, () => true));
    assert.equal(lstatSync(target).ino, inode); assert.deepEqual(library.records(), []);
    rmSync(target, { recursive: true });
  }
  const external = join(root, "external"); mkdirSync(external); symlinkSync(external, join(root, "linked-state"));
  assert.throws(() => new ImageLibrary(join(root, "linked-state")));
  renameSync(library.root, library.root + ".retained"); symlinkSync(external, library.root);
  assert.throws(() => library.records());
});

test("checksum pins descriptor, ignores growing tails and rejects replaced paths/restored mtime", t => {
  const { root } = fixture(t), path = join(root, "artifact"), originalRead = fs.readSync;
  for (const kind of ["growth", "replacement", "restored-mtime"]) {
    writeFileSync(path, Buffer.alloc(2_097_152, 1)); const before = fs.statSync(path); const limits: number[] = []; let changed = false;
    const mock = t.mock.method(fs, "readSync", ((fd: number, buffer: Buffer, offset: number, length: number, position: number) => {
      limits.push(length); const count = originalRead(fd, buffer, offset, length, position);
      if (!changed) {
        changed = true;
        if (kind === "growth") fs.appendFileSync(path, "extension");
        else if (kind === "replacement") { renameSync(path, path + ".retained"); writeFileSync(path, Buffer.alloc(2_097_152, 2)); }
        else { const write = fs.openSync(path, "r+"); fs.writeSync(write, Buffer.alloc(1_048_576, 2), 0, 1_048_576, 1_048_576); fs.closeSync(write); fs.utimesSync(path, before.atime, before.mtime); }
      }
      return count;
    }) as typeof fs.readSync);
    syncBuiltinESMExports();
    try { assert.throws(() => checksum(path), /changed/); assert.deepEqual(limits, [1_048_576, 1_048_576]); }
    finally { mock.mock.restore(); syncBuiltinESMExports(); }
  }
});

test("capture stages until fence exit; exit failure/change quarantines and is never replayed", async t => {
  for (const failure of ["throw", "changed"]) {
    const f = captureFixture(t, (library, task, disk) => {
      assert.ok(existsSync(join(library.root, `${task.id}.staged`))); assert.ok(!existsSync(join(library.root, `${task.id}.json`)));
      if (failure === "throw") throw new Error("Fence exit unconfirmed");
      writeFileSync(disk, "changed source");
    });
    const report = await f.library.capture(f.task, f.provider, f.image);
    assert.equal(report.state, "unknown"); assert.deepEqual(f.library.records(), []);
    assert.ok(existsSync(join(f.library.root, `${f.task.id}.quarantined`)));
    assert.deepEqual(await f.library.capture(f.task, f.provider, f.image), report); assert.equal(f.calls(), 1);
  }
});

test("capture source substitution before open refuses files, links and FIFOs", { skip: process.platform === "win32" }, async t => {
  for (const kind of ["file", "symlink", "fifo"]) {
    const f = captureFixture(t), originalOpen = fs.openSync; let swapped = false;
    const mock = t.mock.method(fs, "openSync", ((path: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
      if (String(path) === f.disk && !swapped) {
        swapped = true; renameSync(f.disk, f.disk + ".retained");
        if (kind === "file") writeFileSync(f.disk, Buffer.alloc(2_097_152, 2));
        else if (kind === "symlink") symlinkSync(f.disk + ".retained", f.disk);
        else assert.equal(spawnSync("mkfifo", [f.disk]).status, 0);
      }
      return originalOpen(path, flags, mode);
    }) as typeof fs.openSync); syncBuiltinESMExports();
    let report;
    try { report = await f.library.capture(f.task, f.provider, f.image); }
    finally { mock.mock.restore(); syncBuiltinESMExports(); }
    assert.ok(swapped); assert.equal(report.state, "failed"); assert.deepEqual(f.library.records(), []);
    assert.deepEqual(readdirSync(f.library.root).filter(p => p.endsWith(".partial")), []);
  }
});

test("restored-mtime source mutation during capture copy quarantines the staged manifest", async t => {
  const f = captureFixture(t), before = fs.statSync(f.disk), originalRead = fs.readSync; let changed = false;
  const mock = t.mock.method(fs, "readSync", ((fd: number, buffer: Buffer, offset: number, length: number, position: number) => {
    const count = originalRead(fd, buffer, offset, length, position);
    if (!changed && fs.fstatSync(fd).ino === before.ino) {
      changed = true; const write = fs.openSync(f.disk, "r+");
      fs.writeSync(write, Buffer.alloc(1_048_576, 9), 0, 1_048_576, 1_048_576); fs.closeSync(write); fs.utimesSync(f.disk, before.atime, before.mtime);
    }
    return count;
  }) as typeof fs.readSync); syncBuiltinESMExports();
  let report;
  try { report = await f.library.capture(f.task, f.provider, f.image); }
  finally { mock.mock.restore(); syncBuiltinESMExports(); }
  assert.ok(changed); assert.equal(report.state, "unknown"); assert.deepEqual(f.library.records(), []);
  assert.ok(existsSync(join(f.library.root, `${f.task.id}.quarantined`)));
});

test("successful capture is independent; lost-receipt recovery checks manifest identity and digest", async t => {
  const f = captureFixture(t), report = await f.library.capture(f.task, f.provider, f.image);
  assert.equal(report.state, "succeeded");
  const record = f.library.records()[0]!, artifact = String(record.definition.image);
  assert.notEqual(lstatSync(artifact).ino, lstatSync(f.disk).ino);
  writeFileSync(f.disk, "reconfigured source"); assert.equal(checksum(artifact), report.result.sha256);
  const receipt = join(f.library.root, `${f.task.id}.capture.json.receipt`);
  const started = { fingerprint: legacyJson({ id: f.task.id, machineId: f.task.machineId, name: f.task.name }), started: true };
  writeFileSync(receipt, JSON.stringify(started));
  assert.deepEqual(await f.library.capture(f.task, f.provider, f.image), report); assert.equal(f.calls(), 1);
  record.public.name = "Changed name"; record.definition.name = "Changed name";
  writeFileSync(join(f.library.root, `${f.task.id}.json`), JSON.stringify(record));
  assert.equal((await f.library.capture(f.task, f.provider, f.image)).state, "unknown"); assert.equal(f.calls(), 1);
});

test("post-publication sync uncertainty retains artifact and durable unknown receipt", { skip: process.platform === "win32" }, async t => {
  const f = captureFixture(t), sync = fs.fsyncSync; let fault = false;
  const mock = t.mock.method(fs, "fsyncSync", (fd: number) => {
    if (!fault && fs.fstatSync(fd).isDirectory() && existsSync(join(f.library.root, `${f.task.id}.json`))) { fault = true; throw new Error("Unconfirmed directory sync"); }
    return sync(fd);
  }); syncBuiltinESMExports();
  let report;
  try { report = await f.library.capture(f.task, f.provider, f.image); }
  finally { mock.mock.restore(); syncBuiltinESMExports(); }
  assert.ok(fault); assert.equal(report.state, "unknown"); assert.deepEqual(f.library.definitions(), []);
  assert.equal(checksum(String(f.library.records()[0]!.definition.image)), f.library.records()[0]!.public.sha256);
  assert.deepEqual(await f.library.capture(f.task, f.provider, f.image), report); assert.equal(f.calls(), 1);
});

test("base cache resolves local links once, preserves sparse contents and verifies every cache reuse", async t => {
  const { root } = fixture(t), source = join(root, "source.raw"), link = join(root, "configured-link"), payload = Buffer.alloc(2_097_152);
  payload.set(Buffer.from("prefix")); writeFileSync(source, payload); symlinkSync(source, link);
  const cache = join(root, "cache"), spec = { path: link, sha256: hash(payload), format: "raw" };
  const target = await prepareImage(spec, cache); assert.equal(checksum(target), spec.sha256);
  assert.notEqual(lstatSync(source).ino, lstatSync(target).ino);
  assert.equal(await prepareImage(spec, cache), target);
  chmodSync(target, 0o600); writeFileSync(target, Buffer.alloc(512));
  await assert.rejects(prepareImage(spec, cache), /checksum/); assert.equal(readFileSync(target).length, 512);
  assert.equal(readdirSync(cache).filter(p => p.endsWith(".partial")).length, 0);
});

test("base cache keeps a competing publisher inode and never overwrites bad competitors", async t => {
  const { root } = fixture(t), cache = join(root, "cache"), payload = Buffer.alloc(512, 7), digest = hash(payload), target = join(cache, `${digest}.raw`);
  let inode = 0;
  const targetPath = await prepareImage({ url: "https://publisher.example/disk", sha256: digest, format: "raw" }, cache, { openSource: async () => {
    let sent = false; return { read() { if (sent) return Buffer.alloc(0); sent = true; writeFileSync(target, payload); inode = lstatSync(target).ino; return payload; } };
  } });
  assert.equal(targetPath, realpathSync(target)); assert.equal(lstatSync(target).ino, inode);
  assert.deepEqual(readdirSync(cache), [`${digest}.raw`]);
});

test("base cache authorization loss and wrong digests clean temporary copies", async t => {
  const { root } = fixture(t), cache = join(root, "cache"); let authorized = true;
  await assert.rejects(prepareImage({ url: "https://publisher.example/disk", sha256: hash(Buffer.alloc(512)), format: "raw" }, cache, {
    authorized: () => authorized, openSource: async () => ({ read() { authorized = false; return Buffer.alloc(512); } }),
  }), /authorization/);
  assert.deepEqual(readdirSync(cache), []);
  const disk = join(root, "wrong-disk"); writeFileSync(disk, Buffer.alloc(512, 3));
  await assert.rejects(prepareImage({ path: disk, sha256: "a".repeat(64), format: "raw" }, cache), /checksum/);
  assert.deepEqual(readdirSync(cache), []);
});

test("base cache sync failures expose unknown publication and retain the verified target", { skip: process.platform === "win32" }, async t => {
  const { root } = fixture(t), source = join(root, "disk"), payload = Buffer.alloc(512, 8); writeFileSync(source, payload);
  const cache = join(root, "cache"), sync = fs.fsyncSync;
  const mock = t.mock.method(fs, "fsyncSync", (fd: number) => { if (fs.fstatSync(fd).isDirectory()) throw new Error("sync unavailable"); sync(fd); }); syncBuiltinESMExports();
  try { await assert.rejects(prepareImage({ path: source, sha256: hash(payload), format: "raw" }, cache), e => e instanceof ServiceError && e.code === "image_cache_publication_uncertain" && e.outcome === "unknown" && !e.retryable); }
  finally { mock.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(checksum(join(cache, `${hash(payload)}.raw`)), hash(payload)); assert.equal(readdirSync(cache).length, 1);
});
