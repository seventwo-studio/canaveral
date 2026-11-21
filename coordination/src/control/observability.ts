import { DatabaseSync } from "node:sqlite";
import { addDestination, AlertDelivery, listDeliveries, listDestinations, MAX_ALERT_DESTINATIONS, pruneDeliveries, removeDestination } from "../alerts.ts";
import type { AlertSender } from "../alerts.ts";
import type { ConsumerIdentities } from "../consumers.ts";
import { identifier } from "../consumers.ts";
import { ServiceError } from "../errors.ts";
import { EVENT_KINDS, eventRetention, installEventTriggers, listEvents, parseEventQuery, projectEvents, pruneEvents, recordEvent } from "../events.ts";
import { installObservability, OBSERVABILITY_PROJECTIONS, observabilitySettings } from "../observability.ts";
import type { ObservabilitySettings } from "../observability.ts";
import type { SqliteStore } from "../sqlite.ts";
import { backfillActiveLeases, parseUsageQuery, pruneUsage, usageCsv, usageReport } from "../usage.ts";
import { requireAdmin } from "./contracts.ts";
import type { ControlModule, ControlOptions, ControlRequest, ControlResponse } from "./contracts.ts";
import { diagnose } from "./diagnosis.ts";

/** Events, usage, alerts and diagnosis routes, plus the observer for conditions no row change expresses.
 *
 * Administrator routes authenticate before any lookup. Application routes accept only the application
 * credential and are filtered to that application's rows in SQL; a lease, host or operator key is refused.
 * The observer and the delivery loop run on a timer outside request handling. Neither holds a transaction
 * across I/O, and both probe on a read-only connection first so an idle controller takes no write lock.
 */
const HOST_FRESH_SECONDS = 30, SAMPLE_FRESH_SECONDS = 60, PRESSURE_HYSTERESIS = 2, MAINTENANCE_INTERVAL_SECONDS = 60, OBSERVE_INTERVAL_SECONDS = 5;
/** After a restart every host looks silent until its next heartbeat; liveness is judged only once that window passed. */
const LIVENESS_GRACE_SECONDS = 45;
const APPLICATION_EVENT_KEYS = ["after", "tail", "since", "kind", "limit", "lease", "request"];
const table = (db: DatabaseSync, name: string): boolean => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);

export class Observability implements ControlModule {
  readonly settings: ObservabilitySettings;
  readonly alerts: AlertDelivery;
  private readonly started: number;
  private lastMaintenance = 0;
  private lastObservation = Number.NEGATIVE_INFINITY;
  private ticking = false;
  constructor(readonly store: SqliteStore, readonly options: ControlOptions, readonly applications: ConsumerIdentities, send?: AlertSender) {
    this.settings = observabilitySettings(options.observability ?? {});
    installObservability(store);
    this.alerts = new AlertDelivery(store, options.controllerId, send);
    this.started = store.clock();
  }

  /** Install capture once every module has created and migrated its tables. Returns the installed trigger names. */
  installCapture(): string[] {
    return this.store.transaction(db => {
      const installed = installEventTriggers(db, eventRetention(this.settings));
      backfillActiveLeases(db);
      recordEvent(db, "controller.started", { subject: this.options.controllerId, data: { controllerId: this.options.controllerId, captured: installed.length } });
      return installed;
    });
  }

  /** Derive host liveness, resource pressure and long waits; write each transition with its condition row. */
  observe(): number {
    const probe = new DatabaseSync(this.store.path, { readOnly: true, timeout: 15000 });
    let pending: boolean;
    try { pending = this.transitions(probe, this.store.clock()).length > 0; } finally { probe.close(); }
    if (!pending) return 0;
    return this.store.transaction(db => {
      const changes = this.transitions(db, this.store.clock());
      for (const change of changes) change(db);
      return changes.length;
    });
  }
  private transitions(db: DatabaseSync, now: number): Array<(db: DatabaseSync) => void> {
    if (!table(db, "event_conditions")) return [];
    const changes: Array<(db: DatabaseSync) => void> = [];
    const held = new Map<string, number>();
    for (const row of db.prepare("SELECT kind,subject,since FROM event_conditions WHERE kind!='lease.refused'").all()) held.set(`${String(row.kind)}\n${String(row.subject)}`, Number(row.since));
    const begin = (kind: string, subject: string, write: (db: DatabaseSync) => void) => {
      if (held.has(`${kind}\n${subject}`)) return;
      changes.push(target => { target.prepare("INSERT OR IGNORE INTO event_conditions VALUES (?,?,?)").run(kind, subject, now); write(target); });
    };
    const end = (kind: string, subject: string, write?: (db: DatabaseSync, since: number) => void) => {
      const since = held.get(`${kind}\n${subject}`);
      if (since === undefined) return;
      changes.push(target => { target.prepare("DELETE FROM event_conditions WHERE kind=? AND subject=?").run(kind, subject); write?.(target, since); });
    };

    if (table(db, "hosts")) {
      const retired = table(db, "retired_runners") ? new Set(db.prepare("SELECT id FROM retired_runners").all().map(row => String(row.id))) : new Set<string>();
      const hosts = db.prepare("SELECT id,seen FROM hosts").all().filter(row => !retired.has(String(row.id)));
      const known = new Set(hosts.map(row => String(row.id)));
      const liveness = now - this.started >= LIVENESS_GRACE_SECONDS;
      for (const host of hosts) {
        const id = String(host.id), seen = Number(host.seen), online = now - seen < HOST_FRESH_SECONDS;
        if (liveness && !online) begin("host.offline", id, target => recordEvent(target, "host.offline", { host: id, subject: id, data: { lastSeenAt: new Date(seen * 1000).toISOString(), silentSeconds: Math.round(now - seen) } }));
        // A heartbeat is positive evidence at any time, including during the restart grace.
        if (online) end("host.offline", id, (target, since) => recordEvent(target, "host.online", { host: id, subject: id, data: { offlineSeconds: Math.round(now - since) } }));
        const sample = online && table(db, "resource_samples") ? db.prepare("SELECT captured,report FROM resource_samples WHERE host=? ORDER BY captured DESC LIMIT 1").get(id) : undefined;
        if (!sample || now - Number(sample.captured) >= SAMPLE_FRESH_SECONDS) continue;
        let report: Record<string, unknown>;
        try { report = JSON.parse(String(sample.report)) as Record<string, unknown>; } catch { continue; }
        // Unavailable readings are neither pressure nor relief; only a fresh measurement moves a condition.
        const share = (free: unknown, total: unknown) => typeof free === "number" && typeof total === "number" && Number.isFinite(free) && Number.isFinite(total) && total > 0 ? free / total * 100 : undefined;
        for (const [kind, free, threshold, fields] of [
          ["host.disk_pressure", share(report.diskFreeGiB, report.diskTotalGiB), this.settings.diskFreeAlertPercent, { freeGiB: report.diskFreeGiB, totalGiB: report.diskTotalGiB }],
          ["host.memory_pressure", share(report.memoryAvailableMiB, report.memoryTotalMiB), this.settings.memoryAvailableAlertPercent, { availableMiB: report.memoryAvailableMiB, totalMiB: report.memoryTotalMiB }],
        ] as const) {
          if (free === undefined) continue;
          const data = { ...fields, freePercent: Number(free.toFixed(1)), thresholdPercent: threshold };
          if (free < threshold) begin(kind, id, target => recordEvent(target, kind, { host: id, subject: id, data }));
          else if (free >= threshold + PRESSURE_HYSTERESIS) end(kind, id, target => recordEvent(target, `${kind}_cleared`, { host: id, subject: id, data }));
        }
      }
      // A removed host identity cannot report again; its conditions end without a recovery event.
      for (const key of held.keys()) { const [kind, subject] = key.split("\n") as [string, string]; if (kind.startsWith("host.") && !known.has(subject)) end(kind, subject); }
    }
    if (table(db, "requests")) {
      const waiting = new Set<string>();
      for (const row of db.prepare("SELECT application,id,kind,reason,created FROM requests WHERE state='waiting' AND created<=?").all(now - this.settings.requestWaitAlertSeconds)) {
        const application = String(row.application), id = String(row.id), subject = `${application}:${id}`;
        waiting.add(subject);
        begin("request.waiting_long", subject, target => recordEvent(target, "request.waiting_long", { application, request: id, subject: id,
          data: { requestKind: String(row.kind), waitedSeconds: Math.round(now - Number(row.created)), thresholdSeconds: this.settings.requestWaitAlertSeconds,
            ...(typeof row.reason === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(row.reason) ? { reason: row.reason } : {}) } }));
      }
      for (const key of held.keys()) { const [kind, subject] = key.split("\n") as [string, string]; if (kind === "request.waiting_long" && !waiting.has(subject)) end(kind, subject); }
    }
    return changes;
  }

  /** Bounded retention for the event log, the usage ledger and settled deliveries. */
  maintain(force = false): void {
    const now = this.store.clock();
    if (!force && now - this.lastMaintenance < MAINTENANCE_INTERVAL_SECONDS) return;
    this.lastMaintenance = now;
    this.store.transaction(db => {
      pruneEvents(db, now, eventRetention(this.settings));
      pruneUsage(db, now, this.settings.usageRetentionSeconds);
      pruneDeliveries(db, now);
      db.prepare("DELETE FROM event_conditions WHERE kind='lease.refused' AND since<?").run(now - 3600);
    });
  }
  /** One round of observation, delivery and retention. A busy database or a failed round never reaches the worker. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      // Conditions move on the scale of heartbeats; due deliveries are checked every round.
      const now = this.store.clock();
      if (now - this.lastObservation >= OBSERVE_INTERVAL_SECONDS) {
        this.lastObservation = now;
        try { this.observe(); } catch { /* Retried on the next round. */ }
      }
      try {
        const probe = new DatabaseSync(this.store.path, { readOnly: true, timeout: 15000 });
        let due: boolean;
        try { due = this.alerts.due(probe, this.store.clock()); } finally { probe.close(); }
        if (due) await this.alerts.deliverDue();
      } catch { /* Pending deliveries keep their schedule. */ }
      try { this.maintain(); } catch { /* Retention is retried a minute later. */ }
    } finally { this.ticking = false; }
  }
  start(intervalMs = 1000): () => void {
    const timer = setInterval(() => { void this.tick(); }, intervalMs);
    timer.unref();
    return () => clearInterval(timer);
  }
  /** Newest committed sequence, read without the write lock. The event stream polls it to stay idle between events. */
  latestSequence(): number {
    const probe = new DatabaseSync(this.store.path, { readOnly: true, timeout: 15000 });
    try { return Number((probe.prepare("SELECT seq FROM sqlite_sequence WHERE name='events'").get() as { seq?: number } | undefined)?.seq ?? 0); }
    finally { probe.close(); }
  }

  private events(req: ControlRequest, scope: "admin" | "application"): ControlResponse {
    return this.store.transaction(db => {
      const application = scope === "admin" ? (requireAdmin(req), undefined) : this.applications.verify(db, req.token).id;
      const query = parseEventQuery(req.query, scope === "admin" ? undefined : APPLICATION_EVENT_KEYS);
      if (application !== undefined) query.application = application;
      // Rows written by another connection since its last commit are stamped before they are read.
      projectEvents(db, this.store.clock(), OBSERVABILITY_PROJECTIONS);
      return { body: listEvents(db, query, scope) };
    });
  }
  private usage(req: ControlRequest, scope: "admin" | "application"): ControlResponse {
    return this.store.transaction(db => {
      const application = scope === "admin" ? (requireAdmin(req), undefined) : this.applications.verify(db, req.token).id;
      const now = this.store.clock(), query = parseUsageQuery(req.query, now, scope);
      if (application !== undefined) query.application = application;
      projectEvents(db, now, OBSERVABILITY_PROJECTIONS);
      const report = usageReport(db, query, now, this.settings.usageRetentionSeconds);
      return query.format === "csv" ? { body: usageCsv(report), contentType: "text/csv; charset=utf-8" } : { body: report };
    });
  }
  private diagnosis(req: ControlRequest): ControlResponse {
    if ([...req.query.keys()].length) throw new ServiceError("Queries are not supported.", 400);
    this.store.transaction(() => { requireAdmin(req); });
    // A separate read-only connection: the diagnosis itself cannot write, whatever it finds.
    const db = new DatabaseSync(this.store.path, { readOnly: true, timeout: 15000 });
    try {
      db.exec("BEGIN");
      return { body: diagnose(db, this.store.clock(), this.settings) };
    } finally { db.close(); }
  }
  private actor(req: ControlRequest): string {
    const principal = requireAdmin(req);
    return principal.kind === "operator" ? "operator" : `${principal.kind}:${principal.user!.id}`;
  }

  handle(req: ControlRequest): ControlResponse | undefined | Promise<ControlResponse | undefined> {
    const { path, method } = req;
    if (method === "GET" && path === "/v1/admin/events") return this.events(req, "admin");
    if (method === "GET" && path === "/v1/events") return this.events(req, "application");
    if (method === "GET" && path === "/v1/admin/events/kinds") return this.store.transaction(() => {
      requireAdmin(req);
      return { body: { kinds: Object.entries(EVENT_KINDS).map(([kind, info]) => ({ kind, summary: info.summary, routine: info.routine === true, attention: info.attention === true })) } };
    });
    if (method === "GET" && path === "/v1/admin/usage") return this.usage(req, "admin");
    if (method === "GET" && path === "/v1/usage") return this.usage(req, "application");
    if (method === "GET" && path === "/v1/admin/diagnosis") return this.diagnosis(req);
    if (!path.startsWith("/v1/admin/alerts/")) return undefined;
    if (method === "GET" && path === "/v1/admin/alerts/destinations") return this.store.transaction(db => {
      requireAdmin(req);
      if ([...req.query.keys()].length) throw new ServiceError("Queries are not supported.", 400);
      return { body: { destinations: listDestinations(db), limit: MAX_ALERT_DESTINATIONS } };
    });
    if (method === "GET" && path === "/v1/admin/alerts/deliveries") return this.store.transaction(db => { requireAdmin(req); return { body: { deliveries: listDeliveries(db, req.query) } }; });
    if (method !== "POST") return undefined;
    if (path === "/v1/admin/alerts/destinations") return this.store.transaction(db => {
      const actor = this.actor(req), result = addDestination(db, req.body, this.store.clock());
      if (result.created) recordEvent(db, "alert.destination_added", { subject: result.destination.id, data: { destinationId: result.destination.id, type: result.destination.type, kinds: result.destination.kinds.length, actor } });
      return { status: result.created ? 201 : 200, body: result.destination };
    });
    const match = /^\/v1\/admin\/alerts\/destinations\/([^/]+)\/(remove|test)$/.exec(path);
    if (!match) return undefined;
    const id = identifier(match[1]);
    if (match[2] === "remove") return this.store.transaction(db => {
      const actor = this.actor(req);
      if (Object.keys(req.body).length) throw new ServiceError("Removal expects {}.", 400);
      const active = !!db.prepare("SELECT 1 FROM alert_destinations WHERE id=? AND removed IS NULL").get(id);
      const result = removeDestination(db, id, this.store.clock());
      if (active) recordEvent(db, "alert.destination_removed", { subject: id, data: { destinationId: id, actor } });
      return { body: result };
    });
    this.store.transaction(() => { requireAdmin(req); });
    if (Object.keys(req.body).length !== 1 || !Object.hasOwn(req.body, "id")) throw new ServiceError("A test requires a stable request UUID and no other fields.", 400);
    // The single attempt runs here, outside any transaction, bounded well inside the worker's request deadline.
    return this.alerts.test(id, identifier(req.body.id)).then(delivery => ({ body: { delivery } }));
  }
}
export function createModule(store: SqliteStore, options: ControlOptions, applications: ConsumerIdentities): Observability { return new Observability(store, options, applications); }
