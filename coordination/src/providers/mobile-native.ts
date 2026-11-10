/** Production process boundary. No command is invoked at module load or provider construction. */
import { spawn as nodeSpawn, spawnSync } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { ServiceError, object } from "../errors.ts";
import type { CommandResult, ContainerDirectory, ContainerFiles, Download, MobileTransport, NativePipe, RecordValue, RunOptions, ShellAdapter } from "./mobile.ts";

function command(argv: readonly string[]): [string, string[]] {
  if (!argv.length || argv.some(a => typeof a !== "string" || a.includes("\0")) || !argv[0]) throw new ServiceError("Invalid native command.", 400);
  return [argv[0], argv.slice(1)];
}
async function timeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new ServiceError("Native mobile command timed out; effects may be uncertain.", 409, { outcome: "unknown" })), Math.max(1, ms)); })]); }
  finally { if (timer) clearTimeout(timer); }
}
export class NodeMobilePipe implements NativePipe {
  readonly child: ChildProcessWithoutNullStreams;
  private readonly completion: Promise<{ code: number; error?: Error }>;
  private failure: Error | undefined;
  private closed = false;
  constructor(argv: readonly string[], options: RunOptions) {
    const [executable, args] = command(argv);
    this.child = nodeSpawn(executable, args, { env: options.env, stdio: ["pipe", "pipe", "pipe"], shell: false, windowsHide: true });
    this.child.stderr.resume();
    this.child.stdout.on("error", error => { this.failure = error; });
    this.child.stdin.on("error", error => { this.failure = error; });
    this.completion = new Promise(resolve => {
      this.child.once("error", error => { this.failure = error; resolve({ code: -1, error }); });
      this.child.once("close", code => resolve({ code: code ?? -1, ...(this.failure ? { error: this.failure } : {}) }));
    });
  }
  async read(count: number, ms: number): Promise<Uint8Array> {
    if (!Number.isSafeInteger(count) || count <= 0 || count > 16 * 1048576) throw new ServiceError("Invalid pipe read size.", 400);
    const stream = this.child.stdout, deadline = performance.now() + ms;
    for (;;) {
      if (this.failure) throw this.failure;
      const data: Buffer | null = stream.read(Math.min(count, Math.max(1, stream.readableLength)));
      if (data) return data;
      if (stream.readableEnded || stream.destroyed || this.closed) return Buffer.alloc(0);
      await new Promise<void>((resolve, reject) => {
        const done = (error?: Error) => { stream.off("readable", ready); stream.off("end", ready); stream.off("close", ready); stream.off("error", failed); this.child.off("error", failed); clearTimeout(timer); if (error) reject(error); else resolve(); };
        const ready = () => done(), failed = (error: Error) => done(error);
        const timer = setTimeout(() => done(new ServiceError("Native pipe read timed out.", 409, { outcome: "unknown" })), Math.max(1, deadline - performance.now()));
        stream.once("readable", ready); stream.once("end", ready); stream.once("close", ready); stream.once("error", failed); this.child.once("error", failed);
      });
    }
  }
  async write(data: Uint8Array, ms: number): Promise<number> {
    if (this.closed || this.failure || this.child.stdin.destroyed) throw this.failure ?? new ServiceError("Native pipe is closed.");
    await timeout(new Promise<void>((resolve, reject) => this.child.stdin.write(data, error => error ? reject(error) : resolve())), ms);
    return data.byteLength;
  }
  async end(): Promise<void> {
    if (this.child.stdin.writableEnded || this.child.stdin.destroyed) return;
    await timeout(new Promise<void>((resolve, reject) => { this.child.stdin.once("error", reject); this.child.stdin.end(() => { this.child.stdin.off("error", reject); resolve(); }); }), 30000);
  }
  async wait(ms: number): Promise<number> { const result = await timeout(this.completion, ms); if (result.error) throw result.error; return result.code; }
  async close(): Promise<void> {
    if (this.closed) return; this.closed = true;
    this.child.stdin.destroy(); this.child.stdout.destroy();
    if (this.child.exitCode === null && this.child.signalCode === null) {
      // Only the retained unreaped direct ChildProcess is ever signalled.
      this.child.kill("SIGTERM");
      try { await timeout(this.completion, 2000); } catch { if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill("SIGKILL"); }
    }
    await timeout(this.completion, 2000).catch(() => {});
  }
}
async function executableAvailable(executable: string): Promise<boolean> {
  const candidates = executable.includes(path.sep) ? [executable] : (process.env.PATH ?? "").split(path.delimiter).filter(Boolean).map(dir => path.join(dir, executable));
  for (const candidate of candidates) try { if (fs.statSync(candidate).isFile()) { fs.accessSync(candidate, fs.constants.X_OK); return true; } } catch { /* Try the next installed candidate. */ }
  return false;
}
async function portPairAvailable(port: number): Promise<boolean> {
  const servers = [createServer(), createServer()];
  try {
    for (const [index, server] of servers.entries()) await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen({ host: "127.0.0.1", port: port + index, exclusive: true }, () => { server.removeListener("error", reject); resolve(); }); });
    return true;
  } catch { return false; }
  finally { await Promise.all(servers.map(server => new Promise<void>(resolve => { if (server.listening) server.close(() => resolve()); else resolve(); }))); }
}
export function mobileNativeHelper(config: RecordValue): string {
  const configured = config.mobileNativeHelper ?? config.nativeHelper;
  if (typeof configured === "string") {
    if (!path.isAbsolute(configured)) throw new ServiceError("nativeHelper must be an absolute operator-configured path.", 400);
    return configured;
  }
  for (const relative of ["../../../native/canaveral-mobile-native", "../../../../native/canaveral-mobile-native"]) { const candidate = fileURLToPath(new URL(relative, import.meta.url)); if (fs.existsSync(candidate)) return candidate; }
  for (const relative of ["../../../target/", "../../../../target/", "../../../crates/mobile-native/target/", "../../../../crates/mobile-native/target/"]) {
    const directory = fileURLToPath(new URL(relative, import.meta.url));
    for (const profile of ["release", "debug"]) { const candidate = path.join(directory, profile, "canaveral-mobile-native"); if (fs.existsSync(candidate)) return candidate; }
  }
  return "canaveral-mobile-native"; // Normal installed binary on the operator's PATH.
}
export function createNodeMobileTransport(config: RecordValue): MobileTransport {
  return {
    async run(argv, options): Promise<CommandResult> {
      const pipe = new NodeMobilePipe(argv, options), output: Buffer[] = [];
      const deadline = performance.now() + options.timeoutMs; let length = 0;
      try {
        const input = (async () => { if (options.input) await pipe.write(options.input, Math.max(1, deadline - performance.now())); await pipe.end(); })();
        // Observe both branches even when one fails; no unhandled child/input rejection.
        const receive = (async () => {
          for (;;) {
            const data = Buffer.from(await pipe.read(Math.min(65536, Math.max(1, options.maxBytes - length + 1)), Math.max(1, deadline - performance.now())));
            if (!data.length) break; length += data.length;
            if (length > options.maxBytes) throw new ServiceError("Native output exceeds its bounded envelope.", 413);
            output.push(data);
          }
        })();
        const results = await Promise.allSettled([input, receive]);
        for (const result of results) if (result.status === "rejected") throw result.reason;
        return { stdout: Buffer.concat(output), exitCode: await pipe.wait(Math.max(1, deadline - performance.now())) };
      } finally { await pipe.close(); }
    },
    async spawn(argv, options) {
      const [executable, args] = command(argv);
      const fd = fs.openSync(options.log, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW, 0o600);
      try {
        if (!fs.fstatSync(fd).isFile()) throw new ServiceError("Emulator log must be a regular file.");
        const child = nodeSpawn(executable, args, { env: options.env, stdio: ["ignore", fd, fd], detached: true, shell: false, windowsHide: true });
        await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
        if (!child.pid) throw new ServiceError("Emulator launch has no retained process identity.");
        return { pid: child.pid, stopped: async () => child.exitCode !== null || child.signalCode !== null };
      } finally { fs.closeSync(fd); }
    },
    async pipe(argv, options) { return new NodeMobilePipe(argv, options); },
    async processAbsent(pid) {
      if (!Number.isSafeInteger(pid) || pid <= 0) return false;
      try { process.kill(pid, 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
    },
    portPairAvailable, executableAvailable,
    ...nativeAdapters(config),
  };
}
/** Freshness uses a suspend-aware native clock, never civil time or awake-only hrtime. */
export function nativeElapsedClock(config: RecordValue): () => number {
  return () => {
    if (process.platform === "linux") {
      const value = Number(fs.readFileSync("/proc/uptime", "utf8").split(" ")[0]);
      if (!Number.isFinite(value) || value < 0) throw new ServiceError("Continuous host clock is unavailable."); return value;
    }
    const result = spawnSync(mobileNativeHelper(config), ["clock"], { env: {}, shell: false, encoding: "utf8", timeout: 1000, maxBuffer: 1024, windowsHide: true });
    const value = Number(result.stdout?.trim());
    if (result.error || result.status !== 0 || !result.stdout?.trim() || !Number.isFinite(value) || value < 0) throw new ServiceError("Continuous native mobile clock is unavailable.", 409, { code: "capability_unsupported" }); return value;
  };
}

/** One scoped helper process owns its descriptors. Requests and replies never enter argv. */
class NativeRpc {
  private sequence = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private references = 1;
  private failed = false;
  private readonly pipe: NodeMobilePipe;
  constructor(helper: string, args: string[], env: Record<string, string>) {
    this.pipe = new NodeMobilePipe([helper, ...args], { env, timeoutMs: 30000, maxBytes: 1048576 });
  }
  retain(): void { this.references++; }
  call(op: string, args: RecordValue = {}): Promise<unknown> {
    const work = this.queue.then(async () => {
      if (this.failed) throw new ServiceError("Scoped mobile helper connection was lost; inspect before retrying.", 409, { outcome: "unknown" });
      const seq = ++this.sequence, request = Buffer.from(JSON.stringify({ seq, op, ...args }) + "\n");
      if (request.length > 1048576) throw new ServiceError("Native helper request exceeds its bounded envelope.", 413);
      try {
        await this.pipe.write(request, 30000);
        const parts: Buffer[] = []; let length = 0;
        const deadline = performance.now() + 30000;
        for (;;) {
          const bytes = Buffer.from(await this.pipe.read(65536, Math.max(1, deadline - performance.now())));
          if (!bytes.length) throw new Error("helper closed");
          parts.push(bytes); length += bytes.length;
          if (length > 1048576) throw new Error("helper envelope");
          if (bytes.includes(10)) { if (bytes.at(-1) !== 10 || Buffer.concat(parts).subarray(0, -1).includes(10)) throw new Error("helper framing"); break; }
        }
        const response = object(JSON.parse(Buffer.concat(parts).toString("utf8")));
        if (response.seq !== seq || typeof response.ok !== "boolean") throw new Error("helper identity");
        if (!response.ok) throw new ServiceError("Scoped native operation failed; inspect before retrying.", 409, { outcome: "unknown" });
        return response.body;
      } catch (error) {
        if (!(error instanceof ServiceError) || error.message !== "Scoped native operation failed; inspect before retrying.") { this.failed = true; await this.pipe.close(); }
        throw error;
      }
    });
    this.queue = work.catch(() => {}); return work;
  }
  async release(): Promise<void> {
    if (--this.references > 0) return;
    try { if (!this.failed) { await this.call("shutdown"); await this.pipe.end(); await this.pipe.wait(3000); } }
    finally { await this.pipe.close(); }
  }
}
function resultId(value: unknown): number {
  const id = object(value).id;
  if (!Number.isSafeInteger(id) || (id as number) < 0) throw new ServiceError("Native helper returned an invalid handle.");
  return id as number;
}
function decodeNative(value: unknown): Buffer {
  if (typeof value !== "string" || value.length > 87384 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new ServiceError("Native helper returned invalid bounded bytes.");
  const data = Buffer.from(value, "base64"); if (data.length > 65536) throw new ServiceError("Native helper byte envelope exceeded."); return data;
}
class NativeDirectory implements ContainerDirectory {
  private closed = false;
  private readonly stages = new Map<string, number>();
  constructor(private readonly rpc: NativeRpc, private readonly id: number) {}
  private args(name?: string): RecordValue { if (this.closed) throw new ServiceError("Container directory is closed."); return { directory: this.id, ...(name === undefined ? {} : { name }) }; }
  async directory(name: string): Promise<ContainerDirectory> { const id = resultId(await this.rpc.call("directory", this.args(name))); this.rpc.retain(); return new NativeDirectory(this.rpc, id); }
  async exists(name: string): Promise<boolean> { const value = object(await this.rpc.call("exists", this.args(name))); if (typeof value.exists !== "boolean") throw new ServiceError("Invalid native existence result."); return value.exists; }
  async list(): Promise<{ name: string; kind: "file" | "directory" }[]> {
    const entries = await this.rpc.call("list", this.args());
    if (!Array.isArray(entries) || entries.length > 2001) throw new ServiceError("Invalid bounded container listing.");
    return entries.map(entry => { const v = object(entry); if (typeof v.name !== "string" || (v.kind !== "file" && v.kind !== "directory")) throw new ServiceError("Invalid container entry."); return { name: v.name, kind: v.kind }; });
  }
  async createExclusive(name: string) {
    const stage = resultId(await this.rpc.call("create", this.args(name))); this.stages.set(name, stage);
    return {
      write: async (data: Uint8Array): Promise<number> => {
        const result = object(await this.rpc.call("stageWrite", { stage, data: Buffer.from(data.subarray(0, 65536)).toString("base64") }));
        if (!Number.isSafeInteger(result.count) || (result.count as number) <= 0 || (result.count as number) > Math.min(data.length, 65536)) throw new ServiceError("Invalid native stage write count."); return result.count as number;
      },
      sync: async () => { await this.rpc.call("stageSync", { stage }); },
      close: async () => { /* Descriptor remains owned until publication/cleanup; directory close releases it. */ },
    };
  }
  async renameOwned(from: string, to: string): Promise<void> { await this.publishOwned(from, to, true); }
  async publishOwned(from: string, to: string, replace: boolean): Promise<"published" | "exists"> {
    if (typeof replace !== "boolean") throw new ServiceError("Replacement must be explicit.", 400);
    const stage = this.stages.get(from); if (stage === undefined) throw new ServiceError("Unknown owned upload stage.");
    const value = object(await this.rpc.call("publish", { stage, name: to, replace }));
    if (value.state !== "published" && value.state !== "exists") throw new ServiceError("Invalid native publication result."); return value.state;
  }
  async removeOwned(name: string): Promise<void> { const stage = this.stages.get(name); if (stage !== undefined) { await this.rpc.call("removeStage", { stage }); this.stages.delete(name); } }
  async sync(): Promise<void> { await this.rpc.call("syncDirectory", this.args()); }
  async download(name: string): Promise<Download> {
    const value = object(await this.rpc.call("download", this.args(name))), download = resultId(value), size = value.size;
    if (!Number.isSafeInteger(size) || (size as number) < 0) throw new ServiceError("Invalid native download size.");
    this.rpc.retain(); let closed = false;
    return { size: size as number,
      read: async count => { if (closed || !Number.isSafeInteger(count) || count < 1) throw new ServiceError("Invalid download read."); return decodeNative(object(await this.rpc.call("downloadRead", { download, count: Math.min(count, 65536) })).data); },
      verify: async () => { if (closed) throw new ServiceError("Download is closed."); await this.rpc.call("downloadVerify", { download }); return true; },
      close: async () => { if (!closed) { closed = true; try { await this.rpc.call("downloadClose", { download }); } finally { await this.rpc.release(); } } },
    };
  }
  async close(): Promise<void> { if (!this.closed) { this.closed = true; try { await this.rpc.call("closeDirectory", { directory: this.id }); } finally { await this.rpc.release(); } } }
}
export function nativeContainerFiles(helper: string): ContainerFiles {
  return { async openRoot(root) {
    const rpc = new NativeRpc(helper, ["files", root], process.env as Record<string, string>);
    // Verify that the helper actually opened its pinned root before returning it.
    try { await rpc.call("syncDirectory", { directory: 0 }); return new NativeDirectory(rpc, 0); }
    catch (error) { await rpc.release().catch(() => {}); throw error; }
  } };
}
export function nativeShells(helper: string): ShellAdapter {
  return { async open(argv, env) {
    const rpc = new NativeRpc(helper, ["pty"], env);
    try { await rpc.call("ptyOpen", { argv: [...argv] }); } catch (error) { await rpc.release().catch(() => {}); throw error; }
    let buffer = Buffer.alloc(0), base = 0, cursor = 0, exited = false, exitCode: unknown = null, closed = false, failure: unknown, polling: Promise<void> | undefined;
    const poll = async () => {
      if (closed) return;
      if (polling) return polling;
      polling = (async () => { const value = object(await rpc.call("ptyRead")), data = decodeNative(value.data); buffer = Buffer.concat([buffer, data]); cursor += data.length;
        if (buffer.length > 1048576) { const lost = buffer.length - 1048576; buffer = buffer.subarray(lost); base += lost; }
        exited = value.exited === true; exitCode = value.exitCode;
      })();
      try { await polling; } finally { polling = undefined; }
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const pump = async () => { try { await poll(); if (!closed && !exited) { timer = setTimeout(() => { void pump(); }, 50); timer.unref(); } } catch (error) { failure = error; } };
    void pump();
    return {
      read: async offset => { if (!Number.isSafeInteger(offset) || offset < 0) throw new ServiceError("Invalid shell offset.", 400); if (failure) throw failure; await poll(); if (offset > cursor) throw new ServiceError("Shell cursor exceeds output.", 400); return { data: buffer.subarray(Math.max(0, offset - base)).toString("base64"), offset: cursor, truncated: offset < base, exited, exitCode }; },
      write: async value => { if (closed) throw new ServiceError("Shell is closed."); const data = Buffer.from(value); for (let at = 0; at < data.length; at += 65536) await rpc.call("ptyWrite", { data: data.subarray(at, at + 65536).toString("base64") }); return { written: data.length }; },
      resize: async (rows, cols) => { if (closed) throw new ServiceError("Shell is closed."); await rpc.call("ptyResize", { rows, cols }); return { rows, cols }; },
      close: async () => { if (!closed) { closed = true; if (timer) clearTimeout(timer); await polling?.catch(() => {}); await rpc.release(); } },
    };
  } };
}
function nativeAdapters(config: RecordValue): Pick<MobileTransport, "files" | "shells"> {
  const helper = mobileNativeHelper(config);
  return { files: nativeContainerFiles(helper), shells: nativeShells(helper) };
}
