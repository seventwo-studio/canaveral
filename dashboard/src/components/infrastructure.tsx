import type { FormEvent, ReactNode } from "react";
import {
  allocationLimits,
  connectionSetups,
  resourceDetails,
  runnerBindings,
  setupReceipt,
  setupRevocation,
} from "@/lib/infrastructure";
import type {
  Host,
  HostAllocation,
  IssuedSetup,
  NamespaceObservation,
  ResourceDetails,
  RunnerBindings,
  SetupActivity,
} from "@/lib/infrastructure";
import { resourceFields, resources } from "@/lib/catalogue";
import type { Refresh, ResourceInput } from "@/lib/catalogue";
import { useEffect, useRef, useState } from "react";
import {
  Server,
  Orbit,
  Download,
  RefreshCw,
  Check,
  AlertTriangle,
  ArrowUpRight,
} from "lucide-react";
import { api, errorMessage, memory, number, provider, since } from "@/lib/api";
import { Button } from "./ui/button";
import { StackedResources, HostMachines, HostImages } from "./host-overview";
import { HostLimits } from "./host-limits";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import { Badge } from "./ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "./ui/dialog";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from "./ui/card";

const kind = (h: Host) =>
  h.kind || (h.provider === "kubevirt" ? "orchestrator" : "host");
const runtimeChoices: Record<string, string[] | undefined> = {
  macos: ["apple", "android", "ios"],
  linux: ["libvirt", "android"],
  windows: ["hyperv"],
};
const runtimeDefaults = (name: string): Record<string, string> =>
  (
    ({
      apple: { runner: "/absolute/path/to/CanaveralVMRunner" },
      android: { androidSDK: "/absolute/path/to/android-sdk" },
      ios: {},
      libvirt: { uri: "qemu:///system" },
      hyperv: { switch: "Default Switch" },
    }) as Record<string, Record<string, string>>
  )[name] ?? {};
const defaults = (p: string) => ({
  storage:
    p === "windows"
      ? "C:\\Canaveral\\guests"
      : "/absolute/path/to/canaveral-guests",
  templates: [],
  ...(runtimeChoices[p]
    ? {
        runtimes: {
          [runtimeChoices[p]![0]!]: runtimeDefaults(runtimeChoices[p]![0]!),
        },
      }
    : { namespace: "canaveral-guests", context: "your-cluster-context" }),
});
const Metric = ({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) => (
  <div className="min-w-0">
    <dt className="text-[10px] text-muted-foreground">{label}</dt>
    <dd className="mt-1 break-words text-xs">{children}</dd>
  </div>
);
function Health({ host }: { host: Host }) {
  const health = host.health;
  return (
    <Badge variant="outline">
      {!health
        ? "Checks not reported"
        : !health.fresh
          ? "Checks stale"
          : health.status === "passed"
            ? "Checks passed"
            : health.status === "warning"
              ? "Check warnings"
              : health.status === "checking"
                ? "Checking…"
                : "Checks failed"}
    </Badge>
  );
}
function Usage({ host }: { host: Host }) {
  const u = host.usage;
  if (!u)
    return (
      <p className="text-xs text-muted-foreground">
        Usage not reported. Update the runner to enable telemetry.
      </p>
    );
  return (
    <div className="space-y-3">
      <p className="text-[10px] text-muted-foreground">
        {u.scope === "runner"
          ? "Runner usage · not cluster capacity"
          : "Physical host usage · includes other workloads"}{" "}
        · {u.fresh ? "Live" : "Stale"} · {since(u.receivedAt)}
      </p>
      <dl className="grid min-w-0 grid-cols-1 gap-3 min-[420px]:grid-cols-3 opacity-90">
        <Metric label="CPU busy">
          {u.cpuPercent == null ? "Unavailable" : `${number(u.cpuPercent)}%`}
        </Metric>
        <Metric label="Memory available">
          {u.memoryAvailableMiB == null
            ? "Unavailable"
            : memory(u.memoryAvailableMiB)}
        </Metric>
        <Metric label="Storage free">
          {u.diskFreeGiB == null
            ? "Unavailable"
            : `${number(u.diskFreeGiB)} GiB`}
        </Metric>
      </dl>
      <section
        className="space-y-2 border-t pt-3"
        aria-label="Canaveral measured usage"
      >
        <h3 className="text-xs font-medium">Canaveral measured usage</h3>
        {u.canaveral ? (
          u.canaveral.categories.map((g) => (
            <div
              key={g.id}
              className="flex flex-wrap justify-between gap-x-4 gap-y-1 text-xs"
            >
              <span>
                {
                  (
                    {
                      services: "Runner and helpers",
                      virtualMachines: "VM processes",
                      simulators: "Simulator processes",
                    } as Record<string, string>
                  )[g.id]
                }
              </span>
              <span className="text-muted-foreground">
                {g.cpuPercent == null
                  ? "CPU unavailable"
                  : `${number(g.cpuPercent)}% CPU`}{" "}
                ·{" "}
                {g.memoryMiB == null
                  ? "Memory unavailable"
                  : `${memory(g.memoryMiB)} RSS`}
              </span>
            </div>
          ))
        ) : (
          <p className="text-xs text-muted-foreground">
            Attribution not reported. Update the runner.
          </p>
        )}
        <p className="text-[10px] text-muted-foreground">
          {u.canaveral?.scope === "runner-and-owned-processes"
            ? "Runner tree and verified assigned VM processes. "
            : "Runner process tree only. "}
          Other detached runtimes, system-managed simulators and separately
          running services may be excluded. CPU is a share of host capacity; RSS
          may count shared memory more than once.
        </p>
      </section>
    </div>
  );
}
export function NamespaceResources({
  cluster,
}: {
  cluster: NamespaceObservation;
}) {
  const metrics = cluster.metrics,
    quotas = cluster.quotas;
  const cores = (value: number) =>
    new Intl.NumberFormat(undefined, { maximumFractionDigits: 6 }).format(
      value,
    );
  return (
    <section className="space-y-2 rounded-md border p-3 text-xs">
      <h3 className="font-medium">Namespace {cluster.namespace}</h3>
      <p className="text-muted-foreground">
        Includes all workloads in the namespace · sampled{" "}
        {since(cluster.sampledAt)}
      </p>
      <p>
        {metrics.status === "available"
          ? `${cores(metrics.cpuCores)} CPU cores · ${memory(metrics.memoryMiB)} · ${metrics.podCount} measured pods`
          : "Namespace usage unavailable. Check metrics-server, pod inventory and API permissions."}
      </p>
      {metrics.coverage && (
        <p className="text-muted-foreground">
          {metrics.coverage.status === "unavailable"
            ? "Measurement coverage unavailable."
            : `${metrics.coverage.measuredPods} of ${metrics.coverage.activePods} active pods have fresh complete measurements.`}
          {metrics.status === "available" && metrics.sampledAt
            ? ` Oldest measurement ${since(metrics.sampledAt)}.`
            : " Incomplete measurements are not shown as namespace totals."}
        </p>
      )}
      <section
        aria-label="Canaveral VM workload usage"
        className="space-y-1 border-t pt-2"
      >
        <h4 className="font-medium">Canaveral VM workloads</h4>
        {cluster.canaveral?.ownership.status === "complete" &&
        cluster.canaveral?.metrics.status === "available" ? (
          <>
            <p>
              {cores(cluster.canaveral.metrics.cpuCores)} CPU cores ·{" "}
              {memory(cluster.canaveral.metrics.memoryMiB)} ·{" "}
              {cluster.canaveral.metrics.podCount} measured pods
            </p>
            <p className="text-muted-foreground">
              Verified for {cluster.canaveral.ownership.verifiedMachines}{" "}
              assigned machine
              {cluster.canaveral.ownership.verifiedMachines === 1 ? "" : "s"}.
              Oldest measurement {since(cluster.canaveral.metrics.sampledAt)}.
            </p>
          </>
        ) : (
          <p className="text-muted-foreground">
            Canaveral VM usage unavailable. Ownership or measurements are
            incomplete.
          </p>
        )}
        <p className="text-muted-foreground">
          Assigned VM pods and their support pods. This usage is included in the
          namespace total.
        </p>
      </section>
      {quotas.status === "unavailable" ? (
        <p className="text-muted-foreground">
          Namespace quotas unavailable. Check resourcequota read permissions.
        </p>
      ) : !quotas.items.length ? (
        <p className="text-muted-foreground">
          No namespace resource quotas configured.
        </p>
      ) : (
        quotas.items.map((q) => (
          <div key={q.name} className="space-y-1 border-t pt-2">
            <p className="font-medium">Quota: {q.name}</p>
            {Object.entries(q.hard).map(([key, limit]) => (
              <p key={key} className="break-words text-muted-foreground">
                {key}:{" "}
                {q.used[key] == null ? "Unavailable" : number(q.used[key])} /{" "}
                {number(limit)}{" "}
                {key.includes("memory")
                  ? "MiB"
                  : key.includes("storage")
                    ? "GiB"
                    : key.includes("cpu")
                      ? "cores"
                      : "claims"}
              </p>
            ))}
          </div>
        ))
      )}
      <p className="text-muted-foreground">
        Kubernetes quota and live usage are observations; Canaveral host limits
        constrain placement reservations.
      </p>
    </section>
  );
}
function ReservationMeters({
  host,
  expanded = false,
}: {
  host: Host;
  expanded?: boolean;
}) {
  if (!host.reserved)
    return (
      <p className="text-xs text-muted-foreground">
        Reservation details unavailable.
      </p>
    );
  return (
    <div
      className={expanded ? "grid min-w-0 gap-4 sm:grid-cols-3" : "space-y-3"}
    >
      {(
        [
          ["cpu", "CPU", "vCPU"],
          ["memoryMiB", "Memory", null],
          ["diskGiB", "Storage", "GiB"],
        ] as const
      ).map(([key, label, unit]) => (
        <div key={key}>
          <div className="mb-1 flex flex-wrap justify-between gap-1 text-xs">
            <span>{label}</span>
            <span>
              {unit
                ? `${number(host.reserved?.[key] || 0)} / ${number(allocationLimits(host)[key])} ${unit}`
                : `${memory(host.reserved?.[key] || 0)} / ${memory(allocationLimits(host)[key])}`}
            </span>
          </div>
          <meter
            min="0"
            max={Math.max(1, allocationLimits(host)[key])}
            value={host.reserved?.[key] || 0}
            aria-label={`${label} reserved`}
          />
        </div>
      ))}
    </div>
  );
}
export function InfrastructureCard({
  host,
  busy,
  mutate,
  resourcesHref,
}: {
  host: Host;
  busy: boolean;
  resourcesHref: string;
  mutate: (
    path: string,
    value: unknown,
    message: string,
  ) => void | Promise<void>;
}) {
  const orchestrator = kind(host) === "orchestrator";
  const Icon = orchestrator ? Orbit : Server;
  return (
    <Card className="min-w-0 rounded-md shadow-none">
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Icon className="size-5 text-muted-foreground" />
          <Badge variant="outline">
            {!host.online
              ? "Offline"
              : !host.enabled
                ? "Draining"
                : host.placementReady === false
                  ? "Needs attention"
                  : "Online"}
          </Badge>
        </div>
        <CardTitle className="break-words text-xl">
          <a
            href={resourcesHref}
            className="underline-offset-4 hover:underline"
            aria-label={`${host.name} overview`}
          >
            {host.name}
          </a>
        </CardTitle>
        <CardDescription>
          {provider(host.platform || host.provider)} ·{" "}
          {orchestrator ? "Orchestrator pool" : "Direct host"}
        </CardDescription>
        {!!host.runtimes?.length && (
          <p className="text-xs text-muted-foreground">
            {host.runtimes.map(provider).join(" · ")}
          </p>
        )}
        <div>
          <Health host={host} />
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <a
          href={resourcesHref}
          aria-label={`View resources for ${host.name}`}
          className="group block min-w-0 space-y-3 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
            <span className="text-muted-foreground">Reserved / limit</span>
            <span className="flex items-center gap-1 group-hover:underline">
              View resources
              <ArrowUpRight className="size-3" />
            </span>
          </div>
          <ReservationMeters host={host} />
          {host.overcommitted && (
            <p className="text-xs text-destructive">
              Reservations exceed the current limit. Existing allocations remain
              reserved.
            </p>
          )}
        </a>
      </CardContent>
      <CardFooter className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() =>
            mutate(
              `hosts/${host.id}/accepting`,
              { enabled: !host.enabled },
              host.enabled
                ? `${host.name} is draining. Existing machines keep running; new placements and restarts are disabled.`
                : `${host.name} accepts placements when checks and capacity allow.`,
            )
          }
        >
          {host.enabled
            ? orchestrator
              ? "Drain pool"
              : "Drain host"
            : "Accept machines"}
        </Button>
      </CardFooter>
    </Card>
  );
}
export function InfrastructureDetails({
  host,
  machines = [],
  onInspect,
  onControl,
  onRefresh,
}: {
  host: Host;
  machines?: HostAllocation[];
  onInspect?: (id: string) => void;
  onControl?: (id: string) => void;
  onRefresh: Refresh;
}) {
  const [data, setData] = useState<ResourceDetails | null>(null),
    [error, setError] = useState(""),
    [reload, setReload] = useState(0),
    [checking, setChecking] = useState(false),
    [checkMessage, setCheckMessage] = useState("");
  useEffect(() => {
    let disposed = false;
    async function load() {
      try {
        const v = await api(`hosts/${host.id}/resources`, undefined, (value) =>
          resourceDetails(value, host.id),
        );
        if (!disposed) {
          setData(v);
          setError("");
        }
      } catch (e) {
        if (!disposed) setError(errorMessage(e));
      }
    }
    load();
    const timer = setInterval(() => {
      if (!document.hidden) load();
    }, 10000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [host.id, reload]);
  async function checks() {
    setChecking(true);
    try {
      await api(`hosts/${host.id}/checks`, {});
      setError("");
      setCheckMessage(
        "Checks requested. Results refresh when the runner reports back.",
      );
      await onRefresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setChecking(false);
    }
  }
  const samples = (data?.samples || [])
    .filter((s): s is typeof s & { cpuPercent: number } => s.cpuPercent != null)
    .slice(0, 60)
    .sort((a, b) => a.receivedAt - b.receivedAt);
  const min = samples[0]?.receivedAt ?? 0,
    span = Math.max(1, (samples.at(-1)?.receivedAt || 0) - min);
  return (
    <div className="min-w-0 space-y-6" aria-label={`${host.name} overview`}>
      {error && (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3"
        >
          <p className="min-w-0 break-words text-sm text-destructive">
            {error}
            {data
              ? " Showing the last resource and image report."
              : " Resource and image details could not be loaded."}
          </p>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setReload((value) => value + 1)}
          >
            <RefreshCw /> Retry resources
          </Button>
        </div>
      )}
      <StackedResources host={host} data={data} unavailable={Boolean(error)} />
      <HostLimits
        key={host.id}
        host={host}
        onRefresh={async () => {
          setReload((value) => value + 1);
          await onRefresh();
        }}
      />
      <div className="grid min-w-0 gap-6 border-t pt-6 xl:grid-cols-2">
        <HostMachines
          host={host}
          machines={machines}
          allocations={data?.allocations}
          onInspect={onInspect}
          onControl={onControl}
        />
        <HostImages
          host={host}
          images={data?.images || []}
          loading={!data && !error}
          unavailable={
            (!data && Boolean(error)) ||
            (data !== null && data.images === undefined)
          }
        />
      </div>
      <div className="grid min-w-0 gap-8 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className="min-w-0 space-y-6">
          <section className="min-w-0 space-y-3">
            <h2 className="text-sm font-medium">Observed resources</h2>
            <Usage host={host} />
            {host.usage?.cluster && (
              <NamespaceResources cluster={host.usage.cluster} />
            )}
            {samples.length > 1 && (
              <figure>
                <svg
                  viewBox="0 0 600 100"
                  className="h-28 w-full rounded-md border"
                  role="img"
                  aria-label="CPU utilization history, from zero to one hundred percent"
                >
                  <polyline
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    points={samples
                      .map(
                        (s) =>
                          `${((s.receivedAt - min) / span) * 600},${100 - s.cpuPercent}`,
                      )
                      .join(" ")}
                  />
                </svg>
                <figcaption className="mt-1 text-[10px] text-muted-foreground">
                  CPU 0–100% · {since(min)} to{" "}
                  {since(samples.at(-1)?.receivedAt)} · gaps follow sampling
                  times
                </figcaption>
              </figure>
            )}
            <p className="text-xs text-muted-foreground">
              Usage includes other workloads. Shared resource domain:{" "}
              {host.usage?.domain || "unknown"}. Do not sum physical usage from
              runners on the same host. KubeVirt runner measurements are
              separate from namespace usage and quotas.
            </p>
          </section>
        </div>
        <aside
          className="min-w-0 space-y-6"
          aria-label="Environment and capabilities"
        >
          <section className="space-y-3">
            <div className="flex flex-wrap justify-between gap-2">
              <h2 className="text-sm font-medium">Environment checks</h2>
              <Button
                size="sm"
                variant="outline"
                disabled={checking || !host.online}
                onClick={checks}
              >
                <RefreshCw />
                Run checks
              </Button>
            </div>
            <Health host={host} />
            {checkMessage && (
              <p role="status" className="text-xs text-muted-foreground">
                {checkMessage}
              </p>
            )}
            {!host.health && (
              <p className="text-xs text-muted-foreground">
                This runner has not reported checks. Upgrade and restart it to
                enable diagnostics.
              </p>
            )}
            <ul className="space-y-2">
              {host.health?.checks?.map((c) => (
                <li key={c.id} className="rounded-md border p-3">
                  <div className="flex items-center gap-2 text-xs">
                    {c.status === "passed" ? (
                      <Check className="size-3 text-emerald-500" />
                    ) : (
                      <AlertTriangle className="size-3 text-amber-500" />
                    )}
                    <span className="font-medium">{c.label}</span>
                    <span className="ml-auto text-muted-foreground">
                      {c.status}
                    </span>
                  </div>
                  <p className="mt-2 break-words text-xs text-muted-foreground">
                    {c.detail}
                  </p>
                </li>
              ))}
            </ul>
            <dl className="grid grid-cols-3 gap-3">
              {Object.entries(host.health?.environment || {}).map(
                ([key, value]) => (
                  <Metric key={key} label={key}>
                    {String(value)}
                  </Metric>
                ),
              )}
            </dl>
          </section>
          <section className="space-y-3 border-t pt-4">
            <h2 className="text-sm font-medium">Configured capabilities</h2>
            <div className="flex flex-wrap gap-2">
              {Object.entries(host.health?.capabilities || {}).map(
                ([key, value]) => (
                  <Badge key={key} variant="outline">
                    {key}: {value ? "Available" : "Unavailable"}
                  </Badge>
                ),
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              Capabilities describe configured adapters. A machine still needs
              its image, guest services and a reachable control connection.
            </p>
          </section>
        </aside>
      </div>
    </div>
  );
}

export function ConnectionSetup({
  initialKind,
  onClose,
  onRefresh,
  hosts,
}: {
  initialKind: "host" | "orchestrator";
  onClose: () => void;
  onRefresh: Refresh;
  hosts: Host[];
}) {
  const intent = useRef<{ id: string; fingerprint: string } | null>(null);
  const [type, setType] = useState(initialKind),
    [name, setName] = useState(""),
    [backend, setBackend] = useState(
      initialKind === "orchestrator" ? "kubevirt" : "macos",
    ),
    [url, setUrl] = useState(""),
    [capacity, setCapacity] = useState<ResourceInput>({
      cpu: 4,
      memoryMiB: 8192,
      diskGiB: 100,
    }),
    [config, setConfig] = useState(
      JSON.stringify(
        defaults(initialKind === "orchestrator" ? "kubevirt" : "macos"),
        null,
        2,
      ),
    ),
    [issued, setIssued] = useState<IssuedSetup | null>(null),
    [activity, setActivity] = useState<SetupActivity[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    let stopped = false;
    async function load() {
      try {
        const v = await api("connection-setups", undefined, connectionSetups);
        if (!stopped) {
          setActivity(v.setups);
          setUrl((old) => old || v.controllerUrl || "");
        }
      } catch (e) {
        if (!stopped) setError(errorMessage(e));
      }
    }
    load();
    const timer = setInterval(load, 5000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, []);
  function change(p: string) {
    setBackend(p);
    setConfig(JSON.stringify(defaults(p), null, 2));
  }
  let bindings: RunnerBindings = {};
  try {
    bindings = runnerBindings(JSON.parse(config) as unknown);
  } catch {
    /* The submit handler reports invalid JSON. */
  }
  const fields = [
    ["storage", "Storage directory"],
    ...(backend === "kubevirt"
      ? [
          ["namespace", "Kubernetes namespace"],
          ["context", "Kubernetes context"],
        ]
      : []),
  ];
  function toggleRuntime(name: string, enabled: boolean) {
    const runtimes = { ...bindings.runtimes };
    if (enabled) runtimes[name] = runtimeDefaults(name);
    else delete runtimes[name];
    binding("runtimes", runtimes);
  }
  function runtimeBinding(name: string, key: string, value: string) {
    binding("runtimes", {
      ...bindings.runtimes,
      [name]: { ...bindings.runtimes?.[name], [key]: value },
    });
  }
  function binding(key: string, value: unknown) {
    setConfig(JSON.stringify({ ...bindings, [key]: value }, null, 2));
  }
  async function issue(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const origin = new URL(url);
      if (
        origin.username ||
        origin.password ||
        origin.pathname !== "/" ||
        origin.search ||
        origin.hash ||
        !["https:", "http:"].includes(origin.protocol)
      )
        throw new Error(
          "Use a controller origin without credentials or a path.",
        );
      if (
        origin.protocol !== "https:" &&
        !["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)
      )
        throw new Error("Remote enrollment requires HTTPS.");
      const bindings = runnerBindings(JSON.parse(config) as unknown);
      if (!bindings || Array.isArray(bindings) || typeof bindings !== "object")
        throw new Error("Runner configuration must be a JSON object.");
      if (!Array.isArray(bindings.templates))
        throw new Error(
          "Images must be a JSON array in the runner configuration.",
        );
      if (
        typeof bindings.storage !== "string" ||
        !/^(\/|[A-Za-z]:[\\/])/.test(bindings.storage)
      )
        throw new Error("Set an absolute storage directory on the runner.");
      if (
        runtimeChoices[backend] &&
        !Object.keys(bindings.runtimes || {}).length
      )
        throw new Error("Enable at least one runtime for this host.");
      const fingerprint = JSON.stringify({ name, provider: backend, capacity });
      if (!intent.current || intent.current.fingerprint !== fingerprint)
        intent.current = { id: crypto.randomUUID(), fingerprint };
      const setupId = intent.current.id;
      const result = await api(
        "connection-setups",
        {
          id: setupId,
          name,
          provider: backend,
          capacity: resources(capacity),
        },
        (value) => setupReceipt(value, setupId),
      );
      setIssued({
        ...result,
        bundle: {
          schemaVersion: 1,
          controllerUrl: origin.origin,
          enrollmentToken: result.enrollmentToken,
          expiresAt: result.expiresAt,
          config: { ...bindings, name, provider: backend, capacity },
        },
      });
      await onRefresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  function download() {
    if (!issued) return;
    const blob = new Blob([JSON.stringify(issued.bundle, null, 2) + "\n"], {
        type: "application/json",
      }),
      href = URL.createObjectURL(blob),
      a = document.createElement("a");
    a.href = href;
    a.download = "canaveral-setup.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(href), 1000);
  }
  async function revoke(id: string) {
    setBusy(true);
    try {
      await api(`connection-setups/${id}/revoke`, {}, (value) =>
        setupRevocation(value, id),
      );
      setActivity((old) =>
        old.map((s) => (s.id === id ? { ...s, state: "revoked" } : s)),
      );
      if (issued?.id === id) setIssued(null);
      if (intent.current?.id === id) intent.current = null;
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  const linked = activity.find((s) => s.id === issued?.id)?.hostId;
  const connected = hosts.find((h) => h.id === linked);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            Add {type === "orchestrator" ? "orchestrator" : "host"}
          </DialogTitle>
          <DialogDescription>
            Connect a runner that provides VMs or simulators. Credentials stay
            on that runner.
          </DialogDescription>
        </DialogHeader>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {!issued ? (
          <form onSubmit={issue} className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="space-y-2 text-xs">
                Connection type
                <select
                  aria-label="Connection type"
                  className="h-9 w-full rounded-md border bg-background px-2"
                  value={type}
                  onChange={(e) => {
                    setType(
                      e.target.value === "orchestrator"
                        ? "orchestrator"
                        : "host",
                    );
                    change(
                      e.target.value === "orchestrator" ? "kubevirt" : "macos",
                    );
                  }}
                >
                  <option value="host">Direct host</option>
                  <option value="orchestrator">External orchestrator</option>
                </select>
              </label>
              <label className="space-y-2 text-xs">
                {type === "orchestrator" ? "Provider" : "Host operating system"}
                <select
                  aria-label={
                    type === "orchestrator"
                      ? "Provider"
                      : "Host operating system"
                  }
                  className="h-9 w-full rounded-md border bg-background px-2"
                  value={backend}
                  onChange={(e) => change(e.target.value)}
                >
                  {(type === "orchestrator"
                    ? ["kubevirt"]
                    : ["macos", "linux", "windows"]
                  ).map((p) => (
                    <option key={p} value={p}>
                      {provider(p)}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <label className="block space-y-2 text-xs">
              Connection name
              <Input
                required
                maxLength={100}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Build Mac or development cluster"
              />
            </label>
            <label className="block space-y-2 text-xs">
              Controller URL
              <Input
                type="url"
                required
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://canaveral.example.com"
              />
              <p className="text-muted-foreground">
                Use an address reachable from this runner. Localhost only works
                on the controller machine.
              </p>
            </label>
            <fieldset className="space-y-2">
              <legend className="text-xs font-medium">
                Canaveral host limits
              </legend>
              <div className="grid grid-cols-3 gap-3">
                {resourceFields.map(([key, label]) => (
                  <label key={key} className="space-y-2 text-xs">
                    {label}
                    <Input
                      type="number"
                      min="1"
                      max="1048576"
                      required
                      value={capacity[key]}
                      onChange={(e) =>
                        setCapacity({
                          ...capacity,
                          [key]:
                            e.target.value === "" ? "" : Number(e.target.value),
                        })
                      }
                    />
                  </label>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                Set how much Canaveral can allocate on this host. Divide
                resources between runners sharing a physical host or cluster
                pool.
              </p>
            </fieldset>
            <div className="grid gap-4 sm:grid-cols-2">
              {fields.map(([key, label]) => (
                <label key={key} className="block space-y-2 text-xs">
                  {label}
                  <Input
                    required
                    aria-label={label}
                    value={
                      typeof bindings[key!] === "string"
                        ? String(bindings[key!])
                        : ""
                    }
                    onChange={(e) => binding(key!, e.target.value)}
                  />
                </label>
              ))}
            </div>
            {runtimeChoices[backend] && (
              <fieldset className="space-y-3 rounded-md border p-3">
                <legend className="px-1 text-xs font-medium">
                  Enabled runtimes
                </legend>
                <p className="text-xs text-muted-foreground">
                  One physical host identity and set of limits covers all
                  enabled runtimes.
                </p>
                {runtimeChoices[backend]!.map((name) => (
                  <div key={name} className="space-y-3">
                    <label className="flex items-center gap-2 text-xs">
                      <input
                        type="checkbox"
                        checked={Boolean(bindings.runtimes?.[name])}
                        onChange={(e) => toggleRuntime(name, e.target.checked)}
                      />
                      {provider(name)}
                    </label>
                    {bindings.runtimes?.[name] &&
                      Object.entries(runtimeDefaults(name)).map(([key]) => (
                        <label
                          key={key}
                          className="block space-y-2 pl-5 text-xs"
                        >
                          {provider(name)} {key}
                          <Input
                            required
                            aria-label={`${provider(name)} ${key}`}
                            value={
                              typeof bindings.runtimes?.[name]?.[key] ===
                              "string"
                                ? String(bindings.runtimes[name]![key])
                                : ""
                            }
                            onChange={(e) =>
                              runtimeBinding(name, key, e.target.value)
                            }
                          />
                        </label>
                      ))}
                  </div>
                ))}
              </fieldset>
            )}
            <details className="space-y-3 rounded-md border p-3">
              <summary className="cursor-pointer text-xs font-medium">
                Advanced configuration and images
              </summary>
              <label className="block space-y-2 text-xs">
                Runner configuration
                <Textarea
                  className="min-h-44 font-mono text-xs"
                  value={config}
                  onChange={(e) => setConfig(e.target.value)}
                  spellCheck={false}
                />
                <p className="text-muted-foreground">
                  Set paths and backend bindings on the target host. Add
                  installed image definitions now, or connect with an empty
                  image catalogue and configure them later. Cluster credentials
                  remain in the runner’s kubeconfig.
                </p>
              </label>
            </details>
            <Button disabled={busy} type="submit">
              {busy ? "Creating setup…" : "Create connection setup"}
            </Button>
          </form>
        ) : (
          <div className="space-y-4">
            <div className="rounded-md border p-4">
              <p className="text-sm font-medium">
                {connected ? "Runner connected" : "Waiting for runner"}
              </p>
              <p className="mt-2 text-xs text-muted-foreground">
                Setup expires{" "}
                {new Date(issued.expiresAt * 1000).toLocaleTimeString()}. The
                downloaded file contains a single-connection enrollment secret.
                Keep it private; the server cannot return it again.
              </p>
              {connected && (
                <div className="mt-3">
                  <Health host={connected} />
                </div>
              )}
            </div>
            <Button onClick={download}>
              <Download />
              Download setup file
            </Button>
            <ol className="list-inside list-decimal space-y-3 text-xs">
              <li>Install Canaveral and the selected runtime on the runner.</li>
              <li>
                Place the private setup file on that machine and check its
                environment:
                <pre className="mt-2 whitespace-pre-wrap break-all rounded-md border p-3">
                  canaveral host --setup-file ./canaveral-setup.json --state
                  ./state/runner --check
                </pre>
              </li>
              <li>
                Connect the runner:
                <pre className="mt-2 whitespace-pre-wrap break-all rounded-md border p-3">
                  canaveral host --setup-file ./canaveral-setup.json --state
                  ./state/runner
                </pre>
              </li>
            </ol>
            <p className="text-xs text-muted-foreground">
              For later restarts, use --config ./state/runner/host-config.json
              with the same --state directory and controller --url. Preserve its
              identity; do not clone its state directory.
            </p>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => revoke(issued.id)}
            >
              Revoke setup credential
            </Button>
          </div>
        )}
        {activity.some((s) => s.state === "pending") && (
          <section className="space-y-2 border-t pt-4">
            <h2 className="text-xs font-medium">Pending setup credentials</h2>
            {activity
              .filter((s) => s.state === "pending")
              .map((s) => (
                <div
                  key={s.id}
                  className="flex items-center justify-between gap-2 text-xs"
                >
                  <span className="break-all">
                    {s.name} · {provider(s.provider)}
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => revoke(s.id)}
                  >
                    Revoke
                  </Button>
                </div>
              ))}
          </section>
        )}
      </DialogContent>
    </Dialog>
  );
}
