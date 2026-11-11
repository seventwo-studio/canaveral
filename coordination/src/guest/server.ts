import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { ServiceError, object } from "../errors.ts";
import { atomicUpload, decodeData, guestPath, jsonBytes, transferSize, uuid } from "../control/transfers.ts";
import type { ByteReader, PinnedDirectory, VerifiedDownload } from "../control/transfers.ts";
import { operationRequest } from "../control/devices.ts";
import type { SessionChannel, SessionMessage } from "../control/session-protocol.ts";
import type { StreamAttachment } from "../dashboard.ts";
import type { DisplayConnection } from "./display.ts";

export interface GuestServerServices {
  /** The guest worker implements files, native inspection and PTYs; no host execution fallback. */
  control(action: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
  download(path: string): Promise<VerifiedDownload & { identity: string }>;
  upload(path: string, reader: ByteReader, size: number, authorized: () => boolean): Promise<{ uploaded: number; durable: true }>;
  adoption?: import("../updates/guest.ts").GuestAdoptionService;
  ready(): boolean;
  close?(): Promise<void>;
}
export interface GuestServerOptions { token: string; mode: "desktop" | "headless"; services: GuestServerServices }
export interface GuestServiceBindings {
  ready(): boolean;
  files: {
    list(path: string): Promise<Record<string, unknown>>;
    download(path: string): Promise<VerifiedDownload & { identity: string }>;
    /** Retains a native parent handle across exclusive staging, sync and final publication. */
    parent(path: string): Promise<{ directory: PinnedDirectory; name: string; close(): Promise<void> }>;
  };
  shells: { control(action: string, args: Record<string, unknown>): Promise<Record<string, unknown>>; close?(): Promise<void> };
  graphics?: {
    screenshot(): Promise<Record<string, unknown>>;
    inspect(includeFrame: boolean): Promise<Record<string, unknown>>;
    /** Revalidates the expiring native target and exposed action before dispatch. */
    action(args: Record<string, unknown>): Promise<Record<string, unknown>>;
  };
}
/** Common Linux helper controls; OS handles, PTYs and AT-SPI stay in the bound guest runtime. */
export function createGuestServices(bindings: GuestServiceBindings): GuestServerServices {
  const upload: GuestServerServices["upload"] = async (path, reader, size, check) => {
    guestPath(path, "absolute"); transferSize(size);
    if (!check()) throw new ServiceError("Upload authorization ended before opening the destination.", 401);
    const parent = await bindings.files.parent(path);
    try { return await atomicUpload(parent.directory, parent.name, reader, size, { authorized: check }); }
    finally { await parent.close(); }
  };
  return {
    ready: () => bindings.ready(), upload,
    download: path => bindings.files.download(guestPath(path, "absolute")),
    async close() { await bindings.shells.close?.(); },
    async control(action, args) {
      if (action.startsWith("shell-")) {
        const session = uuid(args.session), values: Record<string, unknown> = { ...args, session };
        if (action === "shell-open") {
          if (Object.keys(args).some(k => !["session", "cols", "rows"].includes(k))) throw new ServiceError("Invalid terminal open fields.", 400);
          values.cols ??= 80; values.rows ??= 24;
          for (const value of [values.cols, values.rows]) if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 500) throw new ServiceError("Invalid terminal dimensions.", 400);
          return bindings.shells.control(action, values);
        }
        if (action === "shell-read") values.offset ??= 0;
        const validated = operationRequest({ id: randomUUID(), action, arguments: values });
        return bindings.shells.control(action, validated.arguments);
      }
      if (action === "list-files") return bindings.files.list(guestPath(args.path, "absolute", true));
      if (action === "push") {
        const data = decodeData(args.data), path = guestPath(args.path, "absolute"); let offset = 0;
        await upload(path, { read: async maximum => { const part = data.subarray(offset, offset + maximum); offset += part.length; return part; } }, data.length, () => true);
        return { written: data.length, durable: true };
      }
      if (action === "pull") {
        const source = await bindings.files.download(guestPath(args.path, "absolute"));
        try {
          const size = transferSize(source.size);
          if (size > 4 * 1048576) throw new ServiceError("Discrete download exceeds 4 MiB; use streaming.", 413);
          if (await source.verify() !== true) throw new ServiceError("Guest download source changed.", 409);
          const parts: Uint8Array[] = []; let remaining = size;
          while (remaining) {
            const maximum = Math.min(65536, remaining), data = await source.read(maximum);
            if (!(data instanceof Uint8Array) || !data.length || data.length > maximum) throw new ServiceError("Guest download source ended early.", 409);
            parts.push(data); remaining -= data.length;
          }
          if (await source.verify() !== true) throw new ServiceError("Guest download source changed.", 409);
          return { data: Buffer.concat(parts).toString("base64"), mediaType: "application/octet-stream" };
        } finally { await source.close(); }
      }
      if (action === "screenshot" && bindings.graphics) return bindings.graphics.screenshot();
      if (action === "accessibility" && bindings.graphics) return bindings.graphics.inspect(args.includeFrame !== false);
      if (action === "accessibility-action" && bindings.graphics) return bindings.graphics.action(args);
      throw new ServiceError("The guest runtime does not provide this native capability.", 409, { code: "capability_unsupported", retryable: false });
    },
  };
}
const GRAPHICAL = new Set(["screenshot", "hierarchy", "accessibility", "accessibility-action", "tap", "swipe", "text", "key"]);
function header(request: IncomingMessage, name: string): string | undefined {
  const values: string[] = [];
  for (let i = 0; i < request.rawHeaders.length; i += 2) if (request.rawHeaders[i]!.toLowerCase() === name) values.push(request.rawHeaders[i + 1]!);
  if (values.length > 1) throw new ServiceError("Ambiguous guest request header.", 400);
  return values[0];
}
function length(request: IncomingMessage, maximum = Number.MAX_SAFE_INTEGER): number {
  const value = header(request, "content-length");
  if (header(request, "transfer-encoding") !== undefined || !value || !/^\d+$/.test(value)) throw new ServiceError("A single Content-Length is required.", 400);
  const count = transferSize(Number(value)); if (count > maximum) throw new ServiceError("Guest request exceeds its envelope.", 413); return count;
}
function pathHeader(request: IncomingMessage): string {
  let path: string;
  try { path = decodeURIComponent(header(request, "x-canaveral-path") ?? ""); } catch { throw new ServiceError("Invalid guest file path.", 400); }
  if (!path.startsWith("/") || path.includes("\0")) throw new ServiceError("Use an absolute guest file path.", 400);
  return path;
}
class BodyReader implements ByteReader {
  private iterator: AsyncIterator<Uint8Array>;
  private pending: Buffer = Buffer.alloc(0);
  constructor(readonly request: IncomingMessage, private remaining: number) { this.iterator = request[Symbol.asyncIterator]() as AsyncIterator<Uint8Array>; }
  async read(maximum: number): Promise<Uint8Array> {
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 1048576) throw new ServiceError("Use bounded guest request reads.", 400);
    if (!this.remaining) return Buffer.alloc(0);
    if (!this.pending.length) {
      const next = await this.iterator.next();
      if (next.done) throw new ServiceError("Guest request ended early.", 400);
      this.pending = Buffer.from(next.value);
    }
    if (this.pending.length > this.remaining) throw new ServiceError("Guest request exceeds its declared length.", 400);
    const n = Math.min(maximum, this.remaining, this.pending.length), part = this.pending.subarray(0, n);
    this.pending = this.pending.subarray(n); this.remaining -= n; return part;
  }
}
function reply(response: ServerResponse, value: Record<string, unknown>, status = 200): void {
  const data = jsonBytes(value, 6 * 1048576);
  response.writeHead(status, { "Content-Type": "application/json", "Content-Length": data.length, "Cache-Control": "no-store", Connection: "close" }); response.end(data);
}
/** Guest-only HTTP attachment; caller binds this server exclusively to guest loopback. Importing starts nothing. */
export function createGuestServer(options: GuestServerOptions): Server {
  if (!["desktop", "headless"].includes(options.mode) || !/^[\x21-\x7e]{32,4096}$/.test(options.token)) throw new ServiceError("Invalid guest service mode or credential.", 400);
  let effects: Promise<unknown> = Promise.resolve();
  const server = createServer((request, response) => {
    let dispatched = false;
    void (async () => {
      const raw = request.url ?? "";
      if (raw === "/healthz" && request.method === "GET") { reply(response, { ok: true }); return; }
      const supplied = Buffer.from(header(request, "authorization") ?? ""), expected = Buffer.from(`Bearer ${options.token}`);
      if (request.headers.origin !== undefined || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new ServiceError("Credential rejected.", 401);
      if (raw !== "/file" && raw !== "/control") throw new ServiceError("Unknown guest endpoint.", 404);
      const live = () => !request.aborted && !response.destroyed;
      if (raw === "/control" && request.method === "POST") {
        const size = length(request, 1048576); if (!size) throw new ServiceError("Invalid request size.", 400);
        const reader = new BodyReader(request, size), chunks: Uint8Array[] = []; let remaining = size;
        while (remaining) { const part = await reader.read(Math.min(65536, remaining)); remaining -= part.length; chunks.push(part); }
        const value = object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)))); jsonBytes(value, 1048576);
        if (typeof value.action !== "string") throw new ServiceError("Invalid guest action.", 400);
        const args = object(value.arguments ?? {}), action = value.action;
        if (options.mode === "headless" && GRAPHICAL.has(action)) throw new ServiceError("This headless guest has no graphical service.", 409, { code: "capability_unsupported" });
        if (action === "update-acknowledge" || action === "update-inspect") {
          const adoption = options.services.adoption;
          if (!adoption) throw new ServiceError("Guest provision adoption is unavailable.", 409, { code: "capability_unsupported" });
          const result = await adoption.acknowledge(args, action === "update-inspect");
          reply(response, result ? { ...result } : { absent: true }); return;
        }
        if (action !== "health" && options.services.adoption && !options.services.adoption.admitted()) throw new ServiceError("Guest provision admission is fenced.", 409);
        if (action === "health") { reply(response, { ready: options.services.ready() && (!options.services.adoption || options.services.adoption.admitted()), durableWrites: true, mode: options.mode }); return; }
        const execute = async () => { if (!live()) throw new ServiceError("Guest request ended before dispatch.", 410); dispatched = true; return options.services.control(action, args); };
        // Every terminal has its own worker lane. UI capture cannot hold terminal traffic.
        const work = action.startsWith("shell-") ? execute() : effects.then(execute);
        if (!action.startsWith("shell-")) effects = work.catch(() => {});
        const result = await work; if (live()) reply(response, result); return;
      }
      if (raw === "/file" && options.services.adoption && !options.services.adoption.admitted()) throw new ServiceError("Guest provision admission is fenced.", 409);
      if (raw === "/file" && request.method === "PUT") {
        const size = length(request), path = pathHeader(request); dispatched = true;
        const result = await options.services.upload(path, new BodyReader(request, size), size, live);
        if (!live() || result.uploaded !== size || result.durable !== true) throw new ServiceError("Guest upload publication was not confirmed.", 409, { outcome: "unknown", retryable: false });
        reply(response, result); return;
      }
      if (raw === "/file" && ["GET", "HEAD"].includes(request.method ?? "")) {
        if (request.headers["transfer-encoding"] !== undefined || (request.headers["content-length"] !== undefined && request.headers["content-length"] !== "0")) throw new ServiceError("Invalid guest read framing.", 400);
        const source = await options.services.download(pathHeader(request));
        try {
          transferSize(source.size);
          if (!/^[0-9a-f]{64}$/.test(source.identity) || await source.verify() !== true || !live()) throw new ServiceError("Guest download source could not be verified.", 409);
          if (request.method !== "HEAD" && source.size === 0 && (await source.verify() !== true || !live())) throw new ServiceError("Empty download source changed.", 409);
          response.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": source.size, "X-Canaveral-File-Identity": source.identity, "Cache-Control": "no-store", Connection: "close" });
          if (request.method === "HEAD") { response.end(); return; }
          // The last block remains private until verification succeeds, including empty files.
          let remaining = source.size;
          while (remaining) {
            if (!live()) throw new ServiceError("Guest download ended.", 410);
            const maximum = Math.min(65536, remaining), data = await source.read(maximum);
            if (!live() || !data.length || data.length > maximum) throw new ServiceError("Guest download changed or ended.", 409);
            remaining -= data.length;
            if (!remaining && (await source.verify() !== true || !live())) throw new ServiceError("Guest download source changed.", 409);
            await new Promise<void>((resolve, reject) => response.write(data, error => error ? reject(error) : resolve()));
          }
          response.end();
        } finally { await source.close(); }
        return;
      }
      throw new ServiceError("Unknown guest endpoint.", 404);
    })().catch((error: unknown) => {
      request.resume();
      if (response.headersSent) { response.destroy(); return; }
      if (response.destroyed) return;
      const known = error instanceof ServiceError ? error : undefined;
      const definite = known && ["input_rejected", "input_busy", "input_stale", "capability_unsupported"].includes(known.code);
      reply(response, { error: "Guest request was not confirmed.", code: known?.code ?? "operation_incomplete", retryable: false, ...(dispatched && !definite ? { outcome: "unknown" } : {}) }, known?.status ?? 409);
    });
  });
  server.requestTimeout = 0; // Files have no total-size/time product limit; idle I/O stays bounded.
  server.headersTimeout = 10000; server.setTimeout(25000, socket => socket.destroy());
  server.on("checkContinue", (_req, response) => { response.writeHead(417); response.end(); });
  return server;
}

/** RFC6455 server peer with one assembled bounded message and serialized writes. */
class DashboardSocket implements SessionChannel {
  private dead = false;
  private tail: Promise<void> = Promise.resolve();
  private next: Promise<SessionMessage> | undefined;
  private receiving = false;
  private readonly timer: NodeJS.Timeout;
  private readonly abort = () => this.close();
  constructor(readonly attachment: StreamAttachment, readonly check: () => boolean) {
    attachment.socket.on("error", () => this.close());
    attachment.socket.once("close", () => this.close());
    attachment.signal.addEventListener("abort", this.abort, { once: true });
    this.timer = setInterval(() => { void this.allowed().catch(() => this.close()); }, 1000); this.timer.unref();
  }
  private async allowed(): Promise<void> {
    if (this.dead || this.attachment.signal.aborted || !this.check() || !await this.attachment.authorized()) throw new ServiceError("Stream authorization ended.", 410);
    if (this.dead || !this.check() || this.attachment.signal.aborted) throw new ServiceError("Stream authorization ended.", 410);
  }
  private async read(n: number): Promise<Buffer> {
    const socket = this.attachment.socket, result = Buffer.alloc(n); let offset = 0;
    while (offset < n) {
      await this.allowed();
      const part = socket.read(Math.min(n - offset, socket.readableLength || n - offset)) as Buffer | null;
      if (part) { part.copy(result, offset); offset += part.length; continue; }
      if (socket.destroyed || socket.readableEnded) throw new ServiceError("Stream disconnected.", 410);
      await new Promise<void>((resolve, reject) => {
        const done = () => { cleanup(); resolve(); }, end = () => { cleanup(); reject(new ServiceError("Stream disconnected.", 410)); };
        const cleanup = () => { socket.off("readable", done); socket.off("close", end); socket.off("end", end); socket.off("error", end); };
        socket.once("readable", done); socket.once("close", end); socket.once("end", end); socket.once("error", end);
      });
    }
    await this.allowed(); return result;
  }
  private send(data: Uint8Array, opcode: number): Promise<void> {
    const result = this.tail.then(async () => {
      await this.allowed(); const length = data.byteLength, header = Buffer.alloc(length < 126 ? 2 : length < 65536 ? 4 : 10);
      header[0] = 128 | opcode;
      if (length < 126) header[1] = length;
      else if (length < 65536) { header[1] = 126; header.writeUInt16BE(length, 2); }
      else { header[1] = 127; header.writeBigUInt64BE(BigInt(length), 2); }
      await socketWrite(this.attachment.socket, Buffer.concat([header, data])); await this.allowed();
    });
    this.tail = result.catch(() => { this.close(); }); return result;
  }
  sendBytes(data: Uint8Array): Promise<void> { if (data.length > 65536) return Promise.reject(new ServiceError("Oversized stream bytes.", 400)); return this.send(data, 2); }
  sendControl(value: Record<string, unknown>): Promise<void> { return this.send(jsonBytes(value, 16384), 1); }
  private async message(): Promise<SessionMessage> {
    let kind = 0, size = 0; const chunks: Buffer[] = [];
    for (;;) {
      const h = await this.read(2), opcode = h[0]! & 15, final = Boolean(h[0]! & 128);
      if ((h[0]! & 112) || !(h[1]! & 128)) throw new ServiceError("Invalid masked stream frame.", 400);
      let n = h[1]! & 127;
      if (n === 126) { n = (await this.read(2)).readUInt16BE(); if (n < 126) throw new ServiceError("Noncanonical stream frame.", 400); }
      else if (n === 127) { const large = (await this.read(8)).readBigUInt64BE(); if (large < 65536n || large > 65536n) throw new ServiceError("Oversized stream frame.", 400); n = Number(large); }
      if (![0, 1, 2, 8, 9, 10].includes(opcode) || (opcode >= 8 && (!final || n > 125))) throw new ServiceError("Unsupported stream frame.", 400);
      if (opcode < 8) {
        if (opcode === 0 ? !kind : Boolean(kind)) throw new ServiceError("Mixed stream fragments.", 400);
        if (opcode) kind = opcode;
        if (size + n > (kind === 1 ? 16384 : 65536)) throw new ServiceError("Stream message exceeds its budget.", 400);
      }
      const mask = await this.read(4), data = await this.read(n);
      for (let i = 0; i < n; i++) data[i] = data[i]! ^ mask[i % 4]!;
      if (opcode === 8) throw new ServiceError("Stream disconnected.", 410);
      if (opcode === 9) { await this.send(data, 10); continue; }
      if (opcode === 10) continue;
      chunks.push(data); size += n;
      if (final) {
        const raw = Buffer.concat(chunks, size); await this.allowed();
        if (kind === 2) return raw;
        const value = object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw))); jsonBytes(value, 16384); return value;
      }
    }
  }
  async receive(timeoutSeconds = 0.25): Promise<SessionMessage | null> {
    if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 0 || this.receiving) throw new ServiceError("Invalid concurrent stream read.", 400);
    this.receiving = true; let timer: NodeJS.Timeout | undefined;
    try {
      await this.allowed();
      if (!this.next) { this.next = this.message(); void this.next.catch(() => this.close()); }
      const timeout = Symbol();
      const value = await Promise.race([this.next, new Promise<typeof timeout>(resolve => { timer = setTimeout(() => resolve(timeout), timeoutSeconds * 1000); })]);
      await this.allowed();
      if (value === timeout) return null;
      this.next = undefined; return value;
    } finally { if (timer) clearTimeout(timer); this.receiving = false; }
  }
  close(): void { if (this.dead) return; this.dead = true; clearInterval(this.timer); this.attachment.signal.removeEventListener("abort", this.abort); this.attachment.socket.destroy(); }
}
async function socketWrite(socket: Duplex, data: Uint8Array): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let done = false;
    const finish = (error?: Error | null) => { if (done) return; done = true; clearTimeout(timer); socket.off("close", closed); error ? reject(error) : resolve(); };
    const closed = () => finish(new ServiceError("Stream disconnected during output.", 410));
    const timer = setTimeout(() => { finish(new ServiceError("Stream output deadline ended.", 408, { retryable: false, outcome: "unknown" })); socket.destroy(); }, 10000);
    socket.once("close", closed); socket.write(data, error => finish(error));
  });
}
/** Dashboard already authenticates the account and same origin; repeat those checks before upgrading. */
export async function acceptDashboardSocket(attachment: StreamAttachment, check: () => boolean = () => true): Promise<SessionChannel> {
  const req = attachment.request;
  try {
    if (!check() || attachment.signal.aborted || !await attachment.authorized()) throw new ServiceError("Stream authorization ended.", 401);
    const origin = header(req, "origin"), host = header(req, "host"), key = header(req, "sec-websocket-key");
    if (origin !== undefined) {
      let url: URL; try { url = new URL(origin); } catch { throw new ServiceError("Invalid stream Origin.", 403); }
      if (!["http:", "https:"].includes(url.protocol) || url.host !== host || url.origin !== origin) throw new ServiceError("Stream Origin rejected.", 403);
    }
    // Browsers offer compression by default. Negotiate no extensions and keep RSV bits forbidden.
    if (req.method !== "GET" || header(req, "upgrade")?.toLowerCase() !== "websocket" || !header(req, "connection")?.toLowerCase().split(/\s*,\s*/).includes("upgrade") || header(req, "sec-websocket-version") !== "13" || !key || !/^[A-Za-z0-9+/]{22}==$/.test(key) || Buffer.from(key, "base64").toString("base64") !== key || req.headers["transfer-encoding"] !== undefined || (req.headers["content-length"] !== undefined && req.headers["content-length"] !== "0")) throw new ServiceError("Invalid stream WebSocket handshake.", 400);
    const accept = createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    const protocols = header(req, "sec-websocket-protocol")?.split(/\s*,\s*/) ?? [];
    await socketWrite(attachment.socket, Buffer.from(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n${protocols.includes("binary") ? "Sec-WebSocket-Protocol: binary\r\n" : ""}\r\n`));
    if (attachment.head.length) attachment.socket.unshift(attachment.head);
    const channel = new DashboardSocket(attachment, check);
    if (!check() || !await attachment.authorized()) { channel.close(); throw new ServiceError("Stream authorization ended.", 410); }
    return channel;
  } catch (error) { attachment.socket.destroy(); throw error; }
}
export async function serveTerminal(channel: SessionChannel, session: string, control: (request: Record<string, unknown>) => Promise<Record<string, unknown>>, check: () => boolean | Promise<boolean>): Promise<void> {
  session = uuid(session); let offset = 0, lastRead = -Infinity;
  const live = async () => { if (!await check()) throw new ServiceError("Terminal authorization ended.", 410); };
  try {
    while (true) {
      await live(); const value = await channel.receive(0.02); await live();
      if (value !== null) {
        if (value instanceof Uint8Array || !["shell-write", "shell-resize"].includes(value.action as string) || Object.keys(value).some(k => !["action", "arguments"].includes(k))) throw new ServiceError("Unsupported terminal input.", 400);
        const request = operationRequest({ id: randomUUID(), action: value.action, arguments: { ...object(value.arguments), session } });
        await live(); const result = await control({ ...request }); await live(); // A lost write is never retried.
        if ((request.action === "shell-write" && result.written !== Buffer.byteLength(request.arguments.text as string)) || (request.action === "shell-resize" && result.resized !== true)) throw new ServiceError("Terminal input acknowledgement was not confirmed.", 409, { outcome: "unknown", retryable: false });
      }
      if (performance.now() - lastRead >= 50) {
        await live(); const result = await control({ id: randomUUID(), action: "shell-read", arguments: { session, offset } }); await live(); lastRead = performance.now();
        const data = decodeData(result.data, 65536), end = result.offset;
        if (typeof end !== "number" || !Number.isSafeInteger(end) || end < offset || typeof result.truncated !== "boolean" || typeof result.exited !== "boolean" || (!result.truncated && end - offset !== data.length) || (result.truncated && end - data.length <= offset)) throw new ServiceError("Terminal output cursor differs.", 409);
        if (result.truncated) await channel.sendControl({ truncated: true });
        if (data.length) { await live(); await channel.sendBytes(data); }
        offset = end;
        if (result.exited) { if (result.exitCode !== null && !Number.isSafeInteger(result.exitCode)) throw new ServiceError("Invalid terminal exit metadata.", 409); await channel.sendControl({ exited: true, exitCode: result.exitCode }); return; }
      }
    }
  } catch {
    try { await live(); await channel.sendControl({ error: "Terminal connection ended. Input may have been delivered; inspect before retrying." }); } catch { /* Revoked streams cannot send further data. */ }
  } finally { channel.close(); }
}
export async function attachShell(attachment: StreamAttachment, control: (request: Record<string, unknown>) => Promise<Record<string, unknown>>, check: () => boolean = () => true): Promise<void> {
  const session = uuid(attachment.sessionId), channel = await acceptDashboardSocket(attachment, check);
  await serveTerminal(channel, session, control, async () => check() && !attachment.signal.aborted && await attachment.authorized());
}
/** For already owned provider channels; DisplayEndpoint supplies held-input arbitration before this layer. */
export async function relayDesktop(channel: SessionChannel, remote: DisplayConnection, check: () => boolean | Promise<boolean>): Promise<void> {
  let closed = false;
  const live = async () => !closed && await check();
  const output = (async () => {
    while (await live()) {
      const data = await remote.read(65536, 0.1); if (!await live()) break;
      if (data === null) continue; if (!data.length) break;
      if (data.length > 65536) throw new ServiceError("Oversized desktop output.", 400);
      await channel.sendBytes(data);
    }
  })().finally(() => { closed = true; channel.close(); });
  void output.catch(() => {});
  try {
    while (await live()) {
      const data = await channel.receive(0.1); if (!await live()) break;
      if (data === null) continue;
      if (!(data instanceof Uint8Array) || data.length > 65536) throw new ServiceError("Desktop requires bounded binary messages.", 400);
      await remote.write(data);
    }
  } finally { closed = true; channel.close(); await remote.close(); await output; }
}
