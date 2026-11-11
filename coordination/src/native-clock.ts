import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { ServiceError } from './errors.ts';
import { noLinks } from './runtime-process.ts';
import type { ExecutionClock } from './runtime-process.ts';

const unavailable = (): ServiceError => new ServiceError('Native lease clock is unavailable; retain existing execution deadlines.', 503, { retryable: false, outcome: 'unknown' });

/** Explicit installed helper only. No command runs at import time.
 * The helper uses CLOCK_BOOTTIME on Linux and continuous Mach time on Darwin.
 * Every observation is fresh; awake-only elapsed time is never used after sleep.
 */
export function nativeExecutionClock(helper: string): ExecutionClock {
  if (typeof helper !== 'string' || !isAbsolute(helper) || !['linux', 'darwin'].includes(process.platform)) throw new ServiceError('Configure an absolute Unix native clock helper.', 400);
  const options = { env: {}, encoding: 'utf8' as const, timeout: 1000, killSignal: 'SIGKILL' as const, maxBuffer: 1024, stdio: 'pipe' as const, windowsHide: true };
  const uid = BigInt(process.getuid!());
  const fingerprint = (): string => {
    noLinks(helper);
    for (let parent = dirname(helper); ; parent = dirname(parent)) {
      const directory = lstatSync(parent, { bigint: true });
      // A root-owned sticky temporary directory protects its owned child entry.
      const stickyRoot = directory.uid === 0n && (directory.mode & 0o1000n) !== 0n;
      if (!directory.isDirectory() || directory.uid !== 0n && directory.uid !== uid || (directory.mode & 0o022n) !== 0n && !stickyRoot) throw unavailable();
      if (dirname(parent) === parent) break;
    }
    const info = lstatSync(helper, { bigint: true });
    if (!info.isFile() || info.nlink !== 1n || (info.mode & 0o111n) === 0n || (info.mode & 0o022n) !== 0n ||
        (info.uid !== 0n && info.uid !== uid)) throw unavailable();
    return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs, info.mode, info.uid].join(':');
  };
  let identity: string, bootId: string;
  try {
    identity = fingerprint();
    const raw = process.platform === 'linux' ? readFileSync('/proc/sys/kernel/random/boot_id', 'utf8') : execFileSync('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid'], options);
    bootId = raw.trim().toLowerCase();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(bootId) || /^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(bootId)) throw unavailable();
  } catch { throw unavailable(); }
  let last = -1, failed = false;
  const now = (): number => {
    if (failed) throw unavailable();
    try {
      if (fingerprint() !== identity) throw unavailable();
      const output = execFileSync(helper, ['clock'], options).trim();
      const value = Number(output);
      if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/.test(output) || !Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER || value < last || fingerprint() !== identity) throw unavailable();
      last = value; return value;
    } catch { failed = true; throw unavailable(); }
  };
  now();
  return { suspendAware: true, bootId, now, wall: () => Date.now() / 1000 };
}
