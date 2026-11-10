import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, closeSync, constants, fstatSync, fsyncSync, ftruncateSync, linkSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, realpathSync, renameSync, rmdirSync, unlinkSync, writeSync } from "node:fs";
import type { BigIntStats } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { CapacityLedger } from "../capacity.ts";
import { identifier } from "../consumers.ts";
import type { Resources } from "../consumers.ts";
import { object, ServiceError } from "../errors.ts";
import { updateDraining } from "../updates/drain.ts";
import type { SqliteStore } from "../sqlite.ts";
import { owns, requireAdmin, requireScope } from "./contracts.ts";
import type { ControlModule, ControlOptions, ControlRequest } from "./contracts.ts";
import { legacyDigest, legacyJson, normalizeTemplate, source as imageSource } from "./templates.ts";

type Json = Record<string, unknown>;
const GiB = 1_073_741_824, chunkSize = 1_048_576;
const shaPattern = /^[a-f0-9]{64}$/;
function same(a: unknown, b: unknown): boolean { return canonical(a) === canonical(b); }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical((value as Json)[k])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
function fields(value: Json, allowed: readonly string[], required: readonly string[] = allowed): void {
  if (Object.keys(value).some(k => !allowed.includes(k)) || required.some(k => !Object.hasOwn(value, k))) throw new ServiceError("Invalid image fields.", 400);
}
function text(value: unknown, label: string, max = 100): string {
  if (typeof value !== "string" || !value.trim() || Array.from(value).length > max) throw new ServiceError(`Invalid ${label}.`, 400);
  return value;
}
function bytes(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 512) throw new ServiceError("Invalid image content length.", 400);
  return value;
}
function resources(value: unknown): Resources {
  const r = object(value), result = {} as Resources;
  for (const k of ["cpu", "memoryMiB", "diskGiB"] as const) {
    if (typeof r[k] !== "number" || !Number.isSafeInteger(r[k]) || r[k] < 1 || r[k] > 1_048_576) throw new ServiceError(`Invalid ${k}.`, 400);
    result[k] = r[k];
  }
  return result;
}
export interface ImageSpec extends Json {
  id: string; name: string; os: "linux" | "windows" | "macos"; arch: "arm64" | "amd64";
  mode: "desktop" | "headless"; mediaType: "disk" | "installer"; format: string; minimum: Resources; guestAccess?: true;
}
export interface ImageMetadata extends ImageSpec { sha256: string; bytes: number; kind: "base" | "derived"; revision: "1" }
export function specification(value: unknown): ImageSpec {
  const v = object(value);
  fields(v, ["id", "name", "os", "arch", "mode", "mediaType", "format", "minimum", "guestAccess"], ["id", "name", "os", "arch", "mediaType", "format", "minimum"]);
  const mode = v.mode ?? "desktop";
  if (!["linux", "windows", "macos"].includes(String(v.os)) || !["arm64", "amd64"].includes(String(v.arch)) || !["desktop", "headless"].includes(String(mode))) throw new ServiceError("Choose a supported VM operating system, architecture and mode.", 400);
  const formats: Record<string, string[]> = { installer: ["iso", "ipsw"], disk: ["raw", "qcow2", "vhdx"] };
  if (!formats[String(v.mediaType)]?.includes(String(v.format))) throw new ServiceError("Installer media and installed boot disks require distinct formats.", 400);
  if (v.guestAccess != null && typeof v.guestAccess !== "boolean") throw new ServiceError("Invalid guest access flag.", 400);
  if (v.guestAccess && (v.os !== "linux" || v.mediaType !== "disk")) throw new ServiceError("Automatic guest access requires an installed Linux disk.", 400);
  return { id: identifier(v.id), name: text(v.name, "image name"), os: v.os as ImageSpec["os"], arch: v.arch as ImageSpec["arch"], mode: mode as ImageSpec["mode"], mediaType: v.mediaType as ImageSpec["mediaType"], format: String(v.format), minimum: resources(v.minimum), ...(v.guestAccess ? { guestAccess: true as const } : {}) };
}

export interface RegistryEntry extends Json {
  id: string; name: string; publisher: string; os: ImageSpec["os"]; arch: ImageSpec["arch"];
  mode: "desktop"; mediaType: ImageSpec["mediaType"]; format: string; sourcePage: string;
  resolver: string | null; status: string; minimum: Resources; note: string;
}
export function catalogue(): RegistryEntry[] {
  const entries: RegistryEntry[] = [];
  function add(id: string, name: string, publisher: string, os: RegistryEntry["os"], arch: RegistryEntry["arch"], mediaType: RegistryEntry["mediaType"], format: string, sourcePage: string, resolver: string | null, note: string, extra: Json = {}): void {
    entries.push({ id, name, publisher, os, arch, mode: "desktop", mediaType, format, sourcePage, resolver, status: resolver ? "available" : "manual", minimum: { cpu: 2, memoryMiB: 4096, diskGiB: os === "linux" ? 32 : 64 }, note, ...extra });
  }
  add("macos-supported", "macOS · latest supported restore", "Apple", "macos", "arm64", "installer", "ipsw", "https://developer.apple.com/documentation/virtualization/installing-macos-on-a-virtual-machine", "apple", "Resolved by Apple on the selected Apple silicon Mac. Installation and guest access have separate runtime requirements.");
  for (const arch of ["amd64", "arm64"] as const) {
    for (const release of ["24.04", "26.04"]) for (const flavor of ["desktop", "server"]) add(`ubuntu-${release}-${flavor}-${arch}`, `Ubuntu ${release} LTS · ${flavor}`, "Canonical", "linux", arch, "installer", "iso", `https://releases.ubuntu.com/${release}/`, "ubuntu-iso", "Installation media requires an installer console; guest services start after installation.", { release, flavor });
    add(`ubuntu-noble-cloud-${arch}`, "Ubuntu 24.04 LTS · cloud disk", "Canonical", "linux", arch, "disk", "qcow2", "https://cloud-images.ubuntu.com/noble/current/", "ubuntu-cloud", "Installed cloud disk; Linux guest services require configured preparation.");
    add(`debian-stable-netinst-${arch}`, "Debian stable · network installer", "Debian", "linux", arch, "installer", "iso", "https://www.debian.org/CD/netinst/", "debian", "Small installer; downloads packages during installation.");
    add(`fedora-workstation-${arch}`, "Fedora Workstation · stable", "Fedora Project", "linux", arch, "installer", "iso", "https://fedoraproject.org/workstation/download/", "fedora", "Latest stable Workstation ISO; prereleases are excluded.");
    add(`windows-11-iso-${arch}`, "Windows 11 · installation ISO", "Microsoft", "windows", arch, "installer", "iso", `https://www.microsoft.com/en-us/software-download/windows11${arch === "arm64" ? "arm64" : ""}`, null, "Choose edition and language on Microsoft’s site, then import the downloaded ISO. Activation and runtime support are separate.");
    add(`windows-11-evaluation-${arch}`, "Windows 11 Enterprise · evaluation", "Microsoft", "windows", arch, "installer", "iso", "https://www.microsoft.com/en-us/evalcenter/evaluate-windows-11-enterprise", null, "Microsoft registration is required; download from Microsoft, then import.");
  }
  add("windows-development-vm", "Windows development VM", "Microsoft", "windows", "amd64", "disk", "vhdx", "https://developer.microsoft.com/en-us/windows/downloads/virtual-machines/", null, "The former prebuilt VM page redirects to developer tools. Import a licensed disk or official installation media.", { status: "unavailable" });
  return entries;
}
export function registryEntry(id: unknown): RegistryEntry {
  const result = catalogue().find(e => e.id === id);
  if (!result) throw new ServiceError("Unknown base image registry entry.", 404);
  return result;
}
const publisherHosts = new Set(["releases.ubuntu.com", "cdimage.ubuntu.com", "cloud-images.ubuntu.com", "cdimage.debian.org", "chuangtzu.ftp.acc.umu.se", "fedoraproject.org", "dl.fedoraproject.org", "download.fedoraproject.org"]);
export function allowedUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const u = new URL(value);
    return u.protocol === "https:" && !u.username && !u.password && !u.hash && (!u.port || u.port === "443") && (publisherHosts.has(u.hostname) || u.hostname === "cdn-apple.com" || u.hostname.endsWith(".cdn-apple.com"));
  } catch { return false; }
}
export interface RegistrySource { url: string; sha256: string | null; bytes: number; version: string }
export function validateEntrySource(item: RegistryEntry, value: unknown): RegistrySource {
  const s = object(value); fields(s, ["url", "sha256", "bytes", "version"]);
  if (!allowedUrl(s.url) || (s.sha256 !== null && (typeof s.sha256 !== "string" || !shaPattern.test(s.sha256)))) throw new ServiceError("Invalid resolved registry source or publisher checksum.", 400);
  const u = new URL(s.url), origins: Record<string, string[]> = { "ubuntu-iso": ["releases.ubuntu.com", "cdimage.ubuntu.com"], "ubuntu-cloud": ["cloud-images.ubuntu.com"], debian: ["cdimage.debian.org"], fedora: ["dl.fedoraproject.org"] };
  if (item.resolver === "apple") {
    if (!u.hostname.endsWith(".cdn-apple.com") || !u.pathname.toLowerCase().endsWith(".ipsw")) throw new ServiceError("macOS source must be an Apple restore archive.", 400);
  } else if (!origins[item.resolver ?? ""]?.includes(u.hostname) || !s.sha256) throw new ServiceError("Registry source must match its publisher and include a checksum.", 400);
  return { url: s.url, sha256: s.sha256 as string | null, bytes: bytes(s.bytes), version: text(s.version, "registry source version", 200) };
}
export function validateImage(value: unknown): ImageMetadata {
  const v = object(value);
  fields(v, ["id", "name", "os", "arch", "mode", "mediaType", "format", "minimum", "guestAccess", "sha256", "bytes", "kind", "revision", "sourceMachineId", "baseImageId", "identityPolicy", "registry", "consistency"], ["id", "name", "os", "arch", "mode", "mediaType", "format", "minimum", "sha256", "bytes", "kind", "revision"]);
  const spec: Json = {}; for (const k of ["id", "name", "os", "arch", "mode", "mediaType", "format", "minimum", "guestAccess"]) if (Object.hasOwn(v, k)) spec[k] = v[k];
  specification(spec); bytes(v.bytes);
  if (typeof v.sha256 !== "string" || !shaPattern.test(v.sha256) || !["base", "derived"].includes(String(v.kind)) || v.revision !== "1") throw new ServiceError("Invalid image artifact identity or provenance.", 400);
  if (v.kind === "derived") identifier(v.sourceMachineId);
  else if (v.sourceMachineId != null) throw new ServiceError("Base images cannot claim capture provenance.", 400);
  if (v.baseImageId != null) identifier(v.baseImageId);
  if (![undefined, null, "fresh-broker-credentials", "linux-cloud-init", "preserve-configured-os-state"].includes(v.identityPolicy as string | undefined | null) || ![undefined, null, "stopped-disk", "guest-shutdown", "crash-consistent"].includes(v.consistency as string | undefined | null)) throw new ServiceError("Unsupported image identity policy or consistency.", 400);
  if (v.registry !== undefined) {
    const p = object(v.registry); fields(p, ["id", "version", "url", "publisherSha256"]);
    validateEntrySource(registryEntry(p.id), { url: p.url, version: p.version, sha256: p.publisherSha256, bytes: v.bytes });
    if (p.publisherSha256 && p.publisherSha256 !== v.sha256) throw new ServiceError("Image failed its publisher checksum.", 400);
  }
  return structuredClone(v) as ImageMetadata;
}

interface TaskRow { id: string; host: string; machine: string | null; request: string; state: string; result: string | null; created: number; updated: number; reserved_disk: number }
function taskView(row: TaskRow): Json {
  const r = object(JSON.parse(row.request));
  return { id: row.id, hostId: row.host, machineId: row.machine, state: row.state, kind: r.kind, name: r.name ?? object(r.metadata ?? {}).name ?? "Image", updatedAt: row.updated, result: row.result ? JSON.parse(row.result) : null };
}
function taskRow(db: DatabaseSync, id: unknown): TaskRow | undefined { return db.prepare("SELECT * FROM image_tasks WHERE id=?").get(identifier(id)) as unknown as TaskRow | undefined; }
function inTransaction(db: DatabaseSync): void { if (!db.isTransaction) throw new TypeError("Image helpers require the host transaction."); }
function registerImage(db: DatabaseSync, host: string, value: unknown): void {
  const v = validateImage(value), old = db.prepare("SELECT * FROM images WHERE id=?").get(v.id);
  if (old && (old.host !== host || !same(JSON.parse(String(old.metadata)), v))) throw new ServiceError("Image identity already has another owner or immutable artifact.");
  if (!old) db.prepare("INSERT INTO images VALUES (?,?,?)").run(v.id, host, JSON.stringify(v));
}
function validateImportResult(row: TaskRow, result: Json): void {
  const r = object(JSON.parse(row.request)), metadata = object(r.metadata);
  if (result.id !== row.id || result.bytes !== r.bytes || result.kind !== "base" || Object.entries(metadata).some(([k, v]) => !same(result[k], v))) throw new ServiceError("Imported artifact or metadata differs from its reservation.");
  if (r.kind === "registry") {
    const source = object(r.source);
    if (source.sha256 && result.sha256 !== source.sha256) throw new ServiceError("Registry checksum differs from the pinned publisher identity.");
    if (!same(result.registry, { id: r.registryId, version: source.version, url: source.url, publisherSha256: source.sha256 })) throw new ServiceError("Registry provenance differs from the resolved task.");
  }
}
/** Call inside the authenticated heartbeat transaction; no helper authenticates a raw report. */
export function reportImageTasks(db: DatabaseSync, hostId: string, value: unknown, now: number): void {
  inTransaction(db); const reports = object(value);
  if (Object.keys(reports).length > 1) throw new ServiceError("Report at most one image task per heartbeat.", 400);
  for (const [id, value] of Object.entries(reports)) {
    const row = taskRow(db, id), report = object(value);
    if (!row || row.host !== hostId) throw new ServiceError("Cannot report another host image task.", 403);
    if (!["running", "succeeded", "failed", "unknown"].includes(String(report.state))) throw new ServiceError("Invalid image build report.", 400);
    if (["succeeded", "failed", "unknown"].includes(row.state)) continue;
    const result = object(report.result ?? {});
    if (Buffer.byteLength(JSON.stringify(result)) > 20_000) throw new ServiceError("Image build metadata is too large.", 400);
    if (report.state === "succeeded") {
      if (result.id !== row.id || (result.sourceMachineId ?? null) !== row.machine) throw new ServiceError("Capture provenance does not match its task.");
      const request = object(JSON.parse(row.request));
      if (["import", "registry"].includes(String(request.kind))) validateImportResult(row, result);
      else if (result.kind !== "derived" || result.name !== request.name) throw new ServiceError("Capture must publish its requested derived image.");
      if (bytes(result.bytes) > row.reserved_disk * GiB) throw new ServiceError("Image exceeds its storage reservation.");
      registerImage(db, hostId, result);
    }
    db.prepare("UPDATE image_tasks SET state=?,result=?,updated=? WHERE id=?").run(String(report.state), JSON.stringify(result), now, row.id);
  }
}
export function assignedImageTasks(db: DatabaseSync, hostId: string, machineAssignment?: (row: Json) => unknown): Json[] {
  inTransaction(db);
  return (db.prepare("SELECT * FROM image_tasks WHERE host=? AND state IN ('queued','running') ORDER BY rowid LIMIT 8").all(hostId) as unknown as TaskRow[]).map(row => {
    const request = object(JSON.parse(row.request));
    if (request.kind !== "capture") return { id: row.id, ...request };
    const machine = db.prepare("SELECT * FROM machines WHERE id=? AND host=?").get(row.machine, hostId);
    if (!machine || !machineAssignment) throw new ServiceError("Capture assignment requires the host machine serializer.", 503);
    return { id: row.id, ...request, machine: machineAssignment(machine) };
  });
}
export function acknowledgedImages(db: DatabaseSync, hostId: string): Record<string, string> {
  inTransaction(db);
  return Object.fromEntries(db.prepare("SELECT id,metadata FROM images WHERE host=?").all(hostId).map(row => [String(row.id), String(object(JSON.parse(String(row.metadata))).sha256)]));
}
export function validateCatalogueOffer(db: DatabaseSync, hostId: string, proposed: unknown): void {
  inTransaction(db); const offer = object(proposed);
  if (!Array.isArray(offer.templates)) throw new ServiceError("Invalid host catalogue.", 400);
  for (const value of offer.templates) {
    const definition = object(value); if (definition.catalogueImageId == null) continue;
    const row = db.prepare("SELECT * FROM images WHERE id=? AND host=?").get(identifier(definition.catalogueImageId), hostId);
    if (!row) throw new ServiceError("Catalogue artifact has not been registered to this host.");
    const v = object(JSON.parse(String(row.metadata)));
    if (definition.artifactSha256 !== v.sha256 || ["id", "name", "os", "arch", "mode", "mediaType", "minimum"].some(k => !same(v[k], definition[k]))) throw new ServiceError("Offered image differs from its registered artifact.");
  }
}
export function assertNoPendingCapture(db: DatabaseSync, machineId: string): void {
  inTransaction(db);
  if (db.prepare("SELECT 1 FROM image_tasks WHERE machine=? AND state IN ('queued','running','unknown')").get(machineId)) throw new ServiceError("Resolve the pending image capture before restarting this machine.");
}

export class ImagesController {
  readonly ledger: CapacityLedger;
  constructor(readonly store: SqliteStore, readonly leaseSeconds = 30) {
    store.transaction(db => db.exec("CREATE TABLE IF NOT EXISTS images (id TEXT PRIMARY KEY, host TEXT NOT NULL, metadata TEXT NOT NULL); CREATE TABLE IF NOT EXISTS image_tasks (id TEXT PRIMARY KEY, host TEXT NOT NULL, machine TEXT, request TEXT NOT NULL, state TEXT NOT NULL, result TEXT, created REAL NOT NULL, updated REAL NOT NULL, reserved_disk INTEGER NOT NULL)"));
    this.ledger = new CapacityLedger(store);
  }
  private online(db: DatabaseSync, hostId: string): Json {
    const host = db.prepare("SELECT * FROM hosts WHERE id=? AND id NOT IN (SELECT id FROM retired_runners)").get(hostId);
    if (!host || this.store.clock() - Number(host.seen) >= this.leaseSeconds) throw new ServiceError("Image host must be online.");
    return host;
  }
  reserveImageImport(hostId: string, value: unknown, size: number): Json {
    hostId = identifier(hostId); const metadata = specification(value), request = { kind: "import", metadata, bytes: bytes(size) };
    return this.store.transaction(db => {
      const old = taskRow(db, metadata.id);
      if (old) {
        if (old.host !== hostId || !same(JSON.parse(old.request), request)) throw new ServiceError("Image task ID belongs to another specification.");
        if (old.state === "failed") throw new ServiceError("This import failed. Create a new import ID after inspecting its result.");
        return taskView(old);
      }
      this.online(db, hostId); const disk = Math.ceil(size / GiB);
      if (disk > this.ledger.remaining(db, hostId).diskGiB) throw new ServiceError("Image exceeds available host storage.");
      db.prepare("INSERT INTO image_tasks VALUES (?,?,NULL,?,'running',NULL,?,?,?)").run(metadata.id, hostId, JSON.stringify(request), this.store.clock(), this.store.clock(), disk);
      return taskView(taskRow(db, metadata.id)!);
    });
  }
  finishImageImport(taskId: string, hostId: string, result?: unknown, failed = false): Json {
    return this.store.transaction(db => {
      const row = taskRow(db, taskId);
      if (!row || row.host !== hostId || object(JSON.parse(row.request)).kind !== "import") throw new ServiceError("Image import ownership mismatch.", 403);
      if (["succeeded", "failed", "unknown"].includes(row.state)) return taskView(row);
      reportImageTasks(db, hostId, { [row.id]: { state: failed ? "failed" : "succeeded", result: result ?? {} } }, this.store.clock());
      return taskView(taskRow(db, taskId)!);
    });
  }
  createCapture(value: unknown, request?: ControlRequest, adminOnly = false): Json {
    const v = object(value); fields(v, ["id", "machineId", "name"]);
    const id = identifier(v.id), machineId = identifier(v.machineId), intent = { kind: "capture", machineId, name: text(v.name, "image name") };
    return this.store.transaction(db => {
      const principal = request ? (adminOnly ? requireAdmin(request) : requireScope(request, "write")) : undefined;
      const old = taskRow(db, id);
      // Check the old receipt's owner before checking a replacement target.
      for (const mid of new Set([old?.machine, machineId])) {
        if (!mid) continue;
        const owner = db.prepare("SELECT owner FROM machines WHERE id=?").get(mid);
        if (!owner || (principal && !owns(principal, owner.owner))) throw new ServiceError("Unknown machine.", 404);
      }
      if (old) { if (!same(JSON.parse(old.request), intent)) throw new ServiceError("Capture ID belongs to another specification."); return taskView(old); }
      const machine = db.prepare("SELECT * FROM machines WHERE id=?").get(machineId)!;
      if (updateDraining(db, String(machine.host))) throw new ServiceError("Host is draining for a runtime update.", 409);
      this.online(db, String(machine.host));
      if (db.prepare("SELECT 1 FROM machine_deletions WHERE machine=?").get(machineId)) throw new ServiceError("A source with a deletion intent cannot be captured.");
      if (db.prepare("SELECT 1 FROM machine_power_offs WHERE machine=? AND state!='succeeded'").get(machineId)) throw new ServiceError("Resolve the source power-off intent before capture.");
      if (machine.desired !== "stopped" || machine.observed !== "stopped") throw new ServiceError("Stop the machine and wait for its online host to confirm shutdown before capture.");
      const template = object(JSON.parse(String(machine.template))), effective = object(JSON.parse(String(machine.request)));
      if (["android", "ios"].includes(String(template.os))) throw new ServiceError("Simulator image capture is unsupported.");
      if (template.guestAccess && !machine.prepared_at) throw new ServiceError("Finish guest-access preparation before capture.");
      assertNoPendingCapture(db, machineId);
      const disk = resources(effective.resources).diskGiB + 1;
      if (disk > this.ledger.remaining(db, String(machine.host)).diskGiB) throw new ServiceError("Capture exceeds available host storage.");
      db.prepare("INSERT INTO image_tasks VALUES (?,?,?,?,'queued',NULL,?,?,?)").run(id, String(machine.host), machineId, JSON.stringify(intent), this.store.clock(), this.store.clock(), disk);
      return taskView(taskRow(db, id)!);
    });
  }
  createRegistryImport(value: unknown, request?: ControlRequest): Json {
    const v = object(value); fields(v, ["id", "registryId", "hostId", "name", "guestAccess"], ["id", "registryId", "hostId"]);
    const id = identifier(v.id), hostId = identifier(v.hostId), entry = registryEntry(v.registryId);
    if (!entry.resolver) throw new ServiceError(entry.note);
    if (v.guestAccess !== undefined && typeof v.guestAccess !== "boolean") throw new ServiceError("Invalid guest access option.", 400);
    const metadata = specification({ id, name: v.name ?? entry.name, os: entry.os, arch: entry.arch, mode: entry.mode, mediaType: entry.mediaType, format: entry.format, minimum: entry.minimum, ...(v.guestAccess === undefined ? {} : { guestAccess: v.guestAccess }) });
    const intent = { kind: "registry", registryId: entry.id, metadata };
    return this.store.transaction(db => {
      if (request) requireAdmin(request);
      const old = taskRow(db, id);
      if (old) {
        const previous = object(JSON.parse(old.request)); delete previous.source; delete previous.bytes;
        if (old.host !== hostId || !same(previous, intent)) throw new ServiceError("Image task ID belongs to another request.");
        return taskView(old);
      }
      const offer = object(JSON.parse(String(this.online(db, hostId).offer)));
      if (offer.provider === "kubevirt") throw new ServiceError("Registry imports require a direct host.");
      if (entry.os === "macos" && !["macos", "apple"].includes(String(offer.provider))) throw new ServiceError("macOS restore images require a Mac host.");
      db.prepare("INSERT INTO image_tasks VALUES (?,?,NULL,?,'queued',NULL,?,?,0)").run(id, hostId, JSON.stringify(intent), this.store.clock(), this.store.clock());
      return taskView(taskRow(db, id)!);
    });
  }
  resolveRegistryImport(hostId: string, credential: string, id: string, value: unknown): Json {
    hostId = identifier(hostId);
    return this.store.transaction(db => {
      const host = db.prepare("SELECT credential FROM hosts WHERE id=? AND id NOT IN (SELECT id FROM retired_runners)").get(hostId);
      // Python stores SHA256(json.dumps(token)), including the JSON string quotes.
      const expected = host ? String(host.credential) : "", digest = legacyDigest(credential);
      if (!expected || expected.length !== digest.length || !timingSafeEqual(Buffer.from(expected), Buffer.from(digest))) throw new ServiceError("Host credential rejected.", 401);
      const row = taskRow(db, id);
      if (!row || row.host !== hostId) throw new ServiceError("Unknown owned image task.", 404);
      const request = object(JSON.parse(row.request));
      if (request.kind !== "registry" || !["queued", "running"].includes(row.state)) throw new ServiceError("Registry task is not awaiting a source.");
      const source = validateEntrySource(registryEntry(request.registryId), value);
      if (request.source) { if (!same(request.source, source)) throw new ServiceError("Registry source was already pinned to another artifact."); }
      else {
        const cost = Math.ceil(source.bytes / GiB);
        if (cost > this.ledger.remaining(db, hostId).diskGiB) throw new ServiceError("Registry image exceeds available host storage.");
        request.source = source; request.bytes = source.bytes;
        db.prepare("UPDATE image_tasks SET request=?,reserved_disk=?,state='running',updated=? WHERE id=?").run(JSON.stringify(request), cost, this.store.clock(), row.id);
      }
      return { id: row.id, ...request };
    });
  }
}

export function createModule(store: SqliteStore, _options: ControlOptions): ControlModule {
  const controller = new ImagesController(store);
  return { handle(req) {
    const parts = req.parts[0] === "v1" ? req.parts.slice(1) : req.parts;
    if (req.method === "POST" && parts.length === 5 && parts[0] === "hosts" && parts[2] === "image-tasks" && parts[4] === "resolve") return { body: controller.resolveRegistryImport(parts[1]!, req.token, parts[3]!, req.body) };
    if (req.method === "POST" && parts.join("/") === "images/captures") {
      requireAdmin(req); return { body: controller.createCapture(req.body, req, true) };
    }
    if (req.method === "POST" && parts.join("/") === "image-registry/imports") {
      requireAdmin(req); return { body: controller.createRegistryImport(req.body, req) };
    }
    if (req.method !== "GET" || !((parts.length === 1 && ["images", "image-tasks", "image-registry"].includes(parts[0]!)) || (parts.length === 2 && parts[0] === "image-tasks"))) return undefined;
    return store.transaction(db => {
      requireAdmin(req);
      if (parts[0] === "image-registry") return { body: { entries: catalogue() } };
      if (parts[0] === "images") return { body: { images: db.prepare("SELECT * FROM images ORDER BY rowid DESC").all().map(row => ({ hostId: row.host, ...validateImage(JSON.parse(String(row.metadata))) })) } };
      if (parts.length === 1) return { body: { tasks: (db.prepare("SELECT * FROM image_tasks ORDER BY rowid DESC LIMIT 100").all() as unknown as TaskRow[]).map(taskView) } };
      const row = taskRow(db, parts[1]); if (!row) throw new ServiceError("Unknown image task.", 404);
      return { body: taskView(row) };
    });
  } };
}

function signature(info: BigIntStats): string { return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(":"); }
const readFlags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
function pinnedFile(path: string): { fd: number; size: number; unchanged(): void } {
  const before = lstatSync(path, { bigint: true });
  if (!before.isFile()) throw new ServiceError("Image artifact must be a regular file without symbolic links.");
  const fd = openSync(path, readFlags);
  const unchanged = (): void => {
    if (signature(before) !== signature(fstatSync(fd, { bigint: true })) || signature(before) !== signature(lstatSync(path, { bigint: true }))) throw new ServiceError("Image artifact changed during verification or capture.");
  };
  try {
    unchanged();
    const size = Number(before.size);
    if (!Number.isSafeInteger(size)) throw new ServiceError("Image artifact length cannot be safely represented.");
    return { fd, size, unchanged };
  } catch (error) { closeSync(fd); throw error; }
}
/** Hash only the initial logical size, holding one descriptor and checking ctime too. */
export function checksum(path: string): string {
  const pin = pinnedFile(path);
  try {
    const hash = createHash("sha256"), buffer = Buffer.alloc(chunkSize);
    let offset = 0;
    while (offset < pin.size) {
      const count = readSync(pin.fd, buffer, 0, Math.min(chunkSize, pin.size - offset), offset);
      if (!count) throw new ServiceError("Image artifact ended during checksum verification.");
      hash.update(buffer.subarray(0, count)); offset += count;
    }
    pin.unchanged(); return hash.digest("hex");
  } finally { closeSync(pin.fd); }
}
export interface ImageReader { read(count: number): Uint8Array | Promise<Uint8Array> }
export interface LibraryRecord { public: ImageMetadata; definition: Json; registered: boolean }
export interface ImportOptions {
  prepare?: Json; memoryStep?: number; defer?: boolean; expectedSha256?: string | null; registry?: Json;
}
export interface CaptureTask { id: string; machineId: string; name: string; machine: Json }
export interface ImageReport { state: "running" | "succeeded" | "failed" | "unknown"; result: Json }
/** The provider must hold its own runtime lock and positively prove assignment ownership,
 * latest-launch stopped status and disk fencing before invoking consume. Resolving this
 * promise means the fence was released successfully; a disconnected guest is no proof.
 */
export interface CaptureProvider {
  withCaptureSource<T>(machine: Json, image: Json, folder: string | undefined, consume: (source: string, format: string) => Promise<T>): Promise<T>;
  captureConsistency?(machine: Json, image: Json, folder: string | undefined): string;
}

/** Portable artifact I/O only. Native capture and guest preparation are injected. */
export class ImageLibrary {
  readonly root: string;
  private readonly state: string;
  private readonly stateIdentity: string;
  private readonly rootIdentity: string;
  private readonly verified = new Map<string, string>();
  constructor(state: string) {
    mkdirSync(state, { recursive: true, mode: 0o700 });
    const info = lstatSync(state, { bigint: true });
    if (!info.isDirectory() || (process.getuid && info.uid !== BigInt(process.getuid()))) throw new ServiceError("Image state must be an owned directory without symbolic links.");
    this.state = realpathSync(state); this.stateIdentity = `${info.dev}:${info.ino}`;
    this.root = join(this.state, "image-library"); mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const root = lstatSync(this.root, { bigint: true });
    if (!root.isDirectory() || (process.getuid && root.uid !== BigInt(process.getuid()))) throw new ServiceError("Image library must be a private owned directory without symbolic links.");
    chmodSync(this.root, 0o700); this.rootIdentity = `${root.dev}:${root.ino}`;
  }
  private guard(): void {
    for (const [path, expected] of [[this.state, this.stateIdentity], [this.root, this.rootIdentity]]) {
      const info = lstatSync(path!, { bigint: true });
      if (!info.isDirectory() || `${info.dev}:${info.ino}` !== expected || realpathSync(path!) !== path) throw new ServiceError("Image library directory ownership changed.");
      if (path === this.root && process.platform !== "win32" && (info.mode & 0o077n) !== 0n) throw new ServiceError("Image library must remain private.");
    }
  }
  private path(id: string, suffix: string): string { this.guard(); return join(this.root, identifier(id) + suffix); }
  private present(path: string): boolean {
    this.guard(); try { lstatSync(path); return true; } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return false; throw e; }
  }
  private json(path: string): Json {
    this.guard(); const pin = pinnedFile(path);
    try {
      if (pin.size > 2_097_152) throw new ServiceError("Private image metadata exceeds its bounded envelope.");
      const buffer = Buffer.alloc(pin.size); let read = 0;
      while (read < buffer.length) { const count = readSync(pin.fd, buffer, read, buffer.length - read, read); if (!count) throw new ServiceError("Private image metadata was truncated."); read += count; }
      pin.unchanged(); this.guard(); return object(JSON.parse(buffer.toString("utf8")));
    } finally { closeSync(pin.fd); }
  }
  private syncDirectory(): void {
    this.guard(); if (process.platform === "win32") return;
    const fd = openSync(this.root, constants.O_RDONLY | constants.O_DIRECTORY | (constants.O_NOFOLLOW ?? 0));
    try { fsyncSync(fd); } finally { closeSync(fd); }
  }
  private save(path: string, value: unknown, replace = true): void {
    this.guard();
    if (this.present(path) && !lstatSync(path).isFile()) throw new ServiceError("Private image metadata cannot follow links or adopt another file type.");
    const temp = join(this.root, `${randomUUID()}.metadata.partial`), fd = openSync(temp, "wx", 0o600);
    try {
      const buffer = Buffer.from(JSON.stringify(value)); let written = 0;
      while (written < buffer.length) written += writeSync(fd, buffer, written, buffer.length - written);
      fsyncSync(fd); closeSync(fd); this.guard();
      if (replace) renameSync(temp, path); else linkSync(temp, path);
      this.syncDirectory();
    } finally {
      try { closeSync(fd); } catch { /* Already closed before publication. */ }
      if (this.present(temp)) unlinkSync(temp);
    }
  }
  private lock(id: string, kind: string): () => void {
    const path = this.path(id, `.${kind}.lock`);
    try { mkdirSync(path, { mode: 0o700 }); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new ServiceError("Image operation is locked; inspect its durable receipt before recovery.", 409, { outcome: "unknown" }); throw e; }
    // Empty lock directories are removed only by the process that created them.
    return () => { this.guard(); rmdirSync(path); };
  }
  records(): LibraryRecord[] {
    this.guard();
    return readdirSync(this.root).filter(p => /^[a-f0-9-]{36}\.json$/.test(p)).sort().map(p => {
      const r = this.json(join(this.root, p)), publicImage = validateImage(r.public), definition = object(r.definition);
      if (p !== `${publicImage.id}.json`) throw new ServiceError("Image manifest identity differs from its filename.");
      this.checkBinding(publicImage, definition);
      return { public: publicImage, definition, registered: r.registered === true };
    });
  }
  private checkBinding(publicImage: ImageMetadata, definition: Json): void {
    const artifact = join(this.root, `${publicImage.sha256}.${publicImage.format}`), source = object(definition.source);
    if (definition.id !== publicImage.id || definition.catalogueImageId !== publicImage.id || definition.image !== artifact || definition.artifactSha256 !== publicImage.sha256 || source.path !== artifact || source.sha256 !== publicImage.sha256 || source.format !== publicImage.format) throw new ServiceError("Image manifest has an invalid private artifact binding.");
    for (const key of ["name", "os", "arch", "mode", "mediaType", "minimum"]) if (!same(publicImage[key], definition[key])) throw new ServiceError("Image manifest specification differs from its private definition.");
  }
  definitions(): Json[] { return this.records().filter(r => r.registered).map(r => r.definition); }
  publicRecords(): ImageMetadata[] { return this.records().map(r => r.public); }
  acknowledge(registered: Record<string, string>): void {
    for (const record of this.records()) if (!record.registered && registered[record.public.id] === record.public.sha256) this.save(this.path(record.public.id, ".json"), { ...record, registered: true });
  }
  verifyDefinition(image: Json): void {
    this.guard(); const path = String(image.image), expected = image.artifactSha256;
    if (typeof expected !== "string" || !shaPattern.test(expected) || dirname(path) !== this.root) throw new ServiceError("Image verification requires an owned pinned artifact.");
    const before = lstatSync(path, { bigint: true }); if (!before.isFile()) throw new ServiceError("Image artifact must be a regular file without symbolic links.");
    const key = `${path}:${expected}`, initial = signature(before);
    if (this.verified.get(key) === initial) return;
    if (checksum(path) !== expected || signature(lstatSync(path, { bigint: true })) !== initial) throw new ServiceError("Image artifact changed or failed checksum validation; provisioning was refused.");
    this.verified.set(key, initial);
  }
  private validateArtifact(path: string, format: string, size: number): void {
    const pin = pinnedFile(path);
    try {
      const header = Buffer.alloc(104); readSync(pin.fd, header, 0, 104, 0);
      if (format === "qcow2" && (!header.subarray(0, 4).equals(Buffer.from([81, 70, 73, 251])) || ![2, 3].includes(header.readUInt32BE(4)) || header.readBigUInt64BE(8) !== 0n)) throw new ServiceError("Import a standalone QCOW2 v2/v3 disk without a backing file.", 400);
      if (format === "vhdx" && header.toString("ascii", 0, 8) !== "vhdxfile") throw new ServiceError("Invalid VHDX header.", 400);
      if (format === "ipsw" && !header.subarray(0, 4).equals(Buffer.from([80, 75, 3, 4]))) throw new ServiceError("Invalid restore archive header.", 400);
      if (format === "iso") { const volume = Buffer.alloc(5); if (readSync(pin.fd, volume, 0, 5, 32769) !== 5 || volume.toString("ascii") !== "CD001") throw new ServiceError("ISO image volume descriptor is missing.", 400); }
      if (format === "raw" && size % 512) throw new ServiceError("Raw disk size must be a multiple of 512 bytes.", 400);
      pin.unchanged();
    } finally { closeSync(pin.fd); }
  }
  async importStream(value: unknown, reader: ImageReader, size: number, authorized: () => boolean, options: ImportOptions = {}): Promise<ImageMetadata> {
    const metadata = specification(value); bytes(size);
    const step = options.memoryStep ?? 1;
    if (!Number.isSafeInteger(step) || step < 1 || metadata.minimum.memoryMiB % step) throw new ServiceError("Image memory must match the runtime memory granularity.", 400);
    if (options.expectedSha256 != null && !shaPattern.test(options.expectedSha256)) throw new ServiceError("Invalid pinned publisher checksum.", 400);
    this.guard(); const unlock = this.lock(metadata.id, "upload"), temporary = join(this.root, `${randomUUID()}.partial`);
    let fd: number | undefined;
    try {
      fd = openSync(temporary, "wx", 0o600); const digest = createHash("sha256"); let copied = 0;
      while (copied < size) {
        this.guard(); if (!authorized()) throw new ServiceError("Image import authorization ended.", 403);
        const count = Math.min(chunkSize, size - copied), data = await reader.read(count);
        if (!(data instanceof Uint8Array) || !data.length || data.length > count) throw new ServiceError("Image upload was interrupted or exceeded its bounded length.", 400);
        if (!authorized()) throw new ServiceError("Image import authorization ended.", 403);
        digest.update(data);
        if (data.some(byte => byte !== 0)) { let written = 0; while (written < data.length) written += writeSync(fd, data, written, data.length - written, copied + written); }
        copied += data.length;
      }
      ftruncateSync(fd, size); fsyncSync(fd); closeSync(fd); fd = undefined;
      this.validateArtifact(temporary, metadata.format, size);
      const hash = digest.digest("hex");
      if (options.expectedSha256 && hash !== options.expectedSha256) throw new ServiceError("Downloaded image does not match the pinned publisher checksum.", 400);
      const publicImage: ImageMetadata = { ...metadata, sha256: hash, bytes: size, kind: "base", revision: "1", ...(options.registry ? { registry: structuredClone(options.registry) } : {}) };
      validateImage(publicImage);
      const artifact = join(this.root, `${hash}.${metadata.format}`), definition: Json = { id: metadata.id, catalogueImageId: metadata.id, imageKind: "base", artifactSha256: hash, name: metadata.name, revision: "1", os: metadata.os, arch: metadata.arch, mode: metadata.mode, mediaType: metadata.mediaType, minimum: metadata.minimum, defaults: metadata.minimum, memoryStepMiB: step, image: artifact, source: { path: artifact, sha256: hash, format: metadata.format } };
      if (metadata.guestAccess) {
        if (!options.prepare) throw new ServiceError("This host has no configured Linux guest-access preparation.");
        definition.guestAccess = true; definition.cloneIdentity = "linux-cloud-init"; definition.prepare = capturePreparation(options.prepare);
      }
      normalizeTemplate(definition);
      const record = this.path(metadata.id, options.defer ? ".staged" : ".json");
      if (options.defer && this.present(this.path(metadata.id, ".json"))) throw new ServiceError("Image ID already has a published manifest.");
      if (this.present(record)) {
        const previous = this.json(record);
        if (!same(previous.public, publicImage)) throw new ServiceError("Image identity refers to another artifact or specification.");
        this.checkBinding(validateImage(previous.public), object(previous.definition));
        return validateImage(previous.public); // An identical retry is not a new health proof.
      }
      this.guard(); if (!authorized()) throw new ServiceError("Image import authorization ended.", 403);
      let created = false;
      if (!this.present(artifact)) {
        try { linkSync(temporary, artifact); created = true; chmodSync(artifact, 0o400); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      }
      // A competing publication is verified too; never replace an existing artifact.
      if (!created && checksum(artifact) !== hash) throw new ServiceError("Existing image checksum failed; artifact preserved for inspection.");
      try { this.save(record, { public: publicImage, definition, registered: false }, false); }
      catch (error) {
        // If publication may have happened, preserve both bytes and manifest for recovery.
        if (created && !this.present(record)) unlinkSync(artifact);
        throw error;
      }
      return publicImage;
    } finally {
      if (fd !== undefined) closeSync(fd);
      if (this.present(temporary)) unlinkSync(temporary);
      unlock();
    }
  }
  async capture(task: CaptureTask, provider: CaptureProvider, image: Json, folder?: string): Promise<ImageReport> {
    const id = identifier(task.id), machineId = identifier(task.machineId), name = text(task.name, "image name");
    const receipt = this.path(id, ".capture.json.receipt"), fingerprint = legacyJson({ id, machineId, name });
    if (this.present(receipt)) {
      const previous = this.json(receipt);
      if (previous.fingerprint !== fingerprint) throw new ServiceError("Capture identity conflicts with its local receipt.");
      if (previous.report) return imageReport(previous.report);
      const published = this.path(id, ".json");
      if (this.present(published)) {
        const record = this.json(published), pub = validateImage(record.public);
        this.checkBinding(pub, object(record.definition));
        if (pub.id === id && pub.name === name && pub.sourceMachineId === machineId && pub.kind === "derived" && checksum(String(object(record.definition).image)) === pub.sha256) return { state: "succeeded", result: pub };
      }
      return { state: "unknown", result: { detail: "Interrupted capture; inspect its private receipt and artifact before recovery." } };
    }
    const unlock = this.lock(id, "capture");
    let report: ImageReport;
    try {
      this.save(receipt, { fingerprint, started: true }, false);
      const staged = this.path(id, ".staged"), published = this.path(id, ".json");
      try {
        if (task.machine.id !== machineId || task.machine.desired !== "stopped" || task.machine.observed !== "stopped") throw new ServiceError("Source must remain owned and confirmed stopped.");
        if (!provider || typeof provider.withCaptureSource !== "function") throw new ServiceError("Native cold capture has no configured positive fence adapter.");
        let pin: ReturnType<typeof pinnedFile> | undefined;
        try {
          const pub = await provider.withCaptureSource(task.machine, image, folder, async (source, format) => {
            if (pin) throw new ServiceError("Capture provider supplied multiple sources.");
            pin = pinnedFile(source); let position = 0;
            const publicImage = await this.importStream({ id, name, os: image.os, arch: image.arch, mode: image.mode, mediaType: "disk", format, minimum: task.machine.resources }, { read(count) { const buffer = Buffer.alloc(count); const n = readSync(pin!.fd, buffer, 0, count, position); position += n; return buffer.subarray(0, n); } }, pin.size, () => true, { defer: true });
            pin.unchanged();
            const record = this.json(staged), definition = object(record.definition);
            definition.imageKind = "derived";
            for (const key of ["prepare", "guestAccess", "memoryStepMiB", "runtime", "ssh"]) if (Object.hasOwn(image, key)) definition[key] = structuredClone(image[key]);
            if (image.guestAccess && image.os === "linux") definition.cloneIdentity = "linux-cloud-init";
            if (image.guestAccess && definition.prepare) definition.prepare = capturePreparation(object(definition.prepare));
            publicImage.kind = "derived"; publicImage.sourceMachineId = machineId;
            publicImage.identityPolicy = image.guestAccess ? "linux-cloud-init" : "preserve-configured-os-state";
            publicImage.consistency = provider.captureConsistency?.(task.machine, image, folder) ?? "stopped-disk";
            if (image.catalogueImageId) publicImage.baseImageId = image.catalogueImageId;
            if (image.guestAccess) publicImage.guestAccess = true;
            validateImage(publicImage); normalizeTemplate(definition); this.save(staged, { ...record, public: publicImage, definition });
            return publicImage;
          });
          if (!pin || !this.present(staged)) throw new ServiceError("Capture provider did not supply a fenced source.");
          pin.unchanged(); this.guard();
          // No overwrite: a competing manifest must never be adopted.
          linkSync(staged, published); unlinkSync(staged); this.syncDirectory();
          report = { state: "succeeded", result: pub };
        } finally { if (pin) closeSync(pin.fd); }
      } catch {
        if (this.present(staged)) { renameSync(staged, this.path(id, ".quarantined")); report = { state: "unknown", result: { detail: "Capture artifact needs inspection; preserve source state and reserved storage." } }; }
        else if (this.present(published)) report = { state: "unknown", result: { detail: "Capture publication was not confirmed; preserve its artifact and reservation." } };
        else report = { state: "failed", result: { detail: "Cold capture failed; inspect runtime support, owned source and storage headroom." } };
      }
      this.save(receipt, { fingerprint, report }); return report;
    } finally { unlock(); }
  }
  async registryImport(job: Json, options: RegistryWorkerOptions): Promise<ImageReport> {
    const id = identifier(job.id), metadata = specification(job.metadata), item = registryEntry(job.registryId);
    if (metadata.id !== id) throw new ServiceError("Registry task identity differs from its image.");
    const receipt = this.path(id, ".registry.receipt"), fingerprint = canonical({ id, registryId: item.id, metadata });
    let source: RegistrySource | undefined = job.source ? validateEntrySource(item, job.source) : undefined;
    const published = this.records().find(r => r.public.id === id);
    const recover = (record: LibraryRecord, pinned: RegistrySource): ImageReport => {
      const publicImage = record.public;
      if (Object.entries(metadata).some(([key, value]) => !same(publicImage[key], value)) || publicImage.kind !== "base" || publicImage.bytes !== pinned.bytes || (pinned.sha256 && publicImage.sha256 !== pinned.sha256) || !same(publicImage.registry, { id: item.id, version: pinned.version, url: pinned.url, publisherSha256: pinned.sha256 }) || checksum(String(record.definition.image)) !== publicImage.sha256) throw new ServiceError("Published image does not match its pinned registry task.");
      return { state: "succeeded", result: publicImage };
    };
    if (this.present(receipt)) {
      const previous = this.json(receipt);
      if (previous.fingerprint !== fingerprint || (source && previous.source && !same(previous.source, source))) throw new ServiceError("Registry identity conflicts with its durable receipt.");
      if (previous.report) return imageReport(previous.report);
      if (!source && previous.source) source = validateEntrySource(item, previous.source);
      if (published && source) return recover(published, source);
      return { state: "unknown", result: { detail: "Interrupted registry import; inspect its private receipt and partial files before recovery." } };
    }
    if (published) {
      if (!source) throw new ServiceError("Published registry bytes lack a pinned controller resolution.");
      return recover(published, source);
    }
    const unlock = this.lock(id, "registry"); let report: ImageReport;
    try {
      try {
        // Native compatibility/preparation is a host responsibility, never inferred from a header.
        const settings = await options.importSettings(metadata);
        if (!options.authorized()) throw new ServiceError("Registry authorization ended.", 403);
        if (!source) source = validateEntrySource(item, await (options.resolveSource ?? resolveRegistrySource)(item));
        // The authenticated controller acknowledgement must precede all payload copying.
        const pinned = object(await options.pinSource(id, source));
        if (pinned.id !== id || pinned.kind !== "registry" || pinned.registryId !== item.id || !same(pinned.metadata, metadata) || !same(pinned.source, source) || pinned.bytes !== source.bytes) throw new ServiceError("Controller did not acknowledge the exact pinned registry task.");
        this.save(receipt, { fingerprint, started: true, source }, false);
        const provenance = { id: item.id, version: source.version, url: source.url, publisherSha256: source.sha256 };
        const artifact = source.sha256 ? join(this.root, `${source.sha256}.${metadata.format}`) : undefined;
        let publicImage: ImageMetadata;
        if (artifact && this.present(artifact)) {
          const pin = pinnedFile(artifact); let position = 0;
          try {
            if (pin.size !== source.bytes || checksum(artifact) !== source.sha256) throw new ServiceError("Cached registry artifact failed its pinned identity; preserved for inspection.");
            publicImage = await this.importStream(metadata, { read(count) { const buffer = Buffer.alloc(count), n = readSync(pin.fd, buffer, 0, count, position); position += n; return buffer.subarray(0, n); } }, source.bytes, options.authorized, { ...settings, expectedSha256: source.sha256, registry: provenance });
            pin.unchanged();
          } finally { closeSync(pin.fd); }
        } else {
          const reader = await (options.openSource ?? openRegistryReader)(source.url);
          try { publicImage = await this.importStream(metadata, reader, source.bytes, options.authorized, { ...settings, expectedSha256: source.sha256, registry: provenance }); }
          finally { await reader.close?.(); }
        }
        report = { state: "succeeded", result: publicImage };
      } catch (error) {
        const uncertain = this.present(this.path(id, ".json")) || (this.present(receipt) && !(error instanceof ServiceError));
        report = { state: uncertain ? "unknown" : "failed", result: { detail: error instanceof ServiceError ? error.message.slice(0, 500) : "Registry import needs inspection of publisher availability and private host receipts." } };
      }
      this.save(receipt, { fingerprint, source: source ?? null, report }); return report;
    } finally { unlock(); }
  }
}

function capturePreparation(value: Json): Json {
  const result = structuredClone(value);
  if (!Array.isArray(result.commands) || result.commands.some(c => typeof c !== "string")) throw new ServiceError("Invalid guest-access preparation commands.", 400);
  result.commands = (result.commands as string[]).map(c => c.replaceAll("systemctl enable --now canaveral-desktop", "systemctl enable canaveral-desktop && systemctl restart canaveral-desktop"));
  return result;
}
function imageReport(value: unknown): ImageReport {
  const r = object(value);
  if (!["running", "succeeded", "failed", "unknown"].includes(String(r.state))) throw new ServiceError("Invalid durable image receipt.");
  return { state: r.state as ImageReport["state"], result: object(r.result) };
}

export interface RegistryWorkerOptions {
  authorized(): boolean;
  /** Must validate host architecture/runtime and return the configured guest recipe. */
  importSettings(metadata: ImageSpec): ImportOptions | Promise<ImportOptions>;
  pinSource(id: string, source: RegistrySource): Promise<unknown>;
  resolveSource?(item: RegistryEntry): Promise<RegistrySource>;
  openSource?(url: string): Promise<ImageReader & { close?(): Promise<void> | void }>;
}
export function checksums(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of content.split(/\r?\n/)) {
    const match = /^([a-fA-F0-9]{64})\s+\*?([A-Za-z0-9_.+-]+)$/.exec(line.trim());
    if (match) result[match[2]!] = match[1]!.toLowerCase();
  }
  return result;
}
export async function openSource(url: string, method: "GET" | "HEAD" = "GET"): Promise<Response> {
  return fetchPublisher(url, method, allowedUrl, 25_000);
}
async function fetchPublisher(url: string, method: "GET" | "HEAD", allowed: (value: unknown) => boolean, timeoutMs: number): Promise<Response> {
  for (let redirect = 0; redirect <= 8; redirect++) {
    if (!allowed(url)) throw new ServiceError("Publisher source or redirect is outside permitted origins.", 400);
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try { response = await fetch(url, { method, redirect: "manual", signal: controller.signal, headers: { "User-Agent": "Canaveral-image-registry/1", "Accept-Encoding": "identity" } }); }
    catch { throw new ServiceError("Publisher metadata or download is unavailable.", 503); }
    finally { clearTimeout(timeout); }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel(); const location = response.headers.get("location");
      if (!location) throw new ServiceError("Publisher redirect has no target.", 400);
      url = new URL(location, url).href; continue;
    }
    if (!response.ok) { await response.body?.cancel(); throw new ServiceError("Publisher metadata or download is unavailable.", 503); }
    if (response.headers.get("content-encoding") && response.headers.get("content-encoding") !== "identity") { await response.body?.cancel(); throw new ServiceError("Publisher returned an unsupported encoded artifact.", 400); }
    return response;
  }
  throw new ServiceError("Publisher exceeded the redirect limit.", 400);
}
export async function openRegistryReader(url: string): Promise<ImageReader & { close(): Promise<void> }> {
  return responseReader(await openSource(url));
}
function responseReader(response: Response): ImageReader & { close(): Promise<void> } {
  if (!response.body) throw new ServiceError("Publisher returned no image body.", 503);
  const reader = response.body.getReader(); let pending: Uint8Array = new Uint8Array(), done = false;
  return {
    async read(count) {
      while (!pending.length && !done) {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
          const item = await Promise.race([reader.read(), new Promise<never>((_, reject) => { timeout = setTimeout(() => { void reader.cancel().catch(() => {}); reject(new ServiceError("Publisher body read timed out.", 503)); }, 25_000); })]);
          done = item.done; pending = item.value ?? new Uint8Array();
        } finally { if (timeout) clearTimeout(timeout); }
      }
      const result = pending.subarray(0, count); pending = pending.subarray(result.length); return result;
    },
    async close() { await reader.cancel(); reader.releaseLock(); },
  };
}

export interface PrepareImageOptions {
  authorized?(): boolean;
  openSource?(url: string): Promise<ImageReader & { close?(): Promise<void> | void }>;
}
/** Compatibility base cache. Owner-selected source links resolve once; cache entries
 * never follow links, never replace a competing publisher, and hash before reuse. */
export async function prepareImage(value: unknown, cache: string, options: PrepareImageOptions = {}): Promise<string> {
  const spec = imageSource(value);
  mkdirSync(cache, { recursive: true, mode: 0o700 });
  const info = lstatSync(cache, { bigint: true });
  if (!info.isDirectory() || (process.getuid && info.uid !== BigInt(process.getuid()))) throw new ServiceError("Image cache must be an owned directory without symbolic links.");
  cache = realpathSync(cache); const identity = `${info.dev}:${info.ino}`, target = join(cache, `${spec.sha256}.${spec.format}`);
  const guard = (): void => {
    const current = lstatSync(cache, { bigint: true });
    if (!current.isDirectory() || `${current.dev}:${current.ino}` !== identity || realpathSync(cache) !== cache) throw new ServiceError("Image cache directory changed.");
  };
  const authorized = (): void => { if (options.authorized && !options.authorized()) throw new ServiceError("Image cache preparation authorization ended.", 403); };
  const present = (path: string): boolean => { guard(); try { lstatSync(path); return true; } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return false; throw e; } };
  const existing = (): string => { guard(); if (checksum(target) !== spec.sha256) throw new ServiceError("Cached image checksum failed; entry was not overwritten."); guard(); return target; };
  authorized(); if (present(target)) return existing();
  const temporary = join(cache, `${randomUUID()}.partial`); let fd: number | undefined;
  let pin: ReturnType<typeof pinnedFile> | undefined, stream: (ImageReader & { close?(): Promise<void> | void }) | undefined;
  try {
    fd = openSync(temporary, "wx", 0o600);
    let remaining: number | undefined;
    if (spec.path) {
      // Configured local links are supported, but the resolved entry and descriptor
      // must retain identical device/inode/size/mtime/ctime throughout the copy.
      pin = pinnedFile(realpathSync(spec.path)); remaining = pin.size; let position = 0;
      stream = { read(count) { const data = Buffer.alloc(count), n = readSync(pin!.fd, data, 0, count, position); position += n; return data.subarray(0, n); } };
    } else {
      const open = options.openSource ?? (async (url: string) => responseReader(await fetchPublisher(url, "GET", input => {
        if (typeof input !== "string") return false;
        try { const u = new URL(input); return u.protocol === "https:" && !!u.hostname && !u.username && !u.password && !u.hash; } catch { return false; }
      }, 60_000)));
      stream = await open(spec.url!);
    }
    let copied = 0; const hash = createHash("sha256");
    while (remaining === undefined || remaining > 0) {
      guard(); authorized(); const limit = remaining === undefined ? chunkSize : Math.min(chunkSize, remaining), data = await stream.read(limit);
      if (!(data instanceof Uint8Array) || data.length > limit) throw new ServiceError("Base image source returned an invalid chunk.");
      if (!data.length) { if (remaining !== undefined) throw new ServiceError("Local base image source ended during preparation."); break; }
      guard(); authorized(); hash.update(data);
      if (!Number.isSafeInteger(copied + data.length)) throw new ServiceError("Image source length cannot be safely represented.");
      if (data.some(byte => byte !== 0)) { let written = 0; while (written < data.length) written += writeSync(fd, data, written, data.length - written, copied + written); }
      copied += data.length; if (remaining !== undefined) remaining -= data.length;
    }
    pin?.unchanged(); ftruncateSync(fd, copied); chmodSync(temporary, 0o644); fsyncSync(fd); closeSync(fd); fd = undefined;
    // Stream/fence release must complete before publishing a cache artifact.
    await stream.close?.(); stream = undefined;
    if (hash.digest("hex") !== spec.sha256) throw new ServiceError("Base image checksum failed; no image was published.");
    guard(); authorized();
    try { linkSync(temporary, target); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return existing(); throw cachePublicationUncertain(); }
    if (process.platform !== "win32") {
      try { const directory = openSync(cache, constants.O_RDONLY | constants.O_DIRECTORY | (constants.O_NOFOLLOW ?? 0)); try { fsyncSync(directory); } finally { closeSync(directory); } }
      catch { throw cachePublicationUncertain(); }
    }
    return target;
  } finally {
    if (fd !== undefined) closeSync(fd); if (pin) closeSync(pin.fd);
    try { await stream?.close?.(); }
    finally { if (present(temporary)) unlinkSync(temporary); }
  }
}
function cachePublicationUncertain(): ServiceError {
  return new ServiceError("Base image cache publication was not confirmed; inspect before retrying.", 409, { code: "image_cache_publication_uncertain", retryable: false, outcome: "unknown" });
}
export interface RegistryResolverIO {
  metadata(url: string): Promise<string>;
  length(url: string): Promise<number>;
  appleRestore?(): Promise<{ url: string; version: string; build: string }>;
}
const publisherIO: RegistryResolverIO = {
  async metadata(url) {
    const reader = await openRegistryReader(url); const chunks: Buffer[] = []; let length = 0;
    try {
      while (true) { const chunk = await reader.read(Math.min(chunkSize, 2_097_153 - length)); if (!chunk.length) break; length += chunk.length; if (length > 2_097_152) throw new ServiceError("Publisher metadata exceeds its bounded envelope.", 400); chunks.push(Buffer.from(chunk)); }
      return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
    } finally { await reader.close(); }
  },
  async length(url) {
    const response = await openSource(url, "HEAD"), length = response.headers.get("content-length");
    if (!length || !/^\d+$/.test(length)) throw new ServiceError("Publisher must supply image length before capacity is reserved.");
    return bytes(Number(length));
  },
};
function fileVersion(name: string): number[] { return /^(?:ubuntu|debian)-([0-9]+(?:\.[0-9]+)*)-/.exec(name)?.[1]?.split(".").map(Number) ?? []; }
function versionOrder(a: string, b: string): number {
  const av = fileVersion(a), bv = fileVersion(b);
  for (let i = 0; i < Math.max(av.length, bv.length); i++) { if (i >= av.length) return -1; if (i >= bv.length) return 1; if (av[i] !== bv[i]) return av[i]! - bv[i]!; }
  return 0;
}
export async function resolveRegistrySource(item: RegistryEntry, io: RegistryResolverIO = publisherIO): Promise<RegistrySource> {
  let url: string, version: string, sha256: string | null = null;
  if (["ubuntu-iso", "ubuntu-cloud", "debian"].includes(item.resolver ?? "")) {
    let root: string, pattern: RegExp;
    if (item.resolver === "ubuntu-cloud") { root = "https://cloud-images.ubuntu.com/noble/current/"; pattern = new RegExp(`^noble-server-cloudimg-${item.arch}\\.img$`); }
    else if (item.resolver === "debian") { root = `https://cdimage.debian.org/debian-cd/current/${item.arch}/iso-cd/`; pattern = new RegExp(`^debian-[0-9.]+-${item.arch}-netinst\\.iso$`); }
    else {
      const release = String(item.release), flavor = item.flavor === "desktop" ? "desktop" : "live-server";
      root = item.arch === "amd64" ? `https://releases.ubuntu.com/${release}/` : `https://cdimage.ubuntu.com/${item.flavor === "desktop" ? "ubuntu/" : ""}releases/${release}/release/`;
      pattern = new RegExp(`^ubuntu-${release.replaceAll(".", "\\.")}(?:\\.[0-9]+)*-${flavor}-${item.arch}\\.iso$`);
    }
    const sums = checksums(await io.metadata(root + "SHA256SUMS")), names = Object.keys(sums).filter(name => pattern.test(name)).sort(versionOrder), name = names.at(-1);
    if (!name) throw new ServiceError("Publisher currently lists no matching stable image for this architecture.");
    url = root + name; sha256 = sums[name]!; version = name;
  } else if (item.resolver === "fedora") {
    const rows: unknown = JSON.parse(await io.metadata("https://fedoraproject.org/releases.json"));
    if (!Array.isArray(rows)) throw new ServiceError("Invalid Fedora release feed.", 400);
    const arch = item.arch === "amd64" ? "x86_64" : "aarch64";
    const matches = rows.map(object).filter(r => r.variant === "Workstation" && r.arch === arch && /^\d+$/.test(String(r.version)) && typeof r.link === "string" && r.link.endsWith(".iso")).sort((a, b) => Number(a.version) - Number(b.version)), chosen = matches.at(-1);
    if (!chosen) throw new ServiceError("Fedora currently lists no stable Workstation ISO for this architecture.");
    const upstream = new URL(String(chosen.link)); url = `https://dl.fedoraproject.org${upstream.pathname}`; version = String(chosen.version); sha256 = String(chosen.sha256);
  } else if (item.resolver === "apple") {
    if (!io.appleRestore) throw new ServiceError("Resolve macOS using the signed Apple runner on an Apple silicon host.");
    const restore = await io.appleRestore(); url = restore.url; version = `${restore.version} (${restore.build})`;
  } else throw new ServiceError("This entry requires a publisher download and file import.");
  // Validate origin/checksum before even sending HEAD to a resolved source.
  validateEntrySource(item, { url, version, sha256, bytes: 512 });
  return validateEntrySource(item, { url, version, sha256, bytes: await io.length(url) });
}
