import { deflateSync } from "node:zlib";
import { Lane, ServiceError, allowed, equal, integer, uncertain, type Authority, type MaybePromise } from "./common.ts";
import { keyInput, mouseInput, type Bounds, type InputBackend, type InputEvent } from "./input.ts";
export interface DesktopAPI {
  capture(): MaybePromise<{ bounds: Bounds; pixels: Buffer }>;
  geometry(): MaybePromise<Bounds>;
  post(events: InputEvent[], bounds: Bounds | null, cleanup: boolean): MaybePromise<number>;
  close(): MaybePromise<boolean>;
}
function crc32(data: Buffer): number { let crc = 0xffffffff; for (const b of data) { crc ^= b; for (let i = 0; i < 8; i++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0); } return (crc ^ 0xffffffff) >>> 0; }
export function pngBGRA(width: number, height: number, pixels: Buffer): Buffer {
  if (!integer(width, 1, 4096) || !integer(height, 1, 4096) || pixels.length !== width * height * 4) throw new ServiceError("Windows pixel buffer differs from its display envelope.", 409);
  const scanlines = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) { const from = (y * width + x) * 4, to = y * (width * 3 + 1) + 1 + x * 3; scanlines[to] = pixels[from + 2]!; scanlines[to + 1] = pixels[from + 1]!; scanlines[to + 2] = pixels[from]!; }
  const chunk = (kind: string, data: Buffer): Buffer => { const type = Buffer.from(kind), head = Buffer.alloc(4), tail = Buffer.alloc(4); head.writeUInt32BE(data.length); tail.writeUInt32BE(crc32(Buffer.concat([type, data]))); return Buffer.concat([head, type, data, tail]); };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const png = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", header), chunk("IDAT", deflateSync(scanlines, { level: 3 })), chunk("IEND", Buffer.alloc(0))]);
  if (png.length >= 4194304) throw new ServiceError("Windows frame exceeds its TightPNG envelope.", 409); return png;
}
export class Win32Desktop implements InputBackend {
  readonly lane = new Lane(); fenced = false; inputFenced = false; revoked = false;
  constructor(readonly api: DesktopAPI, readonly authorized: Authority, readonly cleanupAuthorized: Authority = authorized) {}
  authorize(cleanup = false): void { if (!allowed(this.authorized)) this.revoked = this.inputFenced = true; if (this.fenced || !(cleanup ? allowed(this.cleanupAuthorized) : !this.revoked && allowed(this.authorized))) throw new ServiceError("Windows desktop authorization ended.", 410); }
  async capture(): Promise<{ bounds: Bounds; png: Buffer }> {
    return this.lane.run(async () => { this.authorize(); const result = await this.api.capture(); if (!equal(await this.api.geometry(), result.bounds)) throw new ServiceError("Desktop topology changed during capture.", 409, { code: "input_stale" }); const png = pngBGRA(result.bounds[2], result.bounds[3], result.pixels); this.authorize(); return { bounds: result.bounds, png }; });
  }
  async post(events: InputEvent[], bounds: Bounds | null, cleanup: boolean): Promise<{ posted: boolean }> {
    if (!Array.isArray(events) || !integer(events.length, 1, 4096)) throw new ServiceError("Use bounded native input batches.", 400);
    for (const event of events) {
      if (event.kind === "key") { keyInput(event.vk, event.scan, event.flags); if (cleanup && !(event.flags & 2)) throw new ServiceError("Cleanup may only release keys.", 400); }
      else if (event.kind === "mouse") { mouseInput(event.flags, event.data, event.x, event.y); if (cleanup && (!event.flags || event.flags & ~0x154)) throw new ServiceError("Cleanup may only release buttons.", 400); }
      else throw new ServiceError("Unsupported native input kind.", 400);
    }
    return this.lane.run(async () => {
      this.authorize(cleanup); if (this.inputFenced && !cleanup) throw new ServiceError("Windows native input requires retirement after uncertainty.", 409);
      if (!cleanup && !equal(await this.api.geometry(), bounds)) throw new ServiceError("Input frame geometry is stale.", 409, { code: "input_stale" });
      try { const count = await this.api.post(structuredClone(events), bounds, cleanup); if (count !== events.length) throw uncertain("Native input count differs."); if (!cleanup && !equal(await this.api.geometry(), bounds)) throw uncertain("Desktop changed during input."); this.authorize(cleanup); return { posted: true }; }
      catch { this.inputFenced = true; throw uncertain("Windows input outcome is unknown; it will not be replayed."); }
    });
  }
  async close(): Promise<boolean> { this.fenced = true; if (this.lane.busy) return false; try { return await this.api.close() === true; } catch { return false; } }
}
