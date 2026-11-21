import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { IosProvider } from "../../src/providers/ios.ts";
import { captureNotRunning } from "../../src/providers/mobile.ts";
import type { NativePipe, RunOptions } from "../../src/providers/mobile.ts";

const options = { fps: 30, durationSeconds: 10, bitRate: 4_000_000 };
function fixture(t: { after(fn: () => void): void }) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ios-video-"))); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const id = randomUUID(), calls: { argv: readonly string[]; options: RunOptions }[] = [];
  let allowed = true, closes = 0, waits = 0, opened = 0, observed = 0, failWait = false;
  const pipe: NativePipe = {
    async read(maximum) { return Buffer.from([0, 0, 0, 1, 0x65]).subarray(0, maximum); }, async write() { throw new Error("unexpected source input"); }, async end() { throw new Error("unexpected source EOF"); },
    async wait() { waits++; if (failWait) throw new Error("native stop unconfirmed"); return 0; }, async close() { closes++; }, async interrupt() {},
  };
  const provider = new IosProvider({ storage: path.join(root, "storage"), idb: "/fixture/idb", transport: {
    async run() { throw new Error("Capture must not use screenshot or discrete control commands"); },
    async pipe(argv: readonly string[], options: RunOptions) { calls.push({ argv, options }); opened++; return pipe; },
  } }, root);
  provider.environment = () => ({ IDB_COMPANION: "foreign", IDB_TARGET_UDID: randomUUID(), DEVELOPER_DIR: "/fixture/xcode", PATH: "/fixture/bin", PYTHONUNBUFFERED: "0" });
  provider.ready = async () => { observed++; return id; };
  return { root, id, calls, provider, pipe, check: () => allowed, revoke: () => { allowed = false; }, failWait: () => { failWait = true; }, get closes() { return closes; }, get waits() { return waits; }, get opened() { return opened; }, get observed() { return observed; } };
}

test("iOS video uses one continuous native H264 source with exact UDID and isolated unbuffered environment", async t => {
  const f = fixture(t), source = await f.provider.openVideo({}, {}, f.root, options, f.check);
  assert.equal(f.opened, 1); assert.equal(f.observed, 2);
  assert.deepEqual(f.calls[0]!.argv, ["/fixture/idb", "video-stream", "--format", "h264", "--fps", "30", "--scale-factor", "1", "--udid", f.id]);
  assert.deepEqual(f.calls[0]!.options.env, { DEVELOPER_DIR: "/fixture/xcode", PATH: "/fixture/bin", PYTHONUNBUFFERED: "1" });
  assert.deepEqual(await source.read(65536, 1000), Buffer.from([0, 0, 0, 1, 0x65]));
  assert.deepEqual(await source.read(2, 1000), Buffer.from([0, 0])); assert.equal(f.opened, 1);
  await assert.rejects(source.write(Buffer.from("input"), 1000), /read-only/); await assert.rejects(source.end(), /Close/);
  await source.close(); await source.close(); assert.equal(f.closes, 1); assert.equal(f.waits, 1);
});

test("iOS video refuses invalid capture options before starting any native source", async t => {
  for (const changed of [{ fps: 29 }, { durationSeconds: 0 }, { durationSeconds: 181 }, { durationSeconds: 1.5 }, { bitRate: 99_999 }, { bitRate: 20_000_001 }]) {
    const f = fixture(t); await assert.rejects(f.provider.openVideo({}, {}, f.root, { ...options, ...changed }, f.check), /Invalid/); assert.equal(f.opened, 0);
  }
});

test("iOS video closes its owned source when authorization ends during an in-flight read", async t => {
  const f = fixture(t), source = await f.provider.openVideo({}, {}, f.root, options, f.check);
  f.pipe.read = async () => { f.revoke(); return Buffer.from([0, 0, 0, 1, 0x65]); };
  await assert.rejects(source.read(65536, 1000), /authorization ended/);
  assert.equal(f.closes, 1); assert.equal(f.waits, 1);
});

test("iOS video rechecks exact owned identity after opening and periodically while streaming", async t => {
  const initial = fixture(t); let calls = 0;
  initial.provider.ready = async () => ++calls === 1 ? initial.id : randomUUID();
  await assert.rejects(initial.provider.openVideo({}, {}, initial.root, options, initial.check), /identity changed/); assert.equal(initial.closes, 1);
  let elapsed = 0; t.mock.method(performance, "now", () => elapsed);
  const f = fixture(t), source = await f.provider.openVideo({}, {}, f.root, options, f.check);
  await source.read(65536, 1000); assert.equal(f.observed, 2);
  elapsed = 1001; f.provider.ready = async () => randomUUID();
  await assert.rejects(source.read(65536, 1000), /identity changed/); assert.equal(f.closes, 1);
});

test("iOS video rejects malformed native chunks and requires positive retained child exit on close", async t => {
  const f = fixture(t), source = await f.provider.openVideo({}, {}, f.root, options, f.check);
  for (const maximum of [0, 65537, 1.5]) await assert.rejects(source.read(maximum, 1000), /read envelope/);
  f.pipe.read = async () => Buffer.alloc(100);
  await assert.rejects(source.read(10, 1000), /byte envelope/); assert.equal(f.closes, 1);
  const uncertain = fixture(t), pending = await uncertain.provider.openVideo({}, {}, uncertain.root, options, uncertain.check); uncertain.failWait();
  await assert.rejects(pending.close(), /stop unconfirmed/); assert.equal(uncertain.closes, 1);
});

test("iOS video duration stops the retained process before exposing EOF and successful completion", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(t), source = await f.provider.openVideo({}, {}, f.root, options, f.check);
  let interrupt: ((error: Error) => void) | undefined;
  f.pipe.read = async () => new Promise<Uint8Array>((_resolve, reject) => { interrupt = reject; });
  f.pipe.interrupt = async () => { interrupt?.(new Error("read interrupted by retained process shutdown")); };
  const pending = source.read(65536, 30000);
  for (let i = 0; i < 5; i++) await Promise.resolve();
  t.mock.timers.tick(options.durationSeconds * 1000);
  assert.deepEqual(await pending, Buffer.alloc(0)); assert.equal(await source.wait(1000), 0); assert.equal(f.waits, 1);
  assert.deepEqual(await source.read(65536, 1000), Buffer.alloc(0)); await source.close();
});

test("iOS video preserves premature EOF and failed duration shutdown as errors", async t => {
  const early = fixture(t), source = await early.provider.openVideo({}, {}, early.root, options, early.check);
  early.pipe.read = async () => Buffer.alloc(0);
  await assert.rejects(source.read(65536, 1000), /before its duration limit/); assert.equal(early.closes, 1);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const failed = fixture(t), finite = await failed.provider.openVideo({}, {}, failed.root, options, failed.check);
  failed.pipe.wait = async () => 1;
  t.mock.timers.tick(options.durationSeconds * 1000);
  await assert.rejects(finite.read(65536, 1000), /did not stop cleanly/); await assert.rejects(finite.wait(1000), /did not stop cleanly/);
});

test("iOS duration shutdown drains bounded native output so idb can acknowledge graceful interruption", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(t), source = await f.provider.openVideo({}, {}, f.root, options, f.check);
  let acknowledge!: () => void, drained = 0;
  f.pipe.interrupt = async () => new Promise<void>(resolve => { acknowledge = resolve; });
  f.pipe.read = async maximum => { assert.equal(maximum, 65536); drained++; acknowledge(); return Buffer.alloc(65536); };
  t.mock.timers.tick(options.durationSeconds * 1000);
  assert.deepEqual(await source.read(65536, 1000), Buffer.alloc(0)); assert.ok(drained >= 1); assert.equal(await source.wait(1000), 0);
});

test("an iOS capture refused before idb is spawned, or stopped with proof right after, is marked as running nothing", async t => {
  // Authorization that ended before or during the preflight: nothing was spawned.
  for (const allowedChecks of [0, 1]) {
    const f = fixture(t); let checks = 0;
    const error = await f.provider.openVideo({}, {}, f.root, options, () => checks++ < allowedChecks).then(() => undefined, (caught: unknown) => caught);
    assert.ok(error instanceof Error); assert.equal(captureNotRunning(error), true); assert.equal(f.opened, 0);
  }
  const invalid = fixture(t), refused = await invalid.provider.openVideo({}, {}, invalid.root, { ...options, fps: 29 }, invalid.check).then(() => undefined, (caught: unknown) => caught);
  assert.equal(captureNotRunning(refused), true); assert.equal(invalid.opened, 0);
  // Refused right after the spawn (the simulator's identity changed) and stopped with proof.
  const changed = fixture(t); let calls = 0;
  changed.provider.ready = async () => ++calls === 1 ? changed.id : randomUUID();
  const stopped = await changed.provider.openVideo({}, {}, changed.root, options, changed.check).then(() => undefined, (caught: unknown) => caught);
  assert.equal(changed.opened, 1); assert.equal(changed.closes, 1); assert.equal(captureNotRunning(stopped), true);
  // The same refusal when the stop cannot be proven: the stop's own failure, unmarked.
  const wedged = fixture(t); let observed = 0;
  wedged.provider.ready = async () => ++observed === 1 ? wedged.id : randomUUID(); wedged.failWait();
  const unproven = await wedged.provider.openVideo({}, {}, wedged.root, options, wedged.check).then(() => undefined, (caught: unknown) => caught);
  assert.ok(unproven instanceof Error); assert.equal(wedged.opened, 1); assert.equal(captureNotRunning(unproven), false);
});
