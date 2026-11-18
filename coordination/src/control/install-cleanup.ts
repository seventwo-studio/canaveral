/** Positive cleanup evidence for dispatched `install-uploaded` attempts.
 * Shared by artifact deletion, repeat installs and machine deletion; it imports no
 * control module so lifecycle and artifact modules can both depend on it. */
import type { DatabaseSync } from 'node:sqlite';
import { object } from '../errors.ts';

export interface InstallAttempt { id: string; state: string; result: string | null }

function tableExists(db: DatabaseSync, name: string): boolean { return db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name) !== undefined; }

/** Operator decisions are append-only: one per operation, never edited or removed. */
export function initializeInstallResolutions(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS device_operation_resolutions (id TEXT PRIMARY KEY,operation TEXT NOT NULL UNIQUE,
    decision TEXT NOT NULL,inspection TEXT,reason TEXT NOT NULL,decided_by TEXT NOT NULL,created REAL NOT NULL)`);
}

/** Clean means: never dispatched, succeeded with positive artifact cleanup, or an
 * explicit operator resolution exists. Absence of a dispatch record is not cleanup. */
export function installAttemptClean(db: DatabaseSync, op: InstallAttempt): boolean {
  if (op.state === 'queued') return false;
  if (db.prepare('SELECT 1 FROM control_device_pending WHERE id=?').get(op.id)) return true;
  const result = op.result ? object(JSON.parse(op.result)) : {};
  if (op.state === 'succeeded' && result.artifactCleaned === true) return true;
  return tableExists(db, 'device_operation_resolutions') && !!db.prepare('SELECT 1 FROM device_operation_resolutions WHERE operation=?').get(op.id);
}

export function installAttempts(db: DatabaseSync, machineId: string, artifactId?: string): InstallAttempt[] {
  if (!tableExists(db, 'device_operations')) return [];
  const filter = artifactId === undefined ? '' : " AND json_extract(request,'$.arguments.artifact')=?";
  return db.prepare(`SELECT id,state,result FROM device_operations WHERE machine=? AND json_extract(request,'$.action')='install-uploaded'${filter}`)
    .all(...(artifactId === undefined ? [machineId] : [machineId, artifactId])) as unknown as InstallAttempt[];
}

/** True while any install on this machine is queued or lacks positive cleanup or a resolution. */
export function unresolvedInstall(db: DatabaseSync, machineId: string): boolean {
  return installAttempts(db, machineId).some(op => !installAttemptClean(db, op));
}
