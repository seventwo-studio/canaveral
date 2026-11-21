/** Cleanup evidence for native-video sessions. Shared by video admission, lease accounting
 * and machine deletion; it imports no control module so lifecycle and leases can depend on it.
 *
 * A session holds its reservation until the runner reports positive native cleanup
 * (`cleaned=1`). An administrator may instead abandon a disconnected, uncleaned session.
 * Abandonment never claims cleanup: it unblocks only machine deletion, keeps blocking
 * another capture on that machine, and keeps the reservation until that deletion completes.
 *
 * Lease sessions (`lease` set) record a leased emulator through the lease key. Their guest
 * recorder is also proven gone by the lease's own positive cleanup, which stops the whole
 * emulator process group and removes its storage; the runner must still report that its own
 * encoder exited (`host_cleaned`). Only both together count as cleanup. */
import type { DatabaseSync } from 'node:sqlite';

/** Append-only: one administrator decision per session, never edited or removed. */
export function initializeVideoResolutions(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS mobile_video_session_resolutions (session TEXT PRIMARY KEY,
    decision TEXT NOT NULL,reason TEXT NOT NULL,decided_by TEXT NOT NULL,created REAL NOT NULL)`);
}

const abandoned = 'EXISTS (SELECT 1 FROM mobile_video_session_resolutions r WHERE r.session=v.id)';
/** The device the session recorded is gone: an ordinary deletion, or a lease's proven cleanup. */
const removed = `(EXISTS (SELECT 1 FROM machine_deletions d WHERE d.machine=v.machine AND d.state='complete') OR
  EXISTS (SELECT 1 FROM lease_cleanup_members c WHERE c.machine=v.machine AND c.state='complete'))`;
/** Host-level predicate over alias `v`: the session still holds host capacity and a slot. */
export const HELD_VIDEO_SESSION = `v.cleaned=0 AND NOT (${abandoned} AND ${removed})`;

/** Capacity predicate over alias `v`: a held session that takes a host slot and a reservation of
 * its own. A device runs one native capture, so a running live capture shares the slot and
 * reservation of a recording of the same device and counts by itself again once that recording
 * is clean. An ended live capture always counts until its cleanup is proven: its encoder may
 * still run. Use HELD_VIDEO_SESSION to ask what still awaits cleanup. */
export const COUNTED_VIDEO_SESSION = `${HELD_VIDEO_SESSION} AND NOT (v.kind='live' AND v.state IN ('pending','attaching','ready')
  AND EXISTS (SELECT 1 FROM mobile_video_sessions o WHERE o.machine=v.machine AND o.kind='record' AND o.cleaned=0))`;

function tableExists(db: DatabaseSync, name: string): boolean { return db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name) !== undefined; }

/** True while a session on this machine is live, or ended without positive cleanup or an
 * administrator abandonment. Deleting the machine would remove the device the runner
 * still has to stop and prove clean. */
export function unresolvedVideoSession(db: DatabaseSync, machineId: string): boolean {
  if (!tableExists(db, 'mobile_video_sessions')) return false;
  const filter = tableExists(db, 'mobile_video_session_resolutions') ? ` AND NOT ${abandoned}` : '';
  return db.prepare(`SELECT 1 FROM mobile_video_sessions v WHERE v.machine=? AND v.cleaned=0${filter}`).get(machineId) !== undefined;
}

/** Records positive cleanup for ended lease sessions whose runner confirmed its own encoder
 * exit and whose emulator the lease's cleanup proved stopped and removed. Run inside the
 * transaction that observes lease cleanup. A live session is never cleaned here. */
export function settleLeaseVideoSessions(db: DatabaseSync): void {
  if (!['mobile_video_sessions', 'lease_cleanup_members'].every(name => tableExists(db, name))) return;
  db.prepare(`UPDATE mobile_video_sessions SET cleaned=1 WHERE cleaned=0 AND lease IS NOT NULL AND host_cleaned=1
    AND state NOT IN ('pending','attaching','ready')
    AND EXISTS (SELECT 1 FROM lease_cleanup_members c WHERE c.machine=mobile_video_sessions.machine AND c.state='complete')`).run();
}

/** Records positive cleanup for the ended live capture of an owned Android device whose runner
 * confirmed its own encoder exit, once that device's host reports it stopped. The host reports
 * `stopped` only after the emulator process has exited, and the guest recorder ran inside that
 * process. A capture needs a running device, so a later `stopped` is always the exit of the
 * emulator that held its recorder. Stopping a watched device ends the runner's authority to
 * signal the recorder; without this rule every such capture would need abandonment.
 *
 * Not for iOS, whose capture source is a host process the simulator's stop does not end, and not
 * for recordings, whose cleanup rules are unchanged. Leased captures settle through the lease. */
export function settleStoppedLiveCaptures(db: DatabaseSync): void {
  if (!['mobile_video_sessions', 'machines'].every(name => tableExists(db, name))) return;
  db.prepare(`UPDATE mobile_video_sessions SET cleaned=1 WHERE cleaned=0 AND kind='live' AND lease IS NULL AND host_cleaned=1
    AND state NOT IN ('pending','attaching','ready')
    AND EXISTS (SELECT 1 FROM machines m WHERE m.id=mobile_video_sessions.machine AND m.observed='stopped' AND json_extract(m.template,'$.os')='android')`).run();
}

/** Each held lease session reserves one CPU and 256 MiB; it counts against its application. */
export const VIDEO_SESSION_RESERVATION = { cpu: 1, memoryMiB: 256 } as const;
export function applicationVideoUsage(db: DatabaseSync, applicationId: string): { cpu: number; memoryMiB: number } {
  if (!['mobile_video_sessions', 'mobile_video_session_resolutions', 'leases', 'machine_deletions', 'lease_cleanup_members'].every(name => tableExists(db, name))) return { cpu: 0, memoryMiB: 0 };
  const held = Number(db.prepare(`SELECT COUNT(*) AS n FROM mobile_video_sessions v JOIN leases l ON l.id=v.lease WHERE l.consumer=? AND ${COUNTED_VIDEO_SESSION}`).get(applicationId)!.n);
  return { cpu: held * VIDEO_SESSION_RESERVATION.cpu, memoryMiB: held * VIDEO_SESSION_RESERVATION.memoryMiB };
}
