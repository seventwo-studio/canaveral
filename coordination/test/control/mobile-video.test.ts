import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { serveMobileVideo, videoEncoderArguments, Mp4Envelope } from '../../src/mobile-video.ts';
import { MobileVideoClient, VideoClient } from '../../src/video-sdk.ts';
import { createSessionUpgradeHandler, SessionConnection } from '../../src/control/sessions.ts';
import { validateRelayMessage } from '../../src/control/session-protocol.ts';
import type { NativePipe } from '../../src/providers/mobile.ts';
import type { SessionChannel, SessionMessage } from '../../src/sdk.ts';
const options = { fps: 30, durationSeconds: 1, bitRate: 4000000 };
function box(type: string, data = Buffer.alloc(0)): Buffer { const b = Buffer.alloc(8); b.writeUInt32BE(8 + data.length); b.write(type, 4); return Buffer.concat([b, data]); }
// An envelope fixture only, with no claim to contain a decodable native video track.
const mp4 = Buffer.concat([box('ftyp', Buffer.from('isom0000')), box('moov'), box('moof'), box('mdat', Buffer.from('encoded-native-samples'))]);
const metadata = { type: 'video', mediaType: 'video/mp4', codec: 'avc1', fps: 30 };
const finish = { type: 'finish', bytes: mp4.length, sha256: createHash('sha256').update(mp4).digest('hex'), cleaned: true };
class Wire implements SessionChannel {
  readonly sessionId = randomUUID();
  queue: Array<SessionMessage | null> = [metadata];
  controls: Record<string, unknown>[] = [];
  closes = 0;
  receiveHook: (() => Promise<SessionMessage | null>) | undefined;
  async receive(): Promise<SessionMessage | null> { return this.receiveHook ? this.receiveHook() : this.queue.shift() ?? null; }
  async sendControl(value: Record<string, unknown>) { this.controls.push(value); }
  async sendBytes() { throw new Error('viewers cannot send video bytes'); }
  close() { this.closes++; }
}
function pipe(parts: Uint8Array[], exit = 0): NativePipe & { closes: number; ends: number; input: Buffer[] } {
  return { closes: 0, ends: 0, input: [],
    async read(maximum) { const data = parts.shift() ?? Buffer.alloc(0); assert.ok(data.length <= maximum); return data; },
    async write(data) { const n = Math.min(2, data.length); this.input.push(Buffer.from(data.subarray(0, n))); return n; },
    async end() { this.ends++; }, async wait() { return exit; }, async close() { this.closes++; },
  };
}

test('native video pipeline pumps H264 to bounded fMP4 and finishes only after both processes complete', async () => {
  const source = pipe([Buffer.from('native-h264')]), encoder = pipe([mp4.subarray(0, 17), mp4.subarray(17)]), controls: Record<string, unknown>[] = [], output: Buffer[] = [];
  await serveMobileVideo({ async sendControl(value) { controls.push(value); }, async sendBytes(bytes) { output.push(Buffer.from(bytes)); }, async receive() { return { type: 'ack' }; }, close() {} }, source,
    async argv => { assert.deepEqual(argv, videoEncoderArguments('/opt/ffmpeg', options)); return encoder; }, '/opt/ffmpeg', options, () => true);
  assert.deepEqual(Buffer.concat(encoder.input), Buffer.from('native-h264')); assert.equal(encoder.ends, 1);
  assert.deepEqual(Buffer.concat(output), mp4); assert.deepEqual(controls, [metadata, finish]); assert.ok(source.closes >= 1); assert.ok(encoder.closes >= 1);
});

test('native capture/encoder failures and revoked authorization never emit successful completion', async () => {
  for (const [sourceExit, encoderExit] of [[1,0],[0,1]]) {
    const source = pipe([Buffer.from('h264')], sourceExit), encoder = pipe([mp4], encoderExit), controls: Record<string, unknown>[] = [];
    await assert.rejects(serveMobileVideo({ async sendControl(value) { controls.push(value); }, async sendBytes() {}, async receive() { return { type: 'ack' }; }, close() {} }, source, async () => encoder, '/opt/ffmpeg', options, () => true));
    assert.ok(!controls.some(value => value.type === 'finish')); assert.ok(source.closes); assert.ok(encoder.closes);
  }
  const source = pipe([]); await assert.rejects(serveMobileVideo({ async sendControl() {}, async sendBytes() {}, async receive() { return null; }, close() {} }, source, async () => { throw new Error('must not spawn'); }, '/opt/ffmpeg', options, () => false)); assert.ok(source.closes);
});

test('process cleanup evidence is independent of recording or ACK success', async () => {
  let cleaned: boolean | undefined;
  const channel = { async sendControl() {}, async sendBytes() {}, async receive() { return null; }, close() {} };
  await assert.rejects(serveMobileVideo(channel, pipe([Buffer.from('h264')]), async () => pipe([mp4]), '/opt/ffmpeg', options, () => true, value => { cleaned = value; }));
  assert.equal(cleaned, true, 'lost recording ACK does not negate positively closed capture/encoder');
  const source = pipe([Buffer.from('h264')]); source.close = async () => { throw new Error('remote capture stop is uncertain'); }; cleaned = undefined;
  await assert.rejects(serveMobileVideo(channel, source, async () => pipe([mp4]), '/opt/ffmpeg', options, () => true, value => { cleaned = value; }));
  assert.equal(cleaned, false, 'uncertain native stop cannot release its reservation');
});

test('encoder options pin low-delay H26430 and fMP4 without consumer command injection', () => {
  const args = videoEncoderArguments('/opt/ffmpeg', options);
  assert.ok(args.includes('libx264')); assert.ok(args.includes('zerolatency')); assert.ok(args.includes('+frag_keyframe+empty_moov+default_base_moof')); assert.ok(args.includes('250000'));
  assert.ok(args.includes('fps=30,scale=w=min(1280\\,iw):h=min(1280\\,ih):force_original_aspect_ratio=decrease:force_divisible_by=2'));
  assert.throws(() => videoEncoderArguments('ffmpeg', options)); assert.throws(() => videoEncoderArguments('/opt/ffmpeg', { ...options, fps: 60 }));
  assert.throws(() => videoEncoderArguments('/opt/ffmpeg', { ...options, durationSeconds: 181 }));
});

test('MP4 envelope handles arbitrary chunk boundaries and rejects truncation and screenshot bytes', () => {
  const valid = new Mp4Envelope(); for (const byte of mp4) valid.push(Buffer.from([byte])); assert.equal(valid.complete(), true);
  const partial = new Mp4Envelope(); partial.push(mp4.subarray(0, -1)); assert.equal(partial.complete(), false);
  assert.throws(() => new Mp4Envelope().push(Buffer.from('89504e470d0a1a0a', 'hex')));
  assert.throws(() => new Mp4Envelope().push(Buffer.concat([box('ftyp'), box('mdat')])));
});

test('SDK streams the exact MP4 through partial writes, verifies digest/cleanup, then acknowledges', async () => {
  const wire = new Wire(); for (let at = 0; at < mp4.length; at += 3) wire.queue.push(mp4.subarray(at, at + 3)); wire.queue.push(finish);
  const video = await VideoClient.connect(wire), output: Buffer[] = [];
  const result = await video.record({ write(bytes) { assert.ok(!wire.controls.length); const count = Math.min(2, bytes.length); output.push(Buffer.from(bytes.subarray(0, count))); return count; } });
  assert.deepEqual(Buffer.concat(output), mp4); assert.deepEqual(result, finish); assert.deepEqual(wire.controls, [{ type: 'ack' }]); assert.ok(wire.closes);
  await assert.rejects(video.record({ write: bytes => bytes.length }));
});

test('SDK rejects bad digest, absent finish, missing cleanup, byte-budget excess and bad metadata', async () => {
  for (const terminal of [null, { ...finish, sha256: '0'.repeat(64) }, { ...finish, cleaned: false }]) {
    const wire = new Wire(); wire.queue.push(mp4, terminal); const video = await VideoClient.connect(wire);
    await assert.rejects(video.record({ write: bytes => bytes.length })); assert.deepEqual(wire.controls, []); assert.ok(wire.closes);
  }
  const small = new Wire(); small.queue.push(mp4); const video = await VideoClient.connect(small, { maxBytes: 1 }); await assert.rejects(video.record({ write: bytes => bytes.length }));
  const invalid = new Wire(); invalid.queue = [{ ...metadata, fps: 60 }]; await assert.rejects(VideoClient.connect(invalid));
});

test('SDK cancellation and blocked output are bounded and never acknowledge incomplete files', async () => {
  const wire = new Wire(); wire.queue.push(mp4, finish); const controller = new AbortController(), video = await VideoClient.connect(wire, { signal: controller.signal });
  let started!: () => void; const writing = new Promise<void>(resolve => { started = resolve; });
  const recording = video.record({ write() { started(); return new Promise(() => {}); } }); await writing; controller.abort(); await assert.rejects(recording); assert.deepEqual(wire.controls, []);
  const blocked = new Wire(); blocked.queue.push(mp4, finish); const other = await VideoClient.connect(blocked, { timeoutMs: 10 });
  await assert.rejects(other.record({ write: () => new Promise(() => {}) })); assert.deepEqual(blocked.controls, []);
});

test('video relay rejects consumer binary/input and malformed metadata or finish controls', () => {
  const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));
  assert.throws(() => validateRelayMessage('video', 'consumer', mp4, true));
  assert.throws(() => validateRelayMessage('video', 'consumer', bytes({ type: 'action', action: 'tap' }), false));
  assert.throws(() => validateRelayMessage('video', 'host', bytes({ ...metadata, extra: true }), false));
  assert.throws(() => validateRelayMessage('video', 'host', bytes({ ...finish, cleaned: false }), false));
  assert.deepEqual(validateRelayMessage('video', 'consumer', bytes({ type: 'ack' }), false), { type: 'ack' });
  assert.deepEqual(validateRelayMessage('video', 'host', bytes(finish), false), finish);
});

test('real WebSocket SDK records exact MP4 and keeps its ACK attached until host completion', { timeout: 10000 }, async t => {
  const id = randomUUID(), generation = randomUUID(), machineId = randomUUID(), hostId = randomUUID(), credential = 'a'.repeat(43), hostCredential = 'b'.repeat(43);
  const view = { id, generation, machineId, capability: 'video', protocol: 'canaveral-session-v1', state: 'ready', ...options, attachBefore: new Date(Date.now() + 30000).toISOString(), authorizationDeadline: new Date(Date.now() + 60000).toISOString() };
  let attached = 0, disconnected = false;
  const broker = createSessionUpgradeHandler({ async request(command) {
    assert.ok(command.type.startsWith('video-sessions.'));
    if (command.type === 'video-sessions.attach') { assert.equal(command.token, command.side === 'host' ? hostCredential : credential); attached++; return view; }
    if (command.type === 'video-sessions.authorized') return { authorized: !disconnected && (!command.ready || attached === 2) };
    disconnected = true; return { disconnected: true };
  } }, { video: true });
  const server = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${credential}`); const parts: Buffer[] = []; for await (const part of req) parts.push(Buffer.from(part));
    assert.equal(req.url, `/v1/machines/${machineId}/video-sessions`); assert.deepEqual(JSON.parse(Buffer.concat(parts).toString()), { id, ...options });
    res.writeHead(201, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(view));
  });
  server.on('upgrade', (req, socket, head) => { void broker.handle(req, socket, head); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { broker.close(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`, api = new MobileVideoClient({ baseUrl: origin, credential, allowLoopbackHttp: true });
  const session = await api.create(machineId, { id, ...options });
  const connecting = api.connect(session, { timeoutMs: 2000 });
  const host = await SessionConnection.connect(origin, `/v1/hosts/${hostId}/video-sessions/${id}/${generation}`, hostCredential); t.after(() => host.close());
  assert.equal((await host.receive(2) as Record<string, unknown>).type, 'ready');
  let cleaned: boolean | undefined;
  const serving = serveMobileVideo(host, pipe([Buffer.from('h264')]), async () => pipe([mp4]), '/opt/ffmpeg', options, () => true, value => { cleaned = value; }).finally(() => host.close());
  const video = await connecting, saved: Buffer[] = [];
  const [receipt] = await Promise.all([video.record({ write(data) { saved.push(Buffer.from(data)); return data.length; } }), serving]);
  assert.deepEqual(Buffer.concat(saved), mp4); assert.deepEqual(receipt, finish); assert.equal(cleaned, true);
});
