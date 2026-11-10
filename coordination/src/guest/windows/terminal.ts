import { ServiceError, base64, fields, integer, text, uuid, type Authority, allowed, uncertain, type MaybePromise } from "./common.ts";
import { type WorkerTransport } from "./ipc.ts";
export interface TerminalBinding { session: string; executable: string; argv: string[]; directory: string }
export interface TerminalAPI {
  open(binding: TerminalBinding, cols: number, rows: number): MaybePromise<unknown>;
  read(offset: number): MaybePromise<unknown>;
  write(text: string): MaybePromise<unknown>;
  resize(cols: number, rows: number): MaybePromise<unknown>;
  close(): MaybePromise<unknown>;
}
export function validateTerminalBinding(binding: TerminalBinding): TerminalBinding {
  const session = uuid(binding.session), absolute = (s: string): boolean => typeof s === "string" && /^[a-z]:[\\/]/i.test(s) && !s.includes("\0");
  if (!absolute(binding.executable) || !absolute(binding.directory) || !Array.isArray(binding.argv) || binding.argv[0] !== binding.executable || binding.argv.some(s => typeof s !== "string" || s.includes("\0")) || binding.argv.join(" ").length > 30000) throw new ServiceError("Use explicit absolute Windows executable and directory bindings.", 400);
  return { ...binding, session, argv: [...binding.argv] };
}
export class ConPTY {
  readonly binding: TerminalBinding;
  private started = false; private fenced = false; private revoked = false; private inputBusy = false; private readBusy = false; private lifecycleBusy = false;
  constructor(binding: TerminalBinding, readonly api: TerminalAPI, readonly authorized: Authority, readonly cleanupAuthorized: Authority = authorized) { this.binding = validateTerminalBinding(binding); }
  private authorize(cleanup = false): void { if (!allowed(this.authorized)) this.revoked = this.fenced = true; if (!(cleanup ? allowed(this.cleanupAuthorized) : !this.revoked && allowed(this.authorized))) throw new ServiceError("Windows terminal authorization ended.", 410); }
  async request(path: string, value: unknown): Promise<Record<string, unknown>> {
    const action = path.replace(/^\/v1\/shell\//, ""), names: Record<string, string[]> = { open: ["session", "cols", "rows"], read: ["session", "offset"], write: ["session", "text"], resize: ["session", "cols", "rows"], close: ["session"] };
    if (!names[action]) throw new ServiceError("Unsupported terminal operation.", 400);
    const body = fields(value, names[action]!);
    if (uuid(body.session) !== this.binding.session) throw new ServiceError("Terminal session binding differs.", 409);
    if (["open", "resize"].includes(action) && (!integer(body.cols, 1, 500) || !integer(body.rows, 1, 500))) throw new ServiceError("Terminal dimensions must be from 1 through 500.", 400);
    if (action === "read" && !integer(body.offset)) throw new ServiceError("Invalid terminal cursor.", 400);
    if (action === "write") text(body.text, 16384);
    const lane = action === "read" ? "readBusy" : action === "write" || action === "resize" ? "inputBusy" : "lifecycleBusy";
    if (this[lane]) throw new ServiceError("Terminal lane is busy.", 409, { code: "input_busy", retryable: false }); this[lane] = true;
    let dispatched = false;
    try {
      this.authorize(action === "close");
      if (action === "open") {
        if (this.started || this.fenced) throw new ServiceError("Windows terminal cannot restart or adopt a session.", 409);
        this.started = true; dispatched = true;
        const result = fields(await this.api.open(this.binding, body.cols as number, body.rows as number), ["session"]);
        if (result.session !== this.binding.session) throw uncertain("Terminal session acknowledgement differs."); this.authorize(); return result;
      }
      if (action === "close") { this.fenced = true; const result = fields(await this.api.close(), ["closed"]); if (typeof result.closed !== "boolean") throw uncertain("Terminal cleanup acknowledgement differs."); return result; }
      if (!this.started) throw new ServiceError("Terminal has no live session context.", 410);
      if (this.fenced && action !== "read") throw new ServiceError("Windows terminal input is fenced.", 410);
      if (action === "write") { dispatched = true; const result = fields(await this.api.write(body.text as string), ["written"]); if (result.written !== Buffer.byteLength(body.text as string)) throw uncertain("Terminal input acknowledgement differs."); this.authorize(); return result; }
      if (action === "resize") { dispatched = true; const result = fields(await this.api.resize(body.cols as number, body.rows as number), ["resized"]); if (result.resized !== true) throw uncertain("Terminal resize acknowledgement differs."); this.authorize(); return result; }
      const result = fields(await this.api.read(body.offset as number), ["session", "data", "offset", "truncated", "exited", "exitCode"]), data = base64(result.data, 65536);
      if (result.session !== this.binding.session || !integer(result.offset, body.offset as number) || typeof result.truncated !== "boolean" || typeof result.exited !== "boolean" || result.exitCode !== null && !integer(result.exitCode, -Number.MAX_SAFE_INTEGER) || !result.truncated && result.offset - (body.offset as number) !== data.length || result.truncated && result.offset - data.length <= (body.offset as number)) throw new ServiceError("Terminal output cursor or metadata differs.", 409);
      this.authorize(); return result;
    } catch (error) { if (dispatched) { this.fenced = true; throw uncertain("Windows terminal effect was not confirmed; it will not be replayed."); } throw error; }
    finally { this[lane] = false; }
  }
}
export class WindowsTerminalWorker extends ConPTY {
  cleanupConfirmed = false;
  private nativeCleanupConfirmed = false;
  constructor(binding: TerminalBinding, readonly transport: WorkerTransport, authorized: Authority, cleanupAuthorized: Authority = authorized) {
    super(binding, {
      open: (binding, cols, rows) => transport.request("terminal.open", { ...binding, cols, rows }, { lane: "terminal.lifecycle", effect: true, limit: 65536 }),
      read: offset => transport.request("terminal.read", { offset }, { lane: "terminal.read" }),
      write: text => transport.request("terminal.write", { text }, { lane: "terminal.input", effect: true }),
      resize: (cols, rows) => transport.request("terminal.resize", { cols, rows }, { lane: "terminal.input", effect: true }),
      close: () => transport.request("terminal.close", {}, { lane: "terminal.lifecycle", cleanup: true }),
    }, authorized, cleanupAuthorized);
  }
  override async request(path: string, value: unknown): Promise<Record<string, unknown>> {
    if (path !== "/v1/shell/close") return super.request(path, value);
    const body = fields(value, ["session"]);
    if (uuid(body.session) !== this.binding.session) throw new ServiceError("Terminal session binding differs.", 409);
    if (this.cleanupConfirmed) return { closed: true };
    if (!this.nativeCleanupConfirmed) {
      const receipt = await super.request(path, value);
      if (receipt.closed !== true) return { closed: false };
      this.nativeCleanupConfirmed = true;
    }
    this.cleanupConfirmed = await this.transport.close();
    return { closed: this.cleanupConfirmed };
  }
  async shutdown(): Promise<boolean> {
    if (this.cleanupConfirmed) return true;
    try {
      const receipt = await this.request("/v1/shell/close", { session: this.binding.session }); return receipt.closed === true;
    } catch { await this.transport.close(); return false; }
  }
}
