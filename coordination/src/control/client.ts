import { EventEmitter } from "node:events";
import { Worker } from "node:worker_threads";
import { ServiceError, secret } from "../errors.ts";
import type { ControlOptions, ControlResponse } from "./contracts.ts";
import type { SessionCommand } from "./sessions.ts";

/** Plain, cloneable requests only. Credentials never appear in events. */
export interface HttpCommand {
  type: "http";
  method: string;
  path: string;
  query: string;
  token: string;
  body: Record<string, unknown>;
}
export interface HostAuthenticateCommand { type: "hosts.authenticate"; hostId: string; token: string }
export type ControlCommand = HttpCommand | SessionCommand | HostAuthenticateCommand | { type: "requests.wake" };
export function mutatesControlCommand(command: ControlCommand): boolean {
  if (command.type === "http") return !["GET", "HEAD", "OPTIONS"].includes(command.method);
  return command.type === "sessions.attach" || command.type === "sessions.disconnect";
}
export type ControlReply =
  | { kind: "ready" }
  | { kind: "accepted"; id: number }
  | { kind: "result"; id: number; value: unknown }
  | { kind: "error"; id: number; error: { message: string; status: number; code: string; retryable: boolean; outcome?: "unknown" } };

interface Pending {
  mutation: boolean;
  timer: NodeJS.Timeout;
  resolve(value: unknown): void;
  reject(error: ServiceError): void;
}

/** A bounded, owned persistence worker. Timeout fences it; nothing is replayed. */
export class ControlClient extends EventEmitter {
  readonly ready: Promise<void>;
  private readonly worker: Worker;
  private readonly pending = new Map<number, Pending>();
  private readonly timeout: number;
  private nextId = 0;
  private ended = false;
  private stopping: Promise<number> | undefined;
  private resolveReady!: () => void;
  private rejectReady!: (error: ServiceError) => void;
  private readonly startup: NodeJS.Timeout;

  constructor(options: ControlOptions & { path: string; requestTimeoutMs?: number }) {
    super();
    secret(options.adminToken);
    if (options.enrollmentToken !== undefined) {
      secret(options.enrollmentToken);
      if (options.adminToken === options.enrollmentToken) throw new TypeError("Admin and enrollment credentials must be different.");
    }
    this.timeout = options.requestTimeoutMs ?? 20_000;
    if (!Number.isSafeInteger(this.timeout) || this.timeout < 1 || this.timeout > 120_000) throw new TypeError("Invalid controller worker deadline.");
    this.ready = new Promise<void>((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
    void this.ready.catch(() => {});
    this.worker = new Worker(new URL("./worker.js", import.meta.url), { workerData: {
      path: options.path, adminToken: options.adminToken, controllerId: options.controllerId,
      ...(options.enrollmentToken === undefined ? {} : { enrollmentToken: options.enrollmentToken }),
      ...(options.updatePublicKeys === undefined ? {} : { updatePublicKeys: options.updatePublicKeys }),
    } });
    this.startup = setTimeout(() => { void this.close(); }, 20_000);
    this.startup.unref();
    this.worker.on("message", (reply: ControlReply) => this.receive(reply));
    this.worker.on("error", () => { void this.close(); });
    this.worker.on("exit", () => this.fail());
  }

  wakeRequests(): Promise<unknown> { return this.request({ type: "requests.wake" }); }

  private unavailable(mutation = false): ServiceError {
    return new ServiceError("Controller response was not confirmed. Inspect state before another mutation.", 503, {
      code: "transport_interrupted", retryable: false, ...(mutation ? { outcome: "unknown" as const } : {}),
    });
  }

  private fail(): void {
    this.ended = true;
    clearTimeout(this.startup);
    this.rejectReady(this.unavailable());
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer); pending.reject(this.unavailable(pending.mutation));
    }
    this.pending.clear();
  }

  private receive(reply: ControlReply): void {
    if (this.ended) return;
    if (reply.kind === "ready") { clearTimeout(this.startup); this.resolveReady(); return; }
    const pending = this.pending.get(reply.id);
    if (!pending) return;
    if (reply.kind === "accepted") { this.emit("accepted", { id: reply.id }); return; }
    clearTimeout(pending.timer); this.pending.delete(reply.id);
    if (reply.kind === "result") pending.resolve(reply.value);
    else pending.reject(new ServiceError(reply.error.message, reply.error.status, {
      code: reply.error.code, retryable: reply.error.retryable,
      ...(reply.error.outcome ? { outcome: reply.error.outcome } : {}),
    }));
  }

  request(command: { type: "requests.wake" }): Promise<unknown>;
  request(command: HttpCommand): Promise<ControlResponse | undefined>;
  request(command: SessionCommand): Promise<unknown>;
  request(command: HostAuthenticateCommand): Promise<unknown>;
  async request(command: ControlCommand): Promise<unknown> {
    await this.ready;
    if (this.ended) throw this.unavailable();
    if (this.pending.size >= 64) throw new ServiceError("Controller service is busy.", 429, { retryable: false });
    if (this.nextId >= Number.MAX_SAFE_INTEGER) throw this.unavailable();
    const id = ++this.nextId;
    return await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => { void this.close(); }, this.timeout);
      timer.unref();
      this.pending.set(id, { mutation: mutatesControlCommand(command), timer, resolve, reject });
      try { this.worker.postMessage({ id, command }); }
      catch {
        clearTimeout(timer); this.pending.delete(id);
        reject(new ServiceError("Controller request cannot cross its worker boundary.", 400, { retryable: false }));
      }
    });
  }

  async authorizeHost(hostId: string, token: string): Promise<void> {
    await this.request({ type: "hosts.authenticate", hostId, token });
  }

  async close(): Promise<void> {
    if (!this.ended) this.fail();
    this.stopping ??= this.worker.terminate();
    await this.stopping;
  }
}
