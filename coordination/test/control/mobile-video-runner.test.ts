import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CliClient } from '../../src/account-cli.ts';
import { startController } from '../../src/main.ts';
import { HostRunner } from '../../src/host.ts';
import type { HostConfig } from '../../src/host.ts';
import { MobileProvider } from '../../src/providers/mobile.ts';
import type { Authorized, DeviceRequest, NativePipe, RecordValue } from '../../src/providers/mobile.ts';
import { MobileVideoClient } from '../../src/video-sdk.ts';
import { object, ServiceError } from '../../src/errors.ts';
import { SessionConnection } from '../../src/control/sessions.ts';
import { LiveCaptureHub } from '../../src/live-capture.ts';
import { readRecord } from '../../src/runtime-process.ts';

function box(type: string, body = Buffer.alloc(0)): Buffer { const header = Buffer.alloc(8); header.writeUInt32BE(8 + body.length); header.write(type, 4); return Buffer.concat([header, body]); }
// Container envelopes prove transport/accounting only; these are not decodable video frames.
const mp4 = Buffer.concat([box('ftyp', Buffer.from('isom0000')), box('moov'), box('moof'), box('mdat', Buffer.from('fixture encoded video'))]);

/** Real controller, broker, HostRunner and SDK; no installed mobile or encoder executable runs. */
async function fixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mobile-video-runner-'))), admin = randomBytes(32).toString('base64url'), enrollment = randomBytes(32).toString('base64url');
  const adminFile = join(root, 'admin.token'), enrollmentFile = join(root, 'enrollment.token');
  writeFileSync(adminFile, admin, { mode: 0o600 }); writeFileSync(enrollmentFile, enrollment, { mode: 0o600 });
  const controller = await startController({ statePath: join(root, 'controller.sqlite'), adminTokenFile: adminFile, enrollmentTokenFile: enrollmentFile,
    controllerId: randomUUID(), listen: { host: '127.0.0.1', port: 0 } });
  let runner: HostRunner | undefined, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const opened = Promise.withResolvers<void>();
  t.after(async () => { release(); await runner?.close(); await controller.close(); rmSync(root, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${controller.address.port}`, client = new CliClient(url, admin), videoApi = new MobileVideoClient({ baseUrl: url, credential: admin, allowLoopbackHttp: true });
  const image: RecordValue = { id: 'android-video-fixture', revision: '1', os: 'android', arch: 'arm64', mode: 'device', minimum: { cpu: 1, memoryMiB: 1024, diskGiB: 4 },
    device: { systemImage: 'system-images;android-35;google_apis;arm64-v8a', profile: 'pixel_8' } };
  const config: HostConfig = { url, stateDir: join(root, 'runner'), enrollmentToken: enrollment, name: 'portable-video-runner', provider: 'android',
    storage: join(root, 'devices'), videoEncoder: '/fixture/ffmpeg', templates: [image], capacity: { cpu: 4, memoryMiB: 8192, diskGiB: 32 }, pollIntervalSeconds: .25, concurrency: 3 };
  const raw = Buffer.from([0, 0, 0, 1, 0x65, 4, 5, 6]), encoderInput: Buffer[] = [];
  let captures = 0, taps = 0, sourceClosed = 0, encoderClosed = 0;
  class FixtureMobile extends MobileProvider {
    override readonly kind = 'android';
    async check() { return { ready: true, nativeAcceptance: false }; }
    async reconcile(machine: RecordValue) { return { state: machine.desired }; }
    override async control(_machine: RecordValue, _image: RecordValue, _folder: string, request: DeviceRequest) {
      assert.equal(request.action, 'tap'); taps++; return { output: 'tap dispatched' };
    }
    async openVideo(_machine: RecordValue, _image: RecordValue, _folder: string, options: { fps: number; durationSeconds: number; bitRate: number }, check: Authorized): Promise<NativePipe> {
      assert.deepEqual(options, { fps: 30, durationSeconds: 1, bitRate: 4_000_000 }); assert.ok(await check()); captures++; opened.resolve();
      let read = false, closed = false;
      return { async read() { await gate; if (read) return Buffer.alloc(0); read = true; return raw; }, async wait() { return 0; },
        async write() { throw new Error('No video source input'); }, async end() { throw new Error('No source EOF injection'); },
        async close() { if (!closed) { closed = true; sourceClosed++; } release(); } };
    }
    override async pipe(argv: readonly string[]): Promise<NativePipe> {
      assert.equal(argv[0], '/fixture/ffmpeg'); assert.ok(argv.includes('libx264')); assert.deepEqual(argv.slice(-3), ['-f', 'mp4', 'pipe:1']);
      let end!: () => void, cursor = 0, closed = false;
      const ended = new Promise<void>(resolve => { end = resolve; });
      return { async read(maximum) { await ended; const bytes = mp4.subarray(cursor, cursor + Math.min(maximum, 7)); cursor += bytes.length; return bytes; },
        async write(data) { const count = Math.min(data.length, 3); encoderInput.push(Buffer.from(data.subarray(0, count))); return count; },
        async end() { end(); }, async wait() { return 0; }, async close() { if (!closed) { closed = true; encoderClosed++; } end(); } };
    }
  }
  const clock = { suspendAware: true, now: () => performance.now() / 1000, wall: () => Date.now() / 1000 };
  const makeRunner = () => new HostRunner(config, { clock, providerFactory: (settings, state) => new FixtureMobile({ ...settings,
    transport: { run: async () => { throw new Error('Native SDK execution is forbidden in this fixture.'); }, elapsed: clock.now } }, state) });
  runner = makeRunner(); await runner.initializeProviders(); await runner.connect(); await runner.checkEnvironment(); await runner.poll();
  const hostId = runner.identity!.id, machineId = randomUUID();
  await client.request('POST', '/v1/machines', { id: machineId, name: 'video-phone', templateId: image.id, resources: image.minimum });
  async function eventually(predicate: () => boolean | Promise<boolean>) {
    const deadline = performance.now() + 5000;
    while (!await predicate() && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(await predicate(), 'fixture work did not complete');
  }
  await runner.poll(); await runner.step(); await eventually(() => runner!.reports.get(machineId)?.state === 'running'); await runner.poll();
  const reservedCpu = async () => Number(object(((await client.request('GET', '/v1/hosts')).hosts as RecordValue[]).find(host => host.id === hostId)!.reserved).cpu);
  const request = { fps: 30, durationSeconds: 1, bitRate: 4_000_000 };
  return { url, admin, config, client, videoApi, machineId, request, eventually, reservedCpu, encoderInput, release, raw, opened: opened.promise,
    get runner() { return runner!; }, get captures() { return captures; }, get taps() { return taps; },
    get sourceClosed() { return sourceClosed; }, get encoderClosed() { return encoderClosed; },
    async restart() { await runner!.close(); runner = makeRunner(); await runner.initializeProviders(); await runner.connect(); await runner.poll(); await runner.step(); },
  };
}

test('runner streams owned video through the real broker without blocking input or replaying capture', { timeout: 30000 }, async t => {
  const f = await fixture(t), { client, videoApi, machineId, config, eventually, reservedCpu, release, encoderInput, raw } = f;
  let runner = f.runner;
  const request = { ...f.request, id: randomUUID() }, initialCpu = await reservedCpu(), session = await videoApi.create(machineId, request);
  assert.equal(await reservedCpu(), initialCpu + 1);
  const connecting = videoApi.connect(session, { timeoutMs: 5000 });
  await runner.poll(); await runner.step(); const video = await connecting;
  await eventually(() => f.captures === 1);
  const received: Buffer[] = [], recording = video.record({ write(bytes) { const count = Math.min(5, bytes.length); received.push(Buffer.from(bytes.subarray(0, count))); return count; } });
  const operationId = randomUUID();
  await client.request('POST', `/v1/machines/${machineId}/operations`, { id: operationId, action: 'tap', arguments: { x: 12, y: 34 } });
  await runner.poll(); await runner.step(); await eventually(() => runner!.deviceReports.get(operationId)?.state === 'succeeded');
  assert.equal(f.taps, 1, 'a paused capture must leave discrete input available'); assert.equal(f.sourceClosed, 0);
  release();
  const finish = await recording;
  assert.deepEqual(Buffer.concat(received), mp4); assert.deepEqual(Buffer.concat(encoderInput), raw);
  assert.deepEqual(finish, { type: 'finish', bytes: mp4.length, sha256: createHash('sha256').update(mp4).digest('hex'), cleaned: true });
  assert.equal((await videoApi.inspect(machineId, session.id)).ackReceived, true);
  assert.equal(f.sourceClosed, 1); assert.equal(f.encoderClosed, 1); assert.equal(await reservedCpu(), initialCpu);
  const replay = await videoApi.create(machineId, request); assert.equal(replay.id, session.id); assert.equal(replay.generation, session.generation); assert.equal(replay.state, 'finished');
  await runner.poll(); await runner.step(); assert.equal(f.captures, 1);
  await f.restart(); runner = f.runner;
  assert.equal(f.captures, 1, 'persisted session identity cannot replay native capture after runner restart');

  const dropped = await videoApi.create(machineId, { ...request, id: randomUUID() });
  const next = videoApi.connect(dropped, { timeoutMs: 5000 });
  await runner.poll(); await runner.step();
  const interrupted = await next;
  t.mock.method(interrupted.connection, 'sendControl', async (value: Record<string, unknown>) => {
    assert.deepEqual(value, { type: 'ack' });
    interrupted.connection.close();
  });
  await assert.rejects(interrupted.record({ write: bytes => bytes.length }), { code: 'video_incomplete' });
  const receipt = await videoApi.inspect(machineId, dropped.id);
  assert.equal(receipt.cleaned, true);
  assert.equal(receipt.ackReceived, undefined);

  const legacy = await videoApi.create(machineId, { ...request, id: randomUUID() });
  const send = runner.transport.request.bind(runner.transport), reports: RecordValue[] = [];
  t.mock.method(runner.transport, 'request', async (...args: Parameters<typeof send>) => {
    if (args[1].endsWith(`/video-sessions/${legacy.id}/finish`)) {
      reports.push(args[2]);
      if (args[2].ackReceived) throw new ServiceError('Mobile video session rejected.', 400);
    }
    return send(...args);
  });
  const legacyConnection = videoApi.connect(legacy, { timeoutMs: 5000 });
  await runner.poll(); await runner.step();
  const legacyVideo = await legacyConnection;
  await assert.rejects(legacyVideo.record({ write: bytes => bytes.length }), { code: 'video_incomplete' });
  const cleanup = { generation: legacy.generation, cleaned: true };
  assert.deepEqual(reports, [{ ...cleanup, ackReceived: true }, cleanup]);
  const journal = readRecord(join(config.stateDir, 'work', 'video', `${legacy.id}.json`));
  assert.equal(journal.ackReceived, true);
  assert.equal(journal.legacyReceipt, true);
  assert.equal((await videoApi.inspect(machineId, legacy.id)).ackReceived, undefined);
  assert.equal(await reservedCpu(), initialCpu);
});

test('a heartbeat that delivers a recording and live view invalidates the cached negative result', { timeout: 15000 }, async t => {
  const f = await fixture(t), runner = f.runner;
  const pending = () => (runner as unknown as { recordingPending(id: string): boolean }).recordingPending(f.machineId);
  const recording = await f.videoApi.create(f.machineId, { ...f.request, id: randomUUID() });
  const send = runner.transport.request.bind(runner.transport), viewId = randomUUID();
  t.mock.method(runner.transport, 'request', async (...args: Parameters<typeof send>) => {
    const response = await send(...args);
    if (args[1].endsWith('/heartbeat')) {
      assert.ok((response.videoSessions as RecordValue[]).some(job => job.id === recording.id));
      assert.equal(pending(), false);
      // Deliver both assignments in the same heartbeat, while the negative result is cached.
      return { ...response, liveViews: [{ id: viewId, machineId: f.machineId }] };
    }
    return response;
  });
  await runner.poll();
  assert.equal(pending(), true);
});

test('a broker close before recording commitment prevents dispatch while the runner still sees an open socket', { timeout: 15000 }, async t => {
  const f = await fixture(t), runner = f.runner;
  const recording = await f.videoApi.create(f.machineId, { ...f.request, id: randomUUID() });
  const stop = Promise.withResolvers<void>(), waiting = Promise.withResolvers<void>();
  const brokerClosed = Promise.withResolvers<void>(), deliverClose = Promise.withResolvers<void>(), startSent = Promise.withResolvers<void>();
  const proxy = createServer({ allowHalfOpen: true }, downstream => {
    const upstream = createConnection({ host: '127.0.0.1', port: Number(new URL(f.url).port), allowHalfOpen: true });
    downstream.pipe(upstream); upstream.pipe(downstream, { end: false });
    upstream.once('end', () => { brokerClosed.resolve(); void deliverClose.promise.then(() => downstream.end()); });
    upstream.on('error', () => {});
    downstream.on('error', () => {});
    downstream.once('close', () => upstream.destroy());
  });
  await new Promise<void>((resolve, reject) => { proxy.once('error', reject); proxy.listen(0, '127.0.0.1', resolve); });
  const address = proxy.address();
  assert.ok(address && typeof address !== 'string');
  t.after(() => { deliverClose.resolve(); return new Promise<void>(resolve => proxy.close(() => resolve())); });
  const begin = LiveCaptureHub.prototype.beginRecording;
  t.mock.method(LiveCaptureHub.prototype, 'beginRecording', async function (this: LiveCaptureHub, ...args: Parameters<typeof begin>) {
    const tap = await begin.apply(this, args);
    waiting.resolve();
    await stop.promise;
    return tap;
  });
  const connect = SessionConnection.connect.bind(SessionConnection);
  let host: SessionConnection | undefined;
  t.mock.method(SessionConnection, 'connect', async (_origin: string, path: string, token: string, options: Parameters<typeof connect>[3]) => {
    assert.ok(path.startsWith('/v1/hosts/'));
    host = await connect(`http://127.0.0.1:${address.port}`, path, token, options);
    const send = host.sendControl.bind(host);
    t.mock.method(host, 'sendControl', async (value: RecordValue) => {
      try { await send(value); } finally { if (value.type === 'start') startSent.resolve(); }
    });
    return host;
  });
  const consumer = await connect(f.url, `/v1/machines/${f.machineId}/video-sessions/${recording.id}/${recording.generation}`, f.admin);
  try {
    await runner.poll(); await runner.step();
    assert.equal((await consumer.receive(5) as RecordValue).type, 'ready');
    await waiting.promise;
    consumer.close();
    await brokerClosed.promise;
    assert.equal(host?.open, true);
    assert.equal(host?.authorized(), true);
    stop.resolve();
    await Promise.race([startSent.promise, f.opened]);
    deliverClose.resolve();
    await f.eventually(async () => (await f.videoApi.inspect(f.machineId, recording.id)).cleaned === true);
    assert.equal(f.captures, 0);
  } finally { consumer.close(); stop.resolve(); deliverClose.resolve(); host?.close(); }
});

test('a broker close after committing a recording stops the started source and proves cleanup', { timeout: 15000 }, async t => {
  const f = await fixture(t), recording = await f.videoApi.create(f.machineId, { ...f.request, id: randomUUID() });
  const connecting = f.videoApi.connect(recording, { timeoutMs: 5000 });
  await f.runner.poll(); await f.runner.step();
  const consumer = await connecting;
  try {
    await f.opened;
    assert.equal(f.sourceClosed, 0);
    consumer.close();
    await f.eventually(async () => (await f.videoApi.inspect(f.machineId, recording.id)).cleaned === true);
    assert.equal(f.sourceClosed, 1);
    assert.equal(f.encoderClosed, 1);
  } finally { consumer.close(); }
});

test('a new runner refuses to record beside a live capture when an older controller supplies no handover flag', { timeout: 15000 }, async t => {
  const f = await fixture(t), runner = f.runner;
  const send = runner.transport.request.bind(runner.transport);
  let liveCaptures: RecordValue[] = [{ id: randomUUID(), generation: randomUUID(), machineId: f.machineId, state: 'disconnected' }];
  t.mock.method(runner.transport, 'request', async (...args: Parameters<typeof send>) => {
    const [method, path, body, ...rest] = args;
    if (!path.endsWith('/heartbeat')) return send(...args);
    const offer = { ...object(body.offer) };
    delete offer.videoHandoverProtocol;
    const response = await send(method, path, { ...body, offer }, ...rest);
    const videoSessions = (response.videoSessions as RecordValue[]).map(job => {
      const legacy = { ...job };
      delete legacy.videoHandoverProtocol;
      delete legacy.priorLiveCapture;
      return legacy;
    });
    return { ...response, videoSessions, liveCaptures };
  });
  const recording = await f.videoApi.create(f.machineId, { ...f.request, id: randomUUID() });
  const connecting = f.videoApi.connect(recording, { timeoutMs: 5000 });
  await runner.poll(); await runner.step();
  f.release();
  await assert.rejects(async () => (await connecting).record({ write: bytes => bytes.length }), { code: 'session_incomplete' });
  await f.eventually(async () => (await f.videoApi.inspect(f.machineId, recording.id)).cleaned === true);
  assert.equal(f.captures, 0);

  liveCaptures = [];
  const solo = await f.videoApi.create(f.machineId, { ...f.request, id: randomUUID() });
  const standalone = f.videoApi.connect(solo, { timeoutMs: 5000 });
  await runner.poll(); await runner.step();
  const finish = await (await standalone).record({ write: bytes => bytes.length });
  assert.equal(finish.cleaned, true);
  assert.equal(f.captures, 1);
});
