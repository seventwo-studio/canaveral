import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { ServiceError, object } from "../errors.ts";
import { SqliteStore } from "../sqlite.ts";
import { decodeData, jsonBytes, uuid } from "../control/transfers.ts";
import { operationRequest } from "../control/devices.ts";
import type { OperationRequest } from "../control/devices.ts";
import type { SessionChannel } from "../control/session-protocol.ts";
import { compactLength, dimensions } from "../providers/mobile.ts";
import { authorized, integer, sameUUID, validUnicode } from "./https.ts";
import type { Authority, GuestRequest } from "./https.ts";

export class InputDenied extends ServiceError {}
export type BootEpoch = { startedAt: number; identity: string } | null;
export type InputState = "owned" | "busy" | "stale" | "reset-uncertain";
interface InputRecord { phase: "idle" | "active" | "blocked"; owner: string | null; epoch: BootEpoch }
export const INPUT_ACTIONS = new Set(["tap", "swipe", "text", "key", "accessibility-action", "launch", "terminate", "open-url", "rotate", "location", "permission", "install", "uninstall"]);
function epoch(value: BootEpoch): BootEpoch {
  if (value !== null && (typeof value !== "object" || Object.keys(value).sort().join() !== "identity,startedAt" || typeof value.startedAt !== "number" || !Number.isFinite(value.startedAt) || typeof value.identity !== "string" || !value.identity)) throw new ServiceError("Invalid display boot identity.", 409);
  return value === null ? null : { ...value };
}
/** Callers retain the runner's exclusive process lock. Recovery never treats an active claim as released. */
export class DisplayControls {
  readonly records = new Map<string, InputRecord>();
  readonly endpoints = new Set<DisplayEndpoint>();
  readonly store: SqliteStore;
  stopping = false;
  constructor(store: SqliteStore | string) {
    this.store = typeof store === "string" ? new SqliteStore(store) : store;
    this.store.transaction(db => {
      db.exec("CREATE TABLE IF NOT EXISTS guest_display_controls(machine TEXT PRIMARY KEY,record TEXT NOT NULL)");
      for (const row of db.prepare("SELECT machine,record FROM guest_display_controls").all() as { machine: string; record: string }[]) {
        const record = object(JSON.parse(row.record));
        if (!["active", "idle", "blocked"].includes(record.phase as string) || !(record.owner === null || typeof record.owner === "string")) throw new ServiceError("Invalid display recovery record.", 409);
        this.records.set(row.machine, { phase: record.phase === "active" ? "blocked" : record.phase as "idle" | "blocked", owner: null, epoch: epoch(record.epoch as BootEpoch) });
      }
    });
  }
  private save(machine: string, record: InputRecord): void {
    try { this.store.transaction(db => { db.prepare("INSERT INTO guest_display_controls(machine,record) VALUES(?,?) ON CONFLICT(machine) DO UPDATE SET record=excluded.record").run(machine, JSON.stringify(record)); }); }
    catch (error) { record.phase = "blocked"; record.owner = null; throw error; }
  }
  claim(machine: string, viewer: string, boot: BootEpoch, current: Authority): InputState {
    if (this.stopping) return "stale";
    boot = epoch(boot);
    if (!authorized(current)) return "stale";
    let record = this.records.get(machine);
    if (!record) { record = { phase: "idle", owner: null, epoch: boot }; this.records.set(machine, record); }
    const previous = record.epoch;
    if (boot && previous && !isDeepStrictEqual(boot, previous)) {
      if (boot.startedAt <= previous.startedAt) return "stale";
      record.phase = "idle"; record.owner = null; record.epoch = boot;
    }
    // Missing boot evidence may never erase a known boot's held-input fence.
    if (previous && boot === null) return "stale";
    if (record.phase === "blocked") return "reset-uncertain";
    if (record.phase === "active") return record.owner === viewer && isDeepStrictEqual(record.epoch, boot) ? "owned" : "busy";
    record.phase = "active"; record.owner = viewer; record.epoch = boot; this.save(machine, record);
    return "owned";
  }
  owns(machine: string, viewer: string, boot: BootEpoch): boolean {
    const r = this.records.get(machine);
    return r?.phase === "active" && r.owner === viewer && isDeepStrictEqual(r.epoch, boot);
  }
  release(machine: string, viewer: string, boot: BootEpoch, reset: boolean): void {
    if (!this.owns(machine, viewer, boot)) return;
    const r = this.records.get(machine)!; r.phase = reset ? "idle" : "blocked"; r.owner = null; this.save(machine, r);
  }
  async discrete<T>(machine: string, operation: string, getEpoch: () => BootEpoch, check: Authority, work: () => Promise<T>): Promise<T> {
    const viewer = `operation:${uuid(operation)}`, boot = epoch(getEpoch());
    const state = this.claim(machine, viewer, boot, () => authorized(check) && isDeepStrictEqual(getEpoch(), boot));
    if (state !== "owned") throw new InputDenied("Input ownership or recovery prevents dispatch.", 409, { code: `input_${state.replaceAll("-", "_")}`, retryable: false });
    let complete = false;
    try {
      if (!authorized(check) || !isDeepStrictEqual(getEpoch(), boot)) { complete = true; throw new InputDenied("Input authorization changed before dispatch.", 410); }
      const result = await work(); complete = true; return result;
    } catch (error) { if (error instanceof InputDenied) complete = true; throw error; }
    finally { this.release(machine, viewer, boot, complete); }
  }
  async close(): Promise<void> {
    this.stopping = true;
    const live = [...this.endpoints]; live.forEach(e => e.close());
    await Promise.all(live.map(e => e.finished));
  }
}

/** Incremental RFB client framing. Unsupported extensions cannot bypass ownership. */
export class ClientMessages {
  private pending: Buffer = Buffer.alloc(0);
  readonly encodings = new Set([0, 1, 2, 4, 5, 6, 7, 16, -260, -223, -239]);
  feed(data: Uint8Array): [number, Buffer][] {
    if (this.pending.length + data.length > 81920) throw new ServiceError("Display input buffer exceeded.", 400);
    this.pending = Buffer.concat([this.pending, data]); const output: [number, Buffer][] = [];
    while (this.pending.length) {
      const kind = this.pending[0]!; let size: number;
      if ([0, 3, 4, 5].includes(kind)) size = ({ 0: 20, 3: 10, 4: 8, 5: 6 } as Record<number, number>)[kind]!;
      else if (kind === 2) {
        if (this.pending.length < 4) break;
        const count = this.pending.readUInt16BE(2);
        if (count > 256) throw new ServiceError("Too many display encodings.", 400);
        size = 4 + count * 4;
      } else if (kind === 6) {
        if (this.pending.length < 8) break;
        const count = this.pending.readUInt32BE(4);
        if (count > 16000) throw new ServiceError("Display clipboard exceeds 16 KiB.", 400);
        size = 8 + count;
      } else throw new ServiceError("Unsupported RFB client message.", 400);
      if (this.pending.length < size) break;
      let frame = Buffer.from(this.pending.subarray(0, size)); this.pending = this.pending.subarray(size);
      if (kind === 2) {
        const values = Array.from({ length: (size - 4) / 4 }, (_, i) => frame.readInt32BE(4 + i * 4)).filter(n => this.encodings.has(n));
        if (!values.length) values.push(0);
        frame = Buffer.alloc(4 + values.length * 4); frame[0] = 2; frame.writeUInt16BE(values.length, 2); values.forEach((n, i) => frame.writeInt32BE(n, 4 + i * 4));
      }
      if (kind === 4 && frame[1] !== 0 && frame[1] !== 1) throw new ServiceError("Invalid RFB key state.", 400);
      output.push([kind, frame]);
    }
    return output;
  }
}

export class GuestStreamScreen {
  stream: string | null = null;
  sequence = 0;
  owned = false;
  uncertain = false;
  frame: string | null = null;
  frameSize: [number, number] | null = null;
  private closed = false;
  private tail: Promise<unknown> = Promise.resolve();
  constructor(readonly request: GuestRequest, readonly check: Authority, readonly cleanupAuthorized: Authority = check, readonly captureRetryTimeoutSeconds = 5) {
    if (!Number.isFinite(captureRetryTimeoutSeconds) || captureRetryTimeoutSeconds < 0) throw new ServiceError("Native capture retry timeout must be finite and nonnegative.", 400);
  }
  private lane<T>(work: () => Promise<T>): Promise<T> { const next = this.tail.then(work); this.tail = next.catch(() => {}); return next; }
  private async call(path: string, body: Record<string, unknown> | null, cleanup = false): Promise<Record<string, unknown>> {
    const check = cleanup ? this.cleanupAuthorized : this.check;
    const fail = () => new ServiceError("Native display authorization ended before acknowledgement.", 410, { retryable: false, ...(body === null ? {} : { outcome: "unknown" as const }) });
    if (!authorized(check) || (this.closed && !cleanup)) throw fail();
    const result = object(await this.request(path, body));
    if (!authorized(check) || (this.closed && !cleanup)) throw fail();
    return result;
  }
  capture(): Promise<Buffer> { return this.lane(async () => {
    const deadline = performance.now() + this.captureRetryTimeoutSeconds * 1000;
    let value: Record<string, unknown>;
    while (true) {
      try { value = await this.call("/v1/display/frame", null); break; }
      catch (error) {
        if (!(error instanceof ServiceError) || error.status !== 409 || !["input_busy", "input_stale"].includes(error.code) || performance.now() >= deadline) throw error;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    }
    const frame = object(value.frame), bounds = object(value.bounds);
    if (!integer(value.displayID, 0xffffffff) || !value.displayID || Object.keys(bounds).sort().join() !== "height,width,x,y" || Object.values(bounds).some(v => typeof v !== "number" || !Number.isFinite(v)) || (bounds.width as number) <= 0 || (bounds.height as number) <= 0) throw new ServiceError("Native display metadata is malformed.", 409);
    const png = decodeData(frame.pngBase64, 6_000_000), size = dimensions(png);
    if (frame.width !== size[0] || frame.height !== size[1] || Math.max(...size) > 4096) throw new ServiceError("Native display pixels differ from their metadata.", 409);
    compactLength(png.length);
    this.frame = uuid(frame.id); this.frameSize = size;
    return png;
  }); }
  takeInput(): Promise<"owned" | "busy" | "reset-uncertain"> { return this.lane(async () => {
    if (this.closed || !authorized(this.check)) throw new ServiceError("Native input authorization ended.", 410);
    if (this.uncertain || (this.stream !== null && !this.owned)) return "reset-uncertain";
    if (this.stream === null) { this.stream = randomUUID(); this.sequence = 0; }
    try {
      const r = await this.call("/v1/display/take", { streamId: this.stream });
      if (!sameUUID(r.streamId, this.stream) || r.state !== "owned" || r.sequence !== this.sequence) throw new ServiceError("Native input claim was not confirmed.", 409);
    } catch (error) {
      if (error instanceof ServiceError && error.status === 409 && error.code === "input_busy") { this.stream = null; this.owned = false; return "busy"; }
      if (error instanceof ServiceError && error.status === 409 && error.code === "input_reset_uncertain") { this.stream = null; this.owned = false; }
      this.uncertain = true;
      return "reset-uncertain";
    }
    this.owned = true; return "owned";
  }); }
  private async send(event: Record<string, unknown>): Promise<void> {
    if (!this.owned || this.uncertain || this.frame === null) throw new ServiceError("Native stream does not own fresh input.", 409);
    if (this.sequence >= Number.MAX_SAFE_INTEGER) throw new ServiceError("Native input sequence is exhausted.", 409);
    const value = { streamId: this.stream, sequence: this.sequence + 1, frameId: this.frame, event };
    jsonBytes(value, 16384);
    try {
      const r = await this.call("/v1/display/input", value);
      if (!sameUUID(r.streamId, this.stream!) || r.sequence !== this.sequence + 1 || r.posted !== true) throw new ServiceError("Native input acknowledgement differs; input will not be replayed.", 409, { outcome: "unknown", retryable: false });
      this.sequence++;
    } catch (error) { this.uncertain = true; throw error; }
  }
  pointer(mask: number, x: number, y: number): Promise<void> { return this.lane(async () => {
    if (!integer(mask, 255) || !this.frameSize || !integer(x) || !integer(y) || x >= this.frameSize[0] || y >= this.frameSize[1]) throw new ServiceError("Pointer is outside the issued native frame.", 400);
    await this.send({ type: "pointer", x, y, buttons: mask });
  }); }
  key(down: number | boolean, keysym: number): Promise<void> { return this.lane(async () => {
    if (![0, 1, false, true].includes(down) || !integer(keysym, 0xffffffff)) throw new ServiceError("Invalid native RFB key event.", 400);
    await this.send({ type: "key", keysym, down: Boolean(down) });
  }); }
  action(action: string, args: Record<string, unknown>): Promise<void> { return this.lane(async () => {
    const text = args.text;
    if (action !== "text" || Object.keys(args).join() !== "text" || typeof text !== "string" || !validUnicode(text) || text.includes("\0") || Buffer.byteLength(text) > 16000) throw new ServiceError("Invalid native clipboard text.", 400);
    await this.send({ type: "text", text });
  }); }
  controlAction(input: OperationRequest): Promise<Record<string, unknown>> { return this.lane(async () => {
    const request = operationRequest(input);
    if (!this.owned || this.uncertain || this.closed || !authorized(this.check)) throw new InputDenied("Native display does not own this input context.", 409, { code: "input_not_owned" });
    if (!["tap", "text", "key", "accessibility-action"].includes(request.action)) throw new InputDenied("Native semantic action is unsupported.", 409, { code: "capability_unsupported" });
    if (request.action !== "accessibility-action" && this.frame === null) throw new InputDenied("Capture a native frame before acting.", 409, { code: "input_stale" });
    const value = { streamId: this.stream, ...request, ...(request.action === "accessibility-action" ? {} : { frameId: this.frame }) };
    jsonBytes(value, 16384);
    try {
      const result = await this.call("/v1/display/action", value);
      if (!sameUUID(result.id, request.id) || result.status !== "posted") throw new ServiceError("Native semantic input was not confirmed.", 409);
    } catch (error) {
      if (error instanceof ServiceError && error.status === 409 && ["input_busy", "input_stale", "capability_unsupported"].includes(error.code)) throw new InputDenied("Native semantic input was refused before dispatch.", 409, { code: error.code, retryable: false });
      this.uncertain = true;
      throw new ServiceError("Native semantic input outcome is unknown; inspect before retrying.", 409, { outcome: "unknown", retryable: false });
    }
    return { posted: true };
  }); }
  resetInput(): Promise<boolean> { return this.lane(() => this.release()); }
  private async release(): Promise<boolean> {
    if (this.stream === null) return !this.uncertain;
    try {
      const result = await this.call("/v1/display/release", { streamId: this.stream }, true);
      if (result.released !== true) throw new ServiceError("Native held-input reset was not confirmed.", 409);
      this.stream = null; this.sequence = 0; this.owned = false; this.uncertain = false;
      return true;
    } catch (error) { this.uncertain = true; throw error; }
  }
  async closeInput(): Promise<void> { this.closed = true; try { await this.resetInput(); } catch { /* Cleanup failure remains uncertain. */ } }
}

export interface DisplayConnection {
  /** null means bounded poll timeout; an empty array means EOF. */
  read(maximum: number, timeoutSeconds?: number): Promise<Uint8Array | null>;
  write(data: Uint8Array): Promise<void>;
  close(): void | Promise<void>;
  cancelInput?(): Promise<boolean>;
  takeInput?(): Promise<"owned" | "busy" | "reset-uncertain">;
  controlAction?(request: OperationRequest): Promise<Record<string, unknown>>;
}
function rectangle(size: [number, number], encoding: number): Buffer { const b = Buffer.alloc(12); b.writeUInt16BE(size[0], 4); b.writeUInt16BE(size[1], 6); b.writeInt32BE(encoding, 8); return b; }
/** Private in-memory RFB peer. The write lane is also the ordered input/reset barrier. */
export class GuestStreamConnection implements DisplayConnection {
  private output: Buffer = Buffer.alloc(0);
  private wake: (() => void) | undefined;
  private dead = false;
  private state = 0;
  private pending: Buffer = Buffer.alloc(0);
  private parser = new ClientMessages();
  private encodings = new Set<number>();
  private size: [number, number] | undefined;
  private lastFrame = -Infinity;
  private tail: Promise<unknown>;
  constructor(readonly screen: GuestStreamScreen) {
    this.tail = screen.capture().then(png => { this.size = dimensions(png); this.emit(Buffer.from("RFB 003.008\n")); }).catch(async () => { await this.close(); });
  }
  private emit(data: Buffer): void {
    if (this.dead) throw new ServiceError("Native display connection ended.", 410);
    if (this.output.length + data.length > 4194304 + 65536) throw new ServiceError("Display output backpressure exceeded.", 409);
    this.output = Buffer.concat([this.output, data]); this.wake?.();
  }
  async read(maximum: number, timeoutSeconds = 0.1): Promise<Uint8Array | null> {
    if (!integer(maximum, 65536) || !maximum) throw new ServiceError("Use bounded display reads.", 400);
    if (!this.output.length && !this.dead) await new Promise<void>(resolve => {
      const done = () => { clearTimeout(timer); if (this.wake === done) this.wake = undefined; resolve(); };
      const timer = setTimeout(done, Math.max(0, timeoutSeconds * 1000)); this.wake = done;
    });
    if (!this.output.length) return this.dead ? Buffer.alloc(0) : null;
    const value = this.output.subarray(0, maximum); this.output = this.output.subarray(value.length); return value;
  }
  private lane<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(() => { if (this.dead) throw new ServiceError("Display connection ended.", 410); return work(); });
    this.tail = result.catch(() => {}); return result;
  }
  write(data: Uint8Array): Promise<void> { return this.lane(async () => {
    if (this.state < 3) {
      if (this.pending.length + data.length > 81920) throw new ServiceError("Display handshake buffer exceeded.", 400);
      this.pending = Buffer.concat([this.pending, data]);
      while (this.state < 3) {
        const n = this.state === 0 ? 12 : 1;
        if (this.pending.length < n) return;
        const part = this.pending.subarray(0, n); this.pending = this.pending.subarray(n);
        if (this.state === 0) { if (part.toString() !== "RFB 003.008\n") throw new ServiceError("RFB 3.8 is required.", 400); this.emit(Buffer.from([1, 1])); }
        else if (this.state === 1) { if (part[0] !== 1) throw new ServiceError("Invalid RFB security selection.", 400); this.emit(Buffer.alloc(4)); }
        else {
          if (part[0] !== 0 && part[0] !== 1) throw new ServiceError("Invalid RFB initialization.", 400);
          const name = Buffer.from("Canaveral display"), info = Buffer.alloc(24);
          info.writeUInt16BE(this.size![0], 0); info.writeUInt16BE(this.size![1], 2);
          Buffer.from([32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 16, 8, 0, 0, 0, 0]).copy(info, 4); info.writeUInt32BE(name.length, 20);
          this.emit(Buffer.concat([info, name]));
        }
        this.state++;
      }
      data = this.pending; this.pending = Buffer.alloc(0);
    }
    for (const [kind, frame] of this.parser.feed(data)) {
      if (kind === 2) this.encodings = new Set(Array.from({ length: frame.readUInt16BE(2) }, (_, i) => frame.readInt32BE(4 + i * 4)));
      else if (kind === 3) {
        if (!this.encodings.has(-260)) throw new ServiceError("Native frame requires TightPNG encoding.", 409);
        const delay = 250 - (performance.now() - this.lastFrame); if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
        const png = await this.screen.capture(), size = dimensions(png), rectangles: Buffer[] = [];
        if (this.size && !isDeepStrictEqual(this.size, size)) {
          if (!this.encodings.has(-223)) throw new ServiceError("Client cannot resize the display.", 409);
          rectangles.push(rectangle(size, -223));
        }
        this.size = size; this.lastFrame = performance.now();
        rectangles.push(Buffer.concat([rectangle(size, -260), Buffer.from([0xa0]), compactLength(png.length), png]));
        this.emit(Buffer.concat([Buffer.from([0, 0, 0, rectangles.length]), ...rectangles]));
      } else if (kind === 4) await this.screen.key(frame[1]!, frame.readUInt32BE(4));
      else if (kind === 5) await this.screen.pointer(frame[1]!, frame.readUInt16BE(2), frame.readUInt16BE(4));
      else if (kind === 6) await this.screen.action("text", { text: new TextDecoder("utf-8", { fatal: true }).decode(frame.subarray(8)) });
    }
  }); }
  takeInput(): Promise<"owned" | "busy" | "reset-uncertain"> { return this.lane(() => this.screen.takeInput()); }
  cancelInput(): Promise<boolean> { return this.lane(() => this.screen.resetInput()); }
  controlAction(request: OperationRequest): Promise<Record<string, unknown>> { return this.lane(() => this.screen.controlAction(request)); }
  async close(): Promise<void> { if (this.dead) return; this.dead = true; this.output = Buffer.alloc(0); this.wake?.(); await this.screen.closeInput(); }
}
export function connect(request: GuestRequest, check: Authority, cleanupAuthorized: Authority = check, captureRetryTimeoutSeconds = 5): GuestStreamConnection {
  return new GuestStreamConnection(new GuestStreamScreen(request, check, cleanupAuthorized, captureRetryTimeoutSeconds));
}

export interface ActionReport { state: "succeeded" | "failed" | "unknown"; result?: unknown }
export interface DisplayOptions {
  epoch?: () => BootEpoch;
  viewer?: string;
  actionHandler?: (request: OperationRequest) => Promise<ActionReport>;
  receiptHandler?: (id: string) => Promise<ActionReport>;
  /** Executes the supplied effect inside the provider's durable operation receipt. */
  contextActionHandler?: (request: OperationRequest, effect: (request: OperationRequest) => Promise<Record<string, unknown>>) => Promise<ActionReport>;
}
export class DisplayEndpoint {
  readonly viewer: string;
  epoch: BootEpoch = null;
  readonly finished: Promise<void>;
  private finish!: () => void;
  private cancelled = false;
  private channel: SessionChannel | undefined;
  remote: DisplayConnection | undefined;
  readonly keys = new Set<number>();
  pointer: [number, number, number] = [0, 0, 0];
  initialized = false;
  streamOK = true;
  constructor(readonly controls: DisplayControls, readonly machine: string, readonly factory: () => DisplayConnection | Promise<DisplayConnection>, readonly check: Authority, readonly options: DisplayOptions = {}) {
    uuid(machine); this.viewer = options.viewer ?? randomUUID(); this.finished = new Promise(resolve => { this.finish = resolve; });
  }
  authorized(): boolean { return !this.cancelled && authorized(this.check); }
  current(): boolean { return isDeepStrictEqual(this.options.epoch?.() ?? null, this.epoch); }
  close(): void { this.cancelled = true; this.channel?.close(); }
  private async write(data: Uint8Array, cleanup = false): Promise<void> {
    if (!cleanup && (!this.authorized() || !this.current())) throw new ServiceError("Display authorization ended.", 410);
    try { await this.remote!.write(data); } catch (error) { this.streamOK = false; throw error; }
  }
  async resetInput(): Promise<boolean> {
    if (!this.streamOK || !this.remote) return false;
    try {
      if (this.remote.cancelInput) { if (await this.remote.cancelInput() !== true) return false; }
      else {
        for (const key of [...this.keys].sort((a, b) => a - b)) { const f = Buffer.alloc(8); f[0] = 4; f.writeUInt32BE(key, 4); await this.write(f, true); }
        const f = Buffer.alloc(6); f[0] = 5; f.writeUInt16BE(this.pointer[1], 2); f.writeUInt16BE(this.pointer[2], 4); await this.write(f, true);
      }
      this.keys.clear(); this.pointer = [0, 0, 0]; return true;
    } catch { return false; }
  }
  private async handshake(): Promise<Buffer> {
    const readSource = async (n: number) => {
      let b: Buffer = Buffer.alloc(0); const deadline = performance.now() + 10000;
      while (b.length < n) {
        if (!this.authorized() || !this.current() || performance.now() >= deadline) throw new ServiceError("Provider display handshake ended.", 410);
        const part = await this.remote!.read(n - b.length, 0.1);
        if (part === null) continue;
        if (!part.length || part.length > n - b.length) throw new ServiceError("Provider display handshake ended.", 409);
        b = Buffer.concat([b, part]);
      }
      return b;
    };
    if ((await readSource(12)).toString() !== "RFB 003.008\n") throw new ServiceError("Provider requires RFB 3.8.", 409, { code: "capability_unsupported" });
    await this.write(Buffer.from("RFB 003.008\n")); const count = (await readSource(1))[0]!;
    if (!count || count > 64 || !(await readSource(count)).includes(1)) throw new ServiceError("Provider display authentication is not configured.", 409);
    await this.write(Buffer.from([1])); if (!(await readSource(4)).equals(Buffer.alloc(4))) throw new ServiceError("Provider refused initialization.", 409);
    await this.write(Buffer.from([1])); const header = await readSource(24), length = header.readUInt32BE(20);
    if (!header.readUInt16BE(0) || !header.readUInt16BE(2) || header.readUInt16BE(0) > 32768 || header.readUInt16BE(2) > 32768 || length > 4096) throw new ServiceError("Unsupported provider display initialization.", 409);
    await readSource(length);
    let pending: Buffer = Buffer.alloc(0); const deadline = performance.now() + 30000;
    const readClient = async (n: number) => {
      while (pending.length < n) {
        if (!this.authorized() || !this.current() || performance.now() >= deadline) throw new ServiceError("Display handshake ended.", 410);
        const v = await this.channel!.receive(0.1);
        if (v instanceof Uint8Array) pending = Buffer.concat([pending, v]);
        else if (v !== null) await this.command(v);
        if (pending.length > 81920) throw new ServiceError("Display handshake buffer exceeded.", 400);
      }
      const part = pending.subarray(0, n); pending = pending.subarray(n); return part;
    };
    await this.channel!.sendBytes(Buffer.from("RFB 003.008\n"));
    if ((await readClient(12)).toString() !== "RFB 003.008\n") throw new ServiceError("RFB 3.8 is required.", 400);
    await this.channel!.sendBytes(Buffer.from([1, 1])); if ((await readClient(1))[0] !== 1) throw new ServiceError("Invalid display security selection.", 400);
    await this.channel!.sendBytes(Buffer.alloc(4)); if (![0, 1].includes((await readClient(1))[0]!)) throw new ServiceError("Invalid client initialization.", 400);
    const name = Buffer.from("Canaveral display"); header.writeUInt32BE(name.length, 20);
    await this.channel!.sendBytes(Buffer.concat([header, name])); this.initialized = true;
    await this.channel!.sendControl({ type: "control", state: "view-only" }); return pending;
  }
  async command(value: Record<string, unknown>): Promise<void> {
    jsonBytes(value, 16384);
    if (value.type === "action-receipt" || value.type === "action") {
      if (!this.initialized || !this.authorized() || !this.current()) throw new ServiceError("Display authorization ended.", 410);
      let report: ActionReport, id: string;
      if (value.type === "action-receipt") {
        if (Object.keys(value).sort().join() !== "id,type") throw new ServiceError("Invalid input receipt request.", 400);
        id = uuid(value.id); report = this.options.receiptHandler ? await this.options.receiptHandler(id) : { state: "failed", result: { code: "capability_unsupported" } };
      } else {
        if (Object.keys(value).sort().join() !== "action,arguments,id,type") throw new ServiceError("Invalid display action.", 400);
        const req = operationRequest({ id: value.id, action: value.action, arguments: value.arguments }); id = req.id;
        if (!INPUT_ACTIONS.has(req.action)) throw new ServiceError("This action does not belong to input.", 400);
        if (!this.controls.owns(this.machine, this.viewer, this.epoch)) report = { state: "failed", result: { code: "input_not_owned" } };
        else {
          try {
            report = this.options.contextActionHandler && this.remote?.controlAction ? await this.options.contextActionHandler(req, r => this.remote!.controlAction!(r)) : this.options.actionHandler ? await this.options.actionHandler(req) : { state: "failed", result: { code: "capability_unsupported" } };
          } catch { report = { state: "unknown", result: { detail: "Input outcome requires inspection before retrying." } }; }
          if (!report || !["succeeded", "failed", "unknown"].includes(report.state)) report = { state: "unknown" };
          if (report.state === "unknown") { await this.resetInput(); this.controls.release(this.machine, this.viewer, this.epoch, false); await this.channel!.sendControl({ type: "control", state: "reset-uncertain" }); }
        }
      }
      let response: Record<string, unknown> = { type: "action-result", id, state: report.state, result: report.result ?? {} };
      try { jsonBytes(response, 16384); } catch { response = { type: "action-result", id, state: report.state, result: { outputOmitted: true } }; }
      await this.channel!.sendControl(response); return;
    }
    if (Object.keys(value).sort().join() !== "action,type" || value.type !== "input-control" || !["take", "release"].includes(value.action as string)) throw new ServiceError("Invalid display control.", 400);
    let state: string;
    if (!this.initialized) state = "not-ready";
    else if (!this.authorized() || !this.current()) throw new ServiceError("Display authorization ended.", 410);
    else if (value.action === "take") {
      state = this.controls.claim(this.machine, this.viewer, this.epoch, () => this.current() && this.authorized());
      if (state === "owned" && this.remote?.takeInput) {
        try {
          state = await this.remote.takeInput();
          if (!["owned", "busy", "reset-uncertain"].includes(state)) throw new ServiceError("Native input claim is invalid.", 409);
          if (!this.authorized() || !this.current()) { await this.resetInput(); throw new ServiceError("Display authorization ended during claim.", 410); }
          if (state !== "owned") this.controls.release(this.machine, this.viewer, this.epoch, state === "busy");
        } catch (error) { this.controls.release(this.machine, this.viewer, this.epoch, false); throw error; }
      }
    } else {
      const reset = this.controls.owns(this.machine, this.viewer, this.epoch) ? await this.resetInput() : true;
      this.controls.release(this.machine, this.viewer, this.epoch, reset); state = reset ? "view-only" : "reset-uncertain";
    }
    await this.channel!.sendControl({ type: "control", state });
  }
  async input(kind: number, frame: Buffer): Promise<boolean> {
    if ([4, 5, 6].includes(kind)) {
      if (!this.controls.owns(this.machine, this.viewer, this.epoch)) return false;
      if (!this.authorized() || !this.current()) throw new ServiceError("Display authorization ended.", 410);
      if (kind === 4) {
        const key = frame.readUInt32BE(4);
        if (frame[1]) { if (this.keys.size >= 128 && !this.keys.has(key)) throw new ServiceError("Too many held display keys.", 400); this.keys.add(key); }
        await this.write(frame); if (!frame[1]) this.keys.delete(key); return true;
      }
      if (kind === 5) this.pointer = [frame[1]!, frame.readUInt16BE(2), frame.readUInt16BE(4)];
    }
    await this.write(frame); return true;
  }
  async runDisplay(channel: SessionChannel): Promise<void> {
    this.channel = channel; this.controls.endpoints.add(this); let outgoing: Promise<void> | undefined;
    try {
      if (this.controls.stopping || !this.authorized()) throw new ServiceError("Display authorization ended.", 410);
      this.epoch = epoch(this.options.epoch?.() ?? null); this.remote = await this.factory();
      let pending = await this.handshake(); const parser = new ClientMessages();
      outgoing = (async () => {
        try {
          while (this.authorized() && this.current()) {
            const data = await this.remote!.read(65536, 0.1);
            if (!this.authorized() || !this.current()) break;
            if (data === null) continue;
            if (!data.length) break;
            if (data.length > 65536) throw new ServiceError("Oversized display output.", 409);
            await channel.sendBytes(data);
          }
        } catch { /* The reader closes the input loop on any transport failure. */ }
        finally { this.close(); }
      })();
      while (this.authorized() && this.current()) {
        const value = pending.length ? pending : await channel.receive(0.1); pending = Buffer.alloc(0);
        if (value instanceof Uint8Array) {
          let denied = false;
          for (const [kind, frame] of parser.feed(value)) denied = !(await this.input(kind, frame)) || denied;
          if (denied) await channel.sendControl({ type: "control", state: "view-only" });
        } else if (value !== null) await this.command(value);
      }
    } finally {
      try { if (this.remote && this.controls.owns(this.machine, this.viewer, this.epoch)) this.controls.release(this.machine, this.viewer, this.epoch, await this.resetInput()); }
      finally {
        try { await this.remote?.close(); }
        finally { this.close(); await outgoing; this.controls.endpoints.delete(this); this.finish(); }
      }
    }
  }
}
