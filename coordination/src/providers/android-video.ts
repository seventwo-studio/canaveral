/** Native AVC capture through one assignment-owned ADB shell-v2 connection.
 * screenrecord flushes H.264 stdout; timestamps and MP4 muxing belong downstream.
 */
import { ServiceError } from '../errors.ts';
import { authorized, canonical, integer, unsupported } from './mobile.ts';
import { MAX_VIDEO_READ_MS } from '../mobile-video.ts';
import type { Authorized, NativePipe, RecordValue } from './mobile.ts';
import type { AndroidProvider } from './android.ts';

export interface AndroidVideoOptions { durationSeconds: number; bitRate: number; fps: number }
function stopUncertain(): ServiceError {
  return new ServiceError('Android capture connection closed without positive guest completion; inspect the bounded recorder before reopening.', 409,
    { code: 'video_stop_uncertain', outcome: 'unknown', retryable: false });
}
function timeout(value: number): number { return integer(value, 'video pipe timeout', 1, MAX_VIDEO_READ_MS); }

export async function openAndroidVideo(provider: AndroidProvider, machine: RecordValue, image: RecordValue, _folder: string,
  options: AndroidVideoOptions, check: Authorized): Promise<NativePipe> {
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
  const epoch = canonical(initial), elapsed = provider.transport.elapsed ?? (() => performance.now() / 1000);
  let lastNativeCheck = elapsed();
  if (!Number.isFinite(lastNativeCheck)) throw new ServiceError('Android capture clock is unavailable.', 409);
  // -T preserves binary bytes; omitting -x retains separate stderr and remote exit status.
  const native = await provider.pipe([provider.tool('adb'), '-s', serial, 'shell', '-T', '-n', 'screenrecord',
    '--output-format=h264', '--bit-rate', String(bitRate), '--time-limit', String(seconds), '-']);
  let completed = false, closed = false, reading = false, failure: unknown, closing: Promise<void> | undefined, nativeCheck: Promise<void> | undefined;
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
        await provider.owned(machine, serial); await authorized(check);
        if (canonical(provider.displayEpoch(machine, image) ?? null) !== epoch) throw new ServiceError('Android capture boot identity changed.', 410);
        lastNativeCheck = elapsed();
      })().finally(() => { nativeCheck = undefined; });
      await nativeCheck;
    }
    await authorized(check);
  };
  const interrupted = async (error: unknown): Promise<never> => {
    failure ??= error;
    try { await closeNative(); } catch { /* A lost close acknowledgement cannot prove guest stop. */ }
    throw failure;
  };
  try {
    await native.end(); await guard();
    // This also revokes a stalled reader; native identity probes are capped at once a second.
    let checking = false;
    timer = setInterval(() => {
      if (checking || completed || closed) return;
      checking = true;
      void guard().catch(error => interrupted(error).catch(() => {})).finally(() => { checking = false; });
    }, 250);
    timer.unref();
  } catch (error) { return interrupted(error); }
  return {
    async read(maximum, timeoutMs) {
      integer(maximum, 'video read size', 1, 65536); timeout(timeoutMs);
      if (reading) throw new ServiceError('Android video already has a pending read.', 409);
      if (failure) throw failure;
      if (closed) throw stopUncertain();
      if (completed) return Buffer.alloc(0);
      reading = true;
      try {
        await guard();
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
    async close() {
      await closeNative();
      // Reaping adb alone cannot prove its guest encoder stopped after cancellation.
      if (!completed) throw stopUncertain();
    },
  };
}
