import { useEffect, useState } from "react";
import { api, memory, errorMessage } from "@/lib/api";
import type { FormEvent } from "react";
import { resourceFields, sharedBudget, sharedBudgets } from "@/lib/catalogue";
import type {
  CatalogueHost,
  Refresh,
  ResourceInput,
  SharedBudget,
} from "@/lib/catalogue";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "./ui/dialog";

export function SharedBudgets({
  hosts,
  onClose,
  onRefresh,
}: {
  hosts: CatalogueHost[];
  onClose: () => void;
  onRefresh: Refresh;
}) {
  const [budgets, setBudgets] = useState<SharedBudget[]>([]),
    [editing, setEditing] = useState<string | null>(null),
    [name, setName] = useState(""),
    [capacity, setCapacity] = useState<ResourceInput>({
      cpu: 4,
      memoryMiB: 8192,
      diskGiB: 100,
    }),
    [members, setMembers] = useState<string[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    api("resource-budgets", undefined, sharedBudgets)
      .then((v) => setBudgets(v))
      .catch((e) => setError(errorMessage(e)));
  }, []);
  function edit(b: SharedBudget | null) {
    setEditing(b?.id || null);
    setName(b?.name || "");
    setCapacity(b?.capacity || { cpu: 4, memoryMiB: 8192, diskGiB: 100 });
    setMembers(b?.hostIds || []);
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const id = editing || crypto.randomUUID();
      setEditing(id);
      const value = await api(
        "resource-budgets",
        {
          id,
          name,
          capacity,
          hostIds: members,
        },
        (value) => sharedBudget(value, id),
      );
      setBudgets((old) => [...old.filter((b) => b.id !== value.id), value]);
      await onRefresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Shared resource budgets</DialogTitle>
          <DialogDescription>
            Apply one capacity limit across runners sharing a physical host or
            overlapping cluster resources.
          </DialogDescription>
        </DialogHeader>
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
        <div className="space-y-2">
          {budgets.map((b) => (
            <button
              type="button"
              key={b.id}
              onClick={() => edit(b)}
              className="w-full rounded-md border p-3 text-left text-xs"
            >
              <span className="font-medium">{b.name}</span>
              <p className="mt-1 text-muted-foreground">
                {b.reserved.cpu} / {b.capacity.cpu} vCPU ·{" "}
                {memory(b.reserved.memoryMiB)} / {memory(b.capacity.memoryMiB)}{" "}
                · {b.reserved.diskGiB} / {b.capacity.diskGiB} GiB ·{" "}
                {b.hostIds.length} runners
              </p>
              {b.overcommitted && (
                <p className="mt-1 text-destructive">
                  Existing reservations exceed this budget. New placements are
                  blocked.
                </p>
              )}
            </button>
          ))}
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => edit(null)}
          disabled={busy}
        >
          New shared budget
        </Button>
        <form className="space-y-4 border-t pt-4" onSubmit={save}>
          <label className="block space-y-2 text-xs">
            Budget name
            <Input
              required
              maxLength={100}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <div className="grid grid-cols-3 gap-3">
            {resourceFields.map(([key, label]) => (
              <label key={key} className="space-y-2 text-xs">
                {label}
                <Input
                  required
                  type="number"
                  min="1"
                  max="1048576"
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
          <fieldset className="space-y-2">
            <legend className="mb-2 text-xs font-medium">Member runners</legend>
            {hosts.map((h) => (
              <label
                key={h.id}
                className="flex items-center gap-3 rounded-md border p-3 text-xs"
              >
                <input
                  type="checkbox"
                  checked={members.includes(h.id)}
                  onChange={(e) =>
                    setMembers((old) =>
                      e.target.checked
                        ? [...old, h.id]
                        : old.filter((id) => id !== h.id),
                    )
                  }
                />
                <span className="min-w-0 break-all">
                  {h.name} · {h.provider}
                </span>
              </label>
            ))}
          </fieldset>
          <p className="text-xs text-muted-foreground">
            Every member’s reservations count toward this budget, including
            offline assignments and stopped disks. All overlapping budgets
            apply. Lowering a budget preserves existing machines and blocks
            allocations that would exceed it. Empty membership disables the
            budget without deleting its record.
          </p>
          <Button type="submit" disabled={busy}>
            {busy ? "Saving…" : "Save shared budget"}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
