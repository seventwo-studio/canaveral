import { CHUNK, Lane, ServiceError, equal, integer, unicode, type MaybePromise } from "./common.ts";
export type Handle = string;
export interface FileIdentity {
  volume: string; fileId: string; size: number; written: string; changed: string;
  links: number; directory: boolean; attributes: number;
}
export interface DirectoryEntry { name: string; kind: "file" | "directory" | "symlink"; size: number; modifiedAt: number; attributes: number; reparseTag: number; nativeFileId: string }
export interface WindowsFileAPI {
  /** Lost native handle acknowledgement requires external cleanup evidence. */
  readonly cleanupUncertain?: boolean;
  drive(drive: string): MaybePromise<Handle>;
  open(parent: Handle, name: string, directory: boolean): MaybePromise<Handle>;
  info(handle: Handle): MaybePromise<FileIdentity>;
  read(handle: Handle, offset: number, count: number): MaybePromise<Buffer>;
  entries(handle: Handle): AsyncIterable<DirectoryEntry>;
  close(handle: Handle): MaybePromise<void>;
  create?(parent: Handle, name: string): MaybePromise<Handle>;
  journal?(parent: Handle, name: string): MaybePromise<Handle>;
  write?(handle: Handle, offset: number, data: Buffer): MaybePromise<number>;
  flush?(handle: Handle): MaybePromise<void>;
  discard?(handle: Handle): MaybePromise<void>;
  publish?(handle: Handle, name: string): MaybePromise<boolean>;
  /** Relative no-follow occupancy, including dangling reparse points. */
  exists?(parent: Handle, name: string): MaybePromise<boolean>;
  /** Atomic handle rename anchored to the retained destination parent. */
  publishOwned?(handle: Handle, parent: Handle, name: string, replace?: boolean): MaybePromise<"published" | "exists">;
}
export interface OwnedFile { close(): Promise<boolean> }
export function component(name: unknown): string {
  if (!unicode(name) || !name || name === "." || name === ".." || /[\\/:\x00-\x1f]/.test(name) || /[ .]$/.test(name) || Buffer.byteLength(name, "utf16le") > 65532) throw new ServiceError("Use unambiguous relative Windows filename components.", 400);
  return name;
}
export function components(parts: readonly string[]): void {
  if (!Array.isArray(parts) || parts.reduce((n, p) => n + Buffer.byteLength(component(p), "utf16le") + 2, 0) > 65532) throw new ServiceError("Windows path metadata exceeds its envelope.", 400);
}
export function safeIdentity(info: FileIdentity): void {
  if (!info || typeof info.volume !== "string" || !info.volume || !/^[a-f0-9]{32}$/i.test(info.fileId) || !integer(info.size) || !integer(info.links, 1) || !integer(info.attributes, 0, 0xffffffff) || info.attributes & 0x440) throw new ServiceError("Guest object identity is invalid, reparsed or unsupported.", 409);
  if (!info.directory && info.links !== 1) throw new ServiceError("Hard-linked Windows files are unsupported.", 409);
}
export function directoryStamp(info: FileIdentity): unknown { safeIdentity(info); if (!info.directory) throw new ServiceError("Pinned parent must be a directory.", 409); return [info.volume, info.fileId, info.attributes]; }
export class WindowsRoot {
  readonly handles: Handle[] = [];
  readonly pins = new Set<OwnedFile>();
  readonly io = new Lane();
  readonly listing = new Lane();
  identity!: FileIdentity;
  started = false;
  fenced = false;
  constructor(readonly drive: string, readonly prefix: readonly string[], readonly api: WindowsFileAPI) {
    if (!/^[a-z]:$/i.test(drive)) throw new ServiceError("Bind an explicit Windows drive.", 400);
    components(prefix);
  }
  get handle(): Handle { const h = this.handles.at(-1); if (this.fenced || !h) throw new ServiceError("Windows root is fenced.", 410); return h; }
  async start(): Promise<{ volume: string; fileId: string }> {
    if (this.started || this.fenced) throw new ServiceError("A Windows root cannot restart or adopt another object.", 409);
    this.started = true;
    try {
      return await this.io.run(async () => {
        this.handles.push(await this.api.drive(this.drive.toUpperCase()));
        const drive = await this.api.info(this.handles.at(-1)!); directoryStamp(drive);
        for (const name of this.prefix) {
          if (this.fenced) throw new ServiceError("Root closed during startup.", 410);
          this.handles.push(await this.api.open(this.handles.at(-1)!, name, true));
          const info = await this.api.info(this.handles.at(-1)!); directoryStamp(info);
          if (info.volume !== drive.volume) throw new ServiceError("Windows root crossed its volume.", 409);
        }
        this.identity = await this.api.info(this.handles.at(-1)!);
        if (this.fenced) throw new ServiceError("Root closed during startup.", 410);
        return { volume: this.identity.volume, fileId: this.identity.fileId };
      });
    } catch { const confirmed = await this.close(); throw new ServiceError("Windows root setup failed.", 409, { retryable: false, ...(!confirmed ? { outcome: "unknown" } : {}) }); }
  }
  async pin(parts: readonly string[], directory = false): Promise<FilePin> {
    components(parts); let parent = this.handle;
    const pin = new FilePin(this); this.pins.add(pin);
    try {
      await pin.io.run(async () => {
        for (const [i, name] of parts.entries()) {
          if (this.fenced) throw new ServiceError("Root closed during open.", 410);
          parent = await this.api.open(parent, name, i < parts.length - 1 || directory);
          pin.handles.push(parent);
          const info = await this.api.info(parent); safeIdentity(info);
          if (info.volume !== this.identity.volume) throw new ServiceError("Windows path crossed its volume.", 409);
          if (i < parts.length - 1 || directory) directoryStamp(info);
        }
        if (!parts.length && !directory) throw new ServiceError("Root is a directory.", 400);
        pin.handle = parent; pin.identity = await this.api.info(parent);
        if (pin.identity.directory !== directory) throw new ServiceError("Windows file type differs.", 409);
        await pin.checkOwned();
      });
      return pin;
    } catch { const confirmed = await pin.close() && !this.api.cleanupUncertain; throw new ServiceError("Relative Windows file binding failed.", 409, { retryable: false, ...(!confirmed ? { outcome: "unknown" } : {}) }); }
  }
  async list(parts: readonly string[] = []): Promise<{ entries: DirectoryEntry[]; truncated: boolean }> {
    return this.listing.run(async () => {
      const pin = await this.pin(parts, true);
      try {
        return await pin.io.run(async () => {
          await pin.checkOwned(); const entries: DirectoryEntry[] = []; let bytes = 0, truncated = false;
          const deadline = performance.now() + 3000;
          for await (const entry of this.api.entries(pin.handle)) {
            if (this.fenced) throw new ServiceError("Root authorization ended.", 410);
            const count = Buffer.byteLength(JSON.stringify(entry)) + 2;
            if (entries.length === 2000 || bytes + count > 6 * 1048576 - 1024 || performance.now() >= deadline) { truncated = true; break; }
            entries.push(entry); bytes += count;
          }
          await pin.checkOwned(); return { entries, truncated };
        });
      } finally { if (!await pin.close()) { this.fenced = true; throw new ServiceError("Windows listing cleanup is unconfirmed.", 409, { code: "file_cleanup_uncertain", retryable: false }); } }
    });
  }
  async close(): Promise<boolean> {
    this.fenced = true;
    if (this.io.busy) return false;
    for (const pin of [...this.pins]) await pin.close();
    if (this.pins.size || this.api.cleanupUncertain) return false;
    return this.io.run(async () => { while (this.handles.length) { try { await this.api.close(this.handles.at(-1)!); } catch { return false; } this.handles.pop(); } return true; });
  }
}
export class FilePin implements OwnedFile {
  readonly handles: Handle[] = [];
  readonly io = new Lane();
  handle!: Handle; identity!: FileIdentity;
  fenced = false; closed = false;
  constructor(readonly root: WindowsRoot) {}
  async checkOwned(): Promise<void> {
    if (this.fenced || this.closed || this.root.fenced) throw new ServiceError("Windows file context is fenced.", 410);
    const info = await this.root.api.info(this.handle); safeIdentity(info);
    if (!equal(info, this.identity)) throw new ServiceError("Pinned Windows file identity or metadata changed.", 409);
    if (this.root.fenced || this.fenced) throw new ServiceError("Windows context closed during metadata check.", 410);
  }
  async check(): Promise<void> { return this.io.run(() => this.checkOwned()); }
  async read(offset: number, size: number): Promise<Buffer> {
    if (!integer(offset) || !integer(size, 0, CHUNK)) throw new ServiceError("Use bounded reads and exact byte cursors.", 400);
    return this.io.run(async () => {
      await this.checkOwned(); if (this.identity.directory) throw new ServiceError("Cannot read a directory.", 400);
      const data = size ? await this.root.api.read(this.handle, offset, size) : Buffer.alloc(0);
      if (!Buffer.isBuffer(data) || data.length > size) throw new ServiceError("Windows read exceeds its envelope.", 409);
      await this.checkOwned(); return data;
    });
  }
  async close(): Promise<boolean> {
    this.fenced = true; if (this.io.busy) return false;
    return this.io.run(async () => {
      while (this.handles.length) { try { await this.root.api.close(this.handles.at(-1)!); } catch { return false; } this.handles.pop(); }
      this.closed = true; this.root.pins.delete(this); return true;
    });
  }
}
