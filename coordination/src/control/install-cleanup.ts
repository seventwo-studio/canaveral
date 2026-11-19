/** Positive cleanup evidence for dispatched `install-uploaded` attempts.
 * Shared by artifact deletion, repeat installs, machine deletion and lease artifact release;
 * it imports no control module so lifecycle, lease and artifact modules can all depend on it. */
import type { DatabaseSync } from 'node:sqlite';
import { object } from '../errors.ts';

export interface InstallAttempt { id: string; state: string; result: string | null }

function tableExists(db: DatabaseSync, name: string): boolean { return db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name) !== undefined; }

/** Operator decisions are append-only: one per operation, never edited or removed. */
export function initializeInstallResolutions(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS device_operation_resolutions (id TEXT PRIMARY KEY,operation TEXT NOT NULL UNIQUE,
    decision TEXT NOT NULL,inspection TEXT,reason TEXT NOT NULL,decided_by TEXT NOT NULL,created REAL NOT NULL)`);
}

/** A leased emulator's proven cleanup stopped its whole process group and removed its storage,
 * so no package session staged on it can remain. */
export function leaseStorageRemoved(db: DatabaseSync, machineId: string): boolean {
  return tableExists(db, 'lease_cleanup_members') && db.prepare("SELECT 1 FROM lease_cleanup_members WHERE machine=? AND state='complete'").get(machineId) !== undefined;
}

/** Clean means: never dispatched, succeeded with positive artifact cleanup, its leased
 * emulator was proven stopped and removed, or an explicit operator resolution exists.
 * Absence of a dispatch record is not cleanup. `confirmedOnly` excludes `abandoned`
 * decisions, whose stage may still exist; repeat installs of the same artifact use it so
 * one reservation never covers two stages. */
export function installAttemptClean(db: DatabaseSync, op: InstallAttempt & { machine?: string }, confirmedOnly = false): boolean {
  if (op.state === 'queued') return false;
  if (db.prepare('SELECT 1 FROM control_device_pending WHERE id=?').get(op.id)) return true;
  // A lease operation the runner never received is recorded as not dispatched.
  if (tableExists(db, 'consumer_operations') && db.prepare('SELECT 1 FROM consumer_operations WHERE id=? AND dispatched=0').get(op.id)) return true;
  const result = op.result ? object(JSON.parse(op.result)) : {};
  if (op.state === 'succeeded' && result.artifactCleaned === true) return true;
  const machine = op.machine ?? (db.prepare('SELECT machine FROM device_operations WHERE id=?').get(op.id) as { machine: string } | undefined)?.machine;
  if (machine !== undefined && leaseStorageRemoved(db, machine)) return true;
  if (!tableExists(db, 'device_operation_resolutions')) return false;
  const decision = (db.prepare('SELECT decision FROM device_operation_resolutions WHERE operation=?').get(op.id) as { decision: string } | undefined)?.decision;
  return decision !== undefined && (!confirmedOnly || decision === 'cleanup-confirmed');
}

export function installAttempts(db: DatabaseSync, machineId: string, artifactId?: string): InstallAttempt[] {
  if (!tableExists(db, 'device_operations')) return [];
  const filter = artifactId === undefined ? '' : " AND json_extract(request,'$.arguments.artifact')=?";
  return db.prepare(`SELECT id,machine,state,result FROM device_operations WHERE machine=? AND json_extract(request,'$.action')='install-uploaded'${filter}`)
    .all(...(artifactId === undefined ? [machineId] : [machineId, artifactId])) as unknown as InstallAttempt[];
}

/** True while any install on this machine is queued or lacks positive cleanup or a resolution. */
export function unresolvedInstall(db: DatabaseSync, machineId: string): boolean {
  return installAttempts(db, machineId).some(op => !installAttemptClean(db, op));
}

/** Releases the uploads of ended leases once every install attempt of each is clean. An upload
 * never installed has no native stage; an attempted one waits for its own positive cleanup or
 * the lease's proven emulator removal. Run inside the transaction that observes lease state. */
export function releaseLeaseArtifacts(db: DatabaseSync): void {
  if (!['app_artifacts', 'leases'].every(name => tableExists(db, name))) return;
  const rows = db.prepare(`SELECT a.id,a.machine FROM app_artifacts a JOIN leases l ON l.id=a.lease
    WHERE a.state!='deleted' AND l.state NOT IN ('provisioning','ready')`).all() as { id: string; machine: string }[];
  for (const a of rows) {
    if (installAttempts(db, a.machine, a.id).some(op => !installAttemptClean(db, op))) continue;
    db.prepare('DELETE FROM app_artifact_chunks WHERE artifact=?').run(a.id);
    db.prepare("UPDATE app_artifacts SET state='deleted',reserved_disk=0 WHERE id=?").run(a.id);
  }
}

/** Host scratch held by an application's lease uploads, released only by the rules above. */
export function applicationArtifactDisk(db: DatabaseSync, applicationId: string): number {
  if (!['app_artifacts', 'leases'].every(name => tableExists(db, name))) return 0;
  return Number(db.prepare("SELECT COALESCE(SUM(a.reserved_disk),0) AS n FROM app_artifacts a JOIN leases l ON l.id=a.lease WHERE l.consumer=? AND a.state!='deleted'").get(applicationId)!.n);
}
