import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { ServiceError } from "../../src/errors.ts";
import { androidUpload, atomicUpload, CHUNK, copyDownload, copyUpload, decodeData, fileIdentity, GUEST_CHUNK, GuestChunkFiles, guestPath, jsonBytes, receiveFile, saveJson, validateAndroidHelper, withHostLock, writeAll } from "../../src/control/transfers.ts";
import type { AndroidUploadProvider, ByteReader, ByteWriter, PinnedDirectory, TransferGuard } from "../../src/control/transfers.ts";

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function reader(bytes: Uint8Array): ByteReader {
  let offset = 0;
  return { read(maximum) { const result = bytes.subarray(offset, offset + maximum); offset += result.length; return result; } };
}
function sink(): ByteWriter & { chunks: Buffer[] } {
  return { chunks: [], write(data) { this.chunks.push(Buffer.from(data)); return data.length; } };
}
const status = (code: number) => (error: unknown) => error instanceof ServiceError && error.status === code;
const code = (expected: string) => (error: unknown) => error instanceof ServiceError && error.code === expected;
const guard: TransferGuard = { authorized: () => true };

test("Python transfer negatives: revocation during read and oversized/early source never reach writer", async () => {
  const output = sink(); let allowed = true;
  await assert.rejects(copyUpload({ read() { allowed = false; return Buffer.from("late"); } }, output, 4, { authorized: () => allowed }), status(401));
  assert.equal(output.chunks.length, 0);
  await assert.rejects(copyUpload({ read() { return Buffer.from("excess"); } }, output, 1), status(400));
  await assert.rejects(copyUpload(reader(Buffer.alloc(0)), output, 1), status(400));
  await assert.rejects(copyUpload(reader(Buffer.alloc(0)), output, 0, { authorized: () => false }), status(401));
  assert.equal(output.chunks.length, 0);
});

test("large virtual uploads have bounded memory and short writes finish without replay", async () => {
  const total = 513 * 1024 * 1024 + 17; let largest = 0, count = 0;
  const slab = Buffer.alloc(CHUNK);
  await copyUpload({ read(size) { largest = Math.max(largest, size); return slab.subarray(0, size); } }, { write(data) { count += data.length; return data.length; } }, total);
  assert.equal(count, total); assert.equal(largest, CHUNK);
  const chunks: Buffer[] = [];
  await writeAll({ write(data) { chunks.push(Buffer.from(data.subarray(0, 3))); return Math.min(3, data.length); } }, Buffer.from("abcdefg"));
  assert.equal(Buffer.concat(chunks).toString(), "abcdefg");
  for (const invalid of [0, -1, NaN, true, undefined, 10]) await assert.rejects(writeAll({ write() { return invalid as number; } }, Buffer.from("x")), ServiceError);
});

test("path, base64 and receipt validation reject host escapes and malformed data", () => {
  for (const path of ["../escape", "/absolute", "safe/../escape", "a\0b", "a\\b", "."]) assert.throws(() => guestPath(path, "container"), status(400));
  assert.equal(guestPath(".", "container", true), "."); assert.equal(guestPath("nested/safe", "container"), "nested/safe");
  for (const path of ["relative", "/a/../b", "/", "/a/"]) assert.throws(() => guestPath(path, "absolute"), status(400));
  assert.equal(guestPath("/", "absolute", true), "/");
  for (const value of ["???", "eA", "eA===", "eA==\n", Buffer.alloc(GUEST_CHUNK + 1).toString("base64"), true]) assert.throws(() => decodeData(value), status(400));
  assert.equal(decodeData("").length, 0); assert.equal(decodeData("eA==").toString(), "x");
  assert.throws(() => jsonBytes({ n: NaN }, 100), status(400));
  assert.throws(() => jsonBytes({ output: "\n".repeat(100) }, 150), status(413));
  const metadata = { dev: 1n, ino: 2n, size: 3n, mtimeNs: 4n, ctimeNs: 5n };
  assert.notEqual(fileIdentity(metadata), fileIdentity({ ...metadata, ctimeNs: 6n }));
});

// Filesystem provider double: asserts sequencing and mutation boundaries without native execution.
function directory() {
  const events: string[] = [], files = new Map<string, Buffer>([["file", Buffer.from("original")]]);
  let fail = "", race = false, cleanupCount = 0;
  const provider: PinnedDirectory = {
    exists(name) { events.push("exists"); return files.has(name); },
    createExclusive(name) {
      events.push("create");
      if (fail === "collision") throw new Error("foreign collision");
      let buffer = Buffer.alloc(0), published = false;
      return {
        write(data) { events.push("write"); buffer = Buffer.concat([buffer, data]); return data.length; },
        sync() { events.push("file-sync"); if (fail === "file-sync") throw new Error("disk full"); },
        publish(target, replace) {
          events.push("publish");
          if (race) files.set(target, Buffer.from("racer"));
          if (!replace && files.has(target)) throw new ServiceError("exists", 409, { code: "download_destination_exists" });
          files.set(target, buffer); published = true;
          if (fail === "lost-receipt") throw new Error("lost publication acknowledgement");
        },
        cleanup() { events.push("cleanup"); cleanupCount++; if (fail === "cleanup") throw new Error("cleanup uncertain"); if (!published) files.delete(name); },
        close() { events.push("close"); },
      };
    },
    sync() { events.push("directory-sync"); if (fail === "directory-sync") throw new Error("directory sync uncertain"); },
  };
  return { provider, files, events, fail(value: string) { fail = value; }, race() { race = true; }, get cleanupCount() { return cleanupCount; } };
}

test("atomic upload preserves destination until complete data, file sync, rename and directory sync", async () => {
  const fixture = directory(), { provider, files, events } = fixture;
  await assert.rejects(atomicUpload(provider, "file", reader(Buffer.from("partial")), 100));
  assert.equal(files.get("file")!.toString(), "original");
  events.length = 0;
  assert.deepEqual(await atomicUpload(provider, "file", reader(Buffer.from("durable")), 7), { uploaded: 7, durable: true });
  assert.equal(files.get("file")!.toString(), "durable");
  assert.deepEqual(events, ["create", "write", "file-sync", "publish", "directory-sync", "cleanup", "close"]);
  fixture.fail("directory-sync");
  await assert.rejects(atomicUpload(provider, "file", reader(Buffer.from("new")), 3), code("upload_publication_uncertain"));
  assert.equal(files.get("file")!.toString(), "new");
});

test("download no-replace, races, partial transfer and pre/post publication failure semantics", async () => {
  const f = directory(); let transfers = 0;
  const transfer = async (writer: ByteWriter) => { transfers++; await writeAll(writer, Buffer.from("verified")); return "receipt"; };
  await assert.rejects(receiveFile(f.provider, "file", transfer), code("download_destination_exists")); assert.equal(transfers, 0);
  await assert.rejects(receiveFile(f.provider, "file", async writer => { await writeAll(writer, Buffer.from("bad")); throw new Error("digest mismatch"); }, true));
  assert.equal(f.files.get("file")!.toString(), "original");
  f.fail("file-sync"); await assert.rejects(receiveFile(f.provider, "file", transfer, true)); assert.equal(f.files.get("file")!.toString(), "original");
  f.fail("lost-receipt"); await assert.rejects(receiveFile(f.provider, "file", transfer, true), code("download_publication_uncertain")); assert.equal(f.files.get("file")!.toString(), "verified");
  const race = directory(); race.race();
  await assert.rejects(receiveFile(race.provider, "new", transfer), code("download_destination_exists")); assert.equal(race.files.get("new")!.toString(), "racer");
  const collision = directory(); collision.fail("collision");
  await assert.rejects(receiveFile(collision.provider, "new", transfer)); assert.equal(collision.cleanupCount, 0);
  const cleanup = directory(); cleanup.fail("cleanup");
  await assert.rejects(receiveFile(cleanup.provider, "new", async () => { throw new Error("bad transfer"); }), code("download_temporary_cleanup_failed"));
  await assert.rejects(receiveFile(undefined, "new", transfer), code("capability_unsupported"));
  await saveJson(failFree(), "receipt.json", { started: true });
  function failFree() { return directory().provider; }
});

test("host lock always releases and unavailable locking fails closed", async () => {
  let acquired = 0, released = 0;
  await assert.rejects(withHostLock({ acquireExclusive() { acquired++; return () => { released++; }; } }, () => { throw new Error("crash"); }));
  assert.equal(acquired, 1); assert.equal(released, 1);
  await assert.rejects(withHostLock(undefined, () => true), code("capability_unsupported"));
});

test("download rechecks identity and authorization around bytes, verifies before finish and always closes", async () => {
  const output = sink(); let allowed = true, closed = 0, checks = 0;
  const source = { size: 4, read() { allowed = false; return Buffer.from("late"); }, verify() { checks++; return true; }, close() { closed++; } };
  await assert.rejects(copyDownload(source, output, { authorized: () => allowed }), status(401));
  assert.equal(output.chunks.length, 0); assert.equal(closed, 1);
  const bytes = Buffer.from("verified\0\r\n"), input = reader(bytes);
  const receipt = await copyDownload({ ...input, size: bytes.length, verify() { checks++; return true; }, close() { closed++; } }, output);
  assert.deepEqual(receipt, { bytes: bytes.length, sha256: sha(bytes) }); assert.equal(checks, 3); assert.equal(closed, 2);
  assert.equal(Buffer.concat(output.chunks).toString(), bytes.toString());
});

function guest(data = Buffer.alloc(0)) {
  const calls: string[] = [], upload: Buffer[] = []; let transform = (_route: string, result: Record<string, unknown>) => result;
  let fail = "", remoteId = "";
  const adapter = new GuestChunkFiles((path, request) => {
    const route = path.slice("/v1/files/".length); calls.push(route);
    if (fail === route) throw new Error("Interrupted transport");
    remoteId = request.id as string;
    let result: Record<string, unknown> = { id: remoteId };
    if (route === "upload/begin") result = { ...result, state: "receiving", bytes: request.size };
    if (route === "upload/chunk") { const bytes = decodeData(request.data); upload.push(bytes); result.offset = (request.offset as number) + bytes.length; }
    if (route === "upload/finish" || route === "upload/verify") {
      const bytes = Buffer.concat(upload);
      result = { ...result, state: route === "upload/finish" && bytes.length > GUEST_CHUNK ? "verifyingUpload" : "committed", durable: true, verified: GUEST_CHUNK, bytes: bytes.length, sha256: sha(bytes) };
    }
    if (route === "download/begin" || route === "download/check") result = { ...result, state: "reading", bytes: data.length };
    if (route === "download/chunk") { const offset = request.offset as number, bytes = data.subarray(offset, offset + GUEST_CHUNK); result = { ...result, data: bytes.toString("base64"), offset: offset + bytes.length }; }
    if (route === "download/finish" || route === "download/verify") result = { ...result, state: route === "download/finish" && data.length > GUEST_CHUNK ? "verifying" : "verified", verified: GUEST_CHUNK, bytes: data.length, sha256: sha(data) };
    return transform(route, result);
  });
  return { adapter, calls, upload, transform(value: typeof transform) { transform = value; }, fail(value: string) { fail = value; } };
}

test("scoped guest uploads verify multichunk/empty bytes, digest and bounded second-pass progress", async () => {
  for (const bytes of [Buffer.alloc(0), Buffer.alloc(GUEST_CHUNK + 37, 42)]) {
    const f = guest();
    assert.deepEqual(await f.adapter.upload("/target", reader(bytes), bytes.length), { uploaded: bytes.length, durable: true });
    assert.deepEqual(Buffer.concat(f.upload), bytes);
    assert.equal(f.calls.filter(r => r === "upload/begin").length, 1);
  }
  for (const mode of ["offset", "id", "sha256", "durable", "bytes", "verify"]) {
    const f = guest();
    f.transform((route, result) => ({ ...result, ...(mode === "id" ? { id: "wrong" } : {}),
      ...(mode === "offset" && route === "upload/chunk" ? { offset: 0 } : {}),
      ...(route === "upload/verify" && ["sha256", "durable", "bytes"].includes(mode) ? { [mode]: mode === "sha256" ? "0".repeat(64) : false } : {}),
      ...(mode === "verify" && route === "upload/finish" ? { verified: 0 } : {}) }));
    await assert.rejects(f.adapter.upload("/target", reader(Buffer.alloc(GUEST_CHUNK + 1)), GUEST_CHUNK + 1));
  }
});

test("lost chunk/commit response never replays, and revocation stops transport including abort", async () => {
  for (const route of ["upload/chunk", "upload/finish"]) {
    const f = guest(); f.fail(route);
    await assert.rejects(f.adapter.upload("/target", reader(Buffer.from("x")), 1));
    assert.equal(f.calls.filter(r => r === route).length, 1); assert.equal(f.calls.at(-1), "abort");
  }
  for (const phase of ["reader", "publish"]) {
    const f = guest(); let allowed = true;
    f.transform((route, value) => { if (phase === "publish" && route === "upload/finish") allowed = false; return value; });
    await assert.rejects(f.adapter.upload("/target", { read() { if (phase === "reader") allowed = false; return Buffer.from("x"); } }, 1, { authorized: () => allowed }));
    assert.equal(f.calls.includes("abort"), false);
    if (phase === "reader") assert.deepEqual(f.calls, ["upload/begin"]);
  }
});

test("guest download checks source and digest, supports small reads and refuses malformed responses", async () => {
  const bytes = Buffer.alloc(GUEST_CHUNK + 37, 31), f = guest(bytes), source = await f.adapter.download("/source");
  await source.verify(); const chunks: Buffer[] = [];
  for (;;) { const part = await source.read(777); if (!part.length) break; chunks.push(Buffer.from(part)); }
  assert.deepEqual(Buffer.concat(chunks), bytes); await source.verify(); await source.verify(); await source.close();
  assert.deepEqual(f.calls, ["download/begin", "download/check", "download/chunk", "download/chunk", "download/finish", "download/verify"]);
  for (const mode of ["length", "cursor", "encoding", "digest", "progress", "identity"]) {
    const helper = guest(bytes);
    helper.transform((route, result) => ({ ...result,
      ...(route === "download/chunk" && mode === "length" ? { data: "eA==" } : {}),
      ...(route === "download/chunk" && mode === "cursor" ? { offset: 0 } : {}),
      ...(route === "download/chunk" && mode === "encoding" ? { data: "!!!!" } : {}),
      ...(route === "download/chunk" && mode === "identity" ? { id: null } : {}),
      ...(route === "download/verify" && mode === "digest" ? { sha256: "0".repeat(64) } : {}),
      ...(route === "download/finish" && mode === "progress" ? { verified: 0 } : {}) }));
    const download = await helper.adapter.download("/source");
    await assert.rejects(copyDownload(download, { write(data) { return data.length; } }));
  }
});

test("observed download revocation stays fenced after predicate recovery; close is idempotent", async () => {
  const f = guest(Buffer.from("bytes")); let allowed = true;
  const source = await f.adapter.download("/source", { authorized: () => allowed }); allowed = false;
  await assert.rejects(async () => source.read(1), status(401)); allowed = true;
  await assert.rejects(async () => source.read(1), status(401));
  await source.close(); await source.close();
  assert.deepEqual(f.calls, ["download/begin", "abort"]);
  const cancelled = new AbortController(); const output = sink();
  const pending = copyUpload({ read() { return new Promise(() => {}); } }, output, 4, { authorized: () => true, signal: cancelled.signal });
  cancelled.abort(); await assert.rejects(pending); assert.equal(output.chunks.length, 0);
});

function helperArtifact() {
  const bytes = Buffer.alloc(128); bytes.set([127, 69, 76, 70, 2, 1]); bytes.writeUInt16LE(3, 16); bytes.writeUInt16LE(183, 18);
  const manifest = { schemaVersion: 1, protocol: "CANAVERAL_TRANSFER_V1", minimumAPI: 26, artifacts: { arm64: { file: "canaveral-transfer-arm64", bytes: bytes.length, sha256: sha(bytes) } } };
  const image = "system-images;android-35;google_apis;arm64-v8a";
  return { bytes, manifest, image, helper: validateAndroidHelper(manifest, bytes, "arm64", image) };
}
test("Android helper snapshot rejects checksum, ABI, API, test hooks, boolean version and traversal", () => {
  const { bytes, manifest, image } = helperArtifact();
  for (const mode of ["hash", "architecture", "api", "hooks", "version", "traversal"]) {
    const binary = mode === "hooks" ? Buffer.concat([bytes, Buffer.from("CANAVERAL_TRANSFER_TEST_FAIL")]) : Buffer.from(bytes);
    const input = structuredClone(manifest);
    if (mode === "hash") binary[127] = 1;
    if (mode === "architecture") binary.writeUInt16LE(62, 18);
    if (["architecture", "hooks"].includes(mode)) { input.artifacts.arm64.bytes = binary.length; input.artifacts.arm64.sha256 = sha(binary); }
    if (mode === "version") (input as unknown as { schemaVersion: boolean }).schemaVersion = true;
    if (mode === "traversal") input.artifacts.arm64.file = "../foreign";
    assert.throws(() => validateAndroidHelper(input, binary, "arm64", mode === "api" ? image.replace("35", "25") : image), code("transfer_helper_invalid"));
  }
});

function android() {
  const events: string[] = [], writes: Buffer[] = []; let id = "", size = 0, lines = 0, fail = "";
  let allowed = true;
  const provider: AndroidUploadProvider = {
    owned() { events.push("owned"); },
    open(_helper, _path, length, request) {
      events.push("open"); id = request; size = length;
      return {
        write(data) { const part = Buffer.from(data.subarray(0, 3)); writes.push(part); return part.length; },
        readLine() {
          lines++; const phase = lines === 1 ? "STAGED" : "COMMITTED"; events.push(phase);
          if (fail === "revoke-precommit" && phase === "STAGED" || fail === "revoke-postcommit" && phase === "COMMITTED") allowed = false;
          return Buffer.from(`CANAVERAL_TRANSFER_V1 ${fail === "staged" && phase === "STAGED" ? "WRONG" : phase} ${id} ${size}\n`);
        },
        closeInput() { events.push("EOF"); }, completed() { return fail !== "exit"; }, close() { events.push("close"); },
      };
    },
    cleanup() { events.push("cleanup"); if (fail === "cleanup-revoke") allowed = false; },
  };
  return { provider, events, writes, guard: { authorized: () => allowed }, fail(value: string) { fail = value; } };
}
test("Android exact staged/committed receipts, short writes and cleanup precede durable acknowledgement", async () => {
  const { helper } = helperArtifact();
  for (const bytes of [Buffer.from("fixture\0data"), Buffer.alloc(0)]) {
    const f = android();
    assert.deepEqual(await androidUpload(f.provider, helper, "/data/file", reader(bytes), bytes.length, f.guard), { uploaded: bytes.length, durable: true });
    const sent = Buffer.concat(f.writes); assert.deepEqual(sent.subarray(0, bytes.length), bytes); assert.equal(sent.subarray(bytes.length).toString().startsWith("COMMIT "), true);
    assert.equal(f.events.indexOf("STAGED") < f.events.indexOf("EOF"), true); assert.equal(f.events.includes("cleanup"), true);
  }
});
test("Android refusal before commit and uncertain publication after commit never claim rollback", async () => {
  const { helper } = helperArtifact();
  for (const mode of ["staged", "revoke-precommit", "revoke-postcommit", "exit", "cleanup-revoke"]) {
    const f = android(); f.fail(mode);
    await assert.rejects(androidUpload(f.provider, helper, "/data/file", reader(Buffer.from("new")), 3, f.guard), ["staged", "revoke-precommit"].includes(mode) ? ServiceError : code("upload_publication_uncertain"));
    if (["staged", "revoke-precommit"].includes(mode)) assert.equal(f.events.includes("EOF"), false);
    if (mode.startsWith("revoke")) assert.equal(f.events.includes("cleanup"), false);
  }
  await assert.rejects(androidUpload(undefined, helper, "/data/file", reader(Buffer.alloc(0)), 0, guard), code("capability_unsupported"));
});
