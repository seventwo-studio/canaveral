import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { open } from "node:fs/promises";
import { dirname, join } from "node:path";
import { AppleProvider } from "../providers/apple.ts";
import { LibvirtProvider } from "../providers/libvirt.ts";
import { absolute, blocker, digest, missing, object, probe, ProbeError, record } from "./core.ts";
import type { BackendId, BackendRecord, Environment, HostConfigData } from "./core.ts";
import { containerdPromoted, promoted } from "./qualification.ts";
import type { ReceiptAsset } from "./qualification.ts";

export const receiptPath = "/var/lib/canaveral-host-installer/receipts/containerd.json";
export const installerInstruction = "Install canaveral-host-installer as root per its README, then run sudo canaveral-host-installer containerd install.";
const unit = "/etc/systemd/system/canaveral-containerd.service";
const configuration = "/etc/canaveral-containerd/config.toml";
const socket = "/run/canaveral-containerd/containerd.sock";
const receiptLimit = 64 * 1024;
const managedFileLimit = 64 * 1024 * 1024;

function checkAncestors(path: string, owner: number, inspect: typeof lstatSync): void {
  const ancestors = [];
  for (let parent = dirname(path); ; parent = dirname(parent)) {
    ancestors.unshift(parent);
    if (parent === dirname(parent)) break;
  }
  for (const ancestor of ancestors) {
    const stat = inspect(ancestor);
    if (!stat.isDirectory() || stat.uid !== owner || stat.mode & 0o022) throw new Error("Unsafe installer directory");
  }
}

export function readReceipt(path = receiptPath, owner = 0, inspect: typeof lstatSync = lstatSync): unknown {
  try {
    checkAncestors(path, owner, inspect);
    const entry = lstatSync(path);
    if (!entry.isFile() || entry.uid !== owner || entry.nlink !== 1 || (entry.mode & 0o7777) !== 0o644) throw new Error("Unsafe receipt file");
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = fstatSync(fd);
      if (stat.dev !== entry.dev || stat.ino !== entry.ino || stat.size > receiptLimit) throw new Error("Unsafe receipt identity");
      const bytes = Buffer.alloc(receiptLimit + 1);
      let size = 0;
      while (size < bytes.length) {
        const count = readSync(fd, bytes, size, bytes.length - size, size);
        if (!count) break;
        size += count;
      }
      if (size !== stat.size) throw new Error("Receipt size changed");
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size))) as unknown;
    } finally { closeSync(fd); }
  } catch (error) {
    if (missing(error)) return undefined;
    throw new ProbeError("containerd_receipt_invalid");
  }
}

function parseReceipt(value: unknown): { version: string; assets: ReceiptAsset[]; files: Map<string, string> } {
  const r = object(value);
  const assets = Array.isArray(r.assets) ? r.assets.map(object) : [];
  const files = Array.isArray(r.files) ? r.files.map(object) : [];
  if (r.type !== "canaveral-host-installer-receipt" || r.version !== 1 || r.component !== "containerd"
    || !Number.isSafeInteger(r.installedAt) || Number(r.installedAt) < 0 || r.unit !== unit || r.socket !== socket
    || assets.some(a => !["containerd", "runc", "cni-plugins"].includes(String(a.name))
      || typeof a.version !== "string" || !/^\d+\.\d+\.\d+$/.test(a.version) || !digest(a.sha256))
    || !assets.some(a => a.name === "containerd") || !assets.some(a => a.name === "runc")
    || new Set(assets.map(a => a.name)).size !== assets.length || !files.length
    || files.some(f => !absolute(f.path) || f.path === "/" || f.path.endsWith("/") || !digest(f.sha256))
    || new Set(files.map(f => f.path)).size !== files.length) {
    throw new ProbeError("containerd_receipt_invalid");
  }
  return {
    version: assets.find(a => a.name === "containerd")!.version as string,
    assets: assets.map(a => ({ name: String(a.name), version: String(a.version), sha256: String(a.sha256) })),
    files: new Map(files.map(f => [f.path as string, f.sha256 as string])),
  };
}

export async function matchesManagedFile(path: string, expected: string, mode: number,
  owner = 0, inspect: typeof lstatSync = lstatSync): Promise<boolean> {
  try {
    checkAncestors(path, owner, inspect);
    const entry = lstatSync(path);
    if (!entry.isFile() || entry.uid !== owner || entry.nlink !== 1 || (entry.mode & 0o7777) !== mode
      || entry.size > managedFileLimit) return false;
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const unchanged = async () => {
        const stat = await file.stat();
        return stat.dev === entry.dev && stat.ino === entry.ino && stat.size === entry.size
          && stat.mtimeMs === entry.mtimeMs && stat.ctimeMs === entry.ctimeMs;
      };
      if (!await unchanged()) return false;
      const hash = createHash("sha256");
      const buffer = Buffer.alloc(64 * 1024);
      for (let offset = 0; offset < entry.size;) {
        const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, entry.size - offset), offset);
        if (!bytesRead) return false;
        hash.update(buffer.subarray(0, bytesRead));
        offset += bytesRead;
      }
      return await unchanged() && hash.digest("hex") === expected;
    } finally { await file.close(); }
  } catch {
    return false;
  }
}

const hasPath = (env: Environment, path: string): boolean => {
  try { env.lstat(path); return true; }
  catch (error) { if (missing(error)) return false; throw error; }
};
const foreignPaths = [
  ...["/usr/sbin", "/usr/bin", "/sbin", "/bin", "/usr/local/sbin", "/usr/local/bin", "/snap/bin"]
    .flatMap(dir => ["containerd", "dockerd", "docker"].map(name => join(dir, name))),
  "/run/containerd/containerd.sock", "/run/docker.sock", "/etc/containerd/config.toml",
  ...["/etc/systemd/system", "/usr/lib/systemd/system", "/lib/systemd/system"]
    .flatMap(dir => ["containerd.service", "docker.service"].map(name => join(dir, name))),
];

async function containerd(env: Environment): Promise<BackendRecord> {
  const receipt = env.receipt();
  const owned = receipt === undefined ? undefined : parseReceipt(receipt);
  const installed = owned?.version;
  if (foreignPaths.some(path => !owned?.files.has(path) && hasPath(env, path))) {
    return record("containerd", true, installed ? "installed" : "unavailable", blocker(
      "containerd_foreign_install", "An existing containerd or Docker installation needs operator review.", installerInstruction,
    ), installed);
  }
  if (!owned) {
    return record("containerd", true, "absent", blocker("containerd_root_installer_required", installerInstruction));
  }
  // Only read paths emitted by the installer, never arbitrary paths from a receipt.
  const binaries = ["containerd", "containerd-shim-runc-v2", "ctr", "runc"]
    .map(name => `/opt/canaveral-containerd/${owned.version}/bin/${name}`);
  const paths = [unit, configuration, ...binaries];
  if (owned.files.size !== paths.length || paths.some(path => !owned.files.has(path))) {
    throw new ProbeError("containerd_receipt_invalid");
  }
  for (const path of paths) {
    if (!await matchesManagedFile(path, owned.files.get(path)!, path === unit || path === configuration ? 0o644 : 0o755)) {
      return record("containerd", true, "failed", blocker(
        "containerd_receipt_file_mismatch", "A recorded file is missing, unsafe, unreadable, or has a different SHA-256.",
        "Inspect the installation with the root host installer.",
      ), installed);
    }
  }
  return { ...record("containerd", true, "verified", undefined, installed), qualified: containerdPromoted(env, owned.assets) };
}

async function apple(config: HostConfigData, env: Environment): Promise<BackendRecord> {
  const id = "apple-virtualization";
  const release = await probe(env, ["/usr/bin/sw_vers", "-productVersion"]);
  if (!/^\d+(\.\d+){1,2}$/.test(release)) throw new ProbeError("runtime_probe_invalid_output");
  // Keep this minimum aligned with VirtualMachines/Package.swift.
  if (Number(release.split(".")[0]) < 26) {
    return record(id, true, "unavailable", blocker("apple_os_unsupported", "The Swift runner requires macOS 26 or later."));
  }
  const runner = object(object(config.runtimes).apple).runner ?? (config.provider === "apple" ? config.runner : undefined);
  if (!absolute(runner) || !hasPath(env, runner)) {
    return record(id, true, "absent", blocker("apple_runner_missing", "Configure the signed Swift runner."));
  }
  await probe(env, ["/usr/bin/test", "-f", runner]);
  await probe(env, ["/usr/bin/test", "-x", runner]);
  await probe(env, ["/usr/bin/codesign", "--verify", "--strict", runner]);
  const entitlements = await probe(env, ["/usr/bin/codesign", "-d", "--entitlements", ":-", runner]);
  if (!/<key>com\.apple\.security\.virtualization<\/key>\s*<true\s*\/>/.test(entitlements)) {
    return record(id, true, "failed", blocker("apple_entitlement_missing", "The Swift runner needs the Apple virtualization entitlement."));
  }
  const provider = new AppleProvider({ runner, platform: env.platform, templates: [], command: (argv: string[]) => probe(env, argv) }, "");
  if (await provider.check() !== "Apple virtualization available") throw new ProbeError("runtime_probe_invalid_output");
  return { ...record(id, true, "verified"), qualified: promoted(id, env, identity => identity.version === release) };
}

async function libvirt(config: HostConfigData, env: Environment): Promise<BackendRecord> {
  const id = "libvirt";
  const uri = object(object(config.runtimes).libvirt).uri ?? (config.provider === "libvirt" ? config.uri : undefined) ?? "qemu:///system";
  if (uri !== "qemu:///system" && uri !== "qemu:///session") {
    return record(id, true, "failed", blocker("libvirt_uri_invalid", "Configure a local libvirt URI."));
  }
  const qemu = env.arch === "arm64" ? "qemu-system-aarch64" : "qemu-system-x86_64";
  let version: string;
  try {
    const outputs = await Promise.all([["virsh", "--version"], ["qemu-img", "--version"], [qemu, "--version"]].map(argv => probe(env, argv)));
    const versions = outputs.map(output => /\b\d+\.\d+\.\d+\b/.exec(output)?.[0]);
    if (versions.some(value => !value)) throw new ProbeError("runtime_probe_invalid_output");
    version = versions[0]!;
  } catch (error) {
    if (error instanceof ProbeError && error.code === "runtime_probe_missing") {
      return record(id, true, "absent", blocker("libvirt_tools_missing", "Install virsh, qemu-img and the host QEMU emulator."));
    }
    throw error;
  }
  let kvm: boolean;
  try { kvm = env.lstat("/dev/kvm").isCharacterDevice(); }
  catch (error) { if (!missing(error)) throw error; kvm = false; }
  if (!kvm) {
    return record(id, true, "installed", blocker("libvirt_kvm_missing", "The /dev/kvm device is unavailable."), version);
  }
  const provider = new LibvirtProvider({ uri, adapters: { platform: env.platform, run: (argv: string[]) => probe(env, argv) } }, "/");
  try { await provider.check(); }
  catch { return record(id, true, "unknown", blocker("libvirt_kvm_probe_failed", "The local libvirt KVM capability probe did not pass."), version); }
  return { ...record(id, true, "verified", undefined, version), qualified: promoted(id, env, identity => identity.version === version) };
}

export async function nativeRecord(id: Exclude<BackendId, "ollama" | "llama.cpp" | "vllm" | "mlx-lm">, config: HostConfigData, env: Environment): Promise<BackendRecord> {
  const supported = id === "apple-virtualization" ? env.platform === "darwin" && env.arch === "arm64"
    : env.platform === "linux" && ["arm64", "x64"].includes(env.arch);
  if (!supported) return record(id, false, "unavailable", blocker("runtime_platform_unsupported", "This backend does not support the host platform and architecture."));
  try {
    if (id === "containerd") return await containerd(env);
    return await (id === "apple-virtualization" ? apple(config, env) : libvirt(config, env));
  } catch (error) {
    const code = error instanceof ProbeError ? error.code : "runtime_probe_failed";
    return record(id, true, "unknown", blocker(code, "Could not establish runtime status."));
  }
}
