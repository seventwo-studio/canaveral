import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { WindowsRoot, component, type DirectoryEntry, type FileIdentity, type WindowsFileAPI } from "../../src/guest/windows/files.ts";
import { WindowsDownloads } from "../../src/guest/windows/downloads.ts";
import { WindowsStage } from "../../src/guest/windows/staging.ts";
import { JOURNAL_BYTES, WindowsInputJournal } from "../../src/guest/windows/journal.ts";
import { WindowsHeldInput, neutral } from "../../src/guest/windows/input.ts";
const digest = (data: Buffer): string => createHash("sha256").update(data).digest("hex");
class Node {
  info: FileIdentity; children = new Map<string, Node>();
  constructor(id: number, public data = Buffer.alloc(0), directory = false) { this.info = { volume: "1", fileId: id.toString(16).padStart(32, "0"), size: data.length, written: "1", changed: "1", links: 1, directory, attributes: directory ? 16 : 128 }; }
}
class API implements WindowsFileAPI {
  driveNode = new Node(1, Buffer.alloc(0), true); file = new Node(2, Buffer.from("hello"));
  handles = new Map<string, Node>(); next = 10; closeFail?: string; renameUnknown = false; discardCalls = 0; partial = false; corruptReads = false;
  pause?: () => Promise<void>;
  constructor() { this.driveNode.children.set("data", this.file); }
  keep(node: Node): string { const h = String(this.next++); this.handles.set(h, node); return h; }
  drive(): string { return this.keep(this.driveNode); }
  open(parent: string, name: string): string { const n = this.handles.get(parent)!.children.get(name); if (!n) throw new Error("private native failure"); return this.keep(n); }
  info(h: string): FileIdentity { return { ...this.handles.get(h)!.info }; }
  async read(h: string, offset: number, count: number): Promise<Buffer> { await this.pause?.(); return this.corruptReads ? Buffer.alloc(count, 99) : this.handles.get(h)!.data.subarray(offset, offset + count); }
  async *entries(): AsyncIterable<DirectoryEntry> { for (let i = 0; i < 2100; i++) yield { name: String(i), kind: "file", size: 0, modifiedAt: 0, attributes: 128, reparseTag: 0, nativeFileId: "0".repeat(32) }; }
  close(h: string): void { if (h === this.closeFail) throw new Error("close failed"); this.handles.delete(h); }
  create(parent: string, name: string): string { const dir = this.handles.get(parent)!; if (dir.children.has(name)) throw new Error("collision"); const n = new Node(this.next + 100); dir.children.set(name, n); return this.keep(n); }
  journal(parent: string, name: string): string { return this.open(parent, name); }
  write(h: string, offset: number, bytes: Buffer): number { const node = this.handles.get(h)!, count = this.partial ? Math.min(8192, bytes.length) : bytes.length; const data = Buffer.alloc(Math.max(offset + count, node.data.length)); node.data.copy(data); bytes.copy(data, offset, 0, count); node.data = data; node.info.size = data.length; node.info.changed = String(Number(node.info.changed) + 1); return count; }
  flush(): void {}
  discard(): void { this.discardCalls++; }
  publish(): boolean { if (this.renameUnknown) throw new Error("rename result lost"); return true; }
}
async function fixture() { const api = new API(), root = new WindowsRoot("C:", [], api); await root.start(); return { api, root }; }
test("Windows names reject traversal, streams, malformed Unicode, trailing ambiguity and UNC roots", () => {
  for (const name of ["", "..", ".", "a/b", "a\\b", "data:secret", "a.", "a ", "\ud800", "\udc00", "a\0b"]) assert.throws(() => component(name));
  assert.equal(component("😀.txt"), "😀.txt"); assert.throws(() => new WindowsRoot("\\\\server\\share", [], new API()));
});
test("Windows pins reject reparse, hard links, metadata changes and cross-volume objects", async () => {
  for (const patch of [{ attributes: 0x480 }, { links: 2 }, { volume: "2" }]) { const { api, root } = await fixture(); Object.assign(api.file.info, patch); await assert.rejects(root.pin(["data"])); assert.equal(await root.close(), true); assert.equal(api.handles.size, 0); }
  const { api, root } = await fixture(), pin = await root.pin(["data"]); api.file.info.changed = "2"; await assert.rejects(pin.read(0, 5)); await root.close();
});
test("root close retains handles during reads and refuses late bytes", async () => {
  const { api, root } = await fixture(), pin = await root.pin(["data"]); let release!: () => void;
  api.pause = () => new Promise<void>(r => { release = r; }); const pending = pin.read(0, 5);
  await new Promise(r => setImmediate(r)); assert.equal(await root.close(), false); assert.equal(api.handles.size, 2); release(); await assert.rejects(pending); assert.equal(await root.close(), true);
});
test("list bounds entries and confirms directory handle release", async () => { const { root } = await fixture(); const result = await root.list(); assert.equal(result.entries.length, 2000); assert.equal(result.truncated, true); await root.close(); });
test("download uses exact cursors, a second hash pass, and positive release before receipts", async () => {
  const { api, root } = await fixture(); const files = new WindowsDownloads(root, p => { assert.equal(p, "/data"); return ["data"]; }, () => true); const id = randomUUID(), call = (route: string, body: object) => files.request(`/v1/files/${route}`, { id, ...body });
  assert.equal((await call("download/begin", { path: "/data" })).bytes, 5);
  await assert.rejects(call("download/begin", { path: "/other" }));
  const chunk = await call("download/chunk", { offset: 0 }); assert.equal(Buffer.from(chunk.data as string, "base64").toString(), "hello"); await assert.rejects(call("download/chunk", { offset: 0 }));
  api.closeFail = files.records.get(id)!.pin!.handle;
  await assert.rejects(call("download/finish", {}), { code: "file_cleanup_uncertain" });
  assert.equal((await call("status", {})).state, "cleanupPending"); assert.equal((await call("download/finish", {})).state, "cleanupPending"); delete api.closeFail;
  const receipt = await call("download/verify", {}); assert.equal(receipt.state, "verified"); assert.equal(receipt.sha256, digest(Buffer.from("hello"))); await files.close();
});
test("download detects unchanged-metadata data mutation and sticky authorization", async () => {
  const { api, root } = await fixture(); let active = true; const files = new WindowsDownloads(root, () => ["data"], () => active, () => true), id = randomUUID();
  await files.request("/v1/files/download/begin", { id, path: "/data" }); await files.request("/v1/files/download/chunk", { id, offset: 0 }); api.corruptReads = true;
  await assert.rejects(files.request("/v1/files/download/finish", { id })); active = false; await assert.rejects(files.request("/v1/files/status", { id })); active = true; await assert.rejects(files.request("/v1/files/status", { id })); assert.equal((await files.request("/v1/files/abort", { id })).state, "aborted"); await files.close();
});
test("staging handles partial writes and verifies without claiming durable publication", async () => {
  const { api, root } = await fixture(); api.partial = true; const data = Buffer.alloc(30000, 17), stage = await WindowsStage.create(root, [], data.length, () => true);
  assert.deepEqual(await stage.write(0, data), { offset: data.length }); await assert.rejects(stage.write(0, data));
  assert.equal((await stage.finish(digest(data))).state, "ready"); const receipt = await stage.publish("结果.bin"); assert.equal(receipt.durable, false); assert.equal(receipt.state, "published"); await assert.rejects(stage.publish("again")); assert.equal(await stage.close(), true); assert.equal(api.discardCalls, 0); await root.close();
});
test("unknown publication retains handle chain and never deletes potentially published data", async () => {
  const { api, root } = await fixture(), stage = await WindowsStage.create(root, [], 0, () => true); await stage.finish(digest(Buffer.alloc(0))); api.renameUnknown = true;
  await assert.rejects(stage.publish("destination"), { outcome: "unknown" }); assert.equal(await stage.close(), false); assert.equal(await root.close(), false); assert.equal(api.discardCalls, 0); assert.equal(api.handles.size, 2);
});
test("empty stage and failed disposition preserve ownership for explicit cleanup retry", async () => { const { api, root } = await fixture(); const stage = await WindowsStage.create(root, [], 0, () => true); assert.equal((await stage.finish(digest(Buffer.alloc(0)))).state, "ready"); api.closeFail = stage.handle!; assert.equal(await stage.close(), false); assert.equal(api.discardCalls, 1); delete api.closeFail; assert.equal(await stage.close(), true); assert.equal(api.discardCalls, 1); await root.close(); });
test("two-slot journal preserves blocked recovery, context and sequence; reset releases only", async () => {
  const { api, root } = await fixture(); const node = new Node(55, Buffer.alloc(JOURNAL_BYTES)); api.driveNode.children.set("journal", node); const context = randomUUID(), expected = { volume: "1", fileId: node.info.fileId };
  await assert.rejects(WindowsInputJournal.open(root, ["journal"], context, expected, () => true));
  const journal = await WindowsInputJournal.open(root, ["journal"], context, expected, () => true, true);
  const held = new WindowsHeldInput({ post: () => ({ posted: true }) }, () => ({ codes: [[0, 30, 8]] }), journal.save, () => true);
  await held.key(65, true, [0, 0, 100, 100]); assert.equal(journal.sequence, 3); await journal.close();
  const recovered = await WindowsInputJournal.open(root, ["journal"], context, expected, () => true); assert.equal(recovered.recovered.keys.length, 1);
  const posted: unknown[] = []; const recovery = new WindowsHeldInput({ post: events => { posted.push(...events); return { posted: true }; } }, () => { throw new Error("must not resolve"); }, recovered.save, () => true, () => true, recovered.recovered);
  await assert.rejects(recovery.key(65, true, [0, 0, 100, 100])); await recovery.reset(); assert.deepEqual(posted, [{ kind: "key", vk: 0, scan: 30, flags: 10 }]); assert.deepEqual(recovery.state, neutral()); await recovered.close();
  await assert.rejects(WindowsInputJournal.open(root, ["journal"], randomUUID(), expected, () => true)); await root.close();
});
test("journal forbids transitions that invent or discard pending held keys", async () => {
  const { api, root } = await fixture(); const node = new Node(56, Buffer.alloc(JOURNAL_BYTES)); api.driveNode.children.set("journal", node);
  const j = await WindowsInputJournal.open(root, ["journal"], randomUUID(), { volume: "1", fileId: node.info.fileId }, () => true, true);
  await assert.rejects(j.save(neutral())); const pending = { ...neutral(), blocked: true, keys: [{ keysym: 65, codes: [[0, 30, 8] as [number, number, number]] }] }; await j.save(pending);
  await assert.rejects(j.save({ ...neutral(), blocked: true })); assert.equal(j.sequence, 2); await j.save(neutral()); assert.equal(j.sequence, 3); await root.close();
});
test("torn final journal write recovers blocked evidence; torn pending write refuses old neutral state", async () => {
  for (const final of [false, true]) {
    const { api, root } = await fixture(), node = new Node(57, Buffer.alloc(JOURNAL_BYTES)); api.driveNode.children.set("journal", node); const context = randomUUID(), expected = { volume: "1", fileId: node.info.fileId };
    const journal = await WindowsInputJournal.open(root, ["journal"], context, expected, () => true, true);
    const pending = { ...neutral(), blocked: true, keys: [{ keysym: 65, codes: [[0, 30, 8] as [number, number, number]] }] };
    if (final) await journal.save(pending);
    await journal.close();
    const offset = final ? 131072 : 0; node.data.fill(0x7f, offset, offset + 100); node.info.changed = "999";
    if (final) { const recovered = await WindowsInputJournal.open(root, ["journal"], context, expected, () => true); assert.equal(recovered.recovered.blocked, true); assert.equal(recovered.recovered.keys.length, 1); await recovered.close(); }
    else await assert.rejects(WindowsInputJournal.open(root, ["journal"], context, expected, () => true));
    await root.close();
  }
});
