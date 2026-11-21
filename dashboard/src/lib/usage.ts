import { duration, instant } from "./clock";
import { record } from "./types";

/** The administrator usage report, `GET /v1/admin/usage`.
 *
 * The figures describe controller state: what was requested, admitted and held. Device time is held
 * lease time, not measured utilisation, and lease figures exist only from when the usage ledger began.
 * The page says so beside the numbers; nothing here estimates or fills in a missing value. */
export const groups = ["application", "template", "platform", "host"] as const;
export type UsageGroup = (typeof groups)[number];
export const groupLabels: Record<UsageGroup, string> = {
  application: "Application",
  template: "Template",
  platform: "Platform",
  host: "Host",
};
export interface Distribution {
  p50: number | null;
  p95: number | null;
  samples: number;
}
export interface RequestUsage {
  submitted: number;
  admitted: number;
  cancelled: number;
  expired: number;
  rejected: number;
  waiting: number;
  waitSeconds: Distribution;
}
export interface LeaseUsage {
  admitted: number;
  ready: number;
  released: number;
  expired: number;
  failed: number;
  active: number;
  cleanupBlocked: number;
  deviceSeconds: number;
  timeToReadySeconds: Distribution;
  holdSeconds: Distribution;
}
export interface UsageRow {
  key: string;
  label?: string;
  /** Absent when grouping by host: a request has no host before it is admitted. */
  requests?: RequestUsage;
  leases: LeaseUsage;
}
export interface UsageReport {
  from: string;
  to: string;
  groupBy: UsageGroup;
  generatedAt: string;
  /** When the lease ledger began; null when the controller has none. */
  leaseLedgerStartedAt: string | null;
  leaseLedgerSeconds: number;
  rows: UsageRow[];
  totals: UsageRow;
}

const amount = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;
const count = (value: unknown): value is number =>
  amount(value) && Number.isSafeInteger(value);
function distribution(value: unknown): Distribution {
  const { p50, p95, samples } = record(value);
  if (
    !count(samples) ||
    !(p50 === null || amount(p50)) ||
    !(p95 === null || amount(p95)) ||
    // A percentile exists exactly when there is a sample to take it from.
    (p50 === null) !== (samples === 0) ||
    (p95 === null) !== (samples === 0)
  )
    throw new Error("Invalid usage distribution.");
  return { p50: p50 as number | null, p95: p95 as number | null, samples };
}
function counts<K extends string>(
  value: Record<string, unknown>,
  keys: readonly K[],
): Record<K, number> {
  const result = {} as Record<K, number>;
  for (const key of keys) {
    if (!count(value[key])) throw new Error("Invalid usage count.");
    result[key] = value[key];
  }
  return result;
}
function usageRow(value: unknown, withRequests: boolean): UsageRow {
  const row = record(value);
  if (typeof row.key !== "string" || !row.key || row.key.length > 400)
    throw new Error("Invalid usage group.");
  if (row.label !== undefined && typeof row.label !== "string")
    throw new Error("Invalid usage label.");
  if ((row.requests !== undefined) !== withRequests)
    throw new Error("Usage report does not match its grouping.");
  const leases = record(row.leases);
  if (!amount(leases.deviceSeconds)) throw new Error("Invalid device time.");
  const requests =
    row.requests === undefined ? undefined : record(row.requests);
  return {
    key: row.key,
    ...(row.label ? { label: row.label } : {}),
    ...(requests
      ? {
          requests: {
            ...counts(requests, [
              "submitted",
              "admitted",
              "cancelled",
              "expired",
              "rejected",
              "waiting",
            ] as const),
            waitSeconds: distribution(requests.waitSeconds),
          },
        }
      : {}),
    leases: {
      ...counts(leases, [
        "admitted",
        "ready",
        "released",
        "expired",
        "failed",
        "active",
        "cleanupBlocked",
      ] as const),
      deviceSeconds: leases.deviceSeconds,
      timeToReadySeconds: distribution(leases.timeToReadySeconds),
      holdSeconds: distribution(leases.holdSeconds),
    },
  };
}
/** Decodes a report and checks that it answers the question that was asked. */
export function usageReport(value: unknown, groupBy: UsageGroup): UsageReport {
  const root = record(value),
    retention = record(root.retention);
  if (
    !instant(root.from) ||
    !instant(root.to) ||
    !instant(root.generatedAt) ||
    root.groupBy !== groupBy ||
    !Array.isArray(root.rows) ||
    !(
      retention.leaseLedgerStartedAt === null ||
      instant(retention.leaseLedgerStartedAt)
    ) ||
    !amount(retention.leaseLedgerSeconds)
  )
    throw new Error("Invalid usage report.");
  const withRequests = groupBy !== "host";
  const seen = new Set<string>();
  const rows = root.rows.map((entry) => {
    const row = usageRow(entry, withRequests);
    if (seen.has(row.key)) throw new Error("Duplicate usage group.");
    seen.add(row.key);
    return row;
  });
  return {
    from: root.from,
    to: root.to,
    groupBy,
    generatedAt: root.generatedAt,
    leaseLedgerStartedAt: retention.leaseLedgerStartedAt as string | null,
    leaseLedgerSeconds: retention.leaseLedgerSeconds,
    rows,
    totals: usageRow(root.totals, withRequests),
  };
}

/** The controller's definition: failed leases, leases whose cleanup was blocked, rejected requests. */
export const failures = (row: UsageRow): number =>
  row.leases.failed + row.leases.cleanupBlocked + (row.requests?.rejected ?? 0);

export const ranges = [
  ["24h", "Last 24 hours", 86400],
  ["7d", "Last 7 days", 7 * 86400],
  ["30d", "Last 30 days", 30 * 86400],
  ["90d", "Last 90 days", 90 * 86400],
] as const;
export type RangeChoice = (typeof ranges)[number][0] | "custom";
/** The controller accepts at most 400 days. */
export const MAX_RANGE_SECONDS = 400 * 86400;
/** A preset ends now; a custom range is two local date-times. Returns UTC instants or the reason the
 * range cannot be asked for. */
export function usageRange(
  choice: RangeChoice,
  custom: { from: string; to: string },
  nowMs: number,
): { from: string; to: string } | { error: string } {
  if (choice !== "custom") {
    const seconds = ranges.find(([key]) => key === choice)![2];
    const to = Math.floor(nowMs / 1000) * 1000;
    return {
      from: new Date(to - seconds * 1000).toISOString(),
      to: new Date(to).toISOString(),
    };
  }
  const from = Date.parse(custom.from),
    to = Date.parse(custom.to);
  if (
    !custom.from ||
    !custom.to ||
    !Number.isFinite(from) ||
    !Number.isFinite(to)
  )
    return { error: "Choose a start and an end." };
  if (from >= to) return { error: "The start must be before the end." };
  if (to - from > MAX_RANGE_SECONDS * 1000)
    return { error: "A range covers at most 400 days." };
  return {
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
  };
}
export const usagePath = (
  range: { from: string; to: string },
  groupBy: UsageGroup,
  format?: "csv",
): string =>
  "admin/usage?" +
  new URLSearchParams({
    from: range.from,
    to: range.to,
    groupBy,
    ...(format ? { format } : {}),
  }).toString();

/** A percentile in seconds. No sample is said, not shown as zero. */
export function seconds(value: number | null): string {
  if (value === null) return "No samples";
  return value < 60 ? `${Number(value.toFixed(1))}s` : duration(value);
}
/** Held lease time. */
export function deviceTime(value: number): string {
  return value > 0 && value < 1 ? "<1s" : duration(value);
}
/** A group's part of the total, as a whole percentage; null when the total is zero. */
export function share(part: number, total: number): number | null {
  return total > 0 ? Math.round((part / total) * 100) : null;
}

/** Fetches the controller's CSV for exactly the range and grouping on screen. The gateway relays it as
 * `text/csv`; anything else is an error and no file is offered. */
export async function usageCsv(
  range: { from: string; to: string },
  groupBy: UsageGroup,
): Promise<Blob> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25000);
  try {
    const response = await fetch(
      `/api/v1/${usagePath(range, groupBy, "csv")}`,
      {
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        signal: controller.signal,
      },
    );
    if (!response.ok) {
      let detail: unknown;
      try {
        detail = record(await response.json()).error;
      } catch {
        /* A refusal without a JSON body keeps the generic message. */
      }
      throw Object.assign(
        new Error(
          typeof detail === "string"
            ? detail
            : "The usage file could not be downloaded.",
        ),
        { status: response.status },
      );
    }
    if (
      response.headers.get("content-type")?.split(";", 1)[0]?.trim() !==
      "text/csv"
    )
      throw new Error("The usage file was not CSV.");
    return await response.blob();
  } catch (error) {
    if (
      error instanceof Error &&
      !("name" in error && error.name === "AbortError") &&
      !(error instanceof TypeError)
    )
      throw error;
    throw new Error("Could not download the usage file. Try again.");
  } finally {
    clearTimeout(timeout);
  }
}
export const csvName = (
  range: { from: string; to: string },
  groupBy: UsageGroup,
): string =>
  `canaveral-usage-${groupBy}-${range.from.slice(0, 10)}_${range.to.slice(0, 10)}.csv`;
