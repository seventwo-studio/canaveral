/** Cleanup evidence for administrative native-video sessions. Shared by video admission
 * and machine deletion; it imports no control module so lifecycle can depend on it.
 *
 * A session holds its reservation until the runner reports positive native cleanup
 * (`cleaned=1`). An administrator may instead abandon a disconnected, uncleaned session.
 * Abandonment never claims cleanup: it unblocks only machine deletion, keeps blocking
 * another capture on that machine, and keeps the reservation until that deletion completes. */
import type { DatabaseSync } from 'node:sqlite';

/** Append-only: one administrator decision per session, never edited or removed. */
export function initializeVideoResolutions(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS mobile_video_session_resolutions (session TEXT PRIMARY KEY,
    decision TEXT NOT NULL,reason TEXT NOT NULL,decided_by TEXT NOT NULL,created REAL NOT NULL)`);
}

const abandoned = 'EXISTS (SELECT 1 FROM mobile_video_session_resolutions r WHERE r.session=v.id)';
/** Host-level predicate over alias `v`: the session still holds host capacity and a slot. */
export const HELD_VIDEO_SESSION = `v.cleaned=0 AND NOT (${abandoned} AND EXISTS (SELECT 1 FROM machine_deletions d WHERE d.machine=v.machine AND d.state='complete'))`;

function tableExists(db: DatabaseSync, name: string): boolean { return db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name) !== undefined; }

/** True while a session on this machine is live, or ended without positive cleanup or an
 * administrator abandonment. Deleting the machine would remove the device the runner
 * still has to stop and prove clean. */
export function unresolvedVideoSession(db: DatabaseSync, machineId: string): boolean {
  if (!tableExists(db, 'mobile_video_sessions')) return false;
  const filter = tableExists(db, 'mobile_video_session_resolutions') ? ` AND NOT ${abandoned}` : '';
  return db.prepare(`SELECT 1 FROM mobile_video_sessions v WHERE v.machine=? AND v.cleaned=0${filter}`).get(machineId) !== undefined;
}
