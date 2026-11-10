import { createHash, randomUUID } from "node:crypto";
import { ServiceError, object } from "../errors.ts";

// These are memory/message envelopes, never a total file-size product limit.
export const CHUNK = 1048576;
export const GUEST_CHUNK = 524288;
export const WIRE_CHUNK = 65536;
export const MAX_INTEGER = Number.MAX_SAFE_INTEGER;
export const MAX_HELPER_BYTES = 16 * 1048576;
export type Awaitable<T> = T | Promise<T>;
export interface ByteReader { read(maximum: number): Awaitable<Uint8Array> }
export interface ByteWriter { write(data: Uint8Array): Awaitable<number> }
export interface TransferGuard { authorized(): boolean; signal?: AbortSignal }
const defaultGuard: TransferGuard = { authorized: () => true };

export function uuid(value: unknown): string {
  if (typeof value !== "string" || !/^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$/.test(value)) throw new ServiceError("Expected a UUID.", 400);
  return value.toLowerCase();
}
export function transferSize(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new ServiceError("Invalid transfer length or cursor.", 400);
  return value;
}
export function jsonBytes(value: unknown, maximum: number): Buffer {
  // JSON.stringify otherwise silently changes NaN, Infinity and undefined into a different receipt.
  const seen = new Set<unknown>();
  const check = (item: unknown, depth: number): void => {
    if (depth > 100 || (typeof item === "number" && !Number.isFinite(item)) || item === undefined || ["function", "symbol", "bigint"].includes(typeof item)) throw new ServiceError("Invalid JSON receipt.", 400);
    if (item !== null && typeof item === "object") {
      if (seen.has(item)) throw new ServiceError("Cyclic JSON receipt.", 400);
      seen.add(item);
      for (const child of Object.values(item)) check(child, depth + 1);
      seen.delete(item);
    }
  };
  check(value, 0);
  const encoded = Buffer.from(JSON.stringify(value), "utf8");
  if (encoded.length > maximum) throw new ServiceError("JSON result exceeds its bounded envelope.", 413);
  return encoded;
}
export function decodeData(value: unknown, maximum = GUEST_CHUNK): Buffer {
  if (typeof value !== "string" || value.length > Math.ceil(maximum / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new ServiceError("Invalid or oversized base64 file data.", 400);
  const data = Buffer.from(value, "base64");
  if (data.length > maximum) throw new ServiceError("File chunk exceeds its bounded envelope.", 400);
  return data;
}
/** Validates the public guest namespace only. Native adapters must pin/no-follow components. */
export function guestPath(value: unknown, namespace: "absolute" | "container", directory = false): string {
  if (typeof value !== "string" || !value || value.length > 4096 || value.includes("\0") || value.includes("\\")) throw new ServiceError("Invalid guest file path.", 400);
  if (namespace === "absolute") {
    if (!value.startsWith("/") || value.split("/").includes("..") || (!directory && (value === "/" || value.endsWith("/")))) throw new ServiceError("Use an absolute guest file path without traversal.", 400);
  } else if (value.startsWith("/") || value.split("/").includes("..") || (!directory && (value === "." || value.endsWith("/") || value.split("/").every(p => p === "." || p === "")))) {
    throw new ServiceError("Use a file path inside the app container.", 400);
  }
  return value;
}
function check(guard: TransferGuard): void {
  if (guard.signal?.aborted || !guard.authorized()) throw new ServiceError("Transfer authorization ended.", 401);
}
/** Races cancellable provider work, without treating JS cancellation as native cleanup proof. */
async function guarded<T>(guard: TransferGuard, work: () => Awaitable<T>): Promise<T> {
  check(guard);
  let cancel: (() => void) | undefined;
  try {
    const result = guard.signal ? await Promise.race([
      Promise.resolve().then(() => { check(guard); return work(); }),
      new Promise<never>((_resolve, reject) => {
        cancel = () => reject(new ServiceError("Transfer cancelled; native cleanup is unconfirmed.", 409, { outcome: "unknown", retryable: false }));
        guard.signal!.addEventListener("abort", cancel, { once: true });
        if (guard.signal!.aborted) cancel();
      }),
    ]) : await work();
    check(guard);
    return result;
  } finally { if (cancel) guard.signal?.removeEventListener("abort", cancel); }
}
export async function writeAll(writer: ByteWriter, data: Uint8Array, guard: TransferGuard = defaultGuard): Promise<void> {
  let offset = 0;
  while (offset < data.length) {
    const count = await guarded(guard, () => writer.write(data.subarray(offset)));
    if (!Number.isSafeInteger(count) || count <= 0 || count > data.length - offset) throw new ServiceError("Transfer pipe did not accept its bytes.", 409);
    offset += count;
  }
}
export async function copyUpload(reader: ByteReader, writer: ByteWriter, size: number, guard: TransferGuard = defaultGuard, chunk = CHUNK): Promise<void> {
  transferSize(size);
  if (!Number.isSafeInteger(chunk) || chunk < 1 || chunk > CHUNK) throw new ServiceError("Invalid transfer buffer size.", 400);
  let remaining = size;
  check(guard); // Empty transfers also require current authorization.
  while (remaining) {
    const maximum = Math.min(chunk, remaining), data = await guarded(guard, () => reader.read(maximum));
    if (!(data instanceof Uint8Array) || !data.length || data.length > maximum) throw new ServiceError("Upload interrupted or exceeded its declared length.", 400);
    await writeAll(writer, data, guard);
    remaining -= data.length;
  }
  check(guard);
}

/** All filesystem methods operate on retained native handles, never concatenated host paths.
 * createExclusive must reserve a private 0600 inode; cleanup removes only that exact owned inode.
 * publish must atomically rename/attach within the pinned parent and refuse no-replace collisions.
 * No Node path fallback is supplied: native handle adapters are required for these operations. */
export interface PinnedStage extends ByteWriter {
  sync(): Awaitable<void>;
  publish(name: string, replace: boolean): Awaitable<void>;
  cleanup(): Awaitable<void>;
  close(): Awaitable<void>;
}
export interface PinnedDirectory {
  exists(name: string): Awaitable<boolean>;
  createExclusive(name: string): Awaitable<PinnedStage>;
  sync(): Awaitable<void>;
}
function component(name: string): void {
  if (!name || [".", ".."].includes(name) || /[/\\\0]/.test(name)) throw new ServiceError("Choose a simple destination filename.", 400);
}
function uncertain(kind: "upload" | "download", _cause?: unknown): ServiceError {
  return new ServiceError(`${kind === "upload" ? "Upload" : "Local download"} publication may have occurred; inspect before retrying.`, 409,
    { code: `${kind}_publication_uncertain`, outcome: "unknown", retryable: false });
}
async function publishBytes<T>(directory: PinnedDirectory | undefined, name: string, receive: (writer: ByteWriter) => Awaitable<T>, replace: boolean,
  kind: "upload" | "download", guard: TransferGuard): Promise<T> {
  if (!directory) throw new ServiceError("Pinned native file publication is unsupported without a bound provider.", 409, { code: "capability_unsupported", retryable: false });
  component(name);
  if (typeof replace !== "boolean") throw new ServiceError("Download replacement must be explicit.", 400);
  check(guard);
  if (!replace && await guarded(guard, () => directory.exists(name))) throw new ServiceError("Download destination already exists.", 409, { code: "download_destination_exists" });
  let stage: PinnedStage | undefined, attempted = false;
  try {
    // Ownership starts only after positive exclusive creation. A collision is never cleaned up.
    await guarded(guard, async () => { stage = await directory.createExclusive(`.canaveral-${kind}-${randomUUID()}`); });
    const result = await guarded(guard, () => receive(stage!));
    await guarded(guard, () => stage!.sync());
    check(guard);
    attempted = true;
    await guarded(guard, () => stage!.publish(name, replace));
    await guarded(guard, () => directory.sync());
    check(guard);
    return result;
  } catch (error) {
    let failure = attempted ? uncertain(kind, error) : error;
    // A positive EEXIST refusal guarantees no publication for no-replace operations.
    if (attempted && !replace && error instanceof ServiceError && error.code === "download_destination_exists") failure = error;
    throw failure;
  } finally {
    if (stage) {
      // The adapter must never remove a destination, including after lost publish acknowledgement.
      let cleanupFailed = false;
      try { await stage.cleanup(); } catch { cleanupFailed = true; }
      try { await stage.close(); } catch { cleanupFailed = true; }
      if (cleanupFailed) {
        if (attempted) throw uncertain(kind);
        throw new ServiceError("Owned temporary file cleanup needs inspection.", 409, { code: `${kind}_temporary_cleanup_failed`, retryable: false });
      }
    }
  }
}
export async function atomicUpload(directory: PinnedDirectory | undefined, name: string, reader: ByteReader, size: number, guard: TransferGuard = defaultGuard): Promise<{ uploaded: number; durable: true }> {
  transferSize(size);
  return publishBytes(directory, name, async writer => {
    await copyUpload(reader, writer, size, guard);
    return { uploaded: size, durable: true as const };
  }, true, "upload", guard);
}
/** The callback must return only after verifying the transfer's complete count/digest/finish. */
export function receiveFile<T>(directory: PinnedDirectory | undefined, name: string, transfer: (writer: ByteWriter) => Awaitable<T>, replace = false, guard: TransferGuard = defaultGuard): Promise<T> {
  return publishBytes(directory, name, transfer, replace, "download", guard);
}
/** Durable private JSON publication. An exclusive host lock belongs to the adapter/runner journal. */
export async function saveJson(directory: PinnedDirectory | undefined, name: string, value: unknown, guard: TransferGuard = defaultGuard): Promise<void> {
  const bytes = jsonBytes(value, 6 * 1048576 + 16384);
  await publishBytes(directory, name, writer => writeAll(writer, bytes, guard), true, "upload", guard);
}
export interface HostLockProvider { acquireExclusive(): Awaitable<() => Awaitable<void>> }
export async function withHostLock<T>(provider: HostLockProvider | undefined, work: () => Awaitable<T>): Promise<T> {
  if (!provider) throw new ServiceError("Native host-state locking requires a bound provider.", 409, { code: "capability_unsupported" });
  const release = await provider.acquireExclusive();
  try { return await work(); } finally { await release(); }
}

export interface VerifiedDownload extends ByteReader { size: number; verify(): Awaitable<boolean>; close(): Awaitable<void> }
export function fileIdentity(metadata: { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint }): string {
  return createHash("sha256").update([metadata.dev, metadata.ino, metadata.size, metadata.mtimeNs, metadata.ctimeNs].join(":")).digest("hex");
}
/** Never forwards bytes returned after revocation, or finish before source verification. Always closes. */
export async function copyDownload(source: VerifiedDownload, writer: ByteWriter, guard: TransferGuard = defaultGuard): Promise<{ bytes: number; sha256: string }> {
  try {
    const size = transferSize(source.size), digest = createHash("sha256");
    if (await guarded(guard, () => source.verify()) !== true) throw new ServiceError("Download source identity could not be verified.", 409);
    let offset = 0;
    while (offset < size) {
      const maximum = Math.min(WIRE_CHUNK, size - offset), data = await guarded(guard, () => source.read(maximum));
      if (!(data instanceof Uint8Array) || !data.length || data.length > maximum) throw new ServiceError("Download source length differs.", 409);
      await writeAll(writer, data, guard); digest.update(data); offset += data.length;
    }
    if (await guarded(guard, () => source.verify()) !== true) throw new ServiceError("Download source identity changed.", 409);
    return { bytes: offset, sha256: digest.digest("hex") };
  } finally { await source.close(); }
}

export type GuestFileTransport = (path: string, body: Record<string, unknown>, signal?: AbortSignal) => Awaitable<unknown>;
/** Transport is authenticated and bound to one assignment by its owner, never selected by a caller path. */
export class GuestChunkFiles {
  constructor(readonly transport: GuestFileTransport) {}
  async call(route: string, values: Record<string, unknown>, id?: string, guard: TransferGuard = defaultGuard): Promise<Record<string, unknown>> {
    const response = object(await guarded(guard, () => this.transport(`/v1/files/${route}`, values, guard.signal)));
    jsonBytes(response, 6 * 1048576); // Includes bounded listing metadata.
    if (id !== undefined) {
      try { if (uuid(response.id) !== id) throw new Error(); }
      catch { throw new ServiceError("Guest transfer response identity differs.", 409); }
    }
    return response;
  }
  async list(path: string, guard: TransferGuard = defaultGuard): Promise<Record<string, unknown>> {
    guestPath(path, "absolute", true);
    const result = await this.call("list", { path }, undefined, guard);
    if (result.path !== path || !Array.isArray(result.entries) || result.entries.length > 2000 || typeof result.truncated !== "boolean") throw new ServiceError("Malformed guest file listing.", 409);
    return result;
  }
  async upload(path: string, reader: ByteReader, size: number, guard: TransferGuard = defaultGuard): Promise<{ uploaded: number; durable: true }> {
    transferSize(size); guestPath(path, "absolute");
    const id = randomUUID(), digest = createHash("sha256");
    let offset = 0, publishing = false, fenced = false;
    const call = async (route: string, values: Record<string, unknown> = {}) => {
      if (fenced) throw new ServiceError("Transfer is fenced.", 401);
      try { return await this.call(route, { id, ...values }, id, guard); }
      catch (error) { if (guard.signal?.aborted || !guard.authorized()) fenced = true; throw error; }
    };
    try {
      let result = await call("upload/begin", { path, size });
      if (result.state !== "receiving" || result.bytes !== size || typeof result.bytes !== "number") throw new ServiceError("Guest upload did not enter a fresh receiving state.", 409);
      while (offset < size) {
        const maximum = Math.min(GUEST_CHUNK, size - offset), data = await guarded(guard, () => reader.read(maximum));
        if (!(data instanceof Uint8Array) || !data.length || data.length > maximum) throw new ServiceError("Guest upload source ended early or exceeded its declared length.", 400);
        result = await call("upload/chunk", { offset, data: Buffer.from(data).toString("base64") });
        if (result.offset !== offset + data.length) throw new ServiceError("Guest upload cursor differs; input will not be replayed.", 409);
        offset += data.length; digest.update(data);
      }
      const sha256 = digest.digest("hex");
      check(guard); publishing = true;
      result = await call("upload/finish", { bytes: size, sha256 });
      let verified = 0;
      while (result.state === "verifyingUpload") {
        verified = verificationProgress(result.verified, verified, size);
        result = await call("upload/verify");
      }
      if (result.state !== "committed" || result.durable !== true || result.bytes !== size || result.sha256 !== sha256) throw new ServiceError("Guest upload durable digest was not confirmed.", 409);
      check(guard);
      return { uploaded: size, durable: true };
    } catch (error) {
      if (!fenced && !guard.signal?.aborted && guard.authorized()) {
        try { await this.call("abort", { id }, id, guard); } catch { /* Explicit cleanup never retries a mutation. */ }
      }
      if (publishing) throw uncertain("upload", error);
      throw error;
    }
  }
  async download(path: string, guard: TransferGuard = defaultGuard): Promise<VerifiedDownload> {
    guestPath(path, "absolute");
    const source = new GuestDownload(this, guard);
    try {
      const result = await source.call("download/begin", { path });
      source.size = transferSize(result.bytes);
      if (result.state !== "reading") throw new ServiceError("Guest download metadata is invalid.", 409);
      return source;
    } catch (error) { await source.close(); throw error; }
  }
}
function verificationProgress(value: unknown, previous: number, size: number): number {
  const current = transferSize(value);
  if (current <= previous || current >= size || current - previous > GUEST_CHUNK) throw new ServiceError("Guest verification cursor differs.", 409);
  return current;
}
class GuestDownload implements VerifiedDownload {
  readonly id = randomUUID();
  size = 0;
  private offset = 0;
  private buffer: Buffer = Buffer.alloc(0);
  private digest = createHash("sha256");
  private completed = false;
  private closed = false;
  private fenced = false;
  private busy = false;
  constructor(private owner: GuestChunkFiles, private guard: TransferGuard) {}
  async call(route: string, values: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    if (this.closed || this.fenced) throw new ServiceError("Guest download is closed or fenced.", 401);
    try {
      const result = await this.owner.call(route, { id: this.id, ...values }, this.id, this.guard);
      if (this.closed) throw new ServiceError("Guest download closed during transport; cleanup is unconfirmed.", 409);
      return result;
    }
    catch (error) { this.fenced = true; throw error; }
  }
  private async lane<T>(work: () => Promise<T>): Promise<T> {
    if (this.busy) throw new ServiceError("Guest transfer already has an operation in flight.", 409);
    this.busy = true;
    try { check(this.guard); if (this.closed || this.fenced) throw new ServiceError("Guest download is closed or fenced.", 401); return await work(); }
    catch (error) { this.fenced = true; throw error; }
    finally { this.busy = false; }
  }
  async read(size: number): Promise<Uint8Array> {
    transferSize(size);
    return this.lane(async () => {
      if (!size) return Buffer.alloc(0);
      if (!this.buffer.length && this.offset < this.size) {
        const result = await this.call("download/chunk", { offset: this.offset });
        const data = decodeData(result.data), expected = Math.min(GUEST_CHUNK, this.size - this.offset);
        if (data.length !== expected || result.offset !== this.offset + expected) throw new ServiceError("Guest download cursor or length differs.", 409);
        this.offset += data.length; this.digest.update(data); this.buffer = data;
      }
      check(this.guard);
      if (this.closed) throw new ServiceError("Guest download was closed during read.", 409);
      const result = this.buffer.subarray(0, size); this.buffer = this.buffer.subarray(size); return result;
    });
  }
  async verify(): Promise<boolean> {
    return this.lane(async () => {
      if (this.completed) return true;
      if (this.offset !== this.size || this.buffer.length) {
        const result = await this.call("download/check");
        if (result.state !== "reading" || result.bytes !== this.size) throw new ServiceError("Guest download source could not be verified.", 409);
        return true;
      }
      let result = await this.call("download/finish"), verified = 0;
      while (result.state === "verifying") {
        verified = verificationProgress(result.verified, verified, this.size);
        result = await this.call("download/verify");
      }
      if (result.state !== "verified" || result.bytes !== this.size || result.sha256 !== this.digest.copy().digest("hex")) throw new ServiceError("Guest download digest was not confirmed.", 409);
      if (this.closed) throw new ServiceError("Guest download closed before verification.", 409);
      this.completed = true;
      return true;
    });
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true; this.buffer = Buffer.alloc(0);
    // Do not race abort against an in-flight native request. Its owner must supervise
    // that request; closing this wrapper alone does not confirm helper reclamation.
    if (!this.completed && !this.busy && !this.guard.signal?.aborted && this.guard.authorized()) {
      try { await this.owner.call("abort", { id: this.id }, this.id, this.guard); } catch { /* Cleanup remains with the assignment owner. */ }
    }
  }
}

/** Pure validation of an owner-loaded regular-file snapshot. Loading must reject special files
 * and cap manifest reads at 64 KiB before parsing; requests cannot select these artifacts. */
export function validateAndroidHelper(manifest: unknown, binary: Uint8Array, arch: "arm64" | "amd64", systemImage: string): { data: Buffer; sha256: string } {
  try {
    jsonBytes(manifest, 65536);
    const input = object(manifest), artifacts = object(input.artifacts), entry = object(artifacts[arch]);
    const image = /^system-images;android-([0-9]+);[^;]+;([^;]+)$/.exec(systemImage);
    const data = Buffer.from(binary), sha256 = createHash("sha256").update(data).digest("hex");
    if (input.schemaVersion !== 1 || input.protocol !== "CANAVERAL_TRANSFER_V1" || input.minimumAPI !== 26 || !image || Number(image[1]) < 26 || image[2] !== (arch === "arm64" ? "arm64-v8a" : "x86_64") ||
      entry.file !== `canaveral-transfer-${arch}` || entry.bytes !== data.length || data.length < 64 || data.length > MAX_HELPER_BYTES || entry.sha256 !== sha256 ||
      !data.subarray(0, 6).equals(Buffer.from([127, 69, 76, 70, 2, 1])) || data.readUInt16LE(16) !== 3 || data.readUInt16LE(18) !== (arch === "arm64" ? 183 : 62) || data.includes("CANAVERAL_TRANSFER_TEST_FAIL")) throw new Error();
    return { data, sha256 };
  } catch { throw new ServiceError("Android transfer helper manifest, architecture, API level or checksum validation failed.", 400, { code: "transfer_helper_invalid" }); }
}
export interface AndroidUploadPipe extends ByteWriter {
  readLine(maximum: number, timeoutMs: number): Awaitable<Uint8Array>;
  closeInput(): Awaitable<void>;
  /** Must confirm zero exit and no trailing stdout. */
  completed(): Awaitable<boolean>;
  /** Supervise the same process; never claim guest reclamation from process exit alone. */
  close(): Awaitable<void>;
}
export interface AndroidUploadProvider {
  /** Verify assignment/lease AND native device ownership immediately before each commit/ack. */
  owned(): Awaitable<void>;
  /** Deploy checksum-pinned helper into a fresh private guest directory, verify installed digest,
   * launch exact-device non-PTY pipe; no host-selected consumer paths or shell interpolation. */
  open(helper: { data: Buffer; sha256: string }, path: string, size: number, id: string, guard: TransferGuard): Awaitable<AndroidUploadPipe>;
  /** Remove only known helper inode and nonrecursively remove owned directory while authorized. */
  cleanup(id: string, guard: TransferGuard): Awaitable<void>;
}
/** Native Android execution is unsupported until an owner binds the above provider.
 * An exact COMMITTED receipt plus zero exit is necessary; fixture success is not native acceptance. */
export async function androidUpload(provider: AndroidUploadProvider | undefined, helper: { data: Buffer; sha256: string }, path: string,
  reader: ByteReader, size: number, guard: TransferGuard): Promise<{ uploaded: number; durable: true }> {
  transferSize(size); guestPath(path, "absolute"); check(guard);
  if (!provider) throw new ServiceError("Durable Android upload is unsupported without a configured native provider.", 409, { code: "capability_unsupported", retryable: false });
  const snapshot = { data: Buffer.from(helper.data), sha256: helper.sha256 };
  if (snapshot.data.length < 64 || snapshot.data.length > MAX_HELPER_BYTES || createHash("sha256").update(snapshot.data).digest("hex") !== snapshot.sha256) throw new ServiceError("Android helper snapshot identity changed.", 400, { code: "transfer_helper_invalid" });
  const id = randomUUID();
  let pipe: AndroidUploadPipe | undefined, commitAttempted = false;
  const owned = () => guarded(guard, () => provider.owned());
  try {
    await owned(); await guarded(guard, async () => { pipe = await provider.open(snapshot, path, size, id, guard); });
    if (!pipe) throw new ServiceError("Android upload pipe was not confirmed.", 409);
    await copyUpload(reader, pipe, size, guard, WIRE_CHUNK);
    const staged = await guarded(guard, () => pipe!.readLine(129, 30_000));
    if (!(staged instanceof Uint8Array) || staged.length > 128 || !Buffer.from(staged).equals(Buffer.from(`CANAVERAL_TRANSFER_V1 STAGED ${id} ${size}\n`))) throw new ServiceError("Android staged upload receipt did not match.", 409);
    await owned(); check(guard); commitAttempted = true;
    await writeAll(pipe, Buffer.from(`COMMIT ${id}\n`), guard); await guarded(guard, () => pipe!.closeInput());
    const committed = await guarded(guard, () => pipe!.readLine(129, 30_000));
    if (!(committed instanceof Uint8Array) || committed.length > 128 || !Buffer.from(committed).equals(Buffer.from(`CANAVERAL_TRANSFER_V1 COMMITTED ${id} ${size}\n`)) || await guarded(guard, () => pipe!.completed()) !== true) throw new ServiceError("Android committed upload receipt or completion was not confirmed.", 409);
    await owned();
  } catch (error) { if (commitAttempted) throw uncertain("upload", error); throw error; }
  finally {
    if (pipe) { try { await pipe.close(); } catch { /* Native cleanup is unconfirmed, never proof of rollback. */ } }
    if (!guard.signal?.aborted && guard.authorized()) {
      try { await owned(); await guarded(guard, () => provider.cleanup(id, guard)); } catch { /* Nonrecursive helper cleanup is separate from file durability. */ }
    }
  }
  try { await owned(); } catch (error) { throw uncertain("upload", error); }
  return { uploaded: size, durable: true };
}
