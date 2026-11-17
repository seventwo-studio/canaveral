/** Administrative native-video client. MP4 bytes are streamed unchanged to consumers. */
import { createHash } from 'node:crypto';
import { ConsumerConfigurationError, Transport } from './consumer-client.ts';
import type { ClientOptions } from './consumer-client.ts';
import { checked, identifier, interrupted, record, SessionConnection, SessionError, timeout } from './sdk.ts';
import type { SessionChannel, Writer } from './sdk.ts';
import { MAX_VIDEO_BYTES, Mp4Envelope, validateVideoOptions } from './mobile-video.ts';
import type { VideoOptions } from './mobile-video.ts';
export type { VideoOptions } from './mobile-video.ts';
export interface VideoSession extends VideoOptions {
  id: string; machineId: string; generation: string; capability: 'video'; protocol: 'canaveral-session-v1'; state: string;
  attachBefore: string; authorizationDeadline: string;
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
  private constructor(readonly connection: SessionChannel, readonly options: VideoReceiveOptions) {}
  static async connect(connection: SessionChannel, options: VideoReceiveOptions = {}): Promise<VideoClient> {
    receiveOptions(options); const self = new VideoClient(connection, options);
    try {
      const value = checked(await bounded(() => connection.receive(options.timeoutMs ?? 30000), options, () => self.close()), connection.sessionId);
      if (!record(value) || Object.keys(value).sort().join(',') !== 'codec,fps,mediaType,type' || value.type !== 'video' || value.mediaType !== 'video/mp4' || value.codec !== 'avc1' || value.fps !== 30) throw new SessionError('Native MP4 video metadata was not confirmed.');
      return self;
    } catch (error) { self.close(); throw interrupted(error, connection.sessionId); }
  }
  close(): void { this.connection.close(); }
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
          if (!(error instanceof SessionError) || error.code !== 'session_disconnected') throw error;
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
export class MobileVideoClient {
  readonly transport: Transport;
  constructor(options: ClientOptions & { credential: string }) { this.transport = new Transport(options, options.credential); }
  async create(machineId: string, request: VideoOptions & { id: string }): Promise<VideoSession> {
    const machine = identifier(machineId), id = identifier(request.id);
    let options: VideoOptions; try { options = validateVideoOptions(request); } catch { throw new ConsumerConfigurationError('Invalid video options.'); }
    const result = session((await this.transport.call('POST', `/v1/machines/${machine}/video-sessions`, { id, ...options }, [200,201], true, id)).json);
    if (result.id !== id || result.machineId !== machine || result.fps !== options.fps || result.durationSeconds !== options.durationSeconds || result.bitRate !== options.bitRate) throw new SessionError('Video session differs from its persisted request.', 'video_incomplete', id); return result;
  }
  async inspect(machineId: string, sessionId: string): Promise<VideoSession> { return this.read('GET', machineId, sessionId); }
  async close(machineId: string, sessionId: string): Promise<VideoSession> { return this.read('POST', machineId, sessionId, '/close'); }
  private async read(method: 'GET' | 'POST', machineId: string, sessionId: string, suffix = ''): Promise<VideoSession> {
    const machine = identifier(machineId), id = identifier(sessionId), result = session((await this.transport.call(method, `/v1/machines/${machine}/video-sessions/${id}${suffix}`, method === 'POST' ? {} : undefined, [200], method === 'POST', id)).json);
    if (result.machineId !== machine || result.id !== id) throw new SessionError('Video receipt belongs to another session.', 'video_incomplete', id); return result;
  }
  async connect(value: VideoSession, options: VideoReceiveOptions = {}): Promise<VideoClient> {
    receiveOptions(options);
    if (options.signal?.aborted) throw new SessionError('Video was cancelled before attachment.', 'video_incomplete');
    const current = session(value), connection = await SessionConnection.connect(this.transport, `/v1/machines/${current.machineId}/video-sessions/${current.id}/${current.generation}`, current.id);
    try {
      const ready = checked(await bounded(() => connection.receive(options.timeoutMs ?? 30000), options, () => connection.close()), current.id);
      if (!record(ready) || ready.type !== 'ready' || ready.sessionId !== current.id || ready.generation !== current.generation || ready.capability !== 'video') throw new SessionError('Native video peers did not become ready.', 'video_incomplete', current.id);
      return await VideoClient.connect(connection, options);
    } catch (error) { connection.close(); throw interrupted(error, current.id); }
  }
}
