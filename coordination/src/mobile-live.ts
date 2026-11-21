/** Live screen views of mobile devices: the constants and the fragmented-MP4 segmenter shared
 * by the controller, the runner and the SDK.
 *
 * A live view never has its own capture path. The runner runs the native video pipeline of
 * recordings (`serveMobileVideo`) for one device and splits its fragmented MP4 output into an
 * initialization segment (`ftyp` + `moov`) and media segments (one `moof` + `mdat` each).
 * Every viewer of that device receives those same segments. Nothing here decodes video. */
import { ServiceError } from './errors.ts';

/** Encoder settings of every live capture. Fixed, so viewers of one device can share one capture;
 * the values are those of the natively trialled dashboard recording. */
export const LIVE_FPS = 30, LIVE_BIT_RATE = 4_000_000;
/** One native capture run. Android screenrecord stops by itself after at most 180 seconds, so a
 * longer view continues in a new run (an "epoch") with a new initialization segment. */
export const LIVE_EPOCH_SECONDS = 180;
/** A view's lifetime without renewal: chosen per view within these bounds, default the maximum.
 * A client renews after a third of it. */
export const LIVE_VIEW_SECONDS = 120, LIVE_VIEW_MIN_SECONDS = 10;
/** A recording that takes a watched device waits at most this long for the live run's stop
 * proof, then starts regardless. The controller adds it to such a recording's deadline. */
export const LIVE_HANDOVER_SECONDS = 15;
export const MAX_LIVE_INIT_BYTES = 1_048_576, MAX_LIVE_SEGMENT_BYTES = 8 * 1_048_576, MAX_LIVE_MOOF_BYTES = 1_048_576;
/** Why the host ended a stream it was still serving. A host whose own authority ended sends
 * nothing more, so that cause is the controller's to record, with its other reasons. */
export const LIVE_HOST_END_REASONS = ['capture_ended', 'capture_failed', 'capture_unavailable'] as const;
export type LiveHostEndReason = typeof LIVE_HOST_END_REASONS[number];

export type LiveItem =
  | { type: 'init'; data: Buffer }
  /** `data` is absent when the segmenter was told not to retain this fragment. */
  | { type: 'segment'; sequence: number; keyframe: boolean; data?: Buffer };

const malformed = (detail: string): never => { throw new ServiceError(`Live video is not a bounded fragmented MP4 stream: ${detail}.`, 409); };
interface Box { type: string; body: number; end: number }
function boxes(data: Buffer, start: number, end: number): Box[] {
  const result: Box[] = [];
  for (let offset = start; offset < end;) {
    if (end - offset < 8) malformed('a box header is truncated');
    let size = data.readUInt32BE(offset), body = offset + 8;
    if (size === 1) {
      if (end - offset < 16) malformed('a box header is truncated');
      const large = data.readBigUInt64BE(offset + 8);
      if (large > BigInt(Number.MAX_SAFE_INTEGER)) malformed('a box is too large');
      size = Number(large); body = offset + 16;
    }
    if (size < body - offset || offset + size > end) malformed('a box is truncated');
    result.push({ type: data.toString('latin1', offset + 4, offset + 8), body, end: offset + size }); offset += size;
  }
  return result;
}
function u32(data: Buffer, box: Box, offset: number): number {
  if (box.body + offset + 4 > box.end) malformed(`the ${box.type} box is short`);
  return data.readUInt32BE(box.body + offset);
}
/** `sample_is_non_sync_sample`: a fragment whose first sample has it cannot start playback. */
const NON_SYNC = 0x10000;
/** The fragment default sample flags of the movie header (`moov/mvex/trex`), if present. */
function movieDefaultFlags(init: Buffer): number | undefined {
  try {
    const moov = boxes(init, 0, init.length).find(b => b.type === 'moov');
    const mvex = moov && boxes(init, moov.body, moov.end).find(b => b.type === 'mvex');
    const trex = mvex && boxes(init, mvex.body, mvex.end).find(b => b.type === 'trex');
    return trex ? u32(init, trex, 20) : undefined;
  } catch { return undefined; }
}
/** True only when the first sample of the fragment is positively a sync sample. The flags come
 * from the sample run's first-sample flags, else its per-sample flags, else the track fragment's
 * defaults, else the movie's. An unreadable fragment is never treated as a key frame. */
export function startsWithKeyFrame(moof: Buffer, movieDefault: number | undefined): boolean {
  try {
    const top = boxes(moof, 0, moof.length)[0];
    if (top?.type !== 'moof') return false;
    const traf = boxes(moof, top.body, top.end).find(b => b.type === 'traf');
    if (!traf) return false;
    const children = boxes(moof, traf.body, traf.end), tfhd = children.find(b => b.type === 'tfhd'), trun = children.find(b => b.type === 'trun');
    if (!tfhd || !trun) return false;
    const trackFlags = u32(moof, tfhd, 0) & 0xffffff;
    let at = 8, flags = movieDefault;
    for (const [bit, size] of [[0x1, 8], [0x2, 4], [0x8, 4], [0x10, 4]] as const) if (trackFlags & bit) at += size;
    if (trackFlags & 0x20) flags = u32(moof, tfhd, at);
    const runFlags = u32(moof, trun, 0) & 0xffffff;
    if (!u32(moof, trun, 4)) return false;
    let cursor = 8 + (runFlags & 0x1 ? 4 : 0);
    if (runFlags & 0x4) flags = u32(moof, trun, cursor);
    else if (runFlags & 0x400) { cursor += (runFlags & 0x100 ? 4 : 0) + (runFlags & 0x200 ? 4 : 0); flags = u32(moof, trun, cursor); }
    return flags !== undefined && (flags & NON_SYNC) === 0;
  } catch { return false; }
}

/** Splits one fragmented MP4 byte stream, in arbitrary chunks, into its initialization segment
 * and its media segments. Only the movie header, each `moof` and the media of retained fragments
 * are copied; everything else is skipped. `retain` is asked once per fragment, at its `moof`. */
export class LiveSegmenter {
  private header = Buffer.alloc(0);
  private collecting: Buffer[] | undefined;
  private remaining = 0;
  private kind = '';
  private init: Buffer[] = [];
  private initBytes = 0;
  private movie = false;
  private moof: Buffer | undefined;
  private keep = false;
  private sequence = 0;
  private movieDefault: number | undefined;
  constructor(private readonly emit: (item: LiveItem) => void, private readonly retain: () => boolean = () => true) {}
  private finish(): void {
    const body = this.collecting ? Buffer.concat(this.collecting) : undefined; this.collecting = undefined;
    if (this.kind === 'ftyp' || this.kind === 'moov') {
      this.init.push(body!);
      if (this.kind === 'moov') { this.movie = true; const data = Buffer.concat(this.init); this.movieDefault = movieDefaultFlags(data); this.emit({ type: 'init', data }); }
    } else if (this.kind === 'moof') this.moof = body!;
    else if (this.kind === 'mdat') {
      const moof = this.moof!, keyframe = startsWithKeyFrame(moof, this.movieDefault); this.moof = undefined;
      this.emit({ type: 'segment', sequence: this.sequence++, keyframe, ...(body ? { data: Buffer.concat([moof, body]) } : {}) });
    }
  }
  push(data: Uint8Array): void {
    let offset = 0;
    while (offset < data.length) {
      if (this.remaining) {
        const count = Math.min(this.remaining, data.length - offset);
        this.collecting?.push(Buffer.from(data.subarray(offset, offset + count)));
        this.remaining -= count; offset += count;
        if (!this.remaining) this.finish();
        continue;
      }
      const target = this.header.length >= 8 && this.header.readUInt32BE(0) === 1 ? 16 : 8;
      const count = Math.min(target - this.header.length, data.length - offset);
      this.header = Buffer.concat([this.header, data.subarray(offset, offset + count)]); offset += count;
      if (this.header.length < target || target === 8 && this.header.readUInt32BE(0) === 1) continue;
      const size = target === 16 ? Number(this.header.readBigUInt64BE(8)) : this.header.readUInt32BE(0), type = this.header.toString('latin1', 4, 8);
      if (!Number.isSafeInteger(size) || size < target || !/^[\x20-\x7e]{4}$/.test(type)) malformed('a box header is invalid');
      const first = !this.init.length && !this.movie;
      if (first && type !== 'ftyp') malformed('it does not start with ftyp');
      if (type === 'ftyp' && !first || type === 'moov' && (this.movie || !this.init.length)) malformed('its movie header is repeated or misplaced');
      if ((type === 'moof' || type === 'mdat') && !this.movie) malformed('media precedes the movie header');
      if (type === 'moof' && this.moof || type === 'mdat' && !this.moof) malformed('a fragment and its media are not paired');
      if (type !== 'mdat' && this.moof) malformed('a fragment is not followed by its media');
      let copy = false;
      if (type === 'ftyp' || type === 'moov') { this.initBytes += size; if (this.initBytes > MAX_LIVE_INIT_BYTES) malformed('its movie header is too large'); copy = true; }
      else if (type === 'moof') { if (size > MAX_LIVE_MOOF_BYTES) malformed('a fragment table is too large'); this.keep = this.retain(); copy = true; }
      else if (type === 'mdat') { if (this.moof!.length + size > MAX_LIVE_SEGMENT_BYTES) malformed('a fragment is too large'); copy = this.keep; }
      this.kind = type; this.collecting = copy ? [this.header] : undefined; this.remaining = size - target; this.header = Buffer.alloc(0);
      if (!this.remaining) this.finish();
    }
  }
}

/** Client-side check of one delivered segment: complete boxes of exactly the expected types.
 * It proves framing, not that a decoder accepts the video. */
export function liveSegmentValid(kind: 'init' | 'media', data: Buffer): boolean {
  try {
    const types = boxes(data, 0, data.length).map(b => b.type);
    return kind === 'init' ? types.length === 2 && types[0] === 'ftyp' && types[1] === 'moov' : types.length === 2 && types[0] === 'moof' && types[1] === 'mdat';
  } catch { return false; }
}
