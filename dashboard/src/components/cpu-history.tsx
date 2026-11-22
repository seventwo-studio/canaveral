import { useId } from "react";
import { number } from "@/lib/api";
import type { Host, ResourceSample } from "@/lib/infrastructure";
import { Badge } from "./ui/badge";

const validCPU = (
  sample: ResourceSample,
): sample is ResourceSample & { cpuPercent: number } =>
  typeof sample.cpuPercent === "number" &&
  Number.isFinite(sample.cpuPercent) &&
  sample.cpuPercent >= 0 &&
  sample.cpuPercent <= 100;

/** Retain missing measurements in the time window; never join across them. */
export function cpuHistoryWindow(samples: ResourceSample[]) {
  return samples
    .filter(
      (s) =>
        Number.isFinite(s.receivedAt) &&
        s.receivedAt >= 0 &&
        Number.isFinite(new Date(s.receivedAt * 1000).getTime()),
    )
    .sort((a, b) => a.receivedAt - b.receivedAt)
    .slice(-60);
}

export function CpuHistory({
  samples,
  host,
  stale = false,
  loading = false,
}: {
  samples: ResourceSample[];
  host: Pick<Host, "online" | "usage">;
  stale?: boolean;
  loading?: boolean;
}) {
  const id = useId();
  const window = cpuHistoryWindow(samples);
  const measured = window.filter(validCPU);
  const first = window[0]?.receivedAt;
  const last = window.at(-1)?.receivedAt;
  const lastMeasurement = measured.at(-1)?.receivedAt;
  const old =
    stale ||
    !host.online ||
    host.usage?.fresh === false ||
    (lastMeasurement !== undefined && Date.now() / 1000 - lastMeasurement > 30);
  const scope =
    host.usage?.scope === "runner"
      ? "Runner CPU · not cluster capacity"
      : host.usage?.scope === "host"
        ? "Physical host CPU · includes other workloads"
        : "CPU scope not reported";
  const crossesDate =
    first !== undefined &&
    last !== undefined &&
    new Date(first * 1000).toDateString() !==
      new Date(last * 1000).toDateString();
  const time = (timestamp: number) =>
    new Date(timestamp * 1000).toLocaleString(undefined, {
      ...(crossesDate
        ? { month: "short" as const, day: "numeric" as const }
        : {}),
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  const fullTime = (timestamp: number) =>
    new Date(timestamp * 1000).toLocaleString();
  const iso = (timestamp: number) => new Date(timestamp * 1000).toISOString();
  const span = first !== undefined && last !== undefined ? last - first : 0;
  const x = (timestamp: number) =>
    span === 0 ? 300 : 8 + ((timestamp - first!) / span) * 584;
  const y = (value: number) => 168 - (value / 100) * 160;
  return (
    <figure
      className="min-w-0 space-y-3 rounded-md border p-4"
      aria-labelledby={`${id}-title`}
    >
      <figcaption className="flex flex-wrap items-start justify-between gap-2">
        <div className="space-y-1">
          <h3 id={`${id}-title`} className="text-sm font-medium">
            CPU history
          </h3>
          <p className="text-xs text-muted-foreground">{scope}</p>
        </div>
        <Badge variant="outline">
          {!host.online
            ? "Host offline · last samples"
            : loading
              ? "Loading"
              : measured.length === 0
                ? "No CPU measurements"
                : old
                  ? "Stale samples"
                  : "Reported samples"}
        </Badge>
      </figcaption>
      {loading ? (
        <p className="py-6 text-sm text-muted-foreground" role="status">
          Loading CPU samples…
        </p>
      ) : measured.length < 2 ? (
        <p className="py-6 text-sm text-muted-foreground">
          Not enough samples. At least two CPU measurements are needed.
        </p>
      ) : (
        <>
          <div className="grid min-w-0 grid-cols-[2.5rem_minmax(0,1fr)] gap-1">
            <div
              className="flex h-44 flex-col justify-between py-1 text-[10px] text-muted-foreground tabular-nums"
              aria-hidden="true"
            >
              <span>100%</span>
              <span>50%</span>
              <span>0%</span>
            </div>
            <svg
              viewBox="0 0 600 176"
              preserveAspectRatio="none"
              className="h-44 w-full overflow-visible"
              role="img"
              aria-label="CPU utilization history, reported samples from zero to one hundred percent"
              aria-describedby={`${id}-description`}
            >
              <title>
                {scope}. {measured.length} measurements from {iso(first!)} to{" "}
                {iso(last!)}.
              </title>
              {[0, 50, 100].map((value) => (
                <line
                  key={value}
                  x1="8"
                  x2="592"
                  y1={y(value)}
                  y2={y(value)}
                  stroke="var(--border)"
                  strokeDasharray="2 3"
                  strokeWidth="1"
                  vectorEffect="non-scaling-stroke"
                />
              ))}
              {measured.map((sample, index) => (
                <g key={`${sample.receivedAt}-${index}`}>
                  <line
                    x1={x(sample.receivedAt)}
                    x2={x(sample.receivedAt)}
                    y1="168"
                    y2={y(sample.cpuPercent)}
                    stroke="var(--foreground)"
                    opacity="0.2"
                    strokeWidth="1"
                    vectorEffect="non-scaling-stroke"
                  />
                  <circle
                    cx={x(sample.receivedAt)}
                    cy={y(sample.cpuPercent)}
                    r="3"
                    fill="var(--foreground)"
                    data-time={sample.receivedAt}
                    data-value={sample.cpuPercent}
                  >
                    <title>
                      {iso(sample.receivedAt)}: {number(sample.cpuPercent)}% CPU
                    </title>
                  </circle>
                </g>
              ))}
            </svg>
          </div>
          <div
            className="ml-10 flex min-w-0 justify-between gap-3 text-[10px] text-muted-foreground tabular-nums"
            aria-hidden="true"
          >
            <time dateTime={iso(first!)} title={fullTime(first!)}>
              {time(first!)}
            </time>
            <time dateTime={iso(last!)} title={fullTime(last!)}>
              {time(last!)}
            </time>
          </div>
          <p id={`${id}-description`} className="text-xs text-muted-foreground">
            {measured.length} measured · {window.length - measured.length}{" "}
            unavailable. Dots are reported samples; gaps are unmeasured. Local
            time.
          </p>
        </>
      )}
      {!loading && window.length > 0 && (
        <details className="min-w-0 border-t pt-3 text-xs">
          <summary className="w-fit cursor-pointer rounded-sm text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            View sample values
          </summary>
          <div className="mt-3 max-h-64 overflow-y-auto">
            <table className="w-full table-fixed text-left tabular-nums">
              <caption className="sr-only">
                Reported CPU sample values. Local time and percent of capacity.
              </caption>
              <thead>
                <tr className="border-b">
                  <th className="w-2/3 py-2 font-medium">Local time</th>
                  <th className="py-2 text-right font-medium">CPU</th>
                </tr>
              </thead>
              <tbody>
                {window.map((sample, index) => (
                  <tr
                    key={`${sample.receivedAt}-${index}`}
                    className="border-b last:border-0"
                  >
                    <td className="break-words py-2 pr-2">
                      <time dateTime={iso(sample.receivedAt)}>
                        {fullTime(sample.receivedAt)}
                      </time>
                    </td>
                    <td className="py-2 text-right">
                      {validCPU(sample)
                        ? `${number(sample.cpuPercent)}%`
                        : "Unavailable"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </figure>
  );
}
