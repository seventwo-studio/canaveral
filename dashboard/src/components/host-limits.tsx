import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { api, errorMessage } from "@/lib/api";
import { resourceFields, resources } from "@/lib/catalogue";
import type { Refresh, ResourceInput } from "@/lib/catalogue";
import { hostLimitReceipt } from "@/lib/infrastructure";
import type { Host } from "@/lib/infrastructure";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

export function HostLimits({
  host,
  onRefresh,
}: {
  host: Host;
  onRefresh: Refresh;
}) {
  const current = host.limits || host.capacity;
  const [limits, setLimits] = useState<ResourceInput>(current);
  const editing = useRef(false);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  useEffect(() => {
    if (!editing.current)
      setLimits({
        cpu: current.cpu,
        memoryMiB: current.memoryMiB,
        diskGiB: current.diskGiB,
      });
  }, [current.cpu, current.memoryMiB, current.diskGiB]);

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const requested = resources(limits);
      await api(`hosts/${host.id}/limits`, { limits: requested }, (value) =>
        hostLimitReceipt(value, host.id, requested),
      );
      setLimits(requested);
      editing.current = false;
      setDirty(false);
      setMessage("Host limits saved.");
      await onRefresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form
      onSubmit={save}
      aria-label="Canaveral host limits"
      className="space-y-3 border-t pt-6"
    >
      <h2 className="text-sm font-medium">Canaveral host limits</h2>
      <p className="text-xs text-muted-foreground">
        Set how much CPU, memory and disk Canaveral can allocate on this host
        across all its runtimes. New allocations also need to fit the capacity
        offered by the host.
      </p>
      <div className="grid gap-3 sm:grid-cols-3">
        {resourceFields.map(([key, label]) => (
          <label key={key} className="space-y-2 text-xs">
            {label}
            <Input
              type="number"
              required
              min="1"
              max="1048576"
              step="1"
              disabled={busy}
              value={limits[key]}
              onChange={(event) => {
                editing.current = true;
                setDirty(true);
                setMessage("");
                setLimits({
                  ...limits,
                  [key]:
                    event.target.value === "" ? "" : Number(event.target.value),
                });
              }}
            />
          </label>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        Lowering a limit keeps existing workloads and blocks allocations that
        would exceed it. These limits control scheduling; they do not throttle
        measured host usage.
      </p>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="text-xs">
          {message}
        </p>
      )}
      <Button type="submit" size="sm" disabled={busy || !dirty}>
        {busy ? "Saving…" : "Save host limits"}
      </Button>
    </form>
  );
}
