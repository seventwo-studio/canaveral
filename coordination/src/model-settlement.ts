import type { DatabaseSync } from "node:sqlite";
import { ServiceError } from "./errors.ts";

/** Settlement of queued model calls that end without admission. Deliberately import-free beyond errors
 * so application revocation (consumers.ts) can settle in its own transaction without a module cycle.
 */
const table = (db: DatabaseSync, name: string): boolean => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);

/** Closes a job that was never assigned. Cancellation closes as cancelled; expiry and rejection close as failed. */
function closeUnassigned(db: DatabaseSync, application: string, id: string, cancelled: boolean, now: number): void {
  db.prepare(`UPDATE model_jobs SET state=?,cancel_requested=?,stopped=1,cleanup='complete',closed=1,updated=?
    WHERE application=? AND id=? AND closed=0 AND NOT EXISTS (SELECT 1 FROM model_assignments a WHERE a.application=model_jobs.application AND a.job=model_jobs.id)`)
    .run(cancelled ? "cancelled" : "failed", cancelled ? 1 : 0, now, application, id);
}

function waitingRequest(db: DatabaseSync, application: string, id: string): { deadline: number | null } | undefined {
  if (!table(db, "requests")) return undefined;
  return db.prepare("SELECT deadline FROM requests WHERE application=? AND id=? AND kind='model-job' AND state='waiting'").get(application, id) as { deadline: number | null } | undefined;
}

/** Waiting intent at or past its deadline expires; the unassigned job closes in the same transaction. */
export function expireModelRequest(db: DatabaseSync, application: string, id: string, now: number): boolean {
  const waiting = waitingRequest(db, application, id);
  if (!waiting || waiting.deadline === null || now < waiting.deadline) return false;
  db.prepare("UPDATE requests SET state='expired',reason='deadline' WHERE application=? AND id=?").run(application, id);
  closeUnassigned(db, application, id, false, now);
  return true;
}

/** Every waiting model call at or past its deadline expires and its unassigned job closes. Runs before a claim
 * reads the queue, so overdue intent is never admitted and never occupies a queue head.
 */
export function expireModelRequests(db: DatabaseSync, now: number): void {
  if (!table(db, "requests")) return;
  const due = db.prepare("SELECT application,id FROM requests WHERE kind='model-job' AND state='waiting' AND deadline<=?").all(now) as Array<{ application: string; id: string }>;
  for (const row of due) expireModelRequest(db, row.application, row.id, now);
}

/** Shared consumer, request and administrator cancellation. Waiting intent closes without execution
 * (expiry wins at its deadline); claimed reservations require runner receipts.
 */
export function cancelModelJob(db: DatabaseSync, application: string, id: string, now: number, reason = "consumer_cancelled"): void {
  const job = db.prepare("SELECT state,cancel_requested FROM model_jobs WHERE application=? AND id=?").get(application, id);
  if (!job) throw new ServiceError("Unknown model job.", 404);
  if (expireModelRequest(db, application, id, now)) return;
  if (["succeeded", "failed", "cancelled"].includes(String(job.state)) || job.cancel_requested) return;
  if (db.prepare("SELECT 1 FROM model_assignments WHERE application=? AND job=?").get(application, id)) {
    db.prepare("UPDATE model_jobs SET cancel_requested=1,updated=? WHERE application=? AND id=?").run(now, application, id);
    return;
  }
  if (waitingRequest(db, application, id)) db.prepare("UPDATE requests SET state='cancelled',reason=? WHERE application=? AND id=?").run(reason, application, id);
  closeUnassigned(db, application, id, true, now);
}

/** Request-pass hook after revocation and expiry: rejects waiting model calls whose grant is gone and
 * closes every unassigned job whose request ended without admission. Absent tables mean no model calls.
 */
export function settleModelRequests(db: DatabaseSync, now: number): void {
  if (!table(db, "requests") || !table(db, "model_jobs") || !table(db, "model_grants")) return;
  db.prepare(`UPDATE requests SET state='rejected',reason='model_grant_revoked' WHERE kind='model-job' AND state='waiting'
    AND NOT EXISTS (SELECT 1 FROM model_grants g WHERE g.application=requests.application AND g.model=json_extract(requests.intent,'$.model')
      AND g.digest=json_extract(requests.intent,'$.digest') AND g.revoked=0)`).run();
  const ended = db.prepare(`SELECT r.application,r.id,r.state FROM requests r JOIN model_jobs j ON j.application=r.application AND j.id=r.id
    WHERE r.kind='model-job' AND r.state IN ('cancelled','expired','rejected') AND j.closed=0`).all() as Array<{ application: string; id: string; state: string }>;
  for (const row of ended) closeUnassigned(db, row.application, row.id, row.state === "cancelled", now);
}

/** Revocation hook for one application, run in the revoking transaction. Queued model calls settle through
 * their requests; direct submissions have no request, so their unassigned jobs close here: as cancelled when
 * the application is revoked, as failed when only the grant is. Assigned work keeps its reservation.
 */
export function closeRevokedModelJobs(db: DatabaseSync, application: string, now: number): void {
  if (!table(db, "model_jobs") || !table(db, "requests")) return;
  settleModelRequests(db, now);
  const revoked = !table(db, "consumers") || !db.prepare("SELECT 1 FROM consumers WHERE id=? AND revoked=0").get(application);
  const rows = db.prepare(`SELECT j.id FROM model_jobs j WHERE j.application=? AND j.closed=0
    AND NOT EXISTS (SELECT 1 FROM requests r WHERE r.application=j.application AND r.id=j.id AND r.kind='model-job')
    AND NOT EXISTS (SELECT 1 FROM model_assignments a WHERE a.application=j.application AND a.job=j.id)
    AND (? OR NOT EXISTS (SELECT 1 FROM model_grants g WHERE g.application=j.application AND g.model=j.model AND g.digest=j.digest AND g.revoked=0))`)
    .all(application, revoked ? 1 : 0) as Array<{ id: string }>;
  for (const row of rows) closeUnassigned(db, application, row.id, revoked, now);
}
/** Startup catch-up for direct jobs left open by revocations made before this rule existed. */
export function closeAllRevokedModelJobs(db: DatabaseSync, now: number): void {
  if (!table(db, "model_jobs") || !table(db, "requests") || !table(db, "model_grants")) return;
  const consumers = table(db, "consumers");
  const applications = db.prepare(`SELECT DISTINCT j.application FROM model_jobs j WHERE j.closed=0
    AND (${consumers ? "NOT EXISTS (SELECT 1 FROM consumers c WHERE c.id=j.application AND c.revoked=0) OR " : ""}
      NOT EXISTS (SELECT 1 FROM model_grants g WHERE g.application=j.application AND g.model=j.model AND g.digest=j.digest AND g.revoked=0))`).all() as Array<{ application: string }>;
  for (const { application } of applications) closeRevokedModelJobs(db, application, now);
}
