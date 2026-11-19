/** Continuous native H.264 capture; frame acquisition never uses screenshots or input locks. */
import { ServiceError } from "../errors.ts";
import { authorized, unsupported } from "./mobile.ts";
import { MAX_VIDEO_READ_MS } from "../mobile-video.ts";
import type { Authorized, NativePipe, RecordValue } from "./mobile.ts";
import type { IosProvider } from "./ios.ts";

export interface IosVideoOptions { durationSeconds: number; bitRate: number; fps: number }

/** idb's video-stream writes raw H.264 to stdout when its output filename is omitted.
 * Its CLI has no bitrate option: the caller's MP4 pipeline owns bitrate policy.
 * A finite-duration timer stops this retained process; the caller must still close on cancellation.
 * Upstream: https://github.com/meta/idb/blob/main/idb/cli/commands/video.py
 */
export async function openIosVideo(provider: IosProvider, machine: RecordValue, image: RecordValue, _folder: string, options: IosVideoOptions, check: Authorized): Promise<NativePipe> {
  if (!Number.isInteger(options.durationSeconds) || options.durationSeconds < 1 || options.durationSeconds > 180 || options.fps !== 30 || !Number.isInteger(options.bitRate) || options.bitRate < 100_000 || options.bitRate > 20_000_000) throw new ServiceError("Invalid native iOS video options.", 400);
  await authorized(check);
  if (!provider.transport?.pipe) unsupported("Native iOS video pipe transport is not configured.");
  const udid = await provider.ready(machine, image);
  await authorized(check);
  const pipe = await provider.transport.pipe([String(provider.config.idb ?? "idb"), "video-stream", "--format", "h264", "--fps", "30", "--scale-factor", "1", "--udid", udid], { env: { ...provider.idbEnvironment(), PYTHONUNBUFFERED: "1" }, timeoutMs: 30000, maxBytes: 65536 });
  let stopped: Promise<void> | undefined, reason: "duration" | "cancelled" | "failed" | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  let reading = false, checkedAt = Number.NEGATIVE_INFINITY;
  let nativeRead: Promise<Uint8Array> | undefined;
  const take = (maximum: number, timeoutMs: number) => {
    const pending = pipe.read(maximum, timeoutMs); nativeRead = pending;
    return pending.finally(() => { if (nativeRead === pending) nativeRead = undefined; });
  };
  const stop = (cause: typeof reason): Promise<void> => {
    if (!stopped) {
      reason = cause; clearTimeout(timer);
      stopped = (async () => {
        let drain: Promise<void> | undefined;
        try {
          if (!pipe.interrupt) throw new ServiceError("Native iOS video requires confirmed graceful interruption.", 409, { outcome: "unknown" });
          let interrupted = false;
          const interrupt = pipe.interrupt().finally(() => { interrupted = true; });
          // idb must be able to flush stdout while acknowledging SIGINT. Stop forwarding
          // frames, but drain bounded chunks so a full pipe cannot prevent graceful exit.
          drain = (async () => {
            if (nativeRead) await nativeRead.catch(() => {});
            while (!interrupted) {
              try { if (!(await pipe.read(65536, 1000)).length) break; }
              catch { break; }
            }
          })();
          await interrupt;
        } finally {
          await pipe.close();
          if (drain) await drain;
          // NativePipe.close may be best effort. Positive exit of this retained child is required.
          if (await pipe.wait(3000) !== 0) throw new ServiceError("Native iOS video did not stop cleanly.", 409, { outcome: "unknown" });
        }
      })();
    }
    return stopped;
  };
  const close = () => stop("cancelled");
  const durationStopped = () => reason === "duration";
  const durationEnd = async () => { await stopped; await authorized(check); return Buffer.alloc(0); };
  const verify = async (force = false) => {
    await authorized(check);
    if (stopped) throw new ServiceError("Native iOS video source is closed.", 409);
    if (force || performance.now() - checkedAt >= 1000) {
      if (await provider.ready(machine, image) !== udid) throw new ServiceError("Owned simulator identity changed during native video capture.", 409);
      checkedAt = performance.now();
    }
    await authorized(check);
  };
  try { await verify(true); }
  catch (error) { await close(); throw error; }
  timer = setTimeout(() => { void stop("duration").catch(() => {}); }, options.durationSeconds * 1000);
  timer.unref();
  return {
    async read(maximum, timeoutMs) {
      if (!Number.isInteger(maximum) || maximum < 1 || maximum > 65536 || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_VIDEO_READ_MS) throw new ServiceError("Invalid native iOS video read envelope.", 400);
      if (reading) throw new ServiceError("Concurrent native iOS video reads are unsupported.", 409);
      reading = true;
      try {
        if (durationStopped()) return await durationEnd();
        await verify();
        const bytes = await take(maximum, timeoutMs);
        if (!(bytes instanceof Uint8Array) || bytes.length > maximum) throw new ServiceError("Native iOS video source exceeded its byte envelope.", 409);
        if (durationStopped()) return await durationEnd();
        if (!bytes.length) throw new ServiceError("Native iOS video ended before its duration limit.", 409, { outcome: "unknown" });
        await verify();
        return bytes;
      } catch (error) {
        if (durationStopped()) return durationEnd();
        await stop("failed"); throw error;
      }
      finally { reading = false; }
    },
    async write() { throw new ServiceError("Native iOS video is a read-only source.", 400); },
    async end() { throw new ServiceError("Close the owned native iOS video source to stop capture.", 400); },
    async wait(timeoutMs) {
      if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new ServiceError("Invalid native iOS video wait envelope.", 400);
      if (durationStopped()) { await stopped; await authorized(check); return 0; }
      const code = await pipe.wait(timeoutMs);
      if (durationStopped()) { await stopped; await authorized(check); return 0; }
      throw new ServiceError(code === 0 ? "Native iOS video ended before its duration limit." : "Native iOS video source failed.", 409, { outcome: "unknown" });
    },
    close,
  };
}
