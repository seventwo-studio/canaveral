import { useEffect, useRef, useState } from "react";
import { api, errorMessage } from "@/lib/api";
import { systemReceipt } from "@/lib/system-control";
import { record } from "@/lib/types";
import { Button } from "./ui/button";

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const terminal = ["succeeded", "failed", "cancelled"];
const jobStates = [
  "queued",
  "waitingForResources",
  "running",
  "unknown",
  ...terminal,
];
const requestStates = [
  "waiting",
  "admitted",
  "cancelled",
  "expired",
  "rejected",
];
const stateLabels: Record<string, string> = {
  queued: "Queued",
  waitingForResources: "Waiting for resources",
  running: "Running",
  unknown: "Outcome unknown",
  succeeded: "Succeeded",
  failed: "Failed",
  cancelled: "Cancelled",
};
const requestLabels: Record<string, string> = {
  waiting: "Waiting for admission",
  admitted: "Admitted",
  cancelled: "Cancelled before admission",
  expired: "Expired before admission",
  rejected: "Rejected before admission",
};
const reasonLabels: Record<string, string> = {
  capacity_unavailable: "no approved runner has free capacity",
  model_job_limit: "the application is at its model job limit",
  deadline: "deadline passed",
  consumer_cancelled: "cancelled by the application",
  administrator_cancelled: "cancelled by an administrator",
  application_revoked: "application revoked",
  model_grant_revoked: "model grant revoked",
};
const time = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;
const iso = (value: unknown) =>
  value === null ||
  (typeof value === "string" && Number.isFinite(Date.parse(value)));

/** Administrator view of one application model job; prompts and results are never listed. */
export function queuedModelJob(value: unknown) {
  const {
    id,
    applicationId,
    model,
    digest,
    state,
    cancelRequested,
    stopped,
    cleanup,
    assigned,
    reservationHeld,
    createdAt,
    request,
  } = record(value);
  if (
    typeof id !== "string" ||
    !UUID.test(id) ||
    typeof applicationId !== "string" ||
    !UUID.test(applicationId) ||
    typeof model !== "string" ||
    typeof digest !== "string" ||
    !DIGEST.test(digest) ||
    typeof state !== "string" ||
    !jobStates.includes(state) ||
    typeof cancelRequested !== "boolean" ||
    typeof stopped !== "boolean" ||
    !["pending", "complete"].includes(String(cleanup)) ||
    typeof assigned !== "boolean" ||
    typeof reservationHeld !== "boolean" ||
    !time(createdAt)
  )
    throw Error("Invalid application model job.");
  let queue:
    | {
        state: string;
        priority: number;
        deadline: string | null;
        reason: string | null;
      }
    | undefined;
  if (request !== undefined) {
    const r = record(request);
    if (
      typeof r.state !== "string" ||
      !requestStates.includes(r.state) ||
      typeof r.priority !== "number" ||
      !Number.isSafeInteger(r.priority) ||
      !iso(r.deadline) ||
      !(r.reason === null || typeof r.reason === "string")
    )
      throw Error("Invalid model request state.");
    queue = {
      state: r.state,
      priority: r.priority,
      deadline: r.deadline as string | null,
      reason: r.reason as string | null,
    };
  }
  return {
    id,
    applicationId,
    model,
    digest,
    state,
    cancelRequested,
    stopped,
    cleanup: cleanup as "pending" | "complete",
    assigned,
    reservationHeld,
    queue,
  };
}
export type QueuedModelJob = ReturnType<typeof queuedModelJob>;
const decodeList = (v: unknown) => {
  const items = record(v).jobs;
  if (!Array.isArray(items)) throw Error("Invalid application model queue.");
  return items.map(queuedModelJob);
};
const denied = (e: unknown) =>
  e instanceof Error && "status" in e && (e.status === 401 || e.status === 403);
const unknownOutcome = (e: unknown) =>
  !(e instanceof Error && "status" in e) ||
  (e instanceof Error && "outcome" in e);
const waiting = (j: QueuedModelJob) =>
  !j.assigned && !terminal.includes(j.state);

function QueueRow({
  job,
  onChanged,
  onDenied,
}: {
  job: QueuedModelJob;
  onChanged: () => void;
  onDenied: () => void;
}) {
  // One mutation UUID per intent; a lost response is retried with the same UUID.
  const [requestId, setRequestId] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  async function cancel() {
    const mutation = requestId ?? crypto.randomUUID();
    setRequestId(mutation);
    setBusy(true);
    setError("");
    try {
      const state = await api(
        "admin/jobs/" + job.id + "/cancel",
        { id: mutation, applicationId: job.applicationId },
        (v) => systemReceipt(v, job.id, mutation, "cancel"),
      );
      setRequestId(undefined);
      setNotice(
        state === "cancel_requested"
          ? "Cancellation requested. The reservation stays held until the runner confirms stop and cleanup."
          : `Cancellation recorded: ${stateLabels[state] ?? state}.`,
      );
      onChanged();
    } catch (e) {
      setError(errorMessage(e));
      if (denied(e)) onDenied();
      else if (!unknownOutcome(e)) setRequestId(undefined);
    } finally {
      setBusy(false);
    }
  }
  const queue = job.queue;
  return (
    <article
      className="min-w-0 space-y-2 px-3 py-3 text-[13px]"
      aria-label={"Application model job " + job.id}
    >
      <h3 className="break-all text-sm font-semibold">{job.model}</h3>
      <p className="break-all font-mono text-xs text-muted-foreground">
        {job.digest.slice(0, 19)} · application {job.applicationId} · {job.id}
      </p>
      <p>
        {stateLabels[job.state]}
        {job.cancelRequested && !terminal.includes(job.state)
          ? " · Cancellation requested"
          : ""}
      </p>
      {queue ? (
        <p>
          Queue: {requestLabels[queue.state]}
          {queue.reason
            ? ` (${reasonLabels[queue.reason] ?? queue.reason})`
            : ""}{" "}
          · priority {queue.priority}
          {queue.deadline
            ? ` · deadline ${new Date(queue.deadline).toLocaleString()}`
            : " · no deadline"}
        </p>
      ) : (
        waiting(job) && <p>Queue: direct submission · priority 0</p>
      )}
      <p>
        {job.reservationHeld
          ? "Capacity reserved"
          : job.assigned
            ? "Capacity released"
            : "No capacity reserved"}
      </p>
      {notice && <p role="status">{notice}</p>}
      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
      {!terminal.includes(job.state) && !job.cancelRequested && (
        <Button disabled={busy} variant="outline" onClick={cancel}>
          {requestId
            ? "Retry same cancellation"
            : waiting(job)
              ? "Cancel waiting job"
              : "Cancel job"}
        </Button>
      )}
    </article>
  );
}

/** Application model calls on the shared request queue. Waiting jobs hold no reservation. */
export function ModelQueue({ onDenied }: { onDenied: () => void }) {
  const [rows, setRows] = useState<QueuedModelJob[]>();
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const deniedCallback = useRef(onDenied);
  deniedCallback.current = onDenied;
  useEffect(() => {
    let live = true;
    void api("admin/model-jobs", undefined, decodeList)
      .then((list) => {
        if (!live) return;
        setRows(list);
        setError("");
      })
      .catch((e) => {
        if (!live) return;
        setError(errorMessage(e));
        if (denied(e)) deniedCallback.current();
      });
    return () => {
      live = false;
    };
  }, [refresh]);
  const open = rows?.some((r) => !terminal.includes(r.state)) ?? false;
  useEffect(() => {
    if (!open) return;
    const timer = setInterval(() => {
      if (!document.hidden) setRefresh((n) => n + 1);
    }, 5000);
    return () => clearInterval(timer);
  }, [open]);
  const queued = rows?.filter(waiting).length ?? 0;
  return (
    <section className="min-w-0 space-y-4" aria-labelledby="model-queue">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="model-queue" className="text-base font-semibold tracking-tight">
          Application model queue
        </h2>
        <Button variant="outline" onClick={() => setRefresh((n) => n + 1)}>
          Refresh queue
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">
        Model calls submitted by applications wait here until an approved runner
        has capacity. Waiting never takes capacity from running work.
      </p>
      {rows && (
        <p>
          {queued} waiting · {rows.length - queued} admitted or finished
        </p>
      )}
      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
      <div className="divide-y border-y empty:hidden">
        {rows?.map((row) => (
          <QueueRow
            key={row.id + row.applicationId}
            job={row}
            onChanged={() => setRefresh((n) => n + 1)}
            onDenied={onDenied}
          />
        ))}
      </div>
      {rows && !rows.length && !error && <p>No application model jobs.</p>}
    </section>
  );
}
