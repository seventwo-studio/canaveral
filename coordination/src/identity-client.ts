import { EventEmitter } from "node:events";
import { Worker } from "node:worker_threads";
import { secret, ServiceError } from "./errors.ts";
import { mutates } from "./identity-protocol.ts";
import type { IdentityCommand, IdentityReply } from "./identity-protocol.ts";

interface Pending {
  command: IdentityCommand["type"]; mutation: boolean; timer: NodeJS.Timeout;
  resolve: (value: unknown) => void; reject: (error: ServiceError) => void;
}

/** One explicit SQLite worker. A lost acknowledgement is never replayed.
 * `accepted` events mean dequeued work, not a durable mutation receipt.
 */
export class IdentityClient extends EventEmitter {
  readonly ready: Promise<void>;
  private readonly worker: Worker;
  private readonly pending = new Map<number, Pending>();
  private readonly timeout: number;
  private nextId = 0;
  private ended = false;
  private stopping: Promise<number> | undefined;
  private resolveReady!: () => void;
  private rejectReady!: (error: ServiceError) => void;
  private startup: NodeJS.Timeout;

  constructor(options: { path: string; adminToken: string; controllerId?: string; requestTimeoutMs?: number }) {
    super();
    secret(options.adminToken);
    this.timeout = options.requestTimeoutMs ?? 20_000;
    if (!Number.isSafeInteger(this.timeout) || this.timeout < 1 || this.timeout > 120_000) throw new TypeError("Invalid identity worker deadline.");
    this.ready = new Promise<void>((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
    void this.ready.catch(() => {});
    this.worker = new Worker(new URL("./identity-worker.js", import.meta.url), {
      workerData: { path: options.path, adminToken: options.adminToken, controllerId: options.controllerId },
    });
    this.startup = setTimeout(() => { this.fail(); void this.close(); }, 20_000);
    this.startup.unref();
    this.worker.on("message", (message: IdentityReply) => this.receive(message));
    this.worker.on("error", () => { this.fail(); void this.close(); });
    this.worker.on("exit", () => this.fail());
  }

  private unavailable(mutation = false): ServiceError {
    return new ServiceError("Identity worker response was not confirmed. Inspect state before another mutation.", 503, {
      code: "transport_interrupted", retryable: false, ...(mutation ? { outcome: "unknown" as const } : {}),
    });
  }

  private fail(): void {
    this.ended = true;
    clearTimeout(this.startup);
    this.rejectReady(this.unavailable());
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(this.unavailable(pending.mutation)); }
    this.pending.clear();
  }

  private receive(message: IdentityReply): void {
    if (this.ended) return;
    if (message.kind === "ready") { clearTimeout(this.startup); this.resolveReady(); return; }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    if (message.kind === "accepted") { this.emit("accepted", { id: message.id, type: pending.command }); return; }
    clearTimeout(pending.timer); this.pending.delete(message.id);
    if (message.kind === "result") pending.resolve(message.value);
    else pending.reject(new ServiceError(message.error.message, message.error.status, {
      code: message.error.code, retryable: message.error.retryable,
      ...(message.error.outcome ? { outcome: message.error.outcome } : {}),
    }));
  }

  async request(command: IdentityCommand): Promise<unknown> {
    await this.ready;
    if (this.ended) throw this.unavailable();
    if (this.pending.size >= 64) throw new ServiceError("Identity service is busy.", 429, { retryable: false });
    if (this.nextId >= Number.MAX_SAFE_INTEGER) throw new ServiceError("Identity request sequence is exhausted.", 503, { retryable: false });
    const id = ++this.nextId;
    return await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => { this.fail(); void this.close(); }, this.timeout);
      timer.unref();
      this.pending.set(id, { command: command.type, mutation: mutates(command), timer, resolve, reject });
      try { this.worker.postMessage({ id, command }); }
      catch {
        clearTimeout(timer); this.pending.delete(id);
        reject(new ServiceError("Identity request cannot cross its worker boundary.", 400, { retryable: false }));
      }
    });
  }

  async close(): Promise<void> {
    this.fail();
    this.stopping ??= this.worker.terminate();
    await this.stopping;
  }
}
