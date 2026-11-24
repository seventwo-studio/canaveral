/** Native-video clients. MP4 bytes are streamed unchanged to consumers. MobileVideoClient records
 * an owned machine with an account or operator credential; LeaseVideoClient records a leased
 * emulator with that lease's current key. Both share one session protocol and verification.
 * MachineLiveClient and LeaseLiveClient watch the same devices live, under the same credentials. */
import { createHash } from 'node:crypto';
import { ConsumerConfigurationError, ConsumerServiceError, Transport } from './consumer-client.ts';
import type { ClientOptions, LeaseClientOptions } from './consumer-client.ts';
import { checked, identifier, interrupted, record, SessionConnection, SessionError, timeout } from './sdk.ts';
import type { SessionChannel, Writer } from './sdk.ts';
import { MAX_VIDEO_BYTES, Mp4Envelope, validateVideoOptions } from './mobile-video.ts';
import type { VideoOptions } from './mobile-video.ts';
export type { VideoOptions } from './mobile-video.ts';
import { LIVE_HOST_END_REASONS, LIVE_VIEW_MIN_SECONDS, LIVE_VIEW_SECONDS, MAX_LIVE_INIT_BYTES, MAX_LIVE_SEGMENT_BYTES, liveSegmentValid } from './mobile-live.ts';
export interface VideoSession extends VideoOptions {
  id: string; machineId: string; generation: string; capability: 'video'; protocol: 'canaveral-session-v1'; state: string;
  attachBefore: string; authorizationDeadline: string;
  /** Positive native cleanup was recorded; the session no longer holds its reservation. */
  cleaned?: boolean;
  /** Lease sessions only. */
  leaseId?: string; member?: string; hostCleaned?: boolean;
}
export interface VideoReceiveOptions { timeoutMs?: number; maxBytes?: number; signal?: AbortSignal }
export interface VideoFinish { type: 'finish'; bytes: number; sha256: string; cleaned: true }
function receiveOptions(value: VideoReceiveOptions): void {
  timeout(value.timeoutMs ?? 30000);
  if (!Number.isSafeInteger(value.maxBytes ?? MAX_VIDEO_BYTES) || (value.maxBytes ?? MAX_VIDEO_BYTES) < 1 || (value.maxBytes ?? MAX_VIDEO_BYTES) > MAX_VIDEO_BYTES || value.signal !== undefined && !(value.signal instanceof AbortSignal)) throw new ConsumerConfigurationError('Choose a video byte budget up to 512 MiB and an AbortSignal.');
}
function session(value: unknown): VideoSession {
  if (!record(value)) throw new ConsumerConfigurationError('Invalid video session.');
  identifier(value.id); identifier(value.machineId); identifier(value.generation);
  try { validateVideoOptions(value as unknown as VideoOptions); } catch { throw new ConsumerConfigurationError('Invalid video options.'); }
  if (value.capability !== 'video' || value.protocol !== 'canaveral-session-v1' || !['pending','attaching','ready','disconnected','finished'].includes(String(value.state)) ||
      typeof value.attachBefore !== 'string' || !Number.isFinite(Date.parse(value.attachBefore)) || typeof value.authorizationDeadline !== 'string' || !Number.isFinite(Date.parse(value.authorizationDeadline))) throw new ConsumerConfigurationError('Invalid video session metadata.');
  return value as unknown as VideoSession;
}
/** A failure of the session connection itself: it ended, was reset or could not be written. A
 * worker's error control is not one; `checked` throws that from a received message. */
const transportFailure = (error: unknown): boolean => error instanceof SessionError && ['session_disconnected', 'session_incomplete'].includes(error.code);
function bounded<T>(work: () => Promise<T>, options: VideoReceiveOptions, close: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => { if (timer) clearTimeout(timer); options.signal?.removeEventListener('abort', abort); };
    const abort = () => { cleanup(); close(); reject(new SessionError('Video was cancelled; recording completion is unconfirmed.', 'video_incomplete')); };
    if (options.signal?.aborted) { abort(); return; }
    timer = setTimeout(() => { cleanup(); close(); reject(new SessionError('Video operation timed out; recording completion is unconfirmed.', 'video_incomplete')); }, options.timeoutMs ?? 30000);
    options.signal?.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => { if (options.signal?.aborted) throw new SessionError('Video was cancelled.', 'video_incomplete'); return work(); }).then(resolve, reject).finally(cleanup);
  });
}
export class VideoClient {
  readonly mediaType = 'video/mp4' as const;
  readonly codec = 'avc1' as const;
  readonly fps = 30;
  finish: VideoFinish | undefined;
  private used = false;
  /** `inspect` reads the session's controller record. Without it, a connection reset after the
   * acknowledgement cannot be confirmed and the recording is reported incomplete. */
  private constructor(readonly connection: SessionChannel, readonly options: VideoReceiveOptions, private readonly inspect?: () => Promise<VideoSession>) {}
  static async connect(connection: SessionChannel, options: VideoReceiveOptions = {}, inspect?: () => Promise<VideoSession>): Promise<VideoClient> {
    receiveOptions(options); const self = new VideoClient(connection, options, inspect);
    try {
      const value = checked(await bounded(() => connection.receive(options.timeoutMs ?? 30000), options, () => self.close()), connection.sessionId);
      if (!record(value) || Object.keys(value).sort().join(',') !== 'codec,fps,mediaType,type' || value.type !== 'video' || value.mediaType !== 'video/mp4' || value.codec !== 'avc1' || value.fps !== 30) throw new SessionError('Native MP4 video metadata was not confirmed.');
      return self;
    } catch (error) { self.close(); throw interrupted(error, connection.sessionId); }
  }
  close(): void { this.connection.close(); }
  /** Reads the controller's record until it shows the session finished with positive cleanup,
   * for at most `timeoutMs`. */
  private async confirmed(): Promise<boolean> {
    if (!this.inspect) return false;
    const deadline = performance.now() + (this.options.timeoutMs ?? 30000);
    while (!this.options.signal?.aborted) {
      try { const current = await this.inspect(); if (current.state === 'finished' && current.cleaned === true) return true; }
      catch (error) { if (!(error instanceof ConsumerServiceError)) return false; }
      if (performance.now() >= deadline) return false;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    return false;
  }
  /** Chunks are arbitrary MP4 byte boundaries, not video frames or complete MP4 boxes. */
  async *chunks(): AsyncGenerator<Buffer, VideoFinish, unknown> {
    if (this.used) throw new ConsumerConfigurationError('A video stream can only be consumed once.'); this.used = true;
    const hash = createHash('sha256'), envelope = new Mp4Envelope(); let bytes = 0;
    try {
      for (;;) {
        const value = checked(await bounded(() => this.connection.receive(this.options.timeoutMs ?? 30000), this.options, () => this.close()), this.connection.sessionId);
        if (Buffer.isBuffer(value)) {
          if (!value.length || value.length > 65536 || bytes + value.length > (this.options.maxBytes ?? MAX_VIDEO_BYTES)) throw new SessionError('Video exceeds its byte envelope.', 'video_incomplete');
          envelope.push(value); hash.update(value); bytes += value.length; yield value; continue;
        }
        if (!record(value) || Object.keys(value).sort().join(',') !== 'bytes,cleaned,sha256,type' || value.type !== 'finish' || value.bytes !== bytes || !bytes || value.cleaned !== true ||
            typeof value.sha256 !== 'string' || value.sha256 !== hash.digest('hex') || !envelope.complete()) throw new SessionError('MP4 content, cleanup or completion was not verified.', 'video_incomplete');
        await bounded(() => this.connection.sendControl({ type: 'ack' }), this.options, () => this.close());
        // Keep the consumer socket attached until the host has received its ACK.
        // Immediate local close could make the broker discard that pending control.
        try {
          const ended = await bounded(() => this.connection.receive(this.options.timeoutMs ?? 30000), this.options, () => this.close());
          if (ended !== null) throw new SessionError('Unexpected data after completed video.', 'video_incomplete');
        } catch (error) {
          if (!(error instanceof SessionError) || error.code !== 'session_disconnected') {
            // A reset is no evidence that the host received the ACK: a heartbeat pong crossing the
            // broker's close draws one, and so does a connection lost before the ACK was relayed.
            // Only the controller's record of the finished, cleaned session completes it then.
            if (!transportFailure(error)) throw error;
            if (!await this.confirmed()) throw new SessionError('The connection was reset after the acknowledgement and the controller has not recorded the recording finished; completion is unconfirmed.', 'video_incomplete');
          }
        }
        this.finish = value as unknown as VideoFinish; return this.finish;
      }
    } catch (error) { throw interrupted(error, this.connection.sessionId); }
    finally { this.close(); }
  }
  async record(writer: Writer): Promise<VideoFinish> {
    if (!writer || typeof writer.write !== 'function') throw new ConsumerConfigurationError('Provide a streaming video writer.');
    try {
      for await (const chunk of this.chunks()) {
        for (let offset = 0; offset < chunk.length;) {
          const count = await bounded(() => Promise.resolve(writer.write(chunk.subarray(offset))), this.options, () => this.close());
          if (!Number.isSafeInteger(count) || count < 1 || count > chunk.length - offset) throw new SessionError('Video writer returned an invalid byte count.', 'video_incomplete');
          offset += count;
        }
      }
      if (!this.finish) throw new SessionError('Video recording is incomplete.', 'video_incomplete'); return this.finish;
    } catch (error) { this.close(); throw interrupted(error, this.connection.sessionId); }
  }
}
function options(request: VideoOptions): VideoOptions { try { return validateVideoOptions(request); } catch { throw new ConsumerConfigurationError('Invalid video options.'); } }
function sameRequest(result: VideoSession, id: string, value: VideoOptions): void {
  if (result.id !== id || result.fps !== value.fps || result.durationSeconds !== value.durationSeconds || result.bitRate !== value.bitRate) throw new SessionError('Video session differs from its persisted request.', 'video_incomplete', id);
}
/** Session attachment and MP4 verification shared by both credentials. */
abstract class VideoSessions {
  readonly transport: Transport;
  constructor(transport: Transport) { this.transport = transport; }
  protected abstract attachPath(session: VideoSession): string;
  /** The session's controller record, read with this client's credential. */
  protected abstract sessionRecord(session: VideoSession): Promise<VideoSession>;
  protected async call(method: 'GET' | 'POST', path: string, body: Record<string, unknown> | undefined, id: string, accepted = [200]): Promise<VideoSession> {
    return session((await this.transport.call(method, path, body, accepted, method === 'POST', id)).json);
  }
  async connect(value: VideoSession, options: VideoReceiveOptions = {}): Promise<VideoClient> {
    receiveOptions(options);
    if (options.signal?.aborted) throw new SessionError('Video was cancelled before attachment.', 'video_incomplete');
    const current = session(value), connection = await SessionConnection.connect(this.transport, this.attachPath(current), current.id);
    try {
      const ready = checked(await bounded(() => connection.receive(options.timeoutMs ?? 30000), options, () => connection.close()), current.id);
      if (!record(ready) || ready.type !== 'ready' || ready.sessionId !== current.id || ready.generation !== current.generation || ready.capability !== 'video') throw new SessionError('Native video peers did not become ready.', 'video_incomplete', current.id);
      return await VideoClient.connect(connection, options, () => this.sessionRecord(current));
    } catch (error) { connection.close(); throw interrupted(error, current.id); }
  }
}
export class MobileVideoClient extends VideoSessions {
  constructor(options: ClientOptions & { credential: string }) { super(new Transport(options, options.credential)); }
  protected attachPath(s: VideoSession): string { return `/v1/machines/${s.machineId}/video-sessions/${s.id}/${s.generation}`; }
  protected sessionRecord(s: VideoSession): Promise<VideoSession> { return this.inspect(s.machineId, s.id); }
  async create(machineId: string, request: VideoOptions & { id: string }): Promise<VideoSession> {
    const machine = identifier(machineId), id = identifier(request.id), value = options(request);
    const result = await this.call('POST', `/v1/machines/${machine}/video-sessions`, { id, ...value }, id, [200,201]);
    sameRequest(result, id, value); if (result.machineId !== machine) throw new SessionError('Video session differs from its persisted request.', 'video_incomplete', id); return result;
  }
  async inspect(machineId: string, sessionId: string): Promise<VideoSession> { return this.read('GET', machineId, sessionId); }
  async close(machineId: string, sessionId: string): Promise<VideoSession> { return this.read('POST', machineId, sessionId, '/close'); }
  private async read(method: 'GET' | 'POST', machineId: string, sessionId: string, suffix = ''): Promise<VideoSession> {
    const machine = identifier(machineId), id = identifier(sessionId), result = await this.call(method, `/v1/machines/${machine}/video-sessions/${id}${suffix}`, method === 'POST' ? {} : undefined, id);
    if (result.machineId !== machine || result.id !== id) throw new SessionError('Video receipt belongs to another session.', 'video_incomplete', id); return result;
  }
}
/** Lease-key recording of the lease's own member. The key cannot record another lease, and a
 * recording ends with the lease: expiry, release, a fence, supervisor loss or key rotation. */
export class LeaseVideoClient extends VideoSessions {
  readonly leaseId: string;
  constructor(options: LeaseClientOptions) { super(new Transport(options, options.leaseKey)); this.leaseId = identifier(options.leaseId); }
  protected attachPath(s: VideoSession): string { return `/v1/leases/${this.leaseId}/video-sessions/${s.id}/${s.generation}`; }
  protected sessionRecord(s: VideoSession): Promise<VideoSession> { return this.inspect(s.id); }
  private bound(result: VideoSession, id: string): VideoSession {
    if (result.id !== id || result.leaseId !== this.leaseId || typeof result.member !== 'string') throw new SessionError('Video receipt belongs to another session.', 'video_incomplete', id); return result;
  }
  /** Persist `id` and the request first; replaying the same body returns the same session. */
  async create(request: VideoOptions & { id: string; member: string }): Promise<VideoSession> {
    const id = identifier(request.id), value = options({ fps: request.fps, durationSeconds: request.durationSeconds, bitRate: request.bitRate });
    if (Object.keys(request).some(k => !['id','member','fps','durationSeconds','bitRate'].includes(k)) || typeof request.member !== 'string' || !request.member.trim() || [...request.member].length > 100) throw new ConsumerConfigurationError('Invalid lease video request.');
    const result = this.bound(await this.call('POST', `/v1/leases/${this.leaseId}/video-sessions`, { id, member: request.member, ...value }, id, [200,201]), id);
    sameRequest(result, id, value); if (result.member !== request.member) throw new SessionError('Video session differs from its persisted request.', 'video_incomplete', id); return result;
  }
  async inspect(sessionId: string): Promise<VideoSession> { const id = identifier(sessionId); return this.bound(await this.call('GET', `/v1/leases/${this.leaseId}/video-sessions/${id}`, undefined, id), id); }
  async close(sessionId: string): Promise<VideoSession> { const id = identifier(sessionId); return this.bound(await this.call('POST', `/v1/leases/${this.leaseId}/video-sessions/${id}/close`, {}, id), id); }
  /** Creates (or replays) the session, attaches and writes the verified MP4 to `writer`. The
   * returned finish is the host's positive receipt: byte count, SHA-256 and cleanup. */
  async record(request: VideoOptions & { id: string; member: string }, writer: Writer, receive: VideoReceiveOptions = {}): Promise<VideoFinish> {
    receiveOptions(receive);
    const created = await this.create(request);
    return (await this.connect(created, receive)).record(writer);
  }
}

/* Live screen views. A view streams the device's shared native capture as fragmented MP4
 * segments until it ends. It is not a recording: there is no finish receipt and no digest, and
 * what a viewer receives starts wherever it joined. See docs/visual-sdk.md. */
export interface LiveView {
  id: string; machineId: string; captureId: string; generation: string; capability: 'live'; protocol: 'canaveral-session-v1';
  state: 'pending' | 'attaching' | 'ready' | 'ended';
  /** Why the controller ended the view, once it has. */
  endReason?: string;
  mediaType: 'video/mp4'; codec: 'avc1'; fps: 30; bitRate: number; ttlSeconds: number; attachBefore: string; authorizationDeadline: string;
  /** Lease views only. */
  leaseId?: string; member?: string;
}
/** One complete MP4 segment. `init` (`ftyp` + `moov`) opens an epoch; each `media` segment is one
 * `moof` + `mdat`. Within an epoch `sequence` only increases, and after any gap the next media
 * segment starts on a key frame. Framing is checked; decoding is the caller's. */
export interface LiveSegment { kind: 'init' | 'media'; epoch: number; sequence: number; keyframe: boolean; data: Buffer }
/** Why a stream ended, and who said so: the capturing host in-band, the controller's record of
 * the view, or this client (it closed, was cancelled, or lost the controller). */
export interface LiveEnd {
  reason: string; source: 'host' | 'controller' | 'client';
  /** With `connection_lost`: the connection failure, when the controller named no cause. */
  error?: SessionError;
}
export interface LiveOptions {
  /** Bound for the handshake and each renewal reply. Not a limit on silence: Android emits no
   * frames while the screen is static. Default 30000. */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Renew the view while segments are being pulled (default true). A consumer that stops
   * pulling stops renewing, and its view then expires. Renewal never renews or extends a lease. */
  autoRenew?: boolean;
}
function liveOptions(value: LiveOptions): void {
  timeout(value.timeoutMs ?? 30000);
  if (value.signal !== undefined && !(value.signal instanceof AbortSignal) || value.autoRenew !== undefined && typeof value.autoRenew !== 'boolean') throw new ConsumerConfigurationError('Choose an AbortSignal and a boolean autoRenew.');
}
function liveView(value: unknown): LiveView {
  if (!record(value)) throw new ConsumerConfigurationError('Invalid live view.');
  identifier(value.id); identifier(value.machineId); identifier(value.captureId); identifier(value.generation);
  if (value.capability !== 'live' || value.protocol !== 'canaveral-session-v1' || !['pending', 'attaching', 'ready', 'ended'].includes(String(value.state)) ||
      value.mediaType !== 'video/mp4' || value.codec !== 'avc1' || value.fps !== 30 || !Number.isSafeInteger(value.bitRate) || !Number.isSafeInteger(value.ttlSeconds) || Number(value.ttlSeconds) < 1 ||
      typeof value.attachBefore !== 'string' || !Number.isFinite(Date.parse(value.attachBefore)) || typeof value.authorizationDeadline !== 'string' || !Number.isFinite(Date.parse(value.authorizationDeadline)) ||
      value.endReason !== undefined && typeof value.endReason !== 'string') throw new ConsumerConfigurationError('Invalid live view metadata.');
  return value as unknown as LiveView;
}
function ttl(value: unknown): Record<string, number> {
  if (value === undefined) return {};
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < LIVE_VIEW_MIN_SECONDS || value > LIVE_VIEW_SECONDS) throw new ConsumerConfigurationError('Choose a live view lifetime of 10 to 120 seconds.');
  return { ttlSeconds: value };
}
/** Controller findings that the view's own authority ended, as opposed to its capture. */
const DEVICE_ENDED = ['device_stopped', 'host_unavailable'];
const AUTHORITY_ENDED = ['lease_expired', 'lease_released', 'lease_failed', 'key_rotated', 'application_revoked', 'access_revoked', ...DEVICE_ENDED];
const count = (value: unknown, maximum: number, minimum = 0): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum;
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export class LiveStream {
  readonly mediaType = 'video/mp4' as const;
  readonly codec = 'avc1' as const;
  readonly fps = 30;
  /** Set once the stream has ended; also the return value of `segments()`. */
  ended: LiveEnd | undefined;
  /** The view's current deadline, as last reported by the controller. */
  authorizationDeadline: string;
  private used = false;
  private closedHere = false;
  private epoch = -1;
  private sequence = -1;
  private needKey = true;
  private renewed = performance.now();
  private awaitingRenewal: number | undefined;
  /** The connection itself failed, as opposed to a worker's error control. */
  private dropped = false;
  constructor(readonly connection: SessionChannel, readonly view: LiveView, private readonly options: LiveOptions, private readonly inspect: () => Promise<LiveView>) {
    this.authorizationDeadline = view.authorizationDeadline;
    options.signal?.addEventListener('abort', () => this.connection.close(), { once: true });
  }
  /** Ends this viewer's stream. The view's controller record is closed with the client's `close`. */
  close(): void { this.closedHere = true; this.connection.close(); }
  /** Asks the controller to extend the view; the new deadline arrives with the next message. */
  async renew(): Promise<void> { this.renewed = performance.now(); this.awaitingRenewal ??= this.renewed; await this.connection.sendControl({ type: 'renew' }); }
  /** The next message that is not a renewal reply. Waits without limit for video, in slices, so
   * renewal and a lost controller are still noticed while the screen is static. */
  private async message(): Promise<Buffer | Record<string, unknown>> {
    const limit = this.options.timeoutMs ?? 30000, cadence = this.view.ttlSeconds * 1000 / 3;
    for (;;) {
      // A renewal that cannot be written leaves the connection closed; the read below reports it.
      if (this.options.autoRenew !== false && performance.now() - this.renewed >= cadence) await this.renew().catch((error: unknown) => { if (!transportFailure(error)) throw error; });
      if (this.awaitingRenewal !== undefined && performance.now() - this.awaitingRenewal > limit) throw new SessionError('The controller did not answer a live view renewal.', 'session_disconnected', this.view.id);
      let received: Awaited<ReturnType<SessionChannel['receive']>>;
      try { received = await this.connection.receive(Math.min(1000, cadence)); }
      catch (error) { this.dropped ||= transportFailure(error); throw error; }
      const value = checked(received, this.view.id);
      if (value === null) continue;
      if (!Buffer.isBuffer(value) && value.type === 'renewal') {
        if (Object.keys(value).sort().join(',') !== 'authorizationDeadline,renewed,type' || typeof value.renewed !== 'boolean' || typeof value.authorizationDeadline !== 'string' || !Number.isFinite(Date.parse(value.authorizationDeadline))) throw new SessionError('Invalid live renewal reply.', 'session_protocol_error', this.view.id);
        this.authorizationDeadline = value.authorizationDeadline; this.awaitingRenewal = undefined; continue;
      }
      return value;
    }
  }
  private async body(bytes: number): Promise<Buffer> {
    const parts: Buffer[] = []; let received = 0;
    while (received < bytes) {
      const part = await this.message();
      if (!Buffer.isBuffer(part) || !part.length || part.length > 65536 || received + part.length > bytes) throw new SessionError('Live segment bytes did not match their header.', 'session_protocol_error', this.view.id);
      parts.push(part); received += part.length;
    }
    return Buffer.concat(parts, bytes);
  }
  /** After the sockets dropped without a word from the host: what the controller recorded. The
   * host enforces a lease deadline slightly before the controller observes it, so the record is
   * read for a few seconds until it names a cause. */
  private async resolve(host?: LiveEnd, dropped?: unknown): Promise<LiveEnd> {
    // Without a cause from the controller or the host, the end is this client's lost connection.
    const lost = (): LiveEnd => ({ reason: 'connection_lost', source: 'client', ...(dropped instanceof SessionError ? { error: dropped } : {}) });
    let device: string | undefined, disconnected = false;
    for (let attempt = 0; attempt < 12; attempt++) {
      try {
        const view = await this.inspect(), reason = view.state === 'ended' ? view.endReason : undefined;
        if (reason) {
          // A lease's device, and its capture, are stopped by its own fence a moment before the
          // lease is recorded as ended, so for a lease such a cause, like a bare disconnect, may
          // still be replaced.
          const provisional = reason === 'disconnected' || view.leaseId !== undefined && [...DEVICE_ENDED, 'capture_ended'].includes(reason);
          if (!provisional) return !host || AUTHORITY_ENDED.includes(reason) ? { reason, source: 'controller' } : host;
          // A host's explicit `capture_failed` is never replaced by the controller's plain record
          // that the capture ended.
          if (reason === 'disconnected') disconnected = true;
          else if (!(host && reason === 'capture_ended')) device = reason;
        }
      } catch (error) {
        // The credential that opened the view no longer reads it: rotated or revoked.
        if (error instanceof ConsumerServiceError && [401, 403].includes(error.status)) return { reason: 'credential_rejected', source: 'controller' };
        if (!(error instanceof ConsumerServiceError)) return host ?? lost();
      }
      await pause(250);
    }
    return device ? { reason: device, source: 'controller' } : host ?? (disconnected ? { reason: 'disconnected', source: 'controller' } : lost());
  }
  async *segments(): AsyncGenerator<LiveSegment, LiveEnd, unknown> {
    if (this.used) throw new ConsumerConfigurationError('A live stream can only be consumed once.'); this.used = true;
    const invalid = (detail: string): never => { throw new SessionError(`Invalid live stream: ${detail}.`, 'session_protocol_error', this.view.id); };
    try {
      for (;;) {
        const value = await this.message();
        if (Buffer.isBuffer(value)) return invalid('bytes without a segment header');
        const keys = Object.keys(value).sort().join(',');
        if (value.type === 'end') {
          if (keys !== 'reason,type' || !(LIVE_HOST_END_REASONS as readonly unknown[]).includes(value.reason)) invalid('unknown end');
          const host: LiveEnd = { reason: String(value.reason), source: 'host' };
          // A device's native side can stop a moment before its lease or device is recorded as
          // ended. A reported capture failure therefore yields to that cause, if there is one.
          return this.ended = value.reason === 'capture_failed' ? await this.resolve(host) : host;
        }
        if (value.type === 'init') {
          if (keys !== 'bytes,epoch,type' || !count(value.epoch, Number.MAX_SAFE_INTEGER) || !count(value.bytes, MAX_LIVE_INIT_BYTES, 16) || value.epoch <= this.epoch) invalid('initialization header');
          const data = await this.body(value.bytes as number);
          if (!liveSegmentValid('init', data)) invalid('initialization segment');
          this.epoch = value.epoch as number; this.sequence = -1; this.needKey = true;
          yield { kind: 'init', epoch: this.epoch, sequence: 0, keyframe: false, data };
        } else if (value.type === 'segment') {
          if (keys !== 'bytes,epoch,keyframe,sequence,type' || value.epoch !== this.epoch || !count(value.sequence, Number.MAX_SAFE_INTEGER) || typeof value.keyframe !== 'boolean' || !count(value.bytes, MAX_LIVE_SEGMENT_BYTES, 16)) invalid('media header');
          const sequence = value.sequence as number, keyframe = value.keyframe as boolean;
          // Playback can start, and resume after a gap, only on a key frame.
          if (sequence <= this.sequence || (this.needKey || sequence !== this.sequence + 1) && !keyframe) invalid('segment order');
          const data = await this.body(value.bytes as number);
          if (!liveSegmentValid('media', data)) invalid('media segment');
          this.sequence = sequence; this.needKey = false;
          yield { kind: 'media', epoch: this.epoch, sequence, keyframe, data };
        } else invalid('unknown control');
      }
    } catch (error) {
      if (this.closedHere || this.options.signal?.aborted) return this.ended = { reason: this.closedHere ? 'closed' : 'cancelled', source: 'client' };
      // The broker ends a view by closing its sockets. A pong or renewal that crosses that close
      // draws a reset instead of an orderly end, which the connection reports as a failure; either
      // way the view's record says why it ended.
      if (this.dropped || error instanceof SessionError && error.code === 'session_disconnected') return this.ended = await this.resolve(undefined, error);
      throw interrupted(error, this.view.id);
    } finally { this.connection.close(); }
  }
}
abstract class LiveViews {
  readonly transport: Transport;
  constructor(transport: Transport) { this.transport = transport; }
  protected abstract path(view: { machineId: string }): string;
  protected async call(method: 'GET' | 'POST', path: string, body: Record<string, unknown> | undefined, id: string, accepted = [200]): Promise<LiveView> {
    const value = liveView((await this.transport.call(method, path, body, accepted, method === 'POST', id)).json);
    if (value.id !== id) throw new SessionError('Live view receipt belongs to another view.', 'session_protocol_error', id);
    return value;
  }
  /** Attaches to a created view. The stream starts with an initialization segment once the
   * device's capture produces one. */
  async connect(value: LiveView, options: LiveOptions = {}): Promise<LiveStream> {
    liveOptions(options);
    if (options.signal?.aborted) throw new SessionError('Live view was cancelled before attachment.', 'session_incomplete');
    const current = liveView(value), base = `${this.path(current)}/${current.id}`, wait = { timeoutMs: options.timeoutMs ?? 30000, ...(options.signal ? { signal: options.signal } : {}) };
    const connection = await SessionConnection.connect(this.transport, `${base}/${current.generation}`, current.id);
    try {
      const ready = checked(await bounded(() => connection.receive(wait.timeoutMs), wait, () => connection.close()), current.id);
      if (!record(ready) || ready.type !== 'ready' || ready.sessionId !== current.id || ready.generation !== current.generation || ready.capability !== 'live') throw new SessionError('Live view peers did not become ready.', 'session_incomplete', current.id);
      const meta = checked(await bounded(() => connection.receive(wait.timeoutMs), wait, () => connection.close()), current.id);
      if (!record(meta) || Object.keys(meta).sort().join(',') !== 'codec,fps,mediaType,type' || meta.type !== 'live' || meta.mediaType !== 'video/mp4' || meta.codec !== 'avc1' || meta.fps !== 30) throw new SessionError('Live video metadata was not confirmed.', 'session_incomplete', current.id);
      return new LiveStream(connection, current, options, () => this.call('GET', base, undefined, current.id));
    } catch (error) { connection.close(); throw interrupted(error, current.id); }
  }
}
/** Live view of an account-owned device, for its owner or an administrator. Leased machines are
 * refused: a leased device is visible to its lease holder only, through `LeaseLiveClient`. */
export class MachineLiveClient extends LiveViews {
  constructor(options: ClientOptions & { credential: string }) { super(new Transport(options, options.credential)); }
  protected path(view: { machineId: string }): string { return `/v1/machines/${view.machineId}/live-views`; }
  /** Persist `id` first; replaying the same request returns the same view. */
  async create(machineId: string, request: { id: string; ttlSeconds?: number }): Promise<LiveView> {
    const machine = identifier(machineId), id = identifier(request.id);
    if (Object.keys(request).some(k => !['id', 'ttlSeconds'].includes(k))) throw new ConsumerConfigurationError('Invalid live view request.');
    const result = await this.call('POST', this.path({ machineId: machine }), { id, ...ttl(request.ttlSeconds) }, id, [200, 201]);
    if (result.machineId !== machine) throw new SessionError('Live view receipt belongs to another device.', 'session_protocol_error', id); return result;
  }
  async inspect(machineId: string, viewId: string): Promise<LiveView> { const id = identifier(viewId); return this.call('GET', `${this.path({ machineId: identifier(machineId) })}/${id}`, undefined, id); }
  async close(machineId: string, viewId: string): Promise<LiveView> { const id = identifier(viewId); return this.call('POST', `${this.path({ machineId: identifier(machineId) })}/${id}/close`, {}, id); }
  /** Creates (or replays) the view and attaches to it. */
  async watch(machineId: string, request: { id: string; ttlSeconds?: number }, options: LiveOptions = {}): Promise<LiveStream> { liveOptions(options); return this.connect(await this.create(machineId, request), options); }
}
/** Live view of a leased emulator with that lease's current key. The view ends with the lease:
 * expiry, release, failure, a fence, supervisor loss or key rotation. */
export class LeaseLiveClient extends LiveViews {
  readonly leaseId: string;
  constructor(options: LeaseClientOptions) { super(new Transport(options, options.leaseKey)); this.leaseId = identifier(options.leaseId); }
  protected path(): string { return `/v1/leases/${this.leaseId}/live-views`; }
  private bound(result: LiveView): LiveView {
    if (result.leaseId !== this.leaseId || typeof result.member !== 'string') throw new SessionError('Live view receipt belongs to another lease.', 'session_protocol_error', result.id); return result;
  }
  /** Persist `id` first; replaying the same request returns the same view. */
  async create(request: { id: string; member: string; ttlSeconds?: number }): Promise<LiveView> {
    const id = identifier(request.id);
    if (Object.keys(request).some(k => !['id', 'member', 'ttlSeconds'].includes(k)) || typeof request.member !== 'string' || !request.member.trim() || [...request.member].length > 100) throw new ConsumerConfigurationError('Invalid lease live view request.');
    const result = this.bound(await this.call('POST', this.path(), { id, member: request.member, ...ttl(request.ttlSeconds) }, id, [200, 201]));
    if (result.member !== request.member) throw new SessionError('Live view differs from its request.', 'session_protocol_error', id); return result;
  }
  async inspect(viewId: string): Promise<LiveView> { const id = identifier(viewId); return this.bound(await this.call('GET', `${this.path()}/${id}`, undefined, id)); }
  async close(viewId: string): Promise<LiveView> { const id = identifier(viewId); return this.bound(await this.call('POST', `${this.path()}/${id}/close`, {}, id)); }
  /** Creates (or replays) the view and attaches to it. */
  async watch(request: { id: string; member: string; ttlSeconds?: number }, options: LiveOptions = {}): Promise<LiveStream> { liveOptions(options); return this.connect(await this.create(request), options); }
}
