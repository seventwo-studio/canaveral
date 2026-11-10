import { execFile, execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { ServiceError, object } from "../errors.ts";

export type Data = Record<string, unknown>;
export interface CommandOptions { input?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number }
export type PlatformCommand = (argv: string[], options: CommandOptions) => Promise<string>;
export function uuid(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new ServiceError("Expected a UUID.", 400);
  return value.toLowerCase();
}
export function string(value: unknown): string { if (typeof value !== "string" || !value) throw new ServiceError("Required provider value is missing."); return value; }
export function list(value: unknown): unknown[] { if (!Array.isArray(value)) throw new ServiceError("Expected a provider list."); return value; }
// Keep existing Python receipts readable: sorted keys, ASCII escapes, and JSON spaces.
export function legacyDigest(value: unknown): string {
  function encode(v: unknown): string {
    if (Array.isArray(v)) return `[${v.map(encode).join(", ")}]`;
    if (v !== null && typeof v === "object") return `{${Object.keys(v).sort().map(k => `${encode(k)}: ${encode((v as Data)[k])}`).join(", ")}}`;
    const result = JSON.stringify(v);
    if (result === undefined) throw new ServiceError("Incomplete assignment fingerprint.");
    return result.replace(/[\u007f-\uffff]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
  }
  return createHash("sha256").update(encode(value)).digest("hex");
}
export function assignmentFingerprint(machine: Data): string { return legacyDigest({ id: machine.id, template: machine.template, resources: machine.resources }); }
export function present(path: string): boolean { try { lstatSync(path); return true; } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return false; throw e; } }
export function safePath(path: string): string {
  const full = resolve(path); let current = full;
  while (true) {
    if (present(current) && lstatSync(current).isSymbolicLink()) throw new ServiceError("Provider storage cannot follow symbolic links.");
    const parent = dirname(current); if (parent === current) return full; current = parent;
  }
}
export function readRecord(path: string): Data {
  safePath(path); const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd); const named = lstatSync(path);
    if (!stat.isFile() || stat.size > 65536 || stat.nlink !== 1 || stat.dev !== named.dev || stat.ino !== named.ino) throw new ServiceError("Provider receipt must be a bounded, single-link regular file.");
    const buffer = Buffer.alloc(65537); let count = 0;
    while (count < buffer.length) { const got = readSync(fd, buffer, count, buffer.length - count, null); if (!got) break; count += got; }
    const after = fstatSync(fd);
    if (count > 65536 || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) throw new ServiceError("Provider receipt changed during observation.");
    return object(JSON.parse(buffer.subarray(0, count).toString("utf8")));
  } finally { closeSync(fd); }
}
export function syncDirectory(path: string): void { const fd = openSync(path, "r"); try { fsyncSync(fd); } finally { closeSync(fd); } }
export function saveRecord(path: string, value: Data, exclusive = false): void {
  safePath(path); mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = exclusive ? path : `${path}.${randomUUID()}.tmp`; const fd = openSync(temp, "wx", 0o600);
  try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); } finally { closeSync(fd); }
  if (!exclusive) renameSync(temp, path); syncDirectory(dirname(path));
}
export async function command(config: Data, argv: string[], options: CommandOptions = {}): Promise<string> {
  const injected = config.command ?? config.transport;
  if (typeof injected === "function") return stringOrEmpty(await (injected as PlatformCommand)(argv, options));
  return new Promise((accept, reject) => {
    const child = execFile(string(argv[0]), argv.slice(1), { env: options.env ?? { ...process.env, LC_ALL: "C", LANG: "C" }, timeout: options.timeoutMs ?? 300_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (error, stdout) => {
      if (error) reject(new ServiceError("Backend command failed or timed out; inspect the retained operation before retrying.", 503, { outcome: "unknown" }));
      else accept(stdout.trim());
    });
    child.stdin?.end(options.input);
  });
}
function stringOrEmpty(value: unknown): string { if (typeof value !== "string") throw new ServiceError("Provider transport must return text."); return value.trim(); }
export function ownedStorage(config: Data, machine: Data, create = true): string {
  const root = safePath(string(config.storage)); if (!isAbsolute(string(config.storage))) throw new ServiceError("Storage requires an absolute path.");
  const path = safePath(join(root, uuid(machine.id))); const marker = join(path, "canaveral-owner.json");
  if (create) mkdirSync(path, { recursive: true, mode: 0o700 });
  const expected = assignmentFingerprint(machine);
  if (present(marker)) { if (readRecord(marker).fingerprint !== expected) throw new ServiceError("VM storage belongs to another assignment."); }
  else if (!create || readdirSync(path).length) throw new ServiceError("VM storage has no matching ownership receipt.");
  else saveRecord(marker, { fingerprint: expected }, true);
  return path;
}
export function verifyAssignment(machine: Data, folder: string): void { if (readRecord(join(safePath(folder), "assignment.json")).fingerprint !== assignmentFingerprint(machine)) throw new ServiceError("Assignment ownership receipt differs."); }
export function localTemplates(config: Data, systems: string[]): Data[] {
  const arch = config.arch ?? ({ arm64: "arm64", x64: "amd64" } as Data)[process.arch];
  return list(config.templates).map(v => { const t = object(v); if (!systems.includes(string(t.os)) || t.arch !== arch) throw new ServiceError("Template is incompatible with this native host's OS or architecture.");
    if (!isAbsolute(string(t.image)) || !lstatSync(safePath(string(t.image))).isFile()) throw new ServiceError("Templates require a readable absolute image path."); return t; });
}
export async function ensureSeed(config: Data, image: Data, machine: Data, storage: string): Promise<string | null> {
  if (!image._userData) return null;
  if (typeof config.ensureSeed === "function") {
    const path = safePath(string(await config.ensureSeed(image, machine, storage)));
    if (!path.startsWith(storage + sep) || !lstatSync(path).isFile() || lstatSync(path).size < 32768) throw new ServiceError("Preparation seed builder did not produce an owned ISO image.");
    return path;
  }
  const id = uuid(machine.id); const target = safePath(join(storage, "cloud-init.iso")); const receipt = join(storage, "seed.json");
  const identity = id.replaceAll("-", "").slice(0, 10);
  const network = image.cloneIdentity === "linux-cloud-init" ? { version: 2, ethernets: { canaveral: { match: { macaddress: `02:${identity.match(/../g)!.join(":")}` }, dhcp4: true, "dhcp-identifier": "mac" } } } : null;
  const fingerprint = legacyDigest({ userData: image._userData, id, ...(network ? { network } : {}) });
  if (present(target)) {
    if (!present(receipt) || readRecord(receipt).fingerprint !== fingerprint || !lstatSync(target).isFile() || lstatSync(target).size < 32768) throw new ServiceError("Existing preparation seed differs; it was not overwritten.");
    return target;
  }
  const temporary = mkdtempSync(join(storage, "seed-"));
  try {
    const content = join(temporary, "content"); mkdirSync(content, { mode: 0o700 });
    const windows = object(image.prepare).driver === "cloudbase-init"; const label = windows ? "CONFIG-2" : "CIDATA";
    if (windows) { const leaf = join(content, "openstack", "latest"); mkdirSync(leaf, { recursive: true, mode: 0o700 }); writeFileSync(join(leaf, "meta_data.json"), JSON.stringify({ uuid: id, hostname: `cvm-${id.slice(0, 8)}` }), { mode: 0o600 }); writeFileSync(join(leaf, "user_data"), string(image._userData), { mode: 0o600 }); }
    else { writeFileSync(join(content, "meta-data"), JSON.stringify({ "instance-id": id, "local-hostname": `cvm-${id}` }), { mode: 0o600 }); writeFileSync(join(content, "user-data"), string(image._userData), { mode: 0o600 }); if (network) writeFileSync(join(content, "network-config"), JSON.stringify(network), { mode: 0o600 }); }
    const output = join(temporary, "seed.iso"); const platform = config.platform ?? process.platform;
    if (platform === "darwin") await command(config, ["hdiutil", "makehybrid", "-iso", "-joliet", "-default-volume-name", label, "-o", output, content]);
    else if (platform === "win32") await command(config, ["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(WINDOWS_ISO, "utf16le").toString("base64")], { env: { ...process.env, CANAVERAL_ISO: JSON.stringify({ directory: content, output, label }) } });
    else await command(config, [typeof config.isoTool === "string" ? config.isoTool : "genisoimage", "-quiet", "-V", label, "-J", "-r", "-o", output, content]);
    safePath(output); if (!lstatSync(output).isFile() || lstatSync(output).size < 32768) throw new ServiceError("Seed generation did not produce an ISO image.");
    const fd = openSync(output, "r"); try { fsyncSync(fd); } finally { closeSync(fd); }
    chmodSync(output, 0o600); saveRecord(receipt, { fingerprint }); renameSync(output, target); syncDirectory(storage); return target;
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}

export const WINDOWS_ISO = String.raw`
$ErrorActionPreference = 'Stop'
$p = $env:CANAVERAL_ISO | ConvertFrom-Json
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
public static class CanaveralISO {
 public static void Write(object source, string path) {
  IStream stream = (IStream)source;
  IntPtr count = Marshal.AllocCoTaskMem(4);
  try {
   byte[] buffer = new byte[65536];
   using (FileStream file = new FileStream(path, FileMode.CreateNew)) {
    while (true) {
     stream.Read(buffer, buffer.Length, count);
     int size = Marshal.ReadInt32(count);
     if (size == 0) break;
     file.Write(buffer, 0, size);
    }
    file.Flush(true);
   }
  } finally { Marshal.FreeCoTaskMem(count); }
 }
}
'@
$image = New-Object -ComObject IMAPI2FS.MsftFileSystemImage
$image.FileSystemsToCreate = 3
$image.VolumeName = $p.label
$image.Root.AddTree($p.directory, $false)
$result = $image.CreateResultImage()
[CanaveralISO]::Write($result.ImageStream, $p.output)
`;

export interface RuntimeProof { boot: number; processExited: boolean; runtimeUnlocked: boolean; diskHandlesClosed: boolean }
export class AppleProvider {
  readonly kind = "apple";
  constructor(readonly config: Data, readonly state: string) {}
  name(machine: Data): string { return `cvm-${uuid(machine.id)}`; }
  storage(machine: Data): string { return ownedStorage(this.config, machine); }
  private native(machine: Data, create = false): string { const root = create ? this.storage(machine) : ownedStorage(this.config, machine, false); return safePath(join(root, uuid(machine.id).toUpperCase())); }
  private async run(args: string[], input?: Data): Promise<string> { return command(this.config, [string(this.config.runner), ...args], input ? { input: JSON.stringify(input) } : {}); }
  private helper(): string { const path = typeof this.config.nativeHelper === "string" ? this.config.nativeHelper : join(dirname(fileURLToPath(import.meta.url)), "apple-native-helper"); if (!isAbsolute(path)) throw new ServiceError("The native storage helper requires an absolute installed path."); return path; }
  private async withRuntimeLock<T>(path: string, consume: () => Promise<T>): Promise<T> {
    if (typeof this.config.withRuntimeLock === "function") return this.config.withRuntimeLock(path, consume) as Promise<T>;
    return this.withFileLock(join(path, "runtime.lock"), consume);
  }
  private async withFileLock<T>(file: string, consume: () => Promise<T>): Promise<T> {
    if (typeof this.config.withFileLock === "function") return this.config.withFileLock(file, consume) as Promise<T>;
    if (process.platform !== "darwin") throw new ServiceError("The native Apple runtime lock requires Darwin.", 503);
    const target = safePath(file);
    // Darwin sys/fcntl.h: O_EXLOCK=0x20. The kernel takes the same flock used
    // by CanaveralVMRunner atomically at open; O_NONBLOCK refuses a live owner.
    const fd = openSync(target, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK | 0x20, 0o600);
    try {
      const held = fstatSync(fd); const named = lstatSync(target);
      if (!held.isFile() || held.nlink !== 1 || held.uid !== process.getuid?.() || held.dev !== named.dev || held.ino !== named.ino) throw new ServiceError("Native runtime lock identity changed.");
      return await consume();
    } finally { closeSync(fd); }
  }
  private async diskClosed(path: string, tree = false): Promise<boolean> {
    safePath(path);
    if (!tree) { const disk = safePath(join(path, "disk.img")); if (!present(disk) || !lstatSync(disk).isFile() || lstatSync(disk).nlink !== 1) return false; }
    const argv = ["/usr/sbin/lsof", "-F", "p", ...(tree ? ["+D", path] : ["--", join(path, "disk.img")])];
    if (typeof this.config.probeCommand === "function") {
      const result = object(await this.config.probeCommand(argv, { timeoutMs: 10000 }));
      return result.exitCode === 1 && result.stdout === "" && result.stderr === "";
    }
    return new Promise(resolveProof => {
      execFile(argv[0]!, argv.slice(1), { timeout: 10000, maxBuffer: 1048576, env: { ...process.env, LC_ALL: "C", LANG: "C" } }, (error, stdout, stderr) => {
        // lsof's clean exit 1 means no handles; permission/errors never do.
        resolveProof(error !== null && "code" in error && error.code === 1 && !stdout.trim() && !stderr.trim());
      });
    });
  }
  private processExited(pid: unknown): boolean {
    if (!Number.isSafeInteger(pid) || Number(pid) <= 0) throw new ServiceError("Native stop record has no valid process identity.");
    if (typeof this.config.processAbsent === "function") return this.config.processAbsent(pid) === true;
    try { process.kill(Number(pid), 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
  }
  private async nativeStopEvidence(machine: Data, path: string, lockHeld = false): Promise<boolean> {
    const launch = readRecord(join(path, "runner-launch.json"));
    const marker = join(path, "lease-fenced.json"); const statusPath = join(path, "status.json");
    let receipt: Data;
    if (machine.lease && present(marker)) {
      receipt = readRecord(marker);
      if (uuid(receipt.machineID) !== uuid(machine.id) || uuid(receipt.leaseID) !== uuid(object(machine.lease).id) || receipt.boot !== launch.attemptedAt) throw new ServiceError("Native lease fence belongs to another machine, lease or boot.");
    } else if (!machine.lease && present(join(path, "fenced-stop.json")) && this.confirmedStopped(path)) {
      receipt = readRecord(join(path, "fenced-stop.json"));
      if (receipt.boot !== launch.attemptedAt) return false;
    } else {
      if (!present(statusPath)) return false; receipt = readRecord(statusPath);
      if (receipt.phase !== "Stopped" || typeof receipt.updatedAt !== "number" || typeof launch.attemptedAt !== "number" || receipt.updatedAt + 978307200 < launch.attemptedAt) return false;
    }
    if (!this.processExited(receipt.pid)) return false;
    const verify = async () => {
      if (!await this.diskClosed(path) || !this.processExited(receipt.pid) || readRecord(join(path, "runner-launch.json")).attemptedAt !== launch.attemptedAt) return false;
      if (machine.lease && present(marker)) saveRecord(join(path, "fenced-stop.json"), { boot: launch.attemptedAt, stoppedAt: Date.now() / 1000, consistency: "crash-consistent", leaseID: uuid(object(machine.lease).id) });
      return true;
    };
    try { return lockHeld ? await verify() : await this.withRuntimeLock(path, verify); }
    catch (error) { if (["EWOULDBLOCK", "EAGAIN"].includes(String((error as NodeJS.ErrnoException).code))) return false; throw error; }
  }
  async check(): Promise<unknown> {
    if ((this.config.platform ?? process.platform) !== "darwin") throw new ServiceError("The Apple backend requires a physical Mac with hardware virtualization.");
    for (const t of localTemplates(this.config, ["linux", "macos"])) {
      if (t.os !== "macos") continue;
      if (t.arch !== "arm64" || t.mode !== "desktop") throw new ServiceError("macOS guests require Apple silicon and desktop mode.");
      if (!string(t.image).toLowerCase().endsWith(".ipsw")) for (const key of ["macOSRestoreImage", "macOSAuxiliaryStorage", "macOSHardwareModel"]) if (!lstatSync(safePath(string(t[key]))).isFile()) throw new ServiceError("macOS base disk platform bindings are missing.");
    }
    if (!isAbsolute(string(this.config.runner))) throw new ServiceError("Configure the absolute signed native runner path.");
    return this.run(["check"]);
  }
  confirmedStopped(path: string): boolean {
    safePath(path); const status = present(join(path, "status.json")) ? readRecord(join(path, "status.json")) : null;
    if (!present(join(path, "runner-launch.json"))) return status === null || status.phase === "Stopped";
    const boot = readRecord(join(path, "runner-launch.json")).attemptedAt;
    if (typeof boot !== "number" || !Number.isFinite(boot)) return false;
    if (present(join(path, "fenced-stop.json"))) {
      const proof = readRecord(join(path, "fenced-stop.json"));
      if (proof.boot === boot && proof.consistency === "crash-consistent") {
        if (status && typeof status.updatedAt === "number" && typeof proof.stoppedAt === "number" && status.updatedAt + 978307200 <= proof.stoppedAt) return true;
        if (!status && proof.leaseID && present(join(path, "machine.json")) && String(readRecord(join(path, "machine.json")).executionLeaseID).toLowerCase() === proof.leaseID) return true;
      }
    }
    return status?.phase === "Stopped" && typeof status.updatedAt === "number" && status.updatedAt + 978307200 >= boot;
  }
  /** Software activation needs current ownership, kernel lock and closed-disk proof. */
  async updateStopped(machine: Data, _image: Data, folder: string): Promise<boolean> {
    try {
      verifyAssignment(machine, folder);
      const path = this.native(machine);
      return await this.withRuntimeLock(path, async () => this.confirmedStopped(path) && await this.stopProof(machine, path, true));
    } catch { return false; }
  }
  private async stopProof(machine: Data, path: string, lockHeld = false): Promise<boolean> {
    if (!present(join(path, "runner-launch.json"))) {
      if (machine.lease || !this.confirmedStopped(path)) return false;
      return lockHeld ? this.diskClosed(path) : this.withRuntimeLock(path, () => this.diskClosed(path));
    }
    if (typeof this.config.runtimeProof !== "function") return this.nativeStopEvidence(machine, path, lockHeld);
    const boot = readRecord(join(path, "runner-launch.json")).attemptedAt;
    const proof = object(await this.config.runtimeProof({ machine, path, boot }));
    return proof.boot === boot && proof.processExited === true && proof.runtimeUnlocked === true && proof.diskHandlesClosed === true;
  }
  private async forceLegacyStop(machine: Data, path: string, requestId: string, locked: boolean): Promise<Data> {
    requestId = uuid(requestId); const launch = readRecord(join(path, "runner-launch.json")); const target = join(path, `legacy-power-off-${requestId}.json`); let receipt: Data;
    for (const name of readdirSync(path).filter(n => /^legacy-power-off-[0-9a-f-]+\.json$/.test(n))) { const prior = readRecord(join(path, name)); if (prior.boot === launch.attemptedAt && prior.requestId !== requestId) throw new ServiceError("Another legacy power-off intent already owns this boot."); }
    if (present(target)) {
      receipt = readRecord(target);
      if (receipt.boot !== launch.attemptedAt || receipt.requestId !== requestId) throw new ServiceError("Legacy power-off receipt belongs to another request or boot.");
    } else {
      if (!locked) throw new ServiceError("Legacy runner no longer owns its runtime lock; no signal was sent.");
      const status = readRecord(join(path, "status.json")); const pid = status.pid;
      if (!Number.isSafeInteger(pid) || Number(pid) <= 1) throw new ServiceError("Native status has no valid process identity.");
      const native = object(JSON.parse(await command(this.config, [this.helper(), "process", String(pid)], { timeoutMs: 5000 })));
      const executable = Buffer.from(string(native.executableHex), "hex").toString("utf8"); const argv = list(native.argvHex).map(v => Buffer.from(string(v), "hex").toString("utf8"));
      const approved = [this.config.runner, ...(Array.isArray(this.config.legacyRunners) ? this.config.legacyRunners : [])].map(p => realpathSync(string(p)));
      const born = Number(native.seconds) + Number(native.micros) / 1e6;
      if (native.pid !== pid || native.uid !== process.getuid?.() || !Number.isSafeInteger(native.seconds) || !Number.isSafeInteger(native.micros) || Number(native.micros) < 0 || Number(native.micros) >= 1e6 || typeof launch.attemptedAt !== "number" || born < launch.attemptedAt - 1 || born > launch.attemptedAt + 10 || !approved.includes(executable) || argv.length !== 3 || argv[1] !== "run" || argv[2] !== path) throw new ServiceError("Native process birth, executable or arguments differ; power-off was refused.");
      receipt = { boot: launch.attemptedAt, pid, seconds: native.seconds, micros: native.micros, executableHex: native.executableHex, requestId, requestedAt: Date.now() / 1000 };
      saveRecord(target, receipt, true);
      // The helper repeats the birth/uid/executable/argv proof immediately before
      // SIGTERM. This durable intent is never replayed, even after a lost reply.
      await command(this.config, [this.helper(), "terminate", String(pid), String(native.seconds), String(native.micros), string(native.executableHex), Buffer.from(path).toString("hex")], { timeoutMs: 5000 });
    }
    if (!this.processExited(receipt.pid)) return { state: "unknown", detail: "Legacy power-off is uncertain; the original process has not exited and will not be signalled again." };
    try {
      return await this.withRuntimeLock(path, async () => {
        if (!await this.diskClosed(path) || !this.processExited(receipt.pid) || readRecord(join(path, "runner-launch.json")).attemptedAt !== receipt.boot) return { state: "unknown", detail: "Native process or disk-handle stop proof remains unconfirmed." };
        saveRecord(join(path, "fenced-stop.json"), { ...receipt, stoppedAt: Date.now() / 1000, consistency: "crash-consistent" });
        return { state: "stopped", detail: "Explicit legacy power-off confirmed; native process, runtime lock and disk handles are closed." };
      });
    } catch (error) { if (["EWOULDBLOCK", "EAGAIN"].includes(String((error as NodeJS.ErrnoException).code))) return { state: "unknown", detail: "Native runtime lock remains owned." }; throw error; }
  }
  async displayEpoch(machine: Data, _image: Data, _folder: string): Promise<Data | null> {
    const path = this.native(machine); if (!present(join(path, "runner-launch.json"))) return null;
    const launch = readRecord(join(path, "runner-launch.json")); return { startedAt: launch.attemptedAt, identity: legacyDigest(launch) };
  }
  async resourceProcesses(machine: Data, _image: Data, folder: string): Promise<unknown[]> {
    verifyAssignment(machine, folder); const path = this.native(machine); const definition = readRecord(join(path, "machine.json"));
    if (uuid(definition.id) !== uuid(machine.id) || (definition.executionLeaseID == null) !== !machine.lease || machine.lease && uuid(definition.executionLeaseID) !== uuid(object(machine.lease).id)) throw new ServiceError("Runtime observation identity differs from the assignment.");
    const launch = readRecord(join(path, "runner-launch.json")); const status = readRecord(join(path, "status.json"));
    if (!Number.isSafeInteger(status.pid) || Number(status.pid) <= 1 || typeof launch.attemptedAt !== "number" || !Number.isFinite(launch.attemptedAt) || typeof status.updatedAt !== "number" || status.updatedAt + 978307200 < launch.attemptedAt - 1) throw new ServiceError("Runtime observation process identity is unavailable.");
    if (this.processExited(status.pid)) return [];
    const snapshot = (): Data => {
      if (typeof this.config.processSnapshot === "function") return object(this.config.processSnapshot(status.pid));
      try { return object(JSON.parse(execFileSync(this.helper(), ["process", String(status.pid)], { timeout: 5000, maxBuffer: 65536, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }))); }
      catch { throw new ServiceError("Native process telemetry is unavailable.", 503); }
    };
    const native = structuredClone(snapshot()); const born = Number(native.seconds) + Number(native.micros) / 1e6;
    const argv = list(native.argvHex).map(v => Buffer.from(string(v), "hex").toString("utf8")); const executable = Buffer.from(string(native.executableHex), "hex").toString("utf8");
    if (native.pid !== status.pid || native.uid !== process.getuid?.() || !Number.isFinite(born) || born < launch.attemptedAt - 1 || born > launch.attemptedAt + 10 || executable !== realpathSync(string(this.config.runner)) || argv.length !== 3 || argv[1] !== "run" || argv[2] !== path) throw new ServiceError("Runtime telemetry executable, arguments or birth differs.");
    for (const key of ["userNanoseconds", "systemNanoseconds", "rssBytes"]) if (typeof native[key] !== "number" || !Number.isFinite(native[key]) || Number(native[key]) < 0) throw new ServiceError("Native process resource counters are unavailable.");
    const verify = (): boolean => {
      try {
        verifyAssignment(machine, folder); this.native(machine); if (legacyDigest(readRecord(join(path, "runner-launch.json"))) !== legacyDigest(launch)) return false;
        const current = snapshot(); return ["pid", "uid", "seconds", "micros", "executableHex"].every(k => native[k] === current[k]) && legacyDigest(current.argvHex) === legacyDigest(native.argvHex);
      } catch { return false; }
    };
    if (!verify()) throw new ServiceError("Native process changed during resource sampling.");
    return [{ pid: status.pid, birth: born, expectedBirth: born, name: "CanaveralVMRunner", userSeconds: Number(native.userNanoseconds) / 1e9, systemSeconds: Number(native.systemNanoseconds) / 1e9, rssBytes: native.rssBytes, category: "virtualMachines", verify }];
  }
  captureConsistency(machine: Data, _image: Data, _folder: string): string {
    const path = this.native(machine); const launch = present(join(path, "runner-launch.json")) ? readRecord(join(path, "runner-launch.json")) : {};
    if (present(join(path, "fenced-stop.json")) && readRecord(join(path, "fenced-stop.json")).boot === launch.attemptedAt) return "crash-consistent";
    const reason = readRecord(join(path, "status.json")).stopReason; return reason === "forced" || reason === "error" ? "crash-consistent" : reason === "guest" ? "guest-shutdown" : "stopped-disk";
  }
  async publishAuthorization(machine: Data, image: Data, path: string, stopping = false): Promise<Data> {
    return this.withFileLock(join(path, "lease-authorization.lock"), () => this.publishAuthorizationLocked(machine, image, path, stopping));
  }
  private async publishAuthorizationLocked(machine: Data, image: Data, path: string, stopping = false): Promise<Data> {
    if (typeof image._leaseAuthorization !== "function") throw new ServiceError("A leased native VM requires its local deadline guard.");
    const started = performance.now(); const auth = object(await image._leaseAuthorization()); const clock = object(JSON.parse(await this.run(["lease-clock"])));
    if (Object.keys(clock).sort().join() !== "bootSessionID,continuous,version" || clock.version !== 1 || typeof clock.continuous !== "number" || !Number.isFinite(clock.continuous) || clock.continuous < 0) throw new ServiceError("The native runner has no valid continuous lease clock.");
    const leaseID = uuid(object(machine.lease).id); if (auth.leaseID !== leaseID || typeof auth.remainingSeconds !== "number" || !Number.isFinite(auth.remainingSeconds) || auth.remainingSeconds < 0 || !Number.isSafeInteger(auth.revision) || typeof auth.fenced !== "boolean") throw new ServiceError("Native lease authorization is invalid.");
    const boot = readRecord(join(path, "runner-launch.json")).attemptedAt;
    const value: Data = { version: 1, machineID: uuid(machine.id), leaseID, revision: auth.revision, boot, bootSessionID: uuid(clock.bootSessionID), deadline: Math.max(0, clock.continuous + auth.remainingSeconds - (performance.now() - started) / 1000 - .25), fenced: stopping || auth.fenced };
    const target = join(path, "lease-authorization.json");
    if (present(target)) { const previous = readRecord(target);
      if (previous.leaseID !== leaseID || previous.machineID !== machine.id || previous.boot !== boot || typeof previous.revision !== "number" || typeof previous.deadline !== "number" || typeof previous.fenced !== "boolean") throw new ServiceError("Native authorization belongs to another identity or boot.");
      if ((auth.revision as number) < previous.revision) throw new ServiceError("Native execution revision cannot move backwards.");
      value.fenced = value.fenced || previous.fenced;
      if (value.revision === previous.revision) value.deadline = Math.min(value.deadline as number, previous.deadline);
    }
    saveRecord(target, value); return value;
  }
  async refreshExecution(machine: Data, image: Data, folder: string, authorization: () => unknown): Promise<Data | null> {
    const path = safePath(join(string(this.config.storage), uuid(machine.id), uuid(machine.id).toUpperCase()));
    if (present(join(folder, "deletion.json")) || !present(join(path, "runner-launch.json"))) return null;
    verifyAssignment(machine, folder); this.native(machine);
    if (String(readRecord(join(path, "machine.json")).executionLeaseID).toLowerCase() !== uuid(object(machine.lease).id)) throw new ServiceError("Native lease updates cannot adopt administrative machines.");
    if (await this.stopProof(machine, path) && this.confirmedStopped(path)) return { state: "stopped", leaseFenced: true };
    const auth = object(await authorization()); const previous = present(join(path, "lease-authorization.json")) ? readRecord(join(path, "lease-authorization.json")) : {};
    const stopping = machine.desired === "stopped" || auth.fenced === true;
    if (previous.revision !== auth.revision || stopping && !previous.fenced) await this.publishAuthorization(machine, { ...image, _leaseAuthorization: () => auth }, path, stopping);
    return stopping ? { state: "stopping", leaseFenced: true, detail: "Lease fenced; positive process, runtime and disk-handle stop proof is pending." } : null;
  }
  async reconcile(machine: Data, image: Data, folder: string): Promise<Data> {
    return this.withFileLock(join(safePath(folder), "provider.lock"), () => this.reconcileLocked(machine, image, folder));
  }
  private async reconcileLocked(machine: Data, image: Data, folder: string): Promise<Data> {
    safePath(folder); if (present(join(folder, "deletion.json"))) throw new ServiceError("Assignment deletion intent blocks preparation and restart.");
    if (!["running", "stopped"].includes(string(machine.desired))) throw new ServiceError("Invalid desired state.", 400);
    const storage = this.storage(machine); const path = this.native(machine); const machineFile = join(path, "machine.json");
    if (present(machineFile)) { const lease = readRecord(machineFile).executionLeaseID; const expected = machine.lease ? uuid(object(machine.lease).id) : null;
      if ((lease == null) !== (expected === null) || lease != null && String(lease).toLowerCase() !== expected) throw new ServiceError("Native execution ownership differs; adoption was refused."); }
    const status = present(join(path, "status.json")) ? readRecord(join(path, "status.json")) : null;
    const now = typeof this.config.now === "function" ? Number(this.config.now()) : Date.now() / 1000;
    const age = status && typeof status.updatedAt === "number" ? now - (status.updatedAt + 978307200) : Infinity;
    const fresh = age >= -5 && age < 8;
    const inspect = present(path) ? object(JSON.parse(await this.run(["inspect", path]))) : { locked: false };
    if (typeof inspect.locked !== "boolean") throw new ServiceError("Native runtime lock state is unavailable.");
    const locked = inspect.locked; const active = locked && fresh && !["Stopped", "Unavailable"].includes(String(status?.phase)); const launch = join(path, "runner-launch.json");
    if (machine.lease && present(launch)) {
      if (await this.stopProof(machine, path) && this.confirmedStopped(path)) return { state: "stopped", leaseFenced: true };
      await this.publishAuthorization(machine, image, path, machine.desired === "stopped");
      if (machine.desired === "stopped") return { state: "stopping", detail: "Lease fenced; positive native stop proof is pending." };
    }
    if (machine.desired === "stopped") {
      if (machine.lease && !present(launch)) return { state: "unknown", detail: "Leased native boot history is missing; durable pre-boot recovery is required." };
      if (!locked && this.confirmedStopped(path) && (!present(launch) || await this.stopProof(machine, path))) return { state: "stopped" };
      verifyAssignment(machine, folder);
      if (machine.powerOffRequest) {
        if (!present(launch)) return { state: "unknown", detail: "Native boot identity is missing; no power-off was sent." };
        if (status?.runnerProtocol !== 1 || !locked) return this.forceLegacyStop(machine, path, uuid(machine.powerOffRequest), locked);
        const request = { id: uuid(machine.powerOffRequest), boot: readRecord(launch).attemptedAt }; const target = join(path, "power-off.request");
        if (present(target)) { const previous = readRecord(target); if (previous.boot === request.boot && previous.id !== request.id) throw new ServiceError("Another power-off intent already owns this native boot."); }
        saveRecord(target, request);
        return { state: "stopping", detail: "Explicit boot-bound power-off requested; positive stop proof is pending." };
      }
      if (active) { const fd = openSync(safePath(join(path, "shutdown.request")), "a", 0o600); closeSync(fd); return { state: "stopping", detail: "Graceful shutdown requested; positive native stop proof is pending." }; }
      return { state: "unknown", detail: "Native outcome is uncertain; capacity remains reserved." };
    }
    if (!present(machineFile)) {
      if (present(join(storage, "apple-prepare.json"))) throw new ServiceError("Native preparation outcome is uncertain; automatic retry is blocked.");
      const resources = object(machine.resources); const request: Data = { id: uuid(machine.id), name: machine.name, os: image.os, mode: image.mode, cpu: resources.cpu, memoryMiB: resources.memoryMiB, diskGiB: resources.diskGiB, image: image.image, directory: storage };
      if (image.os === "macos" && image.macOSRestoreImage) Object.assign(request, { image: image.macOSRestoreImage, baseDisk: image.image, auxiliaryStorage: image.macOSAuxiliaryStorage, hardwareModel: image.macOSHardwareModel });
      if (machine.lease) { if (typeof image._leaseAuthorization !== "function") throw new ServiceError("Leased boot requires a local deadline guard."); request.leaseID = uuid(object(machine.lease).id); }
      const seed = await ensureSeed(this.config, image, machine, storage); if (seed) request.seedISO = seed;
      saveRecord(join(storage, "apple-prepare.json"), { fingerprint: assignmentFingerprint(machine), request }, true);
      await this.run(["prepare"], request);
    }
    if (!present(join(path, "native-prepared")) || !lstatSync(safePath(join(path, "native-prepared"))).isFile()) throw new ServiceError("Native preparation is incomplete; inspect partial state before booting.");
    if (active) return { state: status?.phase === "Running" ? "running" : "starting", detail: status?.detail ?? "" };
    if (fresh && status?.phase === "Unavailable") return { state: "error", detail: status.detail ?? "" };
    if (locked || present(launch) && (!this.confirmedStopped(path) || !await this.stopProof(machine, path))) return { state: "unknown", detail: "Runner outcome uncertain; automatic relaunch is blocked." };
    for (const name of ["shutdown.request", "power-off.request"]) if (present(join(path, name))) { safePath(join(path, name)); unlinkSync(join(path, name)); }
    const attemptedAt = now;
    if (machine.lease) {
      const binding = { version: 1, machineId: uuid(machine.id), leaseId: uuid(object(machine.lease).id), fingerprint: assignmentFingerprint(machine) };
      const journalPath = join(folder, "provisioning.json"); const previous = present(journalPath) ? readRecord(journalPath) : { ...binding, phase: "unproven" };
      if (Object.entries(binding).some(([key, value]) => previous[key] !== value) || !["preparing", "unproven", "bootRequested"].includes(String(previous.phase))) throw new ServiceError("Provisioning journal belongs to another assignment.");
      saveRecord(journalPath, { ...previous, phase: "bootRequested", attemptedAt });
    }
    saveRecord(join(folder, "apple-boot-request.json"), { machineId: uuid(machine.id), fingerprint: assignmentFingerprint(machine), attemptedAt });
    saveRecord(launch, { attemptedAt });
    if (machine.lease) await this.publishAuthorization(machine, image, path);
    if (typeof this.config.launch === "function") await this.config.launch([string(this.config.runner), "run", path], { log: join(path, "runner.log") });
    else {
      const log = openSync(safePath(join(path, "runner.log")), "a", 0o600);
      try { await new Promise<void>((accept, reject) => { const child = spawn(string(this.config.runner), ["run", path], { detached: true, stdio: ["ignore", log, log] }); child.once("error", () => reject(new ServiceError("Runner launch failed; retained boot intent blocks retry.", 503, { outcome: "unknown" }))); child.once("spawn", () => { child.unref(); accept(); }); }); } finally { closeSync(log); }
    }
    return { state: "starting" };
  }
  async captureSource<T>(machine: Data, image: Data, folder: string, consume: (path: string, format: string) => Promise<T>): Promise<T> {
    if (present(join(folder, "deletion.json"))) throw new ServiceError("Deletion intent blocks capture.");
    if (image.os !== "linux") throw new ServiceError("macOS capture requires platform artifact handling.");
    verifyAssignment(machine, folder); const path = this.native(machine);
    if (!present(join(path, "native-prepared"))) throw new ServiceError("Capture requires prepared native storage.");
    return this.withRuntimeLock(path, async () => { if (!this.confirmedStopped(path) || !await this.stopProof(machine, path, true)) throw new ServiceError("Native shutdown and closed disk handles are unconfirmed."); return consume(safePath(join(path, "disk.img")), "raw"); });
  }
  async removeOwnedStorage(machine: Data, image: Data, folder: string, requestId: string, preboot = false): Promise<Data> {
    return this.withFileLock(join(safePath(folder), "provider.lock"), () => this.removeOwnedStorageLocked(machine, image, folder, requestId, preboot));
  }
  private async removeOwnedStorageLocked(machine: Data, _image: Data, folder: string, requestId: string, preboot = false): Promise<Data> {
    requestId = uuid(requestId); verifyAssignment(machine, folder);
    if (machine.desired !== "stopped") throw new ServiceError("Storage removal requires a stopped assignment.");
    if (typeof this.config.removeOwnedStorage === "function") {
      const path = this.native(machine);
      if (!this.confirmedStopped(path) || !await this.stopProof(machine, path)) throw new ServiceError("Positive runtime and disk-handle stop proof is required before removal.");
      return object(await this.config.removeOwnedStorage({ machine, folder, requestId, storage: dirname(path), fingerprint: assignmentFingerprint(machine) }));
    }
    const root = safePath(string(this.config.storage)); const id = uuid(machine.id); const storage = safePath(join(root, id)); const quarantineName = `.removing-${id}-${requestId}`; const quarantine = safePath(join(root, quarantineName));
    const receipt = join(folder, "deletion.json"); const expected: Data = { id: requestId, machineId: id, fingerprint: assignmentFingerprint(machine) };
    const verifyPreboot = () => {
      if (!machine.lease) throw new ServiceError("Pre-boot removal belongs to a lease.");
      const leaseId = uuid(object(machine.lease).id); const provisioning = readRecord(join(folder, "provisioning.json")); const assignment = readRecord(join(folder, "assignment.json"));
      if (provisioning.version !== 1 || provisioning.machineId !== id || provisioning.leaseId !== leaseId || provisioning.fingerprint !== expected.fingerprint || provisioning.phase !== "preparing" || assignment.leaseId !== leaseId) throw new ServiceError("Partial preparation lacks matching durable pre-boot evidence.");
      const path = safePath(join(storage, id.toUpperCase()));
      for (const name of ["runner-launch.json", "status.json", "lease-authorization.json", "lease-fenced.json", "fenced-stop.json", "runner.log"]) if (present(join(path, name))) throw new ServiceError("Partial preparation has possible native execution evidence.");
      if (present(join(folder, "apple-boot-request.json"))) throw new ServiceError("Partial preparation has a durable boot request.");
      if (present(join(path, "machine.json")) && String(readRecord(join(path, "machine.json")).executionLeaseID).toLowerCase() !== leaseId) throw new ServiceError("Partial native metadata belongs to another lease.");
    };
    const helper = this.helper();
    // No runtime compilation/download. The portable Rust helper is installed beside
    // apple.js (or nativeHelper selects its absolute path in ordinary JSON config).
    const erase = async (): Promise<Data> => {
      let journal: Data;
      if (present(receipt)) {
        journal = readRecord(receipt);
        if (journal.evidence === "preboot") { if (!machine.lease) throw new ServiceError("Pre-boot deletion belongs to a lease."); expected.evidence = "preboot"; expected.leaseId = uuid(object(machine.lease).id); preboot = true; }
        if (Object.entries(expected).some(([k, v]) => journal[k] !== v) || preboot && journal.evidence !== "preboot") throw new ServiceError("Deletion receipt belongs to another intent or assignment.");
      } else {
        if (!present(storage) || present(quarantine)) throw new ServiceError("Owned storage is missing or the quarantine path is occupied.");
        if (preboot) { verifyPreboot(); if (readdirSync(root).some(n => n.startsWith(`.removing-${id}-`))) throw new ServiceError("Partial storage already has a removal quarantine."); expected.evidence = "preboot"; expected.leaseId = uuid(object(machine.lease).id); }
        ownedStorage(this.config, machine, false); const r = lstatSync(root, { bigint: true }); const s = lstatSync(storage, { bigint: true });
        if (!r.isDirectory() || !s.isDirectory()) throw new ServiceError("Owned storage must be a directory.");
        journal = { ...expected, state: "planned", rootDev: String(r.dev), rootIno: String(r.ino), storageDev: String(s.dev), storageIno: String(s.ino), ownerHex: readFileSync(join(storage, "canaveral-owner.json")).toString("hex") };
      }
      if (journal.state === "complete") { if (present(storage) || present(quarantine)) throw new ServiceError("Storage reappeared after completed deletion."); return journal; }
      const r = lstatSync(root, { bigint: true }); if (!r.isDirectory() || String(r.dev) !== journal.rootDev || String(r.ino) !== journal.rootIno) throw new ServiceError("Storage root identity changed during removal.");
      const args = [root, string(journal.rootDev), string(journal.rootIno)];
      const pin = (path: string) => { safePath(path); const s = lstatSync(path, { bigint: true }); if (!s.isDirectory() || String(s.dev) !== journal.storageDev || String(s.ino) !== journal.storageIno) throw new ServiceError("Removal directory differs from its pinned identity."); };
      if (present(storage)) {
        if (journal.state !== "planned" || present(quarantine)) throw new ServiceError("Storage layout conflicts with deletion intent."); pin(storage); ownedStorage(this.config, machine, false);
        const path = safePath(join(storage, id.toUpperCase()));
        if (preboot && !await this.diskClosed(storage, true)) throw new ServiceError("Partial preparation still has open handles.");
        const quarantineOwned = async () => {
          if (preboot) verifyPreboot();
          else if (!this.confirmedStopped(path) || !await this.stopProof(machine, path, true)) throw new ServiceError("Native shutdown and closed disk handles are required before removal.");
          saveRecord(receipt, journal);
          await command(this.config, [helper, "quarantine", ...args, id, string(journal.storageDev), string(journal.storageIno), string(journal.ownerHex), quarantineName]);
        };
        if (present(path)) await this.withRuntimeLock(path, quarantineOwned); else if (preboot) await quarantineOwned(); else throw new ServiceError("Owned native directory is missing.");
      }
      if (!present(quarantine) && journal.state !== "removing") throw new ServiceError("No durable removal evidence explains the missing storage.");
      if (present(quarantine)) {
        if (!["planned", "removing"].includes(string(journal.state))) throw new ServiceError("Invalid removal journal state."); pin(quarantine);
        const ownerHex = journal.state === "planned" ? string(journal.ownerHex) : "";
        journal = { ...journal, state: "removing" }; saveRecord(receipt, journal);
        await command(this.config, [helper, "erase", ...args, quarantineName, string(journal.storageDev), string(journal.storageIno), ownerHex]);
      }
      if (present(storage) || present(quarantine)) throw new ServiceError("Storage erasure did not confirm absence.");
      syncDirectory(root); journal = { ...journal, state: "complete" }; saveRecord(receipt, journal); return journal;
    };
    if (typeof this.config.withDeletionLock === "function") return this.config.withDeletionLock(folder, erase) as Promise<Data>;
    return this.withFileLock(join(folder, "deletion.lock"), erase);
  }
}
