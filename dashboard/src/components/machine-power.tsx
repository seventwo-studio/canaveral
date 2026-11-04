import { useRef, useState } from "react";
import { api, errorMessage } from "@/lib/api";
import { powerOffReceipt } from "@/lib/types";
import type { MachinePowerTarget, PowerOffReceipt } from "@/lib/types";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "./ui/dialog";

export function MachinePowerOff({
  machine,
  onClose,
  onRefresh,
}: {
  machine: MachinePowerTarget;
  onClose: () => void;
  onRefresh: () => void | Promise<void>;
}) {
  const intent = useRef(machine.powerOffRequest || crypto.randomUUID());
  const [busy, setBusy] = useState(false),
    [result, setResult] = useState<PowerOffReceipt | null>(null),
    [error, setError] = useState("");
  async function submit() {
    setBusy(true);
    setError("");
    try {
      const value = await api(
        `machines/${machine.id}/power-off`,
        {
          id: intent.current,
        },
        (value) =>
          powerOffReceipt(value, { id: intent.current, machineId: machine.id }),
      );
      setResult(value);
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
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Power off {machine.name}?</DialogTitle>
          <DialogDescription>
            This cuts power to the VM. Unsaved changes may be lost, and a
            captured disk may require filesystem recovery. Use Stop for a
            graceful shutdown.
          </DialogDescription>
        </DialogHeader>
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
        {result ? (
          <div className="space-y-2 text-xs">
            <p>
              Power-off request: {result.state}. Resources stay reserved until
              the host confirms that the VM and disk handles are closed.
            </p>
            <p className="break-all text-muted-foreground">
              Request {result.id}
            </p>
            <Button onClick={onClose}>Close</Button>
          </div>
        ) : (
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="outline" disabled={busy} onClick={onClose}>
              Cancel
            </Button>
            <Button variant="destructive" disabled={busy} onClick={submit}>
              {busy ? "Requesting…" : "Power off VM"}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
