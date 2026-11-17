import { useId, useState } from "react";
import { Button } from "./ui/button";
import { attention } from "@/lib/api";
import { hostIssue, stateFilter } from "@/lib/fleet";
import type { Inventory } from "@/lib/inventory";
import { machineStatus, memory, number } from "@/lib/api";
import { allocationLimits } from "@/lib/infrastructure";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "./ui/card";
import { Badge } from "./ui/badge";

const states = [
  "Ready",
  "Preparing",
  "Running",
  "Stopped",
  "Pending",
  "Setup failed",
  "Error",
  "Unknown",
];
const stateColor = (state: string) =>
  ["Error", "Unknown", "Setup failed"].includes(state)
    ? "var(--destructive)"
    : state === "Ready"
      ? "var(--state-ready)"
      : ["Preparing", "Pending"].includes(state)
        ? "var(--state-pending)"
        : state === "Running"
          ? "var(--foreground)"
          : "var(--muted-foreground)";

/** Each machine appears once; preserve new controller states rather than hiding them. */
export function machineDistribution(inventory: Inventory) {
  const counts = new Map<string, number>();
  for (const machine of inventory.machines) {
    const status = machineStatus(machine);
    counts.set(status, (counts.get(status) ?? 0) + 1);
  }
  return [...new Set([...states, ...counts.keys()])]
    .filter((label) => counts.has(label))
    .map((label) => ({ label, count: counts.get(label)! }));
}

export function FleetPulse({
  inventory,
  loaded,
  stale,
  showHosts = false,
  onSelectState,
  activeFilter,
}: {
  inventory: Inventory;
  loaded: boolean;
  stale: boolean;
  showHosts?: boolean;
  onSelectState?: (filter: string) => void;
  activeFilter?: string;
}) {
  const distribution = machineDistribution(inventory);
  const total = inventory.machines.length;
  const [expanded, setExpanded] = useState(false);
  const [mobileReservations, setMobileReservations] = useState(false);
  const reservationId = useId();
  const hosts = inventory.hosts
    .map((host, index) => ({ host, index }))
    .sort(
      (a, b) =>
        Number(Boolean(hostIssue(b.host))) -
          Number(Boolean(hostIssue(a.host))) || a.index - b.index,
    )
    .map(({ host }) => host);
  const visibleHosts = expanded ? hosts : hosts.slice(0, 3);
  const problems = inventory.machines.filter(attention).length;
  let offset = 0;
  return (
    <section
      aria-label="Fleet pulse"
      className={`grid min-w-0 gap-4 ${showHosts ? "xl:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]" : ""}`}
    >
      <Card className="min-w-0 shadow-none">
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="font-display text-lg font-medium">
              Fleet status
            </CardTitle>
            <Badge variant="outline">
              {!loaded
                ? "Unavailable"
                : stale
                  ? "Last snapshot"
                  : "Current snapshot"}
            </Badge>
          </div>
          <CardDescription>
            {loaded
              ? `${total} ${total === 1 ? "machine" : "machines"} · ${inventory.machines.filter((m) => m.ready).length} ready`
              : "Inventory unavailable"}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {!loaded || !total ? (
            <p className="text-sm text-muted-foreground">
              {loaded ? "No machines yet" : "Waiting for inventory…"}
            </p>
          ) : (
            <div className="flex flex-wrap items-center gap-3 sm:gap-6">
              <svg
                viewBox="0 0 128 128"
                role="img"
                aria-label={`${total} machines by state`}
                className="size-24 shrink-0 sm:size-32"
              >
                <title>
                  {distribution
                    .map(({ label, count }) => `${label}: ${count}`)
                    .join("; ")}
                </title>
                <circle
                  cx="64"
                  cy="64"
                  r="52"
                  fill="none"
                  stroke="var(--muted)"
                  strokeWidth="10"
                />
                {distribution.map(({ label, count }) => {
                  const start = offset;
                  offset += (count / total) * 100;
                  return (
                    <circle
                      key={label}
                      cx="64"
                      cy="64"
                      r="52"
                      pathLength="100"
                      fill="none"
                      stroke={stateColor(label)}
                      strokeWidth="10"
                      strokeDasharray={`${(count / total) * 100} ${100 - (count / total) * 100}`}
                      strokeDashoffset={-start}
                      transform="rotate(-90 64 64)"
                    />
                  );
                })}
                {distribution.map(({ label }, index) => {
                  const before = distribution
                    .slice(0, index)
                    .reduce((sum, row) => sum + row.count, 0);
                  const angle = (before / total) * Math.PI * 2 - Math.PI / 2;
                  return distribution.length > 1 ? (
                    <line
                      key={`boundary-${label}`}
                      x1={64 + Math.cos(angle) * 47}
                      y1={64 + Math.sin(angle) * 47}
                      x2={64 + Math.cos(angle) * 57}
                      y2={64 + Math.sin(angle) * 57}
                      stroke="var(--card)"
                      strokeWidth="2"
                    />
                  ) : null;
                })}
                <text
                  x="64"
                  y="63"
                  textAnchor="middle"
                  fill="var(--foreground)"
                  className="font-display text-3xl"
                >
                  {total}
                </text>
                <text
                  x="64"
                  y="81"
                  textAnchor="middle"
                  fill="var(--muted-foreground)"
                  className="text-[10px]"
                >
                  machines
                </text>
              </svg>
              <ul
                className="min-w-0 flex-1 space-y-1"
                aria-label="Machine state distribution"
              >
                {distribution.map(({ label, count }) => (
                  <li key={label}>
                    {onSelectState ? (
                      <button
                        type="button"
                        aria-pressed={activeFilter === stateFilter(label)}
                        aria-label={`Filter ${label.toLowerCase()} machines: ${count}`}
                        onClick={() => onSelectState(stateFilter(label))}
                        className="flex min-h-8 w-full items-center gap-2 rounded-sm px-2 text-left text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring aria-pressed:bg-accent"
                      >
                        <svg
                          viewBox="0 0 8 8"
                          className="size-2 shrink-0"
                          aria-hidden="true"
                        >
                          <rect width="8" height="8" fill={stateColor(label)} />
                        </svg>
                        <span>{label}</span>
                        <span className="ml-auto tabular-nums">{count}</span>
                        <span className="hidden w-10 text-right tabular-nums text-muted-foreground sm:inline">
                          {Math.round((count / total) * 100)}%
                        </span>
                      </button>
                    ) : (
                      <div className="flex min-h-8 items-center gap-2 text-xs">
                        <svg
                          viewBox="0 0 8 8"
                          className="size-2 shrink-0"
                          aria-hidden="true"
                        >
                          <rect width="8" height="8" fill={stateColor(label)} />
                        </svg>
                        <span>{label}</span>
                        <span className="ml-auto tabular-nums">{count}</span>
                        <span className="hidden w-10 text-right text-muted-foreground sm:inline">
                          {Math.round((count / total) * 100)}%
                        </span>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {loaded && total > 0 && (
            <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t pt-3 text-xs">
              <span className="text-muted-foreground">
                All machines · before filters
              </span>
              {onSelectState ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className={
                    problems ? "text-destructive" : "text-muted-foreground"
                  }
                  onClick={() => onSelectState("attention")}
                >
                  {problems} {problems === 1 ? "needs" : "need"} attention
                </Button>
              ) : (
                <span
                  className={
                    problems ? "text-destructive" : "text-muted-foreground"
                  }
                >
                  {problems} {problems === 1 ? "needs" : "need"} attention
                </span>
              )}
            </div>
          )}
        </CardContent>
      </Card>
      {showHosts && (
        <Card className="min-w-0 shadow-none">
          <CardHeader>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <CardTitle className="font-display text-lg font-medium">
                Host reservations
              </CardTitle>
              {loaded && (
                <span className="text-xs text-muted-foreground">
                  {inventory.hosts.filter((h) => h.online).length}/
                  {inventory.hosts.length} online
                </span>
              )}
            </div>
            <CardDescription className="flex flex-wrap items-center justify-between gap-2">
              <span>Reserved / limit{stale ? " · last snapshot" : ""}</span>
              <Button
                size="sm"
                variant="ghost"
                className="md:hidden"
                aria-label={`${mobileReservations ? "Hide" : "Show"} host reservations`}
                aria-expanded={mobileReservations}
                aria-controls={reservationId}
                onClick={() => setMobileReservations(!mobileReservations)}
              >
                {mobileReservations ? "Hide" : "Show"}
              </Button>
            </CardDescription>
          </CardHeader>
          <CardContent
            id={reservationId}
            className={mobileReservations ? "" : "hidden md:block"}
          >
            {!loaded || !inventory.hosts.length ? (
              <p className="text-sm text-muted-foreground">
                {loaded ? "No hosts connected" : "Inventory unavailable"}
              </p>
            ) : (
              <ul className="divide-y">
                {visibleHosts.map((host, index) => {
                  const limits = allocationLimits(host);
                  const issue = hostIssue(host) ?? "Online";
                  return (
                    <li
                      key={host.id}
                      className={`${index > 0 && !expanded ? "hidden md:grid" : "grid"} min-w-0 gap-3 py-3 first:pt-0 last:pb-0 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]`}
                    >
                      <div className="min-w-0 space-y-1">
                        <a
                          className="block break-words text-sm underline-offset-4 hover:underline"
                          href={`#${host.kind === "orchestrator" || host.provider === "kubevirt" ? "orchestrators" : "hosts"}/${encodeURIComponent(host.id)}/resources`}
                        >
                          {host.name}
                        </a>
                        <span
                          className={`text-xs ${issue === "Online" ? "text-muted-foreground" : "text-destructive"}`}
                        >
                          {issue}
                        </span>
                      </div>
                      <div className="grid min-w-0 grid-cols-3 gap-3">
                        {(
                          [
                            ["cpu", "CPU"],
                            ["memoryMiB", "Memory"],
                            ["diskGiB", "Disk"],
                          ] as const
                        ).map(([key, label]) => {
                          const used = host.reserved?.[key];
                          const limit = limits[key];
                          const format = (v: number) =>
                            key === "memoryMiB" ? memory(v) : number(v);
                          return (
                            <div
                              key={key}
                              className="min-w-0 space-y-1 text-xs"
                            >
                              <span className="text-muted-foreground">
                                {label}
                                {key === "cpu"
                                  ? " · vCPU"
                                  : key === "diskGiB"
                                    ? " · GiB"
                                    : ""}
                              </span>
                              {used === undefined ? (
                                <p>Unavailable</p>
                              ) : (
                                <>
                                  <meter
                                    aria-label={`${host.name} ${label} reserved`}
                                    min={0}
                                    max={Math.max(used, limit, 1)}
                                    value={used}
                                    optimum={0}
                                    high={limit || undefined}
                                  />
                                  <p
                                    className={`break-words tabular-nums ${used > limit ? "text-destructive" : ""}`}
                                  >
                                    {format(used)} / {format(limit)}
                                    {used > limit && (
                                      <span className="block">Over limit</span>
                                    )}
                                  </p>
                                </>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
            {loaded && hosts.length > 1 && (
              <div
                className={`mt-4 border-t pt-3 ${hosts.length <= 3 && !expanded ? "md:hidden" : ""}`}
              >
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setExpanded(!expanded)}
                >
                  {expanded
                    ? "Show fewer connections"
                    : `Show all ${hosts.length} connections`}
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </section>
  );
}
