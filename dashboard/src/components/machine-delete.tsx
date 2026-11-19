import { useRef, useState } from "react";
import { api, errorMessage } from "@/lib/api";
import { deletionReceipt } from "@/lib/types";
import type { DeletionReceipt } from "@/lib/types";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "./ui/dialog";

export interface MachineDeleteTarget {
  id: string;
  name: string;
  deletion?: { id: string; state: string };
}

/** Requests owned removal of a stopped machine. The request UUID is reused for
 * every retry, and success is reported only once the controller confirms it. */
export function MachineDelete({
  machine,
  onClose,
  onRequested,
  returnFocus,
}: {
  machine: MachineDeleteTarget;
  onClose: () => void;
  onRequested: (receipt: DeletionReceipt) => void | Promise<void>;
  returnFocus?: Element | null;
}) {
  const intent = useRef(machine.deletion?.id || crypto.randomUUID());
  const [busy, setBusy] = useState(false),
    [result, setResult] = useState<DeletionReceipt | null>(null),
    [error, setError] = useState("");
  const existing = !!machine.deletion;
  async function submit() {
    setBusy(true);
    setError("");
    try {
      const value = await api(
        `machines/${machine.id}/delete`,
        { id: intent.current },
        (value) =>
          deletionReceipt(value, { id: intent.current, machineId: machine.id }),
      );
      setResult(value);
      await onRequested(value);
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
      <DialogContent
        onCloseAutoFocus={(event) => {
          if (returnFocus instanceof HTMLElement && returnFocus.isConnected) {
            event.preventDefault();
            returnFocus.focus();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>
            {existing
              ? `Check deletion of ${machine.name}`
              : `Delete ${machine.name}?`}
          </DialogTitle>
          <DialogDescription>
            This permanently removes the stopped machine and its disk from its
            host. The machine stays listed until the host confirms removal.
          </DialogDescription>
        </DialogHeader>
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
        {result ? (
          <div className="space-y-2 text-xs">
            <p role="status">
              {result.state === "complete"
                ? "The host confirmed removal."
                : result.state === "blocked"
                  ? "The host could not confirm removal. Storage and its reservation are retained; inspect the host before retrying."
                  : "Deletion requested. Waiting for the host to confirm removal."}
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
              {busy
                ? "Requesting…"
                : existing
                  ? "Check deletion"
                  : "Delete machine"}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
