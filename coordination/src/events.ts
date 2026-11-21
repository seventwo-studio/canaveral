import type { DatabaseSync } from "node:sqlite";
import { identifier } from "./consumers.ts";
import { ServiceError } from "./errors.ts";

/** Durable controller event log.
 *
 * State changes are captured by SQLite triggers on the ledger tables, so an event is written by the
 * same statement, and therefore the same transaction, as the row change it describes, whichever
 * worker or code path made it. A rolled-back change (including one admission attempt's savepoint)
 * leaves no event. Triggers cannot read the controller clock, so they insert `at` as NULL and the
 * store's commit hook stamps it before COMMIT. Conditions that no row change expresses (a host that
 * stops reporting, resource pressure, a request that waits too long) are written by the observer in
 * control/observability.ts, together with their durable condition row.
 *
 * Payloads carry identifiers, states and bounded reason codes. Credentials, hashes, command
 * arguments, operation results, provider detail text and free-text operator reasons never enter a
 * trigger. Limits: the generic lease ledger does not persist why a lease ended, so `reason` appears
 * only where the ledger implies it; a refused direct acquisition changes no state and is recorded
 * separately as `lease.refused`. Fixture coverage only; no native runtime acceptance is implied.
 */
export interface EventKind { summary: string; routine?: true; attention?: true }
export const EVENT_KINDS: Record<string, EventKind> = {
  "controller.started": { summary: "The controller opened its state and installed event capture." },
  "application.created": { summary: "An application identity was created." },
  "application.credential_rotated": { summary: "An application credential was rotated." },
  "application.revoked": { summary: "An application identity was revoked." },
  "lease.admitted": { summary: "A lease was admitted and its resources reserved; provisioning began." },
  "lease.refused": { summary: "A direct lease acquisition was refused before any state changed.", routine: true },
  "lease.ready": { summary: "Every member of a lease became ready for access." },
  "lease.renewed": { summary: "A lease deadline was extended." },
  "lease.released": { summary: "A lease was released; access ended and cleanup was requested." },
  "lease.expired": { summary: "A lease reached its deadline; access ended and cleanup was requested." },
  "lease.failed": { summary: "A lease failed during provisioning or at runtime.", attention: true },
  "lease.cleanup_blocked": { summary: "Lease cleanup is blocked; its reservations stay held.", attention: true },
  "lease.cleanup_proven": { summary: "Lease cleanup was proven and its reservations were released." },
  "request.submitted": { summary: "A waiting request was submitted." },
  "request.admitted": { summary: "A waiting request was admitted." },
  "request.cancelled": { summary: "A waiting request was cancelled." },
  "request.expired": { summary: "A waiting request passed its deadline." },
  "request.rejected": { summary: "A waiting request was permanently rejected.", attention: true },
  "request.waiting_long": { summary: "A request has waited longer than the configured threshold.", attention: true },
  "host.enrolled": { summary: "A host enrolled." },
  "host.online": { summary: "A host resumed reporting." },
  "host.offline": { summary: "A host stopped reporting within the freshness window.", attention: true },
  "host.accepting": { summary: "A host was set to accept new placements." },
  "host.draining": { summary: "A host was set to stop accepting new placements." },
  "host.maintenance_began": { summary: "A maintenance drain began on a host.", attention: true },
  "host.maintenance_resumed": { summary: "A maintenance drain was resumed and admission reopened." },
  "host.checks_failed": { summary: "Host environment checks started failing.", attention: true },
  "host.checks_passed": { summary: "Host environment checks recovered." },
  "host.limits_changed": { summary: "Host allocation limits changed." },
  "host.disk_pressure": { summary: "Free storage on a host fell below the configured threshold.", attention: true },
  "host.disk_pressure_cleared": { summary: "Free storage on a host recovered." },
  "host.memory_pressure": { summary: "Available memory on a host fell below the configured threshold.", attention: true },
  "host.memory_pressure_cleared": { summary: "Available memory on a host recovered." },
  "machine.created": { summary: "A machine or device was placed on a host." },
  "machine.desired": { summary: "The requested state of a machine or device changed." },
  "machine.observed": { summary: "The observed runtime state of a machine or device changed." },
  "machine.error": { summary: "A machine or device reported a runtime error.", attention: true },
  "machine.preparation": { summary: "Guest preparation of a machine changed state." },
  "machine.power_off_requested": { summary: "An explicit power-off was requested." },
  "machine.power_off": { summary: "An explicit power-off reached an outcome." },
  "machine.deletion_requested": { summary: "Owned storage deletion was requested." },
  "machine.deletion_blocked": { summary: "Owned storage deletion is blocked.", attention: true },
  "machine.deleted": { summary: "Owned storage deletion completed." },
  "operation.succeeded": { summary: "A device or command operation succeeded.", routine: true },
  "operation.failed": { summary: "A device or command operation failed." },
  "operation.unknown": { summary: "A device or command operation has an unknown outcome; do not replay it.", attention: true },
  "install.succeeded": { summary: "An app installation succeeded." },
  "install.failed": { summary: "An app installation failed.", attention: true },
  "install.unknown": { summary: "An app installation has an unknown outcome and needs resolution.", attention: true },
  "install.resolved": { summary: "An operator resolved an uncertain app installation." },
  "video.session_opened": { summary: "A video session was admitted." },
  "video.session_ready": { summary: "A video session became ready." },
  "video.session_ended": { summary: "A video session finished or disconnected." },
  "video.session_cleaned": { summary: "Host cleanup of a video session was confirmed." },
  "video.session_abandoned": { summary: "An administrator abandoned an unprovable video session cleanup." },
  "update.rollout_created": { summary: "A managed update rollout was created." },
  "update.job_queued": { summary: "A host update job was queued." },
  "update.job_phase": { summary: "A host update job changed phase." },
  "update.job_succeeded": { summary: "A host update job succeeded." },
  "update.job_rolled_back": { summary: "A host update job rolled back.", attention: true },
  "update.job_failed": { summary: "A host update job failed.", attention: true },
  "update.job_cancelled": { summary: "A host update job was cancelled." },
  "update.job_uncertain": { summary: "A host update job has an uncertain outcome.", attention: true },
  "admin.intervention": { summary: "An administrator recovery action was recorded." },
  "alert.destination_added": { summary: "An alert destination was added." },
  "alert.destination_removed": { summary: "An alert destination was removed." },
  "alert.delivery_failed": { summary: "An alert could not be delivered after its bounded retries." },
};
/** High-volume kinds are retained in their own, smaller tier so they cannot displace the rest. */
export const ROUTINE_KINDS = Object.entries(EVENT_KINDS).filter(([, kind]) => kind.routine).map(([name]) => name);
/** Default selection for a new alert destination. */
export const ATTENTION_KINDS = Object.entries(EVENT_KINDS).filter(([, kind]) => kind.attention).map(([name]) => name);

export interface EventRetention { maxAgeSeconds: number; maxRows: number; routineMaxRows: number }
export const DEFAULT_EVENT_RETENTION: EventRetention = { maxAgeSeconds: 30 * 86400, maxRows: 100_000, routineMaxRows: 10_000 };
export function eventRetention(value: { eventRetentionSeconds?: number; eventMaxRows?: number } = {}): EventRetention {
  const maxRows = value.eventMaxRows ?? DEFAULT_EVENT_RETENTION.maxRows;
  return { maxAgeSeconds: value.eventRetentionSeconds ?? DEFAULT_EVENT_RETENTION.maxAgeSeconds, maxRows, routineMaxRows: Math.max(100, Math.floor(maxRows / 10)) };
}

export interface EventRow {
  seq: number; at: number | null; kind: string; application: string | null; lease: string | null; request: string | null;
  host: string | null; machine: string | null; subject: string | null; data: string;
}
export interface EventView {
  sequence: number; at: string; kind: string; applicationId?: string; leaseId?: string; requestId?: string;
  hostId?: string; machineId?: string; subject?: string; data: Record<string, unknown>;
}
export interface EventInput {
  application?: string | null; lease?: string | null; request?: string | null; host?: string | null; machine?: string | null;
  subject?: string | null; data?: Record<string, unknown>;
}

function tableExists(db: DatabaseSync, name: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}
export function eventSchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, at REAL, kind TEXT NOT NULL, application TEXT, lease TEXT, request TEXT,
      host TEXT, machine TEXT, subject TEXT, data TEXT NOT NULL DEFAULT '{}');
    CREATE INDEX IF NOT EXISTS events_kind ON events(kind,seq);
    CREATE INDEX IF NOT EXISTS events_application ON events(application,seq) WHERE application IS NOT NULL;
    CREATE INDEX IF NOT EXISTS events_pending ON events(seq) WHERE at IS NULL;
    CREATE TABLE IF NOT EXISTS event_conditions (kind TEXT NOT NULL, subject TEXT NOT NULL, since REAL NOT NULL, PRIMARY KEY(kind,subject));`);
}

/** Explicit emission for conditions no trigger can see. The commit hook stamps `at`. */
export function recordEvent(db: DatabaseSync, kind: string, input: EventInput = {}): void {
  if (!Object.hasOwn(EVENT_KINDS, kind)) throw new TypeError("Unknown event kind.");
  db.prepare("INSERT INTO events(kind,application,lease,request,host,machine,subject,data) VALUES (?,?,?,?,?,?,?,?)").run(kind,
    input.application ?? null, input.lease ?? null, input.request ?? null, input.host ?? null, input.machine ?? null,
    input.subject ?? null, JSON.stringify(input.data ?? {}));
}

export type EventProjection = (db: DatabaseSync, events: Array<EventRow & { at: number }>, now: number) => void;
/** Stamp events written since the last commit and derive their projections (usage ledger, alert
 * outbox) in the same transaction. A projection failure must never abort the state change that
 * produced the event, so it is rolled back alone and the events are still stamped. */
export function projectEvents(db: DatabaseSync, now: number, projections: readonly EventProjection[] = []): number {
  const rows = db.prepare("SELECT * FROM events WHERE at IS NULL ORDER BY seq LIMIT 10000").all() as unknown as EventRow[];
  if (!rows.length) return 0;
  db.prepare("UPDATE events SET at=? WHERE at IS NULL AND seq<=?").run(now, rows.at(-1)!.seq);
  const stamped = rows.map(row => ({ ...row, at: now }));
  for (const projection of projections) {
    db.exec("SAVEPOINT canaveral_event_projection");
    try { projection(db, stamped, now); db.exec("RELEASE SAVEPOINT canaveral_event_projection"); }
    catch { db.exec("ROLLBACK TO SAVEPOINT canaveral_event_projection"); db.exec("RELEASE SAVEPOINT canaveral_event_projection"); }
  }
  return rows.length;
}
export function eventView(row: EventRow, scope: "admin" | "application" = "admin"): EventView {
  let data: Record<string, unknown> = {};
  try { const parsed: unknown = JSON.parse(row.data); if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) data = parsed as Record<string, unknown>; } catch { /* A foreign row keeps an empty payload. */ }
  return {
    sequence: row.seq, at: new Date((row.at ?? 0) * 1000).toISOString(), kind: row.kind,
    ...(row.application ? { applicationId: row.application } : {}), ...(row.lease ? { leaseId: row.lease } : {}),
    ...(row.request ? { requestId: row.request } : {}),
    // Host identity and placement are operator inventory; an application sees its lease, request and member only.
    ...(scope === "admin" && row.host ? { hostId: row.host } : {}), ...(row.machine ? { machineId: row.machine } : {}),
    ...(scope === "admin" && row.subject ? { subject: row.subject } : {}),
    data: Object.fromEntries(Object.entries(data).filter(([, value]) => value !== null)),
  };
}

export interface EventQuery {
  after?: number; tail?: number; since?: number; kinds: string[]; limit: number;
  application?: string; lease?: string; request?: string; host?: string; machine?: string;
}
/** `cursor` is the position to pass as `after` next: the last event of a full page, otherwise the head of the log.
 * `truncated` reports that retention removed events after the supplied cursor; they may or may not have matched the filter. */
export interface EventPage { events: EventView[]; cursor: number; more: boolean; truncated: boolean; oldestSequence?: number | null; latestSequence?: number }
export const EVENT_PAGE_LIMIT = 500;
const QUERY_KEYS = ["after", "tail", "since", "kind", "limit", "application", "lease", "request", "host", "machine"];

function sequence(value: string, label: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!/^(?:0|[1-9][0-9]{0,15})$/.test(value) || Number(value) > maximum) throw new ServiceError(`Invalid ${label}.`, 400);
  return Number(value);
}
/** `kind` is an exact kind or a family such as `lease.*`; unknown kinds are refused rather than silently matching nothing. */
export function eventKindFilter(value: string): string {
  if (value.endsWith(".*")) {
    const family = value.slice(0, -1);
    if (!/^[a-z]+\.$/.test(family) || !Object.keys(EVENT_KINDS).some(kind => kind.startsWith(family))) throw new ServiceError("Unknown event kind.", 400, { code: "event_kind_unknown" });
    return value;
  }
  if (!Object.hasOwn(EVENT_KINDS, value)) throw new ServiceError("Unknown event kind.", 400, { code: "event_kind_unknown" });
  return value;
}
export function parseEventQuery(query: URLSearchParams, allowed: readonly string[] = QUERY_KEYS): EventQuery {
  for (const key of query.keys()) {
    if (!allowed.includes(key)) throw new ServiceError("Unsupported event query parameter.", 400);
    if (key !== "kind" && query.getAll(key).length > 1) throw new ServiceError("Repeated event query parameter.", 400);
  }
  const kinds = query.getAll("kind").flatMap(value => value.split(",")).filter(Boolean);
  if (kinds.length > 32) throw new ServiceError("At most 32 event kinds can be selected.", 400);
  const result: EventQuery = { kinds: [...new Set(kinds.map(eventKindFilter))], limit: query.has("limit") ? sequence(query.get("limit")!, "limit", EVENT_PAGE_LIMIT) : 100 };
  if (result.limit < 1) throw new ServiceError("Invalid limit.", 400);
  if (query.has("after")) result.after = sequence(query.get("after")!, "event cursor");
  if (query.has("tail")) {
    if (query.has("after")) throw new ServiceError("Use either after or tail.", 400);
    result.tail = sequence(query.get("tail")!, "tail", EVENT_PAGE_LIMIT);
  }
  if (query.has("since")) {
    const text = query.get("since")!, time = Date.parse(text);
    if (!/^\d{4}-\d\d-\d\dT.*Z$/.test(text) || !Number.isFinite(time)) throw new ServiceError("since must be UTC RFC3339.", 400);
    result.since = time / 1000;
  }
  for (const key of ["application", "lease", "request", "host", "machine"] as const) if (query.has(key)) result[key] = identifier(query.get(key));
  return result;
}

/** Ascending by sequence. `after` is exclusive; `tail` returns the newest matching events. */
export function listEvents(db: DatabaseSync, query: EventQuery, scope: "admin" | "application" = "admin"): EventPage {
  const where: string[] = ["at IS NOT NULL"], args: Array<string | number> = [];
  if (query.kinds.length) {
    where.push("(" + query.kinds.map(kind => kind.endsWith(".*") ? "(kind>=? AND kind<?)" : "kind=?").join(" OR ") + ")");
    for (const kind of query.kinds) {
      if (kind.endsWith(".*")) args.push(kind.slice(0, -1), kind.slice(0, -2) + "/");
      else args.push(kind);
    }
  }
  for (const key of ["application", "lease", "request", "host", "machine"] as const) if (query[key] !== undefined) { where.push(`${key}=?`); args.push(query[key]); }
  if (query.since !== undefined) { where.push("at>=?"); args.push(query.since); }
  const bounds = db.prepare("SELECT min(seq) AS oldest FROM events WHERE at IS NOT NULL").get() as { oldest: number | null };
  // AUTOINCREMENT never reuses a sequence, so the high-water mark survives pruning of the newest row.
  // A row not yet stamped is not readable; the head stops before it so no cursor can step over it.
  const written = Number((db.prepare("SELECT seq FROM sqlite_sequence WHERE name='events'").get() as { seq?: number } | undefined)?.seq ?? 0);
  const unstamped = (db.prepare("SELECT min(seq) AS seq FROM events WHERE at IS NULL").get() as { seq: number | null }).seq;
  const latest = unstamped === null ? written : Math.min(written, unstamped - 1);
  const range = scope === "admin" ? { oldestSequence: bounds.oldest, latestSequence: latest } : {};
  if (query.tail !== undefined) {
    const rows = (db.prepare(`SELECT * FROM events WHERE ${where.join(" AND ")} ORDER BY seq DESC LIMIT ?`).all(...args, query.tail) as unknown as EventRow[]).reverse();
    return { events: rows.map(row => eventView(row, scope)), cursor: latest, more: false, truncated: false, ...range };
  }
  const after = query.after ?? 0;
  const rows = db.prepare(`SELECT * FROM events WHERE seq>? AND seq<=? AND ${where.join(" AND ")} ORDER BY seq LIMIT ?`).all(after, latest, ...args, query.limit + 1) as unknown as EventRow[];
  const more = rows.length > query.limit, page = rows.slice(0, query.limit);
  return {
    events: page.map(row => eventView(row, scope)),
    // Everything up to the head was examined once the last page is read, so the cursor moves there: a
    // follower with a narrow filter stays at the head instead of rescanning, and is not told it fell behind.
    cursor: more ? page.at(-1)!.seq : Math.max(after, latest), more,
    truncated: query.after !== undefined && bounds.oldest !== null && after + 1 < bounds.oldest, ...range,
  };
}

/** Age and routine-tier retention. The total row cap is enforced by a trigger on insert. */
export function pruneEvents(db: DatabaseSync, now: number, retention: EventRetention): number {
  let removed = 0;
  // Sequence order is commit order, so the oldest rows are the first to pass the age limit.
  for (let round = 0; round < 20; round++) {
    const result = db.prepare("DELETE FROM events WHERE seq IN (SELECT seq FROM events ORDER BY seq LIMIT 1000) AND at<?").run(now - retention.maxAgeSeconds);
    removed += Number(result.changes);
    if (Number(result.changes) < 1000) break;
  }
  for (const kind of ROUTINE_KINDS) {
    const boundary = db.prepare("SELECT seq FROM events WHERE kind=? ORDER BY seq DESC LIMIT 1 OFFSET ?").get(kind, retention.routineMaxRows) as { seq: number } | undefined;
    if (boundary) removed += Number(db.prepare("DELETE FROM events WHERE kind=? AND seq<=?").run(kind, boundary.seq).changes);
  }
  return removed;
}

const jx = (column: string, path: string) => `CASE WHEN json_valid(${column}) THEN json_extract(${column},'${path}') END`;
const iso = (expression: string) => `strftime('%Y-%m-%dT%H:%M:%fZ',${expression},'unixepoch')`;
/** Only bounded code-like text may leave a reason column. */
const code = (expression: string) => `CASE WHEN length(${expression}) BETWEEN 1 AND 64 AND ${expression} NOT GLOB '*[^A-Za-z0-9_.:-]*' THEN ${expression} END`;
interface Emit { kind: string; application?: string; lease?: string; request?: string; host?: string; machine?: string; subject?: string; data: Record<string, string>; from?: string; where?: string }
function emit(event: Emit): string {
  const columns = [event.kind, event.application, event.lease, event.request, event.host, event.machine, event.subject].map(value => value ?? "NULL");
  const data = Object.entries(event.data).map(([key, value]) => `'${key}',${value}`).join(",");
  return `INSERT INTO events(kind,application,lease,request,host,machine,subject,data) SELECT ${columns.join(",")},json_object(${data}) ${event.from ?? ""} ${event.where ? "WHERE " + event.where : ""};`;
}
interface TriggerDefinition { name: string; table: string; requires?: string[]; timing: string; when?: string; body: string[] }

function triggerDefinitions(has: (table: string) => boolean): TriggerDefinition[] {
  const leaseHost = "(SELECT m.host FROM lease_members lm JOIN machines m ON m.id=lm.machine WHERE lm.lease=NEW.id ORDER BY lm.name LIMIT 1)";
  const leaseMachine = "(SELECT lm.machine FROM lease_members lm WHERE lm.lease=NEW.id ORDER BY lm.name LIMIT 1)";
  const domainHost = has("physical_domains") ? "(SELECT host FROM physical_domains WHERE domain=NEW.domain)" : "NULL";
  // A leased machine, operation or session is attributed to its lease and owning application.
  const machineLease = (machine: string) => `(SELECT lease FROM lease_members WHERE machine=${machine})`;
  const machineApplication = (machine: string) => `(SELECT l.consumer FROM lease_members lm JOIN leases l ON l.id=lm.lease WHERE lm.machine=${machine})`;
  const leaseApplication = (lease: string) => `(SELECT consumer FROM leases WHERE id=${lease})`;
  const linuxApplication = (lease: string) => `(SELECT application FROM linux_leases WHERE id=${lease})`;
  const genericEndReason = `CASE NEW.state WHEN 'expired' THEN 'deadline'
      WHEN 'released' THEN CASE WHEN coalesce((SELECT revoked FROM consumers WHERE id=NEW.consumer),1)=1 THEN 'application_revoked' END
      WHEN 'failed' THEN CASE WHEN EXISTS (SELECT 1 FROM lease_members lm JOIN machines m ON m.id=lm.machine WHERE lm.lease=NEW.id AND m.observed='error') THEN 'runtime_error'
        WHEN EXISTS (SELECT 1 FROM lease_members lm JOIN machines m ON m.id=lm.machine WHERE lm.lease=NEW.id AND m.preparation_state='failed') THEN 'preparation_failed' END END`;
  const operationAction = jx("NEW.request", "$.action");
  const terminalUpdate = "CASE NEW.phase WHEN 'succeeded' THEN 'update.job_succeeded' WHEN 'failed' THEN 'update.job_failed' WHEN 'rolledBack' THEN 'update.job_rolled_back' WHEN 'cancelled' THEN 'update.job_cancelled' WHEN 'unknown' THEN 'update.job_uncertain' ELSE 'update.job_phase' END";
  const healthStatus = (row: string) => jx(`${row}.report`, "$.status");
  const failedChecks = `CASE WHEN json_valid(NEW.report) THEN (SELECT count(*) FROM json_each(NEW.report,'$.checks') WHERE json_extract(value,'$.status')='failed') END`;
  const checks = (previous: string) => [
    emit({ kind: "'host.checks_failed'", host: "NEW.host", subject: "NEW.host", data: { status: "'failed'", failedChecks },
      where: `${healthStatus("NEW")}='failed' AND coalesce(${previous},'')!='failed'` }),
    emit({ kind: "'host.checks_passed'", host: "NEW.host", subject: "NEW.host", data: { status: healthStatus("NEW") },
      where: `${healthStatus("NEW")} IN ('passed','warning') AND ${previous}='failed'` }),
  ];
  return [
    { name: "application_created", table: "consumers", timing: "AFTER INSERT", body: [
      emit({ kind: "'application.created'", application: "NEW.id", subject: "NEW.id", data: { name: jx("NEW.specification", "$.name") } })] },
    { name: "application_changed", table: "consumers", timing: "AFTER UPDATE", when: "OLD.revoked IS NOT NEW.revoked OR OLD.credential IS NOT NEW.credential", body: [
      emit({ kind: "'application.revoked'", application: "NEW.id", subject: "NEW.id", data: { revoked: "json('true')" }, where: "OLD.revoked=0 AND NEW.revoked=1" }),
      emit({ kind: "'application.credential_rotated'", application: "NEW.id", subject: "NEW.id", data: { rotated: "json('true')" }, where: "OLD.credential IS NOT NEW.credential" })] },

    // Generic ledger. Admission is recorded with its first member so the event names the placement.
    { name: "lease_admitted", table: "lease_members", requires: ["leases", "machines"], timing: "AFTER INSERT", when: "(SELECT count(*) FROM lease_members WHERE lease=NEW.lease)=1", body: [
      emit({ kind: "'lease.admitted'", application: "l.consumer", lease: "l.id", host: "m.host", machine: "NEW.machine", subject: "l.id",
        data: { ledger: "'generic'", member: "NEW.name", templateId: jx("m.template", "$.id"), templateRevision: jx("m.template", "$.revision"), arch: jx("m.template", "$.arch"),
          platform: jx("m.template", "$.os"), expiresAt: iso("l.expires") },
        from: "FROM leases l LEFT JOIN machines m ON m.id=NEW.machine", where: "l.id=NEW.lease" })] },
    { name: "lease_changed", table: "leases", requires: ["lease_members", "machines", "consumers", "lease_cleanup_members"], timing: "AFTER UPDATE",
      when: "OLD.state IS NOT NEW.state OR OLD.expires IS NOT NEW.expires OR OLD.cleanup IS NOT NEW.cleanup", body: [
        emit({ kind: "'lease.'||NEW.state", application: "NEW.consumer", lease: "NEW.id", host: leaseHost, machine: leaseMachine, subject: "NEW.id",
          data: { ledger: "'generic'", state: "NEW.state", previous: "OLD.state", revision: "NEW.revision", reason: genericEndReason },
          where: "OLD.state IS NOT NEW.state AND NEW.state IN ('ready','released','expired','failed')" }),
        emit({ kind: "'lease.renewed'", application: "NEW.consumer", lease: "NEW.id", host: leaseHost, machine: leaseMachine, subject: "NEW.id",
          data: { ledger: "'generic'", revision: "NEW.revision", expiresAt: iso("NEW.expires") },
          where: "NEW.expires>OLD.expires AND NEW.state IN ('provisioning','ready') AND OLD.state IS NEW.state" }),
        emit({ kind: "CASE NEW.cleanup WHEN 'blocked' THEN 'lease.cleanup_blocked' ELSE 'lease.cleanup_proven' END", application: "NEW.consumer", lease: "NEW.id", host: leaseHost, machine: leaseMachine, subject: "NEW.id",
          data: { ledger: "'generic'", state: "NEW.state", cleanup: "NEW.cleanup",
            reason: "CASE NEW.cleanup WHEN 'blocked' THEN (SELECT reason FROM lease_cleanup_members WHERE lease=NEW.id AND state='blocked' ORDER BY machine LIMIT 1) END",
            attempts: "CASE NEW.cleanup WHEN 'blocked' THEN (SELECT max(attempts) FROM lease_cleanup_members WHERE lease=NEW.id) END" },
          where: "OLD.cleanup IS NOT NEW.cleanup AND NEW.cleanup IN ('blocked','complete')" })] },

    // Linux workspace ledger. Its placement is a resource domain; the host is named when the domain is bound to one.
    { name: "linux_lease_admitted", table: "linux_leases", timing: "AFTER INSERT", body: [
      emit({ kind: "'lease.admitted'", application: "NEW.application", lease: "NEW.id", host: domainHost, machine: "NEW.member", subject: "NEW.id",
        data: { ledger: "'linux'", templateId: "NEW.image_id", templateRevision: "NEW.image_revision", arch: "NEW.arch", platform: "'linux'", expiresAt: iso("NEW.expires") },
        where: "NEW.state IN ('provisioning','ready')" })] },
    { name: "linux_lease_changed", table: "linux_leases", timing: "AFTER UPDATE",
      when: "OLD.state IS NOT NEW.state OR OLD.expires IS NOT NEW.expires OR OLD.cleanup IS NOT NEW.cleanup", body: [
        emit({ kind: "'lease.'||NEW.state", application: "NEW.application", lease: "NEW.id", host: domainHost, machine: "NEW.member", subject: "NEW.id",
          data: { ledger: "'linux'", state: "NEW.state", previous: "OLD.state", revision: "NEW.revision",
            reason: `CASE NEW.state WHEN 'expired' THEN 'deadline' WHEN 'failed' THEN ${code("NEW.failure_reason")} END` },
          where: "OLD.state IS NOT NEW.state AND NEW.state IN ('ready','released','expired','failed')" }),
        emit({ kind: "'lease.renewed'", application: "NEW.application", lease: "NEW.id", host: domainHost, machine: "NEW.member", subject: "NEW.id",
          data: { ledger: "'linux'", revision: "NEW.revision", expiresAt: iso("NEW.expires") },
          where: "NEW.expires>OLD.expires AND NEW.state IN ('provisioning','ready') AND OLD.state IS NEW.state" }),
        emit({ kind: "CASE NEW.cleanup WHEN 'blocked' THEN 'lease.cleanup_blocked' ELSE 'lease.cleanup_proven' END", application: "NEW.application", lease: "NEW.id", host: domainHost, machine: "NEW.member", subject: "NEW.id",
          data: { ledger: "'linux'", state: "NEW.state", cleanup: "NEW.cleanup" },
          where: "OLD.cleanup IS NOT NEW.cleanup AND NEW.cleanup IN ('blocked','complete')" })] },

    { name: "request_submitted", table: "requests", timing: "AFTER INSERT", when: "NEW.state='waiting'", body: [
      emit({ kind: "'request.submitted'", application: "NEW.application", request: "NEW.id", subject: "NEW.id",
        data: { requestKind: "NEW.kind", priority: "NEW.priority", deadline: iso("NEW.deadline"), templateId: jx("NEW.intent", "$.templateId"),
          templateRevision: jx("NEW.intent", "$.templateRevision"), arch: jx("NEW.intent", "$.arch"), model: jx("NEW.intent", "$.model") } })] },
    { name: "request_changed", table: "requests", timing: "AFTER UPDATE", when: "OLD.state IS NOT NEW.state AND NEW.state IN ('admitted','cancelled','expired','rejected')", body: [
      emit({ kind: "'request.'||NEW.state", application: "NEW.application", request: "NEW.id", subject: "NEW.id",
        lease: "CASE WHEN NEW.kind IN ('lease','linux-lease') THEN NEW.target END",
        data: { requestKind: "NEW.kind", state: "NEW.state", previous: "OLD.state", priority: "NEW.priority", reason: code("NEW.reason"), target: "NEW.target" } })] },

    { name: "host_enrolled", table: "hosts", timing: "AFTER INSERT", body: [
      emit({ kind: "'host.enrolled'", host: "NEW.id", subject: "NEW.id", data: { name: jx("NEW.offer", "$.name"), provider: jx("NEW.offer", "$.provider") } })] },
    { name: "host_accepting", table: "hosts", timing: "AFTER UPDATE OF enabled", when: "OLD.enabled IS NOT NEW.enabled", body: [
      emit({ kind: "CASE WHEN NEW.enabled=1 THEN 'host.accepting' ELSE 'host.draining' END", host: "NEW.id", subject: "NEW.id", data: { accepting: "json(CASE WHEN NEW.enabled=1 THEN 'true' ELSE 'false' END)" } })] },
    { name: "host_maintenance_began", table: "host_maintenance", timing: "AFTER INSERT", when: "NEW.phase='draining'", body: [
      emit({ kind: "'host.maintenance_began'", host: "NEW.host", subject: "NEW.host", data: { drainId: "NEW.id", phase: "NEW.phase" } })] },
    { name: "host_maintenance_resumed", table: "host_maintenance", timing: "AFTER UPDATE OF phase", when: "OLD.phase IS NOT NEW.phase AND NEW.phase='resumed'", body: [
      emit({ kind: "'host.maintenance_resumed'", host: "NEW.host", subject: "NEW.host", data: { drainId: "NEW.id", phase: "NEW.phase" } })] },
    { name: "host_checks_reported", table: "host_health", timing: "AFTER INSERT", when: "NEW.report IS NOT NULL", body: checks("NULL") },
    { name: "host_checks_changed", table: "host_health", timing: "AFTER UPDATE OF report", when: "NEW.report IS NOT NULL AND OLD.report IS NOT NEW.report", body: checks(healthStatus("OLD")) },
    { name: "host_limits_changed", table: "host_limits", timing: "AFTER UPDATE OF limits", when: "OLD.limits IS NOT NEW.limits", body: [
      emit({ kind: "'host.limits_changed'", host: "NEW.host", subject: "NEW.host",
        data: { cpu: jx("NEW.limits", "$.cpu"), memoryMiB: jx("NEW.limits", "$.memoryMiB"), diskGiB: jx("NEW.limits", "$.diskGiB") } })] },

    { name: "machine_created", table: "machines", timing: "AFTER INSERT", body: [
      emit({ kind: "'machine.created'", host: "NEW.host", machine: "NEW.id", subject: "NEW.id",
        data: { templateId: jx("NEW.template", "$.id"), templateRevision: jx("NEW.template", "$.revision"), arch: jx("NEW.template", "$.arch"),
          platform: jx("NEW.template", "$.os"), mode: jx("NEW.template", "$.mode"), desired: "NEW.desired" } })] },
    { name: "machine_changed", table: "machines", requires: ["lease_members", "leases"], timing: "AFTER UPDATE",
      when: "OLD.desired IS NOT NEW.desired OR OLD.observed IS NOT NEW.observed OR OLD.preparation_state IS NOT NEW.preparation_state", body: [
        emit({ kind: "'machine.desired'", application: machineApplication("NEW.id"), lease: machineLease("NEW.id"), host: "NEW.host", machine: "NEW.id", subject: "NEW.id",
          data: { desired: "NEW.desired", previous: "OLD.desired" }, where: "OLD.desired IS NOT NEW.desired" }),
        emit({ kind: "CASE NEW.observed WHEN 'error' THEN 'machine.error' ELSE 'machine.observed' END", application: machineApplication("NEW.id"), lease: machineLease("NEW.id"), host: "NEW.host", machine: "NEW.id", subject: "NEW.id",
          data: { observed: "NEW.observed", previous: "OLD.observed", platform: jx("NEW.template", "$.os") }, where: "OLD.observed IS NOT NEW.observed" }),
        emit({ kind: "'machine.preparation'", application: machineApplication("NEW.id"), lease: machineLease("NEW.id"), host: "NEW.host", machine: "NEW.id", subject: "NEW.id",
          data: { state: "NEW.preparation_state", previous: "OLD.preparation_state" }, where: "OLD.preparation_state IS NOT NEW.preparation_state" })] },
    { name: "machine_power_off_requested", table: "machine_power_offs", requires: ["machines"], timing: "AFTER INSERT", body: [
      emit({ kind: "'machine.power_off_requested'", host: "(SELECT host FROM machines WHERE id=NEW.machine)", machine: "NEW.machine", subject: "NEW.machine", data: { requestId: "NEW.id", state: "NEW.state" } })] },
    { name: "machine_power_off_changed", table: "machine_power_offs", requires: ["machines"], timing: "AFTER UPDATE OF state", when: "OLD.state IS NOT NEW.state", body: [
      emit({ kind: "'machine.power_off'", host: "(SELECT host FROM machines WHERE id=NEW.machine)", machine: "NEW.machine", subject: "NEW.machine", data: { requestId: "NEW.id", state: "NEW.state", previous: "OLD.state" } })] },
    { name: "machine_deletion_requested", table: "machine_deletions", requires: ["machines"], timing: "AFTER INSERT", body: [
      emit({ kind: "'machine.deletion_requested'", host: "(SELECT host FROM machines WHERE id=NEW.machine)", machine: "NEW.machine", subject: "NEW.machine", data: { requestId: "NEW.id", state: "NEW.state" } })] },
    { name: "machine_deletion_changed", table: "machine_deletions", requires: ["machines"], timing: "AFTER UPDATE OF state", when: "OLD.state IS NOT NEW.state AND NEW.state IN ('blocked','complete')", body: [
      emit({ kind: "CASE NEW.state WHEN 'complete' THEN 'machine.deleted' ELSE 'machine.deletion_blocked' END", host: "(SELECT host FROM machines WHERE id=NEW.machine)", machine: "NEW.machine", subject: "NEW.machine",
        data: { requestId: "NEW.id", state: "NEW.state", previous: "OLD.state" } })] },

    // Outcomes only: the action name and identifiers, never arguments or results.
    { name: "device_operation_outcome", table: "device_operations", requires: ["consumer_operations", "leases"], timing: "AFTER UPDATE OF state",
      when: "OLD.state IS NOT NEW.state AND NEW.state IN ('succeeded','failed','unknown')", body: [
        emit({ kind: `CASE WHEN ${operationAction} IN ('install','install-uploaded') THEN 'install.' ELSE 'operation.' END||NEW.state`,
          application: leaseApplication("(SELECT lease FROM consumer_operations WHERE id=NEW.id)"), lease: "(SELECT lease FROM consumer_operations WHERE id=NEW.id)",
          host: "NEW.host", machine: "NEW.machine", subject: "NEW.id",
          data: { operationId: "NEW.id", ledger: "'device'", action: code(operationAction), state: "NEW.state", previous: "OLD.state" } })] },
    { name: "linux_operation_outcome", table: "linux_operations", requires: ["linux_leases"], timing: "AFTER UPDATE OF state",
      when: "OLD.state IS NOT NEW.state AND NEW.state IN ('succeeded','failed','unknown')", body: [
        emit({ kind: "'operation.'||NEW.state", application: linuxApplication("NEW.lease"), lease: "NEW.lease", subject: "NEW.id",
          data: { operationId: "NEW.id", ledger: "'linux'", action: "'shell'", state: "NEW.state", previous: "OLD.state" } })] },
    { name: "install_resolved", table: "device_operation_resolutions", requires: ["device_operations"], timing: "AFTER INSERT", body: [
      emit({ kind: "'install.resolved'", host: "(SELECT host FROM device_operations WHERE id=NEW.operation)", machine: "(SELECT machine FROM device_operations WHERE id=NEW.operation)", subject: "NEW.operation",
        data: { operationId: "NEW.operation", resolutionId: "NEW.id", decision: code("NEW.decision") } })] },

    { name: "video_session_opened", table: "mobile_video_sessions", requires: ["leases"], timing: "AFTER INSERT", body: [
      emit({ kind: "'video.session_opened'", application: leaseApplication("NEW.lease"), lease: "NEW.lease", host: "NEW.host", machine: "NEW.machine", subject: "NEW.id",
        data: { sessionId: "NEW.id", state: "NEW.state", member: "NEW.member" } })] },
    { name: "video_session_changed", table: "mobile_video_sessions", requires: ["leases"], timing: "AFTER UPDATE", when: "OLD.state IS NOT NEW.state OR OLD.cleaned IS NOT NEW.cleaned", body: [
      emit({ kind: "CASE NEW.state WHEN 'ready' THEN 'video.session_ready' ELSE 'video.session_ended' END", application: leaseApplication("NEW.lease"), lease: "NEW.lease", host: "NEW.host", machine: "NEW.machine", subject: "NEW.id",
        data: { sessionId: "NEW.id", state: "NEW.state", previous: "OLD.state" }, where: "OLD.state IS NOT NEW.state AND NEW.state IN ('ready','finished','disconnected')" }),
      emit({ kind: "'video.session_cleaned'", application: leaseApplication("NEW.lease"), lease: "NEW.lease", host: "NEW.host", machine: "NEW.machine", subject: "NEW.id",
        data: { sessionId: "NEW.id", state: "NEW.state" }, where: "OLD.cleaned=0 AND NEW.cleaned=1" })] },
    { name: "video_session_abandoned", table: "mobile_video_session_resolutions", requires: ["mobile_video_sessions"], timing: "AFTER INSERT", body: [
      emit({ kind: "'video.session_abandoned'", host: "(SELECT host FROM mobile_video_sessions WHERE id=NEW.session)", machine: "(SELECT machine FROM mobile_video_sessions WHERE id=NEW.session)", subject: "NEW.session",
        data: { sessionId: "NEW.session", decision: code("NEW.decision") } })] },

    { name: "update_rollout_created", table: "update_rollouts", timing: "AFTER INSERT", body: [
      emit({ kind: "'update.rollout_created'", subject: "NEW.id", data: { rolloutId: "NEW.id" } })] },
    { name: "update_job_queued", table: "host_update_jobs", timing: "AFTER INSERT", body: [
      emit({ kind: "'update.job_queued'", host: "NEW.host", subject: "NEW.id", data: { jobId: "NEW.id", rolloutId: "NEW.rollout", targetKind: "NEW.target_kind", releaseId: code("NEW.release"), phase: "NEW.phase" } })] },
    { name: "update_job_changed", table: "host_update_jobs", timing: "AFTER UPDATE OF phase", when: "OLD.phase IS NOT NEW.phase", body: [
      emit({ kind: terminalUpdate, host: "NEW.host", subject: "NEW.id",
        data: { jobId: "NEW.id", rolloutId: "NEW.rollout", targetKind: "NEW.target_kind", releaseId: code("NEW.release"), phase: "NEW.phase", previous: "OLD.phase", uncertain: "json(CASE WHEN NEW.uncertain=1 THEN 'true' ELSE 'false' END)" } })] },

    { name: "admin_intervention", table: "admin_system_mutations", timing: "AFTER INSERT", body: [
      emit({ kind: "'admin.intervention'", subject: "NEW.target", data: { mutationId: "NEW.id", action: code("NEW.action"), target: "NEW.target", actor: code("NEW.actor") } })] },
  ];
}

const TRIGGER_PREFIX = "canaveral_event_";
/** Every capture trigger this version defines. A complete controller schema installs all of them. */
export const EVENT_TRIGGERS: readonly string[] = triggerDefinitions(() => true).map(definition => definition.name);
/** Remove capture. SQLite refuses to drop a column that a trigger reads, so a migration that drops or
 * rewrites a captured column calls this first; capture returns when the control worker next installs it. */
export function dropEventTriggers(db: DatabaseSync): void {
  for (const row of db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'canaveral\\_event\\_%' ESCAPE '\\'").all()) db.exec(`DROP TRIGGER IF EXISTS "${String(row.name).replaceAll('"', "")}"`);
}
/** Reinstall every trigger whose table and referenced tables exist. Call after all modules have
 * created and migrated their tables: a trigger that names a missing column would fail its table's
 * writes. Definitions are replaced on every start so an upgrade never leaves a stale body behind.
 * The row cap is part of the schema: it holds for every writer, including one without this module. */
export function installEventTriggers(db: DatabaseSync, retention: EventRetention = DEFAULT_EVENT_RETENTION): string[] {
  eventSchema(db);
  if (!Number.isSafeInteger(retention.maxRows) || retention.maxRows < 1) throw new TypeError("Invalid event row cap.");
  const has = (table: string) => tableExists(db, table);
  dropEventTriggers(db);
  const installed: string[] = [];
  for (const definition of triggerDefinitions(has)) {
    if (!has(definition.table) || (definition.requires ?? []).some(table => !has(table))) continue;
    const name = TRIGGER_PREFIX + definition.name, column = /^AFTER UPDATE OF ([a-z_]+)$/.exec(definition.timing)?.[1] ?? "rowid";
    db.exec(`CREATE TRIGGER ${name} ${definition.timing} ON ${definition.table}${definition.when ? ` WHEN ${definition.when}` : ""} BEGIN ${definition.body.join(" ")} END`);
    // SQLite resolves a trigger body when a firing statement is prepared. Compile one that changes
    // nothing; a body that does not fit this database's columns is removed instead of breaking its table.
    try {
      db.prepare(definition.timing === "AFTER INSERT" ? `INSERT INTO ${definition.table} SELECT * FROM ${definition.table} WHERE 0` : `UPDATE ${definition.table} SET ${column}=${column} WHERE 0`);
      installed.push(definition.name);
    } catch { db.exec(`DROP TRIGGER IF EXISTS ${name}`); }
  }
  db.exec(`CREATE TRIGGER ${TRIGGER_PREFIX}row_cap AFTER INSERT ON events BEGIN DELETE FROM events WHERE seq<=NEW.seq-${retention.maxRows}; END`);
  return installed;
}
