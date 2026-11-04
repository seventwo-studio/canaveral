import { useEffect, useRef, useState } from "react";
import {
  RefreshCw,
  Copy,
  MousePointer2,
  ScanSearch,
  Pause,
  Play,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { operate } from "@/lib/machine-operations";
import { api, errorMessage } from "@/lib/api";
import { accessibilitySnapshot } from "@/lib/workspace";
import type {
  AccessibilityNode,
  AccessibilitySnapshot,
  PerformAction,
} from "@/lib/workspace";

const identity = (n: AccessibilityNode) =>
  JSON.stringify([n.role, n.name, n.identifier, n.bounds, n.path]);
export function AccessibilityInspector({
  machine,
  performAction,
}: {
  machine: { id: string };
  performAction?: PerformAction;
}) {
  const [snapshot, setSnapshot] = useState<AccessibilitySnapshot | null>(null),
    [selected, setSelected] = useState<string | null>(null),
    [query, setQuery] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [live, setLive] = useState(true);
  const inFlight = useRef(false),
    alive = useRef(true),
    selectedIdentity = useRef<string | null>(null);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );
  async function refresh() {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      const value = await api(
        `machines/${machine.id}/accessibility`,
        undefined,
        accessibilitySnapshot,
      );
      if (!alive.current) return;
      setSnapshot(value);
      setError("");
      const matches = value.nodes.filter(
        (n) => identity(n) === selectedIdentity.current,
      );
      setSelected(matches.length === 1 ? matches[0]!.id : null);
      if (matches.length !== 1) selectedIdentity.current = null;
    } catch (e) {
      if (alive.current) setError(errorMessage(e));
    } finally {
      inFlight.current = false;
      if (alive.current) setBusy(false);
    }
  }
  useEffect(() => {
    if (!live) return;
    let stopped = false,
      timer: ReturnType<typeof setTimeout> | undefined;
    async function tick() {
      if (!document.hidden) await refresh();
      if (!stopped) timer = setTimeout(tick, 2000);
    }
    tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [live, machine.id]);
  const node = snapshot?.nodes.find((n) => n.id === selected);
  const nodes =
    snapshot?.nodes.filter((n) =>
      JSON.stringify([n.role, n.name, n.identifier, n.properties])
        .toLowerCase()
        .includes(query.toLowerCase()),
    ) || [];
  async function perform(nativeAction: string) {
    if (!node || !snapshot) return;
    setBusy(true);
    setError("");
    try {
      const act =
        performAction || ((action, args) => operate(machine.id, action, args));
      await act("accessibility-action", {
        snapshotId: snapshot.snapshotId,
        nodeId: node.id,
        nativeAction,
      });
      await refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <aside
      className="flex h-full min-h-0 min-w-0 flex-col border-l bg-background"
      aria-label="Accessibility inspector"
    >
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
        <h2 className="text-sm font-medium">Accessibility</h2>
        <div className="flex gap-1">
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Copy accessibility JSON"
            disabled={!snapshot}
            onClick={() =>
              navigator.clipboard
                .writeText(JSON.stringify(snapshot, null, 2))
                .catch(() => setError("Clipboard access is unavailable."))
            }
          >
            <Copy />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            aria-label={
              live ? "Pause live accessibility" : "Resume live accessibility"
            }
            aria-pressed={live}
            onClick={() => setLive(!live)}
          >
            {live ? <Pause /> : <Play />}
            {live ? "Live" : "Paused"}
          </Button>
          <Button
            size="icon-sm"
            variant="outline"
            disabled={busy}
            aria-label="Refresh accessibility"
            onClick={refresh}
          >
            <RefreshCw className={busy ? "animate-spin" : ""} />
          </Button>
        </div>
      </div>
      <div className="shrink-0 space-y-2 border-b p-3">
        <Input
          aria-label="Search accessibility elements"
          placeholder="Search roles, labels, identifiers…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {snapshot && (
          <p className="text-xs text-muted-foreground">
            {nodes.length} elements · {snapshot.source} ·{" "}
            {snapshot.coordinateSpace}
            {snapshot.truncated ? " · partial tree" : ""}
          </p>
        )}
      </div>
      {error && (
        <p role="alert" className="break-words p-3 text-xs text-destructive">
          {error}
        </p>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {!snapshot ? (
          <div className="flex flex-col items-center gap-3 p-6 text-center text-muted-foreground">
            <ScanSearch className="size-7" />
            <p className="text-sm">
              {busy
                ? "Reading the current interface…"
                : "Inspect the current interface"}
            </p>
            <p className="text-xs">
              Native roles, labels, states, bounds and identifiers for people
              and agents.
            </p>
          </div>
        ) : !nodes.length ? (
          <p className="p-4 text-sm text-muted-foreground">
            {query
              ? "No matching elements."
              : "No native accessibility elements were exposed. Screen input remains available."}
          </p>
        ) : (
          nodes.map((n) => (
            <button
              key={n.id}
              className={`block w-full border-b px-3 py-2 text-left text-xs hover:bg-muted ${selected === n.id ? "bg-muted" : ""}`}
              style={{ paddingLeft: `${12 + Math.min(n.depth || 0, 8) * 8}px` }}
              onClick={() => {
                selectedIdentity.current = identity(n);
                setSelected(n.id);
              }}
            >
              <div className="flex min-w-0 gap-2">
                <span className="min-w-0 max-w-[45%] break-all text-primary">
                  {n.role || "element"}
                </span>
                <span className="min-w-0 flex-1 break-words font-medium">
                  {n.name || n.identifier || "Unnamed"}
                </span>
              </div>
              <div className="mt-1 break-all text-[10px] text-muted-foreground">
                {n.id}
                {n.identifier ? " · " + n.identifier : ""}
              </div>
            </button>
          ))
        )}
      </div>
      {node && (
        <section
          className="max-h-[45%] shrink-0 overflow-y-auto border-t p-4"
          aria-label="Element details"
        >
          <div className="mb-3 flex flex-wrap gap-2">
            {node.actions?.map((action) => (
              <Button
                size="sm"
                variant="outline"
                key={action}
                disabled={busy || !!error}
                onClick={() => perform(action)}
              >
                <MousePointer2 />
                {action}
              </Button>
            ))}
          </div>
          <pre className="whitespace-pre-wrap break-all text-[11px] leading-relaxed">
            {JSON.stringify(node, null, 2)}
          </pre>
        </section>
      )}
      {snapshot && (
        <p className="shrink-0 border-t px-3 py-2 text-[10px] leading-relaxed text-muted-foreground">
          {live ? "Live · " : ""}Updated{" "}
          {new Date(snapshot.capturedAt * 1000).toLocaleTimeString()}. Targets
          expire after 15 seconds. {snapshot.coverage}
        </p>
      )}
    </aside>
  );
}
