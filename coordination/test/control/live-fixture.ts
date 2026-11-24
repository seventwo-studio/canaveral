import type { NativePipe } from "../../src/providers/mobile.ts";
import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import type { LiveSegment, LiveStream } from "../../src/video-sdk.ts";

/** Fragmented MP4 stand-ins for live-view fixtures: a real box structure with the sample flags
 * the runner reads to find key frames, around opaque payloads. They prove segmentation, ordering,
 * transport and accounting. Nothing here is decodable video, and no encoder or device runs. */
const u32 = (value: number): Buffer => { const b = Buffer.alloc(4); b.writeUInt32BE(value); return b; };
export function box(type: string, ...bodies: Buffer[]): Buffer {
  const body = Buffer.concat(bodies), header = Buffer.alloc(8);
  header.writeUInt32BE(8 + body.length); header.write(type, 4, "latin1");
  return Buffer.concat([header, body]);
}
/** `ftyp` + `moov`, whose `trex` defaults mark samples as not sync samples. */
export function initSegment(): Buffer {
  return Buffer.concat([box("ftyp", Buffer.from("isom\0\0\0\0isomavc1", "latin1")), box("moov", box("mvex", box("trex", u32(0), u32(1), u32(1), u32(0), u32(0), u32(0x01010000))))]);
}
/** One `moof` + `mdat` with a single sample; a key frame overrides the default through the
 * sample run's first-sample flags, as FFmpeg's fragments do. */
export function fragment(sequence: number, keyframe: boolean, payload: Buffer): Buffer {
  const trun = box("trun", u32(keyframe ? 0x000205 : 0x000201), u32(1), u32(0), ...(keyframe ? [u32(0x02000000)] : []), u32(payload.length));
  return Buffer.concat([box("moof", box("mfhd", u32(0), u32(sequence + 1)), box("traf", box("tfhd", u32(0x020000), u32(1)), trun)), box("mdat", payload)]);
}
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** A stand-in encoder that streams: the header at its first input, then one fragment per input
 * write, a key frame every `gop` fragments. It exits 0 when its input ends. */
export class FragmentEncoder implements NativePipe {
  private out: Buffer[] = [];
  private code: number | undefined;
  private sequence = 0;
  closed = false;
  constructor(private readonly hooks: { gop?: number; close?: () => void; wait?: () => void } = {}) {}
  async write(data: Uint8Array): Promise<number> {
    if (this.closed) throw new Error("closed");
    if (!this.sequence) this.out.push(initSegment());
    this.out.push(fragment(this.sequence, this.sequence % (this.hooks.gop ?? 4) === 0, Buffer.from(data))); this.sequence++;
    return data.length;
  }
  async end(): Promise<void> { this.code ??= 0; }
  async read(count: number, timeoutMs: number): Promise<Uint8Array> {
    const deadline = Date.now() + timeoutMs;
    while (!this.out.length && this.code === undefined && !this.closed) { if (Date.now() > deadline) throw new Error("read timeout"); await sleep(10); }
    const first = this.out[0];
    if (!first) return Buffer.alloc(0);
    if (first.length > count) { this.out[0] = first.subarray(count); return first.subarray(0, count); }
    this.out.shift(); return first;
  }
  async wait(timeoutMs: number): Promise<number> {
    this.hooks.wait?.();
    const deadline = Date.now() + timeoutMs;
    while (this.code === undefined) { if (Date.now() > deadline) throw new Error("wait timeout"); await sleep(10); }
    return this.code;
  }
  async close(): Promise<void> { if (!this.closed) { this.closed = true; this.hooks.close?.(); this.code ??= 143; } }
}

/** Pulls a live stream in the background so a test can wait for segments and for its end.
 * `lastAt` is when the latest segment reached the consumer (wall clock, milliseconds). */
export function collect(stream: LiveStream): { segments: LiveSegment[]; done: Promise<void>; failure(): unknown; lastAt(): number } {
  const segments: LiveSegment[] = []; let failure: unknown, last = 0;
  const done = (async () => { try { for await (const segment of stream.segments()) { segments.push(segment); last = Date.now(); } } catch (error) { failure = error; } })();
  return { segments, done, failure: () => failure, lastAt: () => last };
}
/** The bound the fixtures hold an ended authority to: no segment reaches a viewer later than
 * this after its authority ended. docs/mobile-control.md states the same number. */
export const LIVE_END_MS = 1000;
/** Asserts that bound for a stream that has ended. `since` is the moment the authority was known
 * to have ended: a request's response, or a deadline. The viewer may learn the reason later (the
 * SDK waits out the controller's three-second window for a provisional reason); the picture may not
 * go on. The stream must have been delivering shortly before, or the bound would prove nothing;
 * that check is loose, because under load the request that ends the authority takes a while. */
export function stoppedWithin(t: TestContext, got: ReturnType<typeof collect>, since: number, label: string, ms = LIVE_END_MS): void {
  const late = got.lastAt() - since;
  t.diagnostic(`${label}: last segment ${late} ms after the authority ended`);
  assert.ok(late > -5000, `${label}: the stream was not delivering when the authority ended (last segment ${-late} ms before)`);
  assert.ok(late <= ms, `${label}: a segment arrived ${late} ms after the authority ended; the bound is ${ms} ms`);
}
/** Within an epoch sequences only increase and each epoch opens with its header; a viewer's
 * first media segment of an epoch, and the first after any gap, is a key frame. */
export function ordered(segments: readonly LiveSegment[]): boolean {
  let epoch = -1, last = -1, needKey = true;
  for (const s of segments) {
    if (s.kind === "init") { if (s.epoch <= epoch) return false; epoch = s.epoch; last = -1; needKey = true; continue; }
    if (s.epoch !== epoch || s.sequence <= last || (needKey || s.sequence !== last + 1) && !s.keyframe) return false;
    last = s.sequence; needKey = false;
  }
  return epoch >= 0;
}

/** A validator for the JSON Schema keywords the packaged live-view definitions use, so tests can
 * hold real messages and responses against the published contract. An unknown keyword throws. */
export function schemaValid(root: Record<string, any>, definition: any, value: any): boolean {
  const resolve = (ref: string) => ref.slice(2).split("/").reduce((node: any, key) => node[key], root);
  const check = (def: any, item: any): boolean => {
    if (def.$ref) return check(resolve(String(def.$ref)), item);
    if (def.anyOf) return def.anyOf.some((option: any) => check(option, item));
    for (const keyword of Object.keys(def)) if (!["type", "const", "enum", "minimum", "maximum", "minLength", "maxLength", "pattern", "properties", "required", "additionalProperties", "description", "format", "default"].includes(keyword)) throw new Error(`unsupported schema keyword ${keyword}`);
    if (Object.hasOwn(def, "const")) return item === def.const;
    if (def.enum && !def.enum.includes(item)) return false;
    if (def.type === "integer") return Number.isSafeInteger(item) && item >= (def.minimum ?? -Infinity) && item <= (def.maximum ?? Infinity);
    if (def.type === "boolean") return typeof item === "boolean";
    if (def.type === "string") return typeof item === "string" && item.length >= (def.minLength ?? 0) && item.length <= (def.maxLength ?? Infinity) && (!def.pattern || new RegExp(def.pattern).test(item)) &&
      (def.format !== "date-time" || Number.isFinite(Date.parse(item))) && (def.format !== "uuid" || /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(item));
    if (def.type !== "object" || item === null || typeof item !== "object") return false;
    return (def.required ?? []).every((name: string) => Object.hasOwn(item, name)) && Object.keys(item).every(name => def.properties?.[name] ? check(def.properties[name], item[name]) : def.additionalProperties !== false);
  };
  return check(definition, value);
}
