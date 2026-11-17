/** Native H.264 capture to a bounded, outbound fragmented MP4 stream. */
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ServiceError } from './errors.ts';
import type { NativePipe } from './providers/mobile.ts';
import type { SessionChannel } from './control/session-protocol.ts';

export interface VideoOptions { fps: number; durationSeconds: number; bitRate: number }
export const MAX_VIDEO_BYTES = 512 * 1024 * 1024;
export function validateVideoOptions(value: VideoOptions): VideoOptions {
  if (value.fps !== 30 || !Number.isSafeInteger(value.durationSeconds) || value.durationSeconds < 1 || value.durationSeconds > 180 ||
      !Number.isSafeInteger(value.bitRate) || value.bitRate < 100000 || value.bitRate > 20000000) throw new ServiceError('Video requires 30 fps, 1–180 seconds and 100000–20000000 bits per second.', 400);
  return { fps: 30, durationSeconds: value.durationSeconds, bitRate: value.bitRate };
}
export function videoEncoderArguments(ffmpeg: string, value: VideoOptions): string[] {
  const options = validateVideoOptions(value);
  if (!path.isAbsolute(ffmpeg) || ffmpeg.includes('\0')) throw new ServiceError('Configure an absolute ffmpeg executable path before requesting video.', 400);
  return [ffmpeg, '-hide_banner', '-loglevel', 'error', '-nostdin', '-threads', '1', '-filter_threads', '1', '-use_wallclock_as_timestamps', '1', '-fflags', '+genpts',
    '-probesize', '65536', '-analyzeduration', '1000000', '-f', 'h264', '-i', 'pipe:0', '-map', '0:v:0', '-an',
    '-vf', 'fps=30,scale=w=min(1280\\,iw):h=min(1280\\,ih):force_original_aspect_ratio=decrease:force_divisible_by=2', '-c:v', 'libx264', '-threads', '1', '-preset', 'ultrafast', '-tune', 'zerolatency',
    '-profile:v', 'baseline', '-pix_fmt', 'yuv420p', '-b:v', String(options.bitRate), '-maxrate', String(options.bitRate), '-bufsize', String(options.bitRate),
    '-g', '30', '-keyint_min', '30', '-sc_threshold', '0', '-movflags', '+frag_keyframe+empty_moov+default_base_moof',
    '-frag_duration', '250000', '-flush_packets', '1', '-f', 'mp4', 'pipe:1'];
}

/** Checks the streamed MP4 box envelope without buffering box bodies or decoding video. */
export class Mp4Envelope {
  private header = Buffer.alloc(0);
  private remaining = 0;
  private boxes = 0;
  private movie = false;
  private fragment = false;
  private media = false;
  push(data: Uint8Array): void {
    let offset = 0;
    while (offset < data.length) {
      if (this.remaining) { const count = Math.min(this.remaining, data.length - offset); this.remaining -= count; offset += count; continue; }
      const target = this.header.length >= 8 && this.header.readUInt32BE(0) === 1 ? 16 : 8;
      const count = Math.min(target - this.header.length, data.length - offset);
      this.header = Buffer.concat([this.header, data.subarray(offset, offset + count)]); offset += count;
      if (this.header.length < target) continue;
      if (target === 8 && this.header.readUInt32BE(0) === 1) continue;
      const size = target === 16 ? Number(this.header.readBigUInt64BE(8)) : this.header.readUInt32BE(0), type = this.header.toString('ascii', 4, 8);
      if (!Number.isSafeInteger(size) || size < target || size > MAX_VIDEO_BYTES || !/^[A-Za-z0-9 ]{4}$/.test(type) || (!this.boxes && type !== 'ftyp')) throw new ServiceError('Video did not contain a bounded MP4 stream.', 409);
      if (type === 'moov') this.movie = true;
      if (type === 'moof') { if (!this.movie) throw new ServiceError('MP4 fragment preceded initialization.', 409); this.fragment = true; }
      if (type === 'mdat') { if (!this.fragment) throw new ServiceError('MP4 media preceded a fragment.', 409); this.media = true; }
      this.boxes++; this.remaining = size - target; this.header = Buffer.alloc(0);
    }
  }
  complete(): boolean { return this.boxes > 0 && this.movie && this.fragment && this.media && !this.remaining && !this.header.length; }
}

/** Source and encoder are owned by this attempt. No native process or input is replayed. */
export async function serveMobileVideo(channel: SessionChannel, source: NativePipe,
  openEncoder: (argv: readonly string[]) => Promise<NativePipe>, ffmpeg: string, value: VideoOptions,
  authorized: () => boolean, onCleanup?: (cleaned: boolean) => void): Promise<void> {
  let encoder: NativePipe | undefined, timer: ReturnType<typeof setTimeout> | undefined, watch: ReturnType<typeof setInterval> | undefined;
  let sourceClosing: Promise<void> | undefined, pumping: Promise<void> | undefined;
  const closeSource = () => sourceClosing ??= source.close();
  const check = () => { if (!authorized()) throw new ServiceError('Video authorization ended.', 410); };
  let rejectFailure!: (error: unknown) => void;
  const failure = new Promise<never>((_resolve, reject) => { rejectFailure = reject; }); void failure.catch(() => {});
  try {
    check(); const options = validateVideoOptions(value); encoder = await openEncoder(videoEncoderArguments(ffmpeg, options)); check();
    const pipe = encoder;
    watch = setInterval(() => { try { check(); } catch (error) { rejectFailure(error); void closeSource().catch(() => {}); void pipe.close().catch(() => {}); } }, 250);
    // Native sources own normal finite termination. Allow their trailer/exit grace;
    // forceful deadline cleanup never produces a successful recording receipt.
    timer = setTimeout(() => { rejectFailure(new ServiceError('Native video exceeded its duration and exit grace.', 409)); void closeSource().catch(() => {}); void pipe.close().catch(() => {}); }, (options.durationSeconds + 10) * 1000);
    pumping = (async () => {
      try {
        for (;;) {
          check(); const data = await source.read(65536, 30000);
          check(); if (!data.length) break;
          if (data.length > 65536) throw new ServiceError('Native video exceeded its chunk bound.', 409);
          for (let offset = 0; offset < data.length;) {
            check(); const count = await pipe.write(data.subarray(offset), 30000);
            if (!Number.isSafeInteger(count) || count < 1 || count > data.length - offset) throw new ServiceError('Video encoder input was interrupted.', 409);
            offset += count;
          }
        }
        if (await source.wait(5000) !== 0) throw new ServiceError('Native video capture did not finish successfully.', 409);
        await closeSource(); check(); await pipe.end();
      } catch (error) { rejectFailure(error); throw error; }
    })(); void pumping.catch(() => {});
    await channel.sendControl({ type: 'video', mediaType: 'video/mp4', codec: 'avc1', fps: 30 });
    const hash = createHash('sha256'), envelope = new Mp4Envelope(); let bytes = 0;
    for (;;) {
      check(); const data = await Promise.race([pipe.read(65536, 30000), failure]); check();
      if (!data.length) break;
      if (data.length > 65536 || bytes + data.length > MAX_VIDEO_BYTES) throw new ServiceError('Video exceeded its output budget.', 413);
      envelope.push(data); hash.update(data); bytes += data.length;
      await Promise.race([channel.sendBytes(data), failure]); check();
    }
    await Promise.race([pumping, failure]);
    if (await pipe.wait(5000) !== 0 || !envelope.complete()) throw new ServiceError('Video encoder did not complete an MP4 stream.', 409);
    await pipe.close(); check();
    await channel.sendControl({ type: 'finish', bytes, sha256: hash.digest('hex'), cleaned: true });
    const ack = await channel.receive(30); check();
    if (!ack || ack instanceof Uint8Array || Object.keys(ack).join(',') !== 'type' || ack.type !== 'ack') throw new ServiceError('Video completion was not acknowledged.', 409);
  } finally {
    if (timer) clearTimeout(timer); if (watch) clearInterval(watch);
    const results = await Promise.allSettled([closeSource(), ...(encoder ? [(async () => { await encoder.close(); const code = await encoder.wait(5000); if (!Number.isInteger(code)) throw new Error('Encoder exit is unconfirmed.'); })()] : [])]);
    if (pumping) await pumping.catch(() => {});
    const cleaned = results.every(result => result.status === 'fulfilled'); onCleanup?.(cleaned);
    if (!cleaned) throw new ServiceError('Video process cleanup is unconfirmed.', 409, { outcome: 'unknown' });
  }
}
