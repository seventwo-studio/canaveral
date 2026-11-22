import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { api, errorMessage } from "@/lib/api";
import { resourceFields, resources } from "@/lib/catalogue";
import type { Refresh, ResourceInput } from "@/lib/catalogue";
import { hostLimitReceipt } from "@/lib/infrastructure";
import type { Host } from "@/lib/infrastructure";
import { Button } from "./ui/button";
import { SettingsRows } from "./ui/field";
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
      className="max-w-2xl space-y-3 border-t pt-4"
    >
      <h2 className="text-sm font-semibold">Canaveral host limits</h2>
      <p className="text-xs text-muted-foreground">
        Allocation budget across this host’s runtimes. Host capacity still
        applies.
      </p>
      <SettingsRows>
        {resourceFields.map(([key, label]) => (
          <label key={key} className="text-[13px] font-medium">
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
      </SettingsRows>
      <p className="text-xs text-muted-foreground">
        Lower limits keep existing workloads and block allocations over budget.
        Limits affect scheduling, not measured usage.
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
      <Button className="ml-auto flex" type="submit" disabled={busy || !dirty}>
        {busy ? "Saving…" : "Save host limits"}
      </Button>
    </form>
  );
}
