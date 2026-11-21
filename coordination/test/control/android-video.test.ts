import test from 'node:test';
import assert from 'node:assert/strict';
import { openAndroidVideo, parseRecorderHeader, recorderCommand, recorderStopCommand } from '../../src/providers/android-video.ts';
import type { AndroidVideoOptions } from '../../src/providers/android-video.ts';
import type { AndroidProvider } from '../../src/providers/android.ts';
import { captureNotRunning } from '../../src/providers/mobile.ts';
import type { NativePipe, RecordValue } from '../../src/providers/mobile.ts';
import { ServiceError } from '../../src/errors.ts';
import { spawn, spawnSync } from 'node:child_process';

const BOOT = '0f1e2d3c-4b5a-4968-8776-655443322110', START = '73311';
const HEADER = `canaveral-recorder ${BOOT} 4321 (sh) R 812 4321 812 0 -1 4194560 120 0 0 0 0 0 0 0 20 0 1 0 ${START} 10973184 512 18446744073709551615\n`;
type Guest = 'running' | 'stubborn' | 'laggard' | 'immortal' | 'absent' | 'replaced' | 'rebooted' | 'zombie' | 'foreign' | 'unreadable' | 'unreachable';

function fixture() {
  let allowed = true, assignment = true, epoch: RecordValue | undefined = { startedAt: 100, identity: 'owned-boot' }, clock = 0, foreign = false, booted = true;
  let closes = 0, waits = 0, ended = 0, ownership = 0, captures = 0, guest: Guest = 'running';
  const calls: unknown[] = [], signals: string[] = [], probes: string[] = [];
  const chunks = [Buffer.from(HEADER), Buffer.from([0,0,0,1,0x67,0x42]), Buffer.from([0,0,0,1,0x65,0xff])];
  const native: NativePipe = {
    read: async () => chunks.shift() ?? Buffer.alloc(0), write: async data => data.length,
    end: async () => { ended++; }, wait: async () => { waits++; return 0; }, close: async () => { closes++; },
  };
  // A guest shell answering recorderStopCommand: it signals only the matching boot, PID and start time.
  const recorder = (script: string): string => {
    // A laggard device answers slowly enough to exhaust the time budget before SIGKILL.
    probes.push(script); clock += guest === 'laggard' ? 4 : 1;
    if (guest === 'unreachable') throw new ServiceError('Device command unavailable or timed out; its effects may be uncertain.', 409, { outcome: 'unknown' });
    assert.ok(script.includes(`!= ${BOOT}`) && script.includes('/proc/4321/stat') && script.includes(`!= ${START}`), 'cleanup is bound to the reported recorder');
    assert.doesNotMatch(script, /pkill|killall|pidof|screenrecord -/, 'cleanup never matches recorders by name');
    const signal = /kill -(TERM|KILL) 4321/.exec(script)?.[1];
    const state = guest === 'stubborn' || guest === 'laggard' || guest === 'immortal' ? 'running' : guest === 'zombie' ? 'exited' : guest;
    if (state === 'running' && signal) { signals.push(signal); if (guest === 'running' || (guest === 'stubborn' || guest === 'laggard') && signal === 'KILL') guest = 'absent'; }
    return 'canaveral-recorder ' + state;
  };
  const provider = {
    transport: { pipe: true, elapsed: () => clock },
    executionAllowed: (machine: RecordValue) => { calls.push('execution'); if (machine.lease) throw new ServiceError('Lease execution is disabled.',409,{code:'capability_unsupported'}); },
    storage: () => { calls.push('storage'); return '/fixture/owned'; },
    endpoint: async () => { calls.push('endpoint'); return 'emulator-5556'; },
    adb: async (_serial: string, args: string[]) => {
      if (args[1] === 'getprop') { calls.push('boot'); return booted ? '1' : '0'; }
      return recorder(args[1]!);
    },
    owned: async () => { ownership++; if (foreign) throw new ServiceError('Foreign AVD.',409); },
    displayEpoch: () => epoch,
    tool: () => '/fixture/sdk/platform-tools/adb',
    pipe: async (argv: string[]) => { calls.push(argv); captures++; return native; },
  } as unknown as AndroidProvider;
  const machine: RecordValue = { desired: 'running' }, image = { os: 'android' };
  const options: AndroidVideoOptions = { durationSeconds: 10, bitRate: 4000000, fps: 30 };
  return { native, calls, provider, machine, image, options, chunks, signals, probes,
    get closes() { return closes; }, get waits() { return waits; }, get ended() { return ended; }, get ownership() { return ownership; }, get captures() { return captures; },
    revoke: () => { allowed = false; }, endAssignment: () => { assignment = false; }, replace: () => { epoch = { startedAt: 200, identity: 'other-boot' }; }, noEpoch: () => { epoch = undefined; },
    advance: () => { clock += 1.1; }, setForeign: () => { foreign = true; }, notBooted: () => { booted = false; }, setGuest: (state: Guest) => { guest = state; },
    open: (selected = options) => openAndroidVideo(provider, machine, image, '/fixture', selected, () => allowed),
    // The runner's shape: capture ends with the session, cleanup needs only the assignment.
    owned: (selected = options) => openAndroidVideo(provider, machine, image, '/fixture', selected, () => allowed, () => assignment) };
}

test('native Android H264 capture preserves encoded bytes and completes only after EOF and remote exit', async () => {
  const f = fixture(), source = await f.open();
  assert.deepEqual(f.calls.at(-1), ['/fixture/sdk/platform-tools/adb','-s','emulator-5556','shell','-T','-n',recorderCommand(10, 4000000)]);
  assert.deepEqual(source.recorder, { boot: BOOT, pid: 4321, start: START });
  assert.equal(f.ended, 1);
  assert.deepEqual(await source.read(65536, 1000), Buffer.from([0,0,0,1,0x67,0x42]));
  assert.deepEqual(await source.read(65536, 1000), Buffer.from([0,0,0,1,0x65,0xff]));
  assert.equal(f.ownership, 1, 'encoded chunks must not start a native identity subprocess per frame');
  assert.deepEqual(await source.read(65536, 1000), Buffer.alloc(0));
  assert.equal(f.waits, 1); assert.equal(await source.wait(1000), 0);
  await source.close(); await source.close(); assert.equal(f.closes, 1);
  assert.equal(f.probes.length, 0, 'a positively completed capture needs no guest stop');
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
  const source = await f.open();
  f.native.read = async () => new Promise<Uint8Array>(resolve => { finish = resolve; });
  f.native.close = async () => { finish(Buffer.from('stale encoded bytes')); };
  const pending = source.read(65536, 1000);
  await new Promise(resolve => setImmediate(resolve)); f.revoke();
  await assert.rejects(pending, /authorization/);
  await assert.rejects(source.close(), { code: 'video_stop_uncertain' });
});

test('Android capture reports uncertain early close, nonzero remote exit and invalid native buffers', async () => {
  const early = fixture(), source = await early.open();
  await assert.rejects(source.wait(1000), /Drain/); await assert.rejects(source.write(Buffer.from('input'),1000), /read-only/);
  await assert.rejects(source.close(), { code: 'video_stop_uncertain', outcome: 'unknown' }); assert.equal(early.closes, 1);
  assert.equal(early.probes.length, 0, 'without assignment authority no guest cleanup is attempted');
  const failed = fixture(), exited = await failed.open(); failed.native.read = async () => Buffer.alloc(0); failed.native.wait = async () => 1;
  await assert.rejects(exited.read(65536,1000), /remote exit/); await assert.rejects(exited.close(), { code: 'video_stop_uncertain' });
  const excessive = fixture(), oversize = await excessive.open(); excessive.native.read = async () => Buffer.alloc(65537);
  await assert.rejects(oversize.read(65537,1000), /read size/); await assert.rejects(oversize.read(65536,1000), /bounded read/);
  await assert.rejects(oversize.close(), { code: 'video_stop_uncertain' }); assert.equal(excessive.closes, 1);
});

test('Android early cancellation stops only the reported recorder and proves it exited', async () => {
  const f = fixture(), source = await f.owned();
  assert.deepEqual(await source.read(65536, 1000), Buffer.from([0,0,0,1,0x67,0x42]));
  await source.close();
  assert.deepEqual(f.signals, ['TERM']); assert.deepEqual(source.signalled, ['TERM']); assert.equal(source.stopped, 'absent'); assert.equal(f.closes, 1);
  assert.ok(f.ownership >= 2, 'the AVD is re-verified before the guest signal');
  const probes = f.probes.length;
  await source.close(); await source.close();
  assert.equal(f.probes.length, probes, 'repeated close reuses the proven cleanup'); assert.deepEqual(f.signals, ['TERM']);
  assert.equal(f.captures, 1, 'cleanup never reopens capture');
});

test('Android cleanup accepts only positive exit evidence for the exact recorder', async () => {
  for (const [guest, stopped] of [['absent','absent'],['replaced','replaced'],['rebooted','rebooted'],['zombie','exited']] as const) {
    const f = fixture(), source = await f.owned(); f.setGuest(guest);
    await source.close(); assert.equal(source.stopped, stopped, guest); assert.deepEqual(f.signals, [], guest + ' needs no signal'); assert.deepEqual(source.signalled, []);
  }
  const stubborn = fixture(), slow = await stubborn.owned(); stubborn.setGuest('stubborn');
  await slow.close(); assert.deepEqual(stubborn.signals, ['TERM', 'KILL']); assert.deepEqual(slow.signalled, ['TERM', 'KILL']); assert.equal(slow.stopped, 'absent');
  // Slow adb must not skip SIGKILL: it is always sent before giving up.
  const laggard = fixture(), late = await laggard.owned(); laggard.setGuest('laggard');
  await late.close(); assert.deepEqual(laggard.signals, ['TERM', 'KILL']); assert.equal(late.stopped, 'absent');
  // After SIGKILL, at least one further probe runs before reporting unknown.
  const immortal = fixture(), stuck = await immortal.owned(); immortal.setGuest('immortal');
  await assert.rejects(stuck.close(), { code: 'video_stop_uncertain' });
  const kill = immortal.probes.findIndex(p => /kill -KILL 4321/.test(p));
  assert.ok(kill >= 0 && immortal.probes.length > kill + 1, 'a probe follows SIGKILL');
  for (const guest of ['immortal','foreign','unreadable','unreachable'] as const) {
    const f = fixture(), source = await f.owned(); f.setGuest(guest);
    await assert.rejects(source.close(), { code: 'video_stop_uncertain', outcome: 'unknown' }, guest);
    assert.equal(source.stopped, undefined, guest); assert.equal(f.captures, 1);
    const probes = f.probes.length;
    await assert.rejects(source.close(), { code: 'video_stop_uncertain' }, guest + ' stays unknown on retry');
    assert.equal(f.probes.length, probes);
  }
  const foreignAvd = fixture(), moved = await foreignAvd.owned(); foreignAvd.setForeign();
  await assert.rejects(moved.close(), { code: 'video_stop_uncertain' }); assert.deepEqual(foreignAvd.signals, [], 'no signal reaches another AVD');
  const unassigned = fixture(), ended = await unassigned.owned(); unassigned.endAssignment();
  await assert.rejects(ended.close(), { code: 'video_stop_uncertain' }); assert.equal(unassigned.probes.length, 0, 'assignment loss prohibits guest cleanup');
});

test('Android cancellation racing a normal finish proves the already exited recorder without a signal', async () => {
  const f = fixture(), source = await f.owned();
  await source.read(65536, 1000); await source.read(65536, 1000);
  let release!: (data: Uint8Array) => void;
  f.native.read = () => new Promise<Uint8Array>(resolve => { release = resolve; });
  f.native.close = async () => { release(Buffer.alloc(0)); };
  f.native.wait = async () => 143; // adb reaped by close, not a successful remote exit
  f.setGuest('absent'); // screenrecord reached its own time limit at the same moment
  const pending = source.read(65536, 1000);
  await new Promise(resolve => setImmediate(resolve));
  const closing = source.close();
  await assert.rejects(pending); await closing;
  assert.equal(source.stopped, 'absent'); assert.deepEqual(f.signals, []);
  await assert.rejects(source.wait(1000));
});

test('Android capture without a valid recorder identity never claims cleanup', async () => {
  for (const header of ['', 'garbled\n', `canaveral-recorder ${BOOT} 4321 (screenrecord) R 1\n`, `canaveral-recorder not-a-boot 4321 (sh) ${'0 '.repeat(19)}${START}\n`, 'x'.repeat(2048)]) {
    const f = fixture(); f.chunks.splice(0, 1, ...(header ? [Buffer.from(header)] : []));
    const source = await f.owned();
    assert.equal(source.recorder, undefined); await assert.rejects(source.read(65536, 1000));
    await assert.rejects(source.close(), { code: 'video_stop_uncertain' }); assert.equal(f.probes.length, 0); assert.equal(f.closes, 1);
  }
  // Authority lost after the guest started still returns the source, so cleanup can be proven.
  const f = fixture(), original = f.native.read;
  f.native.read = async (count, ms) => { f.replace(); f.native.read = original; return original(count, ms); };
  const source = await f.owned();
  await assert.rejects(source.read(65536, 1000), /boot identity/);
  await source.close(); assert.equal(source.stopped, 'absent'); assert.deepEqual(f.signals, ['TERM']);
});

test('Android recorder commands are bounded, quoted by construction and shell-parsable', () => {
  // A zombie main thread counts as exited only when no other thread remains.
  assert.match(recorderStopCommand({ boot: BOOT, pid: 4321, start: START }), /ls \/proc\/4321\/task/);
  assert.deepEqual(parseRecorderHeader(HEADER.trim()), { boot: BOOT, pid: 4321, start: START });
  for (const bad of [{ boot: BOOT + ';reboot', pid: 1, start: '1' }, { boot: BOOT, pid: 0, start: '1' }, { boot: BOOT, pid: 1.5, start: '1' }, { boot: BOOT, pid: 1, start: '1;x' }])
    assert.throws(() => recorderStopCommand(bad), /identity/);
  assert.throws(() => recorderCommand(181, 4000000)); assert.throws(() => recorderCommand(10, 1));
  const recorder = { boot: BOOT, pid: 4321, start: START };
  for (const script of [recorderCommand(180, 20000000), recorderStopCommand(recorder), recorderStopCommand(recorder, 'TERM'), recorderStopCommand(recorder, 'KILL')]) {
    const parsed = spawnSync('/bin/sh', ['-n', '-c', script]); assert.equal(parsed.status, 0, String(parsed.stderr));
  }
  assert.doesNotMatch(recorderStopCommand(recorder), /kill/); assert.match(recorderStopCommand(recorder, 'TERM'), /kill -TERM 4321 /);
});

// Linux /proc gives the same identity fields as the Android guest kernel.
test('Android recorder stop command identifies, signals and confirms a real process', { skip: process.platform !== 'linux' }, async () => {
  const child = spawn('/bin/sh', ['-c', recorderCommand(10, 4000000).replace(/exec screenrecord.*$/, 'while :; do sleep 1; done')], { stdio: ['ignore', 'pipe', 'inherit'] });
  const exited = new Promise(resolve => child.once('exit', resolve));
  try {
    const line = await new Promise<string>(resolve => { let text = ''; child.stdout.on('data', data => { text += data; if (text.includes('\n')) resolve(text.split('\n')[0]!); }); });
    const recorder = parseRecorderHeader(line), run = (script: string) => spawnSync('/bin/sh', ['-c', script], { encoding: 'utf8' }).stdout.trim();
    assert.equal(recorder.pid, child.pid);
    assert.equal(run(recorderStopCommand({ ...recorder, start: String(Number(recorder.start) + 1) }, 'TERM')), 'canaveral-recorder replaced');
    assert.equal(run(recorderStopCommand({ ...recorder, boot: '00000000-0000-4000-8000-000000000000' }, 'TERM')), 'canaveral-recorder rebooted');
    assert.equal(child.exitCode, null, 'mismatched identities never signal');
    assert.equal(run(recorderStopCommand(recorder)), 'canaveral-recorder running');
    assert.equal(run(recorderStopCommand(recorder, 'TERM')), 'canaveral-recorder running');
    await exited;
    assert.match(run(recorderStopCommand(recorder)), /^canaveral-recorder (absent|replaced)$/);
  } finally { child.kill('SIGKILL'); }
});

test('an Android capture refused before its recorder is spawned is marked as running nothing; a failure after the spawn is not', async () => {
  // Authorization that has ended, a device that is not ready or not owned, a missing boot identity
  // and invalid options are all found before anything is spawned.
  for (const prepare of [(f: ReturnType<typeof fixture>) => f.revoke(), (f: ReturnType<typeof fixture>) => f.notBooted(), (f: ReturnType<typeof fixture>) => f.setForeign(), (f: ReturnType<typeof fixture>) => f.noEpoch()]) {
    const f = fixture(); prepare(f);
    const error = await f.owned().then(() => undefined, (caught: unknown) => caught);
    assert.ok(error instanceof Error); assert.equal(captureNotRunning(error), true); assert.equal(f.captures, 0);
  }
  const invalid = fixture(), refused = await invalid.owned({ ...invalid.options, fps: 60 }).then(() => undefined, (caught: unknown) => caught);
  assert.equal(captureNotRunning(refused), true); assert.equal(invalid.captures, 0);
  // Authorization that ends between two preflight steps, as when a viewer leaves while its
  // capture is still being opened.
  const leaving = fixture(); let checks = 0;
  const left = await openAndroidVideo(leaving.provider, leaving.machine, leaving.image, '/fixture', leaving.options, () => checks++ < 1).then(() => undefined, (caught: unknown) => caught);
  assert.ok(left instanceof Error); assert.equal(captureNotRunning(left), true); assert.equal(leaving.captures, 0);
  assert.ok(leaving.calls.includes('boot'), 'the refusal came after the first preflight step');
  // Once the recorder is spawned the source is returned so its owner can prove cleanup; a later
  // failure says nothing about what still runs.
  const spawned = fixture(), pipe = await spawned.owned();
  assert.equal(spawned.captures, 1); spawned.revoke();
  const later = await pipe.read(65536, 1000).then(() => undefined, (caught: unknown) => caught);
  assert.ok(later instanceof Error); assert.equal(captureNotRunning(later), false);
  assert.equal(captureNotRunning(undefined), false); assert.equal(captureNotRunning(new Error('unmarked')), false);
});
