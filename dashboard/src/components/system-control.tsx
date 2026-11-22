import { useEffect, useRef, useState } from "react";
import { api, errorMessage } from "@/lib/api";
import {
  clockReading,
  controllerNow,
  duration,
  useTick,
  type ClockReading,
} from "@/lib/clock";
import type { User } from "@/lib/inventory";
import {
  systemCollections,
  systemReceipt,
  systemSnapshot,
  type SystemAction,
  type SystemCollection,
  type SystemRecord,
  type SystemSnapshot,
} from "@/lib/system-control";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from "./ui/card";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
} from "./ui/alert-dialog";
import { Empty, EmptyHeader, EmptyTitle } from "./ui/empty";

interface Intent {
  collection: SystemCollection;
  target: SystemRecord;
  action: SystemAction;
  requestId: string;
}
const labels: Record<SystemAction, string> = {
  release: "Release lease",
  close: "Close session",
  revoke: "Revoke application",
  cancel: "Cancel work",
};
const impacts: Record<SystemAction, string> = {
  release:
    "Revoke access and request cleanup of this lease. Cleanup may remain pending or blocked; reservations remain held until reclamation is confirmed.",
  close:
    "Close this access session. Its lease and machine remain active. Processes outside this connection may continue.",
  revoke:
    "Permanently revoke this application and access to all its leases. Active leases will be released for cleanup. Reservations remain held until reclamation is confirmed.",
  cancel:
    "Request cancellation of this work. An admitted request also releases its lease. Running jobs may continue until cancellation is confirmed; reservations remain held until cleanup is confirmed.",
};
function actionFor(
  collection: SystemCollection,
  item: SystemRecord,
): SystemAction | null {
  if (
    collection === "applications" &&
    !item.revoked &&
    item.state !== "revoked"
  )
    return "revoke";
  if (collection === "leases" && ["provisioning", "ready"].includes(item.state))
    return "release";
  if (
    collection === "sessions" &&
    ![
      "closed",
      "disconnected",
      "finished",
      "failed",
      "expired",
      "revoked",
    ].includes(item.state)
  )
    return "close";
  if (
    (collection === "requests" || collection === "jobs") &&
    !item.cancelRequested &&
    !["cancelled", "succeeded", "failed", "expired", "rejected"].includes(
      item.state,
    )
  )
    return "cancel";
  return null;
}
const date = (value: number) => new Date(value * 1000).toLocaleString();
/** Time until a lease deadline, against the controller's clock when the inventory carried it. It ticks
 * on its own so the inventory is not rendered again every second. */
function Remaining({
  expiresAt,
  clock,
}: {
  expiresAt: number;
  clock: ClockReading;
}) {
  useTick();
  const seconds = expiresAt - controllerNow(clock) / 1000;
  return <>{seconds > 0 ? duration(seconds) : "Deadline passed"}</>;
}
function actionLabel(
  collection: SystemCollection,
  item: SystemRecord,
  action: SystemAction,
): string {
  return collection === "requests" &&
    item.state === "admitted" &&
    action === "cancel"
    ? "Release admitted lease"
    : labels[action];
}

export function SystemControl({
  user,
  onDenied,
}: {
  user: User;
  onDenied: () => void;
}) {
  // A new component instance fences every response and intent when account identity changes.
  return (
    <SystemControlSession
      key={`${user.id}:${user.role}:${user.status}`}
      user={user}
      onDenied={onDenied}
    />
  );
}
function SystemControlSession({
  user,
  onDenied,
}: {
  user: User;
  onDenied: () => void;
}) {
  const [page, setPage] = useState(0);
  return (
    <SystemControlPage
      key={page}
      user={user}
      onDenied={onDenied}
      page={page}
      onPageChange={setPage}
    />
  );
}
function SystemControlPage({
  user,
  onDenied,
  page,
  onPageChange,
}: {
  user: User;
  onDenied: () => void;
  page: number;
  onPageChange: (page: number) => void;
}) {
  const [snapshot, setSnapshot] = useState<SystemSnapshot | null>(null);
  const [observedAt, setObservedAt] = useState<number | null>(null);
  const [clock, setClock] = useState<ClockReading | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [intent, setIntent] = useState<Intent | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(false);
  const loading = useRef(false);
  const refreshQueued = useRef(false);
  const acting = useRef(false);
  const denied = useRef(false);
  const deniedCallback = useRef(onDenied);
  deniedCallback.current = onDenied;
  const current = () => mounted.current && !denied.current;
  function handleDenied(e: unknown) {
    if (
      e &&
      typeof e === "object" &&
      "status" in e &&
      (e.status === 401 || e.status === 403)
    ) {
      denied.current = true;
      setSnapshot(null);
      setIntent(null);
      setError("Administrator access is required.");
      deniedCallback.current();
      return true;
    }
    return false;
  }
  async function refresh(afterMutation = false) {
    if (!current() || user.role !== "admin") return;
    if (loading.current) {
      if (afterMutation) refreshQueued.current = true;
      return;
    }
    loading.current = true;
    try {
      const next = await api(
        page === 0 ? "admin/system" : `admin/system/pages/${page}`,
        undefined,
        (value) => {
          const decoded = systemSnapshot(value);
          if ((decoded.page ?? 0) !== page)
            throw new Error("System inventory returned a different page.");
          return decoded;
        },
      );
      if (current()) {
        setSnapshot(next);
        setObservedAt(Date.now() / 1000);
        // Countdowns use the controller's clock. An older controller sends none; the browser's is used.
        setClock(
          clockReading(
            next.observedAt === undefined ? Date.now() : next.observedAt * 1000,
          ),
        );
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
  async function execute() {
    if (!intent || !current() || acting.current) return;
    acting.current = true;
    setBusy(true);
    setNotice("");
    try {
      const state = await api(
        `admin/${intent.collection}/${encodeURIComponent(intent.target.id)}/${intent.action}`,
        {
          id: intent.requestId,
          ...((intent.collection === "requests" ||
            intent.collection === "jobs") &&
          intent.target.applicationId
            ? { applicationId: intent.target.applicationId }
            : {}),
        },
        (value) =>
          systemReceipt(
            value,
            intent.target.id,
            intent.requestId,
            intent.action,
          ),
      );
      if (!current()) return;
      setNotice(
        `${actionLabel(intent.collection, intent.target, intent.action)} confirmed: ${state}.`,
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
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">
            System control
          </h1>
          <p className="text-sm text-muted-foreground">
            Application activity, execution and access connections
          </p>
        </div>
        <Button variant="outline" onClick={() => void refresh()}>
          Refresh system
        </Button>
      </div>
      {error && (
        <p role="alert">
          {snapshot ? "System data is stale. " : ""}
          {error}
        </p>
      )}
      {observedAt !== null && (
        <p className="text-xs text-muted-foreground">
          Last observed {date(observedAt)} · refreshes every 5 seconds while
          visible
        </p>
      )}
      {notice && <p role={intent ? "alert" : "status"}>{notice}</p>}
      {!snapshot && !error && <p role="status">Loading system activity…</p>}
      <nav
        aria-label="System inventory pages"
        className="flex flex-wrap items-center gap-3"
      >
        <Button
          variant="outline"
          disabled={page === 0 || !!intent}
          onClick={() => onPageChange(page - 1)}
        >
          Previous page
        </Button>
        <span className="text-sm">Page {page + 1}</span>
        <Button
          variant="outline"
          disabled={
            !snapshot || snapshot.nextPage == null || !!intent || !!error
          }
          onClick={() => {
            if (snapshot?.nextPage != null) onPageChange(snapshot.nextPage);
          }}
        >
          Next page
        </Button>
      </nav>
      {snapshot &&
        systemCollections.map((collection) => (
          <section
            key={collection}
            className="space-y-3"
            aria-label={collection}
          >
            <h2 className="text-base font-semibold capitalize">
              {collection}{" "}
              <span className="text-muted-foreground">
                ({snapshot[collection].length})
              </span>
            </h2>
            {!snapshot[collection].length ? (
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>No {collection} on this page</EmptyTitle>
                </EmptyHeader>
              </Empty>
            ) : (
              <div className="divide-y border-y">
                {snapshot[collection].map((item) => {
                  const action = actionFor(collection, item);
                  return (
                    <Card
                      key={`${item.family}:${item.id}:${item.applicationId ?? ""}`}
                      className="grid min-w-0 gap-3 rounded-none border-0 px-1 py-3 shadow-none lg:grid-cols-[minmax(10rem,1fr)_minmax(0,3fr)_auto] lg:items-start"
                    >
                      <CardHeader className="min-w-0 px-0">
                        <CardTitle className="break-all">
                          {item.name || item.id}
                        </CardTitle>
                        <CardDescription className="break-all">
                          {item.family}
                          {item.name ? ` · ${item.id}` : ""}
                        </CardDescription>
                      </CardHeader>
                      <CardContent className="min-w-0 space-y-2 px-0">
                        <Badge variant="outline">{item.state}</Badge>
                        {item.cleanup === "blocked" && (
                          <Badge variant="destructive">
                            Cleanup blocked · reservations retained
                          </Badge>
                        )}
                        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs xl:grid-cols-3">
                          {(
                            [
                              // A lease's `name` is the label its holder gave it.
                              [
                                "Label",
                                collection === "leases"
                                  ? (item.name ?? "None given")
                                  : undefined,
                              ],
                              ["Application", item.applicationId],
                              ["Lease", item.leaseId],
                              ["Machine", item.machineId],
                              ["Runtime", item.runtimeState],
                              [
                                "Ready",
                                item.ready === undefined
                                  ? undefined
                                  : item.ready
                                    ? "Yes"
                                    : "No",
                              ],
                              ["Requested state", item.requestedState],
                              ["Cleanup", item.cleanup],
                              ["Cleanup reason", item.cleanupReason],
                              ["Cleanup attempts", item.cleanupAttempts],
                              [
                                "Cleanup retry",
                                item.cleanupRetryAt === undefined
                                  ? undefined
                                  : date(item.cleanupRetryAt),
                              ],
                              [
                                "Reservation held",
                                item.reservationHeld === undefined
                                  ? undefined
                                  : item.reservationHeld
                                    ? "Yes"
                                    : "No",
                              ],
                              [
                                "Expires",
                                item.expiresAt === undefined
                                  ? undefined
                                  : date(item.expiresAt),
                              ],
                              [
                                "Time remaining",
                                collection === "leases" &&
                                clock &&
                                item.expiresAt !== undefined &&
                                ["provisioning", "ready"].includes(
                                  item.state,
                                ) ? (
                                  <Remaining
                                    expiresAt={item.expiresAt}
                                    clock={clock}
                                  />
                                ) : undefined,
                              ],
                              [
                                "Created",
                                item.createdAt === undefined
                                  ? undefined
                                  : date(item.createdAt),
                              ],
                              ["Revision", item.revision],
                              [
                                "Cancellation requested",
                                item.cancelRequested === undefined
                                  ? undefined
                                  : item.cancelRequested
                                    ? "Yes"
                                    : "No",
                              ],
                            ] as [string, React.ReactNode][]
                          ).map(
                            ([label, value]) =>
                              value !== undefined && (
                                <div key={label} className="min-w-0">
                                  <dt className="text-muted-foreground">
                                    {label}
                                  </dt>
                                  <dd className="break-all">{value}</dd>
                                </div>
                              ),
                          )}
                          {item.members?.map((member) => (
                            <div key={member.machineId}>
                              <dt className="text-muted-foreground">
                                Member · {member.name}
                              </dt>
                              <dd className="break-all">{member.machineId}</dd>
                              {member.runtimeState && (
                                <dd>Runtime: {member.runtimeState}</dd>
                              )}
                              {member.ready !== undefined && (
                                <dd>Ready: {member.ready ? "Yes" : "No"}</dd>
                              )}
                              {member.cleanup && (
                                <dd>Cleanup: {member.cleanup}</dd>
                              )}
                            </div>
                          ))}
                        </dl>
                        <details>
                          <summary className="cursor-pointer text-sm">
                            Record details
                          </summary>
                          <pre className="mt-2 whitespace-pre-wrap break-all text-xs">
                            {JSON.stringify(item, null, 2)}
                          </pre>
                        </details>
                      </CardContent>
                      {action && (
                        <CardFooter className="px-0">
                          <Button
                            variant="outline"
                            disabled={!!intent || !!error}
                            onClick={() => {
                              setUncertain(false);
                              setNotice("");
                              setIntent({
                                collection,
                                target: item,
                                action,
                                requestId: crypto.randomUUID(),
                              });
                            }}
                          >
                            {actionLabel(collection, item, action)}
                          </Button>
                        </CardFooter>
                      )}
                    </Card>
                  );
                })}
              </div>
            )}
          </section>
        ))}
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
                ? actionLabel(intent.collection, intent.target, intent.action)
                : "Confirm action"}
            </AlertDialogTitle>
            <AlertDialogDescription className="break-all">
              {intent && (
                <>
                  {impacts[intent.action]}
                  <br />
                  Target: {intent.target.name || intent.target.id}
                  {intent.target.applicationId && (
                    <>
                      <br />
                      Application: {intent.target.applicationId}
                    </>
                  )}
                  {intent.target.leaseId && (
                    <>
                      <br />
                      Lease: {intent.target.leaseId}
                    </>
                  )}
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {uncertain && (
            <p role="alert" className="text-sm">
              {notice} Keep this request open and retry it to confirm the
              outcome. Do not start a replacement action.
            </p>
          )}
          {!uncertain && notice && (
            <p role="alert" className="text-sm">
              {notice}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy || uncertain}>
              Cancel
            </AlertDialogCancel>
            <Button disabled={busy} onClick={() => void execute()}>
              {busy
                ? "Waiting…"
                : uncertain
                  ? "Retry same request"
                  : intent
                    ? actionLabel(
                        intent.collection,
                        intent.target,
                        intent.action,
                      )
                    : "Confirm action"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
