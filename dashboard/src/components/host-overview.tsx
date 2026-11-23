import { allocationLimits } from "@/lib/infrastructure";
import type {
  Host,
  HostAllocation,
  HostImage,
  ResourceDetails,
} from "@/lib/infrastructure";
import type { Resources } from "@/lib/catalogue";
import { useState } from "react";
import { memory, number, provider, title } from "@/lib/api";
import { Badge, statusBadgeVariant } from "./ui/badge";
import { Button } from "./ui/button";
import { ToggleGroup, ToggleGroupItem } from "./ui/toggle-group";

const fills: Record<string, string> = {
  virtualMachines: "var(--foreground)",
  simulators: "color-mix(in srgb, var(--foreground) 80%, var(--background))",
  retainedDisks: "color-mix(in srgb, var(--foreground) 65%, var(--background))",
  images: "color-mix(in srgb, var(--foreground) 35%, var(--background))",
  imageTasks: "color-mix(in srgb, var(--foreground) 50%, var(--background))",
  inference: "color-mix(in srgb, var(--foreground) 25%, var(--background))",
};
const amount = (key: keyof Resources, value: number) =>
  key === "memoryMiB"
    ? memory(value)
    : `${number(value)} ${key === "cpu" ? "vCPU" : "GiB"}`;

export function StackedResources({
  host,
  data,
  unavailable = false,
}: {
  host: Host;
  data: ResourceDetails | null;
  unavailable?: boolean;
}) {
  const categories = data?.categories;
  const limits = allocationLimits({
    ...(data || host),
    effectiveCapacity: host.effectiveCapacity,
  });
  return (
    <section className="min-w-0 space-y-5" aria-label="Resources by category">
      <div>
        <h2 className="text-sm font-semibold">Resources</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Reserved capacity against this host’s limit. Measured usage is shown
          separately below.
        </p>
      </div>
      {!categories ? (
        <p className="text-xs text-muted-foreground">
          {unavailable
            ? "Resource categories unavailable."
            : "Loading resource categories…"}
        </p>
      ) : (
        <>
          <div className="grid min-w-0 gap-px overflow-hidden rounded-sm border bg-border sm:grid-cols-3">
            {(
              [
                ["cpu", "CPU"],
                ["memoryMiB", "Memory"],
                ["diskGiB", "Storage"],
              ] as const
            ).map(([key, label]) => {
              const total = categories.reduce(
                  (sum, item) => sum + item[key],
                  0,
                ),
                capacity = limits[key];
              const scale = Math.max(capacity, total, 1),
                free = Math.max(0, capacity - total);
              let offset = 0;
              return (
                <div key={key} className="min-w-0 space-y-2 bg-card p-3">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1 text-xs">
                    <h3 className="text-ui font-medium">{label}</h3>
                    <span className="tabular-nums">
                      {amount(key, total)} / {amount(key, capacity)}
                    </span>
                  </div>
                  <svg
                    viewBox="0 0 1000 24"
                    preserveAspectRatio="none"
                    className="block h-2 w-full overflow-hidden rounded-[2px]"
                    role="img"
                    aria-label={`${label} reservations by category`}
                  >
                    <title>
                      {categories
                        .map(
                          (item) => `${item.label}: ${amount(key, item[key])}`,
                        )
                        .join("; ")}
                      . Unreserved: {amount(key, free)}.
                    </title>
                    <rect width="1000" height="24" fill="var(--muted)" />
                    {categories.map((item) => {
                      const x = offset;
                      offset += (item[key] / scale) * 1000;
                      return (
                        <rect
                          key={item.id}
                          data-category={item.id}
                          x={x}
                          y="0"
                          width={(item[key] / scale) * 1000}
                          height="24"
                          fill={fills[item.id] || "var(--muted-foreground)"}
                          stroke="var(--background)"
                          vectorEffect="non-scaling-stroke"
                          strokeWidth={item[key] > 0 ? 0.5 : 0}
                        >
                          <title>
                            {item.label}: {amount(key, item[key])}
                          </title>
                        </rect>
                      );
                    })}
                    {total > capacity && (
                      <line
                        x1={(capacity / scale) * 1000}
                        x2={(capacity / scale) * 1000}
                        y1="0"
                        y2="24"
                        stroke="var(--destructive)"
                        vectorEffect="non-scaling-stroke"
                        strokeWidth="2"
                      />
                    )}
                  </svg>
                  <p
                    className={`text-xs ${total > capacity ? "text-destructive" : "text-muted-foreground"}`}
                  >
                    {total > capacity
                      ? `${amount(key, total - capacity)} over limit`
                      : `${amount(key, free)} unreserved`}
                  </p>
                </div>
              );
            })}
          </div>
          <section aria-label="Canaveral reservations by category">
            <dl className="divide-y border-y">
              {categories.map((item) => (
                <div
                  key={item.id}
                  className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-1 py-2 text-xs"
                >
                  <dt className="flex min-w-0 items-center gap-2">
                    <span
                      aria-hidden="true"
                      className="size-2 shrink-0 rounded-full"
                      style={{
                        backgroundColor:
                          fills[item.id] || "var(--muted-foreground)",
                      }}
                    />
                    <span className="break-words">{item.label}</span>
                  </dt>
                  <dd className="flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground">
                    <span>{number(item.cpu)} vCPU</span>
                    <span>{memory(item.memoryMiB)}</span>
                    <span>{number(item.diskGiB)} GiB disk</span>
                  </dd>
                </div>
              ))}
            </dl>
          </section>
          <p className="text-xs text-muted-foreground">
            Stopped disks and unresolved work keep their reservations. Image
            aliases sharing one artifact are charged once.
          </p>
        </>
      )}
    </section>
  );
}

export function HostMachines({
  host,
  machines,
  allocations,
  onInspect,
  onControl,
}: {
  host: Host;
  machines: HostAllocation[];
  allocations?: HostAllocation[];
  onInspect?: (id: string) => void;
  onControl?: (id: string) => void;
}) {
  const [filter, setFilter] = useState("all");
  const rows = new Map<string, HostAllocation>(
    (allocations || []).map((item) => [item.id, item]),
  );
  for (const item of machines)
    rows.set(item.id, { ...rows.get(item.id), ...item, known: true });
  const members = [...rows.values()].sort(
    (a, b) =>
      Number(b.observed === "running") - Number(a.observed === "running") ||
      a.name.localeCompare(b.name),
  );
  const running = host.online
    ? members.filter((item) => item.observed === "running").length
    : 0;
  const visible =
    filter === "running"
      ? members.filter((item) => host.online && item.observed === "running")
      : members;
  return (
    <section className="min-w-0 space-y-3" aria-label="Host machines">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold">Machines</h2>
        <span className="text-xs text-muted-foreground">
          {host.online ? `${running} running` : "Runtime unknown"} ·{" "}
          {members.length} assigned
        </span>
      </div>
      <ToggleGroup
        type="single"
        variant="outline"
        size="sm"
        value={filter}
        onValueChange={(value) => value && setFilter(value)}
        className="max-w-full flex-wrap border"
        aria-label="Host machine filter"
      >
        <ToggleGroupItem value="all">All machines</ToggleGroupItem>
        <ToggleGroupItem value="running" disabled={!host.online}>
          Running
        </ToggleGroupItem>
      </ToggleGroup>
      {visible.length ? (
        <ul className="divide-y border-y">
          {visible.map((machine) => (
            <li key={machine.id} className="min-w-0 space-y-1.5 py-3">
              <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                <span className="min-w-0 break-words text-ui font-medium">
                  {machine.name}
                </span>
                <Badge
                  variant={
                    host.online
                      ? statusBadgeVariant(machine.observed)
                      : "secondary"
                  }
                >
                  {host.online ? title(machine.observed) : "Host offline"}
                </Badge>
              </div>
              {machine.template && (
                <p className="text-xs text-muted-foreground">
                  {provider(machine.template.os)} · {machine.template.arch} ·{" "}
                  {machine.template.name || machine.templateId}
                </p>
              )}
              <p className="text-xs text-muted-foreground">
                {machine.resources.cpu} vCPU ·{" "}
                {memory(machine.resources.memoryMiB)} ·{" "}
                {number(machine.resources.diskGiB)} GiB disk
              </p>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs text-muted-foreground">
                  {machine.computeReserved === false
                    ? "Disk retained"
                    : "Compute and disk reserved"}
                </span>
                <div className="flex flex-wrap gap-2">
                  {machine.known && onInspect && (
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`Inspect ${machine.name}`}
                      onClick={() => onInspect(machine.id)}
                    >
                      Details
                    </Button>
                  )}
                  {machine.known &&
                    host.online &&
                    machine.ready &&
                    (machine.template?.mode === "device" ||
                      machine.template?.guestAccess) &&
                    onControl && (
                      <Button size="sm" onClick={() => onControl(machine.id)}>
                        Control
                      </Button>
                    )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="py-4 text-xs text-muted-foreground">
          {!host.online && filter === "running"
            ? "Running state is unavailable while the host is offline."
            : filter === "running"
              ? "No machines running on this host."
              : "No machines assigned to this host."}
        </p>
      )}
    </section>
  );
}

export function HostImages({
  host,
  images = [],
  loading = false,
  unavailable = false,
}: {
  host: Host;
  images?: HostImage[];
  loading?: boolean;
  unavailable?: boolean;
}) {
  return (
    <section className="min-w-0 space-y-3" aria-label="Installed images">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold">Installed images</h2>
        <span className="text-xs text-muted-foreground">
          {!loading &&
            !unavailable &&
            `${images.length} ${images.length === 1 ? "image" : "images"}`}
        </span>
      </div>
      {loading || unavailable ? (
        <p className="py-4 text-xs text-muted-foreground" role="status">
          {unavailable
            ? "Installed image inventory unavailable."
            : "Loading installed images…"}
        </p>
      ) : images.length ? (
        <ul className="divide-y border-y">
          {images.map((image) => (
            <li
              key={`${image.id}:${image.revision}:${image.arch}`}
              className="min-w-0 space-y-1.5 py-3"
            >
              <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                <span className="min-w-0 break-words text-ui font-medium">
                  {image.name || image.id}
                </span>
                <Badge variant="outline">
                  {image.kind === "derived" || image.imageKind === "derived"
                    ? "Captured image"
                    : image.origin === "library"
                      ? "Base image"
                      : "Runtime image"}
                </Badge>
              </div>
              <p className="break-words text-xs text-muted-foreground">
                {provider(image.os)} · {image.arch} · Revision {image.revision}
                {image.format ? ` · ${image.format.toUpperCase()}` : ""}
              </p>
              <div className="flex flex-wrap justify-between gap-2 text-xs text-muted-foreground">
                <span>
                  {image.bytes == null
                    ? "Managed by the runtime"
                    : `${number(image.bytes / 1073741824)} GiB artifact`}
                </span>
                <span>
                  {image.offered === false
                    ? "Not offered for creation"
                    : host.online
                      ? "Offered by host"
                      : "Host offline"}
                </span>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="py-4 text-xs text-muted-foreground">
          No installed images reported.
        </p>
      )}
    </section>
  );
}
