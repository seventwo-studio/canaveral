import { createHash } from "node:crypto";
import { CHUNK, Lane, ServiceError, allowed, fields, integer, text, uuid, type Authority } from "./common.ts";
import { WindowsRoot, type FilePin } from "./files.ts";
interface Transfer {
  id: string; path: string; lane: Lane; state: string; pin?: FilePin;
  size: number; offset: number; verified: number; digest: ReturnType<typeof createHash>;
  second: ReturnType<typeof createHash>; sha256?: string; cleanupPending: boolean; orphaned: boolean;
}
const routes: Record<string, string[]> = { list: ["path"], "download/begin": ["id", "path"], "download/chunk": ["id", "offset"], "download/check": ["id"], "download/finish": ["id"], "download/verify": ["id"], status: ["id"], abort: ["id"] };
export function validateFileRequest(path: string, body: unknown): { route: string; body: Record<string, unknown>; id?: string } {
  const route = path.startsWith("/v1/files/") ? path.slice(10) : "";
  const keys = routes[route]; if (!keys) throw new ServiceError("Windows file operation is unsupported.", 409, { code: "capability_unsupported" });
  const value = fields(body, keys);
  if (Buffer.byteLength(JSON.stringify(value)) > 1000000) throw new ServiceError("File control envelope is oversized.", 400);
  if (keys.includes("path") && !text(value.path, 1000000)) throw new ServiceError("Guest path is empty.", 400);
  if (route === "download/chunk" && !integer(value.offset)) throw new ServiceError("Invalid download cursor.", 400);
  return { route, body: value, ...(route !== "list" ? { id: uuid(value.id) } : {}) };
}
export class WindowsDownloads {
  readonly records = new Map<string, Transfer>();
  fenced = false;
  constructor(readonly root: WindowsRoot, readonly resolve: (path: string) => readonly string[], readonly authorized: Authority, readonly cleanupAuthorized: Authority = authorized) {}
  authorize(cleanup = false): void {
    const active = allowed(this.authorized); if (!active) this.fenced = true;
    if (!(cleanup ? allowed(this.cleanupAuthorized) : active && !this.fenced)) throw new ServiceError("Windows file authorization ended.", 410, { retryable: false });
  }
  status(r: Transfer): Record<string, unknown> {
    return { id: r.id, state: r.state, bytes: r.size, offset: r.offset, cleanupPending: r.cleanupPending || r.orphaned,
      ...(["verifying", "cleanupPending"].includes(r.state) ? { verified: r.verified } : {}), ...(r.state === "verified" ? { sha256: r.sha256 } : {}) };
  }
  receipt(r: Transfer): Record<string, unknown> { this.authorize(); return this.status(r); }
  async fail(r: Transfer): Promise<void> {
    r.state = "failed";
    if (r.pin) { r.cleanupPending = !await r.pin.close(); if (!r.cleanupPending) delete r.pin; }
  }
  async request(path: string, body: unknown): Promise<Record<string, unknown>> {
    const request = validateFileRequest(path, body), { route } = request, value = request.body;
    this.authorize(route === "abort");
    if (route === "list") { const result = await this.root.list(this.resolve(value.path as string)); this.authorize(); return { ...result, path: value.path }; }
    const id = request.id!; let r = this.records.get(id), fresh = false;
    if (!r) {
      if (route !== "download/begin") throw new ServiceError("Windows transfer is unknown; it cannot resume.", 404);
      r = { id, path: value.path as string, lane: new Lane(), state: "opening", size: 0, offset: 0, verified: 0, digest: createHash("sha256"), second: createHash("sha256"), cleanupPending: false, orphaned: false };
      this.records.set(id, r); fresh = true;
    }
    const record = r;
    return record.lane.run(async () => {
      let attempted = false;
      try {
        if (route === "download/begin") {
          if (record.path !== value.path) throw new ServiceError("Transfer UUID belongs to another path.", 409);
          if (fresh) {
            attempted = true;
            try { record.pin = await this.root.pin(this.resolve(record.path)); record.size = record.pin.identity.size; await record.pin.check(); this.authorize(); record.state = "reading"; }
            catch (error) { record.orphaned = !record.pin && error instanceof ServiceError && error.outcome === "unknown"; throw error; }
          }
          return this.receipt(record);
        }
        if (route === "status") return this.receipt(record);
        if (route === "abort") {
          if (record.orphaned) throw new ServiceError("Failed open requires confirmed root shutdown.", 409, { code: "file_cleanup_uncertain" });
          if (record.pin && !await record.pin.close()) { record.cleanupPending = true; throw new ServiceError("Transfer cleanup is unconfirmed.", 409, { code: "file_cleanup_uncertain" }); }
          delete record.pin; record.cleanupPending = false; record.state = "aborted"; this.authorize(true); return { id, state: "aborted", bytes: 0 };
        }
        if (["failed", "aborted", "opening"].includes(record.state)) throw new ServiceError("Transfer ended or cannot resume.", 409);
        if (route === "download/check") {
          if (record.state !== "reading") throw new ServiceError("Download is no longer reading.", 409);
          attempted = true; await record.pin!.check();
        } else if (route === "download/chunk") {
          if (record.state !== "reading" || value.offset !== record.offset) throw new ServiceError("Download cursor differs; bytes are not replayed.", 409);
          attempted = true; const count = Math.min(CHUNK, record.size - record.offset);
          const bytes = await record.pin!.read(record.offset, count);
          if (bytes.length !== count) throw new ServiceError("Windows source ended before its length.", 409);
          this.authorize(); record.digest.update(bytes); record.offset += count; this.authorize();
          return { id, offset: record.offset, data: bytes.toString("base64") };
        } else if (route === "download/finish" && record.state === "reading") {
          if (record.offset !== record.size) throw new ServiceError("Download is incomplete.", 409);
          record.state = "verifying"; return await this.verify(record);
        } else if (route === "download/verify") {
          if (!["verifying", "cleanupPending", "verified"].includes(record.state)) throw new ServiceError("Verification has not started.", 409);
          return await this.verify(record);
        }
        return this.receipt(record);
      } catch (error) {
        if (route !== "status" && route !== "abort" && (attempted || error instanceof ServiceError && error.status === 410)) await this.fail(record);
        if (error instanceof ServiceError) throw error;
        await this.fail(record); throw new ServiceError("Windows download acknowledgement is unconfirmed.", 409, { retryable: false });
      }
    });
  }
  private async verify(r: Transfer): Promise<Record<string, unknown>> {
    if (r.state === "verified") return this.receipt(r);
    try {
      if (r.state === "verifying") {
        const count = Math.min(CHUNK, r.size - r.verified), bytes = await r.pin!.read(r.verified, count);
        if (bytes.length !== count) throw new ServiceError("Windows source changed during verification.", 409);
        this.authorize(); r.second.update(bytes); r.verified += count;
        if (r.verified < r.size) return this.receipt(r);
        await r.pin!.check();
        if (r.second.copy().digest("hex") !== r.digest.copy().digest("hex")) throw new ServiceError("Windows download digest changed.", 409);
        r.sha256 = r.digest.copy().digest("hex"); r.state = "cleanupPending";
      }
      this.authorize();
      if (!await r.pin!.close()) { r.cleanupPending = true; throw new ServiceError("Download handle release is unconfirmed.", 409, { code: "file_cleanup_uncertain", retryable: false }); }
      delete r.pin; r.cleanupPending = false; this.authorize(); r.state = "verified"; return this.receipt(r);
    } catch (error) { if (r.state !== "cleanupPending" || error instanceof ServiceError && error.status === 410) await this.fail(r); throw error; }
  }
  async close(): Promise<boolean> { this.fenced = true; const confirmed = await this.root.close(); if (confirmed) for (const r of this.records.values()) { r.orphaned = r.cleanupPending = false; } return confirmed; }
}
