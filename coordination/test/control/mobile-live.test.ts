/// <reference lib="es2024.promise" />

import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { LiveSegmenter, MAX_LIVE_INIT_BYTES, MAX_LIVE_SEGMENT_BYTES, liveSegmentValid, startsWithKeyFrame } from "../../src/mobile-live.ts";
import type { LiveItem } from "../../src/mobile-live.ts";
import { LiveCaptureHub, LiveCaptureRefused } from "../../src/live-capture.ts";
import type { LiveCaptureSource, LiveReceipt, LiveViewItem } from "../../src/live-capture.ts";
import { validateRelayMessage } from "../../src/control/session-protocol.ts";
import { consumerApiSchema, sessionProtocolSchema } from "../../src/contracts.ts";
import { captureNotRunning, markCaptureNotRunning } from "../../src/providers/mobile.ts";
import type { NativePipe } from "../../src/providers/mobile.ts";
import { FragmentEncoder, box, fragment, initSegment, schemaValid } from "./live-fixture.ts";

/** The segmenter, the wire contract and the runner hub of live views, without a controller.
 * Box structure is real; payloads are opaque. Nothing here decodes video or runs a device. */
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function split(stream: Buffer, size: number, retain: () => boolean = () => true): LiveItem[] {
  const items: LiveItem[] = [], segmenter = new LiveSegmenter(item => items.push(item), retain);
  for (let offset = 0; offset < stream.length; offset += size) segmenter.push(stream.subarray(offset, offset + size));
  return items;
}

test("the segmenter splits a fragmented MP4 stream at any chunk size and finds key frames from the sample flags", () => {
  const payloads = Array.from({ length: 6 }, (_, i) => Buffer.alloc(40 + i * 7, i + 1));
  const stream = Buffer.concat([initSegment(), ...payloads.map((payload, i) => fragment(i, i % 3 === 0, payload)), box("mfra", Buffer.alloc(12))]);
  for (const size of [1, 7, 64, stream.length]) {
    const items = split(stream, size);
    assert.deepEqual(items.map(i => i.type), ["init", ...payloads.map(() => "segment")]);
    assert.deepEqual((items[0] as { data: Buffer }).data, initSegment());
    for (const [i, payload] of payloads.entries()) {
      const item = items[i + 1] as Extract<LiveItem, { type: "segment" }>;
      assert.deepEqual([item.sequence, item.keyframe], [i, i % 3 === 0]);
      assert.deepEqual(item.data, fragment(i, i % 3 === 0, payload));
      assert.ok(liveSegmentValid("media", item.data!));
    }
  }
  assert.ok(liveSegmentValid("init", initSegment()));
  for (const bad of [Buffer.concat([initSegment(), box("free")]), fragment(0, true, Buffer.from("x")).subarray(0, 30), Buffer.alloc(0)]) assert.equal(liveSegmentValid("init", bad), false);
  assert.equal(liveSegmentValid("media", initSegment()), false);
  // Unretained fragments are counted and described, but their media is never copied.
  let keep = false;
  const skipped = split(stream, 13, () => { keep = !keep; return keep; }).slice(1) as Extract<LiveItem, { type: "segment" }>[];
  assert.deepEqual(skipped.map(s => [s.sequence, s.keyframe, s.data !== undefined]), payloads.map((_, i) => [i, i % 3 === 0, i % 2 === 0]));
});

test("key frames are recognised only on positive evidence, through every place the flags can live", () => {
  const u32 = (value: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(value); return b; };
  const moof = (tfhd: Buffer, trun: Buffer) => box("moof", box("mfhd", u32(0), u32(1)), box("traf", tfhd, trun));
  const plain = box("tfhd", u32(0x020000), u32(1));
  // First-sample flags, per-sample flags, track fragment defaults and movie defaults, sync and not.
  assert.equal(startsWithKeyFrame(moof(plain, box("trun", u32(0x205), u32(1), u32(0), u32(0x02000000), u32(9))), 0x01010000), true);
  assert.equal(startsWithKeyFrame(moof(plain, box("trun", u32(0x205), u32(1), u32(0), u32(0x01010000), u32(9))), 0x02000000), false);
  assert.equal(startsWithKeyFrame(moof(plain, box("trun", u32(0x701), u32(1), u32(0), u32(3000), u32(9), u32(0x02000000))), 0x01010000), true);
  assert.equal(startsWithKeyFrame(moof(plain, box("trun", u32(0x701), u32(1), u32(0), u32(3000), u32(9), u32(0x01010000))), undefined), false);
  assert.equal(startsWithKeyFrame(moof(box("tfhd", u32(0x020038), u32(1), u32(3000), u32(9), u32(0x02000000)), box("trun", u32(0x1), u32(1), u32(0))), 0x01010000), true);
  assert.equal(startsWithKeyFrame(moof(box("tfhd", u32(0x020020), u32(1), u32(0x01010000)), box("trun", u32(0x1), u32(1), u32(0))), 0x02000000), false);
  assert.equal(startsWithKeyFrame(moof(plain, box("trun", u32(0x201), u32(1), u32(0), u32(9))), 0x02000000), true);
  // No flags anywhere, no samples, a missing table or a truncated box: never a key frame.
  assert.equal(startsWithKeyFrame(moof(plain, box("trun", u32(0x201), u32(1), u32(0), u32(9))), undefined), false);
  assert.equal(startsWithKeyFrame(moof(plain, box("trun", u32(0x205), u32(0), u32(0), u32(0x02000000))), undefined), false);
  assert.equal(startsWithKeyFrame(box("moof", box("mfhd", u32(0), u32(1))), 0x02000000), false);
  assert.equal(startsWithKeyFrame(moof(plain, box("trun", u32(0x205), u32(1))), 0x02000000), false);
  assert.equal(startsWithKeyFrame(Buffer.from("not a box"), 0x02000000), false);
});

test("a malformed or oversized stream fails the segmenter instead of yielding a partial segment", () => {
  const sized = (type: string, size: number) => { const header = Buffer.alloc(8); header.writeUInt32BE(size); header.write(type, 4, "latin1"); return header; };
  for (const [label, stream] of [
    ["no ftyp first", box("moov")],
    ["media before the movie header", Buffer.concat([box("ftyp"), fragment(0, true, Buffer.from("x"))])],
    ["a repeated movie header", Buffer.concat([initSegment(), box("moov")])],
    ["a fragment without media", Buffer.concat([initSegment(), box("moof"), box("moof")])],
    ["media without a fragment", Buffer.concat([initSegment(), box("mdat", Buffer.from("x"))])],
    ["a box between a fragment and its media", Buffer.concat([initSegment(), box("moof"), box("free")])],
    ["an undersized box", Buffer.concat([initSegment(), sized("moof", 4)])],
    ["a movie header beyond its bound", Buffer.concat([box("ftyp"), sized("moov", MAX_LIVE_INIT_BYTES + 1)])],
    ["a fragment beyond its bound", Buffer.concat([initSegment(), box("moof"), sized("mdat", MAX_LIVE_SEGMENT_BYTES)])],
  ] as const) assert.throws(() => split(stream, 16), /fragmented MP4/, label);
});

test("the live wire contract: the relay and the packaged schema accept the same host messages, and a viewer may only renew", () => {
  const schema = sessionProtocolSchema(), defs = schema.$defs as Record<string, any>;
  const valid = (definition: any, value: any) => schemaValid(schema, definition, value);
  const relay = (side: "host" | "consumer", value: unknown) => { try { validateRelayMessage("live", side, Buffer.from(JSON.stringify(value)), false); return true; } catch { return false; } };
  const error = { type: "error", code: "capability_unsupported", message: "This host has no live screen capture for this device.", outcome: "unknown" };
  const accepted = [{ type: "live", mediaType: "video/mp4", codec: "avc1", fps: 30 }, { type: "init", epoch: 0, bytes: 700 }, { type: "init", epoch: 4, bytes: MAX_LIVE_INIT_BYTES },
    { type: "segment", epoch: 0, sequence: 0, keyframe: true, bytes: 16 }, { type: "segment", epoch: 2, sequence: 9000, keyframe: false, bytes: MAX_LIVE_SEGMENT_BYTES },
    { type: "end", reason: "capture_failed" }, { type: "end", reason: "capture_ended" }, { type: "end", reason: "capture_unavailable" }, error, { ...error, code: "device_recording_active" }];
  const refused = [{ type: "live", mediaType: "video/mp4", codec: "avc1", fps: 60 }, { type: "live", mediaType: "video/mp4", codec: "avc1", fps: 30, bitRate: 1 }, { type: "init", epoch: -1, bytes: 700 },
    { type: "init", epoch: 0, bytes: MAX_LIVE_INIT_BYTES + 1 }, { type: "init", epoch: 0 }, { type: "segment", epoch: 0, sequence: 0, keyframe: 1, bytes: 16 }, { type: "segment", epoch: 0, sequence: 0.5, keyframe: true, bytes: 16 },
    { type: "segment", epoch: 0, sequence: 0, keyframe: true, bytes: MAX_LIVE_SEGMENT_BYTES + 1 }, { type: "segment", epoch: 0, sequence: 0, keyframe: true, bytes: 16, data: "x" },
    { type: "end", reason: "lease_expired" }, { type: "end", reason: "authorization_ended" }, { type: "end" }, { type: "finish", bytes: 1, sha256: "0".repeat(64), cleaned: true }, { type: "video", mediaType: "video/mp4", codec: "avc1", fps: 30 }, { type: "renewal", renewed: true, authorizationDeadline: "2026-01-01T00:00:00Z" }, { type: "renew" }];
  for (const message of accepted) { assert.equal(relay("host", message), true, JSON.stringify(message)); assert.equal(valid(defs.liveHost, message), true, JSON.stringify(message)); }
  for (const message of refused) { assert.equal(relay("host", message), false, JSON.stringify(message)); assert.equal(valid(defs.liveHost, message), false, JSON.stringify(message)); }
  // The viewer's only message is a renewal request; it sends no media, input or acknowledgement.
  assert.equal(relay("consumer", { type: "renew" }), true); assert.equal(valid(defs.liveConsumer, { type: "renew" }), true);
  for (const message of [{ type: "renew", ttlSeconds: 600 }, { type: "ack" }, { type: "input-control", action: "take" }, { type: "end", reason: "capture_ended" }]) { assert.equal(relay("consumer", message), false); assert.equal(valid(defs.liveConsumer, message), false); }
  assert.throws(() => validateRelayMessage("live", "consumer", Buffer.alloc(8), true));
  assert.equal(validateRelayMessage("live", "host", Buffer.alloc(65536), true).byteLength, 65536);
  assert.throws(() => validateRelayMessage("live", "host", Buffer.from(JSON.stringify({ type: "ready", sessionId: "x", generation: "y", capability: "live" })), false));
  assert.equal(valid(defs.liveBroker, { type: "renewal", renewed: false, authorizationDeadline: "2026-11-21T10:00:00.000Z" }), true);
  assert.ok(defs.Ready.properties.capability.enum.includes("live"));
  const streams = schema["x-canaveral-streams"] as Record<string, any>;
  assert.deepEqual(streams.live.binary, { consumer: "forbidden", host: "fragmented-mp4-segments", maxMessageBytes: 65536 });
  // The consumer OpenAPI document publishes the lease routes, under the lease key only.
  const api = consumerApiSchema() as Record<string, any>;
  for (const [path, method, operation] of [["", "post", "createLiveView"], ["/{viewId}", "get", "inspectLiveView"], ["/{viewId}/close", "post", "closeLiveView"], ["/{viewId}/{generation}", "get", "attachLiveView"]] as const) {
    const route = api.paths["/v1/leases/{leaseId}/live-views" + path][method];
    assert.equal(route.operationId, operation); assert.deepEqual(route.security, [{ LeaseBearer: [] }]);
  }
  assert.equal(schemaValid(api, api.components.schemas.CreateLiveView, { id: "0b0b0b0b-0000-4000-8000-000000000001", member: "primary", ttlSeconds: 30 }), true);
  for (const body of [{ id: "0b0b0b0b-0000-4000-8000-000000000001" }, { id: "0b0b0b0b-0000-4000-8000-000000000001", member: "primary", ttlSeconds: 9 }, { id: "0b0b0b0b-0000-4000-8000-000000000001", member: "primary", bitRate: 1 }]) assert.equal(schemaValid(api, api.components.schemas.CreateLiveView, body), false);
  const conflict = { ...error, code: "device_live_view_active" };
  assert.equal(valid(defs.WorkerError, conflict), true);
  assert.deepEqual(validateRelayMessage("video", "host", Buffer.from(JSON.stringify(conflict)), false), conflict);
  // Other capabilities are untouched by the live family.
  assert.throws(() => validateRelayMessage("video", "host", Buffer.from(JSON.stringify({ type: "segment", epoch: 0, sequence: 0, keyframe: true, bytes: 16 })), false));
});

/** A source that produces a frame every 20 ms until its time limit, and counts what runs.
 * Its opening models a provider's preflight: it takes `openMs`, checks authorization at its end
 * as the providers do before they spawn anything, and marks such a refusal. */
interface HubOptions {
  epochSeconds?: number; guestSource?: boolean; nextFrame?: () => Promise<Buffer>;
  /** An early-ended source cannot be proven stopped, or its stop never returns. */
  stop?: "unprovable" | "hangs";
  /** The time the source takes to open, and how its opening fails. */
  openMs?: number; open?: "refuses" | "fails";
}
function hubFixture(options: HubOptions = {}) {
  const journal = new Map<string, Record<string, unknown>>(), receipts: LiveReceipt[] = [], stats = { sources: 0, open: 0, peak: 0, encoders: 0, opening: 0 };
  const control = { saveFails: false };
  const source: LiveCaptureSource = {
    encoder: "/fixture/ffmpeg", guestSource: options.guestSource ?? true, notRunning: captureNotRunning,
    openEncoder: async () => { stats.encoders++; return new FragmentEncoder(); },
    openSource: async (video, authorized): Promise<NativePipe> => {
      stats.opening++;
      if (options.openMs) await sleep(options.openMs);
      // Nothing is spawned before this point.
      if (options.open === "refuses" || !authorized()) throw markCaptureNotRunning(new Error("refused before any spawn"));
      if (options.open === "fails") throw new Error("the spawn may have happened");
      stats.sources++; stats.open++; stats.peak = Math.max(stats.peak, stats.open);
      const started = Date.now(); let completed = false, closed = false, frame = 0;
      return {
        async read() {
          for (;;) {
            if (closed || !authorized()) throw new Error("ended");
            if (Date.now() - started >= video.durationSeconds * 1000) { if (!completed) { completed = true; stats.open--; } return Buffer.alloc(0); }
            if (options.nextFrame) return options.nextFrame();
            await sleep(20); if (!closed) return Buffer.alloc(1, frame++ & 0xff);
          }
        },
        async wait() { if (!completed) throw new Error("not complete"); return 0; },
        async write() { throw new Error("no input"); }, async end() {},
        async close() {
          if (closed) return; closed = true; if (completed) return;
          if (options.stop === "hangs") await new Promise(() => {});
          if (options.stop === "unprovable") throw new Error("stop unproven");
          stats.open--;
        },
      };
    },
  };
  const hub = new LiveCaptureHub({ load: id => journal.get(id), save: (id, value) => { if (control.saveFails) throw new Error("disk full"); journal.set(id, value); }, report: async (_job, receipt) => { receipts.push(receipt); },
    ...(options.epochSeconds ? { epochSeconds: options.epochSeconds } : {}) });
  return { hub, source, journal, receipts, stats, control };
}
const JOB = { id: "0b0b0b0b-0000-4000-8000-000000000001", generation: "0b0b0b0b-0000-4000-8000-000000000002", machineId: "0b0b0b0b-0000-4000-8000-000000000003" };
const OTHER = { id: "0b0b0b0b-0000-4000-8000-000000000011", generation: "0b0b0b0b-0000-4000-8000-000000000012", machineId: "0b0b0b0b-0000-4000-8000-000000000013" };
async function take(subscription: { next(ms: number): Promise<LiveViewItem | null> }, count: number, ms = 5000): Promise<LiveViewItem[]> {
  const items: LiveViewItem[] = [], deadline = Date.now() + ms;
  while (items.length < count && Date.now() < deadline) { const item = await subscription.next(100); if (item) items.push(item); }
  assert.equal(items.length, count, "live items in time"); return items;
}
async function receipt(f: ReturnType<typeof hubFixture>, ms = 5000): Promise<void> { for (const deadline = Date.now() + ms; Date.now() < deadline && !f.receipts.length;) await sleep(50); }
const timers = () => process.getActiveResourcesInfo().filter(name => name === "Timeout").length;

test("the hub captures only while an authorized viewer is subscribed, journals before native dispatch and reports cleanup once", async () => {
  const f = hubFixture(), handle = f.hub.acquire(JOB, f.source);
  // Acquired but unwatched: journaled, nothing native.
  await sleep(400);
  assert.equal(f.stats.sources, 0); assert.equal(f.journal.get(JOB.id)!.state, "attaching");
  let authorized = true;
  const first = handle.subscribe(() => authorized), items = await take(first, 6);
  assert.equal(f.journal.get(JOB.id)!.state, "started");
  assert.deepEqual(items.map(i => i.type), ["init", "segment", "segment", "segment", "segment", "segment"]);
  assert.deepEqual(items.slice(1).map(i => (i as { sequence: number }).sequence), [0, 1, 2, 3, 4]);
  // A viewer that joins later starts with the header and the most recent key frame.
  const other = f.hub.acquire(JOB, f.source), late = other.subscribe(() => true), joined = await take(late, 2);
  assert.equal(joined[0]!.type, "init"); assert.equal((joined[1] as { keyframe: boolean }).keyframe, true);
  assert.equal(f.stats.sources, 1); assert.equal(f.stats.encoders, 1);
  // One of two viewers loses its authority: the capture goes on for the other, uninterrupted.
  authorized = false;
  const after = await take(late, 6);
  assert.ok(after.every(item => item.type === "segment")); assert.equal(f.stats.sources, 1); assert.equal(f.stats.open, 1);
  // Losing authority is leaving: with no authorized viewer the capture stops, and resumes for one.
  late.close(); other.release();
  await sleep(1200); assert.equal(f.stats.open, 0, "the capture stopped with its last authorized viewer");
  authorized = true;
  await sleep(600); assert.equal(f.stats.sources, 2, "an authorized viewer still subscribed gets a new run");
  first.close(); handle.release();
  await receipt(f);
  assert.deepEqual(f.receipts, [{ cleaned: true }]);
  assert.deepEqual([f.journal.get(JOB.id)!.state, f.journal.get(JOB.id)!.cleaned], ["finished", true]);
  assert.equal(f.stats.open, 0); assert.equal(f.stats.peak, 1); assert.equal(f.hub.idle, true);
  // The journal of an attempt is never reused: the capture is not repeated.
  assert.throws(() => f.hub.acquire(JOB, f.source), (error: unknown) => error instanceof LiveCaptureRefused && error.journaled === true);
  assert.equal(f.stats.sources, 2);
});

test("a viewer that leaves while its capture is still being opened leaves the capture clean, at the first run and at a rollover", async () => {
  // The provider refuses in its preflight because the viewer is gone: provably nothing was spawned.
  for (const leaveAfterMs of [0, 60, 150]) {
    const f = hubFixture({ openMs: 300 }), handle = f.hub.acquire(JOB, f.source), viewer = handle.subscribe(() => true);
    await sleep(leaveAfterMs); viewer.close(); handle.release();
    await receipt(f);
    assert.deepEqual(f.receipts, [{ cleaned: true }], `left ${leaveAfterMs} ms into the opening`);
    assert.deepEqual([f.journal.get(JOB.id)!.state, f.journal.get(JOB.id)!.cleaned], ["finished", true]);
    assert.equal(f.stats.sources, 0, "no native source ever ran");
  }
  // The same while the next run is being opened after a rollover.
  const f = hubFixture({ epochSeconds: 1, openMs: 300 }), handle = f.hub.acquire(JOB, f.source), viewer = handle.subscribe(() => true);
  await take(viewer, 3);
  for (const deadline = Date.now() + 5000; Date.now() < deadline && f.stats.opening < 2;) await sleep(10);
  assert.equal(f.stats.opening, 2, "the next run is being opened"); assert.equal(f.stats.sources, 1);
  viewer.close(); handle.release();
  await receipt(f);
  assert.deepEqual(f.receipts, [{ cleaned: true }]); assert.equal(f.stats.sources, 1); assert.equal(f.stats.open, 0);
  // A source that refuses for its own reasons before any spawn: the capture fails, and is clean.
  const refused = hubFixture({ open: "refuses" }), held = refused.hub.acquire(JOB, refused.source), watching = held.subscribe(() => true);
  let ended: LiveViewItem | null = null;
  for (let i = 0; i < 40 && ended?.type !== "end"; i++) ended = await watching.next(100);
  assert.deepEqual(ended, { type: "end", reason: "capture_failed" });
  watching.close(); held.release(); await receipt(refused);
  assert.deepEqual(refused.receipts, [{ cleaned: true }]);
  // A failure to open that does not say whether anything was spawned stays unknown.
  const unknown = hubFixture({ open: "fails" }), kept = unknown.hub.acquire(JOB, unknown.source), seen = kept.subscribe(() => true);
  await sleep(300); seen.close(); kept.release(); await receipt(unknown);
  assert.deepEqual(unknown.receipts, [{ hostCleaned: true }]);
  assert.deepEqual([unknown.journal.get(JOB.id)!.state, unknown.journal.get(JOB.id)!.cleaned], ["unknown", false]);
});

test("the live receipt attributes only a fence that caused the epoch to stop", async t => {
  for (const first of ["fence", "failure"]) await t.test(first, { timeout: 5000 }, async () => {
    const stop = { cause: "fence" as const, leaseId: randomUUID(), leaseRevision: 7 };
    const read = Promise.withResolvers<Uint8Array>(), reading = Promise.withResolvers<void>();
    const output = Promise.withResolvers<Uint8Array>(), cleanup = Promise.withResolvers<void>();
    const result = Promise.withResolvers<LiveReceipt>(), journal = new Map<string, Record<string, unknown>>();
    let fenced = false;
    const encoder: NativePipe = {
      read: () => output.promise, async write(data) { return data.length; },
      async end() {}, async wait() { return 0; }, async close() { output.resolve(Buffer.alloc(0)); },
    };
    const source: LiveCaptureSource = {
      encoder: "/fixture/ffmpeg", guestSource: true, notRunning: () => false,
      leaseFence: () => fenced ? stop : undefined,
      async openSource() {
        return {
          ...encoder,
          read() { reading.resolve(); return read.promise; },
          async close() {
            // In the failure-first ordering the fence appears only after the pipeline enters cleanup.
            fenced = true;
            cleanup.resolve();
            throw new Error("Guest recorder stop is unproven.");
          },
        };
      },
      async openEncoder() { return encoder; },
    };
    const hub = new LiveCaptureHub({ load: id => journal.get(id), save: (id, value) => journal.set(id, value),
      async report(_, value) { result.resolve(value); } });
    const handle = hub.acquire(JOB, source), viewer = handle.subscribe(() => !fenced);
    await reading.promise;
    if (first === "fence") { fenced = true; read.resolve(Buffer.alloc(0)); }
    else read.reject(new Error("Recorder failed before the fence."));
    await cleanup.promise;
    viewer.close(); handle.release();
    assert.deepEqual(await result.promise, first === "fence" ? { hostCleaned: true, stop } : { hostCleaned: true });
    assert.deepEqual(journal.get(JOB.id)?.stop, first === "fence" ? stop : undefined);
  });
});

test("an unproven stop ends the capture as unknown, and a host without capture reports clean without running", async () => {
  // A guest recorder whose stop is unproven: only the encoder's exit is reported.
  const guest = hubFixture({ stop: "unprovable" }), handle = guest.hub.acquire(JOB, guest.source), viewer = handle.subscribe(() => true);
  await take(viewer, 3); viewer.close(); handle.release();
  await receipt(guest);
  assert.deepEqual(guest.receipts, [{ hostCleaned: true }]);
  assert.deepEqual([guest.journal.get(JOB.id)!.state, guest.journal.get(JOB.id)!.cleaned, guest.journal.get(JOB.id)!.hostCleaned], ["unknown", false, true]);
  // A host-process source (iOS) has nothing a device stop could prove: no receipt at all.
  const host = hubFixture({ stop: "unprovable", guestSource: false }), held = host.hub.acquire(JOB, host.source), watching = held.subscribe(() => true);
  await take(watching, 3); watching.close(); held.release();
  await sleep(1500);
  assert.deepEqual(host.receipts, []); assert.equal(host.journal.get(JOB.id)!.state, "unknown");
  // No capture adapter: nothing runs, the viewer is not fed, and the capture is reported clean.
  const none = hubFixture(), idle = none.hub.acquire(JOB, undefined), unfed = idle.subscribe(() => true);
  assert.equal(await unfed.next(300), null); unfed.close(); idle.release();
  await receipt(none);
  assert.deepEqual(none.receipts, [{ cleaned: true }]); assert.equal(none.stats.sources, 0);
});

test("the runner's device reservation excludes recordings and live captures in either order", async () => {
  const f = hubFixture(), live = f.hub.acquire(JOB, f.source);
  try {
    assert.throws(() => f.hub.reserveRecording(JOB.machineId), { code: "device_live_view_active" });
    const other = f.hub.reserveRecording(OTHER.machineId);
    other();
  } finally { live.release(); }
  await receipt(f);
  const release = f.hub.reserveRecording(JOB.machineId);
  try {
    assert.throws(() => f.hub.acquire(JOB, f.source), { code: "device_recording_active" });
    assert.throws(() => f.hub.reserveRecording(JOB.machineId), { code: "device_recording_active" });
    assert.equal(f.stats.sources, 0);
  } finally { release(); await f.hub.close(); }
});

test("a viewer that cannot keep up is skipped ahead to a key frame instead of holding the capture back", async () => {
  let frame = Promise.withResolvers<Buffer>();
  const f = hubFixture({ nextFrame: () => {
    const pending = frame.promise;
    void pending.then(() => { frame = Promise.withResolvers<Buffer>(); });
    return pending;
  } });
  const handle = f.hub.acquire(JOB, f.source);
  const slow = handle.subscribe(() => true), fast = handle.subscribe(() => true);
  try {
    // Send an exact number of frames through the same queue as native live capture. The fast
    // viewer reads every frame while the slow viewer falls more than four MiB behind.
    for (let sequence = 0; sequence < 256; sequence++) {
      frame.resolve(Buffer.alloc(28_000));
      if (sequence === 0) assert.equal((await fast.next(5000))?.type, "init");
      const item = await fast.next(5000);
      assert.equal(item?.type, "segment");
      assert.equal(item.sequence, sequence);
    }
    const backlog: LiveViewItem[] = [];
    for (let item = await slow.next(50); item; item = await slow.next(50)) backlog.push(item);
    const media = backlog.filter(item => item.type === "segment");
    assert.equal(backlog[0]?.type, "init");
    assert.ok(media[0] && media[0].sequence > 20 && media[0].keyframe, `resumed at ${media[0]?.sequence}`);
    assert.ok(media.reduce((bytes, item) => bytes + item.data.length, 0) <= 4 * 1_048_576, "the backlog stays bounded");
    assert.ok(media.every((item, i) => i === 0 || item.sequence === media[i - 1]!.sequence + 1 || item.keyframe), "every gap resumes on a key frame");
  } finally {
    slow.close(); fast.close(); handle.release();
    frame.resolve(Buffer.alloc(0));
    await f.hub.close();
  }
  assert.deepEqual(f.receipts, [{ cleaned: true }]);
  assert.equal(f.stats.sources, 1, "viewers share the native live capture");
});

test("a stopping or journal-less hub refuses captures without a journal, and stopping leaves no timer behind", async () => {
  // Nothing captured: closing is immediate and arms no timer, so the process can exit at once.
  const idle = hubFixture(), before = timers();
  idle.hub.reserveRecording(JOB.machineId)();
  let began = Date.now(); await idle.hub.close();
  assert.ok(Date.now() - began < 100); assert.equal(timers(), before);
  // Stopping with a capture: its stop is proven first, and no timer outlives the close.
  const f = hubFixture(), handle = f.hub.acquire(JOB, f.source), viewer = handle.subscribe(() => true);
  await take(viewer, 3);
  began = Date.now(); await f.hub.close();
  assert.ok(Date.now() - began < 5000);
  assert.deepEqual(f.receipts, [{ cleaned: true }]); assert.equal(f.stats.open, 0);
  viewer.close(); handle.release();
  await sleep(400); assert.ok(timers() <= before, "no additional timer of the hub is left armed");
  // A view that arrives while the hub stops is refused without a journal: its runner must not attach.
  assert.throws(() => f.hub.acquire(OTHER, f.source), (error: unknown) => error instanceof LiveCaptureRefused && error.journaled === false);
  assert.equal(f.journal.has(OTHER.id), false);
  // A capture that cannot be journaled is refused the same way, and starts nothing.
  const disk = hubFixture(); disk.control.saveFails = true;
  assert.throws(() => disk.hub.acquire(JOB, disk.source), (error: unknown) => error instanceof LiveCaptureRefused && error.journaled === false);
  assert.equal(disk.hub.idle, true); assert.equal(disk.stats.opening, 0);
  // A capture that is ending has a journal: a late viewer may be told so by its runner.
  const ending = hubFixture({ stop: "hangs" }), first = ending.hub.acquire(JOB, ending.source), watching = first.subscribe(() => true);
  await take(watching, 2); watching.close(); first.release();
  assert.throws(() => ending.hub.acquire(JOB, ending.source), (error: unknown) => error instanceof LiveCaptureRefused && error.journaled === true);
});
