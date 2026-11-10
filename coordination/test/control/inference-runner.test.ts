import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SqliteStore } from "../../src/sqlite.ts";
import { parseModelJob } from "../../src/model-job.ts";
import type { ModelJob, ModelJobState } from "../../src/model-job.ts";
import { GiB, InferenceRunner, MiB, ResourceGuard, inferenceRequest, linuxMemorySample, macMemorySample } from "../../src/control/inference.ts";
import type { InferenceAssignment, InferenceExecutor, InferenceReport, MemorySample } from "../../src/control/inference.ts";

const definition = { id: "fixture:latest", digest: `sha256:${"a".repeat(64)}`, capability: "generation" as const, resources: { cpu: 2, memoryMiB: 2048, diskGiB: 1 } };
function assignment(): InferenceAssignment {
  const id = randomUUID();
  return { id, hostId: randomUUID(), request: inferenceRequest({ id, model: definition.id, prompt: "Hello" }), definition,
    model: definition.id, desired: "running", state: "queued", detail: "", updatedAt: 1000, stopped: false,
    cleanup: "pending", reservationHeld: true, sequence: 0 };
}
function receipt(job: ModelJob, state: ModelJobState = "succeeded", stopped = true): ModelJob {
  return parseModelJob({ ...job, message: { type: "receipt", state, cancelRequested: state === "cancelled", stopped,
    cleanup: stopped ? "complete" : "pending", ...(state === "succeeded" ? { result: { model: definition.id, text: "Hello", usage: { inputTokens: 1, outputTokens: 5 } } } : {}) } });
}
function fixture(t: { after(callback: () => void): void }) {
  const directory = mkdtempSync(join(tmpdir(), "canaveral-inference-runner-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "runner.sqlite"), store = new SqliteStore(path);
  let now = 0;
  const sample: MemorySample = { physical: 36 * GiB, available: 10 * GiB, normal: true, written: 100 * MiB };
  const guard = new ResourceGuard(directory, () => sample, () => now, () => 8 * GiB);
  guard.restriction(1); now = 1;
  let calls = 0;
  const executor: InferenceExecutor = { async execute(job, _control, restriction) {
    calls++; assert.equal(restriction(), undefined);
    return receipt(job);
  } };
  const runner = (adapter: InferenceExecutor | undefined = executor) => new InferenceRunner(new SqliteStore(path), [definition], guard, adapter, () => now);
  return { path, store, sample, guard, executor, runner, calls: () => calls, advance: (seconds: number) => { now += seconds; } };
}

test("Mac cache accounting removes speculative overlap and excludes compressed memory", () => {
  const sample = macMemorySample(`Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free: 100.
Pages wired down: 200.
Pages occupied by compressor: 50.
File-backed pages: 300.
Pages speculative: 20.
Pages purgeable: 40.
Swapouts: 10.
`, 1000 * 16384, 1);
  assert.deepEqual(sample, { physical: 1000 * 16384, available: (100 + 300 - 20 + 40) * 16384, normal: true, written: 10 * 16384 });
  assert.throws(() => macMemorySample("missing", 1000, 1));
});

test("Linux uses MemAvailable once and derives active swap writes from page-sized counters", () => {
  const sample = linuxMemorySample("MemTotal: 16777216 kB\nMemAvailable: 8388608 kB\nCached: 4194304 kB\n", "pswpout 12\n", 4096);
  assert.deepEqual(sample, { physical: 16 * GiB, available: 8 * GiB, normal: true, written: 49152 });
  assert.throws(() => linuxMemorySample("MemTotal: 100 kB\n", "pswpout 0\n", 4096));
  assert.throws(() => linuxMemorySample("MemTotal: 100 kB\nMemAvailable: 101 kB\n", "pswpout 0\n", 4096));
  assert.throws(() => linuxMemorySample("MemTotal: 100 kB\nMemAvailable: 50 kB\n", "", 4096));
});

test("resource admission retains system headroom, distinguishes loaded weights, and gates swap/disk", () => {
  let now = 0, disk = 8 * GiB;
  const sample = { physical: 36 * GiB, available: 10 * GiB, normal: true, written: 100 * MiB };
  const guard = new ResourceGuard("unused", () => sample, () => now, () => disk);
  assert.match(guard.restriction(8192)!, /baseline/);
  now = 1;
  assert.equal(guard.restriction(4096), undefined);
  assert.match(guard.restriction(8192)!, /RAM/);
  assert.equal(guard.restriction(8192, true), undefined);
  sample.written += 32 * MiB;
  assert.match(guard.restriction(1)!, /swap/);
  now += 32;
  assert.match(guard.restriction(1)!, /swap/);
  now += 31;
  assert.equal(guard.restriction(1), undefined);
  disk = GiB;
  assert.match(guard.restriction(1)!, /disk/);
  sample.normal = false;
  assert.match(guard.restriction(1)!, /pressure/);
  sample.written = 0;
  assert.match(guard.restriction(1)!, /baseline/);
});

test("fast polling cannot discard the 30-second swap baseline; telemetry and clock failures close admission", () => {
  let now = 0;
  const sample = { physical: 36 * GiB, available: 10 * GiB, normal: true, written: 0 };
  const guard = new ResourceGuard("unused", () => sample, () => now, () => 8 * GiB);
  guard.restriction(1); now = 1; guard.restriction(1);
  for (let i = 0; i < 500; i++) { now += 0.01; sample.written += MiB; guard.restriction(1); }
  assert.match(guard.restriction(1)!, /swap/);
  now = 0;
  assert.match(guard.restriction(1)!, /baseline/);
  assert.match(new ResourceGuard("unused", () => { throw new Error("unavailable"); }).restriction(1)!, /unavailable/);
  assert.match(new ResourceGuard("unused", () => ({ ...sample, available: NaN })).restriction(1)!, /unavailable/);
});

test("durable terminal receipts survive new runner instances without executing again", async t => {
  const f = fixture(t), job = assignment();
  const report = await f.runner().reconcile(job, () => "continue");
  assert.equal(report.state, "succeeded");
  assert.equal(report.result?.usage.outputTokens, 5);
  assert.equal(report.stopped, true);
  assert.deepEqual(await f.runner().reconcile(job, () => "cancel"), report);
  assert.equal(f.calls(), 1);
  const conflict = { ...job, request: { ...job.request, prompt: "Different" } };
  assert.equal((await f.runner().reconcile(conflict, () => "continue")).state, "unknown");
  assert.equal(f.calls(), 1);
});

test("launch intent persists before dispatch; restart reports unknown and cancellation cannot replay it", async t => {
  const f = fixture(t), job = assignment();
  let launchJournal: InferenceReport | undefined;
  const crash: InferenceExecutor = { async execute() {
    launchJournal = f.store.transaction(db => JSON.parse(String(db.prepare("SELECT report FROM inference_runner_receipts WHERE job=?").get(job.id)!.report)) as InferenceReport);
    throw new Error("lost runtime response");
  } };
  assert.equal((await f.runner(crash).reconcile(job, () => "continue")).state, "unknown");
  assert.equal(launchJournal?.state, "running");
  job.desired = "cancelled";
  assert.equal((await f.runner().reconcile(job, () => "cancel")).state, "unknown");
  assert.equal(f.calls(), 0);
  assert.equal(await f.runner().work([assignment()], () => "continue"), undefined);
});

test("missing executor, missing telemetry and expired contact never start inference", async t => {
  const f = fixture(t), job = assignment();
  const noExecutor = new InferenceRunner(f.store, [definition], f.guard);
  assert.match((await noExecutor.reconcile(job, () => "continue")).detail!, /not configured/);
  assert.equal((await f.runner().reconcile(job, () => "fence")).state, "waitingForResources");
  const guard = new ResourceGuard("unused", () => { throw new Error("missing"); });
  const runner = new InferenceRunner(f.store, [definition], guard, f.executor, () => 0);
  assert.equal((await runner.reconcile(job, () => "continue")).state, "waitingForResources");
  assert.equal(f.store.transaction(db => db.prepare("SELECT count(*) AS n FROM inference_runner_receipts").get()!.n), 0);
  assert.equal(f.calls(), 0);
});

test("resource waits expire safely without a runtime and pinned inventory changes fail before dispatch", async t => {
  const f = fixture(t), job = assignment();
  f.sample.normal = false;
  const runner = f.runner();
  assert.equal((await runner.reconcile(job, () => "continue")).state, "waitingForResources");
  f.advance(600);
  const expired = await runner.reconcile(job, () => "continue");
  assert.equal(expired.state, "failed");
  assert.equal(expired.stopped, true);
  assert.equal(expired.cleanup, "complete");
  const changed = assignment(); changed.definition = { ...definition, digest: `sha256:${"b".repeat(64)}` };
  assert.equal((await f.runner().reconcile(changed, () => "continue")).state, "failed");
  assert.equal(f.calls(), 0);
});

test("worker confirms queued cancellation before FIFO execution and blocks on incomplete cleanup", async t => {
  const f = fixture(t), first = assignment(), cancelled = assignment(); cancelled.desired = "cancelled";
  const runner = f.runner();
  const turn = await runner.work([first, cancelled], () => "continue");
  assert.equal(turn?.id, cancelled.id); assert.equal(turn?.report.state, "cancelled");
  assert.equal(f.calls(), 0);
  const partial: InferenceExecutor = { async execute(job) { return receipt(job, "succeeded", false); } };
  const outcome = await f.runner(partial).reconcile(first, () => "continue");
  assert.equal(outcome.state, "succeeded"); assert.equal(outcome.stopped, false);
  const second = assignment();
  assert.equal((await f.runner().work([first, second], () => "continue"))?.id, first.id);
  assert.equal(f.calls(), 0);
});

test("concurrent runner instances arbitrate launch durably and only one fixture executor runs", async t => {
  const f = fixture(t), job = assignment();
  let release!: (receipt: ModelJob) => void, submitted!: ModelJob, calls = 0;
  const held: InferenceExecutor = { execute(submission) { calls++; submitted = submission; return new Promise(resolve => { release = resolve; }); } };
  const first = f.runner(held).reconcile(job, () => "continue");
  const second = await f.runner(held).reconcile(job, () => "continue");
  assert.equal(second.state, "unknown"); assert.equal(calls, 1);
  release(receipt(submitted));
  assert.equal((await first).state, "succeeded");
});

test("adapter receipt identity, cancellation intent and dynamic resource checks stay scoped", async t => {
  const f = fixture(t), job = assignment();
  const foreign: InferenceExecutor = { async execute(submission) { return receipt({ ...submission, applicationId: randomUUID() }); } };
  assert.equal((await f.runner(foreign).reconcile(job, () => "continue")).state, "unknown");
  const cancelled = assignment();
  let signal: "continue" | "cancel" | "fence" = "continue";
  const adapter: InferenceExecutor = { async execute(submission, control, restriction) {
    f.sample.written += 32 * MiB;
    assert.match(restriction()!, /swap/);
    signal = "cancel"; assert.equal(control(), "cancel");
    return receipt(submission, "cancelled");
  } };
  const report = await f.runner(adapter).reconcile(cancelled, () => signal);
  assert.equal(report.state, "cancelled"); assert.equal(report.stopped, true);
});
