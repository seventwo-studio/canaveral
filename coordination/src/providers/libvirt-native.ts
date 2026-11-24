import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { release } from "node:os";
import { dirname, isAbsolute, normalize } from "node:path";
import type { Socket } from "node:net";
import { ServiceError } from "../errors.ts";
import { linuxLibvirtBirth } from "./libvirt-process.ts";
import { hash, noSymlinks, refuse } from "./libvirt-ownership.ts";
import type { LeaseFence, LibvirtAdapters, LibvirtLeaseNative } from "./libvirt.ts";
import type { RecordValue } from "./libvirt-ownership.ts";

// The libvirt lease guardian takes the daemon's pidfd from its inherited socket with
// SO_PEERPIDFD, which Linux added in 6.5. Older kernels cannot offer libvirt leases.
const unverified = (): ServiceError => new ServiceError("The configured libvirt lease helper could not be verified.", 409, { code: "libvirt_lease_helper_unverified" });
const unsupportedKernel = (): ServiceError => new ServiceError("Libvirt leases need Linux 6.5 or later for Unix peer pidfds.", 409, { code: "libvirt_lease_kernel_unsupported" });
/** Exit status of `canaveral-libvirt-native check` when the kernel lacks SO_PEERPIDFD (EX_CONFIG). */
const KERNEL_EXIT = 78;
/** Exit status of `fence` while a live guardian holds the lease lock (EX_TEMPFAIL). */
const BUSY_EXIT = 75;
const HELPER_LIMIT = 64 * 1048576;
type HelperPin = { path: string; sha256: string };

export function libvirtLeaseKernelSupported(kernel: string = release()): boolean {
  const match = /^(\d+)\.(\d+)[.-]/.exec(kernel + ".");
  return !!match && (Number(match[1]) > 6 || Number(match[1]) === 6 && Number(match[2]) >= 5);
}

/** The configured helper: an absolute, normalized path and its pinned SHA-256. */
export function libvirtLeaseHelper(config: RecordValue | undefined): HelperPin | undefined {
  if (config?.leaseHelper === undefined && config?.leaseHelperSha256 === undefined) return undefined;
  const path = config.leaseHelper, sha256 = config.leaseHelperSha256;
  if (typeof path !== "string" || !isAbsolute(path) || normalize(path) !== path || typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256)) {
    throw new ServiceError("Configure leaseHelper as an absolute path with its leaseHelperSha256.", 400);
  }
  return { path, sha256 };
}

/** Reads the root-owned helper through one descriptor and checks its pinned digest. The daemon
 * then executes exactly that descriptor, never the configured path again. */
function verifiedHelper(path: string, sha256: string): number {
  // A root daemon could replace a root-owned helper itself.
  const uid = process.getuid?.();
  if (!uid || uid !== process.geteuid?.()) throw unverified();
  let fd: number | undefined;
  try {
    noSymlinks(path);
    for (let parent = dirname(path); ; parent = dirname(parent)) {
      const directory = fs.lstatSync(parent);
      if (!directory.isDirectory() || directory.uid !== 0 || (directory.mode & 0o022)) throw unverified();
      if (dirname(parent) === parent) break;
    }
    // Even a nonroot daemon may have been granted write access.
    try {
      fs.accessSync(path, fs.constants.W_OK);
      throw unverified();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EACCES" && (error as NodeJS.ErrnoException).code !== "EROFS") throw error;
    }
    fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const before = fs.fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.uid !== 0n || before.nlink !== 1n || (before.mode & 0o6022n) || (before.mode & 0o111n) === 0n || before.size > BigInt(HELPER_LIMIT)) throw unverified();
    const bytes = fs.readFileSync(fd);
    const after = fs.fstatSync(fd, { bigint: true });
    if (after.ctimeNs !== before.ctimeNs || after.ino !== before.ino || after.size !== BigInt(bytes.length) || hash(bytes) !== sha256) throw unverified();
    return fd;
  } catch {
    if (fd !== undefined) fs.closeSync(fd);
    throw unverified();
  }
}

/** The child executes its inherited descriptor 3: the verified helper inode. */
const descriptorExecutable = "/proc/self/fd/3";
const helperEnv = (): Record<string, string> => ({ PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C", LC_ALL: "C" });

function runVerifiedHelper(helper: HelperPin, mode: "check" | "clock", timeout: number): string {
  const fd = verifiedHelper(helper.path, helper.sha256);
  try {
    const result = spawnSync(descriptorExecutable, [mode], {
      stdio: ["ignore", "pipe", "ignore", fd], argv0: helper.path, env: helperEnv(),
      encoding: "utf8", timeout, killSignal: "SIGKILL", maxBuffer: 1024,
    });
    if (mode === "check" && result.status === KERNEL_EXIT) throw unsupportedKernel();
    if (result.error || result.status !== 0) throw unverified();
    return result.stdout;
  } finally { fs.closeSync(fd); }
}

/** Inventory check: helper identity and the kernel's peer pidfd support. */
export function checkLibvirtLeaseHelper(config: RecordValue, kernel: string = release()): void {
  const helper = libvirtLeaseHelper(config);
  if (!helper) throw unverified();
  if (process.platform !== "linux" || !libvirtLeaseKernelSupported(kernel)) throw unsupportedKernel();
  if (!/^\d+(?:\.\d+)?\n$/.test(runVerifiedHelper(helper, "check", 5000))) throw unverified();
}

export function libvirtLeaseClockSample(path: string, sha256: string): string {
  return runVerifiedHelper({ path, sha256 }, "clock", 1000);
}

/** CLOCK_BOOTTIME seconds: /proc/uptime counts suspended time, like the guardian's clock. */
export function linuxBootClock(): number {
  const sample = /^(\d+\.\d+) /.exec(fs.readFileSync("/proc/uptime", "ascii"));
  if (!sample) refuse("The Linux boot clock is unavailable.");
  return Number(sample[1]);
}

/** Production lease adapters bound to the configured, pinned helper. */
export function productionLibvirtAdapters(config: RecordValue): LibvirtAdapters {
  const helper = libvirtLeaseHelper(config);
  if (!helper || process.platform !== "linux") return {};
  const { path, sha256 } = helper;
  const args = (folder: string, parent: number): string[] => [path, "guard", folder, String(parent)];
  const peers = new Set<Socket>();

  /** Runs one bounded helper command; anything but the exact reply is unconfirmed. */
  function work(argv: string[], expected: string, timeout: number): Promise<{ status: number | null; ok: boolean }> {
    let fd: number;
    try { fd = verifiedHelper(path, sha256); } catch { return Promise.resolve({ status: null, ok: false }); }
    return new Promise(resolve => {
      let output = "", settled = false;
      const done = (status: number | null): void => { if (!settled) { settled = true; resolve({ status, ok: status === 0 && output === expected + "\n" }); } };
      try {
        const child = spawn(descriptorExecutable, argv, { stdio: ["ignore", "pipe", "ignore", fd], argv0: path, env: helperEnv() });
        const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
        child.stdout!.setEncoding("utf8").on("data", (part: string) => { output += part; if (output.length > 64) child.kill("SIGKILL"); });
        child.once("error", () => { clearTimeout(timer); done(null); });
        child.once("close", status => { clearTimeout(timer); done(status); });
      } catch { done(null); }
      finally { fs.closeSync(fd); }
    });
  }

  const native: LibvirtLeaseNative = {
    helper: { path, sha256 },
    arguments: args,
    birth: linuxLibvirtBirth,
    launch(folder, parent) {
      const fd = verifiedHelper(path, sha256);
      try {
        const child = spawn(descriptorExecutable, args(folder, parent).slice(1), { stdio: ["pipe", "ignore", "ignore", fd], argv0: path, env: helperEnv() });
        // libuv creates this stdin as a Unix socketpair. The guardian reads the daemon's pidfd
        // from its peer (SO_PEERPIDFD); no lease data ever crosses it.
        const peer = child.stdin as Socket;
        peers.add(peer);
        peer.on("error", () => {});
        peer.unref();
        child.once("exit", () => { peers.delete(peer); peer.destroy(); });
        child.on("error", () => { /* A missing birth stays unknown and is fenced. */ });
        child.unref();
        const pid = child.pid ?? 0, birth = linuxLibvirtBirth(pid);
        if (typeof birth !== "object") refuse("The lease guardian birth could not be recorded.");
        return { pid, createdAt: birth.createdAt };
      } finally { fs.closeSync(fd); }
    },
    async fence(folder): Promise<LeaseFence> {
      const result = await work(["fence", folder], "stopped", 90_000);
      return result.ok ? "stopped" : result.status === BUSY_EXIT ? "busy" : "unconfirmed";
    },
    async erase(folder, quarantine) { return (await work(["erase", folder, quarantine], "erased", 180_000)).ok; },
    close() { for (const peer of peers) peer.destroy(); peers.clear(); },
  };
  return { clock: linuxBootClock, lease: native };
}
