import type { DatabaseSync } from "node:sqlite";
import type { ObservabilitySettings } from "../observability.ts";
import { installAttemptClean } from "./install-cleanup.ts";

/** Read-only controller diagnosis for `canaveral doctor`.
 *
 * Every query runs on a read-only SQLite connection supplied by the caller, so a diagnosis cannot
 * change state, advance a lifecycle or take the write lock. It reports what the ledgers say now:
 * it does not contact hosts, repeat an operation or decide an uncertain outcome. Each finding has a
 * stable `code` and a next step for an operator. Findings are bounded per category; `omitted`
 * counts what was left out. Controller state only: nothing here is native runtime acceptance.
 */
export type Severity = "error" | "warning" | "notice";
export interface Finding {
  code: string; severity: Severity; subject: { type: string; id: string }; summary: string; nextStep: string;
  details?: Record<string, string | number | boolean | null>;
}
export interface Diagnosis {
  generatedAt: string; findings: Finding[]; omitted: number;
  checked: { hosts: number; activeLeases: number; waitingRequests: number; updateJobs: number; alertDestinations: number };
}
/** Stable finding codes. The CLI adds the connection codes; the rest come from controller state. */
export const FINDING_CODES: Record<string, string> = {
  controller_unreachable: "The controller did not answer at the configured origin.",
  controller_tls_untrusted: "The controller certificate was not accepted.",
  controller_tls_expiring: "The controller certificate expires soon.",
  controller_plain_http: "The controller is reached over plain HTTP outside loopback.",
  credential_missing: "No credential file was supplied.",
  credential_rejected: "The controller rejected the credential.",
  credential_not_administrator: "The credential lacks administrator authority.",
  diagnosis_unavailable: "The controller did not return a diagnosis.",
  controller_recently_started: "The controller started moments ago and has not heard from every host yet.",
  host_offline: "A host has not reported within the freshness window.",
  host_draining: "A host is set to refuse new placements.",
  host_maintenance: "A host has an active maintenance drain.",
  host_checks_failed: "A host's environment checks are failing.",
  host_checks_stale: "A host's environment checks are too old to admit placements.",
  host_checks_missing: "A host does not report environment checks.",
  lease_cleanup_blocked: "Lease cleanup is blocked and its reservations stay held.",
  lease_cleanup_pending: "An ended lease has waited a long time for its cleanup proof.",
  operation_outcome_unknown: "An operation ended with an unknown outcome.",
  install_outcome_unknown: "An app installation has an unknown outcome and no resolution.",
  request_waiting: "A request is waiting for admission.",
  request_waiting_long: "A request has waited longer than the configured threshold.",
  update_job_uncertain: "A host update job has an uncertain outcome.",
  update_job_failed: "A host update job failed or rolled back.",
  update_job_active: "A host update job is in progress.",
  alert_delivery_failing: "Alerts to a destination are failing.",
};
const HOST_FRESH_SECONDS = 30, CHECK_FRESH_SECONDS = 120, RECENT_SECONDS = 86400, CLEANUP_PATIENCE_SECONDS = 900, PER_CATEGORY = 50;
/** After a restart every host looks silent until it reports again; the observer waits the same time. */
export const LIVENESS_GRACE_SECONDS = 45;
/** Operation receipts are never pruned. Partial indexes keep the diagnosis from reading all of them to
 * find the few with an unknown outcome. Call once those tables exist. */
export function diagnosisIndexes(db: DatabaseSync): void {
  if (table(db, "device_operations")) db.exec("CREATE INDEX IF NOT EXISTS device_operations_unknown ON device_operations(updated) WHERE state='unknown'");
  if (table(db, "linux_operations")) db.exec("CREATE INDEX IF NOT EXISTS linux_operations_unknown ON linux_operations(updated) WHERE state='unknown'");
}
const table = (db: DatabaseSync, name: string): boolean => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
const age = (seconds: number): string => seconds < 120 ? `${Math.round(seconds)}s` : seconds < 7200 ? `${Math.round(seconds / 60)}m` : `${Math.round(seconds / 3600)}h`;
function json(value: unknown): Record<string, unknown> {
  try { const parsed: unknown = JSON.parse(String(value)); return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}; } catch { return {}; }
}
const label = (value: unknown): string => typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 100) : "";

/** `started` is when this controller process began observing. Until LIVENESS_GRACE_SECONDS have passed, a host
 * that has not reported since then is not called offline: its silence may only be the controller's own downtime. */
export function diagnose(db: DatabaseSync, now: number, settings: ObservabilitySettings, started = Number.NEGATIVE_INFINITY): Diagnosis {
  const findings: Finding[] = []; let omitted = 0;
  const bounded = <T>(rows: T[], add: (row: T) => void): void => { for (const row of rows.slice(0, PER_CATEGORY)) add(row); omitted += Math.max(0, rows.length - PER_CATEGORY); };
  const checked = { hosts: 0, activeLeases: 0, waitingRequests: 0, updateJobs: 0, alertDestinations: 0 };

  if (table(db, "hosts")) {
    const retired = table(db, "retired_runners") ? new Set(db.prepare("SELECT id FROM retired_runners").all().map(row => String(row.id))) : new Set<string>();
    const hosts = db.prepare("SELECT id,offer,seen,enabled FROM hosts ORDER BY id").all().filter(row => !retired.has(String(row.id)));
    checked.hosts = hosts.length;
    const settling = now - started < LIVENESS_GRACE_SECONDS;
    let unheard = 0;
    for (const host of hosts) {
      const id = String(host.id), name = label(json(host.offer).name), subject = { type: "host", id }, named = name ? `Host ${name}` : `Host ${id}`;
      const silent = now - Number(host.seen);
      if (silent >= HOST_FRESH_SECONDS && settling && Number(host.seen) < started) { unheard++; continue; }
      if (silent >= HOST_FRESH_SECONDS) {
        findings.push({ code: "host_offline", severity: "error", subject, summary: `${named} has not reported for ${age(silent)}.`,
          nextStep: "Check the host service and its route to the controller. Its placements stay pinned and reservations stay held until it reports again.",
          details: { lastSeenAt: new Date(Number(host.seen) * 1000).toISOString(), silentSeconds: Math.round(silent) } });
        continue;
      }
      if (Number(host.enabled) === 0) findings.push({ code: "host_draining", severity: "notice", subject, summary: `${named} refuses new placements.`,
        nextStep: `Run \`canaveral accept ${id}\` when it should take new work again.` });
      const drain = table(db, "host_maintenance") ? db.prepare("SELECT id,created_at FROM host_maintenance WHERE host=? AND phase='draining'").get(id) : undefined;
      if (drain) findings.push({ code: "host_maintenance", severity: "notice", subject, summary: `${named} has an active maintenance drain.`,
        nextStep: `Follow \`canaveral maintenance status ${id}\` and resume the drain when it reports readyToResume.`, details: { drainId: String(drain.id) } });
      const health = table(db, "host_health") ? db.prepare("SELECT report,received FROM host_health WHERE host=?").get(id) : undefined;
      if (!health?.report) {
        findings.push({ code: "host_checks_missing", severity: "notice", subject, summary: `${named} does not report environment checks.`,
          nextStep: "Upgrade the runner so placement can use the health admission gate." });
        continue;
      }
      const report = json(health.report), stale = now - Number(health.received);
      if (report.status === "failed") {
        const failing = (Array.isArray(report.checks) ? report.checks : []).filter(check => json(JSON.stringify(check)).status === "failed").map(check => label(json(JSON.stringify(check)).id)).filter(Boolean).slice(0, 5);
        findings.push({ code: "host_checks_failed", severity: "error", subject, summary: `${named} fails ${failing.length ? failing.join(", ") : "its environment checks"}.`,
          nextStep: "Repair the failing prerequisites listed in the host's environment checks, then request a new check run. Failed checks block new placements and restarts.",
          details: { failedChecks: failing.length } });
      } else if (stale >= CHECK_FRESH_SECONDS) findings.push({ code: "host_checks_stale", severity: "warning", subject, summary: `${named} last completed its environment checks ${age(stale)} ago.`,
        nextStep: "Checks older than 120 seconds block new placements. Request a check run; restart the host service if results do not refresh.",
        details: { checkedSecondsAgo: Math.round(stale) } });
    }
    if (unheard) findings.push({ code: "controller_recently_started", severity: "notice", subject: { type: "controller", id: "controller" },
      summary: `The controller started ${age(now - started)} ago and ${unheard} host${unheard === 1 ? " has" : "s have"} not reported since; ${unheard === 1 ? "its" : "their"} state is not judged yet.`,
      nextStep: `Run doctor again in ${Math.max(1, Math.ceil(LIVENESS_GRACE_SECONDS - (now - started)))} seconds. A host that is still silent then is reported as offline.`,
      details: { startedSecondsAgo: Math.round(now - started), hostsNotYetHeard: unheard } });
  }
  if (table(db, "leases")) checked.activeLeases += Number(db.prepare("SELECT count(*) AS n FROM leases WHERE state IN ('provisioning','ready')").get()!.n);
  if (table(db, "linux_leases")) checked.activeLeases += Number(db.prepare("SELECT count(*) AS n FROM linux_leases WHERE state IN ('provisioning','ready')").get()!.n);
  if (table(db, "lease_cleanup_members")) bounded(db.prepare("SELECT lease,machine,reason,attempts,next_retry FROM lease_cleanup_members WHERE state='blocked' ORDER BY updated,lease").all(), row => {
    findings.push({ code: "lease_cleanup_blocked", severity: "error", subject: { type: "lease", id: String(row.lease) },
      summary: `Cleanup of lease ${String(row.lease)} is blocked (${row.reason === null ? "no reason reported" : String(row.reason)}) after ${Number(row.attempts)} attempts.`,
      nextStep: "Inspect the lease and its host for the reported reason. Reservations stay held until the runner proves stop, storage removal and credential erasure; do not remove storage by hand.",
      details: { machineId: String(row.machine), reason: row.reason === null ? null : String(row.reason), attempts: Number(row.attempts), retryAt: Number(row.next_retry) ? new Date(Number(row.next_retry) * 1000).toISOString() : null } });
  });
  if (table(db, "linux_leases")) bounded(db.prepare("SELECT id FROM linux_leases WHERE cleanup='blocked' ORDER BY id").all(), row => {
    findings.push({ code: "lease_cleanup_blocked", severity: "error", subject: { type: "lease", id: String(row.id) }, summary: `Cleanup of Linux lease ${String(row.id)} is blocked.`,
      nextStep: "Inspect the lease and its runner. The reservation stays held until the runner reports stopped execution, removed storage and erased credentials." });
  });
  if (table(db, "usage_leases")) {
    const pending = db.prepare("SELECT lease,ledger,ended FROM usage_leases WHERE ended IS NOT NULL AND ended<? AND cleaned IS NULL ORDER BY ended LIMIT 500").all(now - CLEANUP_PATIENCE_SECONDS).filter(row => {
      const ledgerTable = row.ledger === "linux" ? "linux_leases" : "leases";
      const lease = table(db, ledgerTable) ? db.prepare(`SELECT cleanup FROM ${ledgerTable} WHERE id=?`).get(String(row.lease)) : undefined;
      return lease && lease.cleanup !== "complete" && lease.cleanup !== "blocked";
    });
    bounded(pending, row => findings.push({ code: "lease_cleanup_pending", severity: "warning", subject: { type: "lease", id: String(row.lease) },
      summary: `Lease ${String(row.lease)} ended ${age(now - Number(row.ended))} ago and its cleanup is not proven.`,
      nextStep: "Check that its host or runner is online and reporting. Reservations stay held until the cleanup receipt arrives.",
      details: { endedAt: new Date(Number(row.ended) * 1000).toISOString() } }));
  }

  if (table(db, "device_operations")) {
    const installs = table(db, "control_device_pending") ? db.prepare("SELECT id,machine,state,result FROM device_operations WHERE state='unknown' AND json_valid(request) AND json_extract(request,'$.action')='install-uploaded' ORDER BY updated").all()
      .filter(row => !installAttemptClean(db, { id: String(row.id), state: String(row.state), result: row.result === null ? null : String(row.result), machine: String(row.machine) })) : [];
    bounded(installs, row => findings.push({ code: "install_outcome_unknown", severity: "error", subject: { type: "operation", id: String(row.id) },
      summary: `App installation ${String(row.id)} on machine ${String(row.machine)} has an unknown outcome and no resolution.`,
      nextStep: "Inspect the device with an inspect-install operation, then record the decision through `canaveral operation ID --resolve-file FILE`. Do not repeat the install under a new UUID.",
      details: { machineId: String(row.machine) } }));
    const unresolved = new Set(installs.map(row => String(row.id)));
    bounded(db.prepare("SELECT id,machine,updated,CASE WHEN json_valid(request) THEN json_extract(request,'$.action') END AS action FROM device_operations WHERE state='unknown' AND updated>=? ORDER BY updated DESC").all(now - RECENT_SECONDS)
      .filter(row => row.action !== "install-uploaded" && !unresolved.has(String(row.id))), row => findings.push({ code: "operation_outcome_unknown", severity: "warning", subject: { type: "operation", id: String(row.id) },
      summary: `Device operation ${String(row.id)} (${label(row.action) || "unknown action"}) ended with an unknown outcome ${age(now - Number(row.updated))} ago.`,
      nextStep: "Inspect the device state before any further action. An uncertain operation is never replayed; submit a new operation only once its effect is known.",
      details: { machineId: String(row.machine) } }));
  }
  if (table(db, "linux_operations")) bounded(db.prepare("SELECT id,lease,updated FROM linux_operations WHERE state='unknown' AND updated>=? ORDER BY updated DESC").all(now - RECENT_SECONDS), row => {
    findings.push({ code: "operation_outcome_unknown", severity: "warning", subject: { type: "operation", id: String(row.id) },
      summary: `Command operation ${String(row.id)} of lease ${String(row.lease)} ended with an unknown outcome ${age(now - Number(row.updated))} ago.`,
      nextStep: "Inspect the workspace before submitting further commands. An uncertain command is never replayed.", details: { leaseId: String(row.lease) } });
  });

  if (table(db, "requests")) {
    const waiting = db.prepare("SELECT application,id,kind,reason,created,priority FROM requests WHERE state='waiting' ORDER BY created,id").all();
    checked.waitingRequests = waiting.length;
    bounded(waiting, row => {
      const waited = now - Number(row.created), long = waited >= settings.requestWaitAlertSeconds, reason = row.reason === null ? "not yet attempted" : String(row.reason);
      findings.push({ code: long ? "request_waiting_long" : "request_waiting", severity: long ? "warning" : "notice", subject: { type: "request", id: String(row.id) },
        summary: `Request ${String(row.id)} (${String(row.kind)}) has waited ${age(waited)}; last admission answer: ${reason}.`,
        nextStep: reason === "capacity_unavailable" ? "No eligible host has capacity. Check for offline, draining or failing hosts, or release finished leases."
          : reason === "limit_exceeded" ? "The application's limits are full. Release finished leases or raise its limits by replacing the application policy."
            : reason === "host_draining" ? "The only eligible host is draining. Resume it or wait for the maintenance to finish."
              : "Inspect the request and its application; it stays waiting until capacity, limits and grants allow admission or its deadline passes.",
        details: { applicationId: String(row.application), requestKind: String(row.kind), reason: row.reason === null ? null : String(row.reason), waitedSeconds: Math.round(waited), priority: Number(row.priority) } });
    });
  }

  if (table(db, "host_update_jobs")) {
    const jobs = db.prepare("SELECT id,rollout,host,target_kind,phase,uncertain,updated FROM host_update_jobs ORDER BY updated DESC").all();
    checked.updateJobs = jobs.length;
    const finished = ["succeeded", "rolledBack", "failed", "cancelled"];
    bounded(jobs.filter(job => job.phase === "unknown" || (Number(job.uncertain) === 1 && !finished.includes(String(job.phase)))), job => findings.push({ code: "update_job_uncertain", severity: "error",
      subject: { type: "update-job", id: String(job.id) }, summary: `Update job ${String(job.id)} on host ${String(job.host)} has an uncertain outcome.`,
      nextStep: "Inspect the host's installed release and service state before another rollout. The host keeps its update drain until the job is decided.",
      details: { rolloutId: String(job.rollout), hostId: String(job.host), targetKind: String(job.target_kind), phase: String(job.phase) } }));
    bounded(jobs.filter(job => (job.phase === "failed" || job.phase === "rolledBack") && Number(job.updated) >= now - RECENT_SECONDS), job => findings.push({ code: "update_job_failed", severity: "warning",
      subject: { type: "update-job", id: String(job.id) }, summary: `Update job ${String(job.id)} on host ${String(job.host)} ended ${String(job.phase)}.`,
      nextStep: "Read the job's component states with `canaveral updates`, fix the cause on the host and start a new rollout.",
      details: { rolloutId: String(job.rollout), hostId: String(job.host), targetKind: String(job.target_kind), phase: String(job.phase) } }));
    bounded(jobs.filter(job => !finished.includes(String(job.phase)) && job.phase !== "unknown" && Number(job.uncertain) !== 1), job => findings.push({ code: "update_job_active", severity: "notice",
      subject: { type: "update-job", id: String(job.id) }, summary: `Update job ${String(job.id)} on host ${String(job.host)} is ${String(job.phase)}.`,
      nextStep: "Wait for the job to reach a terminal phase; the host admits no new work while its update drain is held.",
      details: { rolloutId: String(job.rollout), hostId: String(job.host), targetKind: String(job.target_kind), phase: String(job.phase) } }));
  }

  if (table(db, "alert_destinations") && table(db, "alert_deliveries")) {
    const destinations = db.prepare("SELECT id,name FROM alert_destinations WHERE removed IS NULL ORDER BY id").all();
    checked.alertDestinations = destinations.length;
    for (const destination of destinations) {
      const failed = Number(db.prepare("SELECT count(*) AS n FROM alert_deliveries WHERE destination=? AND state='failed' AND updated>=?").get(String(destination.id), now - RECENT_SECONDS)!.n);
      if (failed) findings.push({ code: "alert_delivery_failing", severity: "warning", subject: { type: "alert-destination", id: String(destination.id) },
        summary: `${failed} alert${failed === 1 ? "" : "s"} to ${label(destination.name)} could not be delivered in the last 24 hours.`,
        nextStep: `Run \`canaveral alerts test ${String(destination.id)}\` and check the receiver; remove and re-add the destination if its URL or secret changed.`, details: { failedDeliveries: failed } });
    }
  }
  const rank: Record<Severity, number> = { error: 0, warning: 1, notice: 2 };
  findings.sort((a, b) => rank[a.severity] - rank[b.severity] || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0) || (a.subject.id < b.subject.id ? -1 : a.subject.id > b.subject.id ? 1 : 0));
  return { generatedAt: new Date(now * 1000).toISOString(), findings, omitted, checked };
}
