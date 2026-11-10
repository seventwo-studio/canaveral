/** Owned, non-streaming Ollama execution. Construction performs no runtime launch. */
import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { request } from "node:http";
import { createServer } from "node:net";
import { basename, dirname, isAbsolute, join, parse, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inferenceOffer } from "./control/inference.ts";
import type { InferenceExecutor } from "./control/inference.ts";
import { object, ServiceError } from "./errors.ts";
import { modelJobCanRelease, modelReceiptMatches, parseModelJob } from "./model-job.ts";
import type { GenerationResult, ModelJob, ModelJobState } from "./model-job.ts";
import { SqliteStore } from "./sqlite.ts";

type Signal = "continue" | "cancel" | "fence";
type Json = Record<string, unknown>;
interface ExecutionRow { fingerprint: string; receipt: string | null; phase: string }
interface Settings {
  executable: string; modelsDirectory: string; helper: string; inventory: Map<string, string>;
  startupMs: number; executionMs: number; stopMs: number; responseBytes: number; pollMs: number;
}
class RuntimeFailure extends Error {
  constructor(readonly kind: "failed" | "unknown" | "cancelled") { super("Owned inference did not produce a confirmed result."); }
}
const failed = (): RuntimeFailure => new RuntimeFailure("failed");
const uncertain = (): RuntimeFailure => new RuntimeFailure("unknown");
const sleep = (ms: number): Promise<void> => new Promise(resolveSleep => setTimeout(resolveSleep, ms));
function absolute(value: unknown): string {
  if (typeof value !== "string" || !isAbsolute(value) || value.includes("\0")) throw new ServiceError("Inference requires absolute operator-configured paths.", 400);
  return resolve(value);
}
function bounded(input: Json, name: string, fallback: number, maximum: number, minimum = 1): number {
  const value = Object.hasOwn(input, name) ? input[name] : fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) throw new ServiceError("Invalid inference runtime budget.", 400);
  return value;
}
/** Never traverse links or accept another principal's writable executable/state tree. */
function trustedPath(path: string, kind: "file" | "directory", privateMode = false): void {
  const uid = process.getuid?.();
  if (uid === undefined) throw new ServiceError("Owned inference supports macOS and Linux only.", 400);
  const root = parse(path).root;
  let current = root;
  for (const component of path.slice(root.length).split("/").filter(Boolean)) {
    current = join(current, component);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || (stat.uid !== 0 && stat.uid !== uid) ||
        ((stat.mode & 0o022) !== 0 && !(stat.isDirectory() && stat.uid === 0 && (stat.mode & 0o1000) !== 0))) throw failed();
  }
  const stat = lstatSync(path);
  if ((kind === "file" ? !stat.isFile() || stat.nlink !== 1 : !stat.isDirectory()) || (privateMode && (stat.uid !== uid || (stat.mode & 0o077) !== 0))) throw failed();
}
function privateDirectory(path: string): void {
  // Validate the existing parent before creating anything through it.
  if (!existsSync(path)) {
    const parent = dirname(path);
    if (!existsSync(parent)) privateDirectory(parent);
    trustedPath(parent, "directory");
    mkdirSync(path, { mode: 0o700 });
  }
  trustedPath(path, "directory", true);
}
function inventoryTree(path: string): void {
  trustedPath(path, "directory");
  const pending = [path]; let count = 0;
  while (pending.length) {
    for (const entry of readdirSync(pending.pop()!, { withFileTypes: true })) {
      if (++count > 100_000) throw failed();
      const full = join(entry.parentPath, entry.name), stat = lstatSync(full);
      if (stat.isSymbolicLink() || (stat.uid !== 0 && stat.uid !== process.getuid!()) || (stat.mode & 0o022) !== 0 || (!stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1))) throw failed();
      if (stat.isDirectory()) pending.push(full);
    }
  }
}

/** Installed package and repository layouts; an explicit helper always takes precedence. */
export function inferenceNativeHelper(config: Json): string {
  if (Object.hasOwn(config, "nativeHelper")) return absolute(config.nativeHelper);
  const directory = dirname(fileURLToPath(import.meta.url));
  const root = resolve(directory, basename(dirname(directory)) === "dist" ? "../../.." : "../..");
  const candidates = [join(root, "native", "canaveral-mobile-native"), join(root, "target", "release", "canaveral-mobile-native"), join(root, "target", "debug", "canaveral-mobile-native")];
  return candidates.find(path => existsSync(path)) ?? candidates[0]!;
}
function settings(config: Json): Settings {
  const offer = inferenceOffer(config);
  return { executable: absolute(config.executable), modelsDirectory: absolute(config.modelsDirectory), helper: inferenceNativeHelper(config),
    inventory: new Map(offer.models.map(model => [model.id, model.digest])),
    startupMs: bounded(config, "startupMs", 20_000, 20_000), executionMs: bounded(config, "executionMs", 120_000, 120_000),
    stopMs: bounded(config, "stopMs", 5_000, 10_000), responseBytes: bounded(config, "responseBytes", 1_048_576, 1_048_576, 256),
    pollMs: bounded(config, "pollMs", 50, 1000, 10) };
}

/** JSON.parse alone silently replaces duplicate identity/usage fields. Bound depth and reject them. */
function strictJson(bytes: Buffer): unknown {
  const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  let at = 0;
  const whitespace = (): void => { while (/[\x20\t\r\n]/.test(source[at] ?? "!")) at++; };
  const string = (): string => {
    const start = at++;
    while (at < source.length) {
      const char = source[at++];
      if (char === "\\") { at++; continue; }
      if (char === '"') return JSON.parse(source.slice(start, at)) as string;
    }
    throw failed();
  };
  const value = (depth: number): void => {
    if (depth > 64) throw failed();
    whitespace();
    if (source[at] === '"') { string(); return; }
    if (source[at] === "{" || source[at] === "[") {
      const isObject = source[at++] === "{", end = isObject ? "}" : "]", seen = new Set<string>();
      whitespace(); if (source[at] === end) { at++; return; }
      for (;;) {
        whitespace();
        if (isObject) {
          if (source[at] !== '"') throw failed();
          const key = string(); if (seen.has(key)) throw failed(); seen.add(key);
          whitespace(); if (source[at++] !== ":") throw failed();
        }
        value(depth + 1); whitespace();
        const separator = source[at++];
        if (separator === end) return;
        if (separator !== ",") throw failed();
      }
    }
    const token = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(source.slice(at));
    if (!token) throw failed(); at += token[0].length;
  };
  value(0); whitespace(); if (at !== source.length) throw failed();
  return JSON.parse(source) as unknown;
}

/** Private stdio RPC only. Group signals and leader reaping remain entirely in Rust. */
class OwnedProcess {
  readonly child: ChildProcessWithoutNullStreams;
  private sequence = 0;
  private buffer = Buffer.alloc(0);
  private dead = false;
  private pending: { seq: number; accept(body: Json): void; reject(error: Error): void } | undefined;
  constructor(helper: string) {
    this.child = spawn(helper, ["process"], { shell: false, stdio: ["pipe", "pipe", "pipe"], env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LC_ALL: "C" }, windowsHide: true });
    this.child.stderr.resume();
    this.child.on("error", () => this.fail());
    this.child.on("exit", () => this.fail());
    this.child.stdin.on("error", () => this.fail());
    this.child.stdout.on("error", () => this.fail());
    this.child.stdout.on("data", (chunk: Buffer) => {
      try {
        if (this.dead) return;
        this.buffer = Buffer.concat([this.buffer, chunk]);
        if (this.buffer.length > 65_536) throw uncertain();
        const end = this.buffer.indexOf(10);
        if (end < 0) return;
        const response = object(strictJson(this.buffer.subarray(0, end)));
        this.buffer = this.buffer.subarray(end + 1);
        const pending = this.pending;
        if (!pending || response.seq !== pending.seq || response.ok !== true || this.buffer.length) throw uncertain();
        const body = object(response.body); this.pending = undefined; pending.accept(body);
      } catch { this.fail(); }
    });
  }
  private fail(): void {
    this.dead = true;
    const pending = this.pending; this.pending = undefined; pending?.reject(uncertain());
    this.child.stdin.end();
  }
  async call(op: string, body: Json = {}, timeoutMs = 1000): Promise<Json> {
    if (this.dead || this.pending) throw uncertain();
    const seq = ++this.sequence;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await new Promise<Json>((accept, reject) => {
        this.pending = { seq, accept, reject };
        timer = setTimeout(() => this.fail(), timeoutMs);
        this.child.stdin.write(`${JSON.stringify({ seq, op, ...body })}\n`, error => { if (error) this.fail(); });
      });
    } finally { if (timer) clearTimeout(timer); }
  }
  async close(): Promise<void> {
    if (!this.dead) await this.call("shutdown").catch(() => {});
    this.dead = true; this.child.stdin.end(); this.child.stdout.destroy(); this.child.stderr.destroy();
    // Never kill a helper that may still own a runtime. EOF invokes its native stop path.
    this.child.unref();
  }
}

async function freshPort(): Promise<number> {
  const server = createServer();
  try {
    await new Promise<void>((accept, reject) => { server.once("error", reject); server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, accept); });
    const address = server.address();
    if (!address || typeof address === "string") throw failed();
    return address.port;
  } finally { if (server.listening) await new Promise<void>(accept => server.close(() => accept())); }
}
function envelope(job: ModelJob, state: ModelJobState, cancelled: boolean, stopped: boolean, result?: GenerationResult): ModelJob {
  return parseModelJob({ version: 1, applicationId: job.applicationId, id: job.id, message: { type: "receipt", state,
    cancelRequested: cancelled, stopped, cleanup: stopped ? "complete" : "pending", ...(result ? { result } : {}) } });
}
function canonicalSubmission(job: ModelJob): string {
  if (job.message.type !== "submit") throw new ServiceError("Ollama execution requires a submit envelope.", 400);
  const message = job.message;
  return JSON.stringify({ version: 1, applicationId: job.applicationId, id: job.id, message: { type: "submit", adapter: message.adapter,
    model: message.model, digest: message.digest, prompt: message.prompt, maxTokens: message.maxTokens } });
}
function encodedSize(value: unknown): number {
  if (Array.isArray(value)) return 2 + value.reduce((size: number, item) => size + encodedSize(item), 0) + Math.max(0, value.length - 1) * 2;
  if (value !== null && typeof value === "object") return 2 + Object.entries(value).reduce((size, [key, item]) => size + encodedSize(key) + 2 + encodedSize(item), 0) + Math.max(0, Object.keys(value).length - 1) * 2;
  return Buffer.byteLength(JSON.stringify(value).replace(/[\u007f-\uffff]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`));
}

/** Default JSON-configured executor. The explicit private state directory is durable:
 * launch intent precedes every effect, and an interrupted execution is never replayed.
 * Qualified runtimes stay in the owned group and keep the listener in its leader.
 */
export class OllamaExecutor implements InferenceExecutor {
  private readonly settings: Settings;
  private readonly store: SqliteStore;
  private inflight: Promise<ModelJob> | undefined;
  private closing = false;
  readonly stateDirectory: string;
  constructor(config: Json, stateDirectory: string) {
    this.settings = settings(object(config));
    this.stateDirectory = absolute(stateDirectory);
    privateDirectory(this.stateDirectory);
    const database = join(this.stateDirectory, "execution.sqlite");
    if (existsSync(database)) trustedPath(database, "file", true);
    this.store = new SqliteStore(database);
    this.store.transaction(db => db.exec(`CREATE TABLE IF NOT EXISTS ollama_execution_receipts (
      application TEXT NOT NULL,id TEXT NOT NULL,fingerprint TEXT NOT NULL,phase TEXT NOT NULL,receipt TEXT,
      workspace TEXT,stop_proven INTEGER NOT NULL DEFAULT 0,cleanup_proven INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(application,id))`));
  }
  async check(): Promise<void> {
    if (!["darwin", "linux"].includes(process.platform)) throw new ServiceError("Owned inference supports macOS and Linux only.", 400);
    try {
      trustedPath(this.settings.executable, "file"); accessSync(this.settings.executable, constants.X_OK);
      trustedPath(this.settings.helper, "file"); accessSync(this.settings.helper, constants.X_OK);
      inventoryTree(this.settings.modelsDirectory);
      trustedPath(this.stateDirectory, "directory", true);
    } catch { throw new ServiceError("Installed inference executable, native helper, model inventory or private state is unavailable or unsafe.", 400); }
  }
  async execute(input: ModelJob, control: () => Signal, restriction: () => string | undefined): Promise<ModelJob> {
    if (this.inflight || this.closing) throw new ServiceError("Owned inference executor is busy or closing.", 409);
    const promise = this.run(parseModelJob(input), control, restriction);
    this.inflight = promise;
    try { return await promise; } finally { this.inflight = undefined; }
  }
  async close(): Promise<void> { this.closing = true; await this.inflight; }

  private async run(job: ModelJob, control: () => Signal, restriction: () => string | undefined): Promise<ModelJob> {
    const specification = canonicalSubmission(job);
    if (job.message.type !== "submit") throw failed();
    const submit = job.message, fingerprint = createHash("sha256").update(specification).digest("hex");
    const old = this.store.transaction(db => db.prepare("SELECT fingerprint,receipt,phase FROM ollama_execution_receipts WHERE application=? AND id=?").get(job.applicationId, job.id) as unknown as ExecutionRow | undefined);
    if (old) {
      if (old.fingerprint !== fingerprint) return envelope(job, "unknown", false, false);
      if (old.receipt) {
        const saved = parseModelJob(JSON.parse(old.receipt));
        if (!modelReceiptMatches(job, saved)) throw uncertain();
        return saved;
      }
      return envelope(job, "unknown", false, false);
    }
    await this.check();
    // Recheck identity inside the same serialization boundary that publishes launch intent.
    const admitted = this.store.transaction(db => {
      if (db.prepare("SELECT 1 FROM ollama_execution_receipts WHERE phase!='terminal'").get()) return false;
      return Number(db.prepare("INSERT OR IGNORE INTO ollama_execution_receipts(application,id,fingerprint,phase) VALUES (?,?,?,'running')").run(job.applicationId, job.id, fingerprint).changes) === 1;
    });
    if (!admitted) return envelope(job, "unknown", false, false);
    let helper: OwnedProcess | undefined, workspace: string | undefined;
    let workspaceIdentity: { dev: number; ino: number } | undefined;
    let stopped = true, cleanup = true, cancelRequested = false, generationStarted = false;
    let result: GenerationResult | undefined, outcome: "succeeded" | "failed" | "cancelled" | "unknown" = "failed";
    const abort = new AbortController();
    let lastResource = -Infinity, lastStatus = -Infinity;
    const observe = async (force = false): Promise<void> => {
      let signal: Signal;
      try { signal = this.closing ? "fence" : control(); } catch { throw uncertain(); }
      if (signal === "cancel") { cancelRequested = true; throw new RuntimeFailure("cancelled"); }
      if (signal !== "continue") throw uncertain();
      const now = performance.now();
      if (force || now - lastResource >= 1000) {
        lastResource = now;
        let reason: string | undefined;
        try { reason = restriction(); } catch { throw failed(); }
        if (reason !== undefined) throw failed();
      }
      if (helper && (force || now - lastStatus >= 200)) {
        lastStatus = now;
        const status = await helper.call("processStatus");
        if (typeof status.exited !== "boolean") throw uncertain();
        if (status.exited) throw generationStarted ? uncertain() : failed();
      }
    };
    const monitored = async <T>(operation: Promise<T>, deadline: number): Promise<T> => {
      const pending = operation.then(value => ({ value }), error => ({ error: error as unknown }));
      // Wall elapsed time supplements the monotonic clock across host suspension.
      const wallDeadline = Date.now() + Math.max(0, deadline - performance.now());
      for (;;) {
        const remaining = Math.min(deadline - performance.now(), wallDeadline - Date.now());
        if (remaining <= 0) throw failed();
        const settled = await Promise.race([pending, sleep(Math.min(this.settings.pollMs, remaining)).then(() => undefined)]);
        if (settled) {
          if (performance.now() >= deadline || Date.now() >= wallDeadline) throw failed();
          if ("error" in settled) throw settled.error;
          return settled.value;
        }
        await observe();
      }
    };
    const http = async (port: number, path: string, body: Json | undefined, deadline: number): Promise<Json> => {
      await observe();
      if ((await helper!.call("processOwnsPort", { port })).owned !== true) throw failed();
      const response = new Promise<Json>((accept, reject) => {
        let settled = false, timer: ReturnType<typeof setTimeout> | undefined;
        const done = (error?: Error, value?: Json): void => { if (settled) return; settled = true; if (timer) clearTimeout(timer); if (error) reject(error); else accept(value!); };
        const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
        const req = request({ host: "127.0.0.1", port, path, method: data ? "POST" : "GET", agent: false, signal: abort.signal,
          headers: { "Content-Type": "application/json", ...(data ? { "Content-Length": data.length } : {}) } }, res => {
          const chunks: Buffer[] = []; let length = 0;
          if (res.statusCode !== 200 || res.headers["content-encoding"] !== undefined) { done(failed()); res.destroy(); return; }
          res.on("data", (chunk: Buffer) => {
            length += chunk.length;
            if (length > this.settings.responseBytes) { done(failed()); res.destroy(); } else chunks.push(chunk);
          });
          res.once("error", () => done(generationStarted ? uncertain() : failed()));
          res.once("aborted", () => done(generationStarted ? uncertain() : failed()));
          res.once("end", () => {
            try { if (!res.complete) throw uncertain(); done(undefined, object(strictJson(Buffer.concat(chunks)))); }
            catch { done(failed()); }
          });
        });
        timer = setTimeout(() => { done(failed()); req.destroy(); }, Math.max(1, deadline - performance.now()));
        req.once("error", () => done(generationStarted ? uncertain() : failed()));
        req.end(data);
      });
      return monitored(response, deadline);
    };
    try {
      await observe(true);
      if (this.settings.inventory.get(submit.model) !== submit.digest || encodedSize(submit.prompt) > 65536) throw failed();
      workspace = mkdtempSync(join(this.stateDirectory, "work-"));
      const stat = lstatSync(workspace); workspaceIdentity = { dev: stat.dev, ino: stat.ino };
      mkdirSync(join(workspace, "home"), { mode: 0o700 }); mkdirSync(join(workspace, "tmp"), { mode: 0o700 });
      this.store.transaction(db => db.prepare("UPDATE ollama_execution_receipts SET workspace=? WHERE application=? AND id=?").run(workspace!, job.applicationId, job.id));
      const port = await freshPort();
      helper = new OwnedProcess(this.settings.helper);
      // The request may launch before a lost RPC reply. Charge it before dispatch.
      stopped = false; cleanup = false;
      const spawnReply = await helper.call("processSpawn", { executable: this.settings.executable, args: ["serve"], cwd: workspace,
        env: { HOME: join(workspace, "home"), TMPDIR: join(workspace, "tmp"), PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LC_ALL: "C",
          OLLAMA_HOST: `127.0.0.1:${port}`, OLLAMA_MODELS: this.settings.modelsDirectory, OLLAMA_NO_CLOUD: "1", OLLAMA_NOPRUNE: "1",
          OLLAMA_NUM_PARALLEL: "1", OLLAMA_MAX_LOADED_MODELS: "1", OLLAMA_CONTEXT_LENGTH: "8192", OLLAMA_KEEP_ALIVE: "0" } }, 3000);
      if (typeof spawnReply.pid !== "number" || !Number.isSafeInteger(spawnReply.pid) || spawnReply.pid < 2) throw uncertain();
      const startupDeadline = performance.now() + this.settings.startupMs;
      const startupWallDeadline = Date.now() + this.settings.startupMs;
      for (;;) {
        await observe();
        if (performance.now() >= startupDeadline || Date.now() >= startupWallDeadline) throw failed();
        if ((await helper.call("processOwnsPort", { port })).owned === true) {
          try { await http(port, "/api/version", undefined, Math.min(startupDeadline, performance.now() + 2000)); break; }
          catch (error) { if (!(error instanceof RuntimeFailure) || error.kind !== "failed") throw error; }
        }
        await sleep(this.settings.pollMs);
      }
      const tags = await http(port, "/api/tags", undefined, performance.now() + 2000);
      if (!Array.isArray(tags.models)) throw failed();
      const matching = tags.models.filter(item => item !== null && typeof item === "object" && !Array.isArray(item) && (item as Json).name === submit.model) as Json[];
      if (matching.length !== 1 || typeof matching[0]!.digest !== "string" || `sha256:${matching[0]!.digest.replace(/^sha256:/, "")}` !== submit.digest) throw failed();
      const metadata = await http(port, "/api/show", { model: submit.model }, performance.now() + 2000);
      if (metadata.remote_model || metadata.remote_host || !Array.isArray(metadata.capabilities) || !metadata.capabilities.includes("completion")) throw failed();
      await observe(true);
      generationStarted = true;
      const generated = await http(port, "/api/generate", { model: submit.model, prompt: submit.prompt, stream: false, keep_alive: 0, think: false,
        options: { num_ctx: 8192, num_predict: submit.maxTokens } }, performance.now() + this.settings.executionMs);
      await observe(true);
      if (generated.done !== true || generated.model !== submit.model || typeof generated.response !== "string" || !generated.response.trim() ||
          typeof generated.eval_count !== "number" || generated.eval_count > submit.maxTokens) throw failed();
      const candidate = envelope(job, "succeeded", false, true, { model: submit.model, text: generated.response,
        usage: { inputTokens: generated.prompt_eval_count as number, outputTokens: generated.eval_count } });
      if (candidate.message.type !== "receipt" || !candidate.message.result || encodedSize(candidate.message.result) > 262_144) throw failed();
      result = candidate.message.result; outcome = "succeeded";
    } catch (error) { outcome = error instanceof RuntimeFailure ? error.kind : "failed"; }
    finally {
      abort.abort();
      if (helper) {
        try { stopped = (await helper.call("processStop", { budgetMs: this.settings.stopMs }, this.settings.stopMs + 1500)).stopped === true; }
        catch { stopped = false; }
        await helper.close();
      }
      if (stopped && workspace) {
        try {
          trustedPath(this.stateDirectory, "directory", true);
          const stat = lstatSync(workspace);
          if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== workspaceIdentity?.dev || stat.ino !== workspaceIdentity.ino) throw uncertain();
          rmSync(workspace, { recursive: true }); cleanup = !existsSync(workspace);
        } catch { cleanup = false; }
      } else if (!workspace) cleanup = true;
    }
    if (!stopped || !cleanup) outcome = "unknown";
    const receipt = envelope(job, outcome, cancelRequested, outcome !== "unknown" && stopped && cleanup, outcome === "succeeded" ? result : undefined);
    this.store.transaction(db => db.prepare("UPDATE ollama_execution_receipts SET phase=?,receipt=?,stop_proven=?,cleanup_proven=? WHERE application=? AND id=? AND fingerprint=?")
      .run(modelJobCanRelease(receipt) ? "terminal" : "unknown", JSON.stringify(receipt), stopped ? 1 : 0, cleanup ? 1 : 0, job.applicationId, job.id, fingerprint));
    return receipt;
  }
}

export function createInferenceExecutor(config: Json, stateDirectory: string): OllamaExecutor { return new OllamaExecutor(config, stateDirectory); }
