import { createHash } from "node:crypto";
import { Lane, MAX_INTEGER, ServiceError, allowed, canonical, equal, integer, uuid, type Authority } from "./common.ts";
import { WindowsRoot, components, directoryStamp, safeIdentity, type FileIdentity, type Handle } from "./files.ts";
import { neutral, validateState, type HeldState } from "./input.ts";
export const SLOT_BYTES = 131072, JOURNAL_BYTES = SLOT_BYTES * 2;
const HEADER_BYTES = 72, MAGIC = Buffer.from("CNVWINJ1");
function payload(state: HeldState): Buffer { return Buffer.from(canonical(validateState(state))); }
function pack(context: string, sequence: number, state: HeldState): Buffer {
  const raw = Buffer.alloc(SLOT_BYTES), body = payload(state);
  MAGIC.copy(raw); raw.writeBigUInt64LE(BigInt(sequence), 8); raw.writeUInt32LE(body.length, 16); raw.writeUInt32LE(1, 20); Buffer.from(context.replaceAll("-", ""), "hex").copy(raw, 24);
  createHash("sha256").update(raw.subarray(0, 40)).update(body).digest().copy(raw, 40); body.copy(raw, HEADER_BYTES); return raw;
}
class Torn extends Error {}
function decode(raw: Buffer, index: number, context: string): { sequence: number; state: HeldState } | undefined {
  if (raw.length !== SLOT_BYTES) throw new Torn(); if (raw.every(n => n === 0)) return undefined;
  const length = raw.readUInt32LE(16), sequence = Number(raw.readBigUInt64LE(8));
  if (!raw.subarray(0, 8).equals(MAGIC) || !integer(length, 1, 65536) || raw.subarray(HEADER_BYTES + length).some(n => n !== 0)) throw new Torn();
  const body = raw.subarray(HEADER_BYTES, HEADER_BYTES + length);
  if (!createHash("sha256").update(raw.subarray(0, 40)).update(body).digest().equals(raw.subarray(40, 72))) throw new Torn();
  if (!raw.subarray(24, 40).equals(Buffer.from(context.replaceAll("-", ""), "hex")) || raw.readUInt32LE(20) !== 1 || !integer(sequence, 1) || sequence % 2 !== index) throw new ServiceError("Journal context, version or sequence differs.", 409, { code: "input_reset_uncertain" });
  const state = validateState(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)) as unknown);
  if (!payload(state).equals(body)) throw new ServiceError("Journal payload is noncanonical or invalid.", 409);
  return { sequence, state };
}
function covers(a: HeldState, b: HeldState): boolean { return b.keys.every(k => a.keys.some(v => equal(k, v))) && (a.buttons & b.buttons) === b.buttons && b.transient.every(c => a.transient.some(v => equal(c, v))); }
export function journalTransition(previous: HeldState, next: HeldState): void {
  if (!(previous.blocked ? covers(previous, next) && (!next.blocked || covers(next, previous)) : next.blocked && covers(next, previous))) throw new ServiceError("Journal transition would lose or invent held input.", 409, { code: "input_reset_uncertain" });
}
export class WindowsInputJournal {
  readonly io = new Lane(); readonly handles: Handle[] = []; readonly parents: [Handle, unknown][] = [];
  handle?: Handle; stamp?: FileIdentity; sequence = 0; private value = neutral(); fenced = false; closed = false; private writeAttempted = false;
  constructor(readonly root: WindowsRoot, readonly context: string, readonly expected: { volume: string; fileId: string }, readonly authorized: Authority) {}
  static async open(root: WindowsRoot, parts: readonly string[], context: string, expected: { volume: string; fileId: string }, authorized: Authority, initialize = false): Promise<WindowsInputJournal> {
    context = uuid(context); components(parts);
    if (!parts.length || typeof expected.volume !== "string" || !/^[a-f0-9]{32}$/i.test(expected.fileId)) throw new ServiceError("Journal requires provisioned file identity and relative path.", 400);
    if (!root.api.journal || !root.api.write || !root.api.flush) throw new ServiceError("Native journal storage is unavailable.", 409, { code: "capability_unsupported" });
    const journal = new WindowsInputJournal(root, context, expected, authorized); let parent = root.handle; root.pins.add(journal);
    try {
      await journal.io.run(async () => {
        journal.authorize(); journal.parents.push([parent, directoryStamp(await root.api.info(parent))]);
        if (!equal(journal.parents[0]![1], directoryStamp(root.identity))) throw new ServiceError("Journal root changed.", 409);
        for (const name of parts.slice(0, -1)) { journal.authorize(); parent = await root.api.open(parent, name, true); journal.handles.push(parent); journal.parents.push([parent, directoryStamp(await root.api.info(parent))]); }
        await journal.check(); journal.handle = await root.api.journal!(parent, parts.at(-1)!); journal.handles.push(journal.handle); journal.stamp = await root.api.info(journal.handle); journal.regular(journal.stamp);
        await journal.load(initialize); await journal.check();
      }); return journal;
    } catch { const confirmed = await journal.close(); throw new ServiceError("Windows journal setup/recovery was not confirmed.", 409, { code: "input_reset_uncertain", retryable: false, ...(!confirmed || journal.writeAttempted || root.api.cleanupUncertain ? { outcome: "unknown" } : {}) }); }
  }
  get recovered(): HeldState { if (this.fenced || this.closed) throw new ServiceError("Reopen fenced journal explicitly.", 409); return structuredClone(this.value); }
  authorize(): void { if (this.fenced || this.closed || this.root.fenced || !allowed(this.authorized)) { this.fenced = true; throw new ServiceError("Journal I/O authorization ended.", 410); } }
  regular(info: FileIdentity): void { safeIdentity(info); if (info.directory || info.links !== 1 || info.size !== JOURNAL_BYTES || info.volume !== this.expected.volume || info.fileId !== this.expected.fileId || info.volume !== this.root.identity.volume) throw new ServiceError("Journal differs from its provisioned identity/size.", 409); }
  async check(): Promise<void> {
    this.authorize(); for (const [h, stamp] of this.parents) { const info = await this.root.api.info(h); if (info.volume !== this.root.identity.volume || !equal(directoryStamp(info), stamp)) throw new ServiceError("Journal parent changed.", 409); }
    if (this.handle) { const info = await this.root.api.info(this.handle); this.regular(info); if (!equal(info, this.stamp)) throw new ServiceError("Journal metadata changed.", 409); } this.authorize();
  }
  async read(index: number): Promise<Buffer> { await this.check(); const raw = await this.root.api.read(this.handle!, index * SLOT_BYTES, SLOT_BYTES); if (!Buffer.isBuffer(raw) || raw.length !== SLOT_BYTES) throw new ServiceError("Journal read was truncated.", 409); await this.check(); return raw; }
  async load(initialize: boolean): Promise<void> {
    const records: { sequence: number; state: HeldState }[] = []; let torn = false, blank = 0;
    for (let i = 0; i < 2; i++) { try { const record = decode(await this.read(i), i, this.context); if (record) records.push(record); else blank++; } catch (error) { if (error instanceof Torn) torn = true; else throw error; } }
    if (!records.length) { if (blank !== 2 || !initialize) throw new ServiceError("Missing/corrupt journal cannot initialize implicitly.", 409); await this.write(1, neutral()); return; }
    records.sort((a, b) => a.sequence - b.sequence);
    if (records.length === 2) { if (records[1]!.sequence !== records[0]!.sequence + 1) throw new ServiceError("Journal history is ambiguous.", 409); journalTransition(records[0]!.state, records[1]!.state); }
    const last = records.at(-1)!;
    if (torn && !last.state.blocked || blank && last.sequence !== 1) throw new ServiceError("Journal lacks conservative recovery evidence.", 409);
    this.sequence = last.sequence; this.value = last.state;
  }
  async write(sequence: number, state: HeldState): Promise<void> {
    await this.check(); const raw = pack(this.context, sequence, state); let written = 0;
    while (written < raw.length) { this.authorize(); this.writeAttempted = true; const count = await this.root.api.write!(this.handle!, sequence % 2 * SLOT_BYTES + written, raw.subarray(written)); if (!integer(count, 1, raw.length - written)) throw new ServiceError("Journal progress is unknown.", 409); written += count; }
    this.authorize(); await this.root.api.flush!(this.handle!); this.stamp = await this.root.api.info(this.handle!); this.regular(this.stamp);
    if (!(await this.read(sequence % 2)).equals(raw)) throw new ServiceError("Journal readback differs.", 409);
    await this.check(); this.sequence = sequence; this.value = structuredClone(state);
  }
  save = async (raw: HeldState): Promise<boolean> => {
    const state = validateState(raw);
    return this.io.run(async () => {
      this.authorize(); journalTransition(this.value, state); if (this.sequence >= MAX_INTEGER) throw new ServiceError("Journal sequence exhausted.", 409);
      try { await this.write(this.sequence + 1, state); return true; } catch { this.fenced = true; throw new ServiceError("Journal save was not confirmed.", 409, { code: "input_reset_uncertain", retryable: false, outcome: "unknown" }); }
    });
  };
  async close(): Promise<boolean> { this.fenced = true; if (this.io.busy) return false; return this.io.run(async () => { try { while (this.handles.length) { const h = this.handles.at(-1)!; await this.root.api.close(h); this.handles.pop(); if (h === this.handle) delete this.handle; } this.closed = true; this.root.pins.delete(this); return true; } catch { return false; } }); }
}
