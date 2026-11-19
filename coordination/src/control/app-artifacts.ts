import { requireHostAdmission } from "./maintenance.ts";
/** Machine-scoped CI build delivery. Payloads stay in bounded, private SQLite chunks.
 * The same upload, verification, install and cleanup rules serve the administrative routes
 * here and the lease-key routes in lease-app-artifacts.ts; an upload belongs to exactly one. */
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { ServiceError, object } from '../errors.ts';
import type { SqliteStore } from '../sqlite.ts';
import { owns, requireScope } from './contracts.ts';
import type { ControlModule, ControlRequest, Principal } from './contracts.ts';
import { MachineStore, registerMachineHooks } from './machines.ts';
import { installAttemptClean, installAttempts } from './install-cleanup.ts';
import { decodeData, uuid } from './transfers.ts';

import { APP_CHUNK_BYTES, APP_ARTIFACT_BYTES } from '../app-artifact-contract.ts';
export { APP_CHUNK_BYTES, APP_ARTIFACT_BYTES } from '../app-artifact-contract.ts';
export const STORAGE_BYTES = 8 * 1024 ** 3;
const reservationSql = 'SELECT 0 AS cpu,0 AS memoryMiB,COALESCE(SUM(reserved_disk),0) AS diskGiB FROM app_artifacts WHERE host=? AND state!=\'deleted\'';
export type Artifact = { id: string; machine: string; host: string; binding: string; format: string; bytes: number; sha256: string; received: number; state: string; reserved_disk: number; lease: string | null };
const fail = (status = 400): never => { throw new ServiceError('App artifact request rejected.', status); };
export function fields(body: Record<string, unknown>, keys: string[]): void { if (Object.keys(body).length !== keys.length || keys.some(key => !Object.hasOwn(body, key))) fail(); }
function integer(value: unknown, min: number, max: number): number { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) return fail(); return value; }
export function artifactRow(db: DatabaseSync, id: string): Artifact { return db.prepare('SELECT * FROM app_artifacts WHERE id=?').get(uuid(id)) as unknown as Artifact ?? fail(404); }
function machine(db: DatabaseSync, id: string, principal?: Principal) {
  const m = db.prepare('SELECT m.*,h.enabled FROM machines m JOIN hosts h ON h.id=m.host WHERE m.id=?').get(uuid(id));
  if (!m || principal && !owns(principal, m.owner)) return fail(404);
  return m;
}
function binding(m: Record<string, unknown>): string { return createHash('sha256').update(JSON.stringify([m.id, m.host, m.owner, m.template, m.request])).digest('hex'); }
function current(db: DatabaseSync, artifact: Artifact, principal?: Principal) {
  const m = machine(db, artifact.machine, principal);
  if (m.host !== artifact.host || binding(m) !== artifact.binding) return fail(409);
  return m;
}
export function artifactView(a: Artifact) {
  return { id: a.id, machineId: a.machine, ...(a.lease ? { leaseId: a.lease } : {}), format: a.format, bytes: a.bytes, sha256: a.sha256, received: a.received, state: a.state, chunkBytes: APP_CHUNK_BYTES };
}
function leaseLive(db: DatabaseSync, leaseId: string, now: number): boolean {
  const lease = db.prepare('SELECT state,expires FROM leases WHERE id=?').get(leaseId);
  return !!lease && lease.state === 'ready' && now < Number(lease.expires);
}

/** Called in the operation submission transaction, before a durable queue entry exists.
 * A lease operation names its own lease; administrative installs cannot use lease uploads. */
export function validateUploadedArtifact(db: DatabaseSync, machineId: string, artifactId: unknown, leaseId: string | null = null): void {
  const a = artifactRow(db, uuid(artifactId)); current(db, a);
  if (a.machine !== machineId || a.state !== 'ready' || a.lease !== leaseId) fail(409);
  // An abandoned stage may still exist; only confirmed cleanup admits another install.
  if (installAttempts(db, a.machine, a.id).some(op => !installAttemptClean(db, op, true))) fail(409);
}

function requireCleanAttempts(db: DatabaseSync, a: Artifact): void {
  if (installAttempts(db, a.machine, a.id).some(op => !installAttemptClean(db, op))) fail(409);
}

export function initializeAppArtifacts(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS app_artifacts (
    id TEXT PRIMARY KEY,machine TEXT NOT NULL,host TEXT NOT NULL,binding TEXT NOT NULL,format TEXT NOT NULL,
    bytes INTEGER NOT NULL,sha256 TEXT NOT NULL,received INTEGER NOT NULL,state TEXT NOT NULL,reserved_disk INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS app_artifact_chunks (artifact TEXT NOT NULL,offset INTEGER NOT NULL,data BLOB NOT NULL,PRIMARY KEY(artifact,offset));`);
  // Additive: uploads made through a lease key name that lease; administrative uploads keep NULL.
  if (!(db.prepare('PRAGMA table_info(app_artifacts)').all() as { name: string }[]).some(column => column.name === 'lease')) db.exec('ALTER TABLE app_artifacts ADD COLUMN lease TEXT');
}

/** Scratch to reserve on the device host: archive + extracted bytes, plus bounded metadata headroom. */
export function scratchGiB(bytes: number): number { return 1 + Math.ceil(2 * bytes / 1024 ** 3); }
/** Shared intent validation. Returns the saved receipt for an exact replay, or the new upload's reservation. */
export function reserveArtifact(db: DatabaseSync, machines: MachineStore, m: Record<string, unknown>, body: Record<string, unknown>, lease: string | null,
  replay: (old: Artifact) => void): { replayed: Artifact } | { id: string; format: string; size: number; sha: string; reserved: number } {
  const id = uuid(body.id), template = object(JSON.parse(String(m.template)));
  const format = body.format, size = integer(body.bytes, 1, APP_ARTIFACT_BYTES), sha = body.sha256;
  if (format !== (template.os === 'android' ? 'apk' : template.os === 'ios' ? 'ios-app-tar' : null) || typeof sha !== 'string' || !/^[a-f0-9]{64}$/.test(sha)) return fail();
  const old = db.prepare('SELECT * FROM app_artifacts WHERE id=?').get(id) as unknown as Artifact | undefined;
  if (old) { replay(old); current(db, old); if (old.machine !== m.id || old.lease !== lease || old.format !== format || old.bytes !== size || old.sha256 !== sha) return fail(409); return { replayed: old }; }
  // Maintenance closes new administrative uploads; a lease upload is part of its admitted lease.
  if (lease === null) requireHostAdmission(db, String(m.host));
  const used = Number(db.prepare("SELECT COALESCE(SUM(bytes),0) AS n FROM app_artifacts WHERE state!='deleted'").get()!.n);
  if (used + size > STORAGE_BYTES || Number(db.prepare("SELECT COUNT(*) AS n FROM app_artifacts WHERE state!='deleted'").get()!.n) >= 128) return fail(429);
  const reserved = scratchGiB(size);
  if (machines.remainingCapacity(db, String(m.host)).diskGiB < reserved) return fail(409);
  return { id, format: String(format), size, sha, reserved };
}
export function insertArtifact(db: DatabaseSync, m: Record<string, unknown>, intent: { id: string; format: string; size: number; sha: string; reserved: number }, lease: string | null): Artifact {
  db.prepare("INSERT INTO app_artifacts (id,machine,host,binding,format,bytes,sha256,received,state,reserved_disk,lease) VALUES (?,?,?,?,?,?,?,0,'uploading',?,?)")
    .run(intent.id, String(m.id), String(m.host), binding(m), intent.format, intent.size, intent.sha, intent.reserved, lease);
  return artifactRow(db, intent.id);
}
/** Chunk append, publication and payload removal. The caller authorized `a` for its route. */
export function changeArtifact(db: DatabaseSync, a: Artifact, action: string, body: Record<string, unknown>): Artifact {
  current(db, a);
  if (action === 'chunks') {
    fields(body, ['offset','data']);
    if (a.state !== 'uploading') return fail(409);
    const offset = integer(body.offset, 0, a.bytes - 1), data = decodeData(body.data, APP_CHUNK_BYTES);
    if (data.length !== Math.min(APP_CHUNK_BYTES, a.bytes - offset) || offset % APP_CHUNK_BYTES) return fail();
    const previous = db.prepare('SELECT data FROM app_artifact_chunks WHERE artifact=? AND offset=?').get(a.id, offset);
    if (previous) { if (!(previous.data instanceof Uint8Array) || !Buffer.from(previous.data).equals(data)) return fail(409); return a; }
    if (offset !== a.received) return fail(409);
    db.prepare('INSERT INTO app_artifact_chunks VALUES (?,?,?)').run(a.id, offset, data);
    db.prepare('UPDATE app_artifacts SET received=received+? WHERE id=?').run(data.length, a.id);
  } else {
    fields(body, []);
    if (action === 'complete') {
      if (a.state === 'ready') return a;
      if (a.state !== 'uploading' || a.received !== a.bytes) return fail(409);
      const hash = createHash('sha256'); let length = 0;
      for (const part of db.prepare('SELECT offset,data FROM app_artifact_chunks WHERE artifact=? ORDER BY offset').iterate(a.id)) {
        if (part.offset !== length || !(part.data instanceof Uint8Array)) return fail(409);
        hash.update(part.data); length += part.data.byteLength;
      }
      if (length !== a.bytes || hash.digest('hex') !== a.sha256) return fail(409);
      db.prepare("UPDATE app_artifacts SET state='ready' WHERE id=?").run(a.id);
    } else {
      // A dispatched failure/unknown may retain native staging; require positive
      // cleanup or an explicit, audited operator resolution (devices.ts).
      requireCleanAttempts(db, a);
      db.prepare('DELETE FROM app_artifact_chunks WHERE artifact=?').run(a.id);
      db.prepare("UPDATE app_artifacts SET state='deleted',reserved_disk=0 WHERE id=?").run(a.id);
    }
  }
  return artifactRow(db, a.id);
}

export function createAppArtifactsModule(store: SqliteStore, machines: MachineStore): ControlModule {
  store.transaction(initializeAppArtifacts);
  registerMachineHooks(store, {
    additionalReservationsSql: { id: 'app-artifact-scratch-v1', query: reservationSql },
    additionalReservations: (db, host) => ({ diskGiB: Number(db.prepare(reservationSql).get(host)!.diskGiB) }),
  });
  return { handle(req: ControlRequest) {
    const p = req.parts;
    const hostRead = req.method === 'GET' && p[0] === 'v1' && p[1] === 'hosts' && p[3] === 'app-artifacts' && p[5] === 'operations' && (p.length === 7 || p.length === 9 && p[7] === 'chunks');
    const create = req.method === 'POST' && p.length === 4 && p[0] === 'v1' && p[1] === 'machines' && p[3] === 'app-artifacts';
    const access = p[0] === 'v1' && p[1] === 'app-artifacts' && (p.length === 3 && req.method === 'GET' || p.length === 4 && req.method === 'POST' && ['chunks','complete','delete'].includes(p[3]!));
    if (!hostRead && !create && !access) return undefined;
    if (req.query.size) return fail();
    return store.transaction(db => {
      if (hostRead) {
        const hostId = uuid(p[2]); machines.authenticateHost(hostId, req.token);
        const a = artifactRow(db, p[4]!), m = current(db, a);
        const op = db.prepare('SELECT * FROM device_operations WHERE id=?').get(uuid(p[6]));
        if (!op || a.host !== hostId || m.enabled !== 1 || m.desired !== 'running' || m.observed !== 'running' || a.state !== 'ready' || op.machine !== a.machine || op.host !== hostId || op.state !== 'queued') return fail(403);
        const request = object(JSON.parse(String(op.request)));
        if (request.action !== 'install-uploaded' || object(request.arguments).artifact !== a.id || store.clock() >= Number(op.created) + 1800) return fail(403);
        // A lease upload is readable only by that lease's own install, and only while the lease is live.
        if (a.lease !== null) {
          const scoped = db.prepare('SELECT lease FROM consumer_operations WHERE id=?').get(String(op.id));
          if (scoped?.lease !== a.lease || !leaseLive(db, a.lease, store.clock())) return fail(403);
        }
        if (p.length === 7) return { body: artifactView(a) };
        if (!/^(0|[1-9][0-9]*)$/.test(p[8]!)) return fail();
        const offset = integer(Number(p[8]), 0, a.bytes - 1);
        const chunk = db.prepare('SELECT data FROM app_artifact_chunks WHERE artifact=? AND offset=?').get(a.id, offset);
        if (!chunk || !(chunk.data instanceof Uint8Array)) return fail(404);
        return { body: { offset, data: Buffer.from(chunk.data).toString('base64') } };
      }
      const principal = requireScope(req, 'access');
      if (create) {
        fields(req.body, ['id','format','bytes','sha256']);
        const m = machine(db, p[2]!, principal);
        // Leased machines take uploads only through their lease key (lease-app-artifacts.ts).
        if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='lease_members'").get() && db.prepare('SELECT 1 FROM lease_members WHERE machine=?').get(m.id!)) return fail(409);
        const reserved = reserveArtifact(db, machines, m, req.body, null, old => { current(db, old, principal); });
        if ('replayed' in reserved) return { body: artifactView(reserved.replayed) };
        return { body: artifactView(insertArtifact(db, m, reserved, null)), status: 201 };
      }
      const a = artifactRow(db, p[2]!); current(db, a, principal);
      // Lease uploads belong to their lease key alone.
      if (a.lease !== null) return fail(404);
      if (req.method === 'GET') return { body: artifactView(a) };
      return { body: artifactView(changeArtifact(db, a, p[3]!, req.body)) };
    });
  } };
}
