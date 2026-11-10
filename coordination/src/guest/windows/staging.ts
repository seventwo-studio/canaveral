import { createHash, randomUUID } from "node:crypto";
import { CHUNK, Lane, ServiceError, allowed, equal, integer, uncertain, unsupported, type Authority } from "./common.ts";
import { WindowsRoot, component, components, directoryStamp, safeIdentity, type FileIdentity, type Handle } from "./files.ts";
export class WindowsStage {
  readonly name = `.canaveral-upload-${randomUUID().replaceAll("-", "")}`;
  readonly io = new Lane(); readonly handles: Handle[] = []; readonly parents: [Handle, unknown][] = [];
  handle?: Handle; identity?: FileIdentity;
  offset = 0; verified = 0; state = "creating"; fenced = false; closed = false;
  publicationAttempted = false; publicationKnown = false; deleteMarked = false;
  readonly first = createHash("sha256"); readonly second = createHash("sha256"); expected?: string;
  constructor(readonly root: WindowsRoot, readonly size: number, readonly authorized: Authority) {}
  static async create(root: WindowsRoot, parentParts: readonly string[], size: number, authorized: Authority): Promise<WindowsStage> {
    if (!integer(size)) throw new ServiceError("Stage requires an exact length.", 400); components(parentParts);
    if (!root.api.create || !root.api.write || !root.api.flush || !root.api.discard) unsupported("Windows staging is unavailable.");
    let parent = root.handle; const stage = new WindowsStage(root, size, authorized); root.pins.add(stage);
    try {
      await stage.io.run(async () => {
        stage.authorize(); stage.parents.push([parent, directoryStamp(await root.api.info(parent))]);
        if (!equal(stage.parents[0]![1], directoryStamp(root.identity))) throw new ServiceError("Stage root identity changed.", 409);
        for (const name of parentParts) { stage.authorize(); parent = await root.api.open(parent, name, true); stage.handles.push(parent); const info = await root.api.info(parent); if (info.volume !== root.identity.volume) throw new ServiceError("Stage parent crossed its volume.", 409); stage.parents.push([parent, directoryStamp(info)]); }
        await stage.guard(); stage.handle = await root.api.create!(parent, stage.name); stage.handles.push(stage.handle);
        stage.identity = await root.api.info(stage.handle); stage.regular(stage.identity, 0); await stage.guard(); stage.state = "receiving";
      }); return stage;
    } catch { stage.state = "failed"; const confirmed = await stage.close(); throw new ServiceError("Windows stage setup failed.", 409, { retryable: false, ...(!confirmed ? { outcome: "unknown" } : {}) }); }
  }
  authorize(): void { if (this.fenced || this.closed || this.root.fenced || !allowed(this.authorized)) { this.fenced = true; throw new ServiceError("Windows staging authorization ended.", 410); } }
  regular(info: FileIdentity, size: number): void {
    safeIdentity(info);
    if (info.directory || info.links !== 1 || info.volume !== this.root.identity.volume || info.size !== size || this.identity && (info.volume !== this.identity.volume || info.fileId !== this.identity.fileId)) throw new ServiceError("Windows staging identity or length differs.", 409);
  }
  async guard(): Promise<void> {
    this.authorize();
    for (const [h, stamp] of this.parents) if (!equal(directoryStamp(await this.root.api.info(h)), stamp)) throw new ServiceError("Stage parent identity changed.", 409);
    if (this.handle && !equal(await this.root.api.info(this.handle), this.identity)) throw new ServiceError("Pinned stage metadata changed.", 409);
    this.authorize();
  }
  async work<T>(operation: () => Promise<T>, mutation = () => false): Promise<T> {
    return this.io.run(async () => { try { await this.guard(); const result = await operation(); await this.guard(); return result; }
      catch (error) { this.state = "failed"; this.fenced = true; if (mutation()) throw uncertain("Windows staging write acknowledgement is unconfirmed."); if (error instanceof ServiceError) throw error; throw uncertain("Windows staging operation is unconfirmed."); } });
  }
  async write(offset: number, data: Buffer): Promise<{ offset: number }> {
    if (!integer(offset) || offset !== this.offset || this.state !== "receiving" || !Buffer.isBuffer(data) || !integer(data.length, 1, CHUNK) || offset + data.length > this.size) throw new ServiceError("Invalid stage phase, cursor or chunk.", 409);
    let dispatched = false;
    return this.work(async () => {
      let written = 0;
      while (written < data.length) { this.authorize(); dispatched = true; const count = await this.root.api.write!(this.handle!, offset + written, data.subarray(written)); if (!integer(count, 1, data.length - written)) throw uncertain("Stage write length is unknown."); written += count; }
      const info = await this.root.api.info(this.handle!); this.regular(info, offset + written); this.identity = info;
      this.first.update(data); this.offset += written; return { offset: this.offset };
    }, () => dispatched);
  }
  async finish(sha256: string): Promise<Record<string, unknown>> {
    if (!/^[a-f0-9]{64}$/.test(sha256) || this.state !== "receiving" || this.offset !== this.size || sha256 !== this.first.copy().digest("hex")) throw new ServiceError("Stage length or digest differs.", 409);
    await this.work(async () => { await this.root.api.flush!(this.handle!); const info = await this.root.api.info(this.handle!); this.regular(info, this.size); this.identity = info; this.expected = sha256; this.state = "verifying"; });
    return this.verify();
  }
  async verify(): Promise<Record<string, unknown>> {
    if (!["verifying", "ready"].includes(this.state)) throw new ServiceError("Stage is not ready for verification.", 409);
    return this.work(async () => {
      if (this.state === "verifying") {
        const count = Math.min(CHUNK, this.size - this.verified), data = count ? await this.root.api.read(this.handle!, this.verified, count) : Buffer.alloc(0);
        if (!Buffer.isBuffer(data) || data.length !== count) throw new ServiceError("Staged source ended during verification.", 409);
        this.second.update(data); this.verified += count;
        if (this.verified === this.size) { if (this.second.copy().digest("hex") !== this.expected) throw new ServiceError("Staged digest differs.", 409); this.state = "ready"; }
      }
      return { state: this.state, bytes: this.size, verified: this.verified, durable: false, ...(this.state === "ready" ? { sha256: this.expected } : {}) };
    });
  }
  async publish(name: string): Promise<Record<string, unknown>> {
    component(name); if (name.toLowerCase() === this.name.toLowerCase()) throw new ServiceError("Stage cannot replace its temporary name.", 400);
    if (!this.root.api.publish) unsupported("Windows publication is unavailable.");
    return this.io.run(async () => {
      if (this.publicationAttempted || this.state !== "ready") throw new ServiceError("Stage publication cannot restart or replay.", 409);
      let dispatched = false;
      try {
        await this.guard(); this.state = "publishing"; this.publicationAttempted = dispatched = true;
        if (await this.root.api.publish!(this.handle!, name) !== true) throw uncertain("Publication is unconfirmed.");
        this.publicationKnown = true; let info = await this.root.api.info(this.handle!); this.regular(info, this.size); this.identity = info;
        await this.root.api.flush!(this.handle!); info = await this.root.api.info(this.handle!); this.regular(info, this.size); this.identity = info; await this.guard(); this.state = "published";
        return { state: "published", destination: name, bytes: this.size, sha256: this.expected, durable: false };
      } catch (error) { if (dispatched) { this.state = "publicationUnknown"; this.fenced = true; throw uncertain("Publication outcome is unknown; reconcile before retrying."); } throw error; }
    });
  }
  async close(): Promise<boolean> {
    this.fenced = true; if (this.io.busy || this.publicationAttempted && !this.publicationKnown) return false;
    return this.io.run(async () => {
      try {
        if (this.handle && !this.deleteMarked && !this.publicationAttempted) { await this.root.api.discard!(this.handle); this.deleteMarked = true; }
        while (this.handles.length) { const h = this.handles.at(-1)!; await this.root.api.close(h); this.handles.pop(); if (h === this.handle) delete this.handle; }
        this.closed = true; if (!this.publicationAttempted) this.state = "discarded"; this.root.pins.delete(this); return true;
      } catch { return false; }
    });
  }
}
