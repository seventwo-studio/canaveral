import test from "node:test";
import assert from "node:assert/strict";
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
    { type: "end", reason: "capture_failed" }, { type: "end", reason: "capture_ended" }, { type: "end", reason: "capture_unavailable" }, error];
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
  // Other capabilities are untouched by the live family.
  assert.throws(() => validateRelayMessage("video", "host", Buffer.from(JSON.stringify({ type: "segment", epoch: 0, sequence: 0, keyframe: true, bytes: 16 })), false));
});

/** A source that produces a frame every 20 ms until its time limit, and counts what runs.
 * Its opening models a provider's preflight: it takes `openMs`, checks authorization at its end
 * as the providers do before they spawn anything, and marks such a refusal. */
interface HubOptions {
  epochSeconds?: number; handoverMs?: number; guestSource?: boolean;
  /** An early-ended source cannot be proven stopped, or its stop never returns. */
  stop?: "unprovable" | "hangs";
  /** The time the source takes to open, and how its opening fails. */
  openMs?: number; open?: "refuses" | "fails";
}
function hubFixture(options: HubOptions = {}) {
  const journal = new Map<string, Record<string, unknown>>(), receipts: LiveReceipt[] = [], stats = { sources: 0, open: 0, peak: 0, encoders: 0, opening: 0 };
  const control = { queued: false, saveFails: false };
  const source: LiveCaptureSource = {
    encoder: "/fixture/ffmpeg", guestSource: options.guestSource ?? true, notRunning: captureNotRunning, recordingQueued: () => control.queued,
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
    ...(options.epochSeconds ? { epochSeconds: options.epochSeconds } : {}), ...(options.handoverMs ? { handoverMs: options.handoverMs } : {}) });
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

test("a recording stops the live run first, feeds the viewers its own stream, and hands the device back", async () => {
  const f = hubFixture(), handle = f.hub.acquire(JOB, f.source), viewer = handle.subscribe(() => true);
  const before = await take(viewer, 4);
  assert.equal((before[0] as { epoch: number }).epoch, 0);
  const tap = await f.hub.beginRecording(JOB.machineId);
  assert.equal(tap.proven, true); assert.ok(tap.waitedMs < 2000);
  assert.equal(f.stats.open, 0, "the live run was stopped before the recording starts");
  const recording = Buffer.concat([initSegment(), fragment(0, true, Buffer.from("rec-0")), fragment(1, false, Buffer.from("rec-1")), fragment(2, true, Buffer.from("rec-2"))]);
  for (let offset = 0; offset < recording.length; offset += 11) tap.push(recording.subarray(offset, offset + 11));
  const epoch = (item: LiveViewItem) => (item as { epoch: number }).epoch;
  let item: LiveViewItem | null; const during: LiveViewItem[] = [];
  while (during.length < 4 && (item = await viewer.next(1000))) if (epoch(item) === 1) during.push(item);
  assert.deepEqual(during.map(i => i.type), ["init", "segment", "segment", "segment"]);
  assert.deepEqual((during[0] as { data: Buffer }).data, initSegment());
  assert.deepEqual((during[3] as { data: Buffer }).data, fragment(2, true, Buffer.from("rec-2")));
  assert.equal(f.stats.sources, 1, "no native run of the live capture during the recording");
  // A stream the segmenter refuses ends the tee for viewers; the recording's push never throws.
  tap.push(Buffer.from("garbage that is not a box header at all"));
  tap.end(true);
  const after: LiveViewItem[] = [];
  while (after.length < 2 && (item = await viewer.next(2000))) if (epoch(item) === 2) after.push(item);
  assert.deepEqual(after.map(i => i.type), ["init", "segment"]); assert.equal(f.stats.sources, 2); assert.equal(f.stats.peak, 1);
  // While a recording of the device is only queued, no live run starts: the recording finds the device free.
  f.control.queued = true;
  await sleep(700); assert.equal(f.stats.open, 0, "the live run stopped for the queued recording");
  const runs = f.stats.sources;
  await sleep(600); assert.equal(f.stats.sources, runs);
  f.control.queued = false;
  for (const deadline = Date.now() + 3000; Date.now() < deadline && f.stats.sources === runs;) await sleep(20);
  assert.equal(f.stats.sources, runs + 1, "the viewer's capture resumed once no recording was queued");
  // A recording whose own stop is unproven leaves the device without a provable state: the view ends.
  const second = await f.hub.beginRecording(JOB.machineId);
  second.end(false);
  let ended: LiveViewItem | null = null;
  for (let i = 0; i < 50 && ended?.type !== "end"; i++) ended = await viewer.next(100);
  assert.deepEqual(ended, { type: "end", reason: "capture_unavailable" });
  viewer.close(); handle.release();
  await receipt(f);
  assert.deepEqual(f.receipts, [{ cleaned: true }], "the live capture's own runs were all proven clean");
});

test("recording hand-over reports an unproven live stop within the wait bound", async () => {
  // The live run's stop never returns, so hand-over returns without proof.
  const stuck = hubFixture({ stop: "hangs", handoverMs: 400 }), handle = stuck.hub.acquire(JOB, stuck.source), viewer = handle.subscribe(() => true);
  await take(viewer, 3);
  const began = Date.now(), tap = await stuck.hub.beginRecording(JOB.machineId);
  assert.equal(tap.proven, false); assert.ok(tap.waitedMs >= 350 && Date.now() - began < 2000, `waited ${tap.waitedMs} ms`);
  tap.push(initSegment()); tap.end(true);
  // The stop is unprovable and the live capture ends unknown.
  const unprovable = hubFixture({ stop: "unprovable" }), held = unprovable.hub.acquire(JOB, unprovable.source), watching = held.subscribe(() => true);
  await take(watching, 3);
  const taken = await unprovable.hub.beginRecording(JOB.machineId);
  assert.equal(taken.proven, false); assert.ok(taken.waitedMs < 2000);
  let ended: LiveViewItem | null = null;
  for (let i = 0; i < 50 && ended?.type !== "end"; i++) ended = await watching.next(100);
  assert.deepEqual(ended, { type: "end", reason: "capture_failed" });
  taken.end(true); watching.close(); held.release();
  await receipt(unprovable);
  assert.deepEqual(unprovable.receipts, [{ hostCleaned: true }]);
  // Afterwards, and with no live capture at all, a recording starts without any wait.
  for (const hub of [unprovable.hub, hubFixture().hub]) { const next = await hub.beginRecording(JOB.machineId); assert.deepEqual([next.proven, next.waitedMs < 100], [true, true]); next.end(true); }
  // A second recording of one device is not the hub's to refuse; it is simply not fed to viewers.
  const f = hubFixture(), one = await f.hub.beginRecording(JOB.machineId), two = await f.hub.beginRecording(JOB.machineId);
  two.push(initSegment()); two.end(true); one.end(true);
});

test("a viewer that cannot keep up is skipped ahead to a key frame instead of holding the capture back", async () => {
  const f = hubFixture();
  const tap = await f.hub.beginRecording(JOB.machineId);
  tap.push(initSegment());
  const handle = f.hub.acquire(JOB, f.source);
  const slow = handle.subscribe(() => true), fast = handle.subscribe(() => true);
  try {
    assert.equal((await fast.next(5000))?.type, "init");
    // Send an exact number of frames through the same queue as native live capture. The fast
    // viewer reads every frame while the slow viewer falls more than four MiB behind.
    const payload = Buffer.alloc(28_000);
    for (let sequence = 0; sequence < 256; sequence++) {
      tap.push(fragment(sequence, sequence % 4 === 0, payload));
      const item = await fast.next(100);
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
    slow.close(); fast.close(); handle.release(); tap.end(true);
    await f.hub.close();
  }
  assert.deepEqual(f.receipts, [{ cleaned: true }]);
  assert.equal(f.stats.sources, 0, "viewers share the recording feed");
});

test("a stopping or journal-less hub refuses captures without a journal, and stopping leaves no timer behind", async () => {
  // Nothing captured: closing is immediate and arms no timer, so the process can exit at once.
  const idle = hubFixture(), before = timers();
  const tap = await idle.hub.beginRecording(JOB.machineId); tap.end(true);
  let began = Date.now(); await idle.hub.close();
  assert.ok(Date.now() - began < 100); assert.equal(timers(), before);
  // Stopping with a capture: its stop is proven first, and no timer outlives the close.
  const f = hubFixture(), handle = f.hub.acquire(JOB, f.source), viewer = handle.subscribe(() => true);
  await take(viewer, 3);
  began = Date.now(); await f.hub.close();
  assert.ok(Date.now() - began < 5000);
  assert.deepEqual(f.receipts, [{ cleaned: true }]); assert.equal(f.stats.open, 0);
  viewer.close(); handle.release();
  await sleep(400); assert.equal(timers(), before, "no timer of the hub is left armed");
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
