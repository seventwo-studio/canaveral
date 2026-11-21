import type { DatabaseSync } from "node:sqlite";
import { identifier } from "./consumers.ts";
import { ServiceError } from "./errors.ts";
import type { EventProjection } from "./events.ts";

/** Usage reporting from durable state.
 *
 * Request figures are read from the `requests` ledger, whose records the controller never prunes.
 * Lease figures are read from `usage_leases`, a compact ledger with one row per lease, maintained
 * from lease events in the transaction that records them. It exists because neither lease ledger
 * stores when a lease became ready or ended. It is retained for `usageRetentionSeconds` after a
 * lease ends, independently of the shorter event-log retention.
 *
 * Counts and percentiles describe the cohort that started in the range (requests submitted, leases
 * admitted). Device-seconds measure lease time that falls inside the range, whenever the lease was
 * admitted. Leases that ended before this ledger first started are not in it.
 * Portable figures only: they describe controller state, not measured device utilisation.
 */
export const DEFAULT_USAGE_RETENTION_SECONDS = 400 * 86400;
export const USAGE_MAX_RANGE_SECONDS = 400 * 86400;
/** Requests plus leases one report may read. A report runs inside the control worker's single transaction,
 * so a range that holds more is refused instead of stalling every other request. */
export const USAGE_MAX_ROWS = 200_000;
export type UsageGroup = "application" | "template" | "platform" | "host";
export interface UsageQuery { from: number; to: number; groupBy: UsageGroup; application?: string }
export interface Distribution { p50: number | null; p95: number | null; samples: number }
export interface RequestUsage { submitted: number; admitted: number; cancelled: number; expired: number; rejected: number; waiting: number; waitSeconds: Distribution }
export interface LeaseUsage {
  admitted: number; ready: number; released: number; expired: number; failed: number; active: number; cleanupBlocked: number;
  deviceSeconds: number; timeToReadySeconds: Distribution; holdSeconds: Distribution;
}
export interface UsageRow { key: string; label?: string; requests?: RequestUsage; leases: LeaseUsage }
export interface UsageReport {
  from: string; to: string; groupBy: UsageGroup; generatedAt: string; applicationId?: string;
  retention: { requestRecords: "not pruned"; leaseLedgerSeconds: number; leaseLedgerStartedAt: string | null };
  rows: UsageRow[]; totals: UsageRow;
}
interface LedgerRow {
  lease: string; ledger: string; application: string; template: string | null; revision: string | null; arch: string | null; platform: string | null;
  host: string | null; domain: string | null; admitted: number; ready: number | null; ended: number | null; outcome: string | null; cleanup_blocked: number;
}

const tableExists = (db: DatabaseSync, name: string): boolean => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
export function usageSchema(db: DatabaseSync, now: number): void {
  db.exec(`CREATE TABLE IF NOT EXISTS usage_leases (
      lease TEXT PRIMARY KEY, ledger TEXT NOT NULL, application TEXT NOT NULL, template TEXT, revision TEXT, arch TEXT, platform TEXT,
      host TEXT, domain TEXT, admitted REAL NOT NULL, ready REAL, ended REAL, outcome TEXT, reason TEXT,
      cleanup_blocked INTEGER NOT NULL DEFAULT 0, cleaned REAL);
    CREATE INDEX IF NOT EXISTS usage_leases_admitted ON usage_leases(admitted);
    CREATE INDEX IF NOT EXISTS usage_leases_ended ON usage_leases(ended);
    CREATE INDEX IF NOT EXISTS usage_leases_uncleaned ON usage_leases(ended) WHERE cleaned IS NULL AND ended IS NOT NULL;
    CREATE TABLE IF NOT EXISTS usage_state (id INTEGER PRIMARY KEY CHECK(id=1), started REAL NOT NULL);`);
  // The longest hold ever recorded. It lets a report find leases carried into its range by looking back
  // only that far, instead of at every lease admitted before it. It never decreases, so it stays an upper bound.
  if (!(db.prepare("PRAGMA table_info(usage_state)").all() as Array<{ name: string }>).some(column => column.name === "max_hold")) {
    db.exec("ALTER TABLE usage_state ADD COLUMN max_hold REAL NOT NULL DEFAULT 0");
    db.exec("UPDATE usage_state SET max_hold=coalesce((SELECT max(ended-admitted) FROM usage_leases WHERE ended IS NOT NULL),0)");
  }
  db.prepare("INSERT OR IGNORE INTO usage_state (id,started) VALUES (1,?)").run(now);
}
/** Indexes on the request ledger that reports read by time. The requests table belongs to another module
 * and is never pruned, so without them every report would scan all of it. Call once that table exists. */
export function usageIndexes(db: DatabaseSync): void {
  if (tableExists(db, "requests")) db.exec(`CREATE INDEX IF NOT EXISTS requests_created ON requests(created);
    CREATE INDEX IF NOT EXISTS requests_application_created ON requests(application,created);`);
}
/** Leases that were already active when the ledger was first installed keep their exact admission time. */
export function backfillActiveLeases(db: DatabaseSync): void {
  if (["leases", "lease_members", "machines"].every(name => tableExists(db, name))) db.exec(`INSERT OR IGNORE INTO usage_leases (lease,ledger,application,template,revision,arch,platform,host,admitted)
    SELECT l.id,'generic',l.consumer,json_extract(m.template,'$.id'),json_extract(m.template,'$.revision'),json_extract(m.template,'$.arch'),json_extract(m.template,'$.os'),m.host,l.created
    FROM leases l JOIN lease_members lm ON lm.lease=l.id JOIN machines m ON m.id=lm.machine
    WHERE l.state IN ('provisioning','ready') AND json_valid(m.template) GROUP BY l.id`);
  if (tableExists(db, "linux_leases")) db.exec(`INSERT OR IGNORE INTO usage_leases (lease,ledger,application,template,revision,arch,platform,host,domain,admitted)
    SELECT id,'linux',application,image_id,image_revision,arch,'linux',${tableExists(db, "physical_domains") ? "(SELECT host FROM physical_domains p WHERE p.domain=linux_leases.domain)" : "NULL"},domain,created
    FROM linux_leases WHERE state IN ('provisioning','ready')`);
}
const text = (value: unknown): string | null => typeof value === "string" && value.length <= 200 ? value : null;
export const usageProjection: EventProjection = (db, events) => {
  for (const event of events) {
    if (!event.lease || !event.kind.startsWith("lease.") || event.kind === "lease.refused" || event.kind === "lease.renewed") continue;
    let data: Record<string, unknown> = {};
    try { data = JSON.parse(event.data) as Record<string, unknown>; } catch { /* Counted without attributes. */ }
    if (event.kind === "lease.admitted") {
      if (!event.application) continue;
      const linux = data.ledger === "linux" && tableExists(db, "linux_leases") ? db.prepare("SELECT domain FROM linux_leases WHERE id=?").get(event.lease) : undefined;
      db.prepare("INSERT OR IGNORE INTO usage_leases (lease,ledger,application,template,revision,arch,platform,host,domain,admitted) VALUES (?,?,?,?,?,?,?,?,?,?)")
        .run(event.lease, data.ledger === "linux" ? "linux" : "generic", event.application, text(data.templateId), text(data.templateRevision), text(data.arch), text(data.platform),
          event.host, linux?.domain === undefined ? null : String(linux.domain), event.at);
    } else if (event.kind === "lease.ready") db.prepare("UPDATE usage_leases SET ready=? WHERE lease=? AND ready IS NULL").run(event.at, event.lease);
    else if (["lease.released", "lease.expired", "lease.failed"].includes(event.kind)) {
      db.prepare("UPDATE usage_leases SET ended=?,outcome=?,reason=? WHERE lease=? AND ended IS NULL").run(event.at, event.kind.slice(6), text(data.reason), event.lease);
      db.prepare("UPDATE usage_state SET max_hold=max(max_hold,coalesce((SELECT ended-admitted FROM usage_leases WHERE lease=?),0)) WHERE id=1").run(event.lease);
    } else if (event.kind === "lease.cleanup_blocked") db.prepare("UPDATE usage_leases SET cleanup_blocked=cleanup_blocked+1 WHERE lease=?").run(event.lease);
    else if (event.kind === "lease.cleanup_proven") db.prepare("UPDATE usage_leases SET cleaned=? WHERE lease=? AND cleaned IS NULL").run(event.at, event.lease);
  }
};
export function pruneUsage(db: DatabaseSync, now: number, retentionSeconds: number): number {
  return Number(db.prepare("DELETE FROM usage_leases WHERE ended IS NOT NULL AND ended<?").run(now - retentionSeconds).changes);
}

function instant(value: string, label: string): number {
  const time = Date.parse(value);
  if (!/^\d{4}-\d\d-\d\dT.*Z$/.test(value) || !Number.isFinite(time)) throw new ServiceError(`${label} must be UTC RFC3339.`, 400, { code: "usage_range_invalid" });
  return time / 1000;
}
/** Default range: the 24 hours before now. An application may not group by host. */
export function parseUsageQuery(query: URLSearchParams, now: number, scope: "admin" | "application"): UsageQuery & { format: "json" | "csv" } {
  const allowed = scope === "admin" ? ["from", "to", "groupBy", "format", "application"] : ["from", "to", "groupBy", "format"];
  for (const key of query.keys()) if (!allowed.includes(key) || query.getAll(key).length > 1) throw new ServiceError("Unsupported usage query parameter.", 400);
  const to = query.has("to") ? instant(query.get("to")!, "to") : now, from = query.has("from") ? instant(query.get("from")!, "from") : to - 86400;
  if (!(from < to) || to - from > USAGE_MAX_RANGE_SECONDS) throw new ServiceError("Usage range must be positive and at most 400 days.", 400, { code: "usage_range_invalid" });
  const groupBy = query.get("groupBy") ?? "application", groups = scope === "admin" ? ["application", "template", "platform", "host"] : ["application", "template", "platform"];
  if (!groups.includes(groupBy)) throw new ServiceError("Unsupported usage grouping.", 400, { code: "usage_group_unsupported" });
  const format = query.get("format") ?? "json";
  if (format !== "json" && format !== "csv") throw new ServiceError("Usage format must be json or csv.", 400);
  return { from, to, groupBy: groupBy as UsageGroup, format, ...(query.has("application") ? { application: identifier(query.get("application")) } : {}) };
}

function distribution(values: number[]): Distribution {
  if (!values.length) return { p50: null, p95: null, samples: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  // Nearest rank: the smallest observed value with at least p percent of samples at or below it.
  const rank = (p: number) => Number(sorted[Math.max(0, Math.ceil(p / 100 * sorted.length) - 1)]!.toFixed(3));
  return { p50: rank(50), p95: rank(95), samples: sorted.length };
}
class Accumulator {
  requests = { submitted: 0, admitted: 0, cancelled: 0, expired: 0, rejected: 0, waiting: 0 };
  waits: number[] = [];
  leases = { admitted: 0, ready: 0, released: 0, expired: 0, failed: 0, active: 0, cleanupBlocked: 0, deviceSeconds: 0 };
  readies: number[] = []; holds: number[] = [];
  row(key: string, withRequests: boolean, label?: string): UsageRow {
    return { key, ...(label ? { label } : {}), ...(withRequests ? { requests: { ...this.requests, waitSeconds: distribution(this.waits) } } : {}),
      leases: { ...this.leases, deviceSeconds: Number(this.leases.deviceSeconds.toFixed(3)), timeToReadySeconds: distribution(this.readies), holdSeconds: distribution(this.holds) } };
  }
}

export function usageReport(db: DatabaseSync, query: UsageQuery, now: number, retentionSeconds = DEFAULT_USAGE_RETENTION_SECONDS, maxRows = USAGE_MAX_ROWS): UsageReport {
  const groups = new Map<string, Accumulator>(), total = new Accumulator();
  const group = (key: string) => { let found = groups.get(key); if (!found) { found = new Accumulator(); groups.set(key, found); } return found; };
  const withRequests = query.groupBy !== "host";
  const template = (id: unknown, revision: unknown, arch: unknown) => typeof id === "string" ? `${id}@${String(revision ?? "?")}/${String(arch ?? "?")}` : "unknown";
  const platforms = new Map<string, string>();
  const platform = (id: unknown, revision: unknown, arch: unknown): string => {
    const key = template(id, revision, arch);
    if (!platforms.has(key)) {
      const row = tableExists(db, "templates") && typeof id === "string" ? db.prepare("SELECT json_extract(definition,'$.os') AS os FROM templates WHERE id=? AND revision=? AND arch=? AND json_valid(definition)").get(id, String(revision), String(arch)) : undefined;
      platforms.set(key, typeof row?.os === "string" ? row.os : "unknown");
    }
    return platforms.get(key)!;
  };
  // Count through the indexes first, stopping just past the limit, so an oversized range costs no more than the limit.
  const tooLarge = () => new ServiceError("This range holds too many requests and leases for one report; ask for a shorter range.", 400, { code: "usage_range_too_large" });
  const scoped = query.application ? " AND application=?" : "", scope = query.application ? [query.application] : [];
  let budget = maxRows;
  const within = (sql: string, ...parameters: Array<string | number>): void => {
    budget -= Number(db.prepare(`SELECT count(*) AS n FROM (${sql} LIMIT ?)`).get(...parameters, budget + 1)!.n);
    if (budget < 0) throw tooLarge();
  };
  // A lease counts in the range when it was admitted in it, or was admitted earlier and was still held when
  // the range began. An ended lease can only have been carried in if it was admitted within the longest hold
  // ever recorded before the range, so each of the three reads is a bounded walk of an index on `admitted`.
  const longest = tableExists(db, "usage_state") ? Number(db.prepare("SELECT max_hold FROM usage_state WHERE id=1").get()?.max_hold ?? 0) : 0;
  const leaseReads: Array<[string, Array<string | number>]> = tableExists(db, "usage_leases") ? [
    [`SELECT * FROM usage_leases WHERE admitted>=? AND admitted<?${scoped}`, [query.from, query.to, ...scope]],
    [`SELECT * FROM usage_leases WHERE admitted>=? AND admitted<? AND ended>?${scoped}`, [query.from - longest, query.from, query.from, ...scope]],
    [`SELECT * FROM usage_leases WHERE ended IS NULL AND admitted<?${scoped}`, [query.from, ...scope]],
  ] : [];
  if (withRequests && tableExists(db, "requests")) within(`SELECT 1 FROM requests WHERE created>=? AND created<?${scoped}`, query.from, query.to, ...scope);
  for (const [sql, parameters] of leaseReads) within(sql.replace("SELECT *", "SELECT 1"), ...parameters);
  if (withRequests && tableExists(db, "requests")) {
    const rows = db.prepare(`SELECT application,kind,state,created,admitted_at,
        CASE WHEN json_valid(intent) THEN json_extract(intent,'$.templateId') END AS template,CASE WHEN json_valid(intent) THEN json_extract(intent,'$.templateRevision') END AS revision,
        CASE WHEN json_valid(intent) THEN json_extract(intent,'$.arch') END AS arch,CASE WHEN json_valid(intent) THEN json_extract(intent,'$.model') END AS model
      FROM requests WHERE created>=? AND created<?${query.application ? " AND application=?" : ""}`).all(query.from, query.to, ...(query.application ? [query.application] : []));
    for (const r of rows) {
      const key = query.groupBy === "application" ? String(r.application)
        : query.groupBy === "template" ? r.kind === "model-job" ? `model:${String(r.model ?? "unknown")}` : template(r.template, r.revision, r.arch)
        : r.kind === "model-job" ? "model" : r.kind === "linux-lease" ? "linux" : platform(r.template, r.revision, r.arch);
      for (const target of [group(key), total]) {
        target.requests.submitted++;
        if (r.state === "admitted" || r.state === "cancelled" || r.state === "expired" || r.state === "rejected" || r.state === "waiting") target.requests[r.state]++;
        if (r.state === "admitted" && r.admitted_at !== null) target.waits.push(Math.max(0, Number(r.admitted_at) - Number(r.created)));
      }
    }
  }
  for (const [sql, parameters] of leaseReads) {
    for (const l of db.prepare(sql).all(...parameters) as unknown as LedgerRow[]) {
      const key = query.groupBy === "application" ? l.application : query.groupBy === "template" ? template(l.template, l.revision, l.arch)
        : query.groupBy === "platform" ? l.platform ?? "unknown" : l.host ?? (l.domain ? `domain:${l.domain}` : "unassigned");
      const overlap = Math.max(0, Math.min(l.ended ?? now, query.to, now) - Math.max(l.admitted, query.from));
      for (const target of [group(key), total]) {
        target.leases.deviceSeconds += overlap;
        if (l.admitted < query.from) continue;
        target.leases.admitted++;
        if (l.ready !== null) { target.leases.ready++; target.readies.push(Math.max(0, l.ready - l.admitted)); }
        if (l.ended === null) target.leases.active++;
        else { target.holds.push(Math.max(0, l.ended - l.admitted)); if (l.outcome === "released" || l.outcome === "expired" || l.outcome === "failed") target.leases[l.outcome]++; }
        if (l.cleanup_blocked > 0) target.leases.cleanupBlocked++;
      }
    }
  }
  const label = (key: string): string | undefined => {
    const row = query.groupBy === "application" && tableExists(db, "consumers") ? db.prepare("SELECT CASE WHEN json_valid(specification) THEN json_extract(specification,'$.name') END AS name FROM consumers WHERE id=?").get(key)
      : query.groupBy === "host" && tableExists(db, "hosts") ? db.prepare("SELECT CASE WHEN json_valid(offer) THEN json_extract(offer,'$.name') END AS name FROM hosts WHERE id=?").get(key) : undefined;
    return typeof row?.name === "string" ? row.name : undefined;
  };
  const started = tableExists(db, "usage_state") ? db.prepare("SELECT started FROM usage_state WHERE id=1").get() : undefined;
  return {
    from: new Date(query.from * 1000).toISOString(), to: new Date(query.to * 1000).toISOString(), groupBy: query.groupBy, generatedAt: new Date(now * 1000).toISOString(),
    ...(query.application ? { applicationId: query.application } : {}),
    retention: { requestRecords: "not pruned", leaseLedgerSeconds: retentionSeconds, leaseLedgerStartedAt: started ? new Date(Number(started.started) * 1000).toISOString() : null },
    rows: [...groups.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, value]) => value.row(key, withRequests, label(key))),
    totals: total.row("total", withRequests),
  };
}

const CSV_COLUMNS = ["group", "key", "label", "requests_submitted", "requests_admitted", "requests_cancelled", "requests_expired", "requests_rejected", "requests_waiting",
  "wait_p50_seconds", "wait_p95_seconds", "leases_admitted", "leases_ready", "leases_released", "leases_expired", "leases_failed", "leases_active", "leases_cleanup_blocked",
  "ready_p50_seconds", "ready_p95_seconds", "hold_p50_seconds", "hold_p95_seconds", "device_seconds"];
/** RFC 4180 fields. A leading formula character is neutralised: labels are operator text that a spreadsheet may open. */
function csvField(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  let field = String(value);
  if (typeof value === "string" && /^[=+\-@\t\r]/.test(field)) field = "'" + field;
  return /[",\r\n]/.test(field) ? `"${field.replaceAll('"', '""')}"` : field;
}
export function usageCsv(report: UsageReport): string {
  const line = (row: UsageRow) => [report.groupBy, row.key, row.label, row.requests?.submitted, row.requests?.admitted, row.requests?.cancelled, row.requests?.expired,
    row.requests?.rejected, row.requests?.waiting, row.requests?.waitSeconds.p50, row.requests?.waitSeconds.p95, row.leases.admitted, row.leases.ready, row.leases.released,
    row.leases.expired, row.leases.failed, row.leases.active, row.leases.cleanupBlocked, row.leases.timeToReadySeconds.p50, row.leases.timeToReadySeconds.p95,
    row.leases.holdSeconds.p50, row.leases.holdSeconds.p95, row.leases.deviceSeconds].map(csvField).join(",");
  return [CSV_COLUMNS.join(","), ...report.rows.map(line), line(report.totals)].join("\r\n") + "\r\n";
}
