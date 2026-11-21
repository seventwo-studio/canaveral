/** Lease port tunnels: the contract limits and the stream multiplexer both tunnel peers run.
 *
 * One tunnel is one `canaveral-session-v1` pair (capability `tunnel`) between the lease holder's
 * SDK and the runner. Every tunnelled connection is one numbered stream on that pair. No message
 * carries a destination: the side that listens sends `open` with a stream number only, and the
 * other side connects that stream to the tunnel's single fixed endpoint. A reverse tunnel listens
 * on the runner (the device's mapped port) and connects on the holder's machine; a forward tunnel
 * is the mirror image.
 *
 * Flow control is credit based, per stream and per direction. A sender may have at most
 * `windowBytes` unacknowledged bytes outstanding; the receiver returns credit only after it wrote
 * the bytes to its local socket. A slow local endpoint therefore stops its own stream without
 * stalling the others, and neither peer buffers more than one window per stream and direction.
 * A violation ends the whole tunnel. Nothing is retried or replayed. */
import type { Socket } from "node:net";

export type TunnelDirection = "reverse" | "forward";
/** Hard ceiling for the application limit `tunnelsPerLease`. */
export const TUNNELS_PER_LEASE_MAX = 8;
/** Tunnels one host holds at once, across all of its leases. */
export const TUNNELS_PER_HOST = 64;
/** Tunnel identities one lease may ever create; identities are tombstones and are not reused. */
export const TUNNEL_IDENTITIES_PER_LEASE = 256;
/** Concurrent connections on one tunnel. A further connection is closed at once. */
export const TUNNEL_CONNECTIONS = 32;
/** Unacknowledged bytes per connection and direction. */
export const TUNNEL_WINDOW_BYTES = 262_144;
/** One binary message is 64 KiB: a four-byte stream number and at most this much payload. */
export const TUNNEL_PAYLOAD_BYTES = 65_532;
/** A connection that carried no byte in either direction for this long is reset. */
export const TUNNEL_IDLE_SECONDS = 600;
export const TUNNEL_IDLE_SECONDS_MIN = 10;
export const TUNNEL_IDLE_SECONDS_MAX = 3600;
/** Time for the connecting side to reach its endpoint, and for both peers to attach. */
export const TUNNEL_CONNECT_MS = 10_000;
export const TUNNEL_ATTACH_SECONDS = 30;
/** The guest's adb daemon conventionally listens here; it is never a tunnel endpoint. */
export const TUNNEL_RESERVED_DEVICE_PORT = 5555;
const STREAM_MAX = 0xffff_ffff;
export const TUNNEL_RESET_REASONS = ["connect_failed", "limit", "idle", "closed"] as const;
export type TunnelResetReason = typeof TUNNEL_RESET_REASONS[number];

export interface TunnelIntent { direction: TunnelDirection; devicePort: number; idleSeconds: number }
/** Normalizes the controller-visible part of a tunnel request, or returns undefined when invalid.
 * A reverse tunnel listens on the device, where the adb daemon of a user build cannot bind a
 * privileged port; a forward tunnel may reach any device port except the adb daemon's own. */
export function tunnelIntent(direction: unknown, devicePort: unknown, idleSeconds: unknown): TunnelIntent | undefined {
  if (direction !== "reverse" && direction !== "forward") return undefined;
  if (typeof devicePort !== "number" || !Number.isSafeInteger(devicePort) || devicePort < (direction === "reverse" ? 1024 : 1) || devicePort > 65535 || devicePort === TUNNEL_RESERVED_DEVICE_PORT) return undefined;
  const idle = idleSeconds === undefined ? TUNNEL_IDLE_SECONDS : idleSeconds;
  if (typeof idle !== "number" || !Number.isSafeInteger(idle) || idle < TUNNEL_IDLE_SECONDS_MIN || idle > TUNNEL_IDLE_SECONDS_MAX) return undefined;
  return { direction, devicePort, idleSeconds: idle };
}

/** The session channel of either peer, reduced to what the multiplexer needs. `receive` returns
 * null when nothing arrived yet and throws once the channel has ended. */
export interface TunnelChannel {
  sendControl(value: Record<string, unknown>): Promise<void>;
  sendBytes(value: Uint8Array): Promise<void>;
  receive(): Promise<Record<string, unknown> | Uint8Array | null>;
  close(): void;
}
export interface TunnelRelayOptions {
  /** `listen`: local connections are handed in through `accept`. `connect`: every stream the
   * peer opens dials one local connection through `connect`. */
  role: "listen" | "connect";
  connect?: () => Promise<Socket>;
  idleSeconds: number;
  connections?: number;
  windowBytes?: number;
  connectMs?: number;
  /** Checked every 250 ms; false ends the tunnel. */
  authorized?: () => boolean;
  /** Called about once a second while the tunnel runs; a rejection ends the tunnel. */
  alive?: () => Promise<void>;
}
export interface TunnelStats { opened: number; active: number; refused: number; bytesToPeer: number; bytesFromPeer: number }
/** Why a tunnel ended. `closed` is this peer's own close; `error` carries the peer's worker code. */
export interface TunnelEnd { reason: "closed" | "disconnected" | "protocol" | "unauthorized" | "error"; code?: string }

interface Stream {
  id: number; socket: Socket | undefined; accepted: boolean; closed: boolean;
  /** Bytes this peer may still send, and bytes the other peer may still send. */
  credit: number; allowance: number;
  /** Bytes written to the local socket whose credit has not been returned yet. */
  consumed: number;
  sending: boolean; localEnded: boolean; remoteEnded: boolean;
  created: number; activity: number;
}
class ProtocolError extends Error {}
function frame(id: number, payload: Uint8Array): Buffer {
  const data = Buffer.allocUnsafe(4 + payload.length);
  data.writeUInt32BE(id, 0); data.set(payload, 4);
  return data;
}
function streamNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > STREAM_MAX) throw new ProtocolError("stream");
  return value;
}
function fields(value: Record<string, unknown>, names: readonly string[]): void {
  if (Object.keys(value).length !== names.length || names.some(name => !Object.hasOwn(value, name))) throw new ProtocolError("fields");
}

export class TunnelRelay {
  readonly stats: TunnelStats = { opened: 0, active: 0, refused: 0, bytesToPeer: 0, bytesFromPeer: 0 };
  private readonly streams = new Map<number, Stream>();
  private readonly connections: number;
  private readonly window: number;
  private readonly connectMs: number;
  private readonly idleMs: number;
  /** Highest stream number opened so far, by this peer (`listen`) or by the other (`connect`). */
  private highest = 0;
  private queue: Promise<void> = Promise.resolve();
  private started = false;
  private end: TunnelEnd | undefined;
  private ticks = 0;
  private checking = false;
  constructor(readonly channel: TunnelChannel, readonly options: TunnelRelayOptions) {
    this.connections = options.connections ?? TUNNEL_CONNECTIONS; this.window = options.windowBytes ?? TUNNEL_WINDOW_BYTES;
    this.connectMs = options.connectMs ?? TUNNEL_CONNECT_MS; this.idleMs = options.idleSeconds * 1000;
    if (!Number.isSafeInteger(this.connections) || this.connections < 1 || this.connections > TUNNEL_CONNECTIONS || !Number.isSafeInteger(this.window) || this.window < 1024 || this.window > TUNNEL_WINDOW_BYTES ||
        !Number.isFinite(this.idleMs) || this.idleMs < 1 || !Number.isFinite(this.connectMs) || this.connectMs < 1 || (options.role === "connect") !== (typeof options.connect === "function")) throw new TypeError("Invalid tunnel relay options.");
  }
  get ended(): TunnelEnd | undefined { return this.end; }
  /** Ends the tunnel from this peer. Every relayed connection is closed. */
  close(): void { this.fail({ reason: "closed" }); }

  /** Hands in one accepted local connection (`listen` role). It is closed at once when the
   * tunnel is not running yet, has ended, or already carries its maximum of connections. */
  accept(socket: Socket): void {
    socket.on("error", () => {});
    if (this.options.role !== "listen" || !this.started || this.end || this.streams.size >= this.connections || this.highest >= STREAM_MAX) { this.stats.refused++; socket.destroy(); return; }
    const stream = this.add(++this.highest);
    this.attach(stream, socket);
    this.control({ type: "open", stream: stream.id });
  }

  /** Relays until the channel ends, authorization lapses or either peer closes. Never throws. */
  async run(): Promise<TunnelEnd> {
    if (this.started) throw new TypeError("A tunnel relay runs once.");
    this.started = true;
    const timer = setInterval(() => this.tick(), 250);
    try {
      while (!this.end) {
        let message: Record<string, unknown> | Uint8Array | null;
        try { message = await this.channel.receive(); } catch { this.fail({ reason: "disconnected" }); break; }
        if (message === null || this.end) continue;
        try { this.handle(message); } catch (error) { this.fail(error instanceof ProtocolError ? { reason: "protocol" } : { reason: "disconnected" }); }
      }
    } finally { clearInterval(timer); this.fail({ reason: "disconnected" }); }
    await this.queue.catch(() => {});
    return this.end!;
  }

  private fail(end: TunnelEnd): void {
    if (this.end) return;
    this.end = end;
    for (const stream of [...this.streams.values()]) this.drop(stream);
    this.channel.close();
  }
  private tick(): void {
    if (this.end) return;
    let allowed = true;
    try { allowed = this.options.authorized?.() !== false; } catch { allowed = false; }
    if (!allowed) { this.fail({ reason: "unauthorized" }); return; }
    const now = performance.now();
    for (const stream of [...this.streams.values()]) {
      if (!stream.accepted ? now - stream.created >= this.connectMs : now - stream.activity >= this.idleMs) this.reset(stream, stream.accepted ? "idle" : "connect_failed");
    }
    if (++this.ticks % 4 || this.checking || !this.options.alive) return;
    this.checking = true;
    void this.options.alive().catch(() => this.fail({ reason: "unauthorized" })).finally(() => { this.checking = false; });
  }
  private add(id: number): Stream {
    const now = performance.now();
    const stream: Stream = { id, socket: undefined, accepted: false, closed: false, credit: this.window, allowance: this.window, consumed: 0, sending: false, localEnded: false, remoteEnded: false, created: now, activity: now };
    this.streams.set(id, stream); this.stats.opened++; this.stats.active = this.streams.size;
    return stream;
  }
  private drop(stream: Stream): void {
    if (stream.closed) return;
    stream.closed = true; this.streams.delete(stream.id); this.stats.active = this.streams.size;
    stream.socket?.destroy();
  }
  /** Aborts one connection in both directions and tells the peer why. */
  private reset(stream: Stream, reason: TunnelResetReason): void {
    if (stream.closed) return;
    this.drop(stream); this.control({ type: "reset", stream: stream.id, reason });
  }
  private attach(stream: Stream, socket: Socket): void {
    stream.socket = socket;
    socket.on("error", () => {});
    socket.on("readable", () => this.pump(stream));
    socket.on("end", () => {
      if (stream.closed || stream.localEnded) return;
      // `end` is emitted only after every buffered byte was read, so it follows the last data frame.
      stream.localEnded = true; this.control({ type: "end", stream: stream.id });
    });
    socket.on("close", () => {
      if (stream.closed) return;
      if (stream.localEnded && stream.remoteEnded) this.drop(stream); else this.reset(stream, "closed");
    });
  }
  /** Sends at most one data frame at a time for a stream, and only within the peer's credit. */
  private pump(stream: Stream): void {
    const socket = stream.socket;
    if (this.end || stream.closed || !stream.accepted || stream.sending || !socket) return;
    const available = socket.readableLength;
    // An empty read lets a drained connection report its end.
    if (!available) { socket.read(); return; }
    if (stream.credit <= 0) return;
    const chunk = socket.read(Math.min(available, TUNNEL_PAYLOAD_BYTES, stream.credit)) as Buffer | null;
    if (!chunk?.length) return;
    stream.credit -= chunk.length; stream.sending = true; stream.activity = performance.now();
    this.send(() => this.channel.sendBytes(frame(stream.id, chunk)), () => { stream.sending = false; this.stats.bytesToPeer += chunk.length; this.pump(stream); });
  }
  private control(value: Record<string, unknown>): void { this.send(() => this.channel.sendControl(value)); }
  /** One writer: the session channel takes one message at a time. The queue stays bounded because
   * a stream has at most one data frame and a handful of controls outstanding. */
  private send(work: () => Promise<void>, done?: () => void): void {
    this.queue = this.queue.then(async () => {
      if (this.end) return;
      await work(); done?.();
    }).catch(() => { this.fail({ reason: "disconnected" }); });
  }

  private handle(message: Record<string, unknown> | Uint8Array): void {
    if (message instanceof Uint8Array) { this.data(message); return; }
    if (message.type === "error") { this.fail({ reason: "error", ...(typeof message.code === "string" ? { code: message.code } : {}) }); return; }
    if (message.type === "open") { fields(message, ["type", "stream"]); this.opened(streamNumber(message.stream)); return; }
    const stream = this.known(streamNumber(message.stream));
    switch (message.type) {
      case "accept":
        fields(message, ["type", "stream"]);
        if (this.options.role !== "listen") throw new ProtocolError("accept");
        if (stream && !stream.accepted) { stream.accepted = true; stream.activity = performance.now(); this.pump(stream); }
        return;
      case "credit": {
        fields(message, ["type", "stream", "bytes"]);
        const bytes = message.bytes;
        if (typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes < 1 || bytes > this.window) throw new ProtocolError("credit");
        if (!stream) return;
        if (stream.credit + bytes > this.window) throw new ProtocolError("credit");
        stream.credit += bytes; this.pump(stream);
        return;
      }
      case "end":
        fields(message, ["type", "stream"]);
        if (!stream) return;
        if (stream.remoteEnded || !stream.socket) throw new ProtocolError("end");
        stream.remoteEnded = true; stream.socket.end();
        return;
      case "reset":
        fields(message, ["type", "stream", "reason"]);
        if (!(TUNNEL_RESET_REASONS as readonly unknown[]).includes(message.reason)) throw new ProtocolError("reset");
        if (stream) this.drop(stream);
        return;
      default: throw new ProtocolError("control");
    }
  }
  /** A stream this peer already closed may still receive frames that were in flight; a number
   * that was never opened is a violation. */
  private known(id: number): Stream | undefined {
    const stream = this.streams.get(id);
    if (!stream && id > this.highest) throw new ProtocolError("unknown stream");
    return stream;
  }
  private opened(id: number): void {
    if (this.options.role !== "connect" || id <= this.highest) throw new ProtocolError("open");
    this.highest = id;
    if (this.streams.size >= this.connections) { this.stats.refused++; this.control({ type: "reset", stream: id, reason: "limit" }); return; }
    const stream = this.add(id);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const dial = this.options.connect!();
    // A connection that arrives after the deadline, or after the stream ended, is closed unused.
    void dial.then(socket => { if (stream.closed || this.end) socket.destroy(); }, () => {});
    void Promise.race([dial, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("deadline")), this.connectMs); })]).then(socket => {
      if (stream.closed || this.end) return;
      this.attach(stream, socket); stream.accepted = true; stream.activity = performance.now();
      this.control({ type: "accept", stream: id }); this.pump(stream);
    }, () => this.reset(stream, "connect_failed")).finally(() => { if (timer) clearTimeout(timer); });
  }
  private data(message: Uint8Array): void {
    if (message.byteLength < 5 || message.byteLength > 4 + TUNNEL_PAYLOAD_BYTES) throw new ProtocolError("frame");
    const bytes = Buffer.from(message.buffer, message.byteOffset, message.byteLength), id = bytes.readUInt32BE(0), payload = bytes.subarray(4);
    if (id < 1) throw new ProtocolError("stream");
    const stream = this.known(id);
    if (!stream) return;
    // The listening side sends nothing before `accept`, and nobody sends after its own `end`.
    if (!stream.socket || !stream.accepted || stream.remoteEnded || payload.length > stream.allowance) throw new ProtocolError("flow");
    stream.allowance -= payload.length; stream.activity = performance.now(); this.stats.bytesFromPeer += payload.length;
    stream.socket.write(payload, error => {
      if (error || stream.closed || this.end) return;
      stream.consumed += payload.length;
      // Credit returns only for bytes the local endpoint accepted, in batches of half a window.
      if (stream.consumed * 2 < this.window) return;
      const bytes = stream.consumed; stream.consumed = 0; stream.allowance += bytes;
      this.control({ type: "credit", stream: stream.id, bytes });
    });
  }
}
