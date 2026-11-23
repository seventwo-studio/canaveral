import { useId, useState } from "react";
import { Button } from "./ui/button";
import { attention } from "@/lib/api";
import { hostIssue, stateFilter } from "@/lib/fleet";
import type { Inventory } from "@/lib/inventory";
import { machineStatus, memory, number } from "@/lib/api";
import { allocationLimits } from "@/lib/infrastructure";
import {
  Card,
  CardAction,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "./ui/card";

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
      ? "var(--foreground)"
      : ["Preparing", "Pending"].includes(state)
        ? "var(--state-pending)"
        : state === "Running"
          ? "var(--muted-foreground)"
          : "color-mix(in srgb, var(--foreground) 40%, var(--background))";

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
  const attentionLabel = `${problems} ${problems === 1 ? "needs" : "need"} attention`;
  const ready = inventory.machines.filter((machine) => machine.ready).length;
  return (
    <section
      aria-label="Fleet pulse"
      className={`grid min-w-0 overflow-hidden rounded-md border bg-card ${showHosts ? "xl:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]" : ""}`}
    >
      <Card className="min-w-0 gap-2 rounded-none border-0 py-3 shadow-none md:gap-3 md:py-4">
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="text-sm">Fleet status</CardTitle>
            <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
              <span
                aria-hidden="true"
                className={`size-1.5 rounded-full ${!loaded ? "bg-muted-foreground" : stale ? "bg-[var(--state-pending)]" : "bg-[var(--state-ready)]"}`}
              />
              {!loaded
                ? "Unavailable"
                : stale
                  ? "Last snapshot"
                  : "Current snapshot"}
            </span>
          </div>
          <CardDescription>
            {loaded
              ? `${total} ${total === 1 ? "machine" : "machines"} · ${ready} ready`
              : "Inventory unavailable"}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {!loaded || !total ? (
            <p className="text-ui text-muted-foreground">
              {loaded ? "No machines yet" : "Waiting for inventory…"}
            </p>
          ) : (
            <div className="space-y-2.5">
              <div
                role="img"
                aria-label={`${total} machines by state`}
                className="flex h-2 overflow-hidden rounded-[2px] bg-muted"
              >
                {distribution.map(({ label, count }) => (
                  <span
                    key={label}
                    className="min-w-0 border-r border-background last:border-0"
                    style={{
                      width: `${(count / total) * 100}%`,
                      backgroundColor: stateColor(label),
                    }}
                  />
                ))}
              </div>
              <ul
                className="flex flex-wrap gap-1"
                aria-label="Machine state distribution"
              >
                {distribution.map(({ label, count }) => {
                  const contents = (
                    <>
                      <span
                        className="size-1.5 shrink-0 rounded-full"
                        style={{ backgroundColor: stateColor(label) }}
                        aria-hidden="true"
                      />
                      <span>{label}</span>
                      <span className="tabular-nums text-muted-foreground">
                        {count}
                      </span>
                    </>
                  );
                  return (
                    <li key={label}>
                      {onSelectState ? (
                        <button
                          type="button"
                          aria-pressed={activeFilter === stateFilter(label)}
                          aria-label={`Filter ${label.toLowerCase()} machines: ${count}`}
                          onClick={() => onSelectState(stateFilter(label))}
                          className="inline-flex min-h-8 items-center gap-1.5 rounded-md border border-transparent px-2 text-xs hover:bg-accent aria-pressed:border-input aria-pressed:bg-accent"
                        >
                          {contents}
                        </button>
                      ) : (
                        <span className="inline-flex min-h-8 items-center gap-1.5 px-2 text-xs">
                          {contents}
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
          {loaded && total > 0 && (
            <div className="mt-1.5 flex flex-wrap items-center justify-between gap-x-2 gap-y-0.5 border-t pt-1.5 text-xs">
              <span className="text-muted-foreground">Before filters</span>
              {problems > 0 &&
                (onSelectState ? (
                  <button
                    type="button"
                    className="min-h-8 rounded-sm text-destructive underline-offset-4 hover:underline"
                    onClick={() => onSelectState("attention")}
                  >
                    {attentionLabel}
                  </button>
                ) : (
                  <span className="text-destructive">{attentionLabel}</span>
                ))}
            </div>
          )}
        </CardContent>
      </Card>
      {showHosts && (
        <Card className="min-w-0 gap-3 rounded-none border-0 border-t py-3 shadow-none md:py-4 xl:border-t-0 xl:border-l">
          <CardHeader className="md:has-data-[slot=card-action]:grid-cols-1">
            <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
              <CardTitle className="text-sm">Host reservations</CardTitle>
              {loaded && (
                <span className="text-xs text-muted-foreground">
                  {inventory.hosts.filter((h) => h.online).length}/
                  {inventory.hosts.length} online
                </span>
              )}
            </div>
            <CardDescription
              className={mobileReservations || stale ? "" : "hidden md:block"}
            >
              Reserved / limit{stale ? " · last snapshot" : ""}
            </CardDescription>
            <CardAction className="self-center md:hidden">
              <Button
                size="sm"
                variant="ghost"
                aria-label={`${mobileReservations ? "Hide" : "Show"} host reservations`}
                aria-expanded={mobileReservations}
                aria-controls={reservationId}
                onClick={() => setMobileReservations(!mobileReservations)}
              >
                {mobileReservations ? "Hide" : "Show"}
              </Button>
            </CardAction>
          </CardHeader>
          <CardContent
            id={reservationId}
            className={mobileReservations ? "" : "hidden md:block"}
          >
            {!loaded || !inventory.hosts.length ? (
              <p className="text-ui text-muted-foreground">
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
                          className="block break-words text-ui font-medium underline-offset-4 hover:underline"
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
                                    className={`break-words text-ui tabular-nums ${used > limit ? "text-destructive" : ""}`}
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
