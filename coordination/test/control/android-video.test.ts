import test from 'node:test';
import assert from 'node:assert/strict';
import { openAndroidVideo } from '../../src/providers/android-video.ts';
import type { AndroidVideoOptions } from '../../src/providers/android-video.ts';
import type { AndroidProvider } from '../../src/providers/android.ts';
import type { NativePipe, RecordValue } from '../../src/providers/mobile.ts';
import { ServiceError } from '../../src/errors.ts';

function fixture() {
  let allowed = true, epoch: RecordValue | undefined = { startedAt: 100, identity: 'owned-boot' }, clock = 0, foreign = false, booted = true;
  let closes = 0, waits = 0, ended = 0, ownership = 0, captures = 0;
  const calls: unknown[] = [], chunks = [Buffer.from([0,0,0,1,0x67,0x42]), Buffer.from([0,0,0,1,0x65,0xff])];
  const native: NativePipe = {
    read: async () => chunks.shift() ?? Buffer.alloc(0), write: async data => data.length,
    end: async () => { ended++; }, wait: async () => { waits++; return 0; }, close: async () => { closes++; },
  };
  const provider = {
    transport: { pipe: true, elapsed: () => clock },
    executionAllowed: (machine: RecordValue) => { calls.push('execution'); if (machine.lease) throw new ServiceError('Lease execution is disabled.',409,{code:'capability_unsupported'}); },
    storage: () => { calls.push('storage'); return '/fixture/owned'; },
    endpoint: async () => { calls.push('endpoint'); return 'emulator-5556'; },
    adb: async () => { calls.push('boot'); return booted ? '1' : '0'; },
    owned: async () => { ownership++; if (foreign) throw new ServiceError('Foreign AVD.',409); },
    displayEpoch: () => epoch,
    tool: () => '/fixture/sdk/platform-tools/adb',
    pipe: async (argv: string[]) => { calls.push(argv); captures++; return native; },
  } as unknown as AndroidProvider;
  const machine: RecordValue = { desired: 'running' }, image = { os: 'android' };
  const options: AndroidVideoOptions = { durationSeconds: 10, bitRate: 4000000, fps: 30 };
  return { native, calls, provider, machine, image, options, get closes() { return closes; }, get waits() { return waits; }, get ended() { return ended; }, get ownership() { return ownership; }, get captures() { return captures; },
    revoke: () => { allowed = false; }, replace: () => { epoch = { startedAt: 200, identity: 'other-boot' }; }, noEpoch: () => { epoch = undefined; },
    advance: () => { clock += 1.1; }, setForeign: () => { foreign = true; }, notBooted: () => { booted = false; },
    open: (selected = options) => openAndroidVideo(provider, machine, image, '/fixture', selected, () => allowed) };
}

test('native Android H264 capture preserves encoded bytes and completes only after EOF and remote exit', async () => {
  const f = fixture(), source = await f.open();
  assert.deepEqual(f.calls.at(-1), ['/fixture/sdk/platform-tools/adb','-s','emulator-5556','shell','-T','-n','screenrecord','--output-format=h264','--bit-rate','4000000','--time-limit','10','-']);
  assert.equal(f.ended, 1);
  assert.deepEqual(await source.read(65536, 1000), Buffer.from([0,0,0,1,0x67,0x42]));
  assert.deepEqual(await source.read(65536, 1000), Buffer.from([0,0,0,1,0x65,0xff]));
  assert.equal(f.ownership, 1, 'encoded chunks must not start a native identity subprocess per frame');
  assert.deepEqual(await source.read(65536, 1000), Buffer.alloc(0));
  assert.equal(f.waits, 1); assert.equal(await source.wait(1000), 0);
  await source.close(); await source.close(); assert.equal(f.closes, 1);
});

test('Android capture rejects unbounded or unsupported options before any native access', async () => {
  for (const patch of [{ durationSeconds: 0 },{ durationSeconds: 181 },{ durationSeconds: 1.5 },{ bitRate: 99999 },{ bitRate: 20000001 },{ bitRate: Infinity },{ fps: 60 },{ path: '/foreign' }]) {
    const f = fixture(); await assert.rejects(f.open({ ...f.options, ...patch })); assert.deepEqual(f.calls, []); assert.equal(f.captures, 0);
  }
  for (const mode of ['revoked','lease','stopped','foreign','unbooted','missing-epoch']) {
    const f = fixture();
    if (mode === 'revoked') f.revoke();
    if (mode === 'lease') f.machine.lease = { id: 'fixture-lease' };
    if (mode === 'stopped') f.machine.desired = 'stopped';
    if (mode === 'foreign') f.setForeign();
    if (mode === 'unbooted') f.notBooted();
    if (mode === 'missing-epoch') f.noEpoch();
    await assert.rejects(f.open()); assert.equal(f.captures, 0, mode);
  }
});

test('Android capture enforces per-read boot identity and periodic native ownership without forwarding stale bytes', async () => {
  for (const mode of ['epoch','authorization','native']) {
    const f = fixture(), source = await f.open();
    if (mode === 'epoch') f.replace();
    if (mode === 'authorization') f.revoke();
    if (mode === 'native') { f.advance(); f.setForeign(); }
    await assert.rejects(source.read(65536,1000)); assert.equal(f.closes, 1);
    await assert.rejects(source.close(), { code: 'video_stop_uncertain', outcome: 'unknown' });
    assert.equal(f.captures, 1, 'source loss cannot automatically restart screenrecord');
  }
});

test('Android stalled capture is revoked independently of input or another read', { timeout: 3000 }, async () => {
  const f = fixture(); let finish!: (data: Uint8Array) => void;
  f.native.read = async () => new Promise<Uint8Array>(resolve => { finish = resolve; });
  f.native.close = async () => { finish(Buffer.from('stale encoded bytes')); };
  const source = await f.open(), pending = source.read(65536, 1000);
  await new Promise(resolve => setImmediate(resolve)); f.revoke();
  await assert.rejects(pending, /authorization/);
  await assert.rejects(source.close(), { code: 'video_stop_uncertain' });
});

test('Android capture reports uncertain early close, nonzero remote exit and invalid native buffers', async () => {
  const early = fixture(), source = await early.open();
  await assert.rejects(source.wait(1000), /Drain/); await assert.rejects(source.write(Buffer.from('input'),1000), /read-only/);
  await assert.rejects(source.close(), { code: 'video_stop_uncertain', outcome: 'unknown' }); assert.equal(early.closes, 1);
  const failed = fixture(); failed.native.read = async () => Buffer.alloc(0); failed.native.wait = async () => 1;
  const exited = await failed.open(); await assert.rejects(exited.read(65536,1000), /remote exit/); await assert.rejects(exited.close(), { code: 'video_stop_uncertain' });
  const excessive = fixture(); excessive.native.read = async () => Buffer.alloc(65537);
  const oversize = await excessive.open();
  await assert.rejects(oversize.read(65537,1000), /read size/); await assert.rejects(oversize.read(65536,1000), /bounded read/);
  await assert.rejects(oversize.close(), { code: 'video_stop_uncertain' }); assert.equal(excessive.closes, 1);
});
