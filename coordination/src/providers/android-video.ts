/** Native AVC capture through one assignment-owned ADB shell-v2 connection.
 * screenrecord flushes H.264 stdout; timestamps and MP4 muxing belong downstream.
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { ServiceError } from '../errors.ts';
import { authorized, canonical, integer, markCaptureNotRunning, unsupported } from './mobile.ts';
import { MAX_VIDEO_READ_MS } from '../mobile-video.ts';
import type { Authorized, NativePipe, RecordValue } from './mobile.ts';
import type { AndroidProvider } from './android.ts';

export interface AndroidVideoOptions { durationSeconds: number; bitRate: number; fps: number }
/** The exact guest recorder this capture started: kernel boot, PID and process start time. */
export interface AndroidRecorder { boot: string; pid: number; start: string }
/** How cleanup established that the recorder no longer runs. */
export type AndroidRecorderStop = 'absent' | 'replaced' | 'rebooted' | 'exited';
export interface AndroidVideoPipe extends NativePipe {
  /** Recorder identity from the guest header, once read. */
  readonly recorder: AndroidRecorder | undefined;
  /** Positive early-cancellation cleanup evidence, once proven. */
  readonly stopped: AndroidRecorderStop | undefined;
  /** Signals cleanup sent to the still running recorder, in order. */
  readonly signalled: readonly ('TERM' | 'KILL')[];
}

const MARK = 'canaveral-recorder';
const HEADER_BYTES = 1024, HEADER_MS = 10000;
/** Grace for screenrecord's own SIGTERM teardown, then SIGKILL, then a last bounded wait. */
export const RECORDER_TERM_SECONDS = 3, RECORDER_KILL_SECONDS = 3;
const PROBE_MS = 200, PROBE_TIMEOUT_MS = 10000, OWNED_TIMEOUT_MS = 5000;
const POSITIVE = new Set<string>(['absent', 'replaced', 'rebooted', 'exited']);

function stopUncertain(): ServiceError {
  return new ServiceError('Android capture connection closed without positive guest completion; inspect the bounded recorder before reopening.', 409,
    { code: 'video_stop_uncertain', outcome: 'unknown', retryable: false });
}
function timeout(value: number): number { return integer(value, 'video pipe timeout', 1, MAX_VIDEO_READ_MS); }

/** The shell prints its own boot and process identity, then execs screenrecord, which keeps
 * that PID and start time. Output is stdout only: no guest file is created. */
export function recorderCommand(seconds: number, bitRate: number): string {
  return `echo "${MARK} $(cat /proc/sys/kernel/random/boot_id) $(cat /proc/$$/stat)"; ` +
    `exec screenrecord --output-format=h264 --bit-rate ${integer(bitRate, 'video bitrate', 100000, 20000000)} --time-limit ${integer(seconds, 'video duration', 1, 180)} -`;
}
/** Parses `MARK boot pid (comm) state ... starttime ...`; field 22 of /proc/PID/stat is starttime. */
export function parseRecorderHeader(line: string): AndroidRecorder {
  const match = /^canaveral-recorder ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}) ([1-9][0-9]{0,9}) \(sh\) (.*)$/.exec(line);
  const fields = match?.[3]!.split(' ');
  if (!match || !fields || fields.length < 20 || !/^[0-9]{1,20}$/.test(fields[19]!)) throw new ServiceError('Android recorder identity was not reported.', 409, { outcome: 'unknown' });
  return { boot: match[1]!, pid: Number(match[2]), start: fields[19]! };
}
/** Checks the exact recorder and optionally signals only that process. The boot, PID and start
 * time are compared in the same guest shell immediately before the signal; no name match is used. */
export function recorderStopCommand(recorder: AndroidRecorder, signal?: 'TERM' | 'KILL'): string {
  const { boot, pid, start } = recorder;
  if (!/^[0-9a-f-]{36}$/.test(boot) || !Number.isSafeInteger(pid) || pid < 1 || !/^[0-9]{1,20}$/.test(start)) throw new ServiceError('Invalid Android recorder identity.', 409, { outcome: 'unknown' });
  return 'set -f; b=$(cat /proc/sys/kernel/random/boot_id) || exit 3; ' +
    `if [ "$b" != ${boot} ]; then echo ${MARK} rebooted; exit 0; fi; ` +
    `if ! s=$(cat /proc/${pid}/stat 2>/dev/null); then if [ -e /proc/${pid} ]; then echo ${MARK} unreadable; else echo ${MARK} absent; fi; exit 0; fi; ` +
    'set -- $s; ' +
    `if [ "\${22}" != ${start} ]; then echo ${MARK} replaced; exit 0; fi; ` +
    `case "$2" in "(sh)"|"(screenrecord)") ;; *) echo ${MARK} foreign; exit 0;; esac; ` +
    // A zombie main thread is exited only when no other thread of the process remains.
    `case "$3" in Z|X|x) if [ "$(ls /proc/${pid}/task 2>/dev/null)" = ${pid} ]; then echo ${MARK} exited; else echo ${MARK} running; fi; exit 0;; esac; ` +
    (signal ? `kill -${signal} ${pid} 2>/dev/null; ` : '') + `echo ${MARK} running`;
}

/** Stops the exact recorder this capture started and waits for positive evidence that it exited.
 * Any unreachable device, ownership doubt, unreadable state or timeout is unknown, never cleaned. */
export async function stopAndroidRecorder(provider: AndroidProvider, machine: RecordValue, serial: string, recorder: AndroidRecorder,
  allowed: Authorized, elapsed: () => number, signalled: ('TERM' | 'KILL')[] = []): Promise<AndroidRecorderStop> {
  const step = async (signal?: 'TERM' | 'KILL'): Promise<string> => {
    await authorized(allowed);
    if (signal) { await provider.owned(machine, serial, { timeoutMs: OWNED_TIMEOUT_MS }); await authorized(allowed); }
    const output = await provider.adb(serial, ['shell', recorderStopCommand(recorder, signal)], { timeoutMs: PROBE_TIMEOUT_MS });
    const state = /^canaveral-recorder (absent|replaced|rebooted|exited|running|foreign|unreadable)$/.exec(output)?.[1];
    if (!state || state === 'foreign' || state === 'unreadable') throw new ServiceError('Android recorder state is uncertain.', 409, { outcome: 'unknown' });
    if (signal && state === 'running') signalled.push(signal);
    return state;
  };
  const begun = elapsed();
  if (!Number.isFinite(begun)) throw new ServiceError('Android cleanup clock is unavailable.', 409, { outcome: 'unknown' });
  let state = await step('TERM'), killed = false, probedAfterKill = false;
  for (;;) {
    if (POSITIVE.has(state)) return state as AndroidRecorderStop;
    const spent = elapsed() - begun;
    if (!Number.isFinite(spent) || spent < 0) throw new ServiceError('Android cleanup clock identity changed.', 409, { outcome: 'unknown' });
    // Give up only after SIGKILL was sent and at least one later probe still saw the recorder.
    if (spent >= RECORDER_TERM_SECONDS + RECORDER_KILL_SECONDS && killed && probedAfterKill) throw new ServiceError('Android recorder did not exit.', 409, { outcome: 'unknown' });
    await sleep(PROBE_MS);
    if (!killed && spent >= RECORDER_TERM_SECONDS) { killed = true; state = await step('KILL'); }
    else { state = await step(); if (killed) probedAfterKill = true; }
  }
}

export async function openAndroidVideo(provider: AndroidProvider, machine: RecordValue, image: RecordValue, _folder: string,
  options: AndroidVideoOptions, check: Authorized, cleanupCheck?: Authorized): Promise<AndroidVideoPipe> {
  // Everything before the recorder is spawned only validates and reads: a refusal here, including
  // authorization that ended meanwhile, provably started no capture and is marked as such.
  const preflight = async () => {
    const seconds = integer(options.durationSeconds, 'video duration', 1, 180), bitRate = integer(options.bitRate, 'video bitrate', 100000, 20000000);
    if (options.fps !== 30 || Object.keys(options).some(key => !['durationSeconds','bitRate','fps'].includes(key))) throw new ServiceError('Android video requests a 30 fps target with bounded duration and bitrate.', 400);
    provider.executionAllowed(machine); await authorized(check);
    if (image.os !== 'android' || machine.desired !== 'running') throw new ServiceError('Android video requires a running Android assignment.', 409);
    if (!provider.transport?.pipe) unsupported('Native Android video pipe transport is not configured.');
    const storage = provider.storage(machine, image), serial = await provider.endpoint(machine, storage, check);
    if (!serial || await provider.adb(serial, ['shell','getprop','sys.boot_completed']) !== '1') throw new ServiceError('Android device is not ready.', 409);
    await authorized(check); await provider.owned(machine, serial); await authorized(check);
    const initial = provider.displayEpoch(machine, image);
    if (!initial) throw new ServiceError('Android capture requires an owned boot identity.', 409);
    const epoch = canonical(initial), elapsed = provider.transport.elapsed ?? (() => performance.now() / 1000), started = elapsed();
    if (!Number.isFinite(started)) throw new ServiceError('Android capture clock is unavailable.', 409);
    return { seconds, bitRate, serial, epoch, elapsed, started };
  };
  const { seconds, bitRate, serial, epoch, elapsed, started } = await preflight().catch(error => { throw markCaptureNotRunning(error); });
  let lastNativeCheck = started;
  // -T preserves binary bytes; omitting -x retains separate stderr and remote exit status.
  const native = await provider.pipe([provider.tool('adb'), '-s', serial, 'shell', '-T', '-n', recorderCommand(seconds, bitRate)]);
  let completed = false, closed = false, reading = false, failure: unknown, closing: Promise<void> | undefined, nativeCheck: Promise<void> | undefined;
  const signalled: ('TERM' | 'KILL')[] = [];
  let recorder: AndroidRecorder | undefined, stopped: AndroidRecorderStop | undefined, cleanup: Promise<void> | undefined, pending: Buffer = Buffer.alloc(0);
  let timer: ReturnType<typeof setInterval> | undefined;
  const closeNative = (): Promise<void> => {
    if (timer) clearInterval(timer);
    closed = true;
    closing ??= native.close(); return closing;
  };
  const guard = async () => {
    if (failure) throw failure;
    await authorized(check);
    if (canonical(provider.displayEpoch(machine, image) ?? null) !== epoch) throw new ServiceError('Android capture boot identity changed.', 410);
    const now = elapsed();
    if (!Number.isFinite(now) || now < lastNativeCheck) throw new ServiceError('Android capture clock identity changed.', 410);
    if (now - lastNativeCheck >= 1) {
      nativeCheck ??= (async () => {
        await provider.ownedLive(machine, image, serial, check); await authorized(check);
        if (canonical(provider.displayEpoch(machine, image) ?? null) !== epoch) throw new ServiceError('Android capture boot identity changed.', 410);
        lastNativeCheck = elapsed();
      })().finally(() => { nativeCheck = undefined; });
      await nativeCheck;
    }
    await authorized(check);
  };
  const interrupted = async (error: unknown): Promise<never> => {
    failure ??= error;
    try { await closeNative(); } catch { /* close() proves or refuses guest cleanup. */ }
    throw failure;
  };
  const header = async (): Promise<void> => {
    const deadline = performance.now() + HEADER_MS;
    let line = Buffer.alloc(0);
    for (;;) {
      const bytes = await native.read(HEADER_BYTES, Math.max(1, Math.ceil(deadline - performance.now())));
      if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > HEADER_BYTES) throw new ServiceError('Android recorder identity was not reported.', 409, { outcome: 'unknown' });
      line = Buffer.concat([line, bytes]);
      const end = line.indexOf(10);
      if (end >= 0 && end < HEADER_BYTES) { recorder = parseRecorderHeader(line.subarray(0, end).toString('latin1')); pending = line.subarray(end + 1); return; }
      if (line.length >= HEADER_BYTES) throw new ServiceError('Android recorder identity was not reported.', 409, { outcome: 'unknown' });
    }
  };
  try {
    await native.end(); await header(); await guard();
    // This also revokes a stalled reader; native identity probes are capped at once a second.
    let checking = false;
    timer = setInterval(() => {
      if (checking || completed || closed) return;
      checking = true;
      void guard().catch(error => interrupted(error).catch(() => {})).finally(() => { checking = false; });
    }, 250);
    timer.unref();
  } catch (error) {
    // Once the guest may run, return the source so its owner can prove cleanup through close().
    failure ??= error; try { await closeNative(); } catch { /* close() decides. */ }
  }
  return {
    get recorder() { return recorder; },
    get stopped() { return stopped; },
    get signalled() { return [...signalled]; },
    async read(maximum, timeoutMs) {
      integer(maximum, 'video read size', 1, 65536); timeout(timeoutMs);
      if (reading) throw new ServiceError('Android video already has a pending read.', 409);
      if (failure) throw failure;
      if (closed) throw stopUncertain();
      if (completed) return Buffer.alloc(0);
      reading = true;
      try {
        await guard();
        if (pending.length) { const bytes = pending.subarray(0, maximum); pending = pending.subarray(bytes.length); return bytes; }
        const bytes = await native.read(maximum, timeoutMs);
        await guard();
        if (!(bytes instanceof Uint8Array) || bytes.length > maximum) throw new ServiceError('Android capture exceeded its bounded read.', 409);
        if (!bytes.length) {
          if (await native.wait(timeoutMs) !== 0) throw new ServiceError('Android capture ended without a successful remote exit.', 409, { outcome: 'unknown' });
          await guard(); completed = true; if (timer) clearInterval(timer);
        }
        return bytes;
      } catch (error) { return interrupted(error); }
      finally { reading = false; }
    },
    async write() { throw new ServiceError('Android video capture is read-only.', 400); },
    async end() { /* Native capture has no input channel. */ },
    async wait(timeoutMs) {
      timeout(timeoutMs);
      if (failure) throw failure;
      if (!completed) throw new ServiceError('Drain Android capture to a positively acknowledged end before completion.', 409);
      return 0;
    },
    close() {
      cleanup ??= (async () => {
        try { await closeNative(); } catch { /* The host adb client is not the guest recorder. */ }
        // A successful remote exit after EOF proves the recorder ended on its own.
        if (completed) return;
        // Reaping adb alone cannot prove its guest encoder stopped after cancellation:
        // stop the exact recorder under current assignment authority and confirm it exited.
        if (!recorder || !cleanupCheck) throw stopUncertain();
        try { stopped = await stopAndroidRecorder(provider, machine, serial, recorder, cleanupCheck, elapsed, signalled); }
        catch { throw stopUncertain(); }
      })();
      return cleanup;
    },
  };
}
