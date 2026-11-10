/** Portable mobile orchestration. Native execution requires an explicitly injected adapter. */
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { ServiceError, object } from "../errors.ts";
import { createNodeMobileTransport, nativeElapsedClock } from "./mobile-native.ts";
import { Inspections, inspectProvider, snapshot } from "../accessibility-sdk.ts";

export const MAX_OUTPUT = 4 * 1048576;
export const MAX_RESULT = 6 * 1048576;
export type RecordValue = Record<string, unknown>;
export type Authorized = () => boolean | Promise<boolean>;
export interface RunOptions { env: Record<string, string>; timeoutMs: number; maxBytes: number; input?: Uint8Array }
export interface CommandResult { stdout: Uint8Array | string; exitCode: number }
/** read must return at most count bytes, write may be short; implementations enforce timeoutMs. */
export interface NativePipe {
  read(count: number, timeoutMs: number): Promise<Uint8Array>;
  write(data: Uint8Array, timeoutMs: number): Promise<number>;
  end(): Promise<void>;
  wait(timeoutMs: number): Promise<number>;
  close(): Promise<void>;
  resize?(rows: number, cols: number): Promise<void>;
}
export interface NativeChild { pid: number; processStartedAt?: number; stopped(): Promise<boolean> }
export interface MobileTransport {
  run(argv: readonly string[], options: RunOptions): Promise<CommandResult>;
  spawn?(argv: readonly string[], options: RunOptions & { log: string }): Promise<NativeChild>;
  pipe?(argv: readonly string[], options: RunOptions): Promise<NativePipe>;
  /** Positively absent PID only; never signal or adopt it. */
  processAbsent?(pid: number): Promise<boolean>;
  portPairAvailable?(consolePort: number): Promise<boolean>;
  executableAvailable?(name: string): Promise<boolean>;
  shells?: ShellAdapter;
  files?: ContainerFiles;
  elapsed?(): number;
}
export interface ByteReader { read(count: number): Promise<Uint8Array> }
export interface Download extends ByteReader { size: number; verify(): Promise<boolean>; close(): Promise<void> }
/** Native adapter must anchor all operations to open descriptors, disallow symlink traversal,
 * reject nonregular files, and verify descriptor/path identities, including nanosecond times. */
export interface ContainerFiles {
  openRoot(root: string): Promise<ContainerDirectory>;
}
export interface ContainerDirectory {
  directory(name: string): Promise<ContainerDirectory>;
  exists(name: string): Promise<boolean>;
  list(): Promise<{ name: string; kind: "file" | "directory" }[]>;
  download(name: string): Promise<Download>;
  createExclusive(name: string): Promise<{ write(data: Uint8Array): Promise<number>; sync(): Promise<void>; close(): Promise<void> }>;
  /** rename must check the staged entry still identifies the exclusively created file. */
  renameOwned(from: string, to: string): Promise<void>;
  publishOwned(from: string, to: string, replace: boolean): Promise<"published" | "exists">;
  removeOwned(name: string): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}
export interface ShellConnection { read(offset: number): Promise<RecordValue>; write(text: string): Promise<RecordValue>; resize(rows: number, cols: number): Promise<RecordValue>; close(): Promise<void> }
export interface ShellAdapter { open(argv: readonly string[], env: Record<string, string>): Promise<ShellConnection> }
export interface DeviceRequest { id: string; action: string; arguments: RecordValue }
export interface OperationReport { state: "succeeded" | "failed" | "unknown"; result: RecordValue }

export function unsupported(message: string): never { throw new ServiceError(message, 409, { code: "capability_unsupported" }); }
export function uuid(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new ServiceError("Expected a UUID.", 400);
  return value.toLowerCase();
}
export function canonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  throw new ServiceError("Expected finite JSON data.", 400);
}
export function digest(value: unknown): string { return createHash("sha256").update(canonical(value)).digest("hex"); }
export function text(value: unknown, label: string, maximum = 4096, empty = false): string {
  if (typeof value !== "string" || (!empty && !value) || value.length > maximum || value.includes("\0")) throw new ServiceError(`Invalid ${label}.`, 400);
  return value;
}
function safeString(value: unknown, label: string): string {
  const result = text(value, label);
  if (result.startsWith("-")) throw new ServiceError(`Invalid ${label}.`, 400);
  return result;
}
export function integer(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) throw new ServiceError(`Invalid ${label}.`, 400);
  return value as number;
}
export function decodeData(value: unknown, limit = 524288): Buffer {
  if (typeof value !== "string" || value.length > Math.ceil(limit / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new ServiceError("Invalid or oversized base64 data.", 400);
  const bytes = Buffer.from(value, "base64");
  if (bytes.length > limit) throw new ServiceError("File chunk exceeds its envelope.", 400);
  return bytes;
}
export function encoded(data: Uint8Array, mediaType = "application/octet-stream"): RecordValue {
  if (data.byteLength > MAX_OUTPUT) throw new ServiceError("Device output exceeds 4 MiB.", 413);
  return { data: Buffer.from(data).toString("base64"), mediaType };
}
export function deviceDefinition(value: unknown, system: string, arch: string): Record<string, string> {
  if (!["android", "ios"].includes(system) || !["arm64", "amd64"].includes(arch)) throw new ServiceError("Unsupported mobile platform/architecture.", 400);
  const entry = object(value), keys = system === "android" ? ["systemImage", "profile"] : ["runtime", "deviceType"];
  if (Object.keys(entry).length !== keys.length || keys.some(k => !(k in entry))) throw new ServiceError("Invalid device definition fields.", 400);
  const result: Record<string, string> = {};
  for (const key of keys) {
    const v = text(entry[key], key, 200);
    if (!/^[A-Za-z0-9_.;:][A-Za-z0-9_.;:-]*$/.test(v)) throw new ServiceError("Invalid SDK identifier.", 400);
    result[key] = v;
  }
  if (system === "android") {
    if (!new RegExp(`^system-images;android-[0-9]+;[A-Za-z0-9_-]+;${arch === "arm64" ? "arm64-v8a" : "x86_64"}$`).test(result.systemImage!)) throw new ServiceError("Android system image must match the template architecture.", 400);
  } else if (!result.runtime!.startsWith("com.apple.CoreSimulator.SimRuntime.iOS-") || !result.deviceType!.startsWith("com.apple.CoreSimulator.SimDeviceType.")) throw new ServiceError("Use full iOS runtime and device type identifiers.", 400);
  return result;
}
const fields: Record<string, readonly string[]> = {
  screenshot: [], hierarchy: [], apps: [], logs: [], tap: ["x", "y"], swipe: ["x", "y", "toX", "toY", "durationMs"], text: ["text"], key: ["key"], install: ["artifact"], uninstall: ["app"], launch: ["app"], terminate: ["app"], "open-url": ["url"], location: ["latitude", "longitude"], push: ["path", "data"], pull: ["path"], shell: ["argv"], permission: ["app", "permission", "state"], rotate: ["orientation"], accessibility: [], "accessibility-action": ["snapshotId", "nodeId", "nativeAction"], "list-files": ["path"], "shell-open": ["session"], "shell-read": ["session", "offset"], "shell-write": ["session", "text"], "shell-close": ["session"], "shell-resize": ["session", "rows", "cols"],
};
export function operationRequest(value: unknown): DeviceRequest {
  const input = object(value);
  if (Object.keys(input).some(k => !["id", "action", "arguments"].includes(k))) throw new ServiceError("Invalid device operation.", 400);
  const action = text(input.action, "action"), required = Object.hasOwn(fields, action) ? fields[action] : undefined, args = object(input.arguments ?? {});
  if (!required) throw new ServiceError("Unsupported device action.", 400);
  const optional = ["push", "pull", "list-files"].includes(action) ? ["app"] : [];
  if (required.some(k => !(k in args)) || Object.keys(args).some(k => !required.includes(k) && !optional.includes(k))) throw new ServiceError(`Invalid arguments for ${action}.`, 400);
  for (const [key, val] of Object.entries(args)) {
    if (key === "session") uuid(val);
    else if (key === "offset") integer(val, key, 0, Number.MAX_SAFE_INTEGER);
    else if (["rows", "cols"].includes(key)) integer(val, key, 1, 500);
    else if (["x", "y", "toX", "toY"].includes(key)) integer(val, key, 0, 32768);
    else if (key === "durationMs") integer(val, key, 1, 10000);
    else if (["latitude", "longitude"].includes(key)) {
      if (typeof val !== "number" || !Number.isFinite(val) || Math.abs(val) > (key === "latitude" ? 90 : 180)) throw new ServiceError("Invalid geographic coordinate.", 400);
    } else if (key === "data") decodeData(val);
    else if (key === "argv") {
      if (!Array.isArray(val) || val.length < 1 || val.length > 100) throw new ServiceError("Shell requires a guest argument list.", 400);
      for (const item of val) text(item, "shell argument", 4096, true);
      safeString(val[0], "guest executable");
    } else if (key === "text") text(val, "input text", 16000, true);
    else safeString(val, key);
  }
  if ("app" in args && !/^[A-Za-z0-9_][A-Za-z0-9_.]*(?:\/[A-Za-z0-9_.$]+)?$/.test(args.app as string)) throw new ServiceError("Invalid app identifier.", 400);
  if (action === "permission" && !["grant", "revoke", "reset"].includes(args.state as string)) throw new ServiceError("Invalid permission state.", 400);
  if (action === "rotate" && !["PORTRAIT", "PORTRAIT_UPSIDE_DOWN", "LANDSCAPE_LEFT", "LANDSCAPE_RIGHT"].includes(args.orientation as string)) throw new ServiceError("Invalid orientation.", 400);
  const normalized = structuredClone(args);
  if ("session" in normalized) normalized.session = uuid(normalized.session);
  return { id: uuid(input.id), action, arguments: normalized };
}
export function readRegular(file: string, limit: number): Buffer {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > limit) throw new ServiceError("Expected a bounded regular file.", 409);
    const data = Buffer.alloc(Math.min(stat.size + 1, limit + 1));
    let offset = 0, count: number;
    while (offset < data.length && (count = fs.readSync(fd, data, offset, data.length - offset, null)) > 0) offset += count;
    if (offset > limit) throw new ServiceError("File exceeds its bounded envelope.", 409);
    return data.subarray(0, offset);
  } finally { fs.closeSync(fd); }
}
export function readJson(file: string): RecordValue | undefined {
  try { return object(JSON.parse(readRegular(file, MAX_RESULT + 16384).toString("utf8"))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
export function privateDirectory(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!fs.lstatSync(dir).isDirectory() || fs.lstatSync(dir).isSymbolicLink() || fs.realpathSync(dir) !== path.resolve(dir)) throw new ServiceError("Storage must be a real private directory.");
  fs.chmodSync(dir, 0o700);
}
export function saveJson(file: string, value: unknown): void {
  const temporary = file + "." + randomUUID() + ".tmp";
  const fd = fs.openSync(temporary, "wx", 0o600);
  try { fs.writeFileSync(fd, canonical(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temporary, file);
  const parent = fs.openSync(path.dirname(file), fs.constants.O_RDONLY);
  try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
}
/** Never reclaim an unexplained stale lock automatically. Its operation may still be active. */
export async function locked<T>(file: string, body: () => Promise<T>): Promise<T> {
  let fd: number;
  try { fd = fs.openSync(file, "wx", 0o600); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new ServiceError("Mobile assignment is busy or has an unresolved lock.", 409, { code: "assignment_busy" }); throw error; }
  try { return await body(); } finally { fs.closeSync(fd); fs.unlinkSync(file); }
}
export async function authorized(check: Authorized): Promise<void> { if (!await check()) throw new ServiceError("Mobile operation authorization ended.", 401); }
export async function writeAll(pipe: Pick<NativePipe, "write">, bytes: Uint8Array, check: Authorized): Promise<void> {
  let offset = 0;
  while (offset < bytes.length) {
    await authorized(check);
    const count = await pipe.write(bytes.subarray(offset), 30000);
    integer(count, "pipe write count", 1, bytes.length - offset);
    offset += count;
  }
}
export async function copyUpload(reader: ByteReader, writer: (data: Uint8Array) => Promise<void>, size: number, check: Authorized): Promise<void> {
  integer(size, "transfer length", 0, Number.MAX_SAFE_INTEGER);
  let remaining = size;
  while (remaining > 0) {
    await authorized(check);
    const chunk = await reader.read(Math.min(65536, remaining));
    if (!(chunk instanceof Uint8Array) || !chunk.length || chunk.length > Math.min(65536, remaining)) throw new ServiceError("Upload interrupted or exceeded its declared length.", 400);
    await authorized(check); await writer(chunk); remaining -= chunk.length;
  }
}
export function publicationUncertain(): ServiceError { return new ServiceError("Upload publication may have occurred; inspect before retrying.", 409, { code: "upload_publication_uncertain", outcome: "unknown" }); }

export class MobileProvider {
  readonly kind: string = "mobile";
  readonly config: RecordValue;
  readonly state: string;
  readonly transport: MobileTransport | undefined;
  readonly inspections: Inspections;
  private readonly elapsed: () => number;
  private readonly authorization = new AsyncLocalStorage<Authorized>();
  private readonly sessions = new Map<string, ShellConnection>();
  constructor(config: RecordValue, state: string) {
    this.transport = config.transport as MobileTransport | undefined ?? createNodeMobileTransport(config);
    const { transport: _transport, ...settings } = config;
    this.config = structuredClone(settings);
    this.state = path.resolve(state);
    this.elapsed = this.transport?.elapsed ?? nativeElapsedClock(this.config);
    this.inspections = new Inspections(this.elapsed);
  }
  now(): number { return Date.now() / 1000; }
  name(machine: RecordValue): string { return "cvm-" + uuid(machine.id); }
  binding(machine: RecordValue, image?: RecordValue): RecordValue {
    const template = object(machine.template), resources = object(machine.resources);
    const lease = machine.lease == null ? null : object(machine.lease);
    return { version: 1, id: uuid(machine.id), template, resources, image: image ?? template,
      hostId: machine.hostId ?? null, ownerUserId: machine.ownerUserId ?? machine.ownerId ?? machine.userId ?? null,
      lease: lease ? Object.fromEntries(["id", "consumerId", "userId", "requestId", "resourceDomainId", "hostId"].map(k => [k, lease[k] ?? null])) : null,
      runtime: { kind: this.kind, state: this.state, storage: this.config.storage, androidSDK: this.config.androidSDK ?? null, xcrun: this.config.xcrun ?? null } };
  }
  storage(machine: RecordValue, image?: RecordValue): string {
    const template = object(machine.template), selected = image ?? template;
    if (selected.os !== this.kind && this.kind !== "mobile") throw new ServiceError("Mobile image belongs to another runtime.", 400);
    if (["android", "ios"].includes(this.kind)) {
      deviceDefinition(selected.device, this.kind, String(selected.arch));
      if (template.os !== selected.os || template.arch !== selected.arch || canonical(template.device) !== canonical(selected.device)) throw new ServiceError("Mobile image differs from the pinned template.");
      for (const [key, value] of Object.entries(template)) if (!(key in selected) || canonical(selected[key]) !== canonical(value)) throw new ServiceError("Mobile image differs from the full pinned template.");
    }
    const root = text(this.config.storage, "storage");
    if (!path.isAbsolute(root)) throw new ServiceError("Mobile storage must be an absolute path.", 400);
    privateDirectory(root);
    const dir = path.join(root, uuid(machine.id));
    privateDirectory(dir);
    const marker = path.join(dir, "canaveral-owner.json"), binding = this.binding(machine, image), fingerprint = digest(binding);
    const owner = readJson(marker);
    if (owner) { if (owner.fingerprint !== fingerprint || canonical(owner.binding) !== canonical(binding)) throw new ServiceError("Mobile storage belongs to another immutable assignment."); }
    else {
      if (fs.readdirSync(dir).length) throw new ServiceError("Mobile storage has no owner receipt; refusing adoption.");
      // Exclusive publication prevents two initial assignments from claiming the same directory.
      const fd = fs.openSync(marker, "wx", 0o600);
      try { fs.writeFileSync(fd, canonical({ fingerprint, binding })); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      const parent = fs.openSync(dir, fs.constants.O_RDONLY); try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
    }
    return dir;
  }
  environment(): Record<string, string> {
    return { ...Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined)), LC_ALL: "C", LANG: "C" };
  }
  async run(argv: readonly string[], options: Partial<RunOptions> = {}): Promise<Buffer> {
    const check = this.authorization.getStore(); if (check) await authorized(check);
    if (!this.transport) unsupported("Native mobile transport is not configured; native acceptance is outstanding.");
    let result: CommandResult;
    try { result = await this.transport.run(argv, { env: this.environment(), timeoutMs: 60000, maxBytes: MAX_OUTPUT, ...options }); }
    catch { throw new ServiceError("Device command unavailable or timed out; its effects may be uncertain.", 409, { outcome: "unknown" }); }
    if (check) await authorized(check);
    if (result.exitCode !== 0) throw new ServiceError("Device command failed; inspect device state before retrying.", 409, { outcome: "unknown" });
    const output = Buffer.from(result.stdout);
    if (output.length > MAX_OUTPUT) throw new ServiceError("Device output exceeds 4 MiB.", 413);
    return output;
  }
  async runText(argv: readonly string[], options: Partial<RunOptions> = {}): Promise<string> { return (await this.run(argv, options)).toString("utf8").trim(); }
  async pipe(argv: readonly string[]): Promise<NativePipe> {
    if (!this.transport?.pipe) unsupported("Native mobile pipe transport is not configured.");
    return this.transport.pipe(argv, { env: this.environment(), timeoutMs: 30000, maxBytes: MAX_OUTPUT });
  }
  checkTemplates(system: string): RecordValue[] {
    if (!Array.isArray(this.config.templates) || !this.config.templates.length) throw new ServiceError("Offer at least one mobile template.", 400);
    const arch = this.config.hostArch ?? (process.arch === "x64" ? "amd64" : process.arch);
    return this.config.templates.map(item => {
      const image = object(item);
      if (image.os !== system || image.arch !== arch || image.mode !== "device") throw new ServiceError("Device templates must match host OS and architecture.", 400);
      deviceDefinition(image.device, system, String(arch)); return image;
    });
  }
  artifact(name: unknown): string {
    const artifacts = object(this.config.artifacts ?? {}), file = artifacts[safeString(name, "artifact")];
    if (typeof file !== "string" || !path.isAbsolute(file) || !fs.existsSync(file)) throw new ServiceError("Install requires an artifact ID configured by this host's owner.");
    return file;
  }
  async control(_machine: RecordValue, _image: RecordValue, _folder: string, _request: DeviceRequest): Promise<RecordValue> { return unsupported("Mobile action requires a platform provider."); }
  executionAllowed(machine: RecordValue): void {
    if (machine.lease != null) unsupported("Native mobile lease fencing and cleanup acceptance are outstanding; consumer execution is disabled.");
  }
  async displayDensity(_machine: RecordValue, _image: RecordValue): Promise<number> { return 1; }
  async operate(machine: RecordValue, image: RecordValue, folder: string, operation: RecordValue, check: Authorized = () => true, handler?: (request: DeviceRequest) => Promise<RecordValue>): Promise<OperationReport> {
    this.executionAllowed(machine);
    const request = operationRequest({ id: operation.id, action: operation.action, arguments: operation.arguments });
    const dir = this.storage(machine, image);
    privateDirectory(path.join(dir, "operations"));
    return locked(path.join(dir, "assignment.lock"), async () => {
      const receipt = path.join(dir, "operations", request.id + ".json"), fingerprint = digest({ binding: this.binding(machine, image), ...request });
      await authorized(check);
      const saved = readJson(receipt);
      if (saved) {
        if (saved.fingerprint !== fingerprint) throw new ServiceError("Device operation identity conflicts with its local receipt.");
        return (saved.report as OperationReport | undefined) ?? { state: "unknown", result: { detail: "Interrupted device action; inspect before issuing a new operation." } };
      }
      let report: OperationReport;
      if (typeof operation.expiresAt !== "number" || !Number.isFinite(operation.expiresAt)) throw new ServiceError("Invalid operation expiry.", 400);
      if (this.now() > operation.expiresAt) report = { state: "failed", result: { detail: "Device operation expired before execution." } };
      else if (machine.desired !== "running") report = { state: "failed", result: { detail: "Device is stopping or stopped." } };
      else {
        saveJson(receipt, { fingerprint, started: true });
        try {
          await authorized(check);
          // Accessibility may be supplied by the shared native inspection module through handler.
          const result = await this.authorization.run(check, () => handler ? handler(request) : this.control(machine, image, folder, request));
          await authorized(check);
          report = { state: "succeeded", result };
        } catch (error) {
          report = { state: error instanceof ServiceError && error.code === "input_rejected" ? "failed" : "unknown", result: { detail: error instanceof Error ? error.message.slice(0, 2000) : "Device action interrupted; inspect before retrying." } };
          if (error instanceof ServiceError && error.code === "input_rejected") report.result.code = error.code;
        }
      }
      try { if (Buffer.byteLength(canonical(report.result)) > MAX_RESULT) throw new Error("envelope"); }
      catch { report = { state: "unknown", result: { detail: "Device output exceeds the result envelope or is invalid; inspect before retrying." } }; }
      saveJson(receipt, { fingerprint, report }); return report;
    });
  }
  operationReceipt(machine: RecordValue, image: RecordValue, operationId: string): OperationReport {
    return (readJson(path.join(this.storage(machine, image), "operations", uuid(operationId) + ".json"))?.report as OperationReport | undefined) ?? { state: "unknown", result: { detail: "No completed local receipt is available. Inspect before retrying." } };
  }
  async shellControl(machine: RecordValue, request: DeviceRequest, argv: readonly string[]): Promise<RecordValue> {
    const check = this.authorization.getStore(); if (check) await authorized(check);
    const args = request.arguments, key = uuid(machine.id) + ":" + uuid(args.session);
    if (request.action === "shell-open") {
      if (this.sessions.has(key)) return { session: args.session, state: "open" };
      if (!this.transport?.shells) unsupported("Native PTY adapter is not configured.");
      if ([...this.sessions.keys()].filter(k => k.startsWith(uuid(machine.id) + ":")).length >= 8) throw new ServiceError("Too many device shells.", 429);
      const connection = await this.transport.shells.open(argv, this.environment());
      try { if (check) await authorized(check); }
      catch (error) { await connection.close().catch(() => {}); throw error; }
      this.sessions.set(key, connection);
      return { session: args.session, state: "open" };
    }
    const session = this.sessions.get(key);
    if (!session) throw new ServiceError("Owned shell session is unavailable; a restart does not restore it.", 404);
    switch (request.action) {
      case "shell-read": return session.read(args.offset as number);
      case "shell-write": return session.write(args.text as string);
      case "shell-resize": return session.resize(args.rows as number, args.cols as number);
      case "shell-close": await session.close(); this.sessions.delete(key); return { session: args.session, state: "closed" };
      default: throw new ServiceError("Unsupported shell operation.", 400);
    }
  }
  async closeShells(machine: RecordValue): Promise<void> {
    for (const [key, session] of this.sessions) if (key.startsWith(uuid(machine.id) + ":")) { await session.close(); this.sessions.delete(key); }
  }
  async mobileAccessibility(machine: RecordValue, image: RecordValue, folder: string, request: DeviceRequest): Promise<RecordValue> {
    if (image.os !== "android" && image.os !== "ios") return unsupported("Native mobile accessibility requires Android or iOS.");
    if (request.action === "accessibility") return inspectProvider({ inspections: this.inspections, control: (m, i, f, r) => this.control(m, i, String(f), operationRequest(r)) }, machine, image, folder, true, this.elapsed);
    if (request.arguments.nativeAction !== "click") throw new ServiceError("Only click is exposed for simulator accessibility targets.", 409, { code: "input_rejected" });
    const current = snapshot(image.os, await this.control(machine, image, folder, { id: request.id, action: "hierarchy", arguments: {} }));
    let point: { x: number; y: number };
    try { point = this.inspections.target(uuid(machine.id), { snapshotId: String(request.arguments.snapshotId), nodeId: String(request.arguments.nodeId) }, current); }
    catch (error) { throw new ServiceError(error instanceof Error ? error.message : "Accessibility target changed.", 409, { code: "input_rejected" }); }
    return this.control(machine, image, folder, { id: request.id, action: "tap", arguments: point });
  }
}

export function containerParts(relative: string, directory = false): string[] {
  text(relative, "container path");
  if (relative.startsWith("/") || relative.split("/").includes("..") || relative.includes("\\")) throw new ServiceError("Use a relative app-container path without traversal.", 400);
  const parts = relative.split("/").filter(p => p && p !== ".");
  if (!directory && !parts.length) throw new ServiceError("Use a file inside the app container.", 400);
  return parts;
}
export async function confined<T>(files: ContainerFiles | undefined, root: string, relative: string, action: (parent: ContainerDirectory, name: string) => Promise<T>, directory = false): Promise<T> {
  if (!files) unsupported("Descriptor-confined iOS file adapter is not configured; unsafe host-path fallback is disabled.");
  const parts = containerParts(relative, directory), opened: ContainerDirectory[] = [];
  let parent = await files.openRoot(root); opened.push(parent);
  try {
    const ancestors = directory ? parts : parts.slice(0, -1);
    for (const part of ancestors) { parent = await parent.directory(part); opened.push(parent); }
    return await action(parent, directory ? "." : parts.at(-1)!);
  } finally { for (const handle of opened.reverse()) await handle.close(); }
}
export async function atomicUpload(parent: ContainerDirectory, name: string, reader: ByteReader, size: number, check: Authorized): Promise<RecordValue> {
  await authorized(check); integer(size, "transfer length", 0, Number.MAX_SAFE_INTEGER);
  const temporary = ".canaveral-upload-" + randomUUID();
  const output = await parent.createExclusive(temporary);
  let commitAttempted = false;
  try {
    await copyUpload(reader, async data => {
      let at = 0;
      while (at < data.length) { await authorized(check); const count = await output.write(data.subarray(at)); integer(count, "file write count", 1, data.length - at); at += count; }
    }, size, check);
    await output.sync(); await output.close(); await authorized(check);
    commitAttempted = true; await parent.renameOwned(temporary, name); await parent.sync(); await authorized(check);
    return { uploaded: size, durable: true };
  } catch (error) { if (commitAttempted) throw publicationUncertain(); throw error; }
  finally { await output.close().catch(() => {}); try { if (await check()) await parent.removeOwned(temporary).catch(() => {}); } catch { /* Cleanup cannot replace an uncertain-publication error. */ } }
}

export function dimensions(png: Uint8Array): [number, number] {
  const data = Buffer.from(png);
  if (data.length < 24 || !data.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")) || data.toString("ascii", 12, 16) !== "IHDR") throw new ServiceError("Simulator did not return a PNG display.");
  const width = data.readUInt32BE(16), height = data.readUInt32BE(20);
  if (!width || !height || width > 32768 || height > 32768) throw new ServiceError("Unsupported simulator display dimensions.");
  return [width, height];
}
export function compactLength(size: number): Buffer {
  integer(size, "TightPNG length", 0, 4194303);
  const parts = [size & 127]; size >>>= 7;
  if (size) { parts[0]! |= 128; parts.push(size & 127); size >>>= 7; if (size) { parts[1]! |= 128; parts.push(size); } }
  return Buffer.from(parts);
}
export interface ScreenProvider {
  control(machine: RecordValue, image: RecordValue, folder: string, request: DeviceRequest): Promise<RecordValue>;
  displayDensity(machine: RecordValue, image: RecordValue): Promise<number>;
}
/** Protocol-neutral screen input and TightPNG frames; serve() consumes an injected private duplex. */
export class SimulatorScreen {
  size: [number, number] | undefined;
  pressed: [number, number, number] | undefined;
  private lastFrame = 0;
  private readonly barriers = new Map<string, () => void>();
  constructor(readonly provider: ScreenProvider, readonly machine: RecordValue, readonly image: RecordValue, readonly folder: string, readonly check: Authorized) {}
  async action(action: string, args: RecordValue): Promise<RecordValue> {
    await authorized(this.check);
    const result = await this.provider.control(this.machine, this.image, this.folder, operationRequest({ id: randomUUID(), action, arguments: args }));
    await authorized(this.check); return result;
  }
  async capture(): Promise<Buffer> { const png = decodeData((await this.action("screenshot", {})).data, MAX_OUTPUT); dimensions(png); return png; }
  async points(...coords: [number, number][]): Promise<{ x: number; y: number }[]> {
    if (!this.size) throw new ServiceError("Simulator display dimensions are unknown.");
    await authorized(this.check);
    const density = this.image.os === "ios" ? await this.provider.displayDensity(this.machine, this.image) : 1;
    await authorized(this.check);
    if (typeof density !== "number" || !Number.isFinite(density) || density <= 0) throw new ServiceError("iOS display scale is unavailable; refusing imprecise input.");
    return coords.map(([x, y]) => {
      const px = Math.trunc(Math.max(0, Math.min(x, this.size![0] - 1)) / density), py = Math.trunc(Math.max(0, Math.min(y, this.size![1] - 1)) / density);
      if (!Number.isSafeInteger(px) || !Number.isSafeInteger(py)) throw new ServiceError("Simulator scale cannot represent input coordinates.");
      return { x: px, y: py };
    });
  }
  async pointer(mask: number, x: number, y: number): Promise<void> {
    await authorized(this.check);
    if ((mask & 1) && !this.pressed) this.pressed = [x, y, performance.now()];
    else if (!(mask & 1) && this.pressed) {
      const [sx, sy, started] = this.pressed; this.pressed = undefined;
      if (Math.abs(x - sx) + Math.abs(y - sy) < 6) await this.action("tap", (await this.points([x, y]))[0]!);
      else { const [start, end] = await this.points([sx, sy], [x, y]); await this.action("swipe", { ...start!, toX: end!.x, toY: end!.y, durationMs: Math.max(100, Math.min(2000, Math.trunc(performance.now() - started))) }); }
    }
    if (mask & (8 | 16)) { const [start, end] = await this.points([x, y], [x, Math.max(0, Math.min(this.size![1] - 1, y + (mask & 8 ? 200 : -200)))]); await this.action("swipe", { ...start!, toX: end!.x, toY: end!.y, durationMs: 200 }); }
  }
  async key(down: boolean, keysym: number): Promise<void> {
    if (!down) return;
    const android: Record<number, string> = { 0xff08: "DEL", 0xff09: "TAB", 0xff0d: "ENTER", 0xff1b: "BACK", 0xff51: "DPAD_LEFT", 0xff52: "DPAD_UP", 0xff53: "DPAD_RIGHT", 0xff54: "DPAD_DOWN", 0xffff: "FORWARD_DEL", 0x1008ff18: "HOME" };
    const ios: Record<number, string> = { 0xff08: "42", 0xff09: "43", 0xff0d: "40", 0xff1b: "41", 0xff51: "80", 0xff52: "82", 0xff53: "79", 0xff54: "81", 0xffff: "76", 0x1008ff18: "HOME" };
    const key = (this.image.os === "android" ? android : ios)[keysym];
    if (key) await this.action("key", { key }); else if (keysym >= 32 && keysym < 127) await this.action("text", { text: String.fromCharCode(keysym) });
  }
  resetInput(): true { this.pressed = undefined; return true; }
  /** Enqueue in the same ordered byte queue as client input, then await native-side observation. */
  async barrier(write: (bytes: Uint8Array) => void | Promise<void>, reset = true): Promise<boolean> {
    await authorized(this.check);
    const token = Buffer.from(randomUUID().replaceAll("-", ""), "hex"), key = token.toString("hex");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const observed = new Promise<boolean>(resolve => { this.barriers.set(key, () => resolve(true)); timer = setTimeout(() => resolve(false), 2000); });
      await write(Buffer.concat([Buffer.from([reset ? 249 : 250]), token]));
      return await observed;
    } finally { if (timer) clearTimeout(timer); this.barriers.delete(key); }
  }
  async frame(encodings: ReadonlySet<number>): Promise<Buffer> {
    if (!encodings.has(-260)) throw new ServiceError("Simulator requires TightPNG encoding.");
    const delay = 250 - (performance.now() - this.lastFrame);
    if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
    const png = await this.capture(), next = dimensions(png), rectangles: Buffer[] = [];
    if (this.size && (this.size[0] !== next[0] || this.size[1] !== next[1])) {
      if (!encodings.has(-223)) throw new ServiceError("Client cannot resize the rotated display.");
      rectangles.push(rectangle(next, -223)); this.resetInput();
    }
    this.size = next; this.lastFrame = performance.now();
    rectangles.push(Buffer.concat([rectangle(next, -260), Buffer.from([0xa0]), compactLength(png.length), png]));
    return Buffer.concat([Buffer.from([0, 0, 0, rectangles.length]), ...rectangles]);
  }
  async serve(connection: NativePipe, reset?: (token: Buffer, reset: boolean) => boolean | Promise<boolean>): Promise<void> {
    const read = async (size: number) => {
      const parts: Buffer[] = []; let remaining = size;
      while (remaining) { await authorized(this.check); const chunk = Buffer.from(await connection.read(remaining, 30000)); if (!chunk.length || chunk.length > remaining) throw new ServiceError("Display connection interrupted."); parts.push(chunk); remaining -= chunk.length; }
      return Buffer.concat(parts);
    };
    const send = async (bytes: Buffer) => writeAll(connection, bytes, this.check);
    try {
      this.size = dimensions(await this.capture());
      await send(Buffer.from("RFB 003.008\n"));
      if ((await read(12)).toString() !== "RFB 003.008\n") throw new ServiceError("RFB 3.8 is required.");
      // This private duplex must be created only after the stream gateway authenticates.
      await send(Buffer.from([1, 1])); if ((await read(1))[0] !== 1) throw new ServiceError("Invalid RFB security selection.");
      await send(Buffer.alloc(4)); await read(1);
      const name = Buffer.from("Canaveral display"), info = Buffer.alloc(24);
      info.writeUInt16BE(this.size[0], 0); info.writeUInt16BE(this.size[1], 2);
      Buffer.from([32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 16, 8, 0, 0, 0, 0]).copy(info, 4); info.writeUInt32BE(name.length, 20);
      await send(Buffer.concat([info, name])); let encodings = new Set<number>();
      while (await this.check()) {
        const kind = (await read(1))[0];
        if (kind === 0) await read(19);
        else if (kind === 2) { const count = (await read(3)).readUInt16BE(1); if (count > 256) throw new ServiceError("Too many display encodings."); const raw = await read(count * 4); encodings = new Set(Array.from({ length: count }, (_, i) => raw.readInt32BE(i * 4))); }
        else if (kind === 3) { await read(9); await send(await this.frame(encodings)); }
        else if (kind === 4) { const raw = await read(7); await this.key(raw[0] !== 0, raw.readUInt32BE(3)); }
        else if (kind === 5) { const raw = await read(5); await this.pointer(raw[0]!, raw.readUInt16BE(1), raw.readUInt16BE(3)); }
        else if (kind === 6) { const size = (await read(7)).readUInt32BE(3); if (size > 16000) throw new ServiceError("Clipboard exceeds control envelope."); await this.action("text", { text: new TextDecoder("utf-8", { fatal: true }).decode(await read(size)) }); }
        else if (kind === 249 || kind === 250) {
          const token = await read(16), observed = this.barriers.get(token.toString("hex"));
          if (!observed && (!reset || !await reset(token, kind === 249))) throw new ServiceError("Unknown simulator input reset.");
          if (kind === 249) this.resetInput(); observed?.();
        }
        else throw new ServiceError("Unsupported RFB client message.");
      }
    } finally { this.resetInput(); await connection.close(); }
  }
}
function rectangle(size: [number, number], encoding: number): Buffer { const raw = Buffer.alloc(12); raw.writeUInt16BE(size[0], 4); raw.writeUInt16BE(size[1], 6); raw.writeInt32BE(encoding, 8); return raw; }
