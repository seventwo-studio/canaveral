import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { ServiceError, allowed, object, uncertain, type Authority } from "./common.ts";
export const MAX_REQUEST = 1000000, MAX_RESPONSE = 6 * 1048576 + 4096;
export function packet(value: unknown, limit = MAX_REQUEST): Buffer {
  let raw: Buffer;
  try { raw = Buffer.from(JSON.stringify(value)); } catch { throw new ServiceError("Worker packet is not serializable.", 400); }
  if (!raw.length || raw.length > limit) throw new ServiceError("Worker packet exceeds its envelope.", 400);
  const header = Buffer.alloc(4); header.writeUInt32BE(raw.length); return Buffer.concat([header, raw]);
}
export class PacketDecoder {
  private pending = Buffer.alloc(0); private length: number | undefined;
  constructor(readonly limit = MAX_RESPONSE) {}
  push(bytes: Buffer): Record<string, unknown>[] {
    // Consume one bounded frame at a time, including coalesced responses.
    const results: Record<string, unknown>[] = []; let offset = 0;
    while (offset < bytes.length) {
      const need = this.length === undefined ? 4 - this.pending.length : this.length - this.pending.length;
      const take = Math.min(need, bytes.length - offset);
      this.pending = Buffer.concat([this.pending, bytes.subarray(offset, offset + take)]); offset += take;
      if (this.length === undefined && this.pending.length === 4) { this.length = this.pending.readUInt32BE(); this.pending = Buffer.alloc(0); if (!this.length || this.length > this.limit) throw new Error("Invalid worker packet length"); }
      else if (this.length !== undefined && this.pending.length === this.length) {
        results.push(object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(this.pending)) as unknown)); this.pending = Buffer.alloc(0); this.length = undefined;
      }
    }
    return results;
  }
  end(): void { if (this.pending.length || this.length !== undefined) throw new Error("Truncated worker packet"); }
}
interface Pending { resolve(value: unknown): void; reject(error: unknown): void; timer: NodeJS.Timeout; effect: boolean; lane: string; cleanup: boolean }
export interface WorkerTransport {
  request(action: string, args: Record<string, unknown>, options?: { lane?: string; effect?: boolean; limit?: number; cleanup?: boolean }): Promise<unknown>;
  close(): Promise<boolean>;
}
export interface ProcessWorkerOptions { command: readonly string[]; authorized: Authority; cleanupAuthorized?: Authority; timeoutMs?: number }
export class WindowsProcessWorker implements WorkerTransport {
  private child?: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string, Pending>(); private readonly lanes = new Set<string>();
  private readonly decoder = new PacketDecoder(); private readonly monitor: NodeJS.Timeout;
  private readonly timeout: number; private ended = false; private revoked = false; private exited = false;
  constructor(readonly options: ProcessWorkerOptions) {
    this.timeout = options.timeoutMs ?? 5000;
    if (!Number.isFinite(this.timeout) || this.timeout <= 0 || this.timeout > 30000 || !options.command.length || options.command.some(c => !c || c.includes("\0"))) throw new ServiceError("Invalid Windows worker configuration.", 400);
    this.monitor = setInterval(() => {
      if (!allowed(options.authorized)) {
        this.revoked = true;
        // An idle helper may retain explicit release-only authority. A native
        // ordinary call already in flight must still be interrupted and fenced.
        if (!allowed(options.cleanupAuthorized ?? options.authorized) || [...this.pending.values()].some(p => !p.cleanup)) void this.close();
      }
    }, 25); this.monitor.unref();
  }
  private start(): ChildProcessWithoutNullStreams {
    if (this.child) return this.child;
    const child = spawn(this.options.command[0]!, this.options.command.slice(1), { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, shell: false });
    this.child = child; child.stderr.resume();
    child.stdout.on("data", (bytes: Buffer) => { try { for (const value of this.decoder.push(bytes)) this.response(value); } catch { void this.close(); } });
    child.stdout.on("end", () => { try { this.decoder.end(); } catch { /* close below fences pending effects */ } void this.close(); });
    child.on("error", () => { this.exited = child.pid === undefined; void this.close(); });
    child.on("exit", () => { this.exited = true; void this.close(); });
    return child;
  }
  private response(value: Record<string, unknown>): void {
    const pending = typeof value.id === "string" ? this.pending.get(value.id) : undefined;
    if (!pending || typeof value.ok !== "boolean") { void this.close(); return; }
    if (value.ok) {
      if (Object.keys(value).sort().join(",") !== "id,ok,result") { void this.close(); return; }
      this.settle(value.id as string); pending.resolve(value.result);
    } else {
      if (Object.keys(value).sort().join(",") !== "code,id,ok,outcome,status" || ![400, 409, 410, 503].includes(value.status as number) || !["worker_refused", "worker_failed", "input_rejected", "capability_unsupported", "input_stale", "input_busy"].includes(value.code as string) || value.outcome !== null && value.outcome !== "unknown" || value.code === "input_rejected" && (value.status !== 409 || value.outcome !== null)) { void this.close(); return; }
      this.settle(value.id as string); pending.reject(new ServiceError("Windows native worker refused the operation.", value.status as number, { code: value.code as string, retryable: false, ...(value.outcome === "unknown" ? { outcome: "unknown" } : {}) }));
    }
  }
  private settle(id: string): void { const p = this.pending.get(id); if (!p) return; clearTimeout(p.timer); this.lanes.delete(p.lane); this.pending.delete(id); }
  async request(action: string, args: Record<string, unknown>, options: { lane?: string; effect?: boolean; limit?: number; cleanup?: boolean } = {}): Promise<unknown> {
    const lane = options.lane ?? "native", effect = options.effect ?? false;
    if (this.lanes.has(lane)) throw new ServiceError("Windows worker lane is busy.", 409, { code: "input_busy", retryable: false });
    if (!allowed(this.options.authorized)) this.revoked = true;
    if (this.ended || !(options.cleanup ? allowed(this.options.cleanupAuthorized ?? this.options.authorized) : !this.revoked && allowed(this.options.authorized))) {
      if (this.ended || !allowed(this.options.cleanupAuthorized ?? this.options.authorized)) await this.close();
      throw new ServiceError("Windows worker authorization ended.", 410, { retryable: false });
    }
    const id = randomUUID(), bytes = packet({ id, action, arguments: args }, options.limit ?? MAX_REQUEST);
    const child = this.start();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { void this.close(); }, this.timeout);
      this.lanes.add(lane); this.pending.set(id, { resolve: result => { if (!options.cleanup && (!allowed(this.options.authorized) || this.revoked)) { void this.close(); reject(effect ? uncertain("Worker authorization ended after dispatch.") : new ServiceError("Worker authorization ended.", 410)); } else resolve(result); }, reject, timer, effect, lane, cleanup: options.cleanup ?? false });
      child.stdin.write(bytes, error => { if (error) void this.close(); });
    });
  }
  async close(): Promise<boolean> {
    this.ended = true; clearInterval(this.monitor);
    for (const [id, p] of this.pending) { this.settle(id); p.reject(new ServiceError("Windows worker response was not confirmed.", 503, { code: "worker_interrupted", retryable: false, ...(p.effect ? { outcome: "unknown" } : {}) })); }
    const child = this.child; if (!child || this.exited) return true;
    const wait = (ms: number): Promise<boolean> => new Promise(resolve => { if (this.exited) { resolve(true); return; } const done = (): void => { clearTimeout(timer); resolve(true); }; const timer = setTimeout(() => { child.off("exit", done); resolve(this.exited); }, ms); child.once("exit", done); });
    try { child.kill("SIGTERM"); if (!await wait(250)) { child.kill("SIGKILL"); if (!await wait(500)) return false; } child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); return true; } catch { return this.exited; }
  }
}
