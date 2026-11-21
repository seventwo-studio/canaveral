import { useEffect, useRef, useState } from "react";
import { Download, RefreshCw } from "lucide-react";
import { api, errorMessage } from "@/lib/api";
import { localTime } from "@/lib/clock";
import type { User } from "@/lib/inventory";
import {
  csvName,
  deviceTime,
  failures,
  groupLabels,
  groups,
  ranges,
  seconds,
  share,
  usageCsv,
  usagePath,
  usageRange,
  usageReport,
  type Distribution,
  type RangeChoice,
  type UsageGroup,
  type UsageReport as Report,
  type UsageRow,
} from "@/lib/usage";
import { Alert, AlertDescription } from "./ui/alert";
import { Button } from "./ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "./ui/empty";
import { Field, FieldError, FieldLabel } from "./ui/field";
import { Input } from "./ui/input";

const denied = (e: unknown) =>
  e !== null &&
  typeof e === "object" &&
  "status" in e &&
  (e.status === 401 || e.status === 403);
const select =
  "h-10 w-full min-w-0 rounded-md border border-input bg-card px-2 text-sm md:h-9";
const figure = "font-mono tabular-nums";

/** p50 and p95 with the number of samples behind them, so a percentile over three leases reads as one. */
function Percentiles({ value }: { value: Distribution }) {
  if (!value.samples)
    return <span className="text-muted-foreground">No samples</span>;
  return (
    <>
      <span className={figure}>
        {seconds(value.p50)} · {seconds(value.p95)}
      </span>
      <span className="block text-xs text-muted-foreground">
        p50 · p95 of {value.samples}{" "}
        {value.samples === 1 ? "sample" : "samples"}
      </span>
    </>
  );
}
function Pair({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm [overflow-wrap:anywhere]">{children}</dd>
    </div>
  );
}
function Figures({ row, total }: { row: UsageRow; total: UsageRow }) {
  const part = share(row.leases.deviceSeconds, total.leases.deviceSeconds);
  const failed = failures(row);
  return (
    <dl className="grid min-w-0 grid-cols-2 gap-x-4 gap-y-3 md:grid-cols-4">
      <Pair label="Requests by outcome">
        {row.requests ? (
          <>
            <span className={figure}>{row.requests.submitted}</span> submitted
            <span className="block text-xs text-muted-foreground">
              <span className={figure}>{row.requests.admitted}</span> admitted ·{" "}
              <span className={figure}>{row.requests.cancelled}</span> cancelled
              · <span className={figure}>{row.requests.expired}</span> expired ·{" "}
              <span className={figure}>{row.requests.rejected}</span> rejected ·{" "}
              <span className={figure}>{row.requests.waiting}</span> still
              waiting
            </span>
          </>
        ) : (
          <span className="text-muted-foreground">Not counted by host</span>
        )}
      </Pair>
      <Pair label="Wait until admitted">
        {row.requests ? (
          <Percentiles value={row.requests.waitSeconds} />
        ) : (
          <span className="text-muted-foreground">Not counted by host</span>
        )}
      </Pair>
      <Pair label="Leases">
        <span className={figure}>{row.leases.admitted}</span> admitted
        <span className="block text-xs text-muted-foreground">
          <span className={figure}>{row.leases.ready}</span> became ready ·{" "}
          <span className={figure}>{row.leases.released}</span> released ·{" "}
          <span className={figure}>{row.leases.expired}</span> expired ·{" "}
          <span className={figure}>{row.leases.active}</span> active
        </span>
      </Pair>
      <Pair label="Device time held">
        <span className={figure}>{deviceTime(row.leases.deviceSeconds)}</span>
        {row !== total && part !== null && (
          <>
            <meter
              className="mt-1 block h-2 w-full max-w-40"
              min={0}
              max={100}
              value={part}
              aria-label={`${part}% of the device time held in this range`}
            />
            <span className="block text-xs text-muted-foreground">
              <span className={figure}>{part}%</span> of the total
            </span>
          </>
        )}
      </Pair>
      <Pair label="Time to ready">
        <Percentiles value={row.leases.timeToReadySeconds} />
      </Pair>
      <Pair label="Hold time">
        <Percentiles value={row.leases.holdSeconds} />
      </Pair>
      <Pair label="Failures">
        <span className={`${figure} ${failed ? "text-destructive" : ""}`}>
          {failed}
        </span>
        <span className="block text-xs text-muted-foreground">
          <span className={figure}>{row.leases.failed}</span> failed leases ·{" "}
          <span className={figure}>{row.leases.cleanupBlocked}</span> with
          cleanup blocked
          {row.requests && (
            <>
              {" "}
              · <span className={figure}>{row.requests.rejected}</span> rejected
              requests
            </>
          )}
        </span>
      </Pair>
    </dl>
  );
}

export function UsageReport({
  user,
  onDenied,
}: {
  user: User;
  onDenied: () => void;
}) {
  // A new component instance fences every response when account identity changes.
  return (
    <UsageSession
      key={`${user.id}:${user.role}:${user.status}`}
      user={user}
      onDenied={onDenied}
    />
  );
}
function UsageSession({
  user,
  onDenied,
}: {
  user: User;
  onDenied: () => void;
}) {
  const [choice, setChoice] = useState<RangeChoice>("24h");
  const [custom, setCustom] = useState({ from: "", to: "" });
  const [groupBy, setGroupBy] = useState<UsageGroup>("application");
  const [report, setReport] = useState<Report | null>(null);
  /** The question the report on screen answers. */
  const [answered, setAnswered] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [download, setDownload] = useState<{ busy: boolean; error: string }>({
    busy: false,
    error: "",
  });
  const mounted = useRef(false),
    refused = useRef(false),
    epoch = useRef(0);
  const deniedCallback = useRef(onDenied);
  deniedCallback.current = onDenied;
  const question = JSON.stringify([choice, custom, groupBy]);
  const customRange =
    choice === "custom" ? usageRange(choice, custom, 0) : null;
  const rangeError =
    customRange && "error" in customRange ? customRange.error : "";

  function fail(e: unknown) {
    if (denied(e)) {
      refused.current = true;
      setReport(null);
      setError("Administrator access is required.");
      deniedCallback.current();
      return true;
    }
    return false;
  }
  async function load() {
    if (!mounted.current || refused.current || user.role !== "admin") return;
    const range = usageRange(choice, custom, Date.now());
    if ("error" in range) return;
    const request = ++epoch.current;
    setLoading(true);
    try {
      const next = await api(usagePath(range, groupBy), undefined, (value) =>
        usageReport(value, groupBy),
      );
      if (!mounted.current || epoch.current !== request) return;
      setReport(next);
      setAnswered(question);
      setError("");
    } catch (e) {
      if (!mounted.current || epoch.current !== request) return;
      if (!fail(e)) setError(errorMessage(e));
    } finally {
      if (mounted.current && epoch.current === request) setLoading(false);
    }
  }
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // A report is read when the question changes and on request. It is not polled: each read scans the
  // request ledger for the whole range.
  useEffect(() => {
    void load();
  }, [choice, custom.from, custom.to, groupBy]);

  async function save() {
    if (!report || download.busy) return;
    setDownload({ busy: true, error: "" });
    try {
      // The file covers exactly the range and grouping on screen.
      const blob = await usageCsv(report, report.groupBy);
      if (!mounted.current) return;
      const url = URL.createObjectURL(blob),
        link = document.createElement("a");
      link.href = url;
      link.download = csvName(report, report.groupBy);
      document.body.append(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      setDownload({ busy: false, error: "" });
    } catch (e) {
      if (!mounted.current) return;
      if (!fail(e)) setDownload({ busy: false, error: errorMessage(e) });
    }
  }
  if (user.role !== "admin")
    return <p role="alert">Administrator access is required.</p>;
  // A report stays on screen while the next one is read; the page says when it answers an earlier question.
  const earlier = !!report && answered !== question;
  const beforeLedger =
    report?.leaseLedgerStartedAt &&
    Date.parse(report.from) < Date.parse(report.leaseLedgerStartedAt);
  return (
    <div className="min-w-0 space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h1 className="font-display text-3xl font-medium tracking-tight">
            Usage
          </h1>
          <p className="max-w-prose text-sm text-muted-foreground">
            What applications requested, what the controller admitted and how
            long leases were held. These are the controller's records. Device
            time is held lease time, not CPU, memory or power measured on a
            host.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            disabled={loading || !!rangeError}
            onClick={() => void load()}
          >
            <RefreshCw aria-hidden="true" />
            Refresh usage
          </Button>
          <Button
            variant="outline"
            disabled={!report || download.busy}
            onClick={() => void save()}
          >
            <Download aria-hidden="true" />
            {download.busy ? "Preparing CSV…" : "Download CSV"}
          </Button>
        </div>
      </div>

      <form
        className="grid min-w-0 gap-3 rounded-md border bg-card p-4 sm:grid-cols-2 lg:grid-cols-4"
        aria-label="Choose a usage report"
        onSubmit={(event) => event.preventDefault()}
      >
        <Field>
          <FieldLabel htmlFor="usage-range">Range</FieldLabel>
          <select
            id="usage-range"
            className={select}
            value={choice}
            onChange={(event) => setChoice(event.target.value as RangeChoice)}
          >
            {ranges.map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
            <option value="custom">Custom range</option>
          </select>
        </Field>
        <Field>
          <FieldLabel htmlFor="usage-group">Group by</FieldLabel>
          <select
            id="usage-group"
            className={select}
            value={groupBy}
            onChange={(event) => setGroupBy(event.target.value as UsageGroup)}
          >
            {groups.map((key) => (
              <option key={key} value={key}>
                {groupLabels[key]}
              </option>
            ))}
          </select>
        </Field>
        {choice === "custom" && (
          <>
            <Field>
              <FieldLabel htmlFor="usage-from">From (local time)</FieldLabel>
              <Input
                id="usage-from"
                type="datetime-local"
                className="font-mono text-xs"
                value={custom.from}
                onChange={(event) =>
                  setCustom((current) => ({
                    ...current,
                    from: event.target.value,
                  }))
                }
              />
            </Field>
            <Field data-invalid={!!rangeError || undefined}>
              <FieldLabel htmlFor="usage-to">To (local time)</FieldLabel>
              <Input
                id="usage-to"
                type="datetime-local"
                className="font-mono text-xs"
                aria-invalid={!!rangeError || undefined}
                aria-describedby={rangeError ? "usage-range-error" : undefined}
                value={custom.to}
                onChange={(event) =>
                  setCustom((current) => ({
                    ...current,
                    to: event.target.value,
                  }))
                }
              />
              {rangeError && (
                <FieldError id="usage-range-error">{rangeError}</FieldError>
              )}
            </Field>
          </>
        )}
      </form>

      {error && (
        <Alert variant="destructive" role="alert">
          <AlertDescription className="text-foreground">
            {report ? "The usage shown is from an earlier read. " : ""}
            {error}
          </AlertDescription>
        </Alert>
      )}
      {download.error && <p role="alert">{download.error}</p>}
      {!report && !error && !rangeError && <p role="status">Loading usage…</p>}
      {report && (
        <>
          <div className="space-y-1 text-xs text-muted-foreground">
            <p>
              {localTime(report.from)} to {localTime(report.to)} · by{" "}
              {groupLabels[report.groupBy].toLowerCase()} · read from the
              controller at {localTime(report.generatedAt)}
              {loading && " · reading again…"}
            </p>
            {earlier && !error && (
              <p role="status">
                This is the previous report. It is replaced when the one for the
                current choices arrives.
              </p>
            )}
            <p>
              Requests are counted by when they were submitted and leases by
              when they were admitted. Device time is the lease time that falls
              inside the range.{" "}
              {report.leaseLedgerStartedAt
                ? `Lease figures begin ${localTime(report.leaseLedgerStartedAt)}, when the usage ledger started; leases that ended before then are not in it.`
                : "This controller reports no usage ledger, so lease figures are unavailable rather than zero."}
            </p>
          </div>
          {beforeLedger && (
            <p role="status" className="text-sm">
              This range starts before the usage ledger did. Lease counts,
              device time and hold times cover only the part of the range after{" "}
              {localTime(report.leaseLedgerStartedAt!)}.
            </p>
          )}
          {report.groupBy === "host" && (
            <p className="text-sm text-muted-foreground">
              A request has no host until it is admitted, so grouping by host
              reports leases only. A workspace lease is listed under the host
              its resource domain is bound to.
            </p>
          )}
          <section
            className="min-w-0 space-y-3 rounded-md border bg-card p-4"
            aria-labelledby="usage-totals"
          >
            <h2 id="usage-totals" className="text-lg font-semibold">
              Total for the range
            </h2>
            <Figures row={report.totals} total={report.totals} />
          </section>
          <section className="min-w-0 space-y-3" aria-labelledby="usage-groups">
            <h2 id="usage-groups" className="text-lg font-semibold">
              By {groupLabels[report.groupBy].toLowerCase()}{" "}
              <span className="text-muted-foreground">
                ({report.rows.length})
              </span>
            </h2>
            {!report.rows.length ? (
              <Empty className="border">
                <EmptyHeader>
                  <EmptyTitle>Nothing recorded in this range</EmptyTitle>
                  <EmptyDescription>
                    A {groupLabels[report.groupBy].toLowerCase()} appears here
                    when a request was submitted or a lease was admitted or
                    still held between {localTime(report.from)} and{" "}
                    {localTime(report.to)}. Administrative machines that are not
                    leased and model run time are not part of usage.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <ul
                aria-label={`Usage by ${groupLabels[report.groupBy].toLowerCase()}`}
                className="min-w-0 divide-y overflow-hidden rounded-md border bg-card"
              >
                {report.rows.map((row) => (
                  <li key={row.key} className="min-w-0 space-y-3 px-4 py-4">
                    <div className="min-w-0">
                      {row.label && (
                        <p className="font-display text-base font-medium [overflow-wrap:anywhere]">
                          {row.label}
                        </p>
                      )}
                      <p
                        className={`[overflow-wrap:anywhere] ${row.label ? "font-mono text-xs text-muted-foreground" : "font-mono text-sm font-medium"}`}
                      >
                        {row.key}
                      </p>
                    </div>
                    <Figures row={row} total={report.totals} />
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}
