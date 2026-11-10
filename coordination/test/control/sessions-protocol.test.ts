import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { encodeControl, GuestHelperBinding, MAX_CONTROL_BYTES, RunnerSession, UploadReader, validateRelayMessage, validateSnapshot, workerError } from "../../src/control/session-protocol.ts";
import type { RunnerSessionJob, SessionChannel, SessionMessage } from "../../src/control/session-protocol.ts";
import { ServiceError } from "../../src/errors.ts";

class Channel implements SessionChannel {
  controls: Record<string, unknown>[] = []; binary: Uint8Array[] = []; closed = false;
  constructor(readonly input: SessionMessage[]) {}
  async receive(): Promise<SessionMessage | null> { return this.input.shift() ?? null; }
  async sendControl(value: Record<string, unknown>): Promise<void> { this.controls.push(value); }
  async sendBytes(value: Uint8Array): Promise<void> { this.binary.push(value); }
  close(): void { this.closed = true; }
}
const sha = (data: Uint8Array): string => createHash("sha256").update(data).digest("hex");
function snapshot() {
  return { snapshotId: randomUUID(), capturedAt: 1, source: "fixture", coordinateSpace: "screen-pixels", truncated: false, coverage: "fixture only", nodes: [
    { id: "root", parentId: null, depth: 0, role: "window", name: "", identifier: "", states: {}, actions: [], properties: {}, bounds: null },
    { id: "child", parentId: "root", depth: 1, role: "button", name: "Save", identifier: "save", states: ["enabled"], actions: ["click"], properties: {}, bounds: { x: -1, y: 0, width: 30, height: 20 } },
  ] };
}
test("UTF-8 byte bounds, directions, broker-only ready and nonfinite controls", () => {
  assert.throws(() => encodeControl({ text: "é".repeat(MAX_CONTROL_BYTES / 2) }));
  assert.throws(() => encodeControl({ x: NaN }));
  assert.throws(() => validateRelayMessage("pty", "host", Buffer.from('{"n":1e999}'), false));
  assert.throws(() => validateRelayMessage("pty", "host", Buffer.from([0xc3, 0x28]), false));
  assert.throws(() => validateRelayMessage("pty", "host", Buffer.from('{"type":"ready"}'), false));
  for (const [capability, side] of [["pty", "consumer"], ["upload", "host"], ["download", "consumer"], ["accessibility", "consumer"]] as const) assert.throws(() => validateRelayMessage(capability, side, Buffer.from("bad"), true));
  assert.equal(validateRelayMessage("display", "consumer", Buffer.alloc(65536), true).byteLength, 65536);
  assert.throws(() => validateRelayMessage("display", "consumer", Buffer.alloc(65537), true));
});
test("upload final bytes are withheld until exact count and digest, including empty uploads", async () => {
  const data = Buffer.from("hello");
  const bad = new UploadReader(new Channel([data, { type: "finish", bytes: 5, sha256: "00".repeat(32) }]), 5);
  assert.equal(Buffer.from(await bad.read(2)).toString(), "he");
  await assert.rejects(bad.read(3), /digest/); assert.equal(bad.finished, false);
  const good = new UploadReader(new Channel([data, { type: "finish", bytes: 5, sha256: sha(data) }]), 5);
  assert.deepEqual(await good.read(65536), data); assert.equal(good.finished, true); assert.equal(good.checksum(), sha(data));
  const empty = new UploadReader(new Channel([{ type: "finish", bytes: 0, sha256: sha(Buffer.alloc(0)) }]), 0);
  await empty.finish(); assert.equal(empty.finished, true);
  await assert.rejects(new UploadReader(new Channel([Buffer.alloc(6)]), 5).read(6));
});
test("snapshot semantic parent, depth, bounds, frame and node-count limits", () => {
  assert.equal(validateSnapshot(snapshot()).source, "fixture");
  for (const mutate of [
    (s: ReturnType<typeof snapshot>) => { s.nodes[1]!.parentId = "unknown"; },
    (s: ReturnType<typeof snapshot>) => { s.nodes[1]!.depth = 2; },
    (s: ReturnType<typeof snapshot>) => { s.nodes[1]!.id = "root"; },
    (s: ReturnType<typeof snapshot>) => { s.nodes[1]!.bounds!.width = -1; },
    (s: ReturnType<typeof snapshot>) => { s.capturedAt = Infinity; },
    (s: ReturnType<typeof snapshot>) => { s.nodes = Array(2001).fill(s.nodes[0]); },
  ]) { const s = snapshot(); mutate(s); assert.throws(() => validateSnapshot(s)); }
  assert.throws(() => validateSnapshot({ ...snapshot(), frame: null }));
});
test("worker and native transport failures suppress secrets and preserve uncertainty", async () => {
  const error = workerError({ type: "error", code: "upload_publication_uncertain", message: "token=secret-endpoint", outcome: "unknown" }, "correlation")!;
  assert.equal(error.outcome, "unknown"); assert.equal(error.retryable, false); assert.equal(error.requestId, "correlation"); assert.ok(!error.message.includes("secret"));
  assert.equal(workerError({ type: "error", code: "unexpected", message: "private", outcome: "unknown" })!.code, "session_protocol_error");
  let allowed = true, calls = 0;
  const binding = new GuestHelperBinding(async () => { calls++; allowed = false; return { written: 3 }; }, () => allowed, () => true);
  await assert.rejects(binding.call("/v1/shell/write", { text: "abc" }), (e: unknown) => e instanceof ServiceError && e.status === 410 && e.outcome === "unknown");
  await assert.rejects(binding.call("/v1/files/abort", {}, true)); assert.equal(calls, 1);
  const failing = new GuestHelperBinding(async () => { throw new Error("Bearer secret https://private"); }, () => true);
  await assert.rejects(failing.call("/v1/shell/write", {}), (e: unknown) => e instanceof ServiceError && e.outcome === "unknown" && !e.message.includes("private"));
});
test("portable runner verifies transfer finish, refuses replay and sanitizes worker failure", async () => {
  const job: RunnerSessionJob = { id: randomUUID(), generation: randomUUID(), leaseId: randomUUID(), machineId: randomUUID(), capability: "upload" };
  const data = Buffer.from("port proof"), c = new Channel([{ type: "ready", sessionId: job.id, generation: job.generation, capability: job.capability }, { type: "begin", path: "/tmp/test", size: data.length }, data, { type: "finish", bytes: data.length, sha256: sha(data) }]);
  let attempts = 0, published = 0; const receipts: string[] = [];
  const options = { authorized: () => true, beginExecution: () => {}, receipts: { claim: () => ++attempts === 1, update: (_job: RunnerSessionJob, state: string) => receipts.push(state) }, connect: async () => c,
    backend: () => ({ upload: async (_path: string, _app: string | undefined, reader: UploadReader, size: number) => { assert.deepEqual(await reader.read(size), data); assert.ok(reader.finished); published++; return { uploaded: size, durable: true }; } }) };
  await new RunnerSession(job, options).run(); await new RunnerSession(job, options).run();
  assert.equal(published, 1); assert.deepEqual(receipts, ["active", "complete"]); assert.equal(c.controls[0]!.durable, true); assert.equal(c.closed, true);
  const refused = new Channel([{ type: "ready", sessionId: job.id, generation: job.generation, capability: job.capability }, { type: "begin", path: "/tmp/test", size: 1 }]);
  await new RunnerSession({ ...job, id: job.id }, { ...options, receipts: { claim: () => true, update: () => {} }, connect: async () => refused, backend: () => ({ upload: async () => { throw new Error("private-endpoint Bearer token"); } }) }).run();
  assert.equal(refused.controls[0]!.code, "session_incomplete"); assert.ok(!JSON.stringify(refused.controls).includes("private-endpoint"));
});

test("runner downloads require positive source identity before finish; accessibility streams bounded chunks", async () => {
  const base: RunnerSessionJob = { id: randomUUID(), generation: randomUUID(), leaseId: randomUUID(), machineId: randomUUID(), capability: "download" };
  const ready = (job: RunnerSessionJob) => ({ type: "ready", sessionId: job.id, generation: job.generation, capability: job.capability });
  const receipts = { claim: () => true, update: () => {} }, beginExecution = () => {}, authorized = () => true;
  let closed = false;
  const c = new Channel([ready(base), { type: "begin", path: "/tmp/source" }]);
  await new RunnerSession(base, { authorized, beginExecution, receipts, connect: async () => c, backend: () => ({ download: async () => ({ size: 3, read: () => Buffer.from("abc"), verify: () => false, close: () => { closed = true; } }) }) }).run();
  assert.ok(closed); assert.deepEqual(c.binary, [Buffer.from("abc")]); assert.ok(!c.controls.some(v => v.type === "finish")); assert.equal(c.controls.at(-1)!.code, "session_incomplete");
  const job: RunnerSessionJob = { ...base, id: randomUUID(), capability: "accessibility" }, s = snapshot(); s.nodes[1]!.name = "é".repeat(40000);
  const inspection = new Channel([ready(job), { type: "begin" }]);
  await new RunnerSession(job, { authorized, beginExecution, receipts, connect: async () => inspection, backend: () => ({ inspect: async () => s }) }).run();
  const binary = Buffer.concat(inspection.binary); assert.ok(inspection.binary.length > 1); assert.ok(inspection.binary.every(b => b.length <= 65536));
  assert.equal(inspection.controls[0]!.schema, "canaveral-accessibility-v1"); assert.equal(inspection.controls.at(-1)!.sha256, sha(binary));
  assert.deepEqual(JSON.parse(binary.toString()), s);
});
test("PTY uses broker-owned session, rejects ownership injection and records cleanup", async () => {
  const job: RunnerSessionJob = { id: randomUUID(), generation: randomUUID(), leaseId: randomUUID(), machineId: randomUUID(), capability: "pty" }, calls: { action: string; args: Record<string, unknown> }[] = [], states: string[] = [];
  const c = new Channel([{ type: "ready", sessionId: job.id, generation: job.generation, capability: "pty" }, { action: "shell-write", arguments: { text: "hello", session: randomUUID() } }]);
  await new RunnerSession(job, { authorized: () => true, beginExecution: () => {}, receipts: { claim: () => true, update: (_j, state, cleanup) => states.push(`${state}/${cleanup}`) }, connect: async () => c,
    backend: () => ({ control: async (action, args) => { calls.push({ action, args }); return action === "shell-close" ? { closed: true } : { session: job.id }; } }) }).run();
  assert.deepEqual(calls.map(c => c.action), ["shell-open", "shell-close"]); assert.ok(calls.every(c => c.args.session === job.id));
  assert.equal(c.controls[0]!.code, "session_incomplete"); assert.equal(states.at(-1), "unknown/complete");
});
