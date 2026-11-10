import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { GuestChunkFiles, CHUNK } from "../../src/guest/chunk-files.ts";
import { GuestChunkShells } from "../../src/guest/chunk-shells.ts";
import { ServiceError } from "../../src/errors.ts";
import type { GuestRequest } from "../../src/guest/https.ts";

function helper(initial = Buffer.alloc(0)) {
  let data: Buffer = initial, stage = Buffer.alloc(0), offset = 0, verified = 0;
  const calls: [string, Record<string, unknown>][] = [];
  let transform = (_route: string, result: Record<string, unknown>) => result;
  let fail: string | undefined;
  const request: GuestRequest = async (path, body) => {
    const route = path.replace("/v1/files/", ""), b = body!; calls.push([route, b]);
    if (route === fail) throw new ServiceError("Interrupted fixture", 409);
    const identity = { id: b.id }; let result: Record<string, unknown>;
    if (route === "upload/begin") { verified = 0; result = { ...identity, state: "receiving", bytes: b.size }; }
    else if (route === "upload/chunk") { assert.equal(b.offset, stage.length); stage = Buffer.concat([stage, Buffer.from(b.data as string, "base64")]); result = { ...identity, offset: stage.length }; }
    else if (route.startsWith("upload/")) {
      if (route === "upload/finish") { assert.equal(b.bytes, stage.length); assert.equal(b.sha256, createHash("sha256").update(stage).digest("hex")); }
      verified += Math.min(CHUNK, stage.length - verified);
      if (verified < stage.length) result = { ...identity, state: "verifyingUpload", verified };
      else { data = stage; result = { ...identity, state: "committed", bytes: data.length, sha256: createHash("sha256").update(data).digest("hex"), durable: true }; }
    } else if (route === "download/begin") { verified = 0; offset = 0; result = { ...identity, state: "reading", bytes: data.length }; }
    else if (route === "download/check") result = { ...identity, state: "reading", bytes: data.length };
    else if (route === "download/chunk") { assert.equal(b.offset, offset); const part = data.subarray(offset, offset + CHUNK); offset += part.length; result = { ...identity, offset, data: part.toString("base64") }; }
    else if (route.startsWith("download/")) {
      verified += Math.min(CHUNK, data.length - verified);
      result = verified < data.length ? { ...identity, state: "verifying", verified } : { ...identity, state: "verified", bytes: data.length, sha256: createHash("sha256").update(data).digest("hex") };
    } else if (route === "abort") result = { ...identity, state: "aborted", bytes: 0 };
    else result = { path: b.path, entries: [], truncated: false };
    return transform(route, result);
  };
  return { request, calls, data: () => data, transform: (fn: typeof transform) => { transform = fn; }, fail: (route: string) => { fail = route; } };
}
function reader(bytes: Uint8Array) { let offset = 0; return { read: async (size: number) => { const part = bytes.subarray(offset, offset + size); offset += part.length; return part; } }; }

test("guest chunk files retain binary chunks, bounded verification and literal paths", async () => {
  const h = helper(), adapter = new GuestChunkFiles(h.request), data = Buffer.alloc(CHUNK * 2 + 11, 0x80);
  assert.deepEqual(await adapter.upload("/path ; literal", reader(data), data.length), { uploaded: data.length, durable: true });
  assert.deepEqual(h.data(), data);
  assert.deepEqual(h.calls.map(c => c[0]), ["upload/begin", "upload/chunk", "upload/chunk", "upload/chunk", "upload/finish", "upload/verify", "upload/verify"]);
  assert.equal(h.calls[0]![1].path, "/path ; literal");
  const source = await adapter.download("/path ; literal");
  assert.equal(await source.verify(), true);
  const parts: Uint8Array[] = [];
  while (true) { const part = await source.read(777); if (!part.length) break; parts.push(part); }
  assert.equal(await source.verify(), true); assert.equal(await source.verify(), true); await source.close();
  assert.deepEqual(Buffer.concat(parts), data);
});
test("empty transfers verify; declared huge uploads never allocate their length", async () => {
  const h = helper(), files = new GuestChunkFiles(h.request);
  await files.upload("/empty", reader(Buffer.alloc(0)), 0);
  const source = await files.download("/empty"); assert.equal(await source.verify(), true); await source.close();
  await assert.rejects(files.upload("/huge", reader(Buffer.alloc(0)), 2 ** 40), /ended early/);
  for (const size of [-1, 1.5, true, 2 ** 53]) await assert.rejects(files.upload("/bad", reader(Buffer.alloc(0)), size as number));
});
test("lost mutation responses never replay, and durable acknowledgements are mandatory", async () => {
  for (const route of ["upload/chunk", "upload/finish"]) {
    const h = helper(); h.fail(route);
    await assert.rejects(new GuestChunkFiles(h.request).upload("/target", reader(Buffer.from("x")), 1));
    assert.equal(h.calls.filter(c => c[0] === route).length, 1);
  }
  for (const change of [{ durable: false }, { sha256: "0".repeat(64) }, { bytes: true }, { id: "wrong" }]) {
    const h = helper(); h.transform((route, r) => route === "upload/finish" ? { ...r, ...change } : r);
    await assert.rejects(new GuestChunkFiles(h.request).upload("/target", reader(Buffer.from("x")), 1));
  }
});
test("revocation during reads and after publication cannot acknowledge or clean up by hidden bypass", async () => {
  for (const revoke of ["read", "finish"]) {
    let live = true; const h = helper();
    h.transform((route, result) => { if (route === "upload/finish" && revoke === "finish") live = false; return result; });
    const source = { read: async () => { if (revoke === "read") live = false; return Buffer.from("x"); } };
    await assert.rejects(new GuestChunkFiles(h.request).upload("/target", source, 1, () => live));
    assert.equal(h.calls.some(c => c[0] === "abort"), false);
    if (revoke === "read") assert.deepEqual(h.calls.map(c => c[0]), ["upload/begin"]);
  }
});
test("download rejects identity/cursor/encoding/digest and verification cursor substitution", async () => {
  for (const mode of ["identity", "offset", "data", "digest", "progress"]) {
    const h = helper(Buffer.alloc(CHUNK + 1));
    h.transform((route, r) => route === "download/chunk" && mode === "identity" ? { ...r, id: randomUUID() } : route === "download/chunk" && mode === "offset" ? { ...r, offset: 0 } : route === "download/chunk" && mode === "data" ? { ...r, data: "!!!!" } : route === "download/verify" && mode === "digest" ? { ...r, sha256: "0".repeat(64) } : route === "download/finish" && mode === "progress" ? { ...r, verified: 0 } : r);
    const source = await new GuestChunkFiles(h.request).download("/source");
    await assert.rejects(async () => { while ((await source.read(CHUNK)).length) { /* drain */ } await source.verify(); }); await source.close();
  }
});
test("terminal controls validate Unicode byte acknowledgements and never retry input", async () => {
  const session = randomUUID(), calls: [string, Record<string, unknown> | null][] = [];
  const responses = [{ session: session.toUpperCase() }, { resized: true }, { written: 4 }, { session, data: "YQpi", offset: 3, truncated: false, exited: true, exitCode: 7 }, { closed: true }];
  const shells = new GuestChunkShells(async (route, args) => { calls.push([route, args]); return responses.shift()!; });
  assert.deepEqual(await shells.control("shell-open", { session }), { session });
  await shells.control("shell-resize", { session, cols: 120, rows: 40 });
  assert.deepEqual(await shells.control("shell-write", { session, text: "🚀" }), { written: 4 });
  assert.equal((await shells.control("shell-read", { session })).exited, true);
  assert.deepEqual(await shells.control("shell-close", { session }), { closed: true });
  assert.deepEqual(calls[0], ["/v1/shell/open", { session, cols: 80, rows: 24 }]);
  for (const text of ["\ud800", "\0", "x".repeat(16001), "🚀".repeat(5000), "\n".repeat(9000)]) {
    await assert.rejects(new GuestChunkShells(async () => { assert.fail("must not dispatch"); }).control("shell-write", { session, text }));
  }
  let sent = 0;
  await assert.rejects(new GuestChunkShells(async () => { sent++; throw new Error("lost"); }).control("shell-write", { session, text: "once" })); assert.equal(sent, 1);
});
test("terminal malformed reads, cleanup metadata and invalid dimensions refuse success", async () => {
  const session = randomUUID(), good = { session, data: "eA==", offset: 1, truncated: false, exited: false, exitCode: null };
  for (const change of [{ data: "!!!!" }, { offset: true }, { offset: 2 }, { truncated: true }, { exited: 1 }, { exitCode: true }, { session: randomUUID() }]) await assert.rejects(new GuestChunkShells(async () => ({ ...good, ...change })).control("shell-read", { session }));
  for (const cols of [0, 501, true, 1.5, null]) await assert.rejects(new GuestChunkShells(async () => { assert.fail("must not dispatch"); }).control("shell-resize", { session, cols, rows: 24 }));
  await assert.rejects(new GuestChunkShells(async () => ({ closed: 1 })).control("shell-close", { session }));
  const ids = new Set<string>(), shells = new GuestChunkShells(async (_route, args) => { ids.add(args!.session as string); return { session: args!.session }; });
  for (let n = 0; n < 9; n++) await shells.control("shell-open", { session: randomUUID() }); assert.equal(ids.size, 9);
});
