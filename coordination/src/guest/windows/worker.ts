import { randomUUID } from "node:crypto";
import { Lane, ServiceError, allowed, fields, integer, object, unsupported, uuid, type Authority, type MaybePromise } from "./common.ts";
import { WindowsDownloads, validateFileRequest } from "./downloads.ts";
import { WindowsRoot, type WindowsFileAPI } from "./files.ts";
import { Win32Files, NativeDesktop, NativeKeys, NativeUIA, nativeTransport } from "./native.ts";
import { WindowsInspections, type WindowsUIAAPI } from "./accessibility.ts";
import { WindowsHeldInput, type Bounds, type HeldState, type InputBackend, type KeyResolver } from "./input.ts";
import { WindowsKeys } from "./keys.ts";
import { WindowsTerminalWorker, type TerminalBinding } from "./terminal.ts";
import { type WorkerTransport } from "./ipc.ts";
export interface WindowsGuestOptions {
  /** Bound by the guest server to the current assignment and credential. */
  authorized: Authority;
  cleanupAuthorized?: Authority;
  files?: { drive: string; prefix: readonly string[]; resolve(path: string): readonly string[]; api?: WindowsFileAPI };
  transport?: WorkerTransport;
  transportFactory?: () => WorkerTransport;
  /** Executable/argv/directory come from trusted guest configuration, never HTTP. */
  terminal?: Omit<TerminalBinding, "session">;
  uia?: WindowsUIAAPI<string>;
  desktop?: { capture(): MaybePromise<{ bounds: Bounds; png: Buffer }>; post: InputBackend["post"]; close(): MaybePromise<boolean> };
  held?: { resolve?: KeyResolver; save(state: HeldState): MaybePromise<boolean>; recovered?: HeldState };
  /** Exclusive display/UIA owner gate. Required for any native UI effect. */
  inputAuthorized?: Authority;
  clock?: () => number;
}
/** Internal guest dispatcher. No listener, host fallback, credential selection or admission. */
export class WindowsGuestWorker {
  readonly ui = new Lane(); readonly terminals = new Map<string, WindowsTerminalWorker>();
  private readonly root?: WindowsRoot; private downloads?: WindowsDownloads; private start?: Promise<void>;
  private transportValue?: WorkerTransport; private inspectionsValue?: WindowsInspections<string>; private heldValue?: WindowsHeldInput;
  private frame?: { id: string; bounds: Bounds; expires: number }; private sequence = 0; private closed = false; private revoked = false; private cleanupConfirmed = false;
  private desktopReleased = false;
  readonly clock: () => number;
  constructor(readonly options: WindowsGuestOptions) {
    this.clock = options.clock ?? (() => performance.now() / 1000);
    if (options.transport) this.transportValue = options.transport;
    if (options.files) { const f = options.files; this.root = new WindowsRoot(f.drive, f.prefix, f.api ?? new Win32Files(this.transport)); }
  }
  private get transport(): WorkerTransport { return this.transportValue ??= this.options.transportFactory?.() ?? nativeTransport(this.options.authorized, this.options.cleanupAuthorized ?? this.options.authorized); }
  private authorize(cleanup = false): void {
    if (!allowed(this.options.authorized)) this.revoked = true;
    if (this.closed || !(cleanup ? allowed(this.options.cleanupAuthorized ?? this.options.authorized) : !this.revoked && allowed(this.options.authorized))) throw new ServiceError("Windows guest assignment ended.", 410, { retryable: false });
  }
  private inputAuthority = (): boolean => !this.closed && !this.revoked && allowed(this.options.authorized) && !!this.options.inputAuthorized && allowed(this.options.inputAuthorized);
  private async files(): Promise<WindowsDownloads> {
    if (!this.root || !this.options.files) unsupported("Windows file root is not bound.");
    this.start ??= this.root.start().then(() => { this.downloads = new WindowsDownloads(this.root!, this.options.files!.resolve, this.options.authorized, this.options.cleanupAuthorized ?? this.options.authorized); });
    await this.start; return this.downloads!;
  }
  private get inspections(): WindowsInspections<string> { return this.inspectionsValue ??= new WindowsInspections(this.options.uia ?? new NativeUIA(this.transport), this.options.authorized, this.clock, this.inputAuthority); }
  private get desktop(): NonNullable<WindowsGuestOptions["desktop"]> {
    if (this.options.desktop) return this.options.desktop;
    const native = new NativeDesktop(this.transport);
    return { capture: () => native.capture(), post: async (events, bounds, cleanup) => { if (await native.post(events, bounds, cleanup) !== events.length) throw new ServiceError("Windows input count is unconfirmed.", 409, { outcome: "unknown" }); return { posted: true }; }, close: () => native.close() };
  }
  private get held(): WindowsHeldInput {
    if (this.heldValue) return this.heldValue;
    if (!this.options.held) unsupported("Windows input requires a durable assignment-bound journal.");
    const held = this.options.held;
    const resolver = held.resolve ?? new WindowsKeys(new NativeKeys(this.transport), this.inputAuthority).resolve;
    return this.heldValue = new WindowsHeldInput(this.desktop, resolver, held.save, this.inputAuthority, this.options.cleanupAuthorized ?? this.options.authorized, held.recovered);
  }
  private consume(args: Record<string, unknown>): Bounds {
    if (!this.inputAuthority()) throw new ServiceError("Windows exclusive input ownership is unavailable.", 409, { code: "input_rejected" });
    if (!integer(args.sequence, 1) || args.sequence !== this.sequence + 1) throw new ServiceError("Windows input sequence differs; effects are not replayed.", 409, { code: "input_stale" });
    if (!this.frame || args.frameId !== this.frame.id || this.clock() >= this.frame.expires) throw new ServiceError("Windows input frame is stale.", 409, { code: "input_stale" });
    this.sequence = args.sequence; return this.frame.bounds;
  }
  async request(method: string, path: string, body: unknown = {}): Promise<unknown> {
    this.authorize(path === "/v1/files/abort" || path === "/v1/input/reset" || path === "/v1/shell/close");
    if (method === "GET" && path === "/healthz") return { ok: true };
    if (method !== "POST") throw new ServiceError("Unknown Windows guest endpoint.", 404);
    if (path.startsWith("/v1/files/")) { validateFileRequest(path, body); return (await this.files()).request(path, body); }
    if (path.startsWith("/v1/shell/")) {
      const args = object(body), session = uuid(args.session); let worker = this.terminals.get(session);
      if (!worker) { if (path !== "/v1/shell/open") throw new ServiceError("Windows terminal is unknown.", 404); if (!this.options.terminal) unsupported("Windows terminal executable is not bound."); worker = new WindowsTerminalWorker({ ...this.options.terminal, session }, this.options.transportFactory?.() ?? nativeTransport(this.options.authorized, this.options.cleanupAuthorized ?? this.options.authorized), this.options.authorized, this.options.cleanupAuthorized ?? this.options.authorized); this.terminals.set(session, worker); }
      return worker.request(path, body);
    }
    return this.ui.run(async () => {
      this.authorize(path === "/v1/input/reset");
      if (path === "/v1/display/capture") { fields(body, []); const result = await this.desktop.capture(); this.authorize(); const id = randomUUID(); this.frame = { id, bounds: result.bounds, expires: this.clock() + 15 }; return { id, capturedAt: Date.now() / 1000, width: result.bounds[2], height: result.bounds[3], bounds: result.bounds, data: result.png.toString("base64"), mediaType: "image/png" }; }
      if (path === "/v1/accessibility/inspect") { fields(body, []); return this.inspections.inspect(); }
      if (path === "/v1/accessibility/invoke") {
        if (!this.inputAuthority()) throw new ServiceError("Windows exclusive UIA ownership is unavailable.", 409, { code: "input_rejected" });
        if (this.heldValue && (this.heldValue.state.blocked || this.heldValue.state.keys.length || this.heldValue.state.buttons)) throw new ServiceError("Release held input before UIA invocation.", 409);
        return this.inspections.invoke(body);
      }
      if (path === "/v1/input/reset") { fields(body, []); return this.held.reset(); }
      if (path === "/v1/input/key") { const a = fields(body, ["frameId", "sequence", "keysym", "down"]), bounds = this.consume(a); return this.held.key(a.keysym as number, a.down as boolean, bounds); }
      if (path === "/v1/input/pointer") { const a = fields(body, ["frameId", "sequence", "x", "y", "mask"]), bounds = this.consume(a); return this.held.pointer(a.x as number, a.y as number, a.mask as number, bounds); }
      if (path === "/v1/input/text") { const a = fields(body, ["frameId", "sequence", "text"]), bounds = this.consume(a); return this.held.text(a.text as string, bounds); }
      unsupported("Windows guest operation is unavailable for this binding.");
    });
  }
  /** Confirm native releases before stopping helpers; process exit alone proves no release. */
  async close(): Promise<boolean> {
    if (this.cleanupConfirmed) return true;
    if (this.ui.busy) return false;
    let confirmed = true;
    if (this.heldValue) { try { await this.heldValue.reset(); } catch { confirmed = false; } }
    this.closed = true;
    for (const terminal of this.terminals.values()) if (!await terminal.shutdown()) confirmed = false;
    if (this.root && !await this.root.close()) confirmed = false;
    if ((this.transportValue || this.options.desktop) && !this.desktopReleased) { try { this.desktopReleased = await this.desktop.close(); if (!this.desktopReleased) confirmed = false; } catch { confirmed = false; } }
    // Retain the daemon while owned native release is still retryable.
    if (!confirmed) return false;
    if (this.transportValue && !await this.transportValue.close()) confirmed = false;
    this.cleanupConfirmed = confirmed;
    return confirmed;
  }
}
export { WindowsGuestWorker as WindowsWorker };
