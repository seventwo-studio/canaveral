import { useState, useEffect, useRef } from "react";
import { api, errorMessage, since } from "@/lib/api";
import { maintenanceStatus } from "@/lib/maintenance";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
  DialogClose,
} from "./ui/dialog";

const actions: Record<string, string> = {
  assignment: "Stop the machine.",
  operation: "Wait for the operation receipt.",
  lease: "Release the lease and wait for cleanup.",
  session: "Close the session.",
  update: "Wait for the managed update to finish.",
  unsupportedProof: "Verify the workload has stopped manually.",
  unsupportedHost:
    "Review outstanding host assignments and resources before cleanup.",
  notIdle: "Wait for runner activity to finish.",
  acknowledgement: "Check runner connectivity and wait for fresh confirmation.",
  agentUnsupported: "Upgrade the host agent through managed updates.",
  unknownState: "Reconcile the assignment with the host.",
  uncertainOperation: "Recover the operation receipt before continuing.",
  missingResource: "Verify the assignment’s storage on this host.",
  unexpectedResource:
    "Identify the unexpected resource and reconcile ownership.",
  incompleteInventory: "Check runner inventory errors and reconcile again.",
};

export function Maintenance({ host }: { host: string }) {
  const path = "hosts/" + encodeURIComponent(host) + "/maintenance";
  const [status, setStatus] = useState<
    ReturnType<typeof maintenanceStatus> | undefined
  >();
  const [error, setError] = useState(""),
    [readError, setReadError] = useState(""),
    [open, setOpen] = useState(false),
    [reason, setReason] = useState(""),
    [busy, setBusy] = useState(false);
  const pending = useRef<{ id: string; reason: string } | null>(null),
    resume = useRef<{ id: string; requestId: string } | null>(null);
  const revision = useRef(0),
    writing = useRef(false);
  useEffect(() => {
    let live = true;
    let reading = false;
    async function refresh() {
      if (writing.current || reading) return;
      reading = true;
      const version = ++revision.current;
      try {
        const next = await api(path, undefined, (v) =>
          maintenanceStatus(v, host),
        );
        if (live && version === revision.current) {
          if (next && next.id === pending.current?.id) {
            pending.current = null;
            setOpen(false);
            setReason("");
            setError("");
          }
          setStatus(next);
          setReadError("");
        }
      } catch (e) {
        if (live && version === revision.current) {
          setStatus(undefined);
          setReadError(errorMessage(e));
        }
      } finally {
        reading = false;
      }
    }
    void refresh();
    const timer = setInterval(refresh, 5000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [path, host]);
  useEffect(() => {
    if (!status?.safeToPowerOff && !status?.readyToResume) return;
    // Discard a positive snapshot if the next status read stalls.
    const timeout = setTimeout(() => {
      setStatus(undefined);
      setReadError("Waiting for current maintenance status…");
    }, 6000);
    return () => clearTimeout(timeout);
  }, [status]);
  async function submit(begin: boolean) {
    if (writing.current || (!begin && !status?.readyToResume)) return;
    writing.current = true;
    revision.current++;
    setBusy(true);
    setError("");
    try {
      let route = path,
        body;
      if (begin) {
        if (pending.current?.reason !== reason)
          pending.current = { id: crypto.randomUUID(), reason };
        body = { id: pending.current.id, ...(reason ? { reason } : {}) };
      } else {
        if (!status) return;
        if (resume.current?.id !== status.id)
          resume.current = { id: status.id, requestId: crypto.randomUUID() };
        route += "/" + encodeURIComponent(status.id) + "/resume";
        body = { requestId: resume.current.requestId };
      }
      const next = await api(route, body, (v) => maintenanceStatus(v, host));
      setStatus(next);
      setReadError("");
      setOpen(false);
      setReason("");
      pending.current = null;
      resume.current = null;
    } catch (e) {
      if (e instanceof Error && "blockedStatus" in e) {
        setStatus(undefined);
        try {
          setStatus(maintenanceStatus(e.blockedStatus, host));
        } catch {
          /* Keep actions disabled until refresh. */
        }
        setError(
          "Resume refused (409 maintenance_blocked). Resolve the resume blockers and retry.",
        );
      } else {
        setError(errorMessage(e));
        setStatus(undefined);
      }
    } finally {
      writing.current = false;
      setBusy(false);
    }
  }
  const safe =
    status?.phase === "draining" &&
    status.scope === "directHost" &&
    !status.blockers.length &&
    status.safeToPowerOff;
  return (
    <section aria-label="Host maintenance" className="space-y-3 border-t pt-4">
      <h2 className="text-sm font-semibold">Planned maintenance</h2>
      <div aria-live="polite" className="space-y-1 text-sm">
        {status === undefined ? (
          <p>{readError || "Checking maintenance status…"}</p>
        ) : status === null ? (
          <p>No maintenance history.</p>
        ) : (
          <>
            <p>Direct host · {status.phase}</p>
            <p>Admission owners: {status.owners.join(", ") || "None"}</p>
            <p>Last runner confirmation: {since(status.confirmed)}</p>
            <p>
              {safe ? "Safe to power off" : "Not safe to power off"} ·
              Canaveral-managed workloads on this host.
            </p>
            <ul className="list-disc pl-5">
              {status.blockers.map((b, i) => (
                <li key={i}>
                  {b.kind} · {b.id} · {b.state} — {b.detail} Blocks{" "}
                  {b.resume ? "power off and resume" : "power off only"}.{" "}
                  {actions[b.kind] ?? "Inspect the blocker before continuing."}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>
          <Button
            disabled={
              busy || status === undefined || status?.phase === "draining"
            }
          >
            Begin maintenance
          </Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Begin maintenance?</DialogTitle>
            <DialogDescription>
              Close admission for new work on this host. Existing work can
              finish. Resume admission after reconciliation.
            </DialogDescription>
          </DialogHeader>
          <label className="grid gap-1.5 text-ui font-medium">
            Reason (optional)
            <Input
              maxLength={500}
              value={reason}
              disabled={busy}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
          {error && <p role="alert">{error}</p>}
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button
              disabled={busy || status?.phase === "draining"}
              onClick={() => submit(true)}
            >
              Begin maintenance
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>{" "}
      <Button
        variant="outline"
        disabled={busy || status?.phase !== "draining" || !status.readyToResume}
        onClick={() => submit(false)}
      >
        Resume admission
      </Button>
      {error && !open && <p role="alert">{error}</p>}
    </section>
  );
}
