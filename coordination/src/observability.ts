import type { DatabaseSync } from "node:sqlite";
import { alertProjection, alertSchema } from "./alerts.ts";
import { object, ServiceError } from "./errors.ts";
import { DEFAULT_EVENT_RETENTION, eventSchema, projectEvents, recordEvent } from "./events.ts";
import type { EventProjection } from "./events.ts";
import type { SqliteStore } from "./sqlite.ts";
import { DEFAULT_USAGE_RETENTION_SECONDS, usageProjection, usageSchema } from "./usage.ts";

/** Operator-tunable observability bounds. Every value has a safe default and an enforced range. */
export interface ObservabilitySettings {
  /** Events older than this are removed. */
  eventRetentionSeconds: number;
  /** Hard cap on retained event rows, enforced by the schema on every insert. */
  eventMaxRows: number;
  /** How long an ended lease stays in the usage ledger. */
  usageRetentionSeconds: number;
  /** A request waiting at least this long raises `request.waiting_long` once. */
  requestWaitAlertSeconds: number;
  /** `host.disk_pressure` below this share of free storage. */
  diskFreeAlertPercent: number;
  /** `host.memory_pressure` below this share of available memory. */
  memoryAvailableAlertPercent: number;
}
const RANGES: Record<keyof ObservabilitySettings, [number, number, number]> = {
  eventRetentionSeconds: [3600, 400 * 86400, DEFAULT_EVENT_RETENTION.maxAgeSeconds],
  eventMaxRows: [1000, 5_000_000, DEFAULT_EVENT_RETENTION.maxRows],
  usageRetentionSeconds: [86400, 5 * 366 * 86400, DEFAULT_USAGE_RETENTION_SECONDS],
  requestWaitAlertSeconds: [10, 7 * 86400, 600],
  diskFreeAlertPercent: [1, 50, 10],
  memoryAvailableAlertPercent: [1, 50, 5],
};
export function observabilitySettings(value: unknown = {}): ObservabilitySettings {
  const input = object(value);
  if (Object.keys(input).some(key => !Object.hasOwn(RANGES, key))) throw new ServiceError("Unknown observability setting.", 400);
  return Object.fromEntries(Object.entries(RANGES).map(([key, [minimum, maximum, fallback]]) => {
    const setting = input[key] === undefined ? fallback : input[key];
    if (typeof setting !== "number" || !Number.isSafeInteger(setting) || setting < minimum || setting > maximum) throw new ServiceError(`observability.${key} must be an integer from ${minimum} to ${maximum}.`, 400);
    return [key, setting];
  })) as unknown as ObservabilitySettings;
}

/** Derived in the transaction that records the events: the usage ledger, then the alert outbox. */
export const OBSERVABILITY_PROJECTIONS: readonly EventProjection[] = [usageProjection, alertProjection];
const installed = new WeakSet<SqliteStore>();
/** Creates the observability tables and stamps and projects new events at every commit of this store.
 * Every worker that writes the ledgers installs it. Capture itself is the trigger set that the
 * control worker installs once all module tables exist. */
export function installObservability(store: SqliteStore): void {
  if (installed.has(store)) return;
  installed.add(store);
  store.transaction(db => { eventSchema(db); usageSchema(db, store.clock()); alertSchema(db); });
  // A commit hook that throws rolls its transaction back. Observability must never do that to the
  // control path: an unreadable log leaves events unstamped for a later commit instead.
  store.addCommitHook((db, now) => { try { projectEvents(db, now, OBSERVABILITY_PROJECTIONS); } catch { /* Retried at the next commit. */ } });
}

const REFUSAL_THROTTLE_SECONDS = 60;
/** A refused direct acquisition rolls back and so leaves no ledger change to capture. Record it in a
 * transaction of its own, after the refusal, for the authenticated application only. A polling client
 * could otherwise fill the log, so one event is kept per application and code per minute; the count is
 * therefore a signal, not a usage figure. Recording never replaces the caller's original error. */
export function recordLeaseRefusal(store: SqliteStore, application: (db: DatabaseSync) => string, error: unknown, ledger: "generic" | "linux", intent: unknown): void {
  if (!(error instanceof ServiceError) || ![403, 429, 503].includes(error.status) || !/^[a-z][a-z0-9_]{0,63}$/.test(error.code)) return;
  try {
    store.transaction(db => {
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='event_conditions'").get()) return;
      const id = application(db), subject = `${id}:${error.code}`, now = store.clock();
      const last = db.prepare("SELECT since FROM event_conditions WHERE kind='lease.refused' AND subject=?").get(subject);
      if (last && now - Number(last.since) < REFUSAL_THROTTLE_SECONDS) return;
      db.prepare("INSERT INTO event_conditions VALUES ('lease.refused',?,?) ON CONFLICT(kind,subject) DO UPDATE SET since=excluded.since").run(subject, now);
      const fields = intent !== null && typeof intent === "object" && !Array.isArray(intent) ? intent as Record<string, unknown> : {};
      const label = (value: unknown) => typeof value === "string" && value.length <= 200 ? value : undefined;
      recordEvent(db, "lease.refused", { application: id, subject, data: { ledger, code: error.code, status: error.status,
        templateId: label(fields.templateId), templateRevision: label(fields.templateRevision), arch: label(fields.arch) } });
    });
  } catch { /* The refusal itself is the caller's answer. */ }
}
