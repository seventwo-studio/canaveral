import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import { ServiceError, object, secret } from "../errors.ts";
import type { SqliteStore } from "../sqlite.ts";
import { canonicalManifest, parseSignedRelease, verifyRelease } from "../updates/protocol.ts";
import type { SignedRelease, Target } from "../updates/protocol.ts";
import { RunnerEnrollment } from "../enrollment.ts";
import { machineDigest } from "./machines.ts";
import { requireAdmin } from "./contracts.ts";
import type { ControlModule, ControlOptions, ControlRequest } from "./contracts.ts";

// Limits apply before decoding or allocating artifact contents. SQLite holds bounded
// chunks, never a concatenation of an entire release in controller memory.
export const updateChunkBytes = 512 * 1024;
export const updateArtifactBytes = 512 * 1024 * 1024;
const maxStorageBytes = 8 * 1024 * 1024 * 1024;
const maxArtifactChunks = 8192;
const terminal = ["succeeded", "rolledBack", "failed", "cancelled"] as const;
export type UpdateState = "queued" | "draining" | "downloading" | "staged" | "activating" | "verifying" | "succeeded" | "rolledBack" | "failed" | "unknown" | "cancelled";
export interface UpdateOptions extends ControlOptions { updatePublicKeys?: Record<string, string> }
type TargetKind = "host" | "runner";
type Row = Record<string, SQLOutputValue>;
const refuse = (status = 400): never => { throw new ServiceError("Update request rejected.", status); };
function fields(body: Record<string, unknown>, allowed: string[]): void { if (Object.keys(body).some(key => !allowed.includes(key))) refuse(); }
function uuid(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) return refuse();
  return value.toLowerCase();
}
function digest(value: unknown): string { if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) return refuse(); return value; }
function integer(value: unknown, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) return refuse(); return value;
}
function target(value: unknown): Target {
  const v = object(value); fields(v, ["os", "arch"]);
  if (!["linux", "darwin", "win32"].includes(String(v.os)) || !["amd64", "arm64"].includes(String(v.arch))) return refuse();
  return { os: v.os as Target["os"], arch: v.arch as Target["arch"] };
}
function equalSecret(a: string, b: string): boolean { return a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b)); }
function table(db: DatabaseSync, name: string): boolean { return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name); }
function authenticate(db: DatabaseSync, host: string, token: string): string {
  secret(token);
  if (table(db, "retired_runners") && db.prepare("SELECT 1 FROM retired_runners WHERE id=?").get(host)) return refuse(403);
  const row = table(db, "hosts") ? db.prepare("SELECT credential FROM hosts WHERE id=?").get(host) : undefined;
  const hash = machineDigest(token);
  if (!row || !equalSecret(String(row.credential), hash)) return refuse(401);
  return hash;
}
function active(db: DatabaseSync, host: string, kind: TargetKind): Row | undefined { return db.prepare("SELECT * FROM host_update_jobs WHERE host=? AND target_kind=? AND phase NOT IN ('succeeded','rolledBack','failed','cancelled')").get(host, kind); }
function envelope(db: DatabaseSync, id: string): SignedRelease {
  const row = db.prepare("SELECT envelope FROM update_releases WHERE id=?").get(id);
  if (!row) return refuse(404);
  return parseSignedRelease(JSON.parse(String(row.envelope)));
}
function wireRelease(release: SignedRelease): string {
  return JSON.stringify({ manifest: JSON.parse(canonicalManifest(release.manifest).toString("utf8")), keyId: release.keyId, signature: release.signature });
}
function jobView(row: Row) {
  return { id: row.id, ...(row.target_kind === "host" ? { hostId: row.host } : { runnerId: row.host }), targetKind: row.target_kind, attemptId: row.attempt, state: row.phase, sequence: row.sequence,
    previousReleaseId: row.previous_release, installedReleaseId: row.installed_release, detail: row.detail,
    components: JSON.parse(String(row.components)), createdAt: row.created, updatedAt: row.updated };
}
function rolloutView(db: DatabaseSync, row: Row) {
  const request = JSON.parse(String(row.request)) as { id: string; releaseId: string; hostIds: string[]; runnerIds?: string[] };
  return { ...request, jobs: db.prepare("SELECT * FROM host_update_jobs WHERE rollout=? ORDER BY host").all(row.id!).map(jobView) };
}

/** Every nonterminal phase, including queued and unknown, drains NEW placements.
 * No expiry, heartbeat, credential rotation or cancellation releases reservations.
 * Consumers must deny placement while such a row exists for their host.
 */
export function initializeUpdates(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS update_releases (
      id TEXT PRIMARY KEY, envelope TEXT NOT NULL, os TEXT NOT NULL, arch TEXT NOT NULL,
      sequence INTEGER NOT NULL, created REAL NOT NULL, UNIQUE(os,arch,sequence));
    CREATE TABLE IF NOT EXISTS update_artifacts (
      sha256 TEXT PRIMARY KEY, total INTEGER NOT NULL, received INTEGER NOT NULL, verified INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS update_artifact_chunks (
      sha256 TEXT NOT NULL, offset INTEGER NOT NULL, data BLOB NOT NULL, checksum TEXT NOT NULL, PRIMARY KEY(sha256,offset));
    CREATE TABLE IF NOT EXISTS host_update_registrations (
      host TEXT NOT NULL, target_kind TEXT NOT NULL, binding TEXT, credential_revision INTEGER, installation TEXT NOT NULL, credential TEXT NOT NULL, os TEXT NOT NULL, arch TEXT NOT NULL,
      launcher INTEGER NOT NULL, current_release TEXT, highwater INTEGER NOT NULL DEFAULT 0, updated REAL NOT NULL, PRIMARY KEY(host,target_kind));
    CREATE TABLE IF NOT EXISTS update_rollouts (id TEXT PRIMARY KEY,request TEXT NOT NULL,created REAL NOT NULL);
    CREATE TABLE IF NOT EXISTS host_update_jobs (
      id TEXT PRIMARY KEY,rollout TEXT NOT NULL,host TEXT NOT NULL,target_kind TEXT NOT NULL,binding TEXT,credential_revision INTEGER,release TEXT NOT NULL,attempt TEXT NOT NULL UNIQUE,
      installation TEXT NOT NULL,credential TEXT NOT NULL,phase TEXT NOT NULL,sequence INTEGER NOT NULL DEFAULT 0,
      delivered INTEGER NOT NULL DEFAULT 0,previous_release TEXT,installed_release TEXT,activated INTEGER NOT NULL DEFAULT 0,
      uncertain INTEGER NOT NULL DEFAULT 0,detail TEXT,components TEXT NOT NULL,created REAL NOT NULL,updated REAL NOT NULL,
      UNIQUE(rollout,host,target_kind));
    CREATE UNIQUE INDEX IF NOT EXISTS host_update_one_active ON host_update_jobs(host,target_kind)
      WHERE phase NOT IN ('succeeded','rolledBack','failed','cancelled');
    CREATE TABLE IF NOT EXISTS host_update_reports (
      job TEXT NOT NULL,sequence INTEGER NOT NULL,request TEXT NOT NULL,response TEXT NOT NULL,PRIMARY KEY(job,sequence));`);
}

function chunkChecksum(offset: number, bytes: Uint8Array): string {
  return createHash("sha256").update(`${offset}:${bytes.length}:`, "ascii").update(bytes).digest("hex");
}
/** Publication verifies the whole artifact; subsequent range reads verify each
 * persisted chunk, including its offset and size, against that publication.
 */
function verifyArtifact(db: DatabaseSync, sha: string, total: number): void {
  const hash = createHash("sha256"); let next = 0, count = 0;
  for (const row of db.prepare("SELECT offset,data,checksum FROM update_artifact_chunks WHERE sha256=? ORDER BY offset").iterate(sha)) {
    const bytes = row.data;
    if (!(bytes instanceof Uint8Array) || bytes.length > updateChunkBytes || row.offset !== next || ++count > maxArtifactChunks) return refuse(409);
    if ((!bytes.length && total !== 0) || row.checksum !== chunkChecksum(next, bytes)) return refuse(409);
    hash.update(bytes); next += bytes.length;
    if (next > total) return refuse(409);
  }
  if (next !== total || hash.digest("hex") !== sha) return refuse(409);
}
function readyArtifact(db: DatabaseSync, sha: string, total: number, full = true): void {
  const row = db.prepare("SELECT * FROM update_artifacts WHERE sha256=?").get(sha);
  if (!row || row.verified !== 1 || row.total !== total || row.received !== total) return refuse(409);
  if (full) verifyArtifact(db, sha, total);
}
function releaseBounds(release: SignedRelease): void {
  let bytes = 0;
  const sizes = new Map<string, number>();
  for (const file of release.manifest.files) {
    integer(file.bytes, 0, updateArtifactBytes); bytes += file.bytes;
    if (sizes.has(file.sha256) && sizes.get(file.sha256) !== file.bytes) return refuse();
    sizes.set(file.sha256, file.bytes);
  }
  if (bytes > 2 * 1024 * 1024 * 1024) refuse(413);
}

export function createModule(store: SqliteStore, options: UpdateOptions): ControlModule {
  // Copy only operator configuration. No request or signed manifest can add trust.
  const keys = Object.assign(Object.create(null) as Record<string, string>, options.updatePublicKeys ?? {});
  store.transaction(initializeUpdates);
  const runners = new RunnerEnrollment(store, options.controllerId);
  function authorize(db: DatabaseSync, kind: TargetKind, id: string, token: string, value?: unknown) {
    if (kind === "host") return { credential: authenticate(db, id, token), binding: null, revision: null };
    const { credentialRevision, ...binding } = runners.verify(db, token, value);
    if (binding.runnerId !== id) return refuse(403);
    return { credential: createHash("sha256").update(`runner:${secret(token)}`, "ascii").digest("hex"), binding: JSON.stringify(binding), revision: credentialRevision };
  }
  // Authority loss never turns an in-flight operation into safe failure. The same
  // hook runs at admission boundaries, including a transaction owned by a caller.
  store.addTransactionHook(db => {
    for (const job of db.prepare("SELECT * FROM host_update_jobs WHERE phase NOT IN ('succeeded','rolledBack','failed','cancelled','unknown')").all()) {
      let current = false;
      if (job.target_kind === "host") {
        current = table(db, "hosts") && !!db.prepare("SELECT 1 FROM hosts WHERE id=? AND credential=?").get(job.host!, job.credential!);
        if (table(db, "retired_runners") && db.prepare("SELECT 1 FROM retired_runners WHERE id=?").get(job.host!)) current = false;
      } else {
        const b = JSON.parse(String(job.binding)) as { controllerId: string; runnerId: string; generation: number; incarnationId: string };
        const row = db.prepare("SELECT * FROM runner_bindings WHERE controller=? AND runner=? ORDER BY generation DESC LIMIT 1").get(b.controllerId, b.runnerId);
        current = !!row && row.revoked === 0 && row.generation === b.generation && row.incarnation === b.incarnationId && row.credential === job.credential && row.revision === job.credential_revision;
      }
      if (!current) db.prepare("UPDATE host_update_jobs SET phase='unknown',uncertain=1,detail='Update credential authority changed; retain drain.',updated=? WHERE id=?").run(store.clock(), job.id!);
    }
  });
  function verified(db: DatabaseSync, id: string): SignedRelease {
    const release = envelope(db, id);
    try { verifyRelease(release, keys); } catch { return refuse(409); }
    releaseBounds(release); return release;
  }
  function register(db: DatabaseSync, req: ControlRequest) {
    if (!Object.keys(keys).length) return refuse(503);
    let release: SignedRelease;
    try { release = verifyRelease(req.body, keys); } catch { return refuse(); }
    releaseBounds(release);
    const m = release.manifest, serialized = wireRelease(release);
    const old = db.prepare("SELECT envelope FROM update_releases WHERE id=?").get(m.releaseId);
    if (old) { if (old.envelope !== serialized) return refuse(409); return release; }
    if (db.prepare("SELECT 1 FROM update_releases WHERE os=? AND arch=? AND sequence=?").get(m.target.os, m.target.arch, m.sequence)) return refuse(409);
    for (const file of m.files) {
      const artifact = db.prepare("SELECT total FROM update_artifacts WHERE sha256=?").get(file.sha256);
      if (artifact && artifact.total !== file.bytes) return refuse(409);
    }
    db.prepare("INSERT INTO update_releases VALUES (?,?,?,?,?,?)").run(m.releaseId, serialized, m.target.os, m.target.arch, m.sequence, store.clock());
    return release;
  }
  function upload(db: DatabaseSync, sha: string, body: Record<string, unknown>) {
    fields(body, ["offset", "totalBytes", "data"]);
    const total = integer(body.totalBytes, 0, updateArtifactBytes), offset = integer(body.offset, 0, total);
    if (typeof body.data !== "string" || body.data.length > 1024 * 1024) return refuse(413);
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(body.data)) return refuse();
    const data = Buffer.from(body.data, "base64");
    if (data.toString("base64") !== body.data || data.length > updateChunkBytes || offset + data.length > total || (!data.length && total !== 0)) return refuse();
    let artifact = db.prepare("SELECT * FROM update_artifacts WHERE sha256=?").get(sha);
    if (!artifact) {
      if (offset !== 0) return refuse(409);
      const capacity = db.prepare("SELECT COALESCE(SUM(total),0) AS bytes,COUNT(*) AS count FROM update_artifacts").get()!;
      if (Number(capacity.bytes) + total > maxStorageBytes || Number(capacity.count) >= 16384) return refuse(413);
      // A prior signed declaration also pins this digest's byte count.
      for (const row of db.prepare("SELECT envelope FROM update_releases").iterate()) {
        const release = parseSignedRelease(JSON.parse(String(row.envelope)));
        if (release.manifest.files.some(file => file.sha256 === sha && file.bytes !== total)) return refuse(409);
      }
      db.prepare("INSERT INTO update_artifacts VALUES (?,?,0,0)").run(sha, total);
      artifact = db.prepare("SELECT * FROM update_artifacts WHERE sha256=?").get(sha)!;
    }
    if (artifact.total !== total) return refuse(409);
    const old = db.prepare("SELECT data FROM update_artifact_chunks WHERE sha256=? AND offset=?").get(sha, offset);
    if (old) {
      if (!(old.data instanceof Uint8Array) || !data.equals(old.data)) return refuse(409);
      if (artifact.verified === 1) verifyArtifact(db, sha, total);
      return { sha256: sha, totalBytes: total, receivedBytes: artifact.received, verified: artifact.verified === 1 };
    }
    if (artifact.verified === 1 || artifact.received !== offset) return refuse(409);
    if (Number(db.prepare("SELECT COUNT(*) AS n FROM update_artifact_chunks WHERE sha256=?").get(sha)!.n) >= maxArtifactChunks) return refuse(413);
    db.prepare("INSERT INTO update_artifact_chunks VALUES (?,?,?,?)").run(sha, offset, data, chunkChecksum(offset, data));
    const received = offset + data.length, complete = received === total;
    if (complete) verifyArtifact(db, sha, total);
    db.prepare("UPDATE update_artifacts SET received=?,verified=? WHERE sha256=?").run(received, complete ? 1 : 0, sha);
    return { sha256: sha, totalBytes: total, receivedBytes: received, verified: complete };
  }
  function rollout(db: DatabaseSync, body: Record<string, unknown>) {
    fields(body, ["id", "releaseId", "hostIds", "runnerIds"]);
    const id = uuid(body.id), releaseId = uuid(body.releaseId);
    const hostValues = body.hostIds ?? [], runnerValues = body.runnerIds ?? [];
    if (!Array.isArray(hostValues) || !Array.isArray(runnerValues) || hostValues.length + runnerValues.length < 1 || hostValues.length + runnerValues.length > 1000) return refuse();
    const hosts = hostValues.map(uuid), runnerIds = runnerValues.map(uuid);
    if (new Set(hosts).size !== hosts.length || new Set(runnerIds).size !== runnerIds.length) return refuse();
    const targets: Array<{ id: string; kind: TargetKind }> = [...hosts.map(id => ({ id, kind: "host" as const })), ...runnerIds.map(id => ({ id, kind: "runner" as const }))];
    // Preserve supplied list order and optional-field presence for exact replay.
    const request = JSON.stringify({ id, releaseId, ...(body.hostIds === undefined ? {} : { hostIds: hosts }), ...(body.runnerIds === undefined ? {} : { runnerIds }) });
    const old = db.prepare("SELECT * FROM update_rollouts WHERE id=?").get(id);
    if (old) { if (old.request !== request) return refuse(409); return rolloutView(db, old); }
    const release = verified(db, releaseId), m = release.manifest;
    for (const [sha, bytes] of new Map(m.files.map(file => [file.sha256, file.bytes]))) readyArtifact(db, sha, bytes);
    for (const { id: host, kind } of targets) {
      const registration = db.prepare("SELECT * FROM host_update_registrations WHERE host=? AND target_kind=?").get(host, kind);
      let identity: Row | undefined;
      if (kind === "host") identity = table(db, "hosts") ? db.prepare("SELECT credential,enabled FROM hosts WHERE id=?").get(host) : undefined;
      else if (registration) {
        const binding = JSON.parse(String(registration.binding)) as unknown;
        if (runners.current(db, binding)) {
          const b = binding as { controllerId: string; runnerId: string; generation: number };
          const row = db.prepare("SELECT * FROM runner_bindings WHERE controller=? AND runner=? AND generation=?").get(b.controllerId, b.runnerId, b.generation)!;
          if (row.revision === registration.credential_revision) identity = { ...row, enabled: 1 };
        }
      }
      if (!registration || !identity) return refuse(409);
      if (kind === "host" && table(db, "retired_runners") && db.prepare("SELECT 1 FROM retired_runners WHERE id=?").get(host)) return refuse(403);
      if (identity.enabled !== 1 || registration.credential !== identity.credential || registration.os !== m.target.os || registration.arch !== m.target.arch || Number(registration.launcher) < m.minimumLauncherVersion || Number(registration.highwater) >= m.sequence || active(db, host, kind)) return refuse(409);
    }
    db.prepare("INSERT INTO update_rollouts VALUES (?,?,?)").run(id, request, store.clock());
    const components = JSON.stringify(Object.fromEntries([...new Set(m.files.map(file => file.component))].map(component => [component, "pending"])));
    for (const { id: host, kind } of targets) {
      const registration = db.prepare("SELECT * FROM host_update_registrations WHERE host=? AND target_kind=?").get(host, kind)!;
      db.prepare(`INSERT INTO host_update_jobs (id,rollout,host,target_kind,binding,credential_revision,release,attempt,installation,credential,phase,components,created,updated)
        VALUES (?,?,?,?,?,?,?,?,?,?,'queued',?,?,?)`).run(randomUUID(), id, host, kind, registration.binding!, registration.credential_revision!, releaseId, randomUUID(), registration.installation!, registration.credential!, components, store.clock(), store.clock());
    }
    return rolloutView(db, db.prepare("SELECT * FROM update_rollouts WHERE id=?").get(id)!);
  }
  function poll(db: DatabaseSync, req: ControlRequest, host: string, kind: TargetKind) {
    const authority = authorize(db, kind, host, req.token, req.body.binding), credential = authority.credential, body = req.body;
    fields(body, ["installationId", "target", "launcherVersion", "currentReleaseId", ...(kind === "runner" ? ["binding"] : [])]);
    const installation = uuid(body.installationId), platform = target(body.target), launcher = integer(body.launcherVersion, 1, Number.MAX_SAFE_INTEGER);
    const current = body.currentReleaseId === undefined ? null : uuid(body.currentReleaseId);
    const old = db.prepare("SELECT * FROM host_update_registrations WHERE host=? AND target_kind=?").get(host, kind), job = active(db, host, kind);
    if (job && (job.installation !== installation || job.credential !== credential || job.binding !== authority.binding || job.credential_revision !== authority.revision)) return refuse(409);
    if (job && old && (old.os !== platform.os || old.arch !== platform.arch)) return refuse(409);
    // An installation ID is durable, not a way to reset the anti-downgrade floor.
    let highwater = Number(old?.highwater ?? 0);
    if (current) {
      const known = db.prepare("SELECT os,arch,sequence FROM update_releases WHERE id=?").get(current);
      if (known && (known.os !== platform.os || known.arch !== platform.arch)) return refuse(409);
      if (known) highwater = Math.max(highwater, Number(known.sequence));
    }
    db.prepare(`INSERT INTO host_update_registrations VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(host,target_kind) DO UPDATE SET
      binding=excluded.binding,credential_revision=excluded.credential_revision,
      installation=excluded.installation,credential=excluded.credential,os=excluded.os,arch=excluded.arch,launcher=excluded.launcher,
      current_release=excluded.current_release,highwater=excluded.highwater,updated=excluded.updated`).run(host, kind, authority.binding, authority.revision, installation, credential, platform.os, platform.arch, launcher, current, highwater, store.clock());
    if (!job) return { job: null };
    const release = verified(db, String(job.release)), m = release.manifest;
    if (m.target.os !== platform.os || m.target.arch !== platform.arch || launcher < m.minimumLauncherVersion) return refuse(409);
    if (job.delivered === 0) {
      if (m.sequence <= highwater) return refuse(409);
      db.prepare("UPDATE host_update_jobs SET delivered=1,previous_release=?,updated=? WHERE id=?").run(current, store.clock(), job.id!);
      db.prepare("UPDATE host_update_registrations SET highwater=? WHERE host=? AND target_kind=?").run(m.sequence, host, kind);
    }
    return { job: { id: job.id, attemptId: job.attempt, release } };
  }
  function report(db: DatabaseSync, req: ControlRequest, host: string, kind: TargetKind) {
    const authority = authorize(db, kind, host, req.token, req.body.binding), credential = authority.credential, body = req.body;
    fields(body, ["jobId", "attemptId", "sequence", "state", "installedReleaseId", "detail", ...(kind === "runner" ? ["binding"] : [])]);
    const id = uuid(body.jobId), attempt = uuid(body.attemptId), sequence = integer(body.sequence, 1, Number.MAX_SAFE_INTEGER);
    const installed = body.installedReleaseId === undefined ? undefined : body.installedReleaseId === null ? null : uuid(body.installedReleaseId);
    const state = body.state as UpdateState;
    if (!["draining", "downloading", "staged", "activating", "verifying", "succeeded", "rolledBack", "failed", "unknown", "cancelled"].includes(state)) return refuse();
    if (body.detail !== undefined && (typeof body.detail !== "string" || body.detail.length > 2000 || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(body.detail))) return refuse();
    const job = db.prepare("SELECT * FROM host_update_jobs WHERE id=? AND host=? AND target_kind=?").get(id, host, kind);
    if (!job) return refuse(404);
    const registration = db.prepare("SELECT * FROM host_update_registrations WHERE host=? AND target_kind=?").get(host, kind);
    if (job.binding !== authority.binding || job.credential_revision !== authority.revision || job.credential !== credential || job.attempt !== attempt || !registration || job.installation !== registration.installation || registration.credential !== credential || job.delivered !== 1) return refuse(409);
    const request = JSON.stringify({ jobId: id, attemptId: attempt, sequence, state, ...(installed === undefined ? {} : { installedReleaseId: installed }), ...(body.detail === undefined ? {} : { detail: body.detail }) });
    const old = db.prepare("SELECT request,response FROM host_update_reports WHERE job=? AND sequence=?").get(id, sequence);
    if (old) { if (old.request !== request) return refuse(409); return JSON.parse(String(old.response)) as unknown; }
    if (terminal.includes(job.phase as typeof terminal[number]) || sequence !== Number(job.sequence) + 1) return refuse(409);
    const next: Partial<Record<UpdateState, UpdateState>> = { queued: "draining", draining: "downloading", downloading: "staged", staged: "activating", activating: "verifying", verifying: "succeeded" };
    if (state === "succeeded") {
      if (job.phase !== "verifying" || installed !== job.release) return refuse(409);
    } else if (state === "rolledBack") {
      if (job.activated !== 1 || job.previous_release === null || installed !== job.previous_release || !["activating", "verifying", "unknown"].includes(String(job.phase))) return refuse(409);
    } else if (state === "failed" || state === "cancelled") {
      // Explicit installedReleaseId:null is the no-activation proof for the initial
      // unmanaged baseline only. It can never establish a successful rollback.
      if (job.activated !== 0 || job.uncertain !== 0 || installed === undefined || installed !== job.previous_release) return refuse(409);
    } else if (state !== "unknown" && !(job.phase === "unknown" && job.activated === 1 && state === "verifying") && next[job.phase as UpdateState] !== state) return refuse(409);
    const release = envelope(db, String(job.release));
    const components = JSON.parse(String(job.components)) as Record<string, string>;
    if (state === "staged") for (const component of Object.keys(components)) components[component] = "staged";
    if (state === "succeeded") for (const component of Object.keys(components)) components[component] = component === "host" ? "ready" : component === "guest" ? "pendingGuestReceipt" : "pendingNativeReceipt";
    if (state === "rolledBack") for (const component of Object.keys(components)) components[component] = "rolledBack";
    // A host success only attests staged guest files, never live guest application.
    if (state === "succeeded" || state === "rolledBack") {
      db.prepare("UPDATE host_update_registrations SET current_release=?,updated=? WHERE host=? AND target_kind=?").run(installed!, store.clock(), host, kind);
    }
    // Retain parsing of the bound release on every receipt; corrupt state fails closed.
    if (release.manifest.releaseId !== job.release) return refuse(409);
    db.prepare(`UPDATE host_update_jobs SET phase=?,sequence=?,installed_release=?,detail=?,components=?,
      activated=MAX(activated,?),uncertain=MAX(uncertain,?),updated=? WHERE id=?`).run(state, sequence, installed ?? null, (body.detail as string | undefined) ?? null, JSON.stringify(components), state === "activating" ? 1 : 0, state === "unknown" ? 1 : 0, store.clock(), id);
    const response = { accepted: true, job: jobView(db.prepare("SELECT * FROM host_update_jobs WHERE id=?").get(id)!) };
    db.prepare("INSERT INTO host_update_reports VALUES (?,?,?,?)").run(id, sequence, request, JSON.stringify(response));
    return response;
  }
  function download(db: DatabaseSync, req: ControlRequest, sha: string) {
    const allowed = new Set(["offset", "length", "jobId"]);
    for (const key of req.query.keys()) if (!allowed.has(key) || req.query.getAll(key).length !== 1) return refuse();
    const jobId = uuid(req.query.get("jobId"));
    const job = db.prepare("SELECT * FROM host_update_jobs WHERE id=?").get(jobId);
    if (!job) return refuse(404);
    const authority = authorize(db, job.target_kind as TargetKind, String(job.host), req.token, job.binding === null ? undefined : JSON.parse(String(job.binding))), hash = authority.credential;
    const registration = db.prepare("SELECT * FROM host_update_registrations WHERE host=? AND target_kind=?").get(job.host!, job.target_kind!);
    if (job.binding !== authority.binding || job.credential_revision !== authority.revision || job.credential !== hash || !registration || registration.installation !== job.installation || registration.credential !== hash || job.delivered !== 1 || terminal.includes(job.phase as typeof terminal[number])) return refuse(403);
    const release = verified(db, String(job.release)), file = release.manifest.files.find(file => file.sha256 === sha);
    if (!file) return refuse(404);
    const number = (name: string, min: number, max: number): number => {
      const value = req.query.get(name);
      if (value === null || !/^(0|[1-9][0-9]*)$/.test(value)) return refuse(); return integer(Number(value), min, max);
    };
    const offset = number("offset", 0, file.bytes), length = number("length", 1, updateChunkBytes);
    readyArtifact(db, sha, file.bytes, false);
    const end = Math.min(file.bytes, offset + length), result = Buffer.alloc(end - offset);
    let cursor = offset;
    for (const row of db.prepare("SELECT offset,data,checksum FROM update_artifact_chunks WHERE sha256=? AND offset<? AND offset+length(data)>? ORDER BY offset").iterate(sha, end, offset)) {
      const bytes = row.data as Uint8Array, start = Number(row.offset), left = Math.max(offset, start), right = Math.min(end, start + bytes.length);
      if (!(bytes instanceof Uint8Array) || !Number.isSafeInteger(start) || start < 0 || bytes.length > updateChunkBytes || start + bytes.length > file.bytes || row.checksum !== chunkChecksum(start, bytes) || left !== cursor || right <= left) return refuse(409);
      result.set(bytes.subarray(left - start, right - start), left - offset); cursor = right;
    }
    if (cursor !== end) return refuse(409);
    return { offset, totalBytes: file.bytes, data: result.toString("base64") };
  }
  return { handle(req) {
    const p = req.parts;
    const adminRoute = p[0] === "v1" && p[1] === "updates";
    const hostRoute = p[0] === "v1" && ["hosts", "runners"].includes(p[1] ?? "") && p[3] === "updates";
    if (!adminRoute && !hostRoute) return undefined;
    return store.transaction(db => {
      if (hostRoute) {
        const host = uuid(p[2]);
        if (req.method === "POST" && p.length === 5 && p[4] === "poll") return { body: poll(db, req, host, p[1] === "hosts" ? "host" : "runner") };
        if (req.method === "POST" && p.length === 5 && p[4] === "report") return { body: report(db, req, host, p[1] === "hosts" ? "host" : "runner") };
        return refuse(404);
      }
      // Artifact reads have their own job-bound host authority. Admin tokens cannot
      // download a host assignment and host tokens cannot administer artifacts.
      if (req.method === "GET" && p.length === 4 && p[2] === "artifacts") return { body: download(db, req, digest(p[3])) };
      requireAdmin(req);
      if (p[2] === "releases") {
        if (req.method === "POST" && p.length === 3) return { body: register(db, req) };
        if (req.method === "GET" && p.length === 3) return { body: { releases: db.prepare("SELECT envelope FROM update_releases ORDER BY created,id").all().map(row => parseSignedRelease(JSON.parse(String(row.envelope)))) } };
        if (req.method === "GET" && p.length === 4) return { body: envelope(db, uuid(p[3])) };
      }
      if (p[2] === "artifacts" && req.method === "POST" && p.length === 4) return { body: upload(db, digest(p[3]), req.body) };
      if (p[2] === "rollouts") {
        if (req.method === "POST" && p.length === 3) return { body: rollout(db, req.body) };
        if (req.method === "GET" && p.length === 3) return { body: { rollouts: db.prepare("SELECT * FROM update_rollouts ORDER BY created,id").all().map(row => rolloutView(db, row)) } };
        if (p.length >= 4) {
          const row = db.prepare("SELECT * FROM update_rollouts WHERE id=?").get(uuid(p[3]));
          if (!row) return refuse(404);
          if (req.method === "GET" && p.length === 4) return { body: rolloutView(db, row) };
          if (req.method === "POST" && p.length === 5 && p[4] === "cancel") {
            fields(req.body, []);
            const jobs = db.prepare("SELECT * FROM host_update_jobs WHERE rollout=?").all(row.id!);
            // Once delivered, only a positive host receipt can remove the drain.
            if (jobs.some(job => !terminal.includes(job.phase as typeof terminal[number]) && (job.delivered !== 0 || job.phase !== "queued"))) return refuse(409);
            db.prepare("UPDATE host_update_jobs SET phase='cancelled',updated=? WHERE rollout=? AND phase='queued' AND delivered=0").run(store.clock(), row.id!);
            return { body: rolloutView(db, row) };
          }
        }
      }
      return refuse(404);
    });
  } };
}
