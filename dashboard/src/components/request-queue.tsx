import { useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { api, errorMessage } from "@/lib/api";
import {
  clockReading,
  controllerNow,
  duration,
  localTime,
  useTick,
  type ClockReading,
} from "@/lib/clock";
import type { User } from "@/lib/inventory";
import {
  kindLabels,
  pinLabel,
  queueView,
  unorderedReason,
  waitingReason,
  type QueueLease,
  type QueueRequest,
  type QueueView,
} from "@/lib/queue";
import { systemReceipt } from "@/lib/system-control";
import { Alert, AlertDescription } from "./ui/alert";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./ui/alert-dialog";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "./ui/empty";

/** One mutation UUID per confirmation. It is kept while the outcome is uncertain, so the retry
 * recovers the original cancellation instead of starting a second one. */
interface Intent {
  target: QueueRequest;
  requestId: string;
}
const denied = (e: unknown) =>
  e !== null &&
  typeof e === "object" &&
  "status" in e &&
  (e.status === 401 || e.status === 403);
const name = (request: QueueRequest) => request.label || request.id;

function Pair({
  label,
  children,
  mono = false,
}: {
  label: string;
  children: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd
        className={`[overflow-wrap:anywhere] ${mono ? "font-mono text-xs tabular-nums" : "text-sm"}`}
      >
        {children}
      </dd>
    </div>
  );
}
function Holder({
  subject,
}: {
  subject: Pick<QueueRequest, "applicationId" | "applicationName">;
}) {
  return (
    <>
      {subject.applicationName && (
        <span className="block text-sm">{subject.applicationName}</span>
      )}
      <a
        className="font-mono text-xs underline-offset-4 hover:underline"
        href={`#activity/application/${subject.applicationId}`}
        aria-label={`Activity of application ${subject.applicationId}`}
      >
        {subject.applicationId}
      </a>
    </>
  );
}
function What({
  subject,
}: {
  subject: Pick<QueueRequest, "template" | "platform" | "model">;
}) {
  if (subject.model)
    return <span className="font-mono text-xs">{subject.model}</span>;
  if (!subject.template) return <>Not reported</>;
  return (
    <>
      <span className="font-mono text-xs">{pinLabel(subject.template)}</span>
      {subject.platform && (
        <span className="block text-xs text-muted-foreground">
          {subject.platform}
        </span>
      )}
    </>
  );
}

export function RequestQueue({
  user,
  onDenied,
}: {
  user: User;
  onDenied: () => void;
}) {
  // A new component instance fences every response and intent when account identity changes.
  return (
    <QueueSession
      key={`${user.id}:${user.role}:${user.status}`}
      user={user}
      onDenied={onDenied}
    />
  );
}
function QueueSession({
  user,
  onDenied,
}: {
  user: User;
  onDenied: () => void;
}) {
  const [view, setView] = useState<QueueView | null>(null);
  const [clock, setClock] = useState<ClockReading | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [intent, setIntent] = useState<Intent | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(false),
    loading = useRef(false),
    refreshQueued = useRef(false),
    acting = useRef(false),
    refused = useRef(false);
  const deniedCallback = useRef(onDenied);
  deniedCallback.current = onDenied;
  const current = () => mounted.current && !refused.current;
  useTick();
  function handleDenied(e: unknown) {
    if (!denied(e)) return false;
    refused.current = true;
    setView(null);
    setIntent(null);
    setError("Administrator access is required.");
    deniedCallback.current();
    return true;
  }
  async function refresh(afterMutation = false) {
    if (!current() || user.role !== "admin") return;
    if (loading.current) {
      if (afterMutation) refreshQueued.current = true;
      return;
    }
    loading.current = true;
    try {
      const next = await api("admin/queue", undefined, queueView);
      if (current()) {
        setView(next);
        setClock(clockReading(Date.parse(next.observedAt)));
        setError("");
      }
    } catch (e) {
      if (current() && !handleDenied(e)) setError(errorMessage(e));
    } finally {
      loading.current = false;
      if (refreshQueued.current) {
        refreshQueued.current = false;
        if (current()) void refresh();
      }
    }
  }
  useEffect(() => {
    mounted.current = true;
    void refresh();
    const visibleRefresh = () => {
      if (!document.hidden) void refresh();
    };
    const timer = setInterval(visibleRefresh, 5000);
    document.addEventListener("visibilitychange", visibleRefresh);
    return () => {
      mounted.current = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", visibleRefresh);
    };
  }, []);
  async function cancel() {
    if (!intent || !current() || acting.current) return;
    acting.current = true;
    setBusy(true);
    setNotice("");
    try {
      const state = await api(
        `admin/requests/${intent.target.id}/cancel`,
        // The application selector binds the cancellation to this row: request UUIDs can repeat
        // across applications.
        { id: intent.requestId, applicationId: intent.target.applicationId },
        (value) =>
          systemReceipt(value, intent.target.id, intent.requestId, "cancel"),
      );
      if (!current()) return;
      setNotice(
        state === "cancelled"
          ? `Request ${name(intent.target)} cancelled. Nothing was reserved for it.`
          : `Request ${name(intent.target)} was no longer waiting. The controller reports: ${state}.`,
      );
      setIntent(null);
      setUncertain(false);
      void refresh(true);
    } catch (e) {
      if (!current() || handleDenied(e)) return;
      const definite =
        e !== null &&
        typeof e === "object" &&
        "status" in e &&
        typeof e.status === "number" &&
        e.status >= 400 &&
        e.status < 500 &&
        (!("outcome" in e) || e.outcome !== "unknown");
      setUncertain(!definite);
      setNotice(errorMessage(e));
    } finally {
      acting.current = false;
      if (current()) setBusy(false);
    }
  }
  if (user.role !== "admin")
    return <p role="alert">Administrator access is required.</p>;
  const now = clock ? controllerNow(clock) : Date.now();
  return (
    <div className="min-w-0 space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h1 className="font-display text-3xl font-medium tracking-tight">
            Queue
          </h1>
          <p className="max-w-prose text-sm text-muted-foreground">
            Requests waiting for a machine, device or runner, in the order the
            controller will try them. Position is an order of attempts, not a
            promise: a request that does not fit when tried is skipped, so a
            later position can be admitted first.
          </p>
        </div>
        <Button variant="outline" onClick={() => void refresh()}>
          <RefreshCw aria-hidden="true" />
          Refresh queue
        </Button>
      </div>
      {error && (
        <Alert variant="destructive" role="alert">
          <AlertDescription className="text-foreground">
            {view ? "The queue shown is stale. " : ""}
            {error}
          </AlertDescription>
        </Alert>
      )}
      {notice && !intent && <p role="status">{notice}</p>}
      {!view && !error && <p role="status">Loading the queue…</p>}
      {view && (
        <>
          <p className="text-xs text-muted-foreground">
            <span className="font-mono tabular-nums">{view.waitingTotal}</span>{" "}
            waiting ·{" "}
            <span className="font-mono tabular-nums">{view.activeTotal}</span>{" "}
            {view.activeTotal === 1 ? "lease holds" : "leases hold"} capacity ·
            controller time {localTime(view.observedAt)} · refreshes every 5
            seconds while visible
          </p>
          <section
            className="min-w-0 space-y-3"
            aria-labelledby="queue-waiting"
          >
            <h2 id="queue-waiting" className="text-lg font-semibold">
              Waiting requests
            </h2>
            {view.requests.length < view.waitingTotal && (
              <p className="text-sm text-muted-foreground">
                Showing the first {view.requests.length} of {view.waitingTotal}{" "}
                waiting requests. The rest are behind them in the order.
              </p>
            )}
            {!view.requests.length ? (
              <Empty className="border">
                <EmptyHeader>
                  <EmptyTitle>No requests are waiting</EmptyTitle>
                  <EmptyDescription>
                    A request appears here when an application submits it to the
                    queue and capacity or one of its limits keeps the controller
                    from admitting it at once. Direct acquisitions never wait:
                    they are admitted or refused.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <ol
                aria-label="Waiting requests in attempt order"
                className="min-w-0 divide-y overflow-hidden rounded-md border bg-card"
              >
                {view.requests.map((request) => (
                  <li
                    key={`${request.applicationId}:${request.id}`}
                    className="grid min-w-0 gap-3 px-4 py-4 lg:grid-cols-[5.5rem_minmax(0,1fr)_auto] lg:items-start"
                  >
                    <div className="min-w-0">
                      {request.position === null ? (
                        <Badge variant="outline">No position</Badge>
                      ) : (
                        <p
                          className="font-mono text-2xl font-medium tabular-nums"
                          aria-label={`Position ${request.position}`}
                        >
                          #{request.position}
                        </p>
                      )}
                    </div>
                    <div className="min-w-0 space-y-3">
                      <div className="min-w-0 space-y-1">
                        <p
                          className={`font-display text-base font-medium [overflow-wrap:anywhere] ${request.label ? "" : "text-muted-foreground"}`}
                        >
                          {request.label ?? "No label"}
                        </p>
                        <p className="text-sm">
                          {waitingReason(request)}
                          {request.reason && (
                            <>
                              {" "}
                              <span className="font-mono text-xs text-muted-foreground">
                                {request.reason}
                              </span>
                            </>
                          )}
                        </p>
                        {request.position === null && (
                          <p className="text-sm text-muted-foreground">
                            {unorderedReason(request, now)}
                          </p>
                        )}
                      </div>
                      <dl className="grid min-w-0 grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3 xl:grid-cols-5">
                        <Pair label="Kind">{kindLabels[request.kind]}</Pair>
                        <Pair
                          label={
                            request.kind === "model-job" ? "Model" : "Template"
                          }
                        >
                          <What subject={request} />
                        </Pair>
                        <Pair label="Priority" mono>
                          {request.priority}
                        </Pair>
                        <Pair label="Waiting for" mono>
                          <span
                            title={`Submitted ${localTime(request.createdAt)}`}
                          >
                            {duration(
                              (now - Date.parse(request.createdAt)) / 1000,
                            )}
                          </span>
                        </Pair>
                        <Pair label="Deadline" mono>
                          {request.deadline === null ? (
                            "None"
                          ) : (
                            <span title={localTime(request.deadline)}>
                              {Date.parse(request.deadline) > now
                                ? `in ${duration((Date.parse(request.deadline) - now) / 1000)}`
                                : "passed"}
                            </span>
                          )}
                        </Pair>
                      </dl>
                      <dl className="grid min-w-0 gap-x-4 gap-y-3 sm:grid-cols-2">
                        <Pair label="Application">
                          <Holder subject={request} />
                        </Pair>
                        <Pair label="Request" mono>
                          <a
                            className="underline-offset-4 hover:underline"
                            href={`#activity/request/${request.id}`}
                            aria-label={`Activity of request ${request.id}`}
                          >
                            {request.id}
                          </a>
                        </Pair>
                      </dl>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={!!intent || !!error}
                      aria-label={`Cancel request ${name(request)}`}
                      onClick={() => {
                        setUncertain(false);
                        setNotice("");
                        setIntent({
                          target: request,
                          requestId: crypto.randomUUID(),
                        });
                      }}
                    >
                      Cancel request
                    </Button>
                  </li>
                ))}
              </ol>
            )}
          </section>
          <ActiveLeases view={view} now={now} />
        </>
      )}
      <AlertDialog
        open={!!intent}
        onOpenChange={(open) => {
          if (!open && !busy && !uncertain) setIntent(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {intent
                ? `Cancel request ${name(intent.target)}?`
                : "Cancel request"}
            </AlertDialogTitle>
            <AlertDialogDescription className="[overflow-wrap:anywhere]">
              {intent && (
                <>
                  The request stops waiting and is not admitted. Nothing is
                  reserved for a waiting request, so no cleanup follows. Its
                  application reads the reason{" "}
                  <span className="font-mono">administrator_cancelled</span>. If
                  the controller admitted it since this page last refreshed,
                  cancelling releases its lease instead and cleanup follows the
                  lease rules.
                  <br />
                  Request: <span className="font-mono">{intent.target.id}</span>
                  <br />
                  Application:{" "}
                  {intent.target.applicationName
                    ? `${intent.target.applicationName} · `
                    : ""}
                  <span className="font-mono">
                    {intent.target.applicationId}
                  </span>
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {uncertain && (
            <p role="alert" className="text-sm">
              {notice} Keep this dialog open and retry the same cancellation to
              learn its outcome. Do not start another one.
            </p>
          )}
          {!uncertain && notice && (
            <p role="alert" className="text-sm">
              {notice}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy || uncertain}>
              Keep waiting
            </AlertDialogCancel>
            <Button disabled={busy} onClick={() => void cancel()}>
              {busy
                ? "Waiting…"
                : uncertain
                  ? "Retry same cancellation"
                  : "Cancel request"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function ActiveLeases({ view, now }: { view: QueueView; now: number }) {
  return (
    <section className="min-w-0 space-y-3" aria-labelledby="queue-leases">
      <div className="space-y-1">
        <h2 id="queue-leases" className="text-lg font-semibold">
          Leases holding capacity
        </h2>
        <p className="max-w-prose text-sm text-muted-foreground">
          Provisioning and ready leases, soonest deadline first. A holder can
          renew before the deadline, and an ended lease keeps its reservation
          until cleanup is proven, so time remaining is not when capacity frees.
          Release a lease from{" "}
          <a className="underline underline-offset-4" href="#system">
            System
          </a>
          .
        </p>
      </div>
      {view.leases.length < view.activeTotal && (
        <p className="text-sm text-muted-foreground">
          Showing the {view.leases.length} leases with the soonest deadline of{" "}
          {view.activeTotal}.
        </p>
      )}
      {!view.leases.length ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyTitle>No lease holds capacity</EmptyTitle>
            <EmptyDescription>
              Leases appear here from admission until they are released, expire
              or fail. Administrative machines that are not leased are listed
              under Machines.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ul
          aria-label="Leases holding capacity"
          className="min-w-0 divide-y overflow-hidden rounded-md border bg-card"
        >
          {view.leases.map((lease) => (
            <LeaseRow key={lease.id} lease={lease} now={now} />
          ))}
        </ul>
      )}
    </section>
  );
}
function LeaseRow({ lease, now }: { lease: QueueLease; now: number }) {
  const remaining = (Date.parse(lease.expiresAt) - now) / 1000;
  return (
    <li className="grid min-w-0 gap-3 px-4 py-4 lg:grid-cols-[5.5rem_minmax(0,1fr)] lg:items-start">
      <div className="min-w-0">
        <Badge variant="outline">{lease.state}</Badge>
      </div>
      <div className="min-w-0 space-y-3">
        <p
          className={`font-display text-base font-medium [overflow-wrap:anywhere] ${lease.name === null ? "text-muted-foreground" : ""}`}
        >
          {lease.name ?? "No label"}
        </p>
        <dl className="grid min-w-0 grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3 xl:grid-cols-5">
          <Pair label="Time remaining" mono>
            <span title={`Expires ${localTime(lease.expiresAt)}`}>
              {remaining > 0 ? duration(remaining) : "Deadline passed"}
            </span>
          </Pair>
          <Pair label="Template">
            <What subject={lease} />
          </Pair>
          <Pair label="Ledger">
            {lease.ledger === "linux" ? "Linux workspace" : "Machine or device"}
          </Pair>
        </dl>
        <dl className="grid min-w-0 gap-x-4 gap-y-3 sm:grid-cols-2">
          <Pair label="Holder">
            <Holder subject={lease} />
          </Pair>
          <Pair label="Lease" mono>
            <a
              className="underline-offset-4 hover:underline"
              href={`#activity/lease/${lease.id}`}
              aria-label={`Activity of lease ${lease.id}`}
            >
              {lease.id}
            </a>
          </Pair>
        </dl>
      </div>
    </li>
  );
}
