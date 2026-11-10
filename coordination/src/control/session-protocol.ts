import { createHash } from "node:crypto";
import { identifier } from "../consumers.ts";
import { object, ServiceError } from "../errors.ts";

export const SESSION_PROTOCOL = "canaveral-session-v1";
export const MAX_CONTROL_BYTES = 16_384;
export const MAX_BINARY_BYTES = 65_536;
export const INSPECTION_SCHEMA = "canaveral-accessibility-v1";
export const MAX_INSPECTION_BYTES = 6 * 1_048_576;
export const MAX_INSPECTION_NODES = 2_000;
export type SessionCapability = "pty" | "display" | "upload" | "download" | "accessibility";
export type SessionSide = "host" | "consumer";
export type SessionMessage = Record<string, unknown> | Uint8Array;
export interface SessionChannel {
  receive(timeoutSeconds?: number): Promise<SessionMessage | null>;
  sendControl(value: Record<string, unknown>): Promise<void>;
  sendBytes(value: Uint8Array): Promise<void>;
  close(): void;
}
export function exact(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  const v = object(value);
  if (required.some(k => !Object.hasOwn(v, k)) || Object.keys(v).some(k => !required.includes(k) && !optional.includes(k)))
    throw new ServiceError("Invalid session control fields.", 400);
  return v;
}
export function transferLength(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new ServiceError("Invalid transfer length.", 400);
  return value;
}
function finite(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value); }
export function sessionString(value: unknown, maximum = 4096): string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0") || Array.from(value).length > maximum || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value))
    throw new ServiceError("Invalid session string.", 400);
  return value;
}
export function encodeControl(value: unknown): string {
  object(value);
  let data: string;
  try {
    data = JSON.stringify(value, (_key, item: unknown) => {
      if (typeof item === "number" && !Number.isFinite(item)) throw new Error();
      if (typeof item === "undefined" || typeof item === "function" || typeof item === "symbol") throw new Error();
      return item;
    });
  } catch { throw new ServiceError("Session control is not finite JSON.", 400); }
  if (Buffer.byteLength(data, "utf8") > MAX_CONTROL_BYTES) throw new ServiceError("Session control exceeds 16 KiB.", 400);
  return data;
}
/** Relay checks preserve worker-owned schemas. Ready may only originate in the broker. */
export function validateRelayMessage(capability: SessionCapability, side: SessionSide, data: Uint8Array, binary: boolean): SessionMessage {
  if (data.byteLength > (binary ? MAX_BINARY_BYTES : MAX_CONTROL_BYTES)) throw new ServiceError("Session message exceeds its budget.", 400);
  if (binary) {
    if ((capability === "pty" && side === "consumer") || (capability === "upload" && side === "host") ||
        ((capability === "download" || capability === "accessibility") && side === "consumer"))
      throw new ServiceError("Binary payload is not valid in this session direction.", 400);
    return data;
  }
  let value: Record<string, unknown>;
  try { value = object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data))); }
  catch { throw new ServiceError("Invalid session control.", 400); }
  if (value.type === "ready") throw new ServiceError("Ready is reserved to the broker.", 400);
  // JSON permits exponents that overflow IEEE-754 even though NaN/Infinity literals are forbidden.
  encodeControl(value);
  return value;
}
export const WORKER_MESSAGES: Readonly<Record<string, string>> = {
  capability_unsupported: "This worker does not support the requested access capability. Inspect the session before choosing another environment.",
  session_incomplete: "Access ended without confirmed completion. Inspect before retrying.",
  upload_publication_uncertain: "Upload publication may have occurred. Inspect the destination before retrying.",
};
export function workerError(value: unknown, requestId?: string): (ServiceError & { requestId?: string }) | undefined {
  if (!value || typeof value !== "object" || (value as Record<string, unknown>).type !== "error") return undefined;
  const v = value as Record<string, unknown>;
  const valid = Object.keys(v).sort().join() === "code,message,outcome,type" && typeof v.code === "string" &&
    Object.hasOwn(WORKER_MESSAGES, v.code) && typeof v.message === "string" && v.outcome === "unknown";
  const e: ServiceError & { requestId?: string } = new ServiceError(valid ? WORKER_MESSAGES[v.code as string]! : "Invalid worker error control; completion was not confirmed.", 409,
    { code: valid ? v.code as string : "session_protocol_error", retryable: false, outcome: "unknown" });
  if (requestId !== undefined) e.requestId = requestId;
  return e;
}
export function validateSnapshot(value: unknown): Record<string, unknown> {
  const fail = (message: string): never => { throw new ServiceError(message, 409); };
  if (!value || typeof value !== "object" || Array.isArray(value) || "frame" in value) fail("Expected a native accessibility snapshot without image data.");
  const v = value as Record<string, unknown>;
  try { identifier(v.snapshotId); } catch { fail("Invalid accessibility snapshot identity."); }
  if (!finite(v.capturedAt) || v.capturedAt < 0) fail("Invalid accessibility capture time.");
  if (typeof v.source !== "string" || !v.source || !["screen-pixels", "screen-points"].includes(v.coordinateSpace as string)) fail("Accessibility source or coordinate space is missing.");
  if (typeof v.truncated !== "boolean" || typeof v.coverage !== "string" || !v.coverage) fail("Accessibility coverage must be explicit.");
  if (Object.hasOwn(v, "unavailableNodes") && (!Number.isSafeInteger(v.unavailableNodes) || (v.unavailableNodes as number) < 0)) fail("Invalid unavailable node count.");
  if (!Array.isArray(v.nodes) || v.nodes.length > MAX_INSPECTION_NODES) fail("Accessibility nodes exceed the snapshot envelope.");
  const seen = new Map<string, number>();
  for (const item of v.nodes as unknown[]) {
    if (!item || typeof item !== "object" || Array.isArray(item)) fail("Malformed accessibility node.");
    const n = item as Record<string, unknown>, p = n.parentId;
    if (typeof n.id !== "string" || !n.id || seen.has(n.id)) fail("Accessibility node identity is missing or duplicated.");
    if (!Object.hasOwn(n, "parentId") || (p !== null && (typeof p !== "string" || !seen.has(p)))) fail("Accessibility parent must precede its child.");
    if (!Number.isInteger(n.depth) || (n.depth as number) < 0 || (n.depth as number) > 30 || n.depth !== (p === null ? 0 : seen.get(p as string)! + 1)) fail("Accessibility depth differs from its parent.");
    if (["role", "name", "identifier"].some(k => typeof n[k] !== "string")) fail("Malformed accessibility labels.");
    if (!n.states || typeof n.states !== "object" || (Array.isArray(n.states) && n.states.some(s => typeof s !== "string"))) fail("Malformed accessibility states.");
    if (!Array.isArray(n.actions) || n.actions.some(a => typeof a !== "string") || !n.properties || typeof n.properties !== "object" || Array.isArray(n.properties)) fail("Malformed accessibility actions or properties.");
    if (!Object.hasOwn(n, "bounds")) fail("Accessibility bounds must be explicit or null.");
    if (n.bounds !== null) {
      const b = n.bounds as Record<string, unknown>;
      if (!b || typeof b !== "object" || ["x", "y", "width", "height"].some(k => !finite(b[k])) || (b.width as number) < 0 || (b.height as number) < 0) fail("Malformed accessibility bounds.");
    }
    seen.set(n.id as string, n.depth as number);
  }
  return v;
}
export function transferBegin(value: unknown, upload = false): Record<string, unknown> {
  const v = exact(value, upload ? ["type", "path", "size"] : ["type", "path"], ["app"]);
  if (v.type !== "begin") throw new ServiceError("Invalid file transfer begin control.", 400);
  sessionString(v.path); if ("app" in v) sessionString(v.app, 200); if (upload) transferLength(v.size);
  return v;
}
/** Final bytes never reach a provider until finish/count/digest have been verified. */
export class UploadReader {
  readonly hash = createHash("sha256");
  readonly size: number;
  remaining: number;
  finished = false;
  private pending: Uint8Array = new Uint8Array();
  private digest: string | undefined;
  constructor(readonly connection: SessionChannel, size: unknown) { this.size = transferLength(size); this.remaining = this.size; }
  checksum(): string { if (!this.digest) throw new ServiceError("Upload is incomplete.", 409); return this.digest; }
  async finish(): Promise<void> {
    if (this.finished) return;
    if (this.remaining || this.pending.byteLength) throw new ServiceError("Upload is incomplete.", 400);
    const v = exact(await this.connection.receive(30), ["type", "bytes", "sha256"]);
    this.digest = this.hash.digest("hex");
    if (v.type !== "finish" || v.bytes !== this.size || v.sha256 !== this.digest) throw new ServiceError("Upload finish or content digest did not match.", 400);
    this.finished = true;
  }
  async read(size: number): Promise<Uint8Array> {
    transferLength(size);
    if (!size || !this.remaining) return new Uint8Array();
    if (!this.pending.byteLength) {
      const value = await this.connection.receive(30);
      if (!(value instanceof Uint8Array) || !value.byteLength || value.byteLength > MAX_BINARY_BYTES || value.byteLength > this.remaining) throw new ServiceError("Upload ended early or exceeded its declared length.", 400);
      this.pending = value;
    }
    const data = this.pending.slice(0, Math.min(size, this.remaining));
    this.pending = this.pending.slice(data.byteLength); this.remaining -= data.byteLength; this.hash.update(data);
    if (!this.remaining) await this.finish();
    return data;
  }
}
/** Injected authenticated native transport. This selects no endpoint, enrollment or capability. */
export class GuestHelperBinding {
  constructor(readonly request: (path: string, body: Record<string, unknown> | null) => Promise<unknown>, readonly authorized: () => boolean,
    readonly cleanupAuthorized?: () => boolean) {}
  async call(path: string, body: Record<string, unknown> | null, cleanup = false): Promise<Record<string, unknown>> {
    if (cleanup && !["/v1/display/release", "/v1/shell/close"].includes(path)) throw new ServiceError("This operation is not owned input or terminal cleanup.", 409);
    const allowed = cleanup ? this.cleanupAuthorized ?? this.authorized : this.authorized;
    const check = (): boolean => { try { return allowed() === true; } catch { return false; } };
    if (!check()) throw new ServiceError("Guest assignment authorization ended.", 410);
    let result: unknown;
    try { result = await this.request(path, body); }
    catch (error) {
      const known = error instanceof ServiceError && error.status === 409 && ["input_busy", "input_stale", "input_reset_uncertain", "capability_unsupported"].includes(error.code);
      throw new ServiceError("Native guest request was not confirmed; inspect before retrying.", error instanceof ServiceError ? error.status : 409,
        { retryable: false, ...(known ? { code: (error as ServiceError).code } : {}), ...((error instanceof ServiceError && error.outcome) || (body !== null && !known) ? { outcome: "unknown" as const } : {}) });
    }
    const stillAllowed = check();
    if (!stillAllowed || !result || typeof result !== "object" || Array.isArray(result)) throw new ServiceError("Native guest acknowledgement was not confirmed.", !stillAllowed ? 410 : 409,
      { retryable: false, ...(body !== null ? { outcome: "unknown" as const } : {}) });
    return result as Record<string, unknown>;
  }
}

export interface RunnerSessionJob { id: string; generation: string; leaseId: string; machineId: string; capability: SessionCapability }
export interface SessionReceiptStore {
  /** Atomically and durably refuse any previously attempted session identity, including uncertain attempts. */
  claim(job: RunnerSessionJob): boolean;
  update(job: RunnerSessionJob, state: "active" | "complete" | "unknown", cleanup: "notNeeded" | "unknown" | "complete"): void;
}
export interface SessionDownload {
  size: number;
  read(maximum: number): Promise<Uint8Array> | Uint8Array;
  verify(): Promise<boolean> | boolean;
  close(): Promise<void> | void;
}
export interface RunnerSessionBackend {
  control?(action: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
  upload?(path: string, app: string | undefined, reader: UploadReader, size: number, authorized: () => boolean): Promise<{ uploaded: number; durable: boolean }>;
  download?(path: string, app: string | undefined): Promise<SessionDownload>;
  inspect?(): Promise<unknown>;
  display?(connection: SessionChannel, authorized: () => boolean, job: RunnerSessionJob): Promise<void>;
}
export interface RunnerSessionOptions {
  authorized(job: RunnerSessionJob): boolean;
  /** Verify the persisted assignment fingerprint and begin its independent lease execution guard. */
  beginExecution(job: RunnerSessionJob): Promise<void> | void;
  receipts: SessionReceiptStore;
  connect(job: RunnerSessionJob, authorized: () => boolean): Promise<SessionChannel>;
  backend(job: RunnerSessionJob): RunnerSessionBackend;
}
const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
/** Portable worker state machine. All native effects require an injected assignment-bound backend. */
export class RunnerSession {
  private cancelled = false;
  private connection: SessionChannel | undefined;
  private ptyStarted = false;
  constructor(readonly job: RunnerSessionJob, readonly options: RunnerSessionOptions) {
    for (const key of ["id", "generation", "leaseId", "machineId"] as const) identifier(job[key]);
    if (!["pty", "display", "upload", "download", "accessibility"].includes(job.capability)) throw new ServiceError("Unsupported session capability.", 400);
  }
  authorized = (): boolean => { try { return !this.cancelled && this.options.authorized(this.job) === true; } catch { return false; } };
  private check(): void { if (!this.authorized()) throw new ServiceError("Lease access ended.", 410); }
  close(): void { this.cancelled = true; this.connection?.close(); }
  private async control(backend: RunnerSessionBackend, action: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!backend.control) throw new ServiceError("This worker has no terminal adapter.", 409, { code: "capability_unsupported" });
    return backend.control(action, { ...args, session: this.job.id });
  }
  private async pty(backend: RunnerSessionBackend, c: SessionChannel): Promise<void> {
    this.ptyStarted = true; this.check(); await this.control(backend, "shell-open", {});
    let offset = 0, lastRead = 0;
    while (this.authorized()) {
      const value = await c.receive(0.025);
      if (value !== null) {
        const v = exact(value, ["action", "arguments"]), args = object(v.arguments);
        if (!["shell-write", "shell-resize"].includes(v.action as string) || Object.hasOwn(args, "session")) throw new ServiceError("Invalid terminal control; ownership is fixed by its broker session.", 400);
        if (v.action === "shell-write") {
          exact(args, ["text"]);
          if (typeof args.text !== "string" || args.text.includes("\0") || Array.from(args.text).length > 16000) throw new ServiceError("Invalid terminal text.", 400);
        } else {
          exact(args, ["cols", "rows"]);
          if ([args.cols, args.rows].some(n => typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 500)) throw new ServiceError("Invalid terminal dimensions.", 400);
        }
        this.check(); await this.control(backend, v.action as string, args);
      }
      if (Date.now() - lastRead < 50) continue;
      this.check(); const result = await this.control(backend, "shell-read", { offset }); lastRead = Date.now(); this.check();
      const encoded = result.data;
      if (typeof encoded !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded) || encoded.length > 87384) throw new ServiceError("Invalid terminal output encoding.", 409);
      const data = Buffer.from(encoded, "base64");
      if (data.length > MAX_BINARY_BYTES || !Number.isSafeInteger(result.offset) || (result.offset as number) < offset) throw new ServiceError("Terminal output exceeds its bounded read or cursor.", 409);
      if (result.truncated === true) await c.sendControl({ type: "truncated" });
      if (data.length) await c.sendBytes(data);
      offset = result.offset as number;
      if (result.exited === true) { await c.sendControl({ type: "exited", exitCode: result.exitCode ?? null }); return; }
    }
    this.check();
  }
  private async upload(backend: RunnerSessionBackend, c: SessionChannel): Promise<void> {
    const v = transferBegin(await c.receive(30), true), reader = new UploadReader(c, v.size);
    if (!reader.size) await reader.finish(); this.check();
    if (!backend.upload) throw new ServiceError("This provider has no streaming upload.", 409, { code: "capability_unsupported" });
    const result = await backend.upload(v.path as string, v.app as string | undefined, reader, reader.size, this.authorized);
    if (reader.remaining || !reader.finished || result.uploaded !== reader.size || result.durable !== true) throw new ServiceError("Durable upload publication was not confirmed.", 409, { code: "upload_publication_uncertain", outcome: "unknown", retryable: false });
    this.check(); await c.sendControl({ type: "finish", bytes: reader.size, sha256: reader.checksum(), durable: true });
  }
  private async download(backend: RunnerSessionBackend, c: SessionChannel): Promise<void> {
    const v = transferBegin(await c.receive(30)); this.check();
    if (!backend.download) throw new ServiceError("This provider has no streaming download.", 409, { code: "capability_unsupported" });
    const source = await backend.download(v.path as string, v.app as string | undefined);
    try {
      const size = transferLength(source.size), checksum = createHash("sha256"); let remaining = size;
      this.check(); await c.sendControl({ type: "begin", size });
      while (remaining) {
        this.check(); const data = await source.read(Math.min(MAX_BINARY_BYTES, remaining)); this.check();
        if (!(data instanceof Uint8Array) || !data.length || data.length > Math.min(MAX_BINARY_BYTES, remaining)) throw new ServiceError("Download source ended early or exceeded its declared size.", 409);
        checksum.update(data); await c.sendBytes(data); remaining -= data.length;
      }
      if (await source.verify() !== true) throw new ServiceError("Download source identity could not be verified.", 409);
      this.check(); await c.sendControl({ type: "finish", bytes: size, sha256: checksum.digest("hex") });
    } finally { await source.close(); }
  }
  private async accessibility(backend: RunnerSessionBackend, c: SessionChannel): Promise<void> {
    const v = exact(await c.receive(30), ["type"]);
    if (v.type !== "begin") throw new ServiceError("Accessibility accepts only an empty begin control.", 400);
    this.check(); if (!backend.inspect) throw new ServiceError("This provider has no native accessibility adapter.", 409, { code: "capability_unsupported" });
    const raw = object(await backend.inspect()); this.check();
    const snapshot = { ...raw }; delete snapshot.frame; validateSnapshot(snapshot);
    let data: Buffer;
    try { data = Buffer.from(JSON.stringify(snapshot, (_key, item: unknown) => { if (typeof item === "number" && !Number.isFinite(item)) throw new Error(); return item; })); }
    catch { throw new ServiceError("Accessibility snapshot is not finite JSON.", 409); }
    if (data.length > MAX_INSPECTION_BYTES) throw new ServiceError("Accessibility snapshot exceeds its transfer envelope.", 413);
    await c.sendControl({ type: "begin", schema: INSPECTION_SCHEMA, size: data.length });
    for (let i = 0; i < data.length; i += MAX_BINARY_BYTES) { this.check(); await c.sendBytes(data.subarray(i, i + MAX_BINARY_BYTES)); }
    this.check(); await c.sendControl({ type: "finish", bytes: data.length, sha256: createHash("sha256").update(data).digest("hex") });
  }
  async run(): Promise<void> {
    if (!this.options.receipts.claim(this.job)) return;
    let state: "complete" | "unknown" = "unknown", cleanup: "notNeeded" | "unknown" | "complete" = "notNeeded";
    let backend: RunnerSessionBackend | undefined;
    try {
      this.check(); await this.options.beginExecution(this.job); this.check();
      backend = this.options.backend(this.job);
      const c = this.connection = await this.options.connect(this.job, this.authorized);
      const ready = exact(await c.receive(30), ["type", "sessionId", "generation", "capability"]);
      if (ready.type !== "ready" || ready.sessionId !== this.job.id || ready.generation !== this.job.generation || ready.capability !== this.job.capability) throw new ServiceError("Outbound session did not become ready.", 409);
      this.check(); this.options.receipts.update(this.job, "active", cleanup);
      switch (this.job.capability) {
        case "pty": await this.pty(backend, c); break;
        case "upload": await this.upload(backend, c); break;
        case "download": await this.download(backend, c); break;
        case "accessibility": await this.accessibility(backend, c); break;
        case "display":
          if (!backend.display) throw new ServiceError("This runner has no display adapter.", 409, { code: "capability_unsupported" });
          await backend.display(c, this.authorized, this.job); break;
      }
      state = "complete";
    } catch (error) {
      const code = error instanceof ServiceError && Object.hasOwn(WORKER_MESSAGES, error.code) ? error.code : "session_incomplete";
      try { await this.connection?.sendControl({ type: "error", code, message: WORKER_MESSAGES[code]!, outcome: "unknown" }); } catch { /* no replay */ }
    } finally {
      if (this.ptyStarted && backend) {
        cleanup = "unknown";
        try { if ((await this.control(backend, "shell-close", {})).closed === true) cleanup = "complete"; } catch { /* uncertain cleanup remains fenced */ }
      }
      this.close(); this.options.receipts.update(this.job, state, cleanup);
    }
  }
}
export class RunnerSessions {
  private readonly sessions = new Map<string, { session: RunnerSession; work: Promise<void> }>();
  private stopped = false;
  constructor(readonly options: RunnerSessionOptions) {}
  step(jobs: readonly RunnerSessionJob[]): void {
    for (const { session } of this.sessions.values()) if (!session.authorized()) session.close();
    if (this.stopped) return;
    for (const job of jobs) {
      if (this.sessions.has(job.id) || !this.options.authorized(job)) continue;
      const session = new RunnerSession(job, this.options);
      // Defer until the map records this attempt, even if claim immediately refuses a tombstone.
      const work = Promise.resolve().then(() => session.run()).catch(() => { session.close(); }).finally(() => this.sessions.delete(job.id));
      this.sessions.set(job.id, { session, work });
    }
  }
  closeMachine(id: string): void { for (const { session } of this.sessions.values()) if (session.job.machineId === id) session.close(); }
  async close(): Promise<void> { this.stopped = true; for (const { session } of this.sessions.values()) session.close(); await Promise.race([Promise.all([...this.sessions.values()].map(s => s.work)), delay(5000)]); }
}
