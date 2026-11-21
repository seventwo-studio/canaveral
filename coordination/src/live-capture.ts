/** Runner half of live screen views: one shared native capture per device.
 *
 * Every viewer of a device is its own outbound broker session; this hub fans one capture out to
 * them. It adds no capture path: each run ("epoch") is the recording pipeline, `serveMobileVideo`,
 * with the hub in place of the recording's consumer, so the native source, the encoder arguments,
 * the authorization checks and the cleanup proof are those of a recording.
 *
 * - Capture runs only while a viewer with current authority is subscribed. The last viewer
 *   leaving, or losing authority, ends the epoch like a cancelled recording.
 * - An epoch lasts at most `LIVE_EPOCH_SECONDS` (Android screenrecord's own limit). While viewers
 *   remain, the next epoch starts and they receive a new initialization segment.
 * - One native capture per device at a time. A recording takes the device: the live epoch is
 *   stopped and proven stopped first, then the recording's own stream is also fed to the viewers.
 *   If that stop cannot be proven, the recording does not start.
 * - A failed epoch is never retried, and an epoch whose cleanup is unproven ends the capture as
 *   unknown: no receipt is sent, so the controller keeps its reservation.
 *
 * The runner journals a capture before its first attachment and before native dispatch, and
 * never resumes one after a restart. Fixture-covered only; see docs/mobile-control.md. */
import { ServiceError } from './errors.ts';
import { serveMobileVideo } from './mobile-video.ts';
import type { VideoOptions } from './mobile-video.ts';
import { LIVE_BIT_RATE, LIVE_EPOCH_SECONDS, LIVE_FPS, LiveSegmenter } from './mobile-live.ts';
import type { LiveHostEndReason, LiveItem } from './mobile-live.ts';
import type { NativePipe } from './providers/mobile.ts';
import type { SessionChannel } from './control/session-protocol.ts';

export interface LiveCaptureJob { id: string; generation: string; machineId: string }
export interface LiveCaptureSource {
  /** Absolute path of the operator-configured encoder. */
  encoder: string;
  openSource(options: VideoOptions, authorized: () => boolean): Promise<NativePipe>;
  openEncoder(argv: readonly string[]): Promise<NativePipe>;
  /** The native source is a recorder inside the device's own process (Android), so the device's
   * proven stop also proves the recorder gone. False for a host-process source (iOS idb). */
  guestSource: boolean;
}
export type LiveReceipt = { cleaned: true } | { hostCleaned: true };
export interface LiveHubOptions {
  load(captureId: string): Record<string, unknown> | undefined;
  save(captureId: string, value: Record<string, unknown>): void;
  /** Delivers the cleanup receipt. A failure is retried later from the saved journal. */
  report(job: LiveCaptureJob, receipt: LiveReceipt): Promise<void>;
  /** Test seam: the epoch length in seconds. */
  epochSeconds?: number;
}
export type LiveViewItem =
  | { type: 'init'; epoch: number; data: Buffer }
  | { type: 'segment'; epoch: number; sequence: number; keyframe: boolean; data: Buffer }
  | { type: 'end'; reason: LiveHostEndReason };
export interface LiveSubscription { next(timeoutMs: number): Promise<LiveViewItem | null>; close(): void }
export interface LiveCaptureHandle { subscribe(live: () => boolean): LiveSubscription; release(): void }
export interface RecordingTap { push(data: Uint8Array): void; end(cleaned: boolean): void }

/** Media a slow viewer may have queued before it is skipped ahead to the next key frame, and the
 * most recent group of pictures kept so a joining viewer starts with a picture. */
const VIEW_QUEUE_BYTES = 4 * 1_048_576, GOP_CACHE_BYTES = 8 * 1_048_576;
/** Three epochs in a row that end by themselves in under half their length (at most this long)
 * are a failing source, not a rollover. */
const SHORT_EPOCH_MS = 5000;
/** A recording waits this long for the device's live run to stop and be proven stopped. */
const SETTLE_MS = 30_000;
/** How long a device stays closed to recordings after its live capture ended without proof.
 * Longer than a recording admitted just before that can take to reach its capture. */
const UNPROVEN_MS = 90_000;
type Segment = Extract<LiveItem, { type: 'segment' }> & { data: Buffer };

/** One fragmented MP4 stream being split: its header and its latest group of pictures. */
class Feed {
  init: Buffer | undefined;
  gop: Segment[] = [];
  private gopBytes = 0;
  private failed = false;
  listener: ((item: LiveItem) => void) | undefined;
  wanted: () => boolean = () => false;
  private readonly segmenter = new LiveSegmenter(item => this.accept(item), () => this.wanted());
  push(data: Uint8Array): void {
    if (this.failed) throw new ServiceError('Live stream segmentation failed.', 409);
    try { this.segmenter.push(data); } catch (error) { this.failed = true; throw error; }
  }
  private accept(item: LiveItem): void {
    if (item.type === 'init') this.init = item.data;
    else {
      if (item.keyframe) { this.gop = []; this.gopBytes = 0; }
      // The cache is one unbroken run from a key frame; a dropped or oversized fragment voids it.
      if (item.data && (item.keyframe || this.gop.length) && this.gopBytes + item.data.length <= GOP_CACHE_BYTES) { this.gop.push(item as Segment); this.gopBytes += item.data.length; }
      else { this.gop = []; this.gopBytes = 0; }
    }
    this.listener?.(item);
  }
}

class Subscription implements LiveSubscription {
  private queue: LiveViewItem[] = [];
  private bytes = 0;
  private wake: (() => void) | undefined;
  private needKey = true;
  private epoch = -1;
  closed = false;
  constructor(private readonly capture: Capture, readonly live: () => boolean) {}
  private add(item: LiveViewItem): void { this.queue.push(item); this.wake?.(); }
  begin(epoch: number, init: Buffer, gop: readonly Segment[]): void {
    this.epoch = epoch; this.needKey = true; this.add({ type: 'init', epoch, data: init });
    for (const segment of gop) this.media(epoch, segment);
  }
  media(epoch: number, item: Extract<LiveItem, { type: 'segment' }>): void {
    if (epoch !== this.epoch) return;
    // After any gap, playback resumes only on a key frame.
    if (!item.data) { this.needKey = true; return; }
    if (this.needKey && !item.keyframe) return;
    if (this.bytes + item.data.length > VIEW_QUEUE_BYTES) {
      // A viewer that cannot keep up stays live: drop its backlog and continue at a key frame.
      this.queue = this.queue.filter(queued => queued.type !== 'segment'); this.bytes = 0;
      if (!item.keyframe) { this.needKey = true; return; }
    }
    this.needKey = false; this.bytes += item.data.length;
    this.add({ type: 'segment', epoch, sequence: item.sequence, keyframe: item.keyframe, data: item.data });
  }
  finish(reason: LiveHostEndReason): void { this.add({ type: 'end', reason }); }
  async next(timeoutMs: number): Promise<LiveViewItem | null> {
    if (!this.queue.length && !this.closed) await new Promise<void>(resolve => {
      const timer = setTimeout(() => { this.wake = undefined; resolve(); }, timeoutMs);
      this.wake = () => { clearTimeout(timer); this.wake = undefined; resolve(); };
    });
    const item = this.queue.shift();
    if (item?.type === 'segment') this.bytes -= item.data.length;
    return item ?? null;
  }
  close(): void { if (!this.closed) { this.closed = true; this.wake?.(); this.capture.unsubscribe(this); } }
}

class Capture {
  refs = 0;
  closing = false;
  ended: LiveHostEndReason | undefined;
  /** A native epoch ended without positive cleanup proof. */
  unknown = false;
  private readonly subscribers = new Set<Subscription>();
  private epoch = -1;
  private feed: Feed | undefined;
  private nativeStarted = false;
  private encodersExited = true;
  private running: Promise<void> | undefined;
  /** A failed epoch: no further epoch starts while its viewers are being told. */
  private halted = false;
  private waiters: (() => void)[] = [];
  readonly done: Promise<void>;
  constructor(private readonly hub: LiveCaptureHub, readonly job: LiveCaptureJob, private readonly source: LiveCaptureSource | undefined) {
    // A capture that cannot even end in order (its journal cannot be written) reports nothing,
    // so its reservation is retained; it must still leave the hub and tell its viewers.
    this.done = this.drive().catch(() => { this.finish('capture_failed'); }).finally(() => this.hub.forget(this));
  }
  poke(): void { for (const wake of this.waiters.splice(0)) wake(); }
  /** Conditions such as a viewer's authority change without notice, so waits are also timed. */
  private wait(): Promise<void> { return new Promise(resolve => { const timer = setTimeout(resolve, 250); this.waiters.push(() => { clearTimeout(timer); resolve(); }); }); }
  /** Resolves once no native epoch of this capture is running. */
  async settled(): Promise<void> { while (this.running) await this.running; }
  private wanted(): boolean {
    return !this.closing && !this.ended && !this.halted && !!this.source && !this.hub.recording(this.job.machineId) && [...this.subscribers].some(s => !s.closed && s.live());
  }
  private attach(feed: Feed): void {
    this.detach(); this.feed = feed; this.epoch++;
    feed.wanted = () => this.subscribers.size > 0;
    feed.listener = item => {
      if (item.type === 'init') for (const s of this.subscribers) s.begin(this.epoch, item.data, []);
      else for (const s of this.subscribers) s.media(this.epoch, item);
    };
    if (feed.init) for (const s of this.subscribers) s.begin(this.epoch, feed.init, feed.gop);
  }
  detach(feed?: Feed): void {
    if (!this.feed || feed && this.feed !== feed) return;
    this.feed.listener = undefined; this.feed.wanted = () => false; this.feed = undefined;
  }
  subscribe(live: () => boolean): LiveSubscription {
    const s = new Subscription(this, live); this.subscribers.add(s);
    if (this.ended) s.finish(this.ended);
    else if (this.feed?.init) s.begin(this.epoch, this.feed.init, this.feed.gop);
    this.poke(); return s;
  }
  unsubscribe(s: Subscription): void { this.subscribers.delete(s); this.poke(); }
  release(): void { if (--this.refs <= 0) { this.closing = true; this.poke(); } }
  finish(reason: LiveHostEndReason): void {
    if (this.ended) return;
    this.ended = reason; this.detach();
    for (const s of this.subscribers) s.finish(reason);
    this.poke();
  }
  /** Ends the capture after a failed epoch. A device's native side can stop a moment before
   * this runner observes the same ending (a lease deadline is also enforced natively), so the
   * viewers' own authority is given a second to lapse first: a viewer whose lease just ended then
   * learns that from the controller instead of being told its capture failed. */
  private async fail(): Promise<void> {
    this.halted = true;
    for (let i = 0; i < 4 && [...this.subscribers].some(s => !s.closed && s.live()); i++) await new Promise(resolve => setTimeout(resolve, 250));
    this.finish('capture_failed');
  }
  /** One run of the recording pipeline whose consumer is this capture's viewers. */
  private async runEpoch(source: LiveCaptureSource): Promise<{ cleaned: boolean; natural: boolean }> {
    const feed = new Feed(), options: VideoOptions = { fps: LIVE_FPS, durationSeconds: this.hub.options.epochSeconds ?? LIVE_EPOCH_SECONDS, bitRate: LIVE_BIT_RATE };
    let finished = false, cleaned = false, natural = false, encoderExited = true;
    // The hub stands where a recording's consumer would: it takes the bytes, never sends input,
    // and acknowledges the finish receipt of an epoch that ran to its own end.
    const channel: SessionChannel = {
      receive: async () => finished ? { type: 'ack' } : null,
      sendControl: async value => { if (value.type === 'finish') finished = true; },
      sendBytes: async data => { feed.push(data); },
      close: () => {},
    };
    const authorized = () => this.wanted();
    // Journal before native dispatch. Without a durable journal nothing is dispatched.
    if (!this.nativeStarted) {
      try { this.hub.journal(this.job, { state: 'started' }); } catch { return { cleaned: true, natural: false }; }
      this.nativeStarted = true;
    }
    this.attach(feed);
    try {
      const pipe = await source.openSource(options, authorized);
      await serveMobileVideo(channel, pipe, argv => source.openEncoder(argv), source.encoder, options, authorized, (positive, parts) => { cleaned = positive; encoderExited = parts.encoder; });
      cleaned = true; natural = true;
    } catch { /* The cleanup callback decided; a source that never opened stays unproven, as for recordings. */ }
    this.detach(feed);
    if (!encoderExited) this.encodersExited = false;
    return { cleaned, natural };
  }
  private async drive(): Promise<void> {
    await Promise.resolve();
    let short = 0;
    while (!this.closing) {
      const recording = this.hub.recording(this.job.machineId);
      if (this.ended || !this.source) { await this.wait(); continue; }
      // During a recording the device's one native capture is the recording's: follow its stream.
      if (recording) { if (this.feed !== recording) this.attach(recording); await this.wait(); continue; }
      if (!this.wanted()) { await this.wait(); continue; }
      const started = performance.now(), brief = Math.min(SHORT_EPOCH_MS, (this.hub.options.epochSeconds ?? LIVE_EPOCH_SECONDS) * 500);
      let release!: () => void;
      this.running = new Promise<void>(resolve => { release = resolve; });
      let outcome: { cleaned: boolean; natural: boolean };
      try { outcome = await this.runEpoch(this.source); } finally { this.running = undefined; release(); }
      if (!outcome.cleaned) { this.unknown = true; this.hub.unproven(this.job.machineId); await this.fail(); }
      // An epoch that stopped while its viewers still held authority failed; it is not retried.
      else if (!outcome.natural && this.wanted()) await this.fail();
      else if (outcome.natural) { short = performance.now() - started < brief ? short + 1 : 0; if (short >= 3) this.finish('capture_failed'); }
    }
    this.detach();
    for (const s of this.subscribers) s.finish(this.ended ?? 'capture_ended');
    // Nothing native was dispatched, or every epoch was proven clean: positive cleanup. Otherwise a
    // confirmed encoder exit may be reported for a guest recorder; anything else stays unknown.
    const receipt: LiveReceipt | undefined = !this.nativeStarted || !this.unknown ? { cleaned: true } : this.encodersExited && this.source?.guestSource ? { hostCleaned: true } : undefined;
    this.hub.journal(this.job, { state: receipt && 'cleaned' in receipt ? 'finished' : 'unknown', cleaned: !!receipt && 'cleaned' in receipt, ...(receipt && 'hostCleaned' in receipt ? { hostCleaned: true } : {}) });
    this.hub.forget(this);
    if (receipt) await this.hub.options.report(this.job, receipt).catch(() => {});
  }
}

export class LiveCaptureHub {
  private readonly captures = new Map<string, Capture>();
  private readonly recordings = new Map<string, Feed>();
  private readonly unprovenUntil = new Map<string, number>();
  private closed = false;
  constructor(readonly options: LiveHubOptions) {}
  recording(machineId: string): Feed | undefined { return this.recordings.get(machineId); }
  unproven(machineId: string): void { this.unprovenUntil.set(machineId, performance.now() + UNPROVEN_MS); }
  journal(job: LiveCaptureJob, state: Record<string, unknown>): void { this.options.save(job.id, { generation: job.generation, machineId: job.machineId, ...state }); }
  forget(capture: Capture): void { if (this.captures.get(capture.job.machineId) === capture) this.captures.delete(capture.job.machineId); }
  /** True while this process holds the capture; its saved journal then describes live work. */
  active(captureId: string): boolean { return [...this.captures.values()].some(c => c.job.id === captureId); }
  get idle(): boolean { return this.captures.size === 0; }
  /** Joins the device's capture or journals a new one. `source` is undefined when this host
   * cannot capture: the viewer is told so and the capture is reported clean without running. */
  acquire(job: LiveCaptureJob, source: LiveCaptureSource | undefined): LiveCaptureHandle {
    if (this.closed) throw new ServiceError('This runner is stopping.', 409);
    let capture = this.captures.get(job.machineId);
    if (capture) {
      if (capture.job.id !== job.id || capture.job.generation !== job.generation || capture.closing) throw new ServiceError('The device\'s live capture is ending.', 409);
    } else {
      // A journal from an earlier attempt, in this process or before a restart, is never reused.
      if (this.options.load(job.id)) throw new ServiceError('This live capture was already attempted; it is never repeated.', 409);
      this.journal(job, { state: 'attaching' });
      capture = new Capture(this, job, source); this.captures.set(job.machineId, capture);
    }
    const held = capture; held.refs++;
    let released = false;
    return { subscribe: live => held.subscribe(live), release: () => { if (!released) { released = true; held.release(); } } };
  }
  /** Called by a recording before it opens its native source. Stops the device's live epoch and
   * requires proof that it stopped; the returned tap then feeds the recording's stream to viewers.
   * It never changes what the recording receives. */
  async beginRecording(machineId: string): Promise<RecordingTap> {
    const refusal = () => new ServiceError('A capture of this device has not been proven stopped.', 409, { outcome: 'unknown' });
    if (this.recordings.has(machineId) || (this.unprovenUntil.get(machineId) ?? 0) > performance.now()) throw refusal();
    const feed = new Feed(), capture = this.captures.get(machineId);
    this.recordings.set(machineId, feed);
    if (capture) {
      capture.poke();
      // The stop is bounded by the native source's own cleanup; a source that never returns is unproven.
      const stopped = await Promise.race([capture.settled().then(() => true), new Promise<boolean>(resolve => setTimeout(() => resolve(false), SETTLE_MS))]);
      if (!stopped || capture.unknown) { this.recordings.delete(machineId); capture.poke(); throw refusal(); }
    }
    let ended = false;
    return {
      // A stream the segmenter refuses ends the tee for the viewers, never the recording.
      push: data => { if (!ended) try { feed.push(data); } catch { /* viewers simply receive no more of this stream */ } },
      end: cleaned => {
        if (ended) return; ended = true;
        if (this.recordings.get(machineId) === feed) this.recordings.delete(machineId);
        const current = this.captures.get(machineId);
        current?.detach(feed);
        // A recording whose stop is unproven leaves the device without a provable capture state.
        if (!cleaned) { this.unproven(machineId); current?.finish('capture_unavailable'); }
        current?.poke();
      },
    };
  }
  async close(): Promise<void> {
    this.closed = true;
    const captures = [...this.captures.values()];
    for (const capture of captures) { capture.closing = true; capture.poke(); }
    await Promise.race([Promise.all(captures.map(c => c.done)), new Promise(resolve => setTimeout(resolve, 15000))]);
  }
}
