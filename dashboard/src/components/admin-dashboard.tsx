import { WorkspaceHeaderActions } from "./workspace-header-actions";
import { NativeSelect } from "@/components/ui/native-select";
import { hostIssue } from "@/lib/fleet";
import { FleetPulse } from "./fleet-pulse";
import { useCallback, useEffect, useRef, useState } from "react";
import { CircleCheck, RefreshCw } from "lucide-react";
import type { Inventory, User } from "@/lib/inventory";
import type { Host } from "@/lib/infrastructure";
import { api, attention, errorMessage, machineStatus } from "@/lib/api";
import {
  adminToken,
  adminTokens,
  adminUsers,
  ownerLabel,
  type AdminToken,
} from "@/lib/admin";
import { timestamp, tokenState } from "@/lib/accounts";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Badge, StatusBadge } from "./ui/badge";
import { Alert, AlertDescription } from "./ui/alert";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
  TableCaption,
} from "./ui/table";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from "./ui/alert-dialog";

const denied = (e: unknown) =>
  e !== null &&
  typeof e === "object" &&
  "status" in e &&
  [401, 403].includes(Number(e.status));

// Cache belongs to one active identity. Request epochs also fence slow refreshes.
function useAdminResource<T>(
  user: User | null,
  path: string,
  decode: (v: unknown) => T,
  onDenied: () => void,
  refreshKey?: string,
) {
  const key = user?.role === "admin" && user.status === "active" ? user.id : "";
  const [snapshot, setSnapshot] = useState<{
    key: string;
    data: T | null;
    error: string;
    loading: boolean;
  }>({ key: "", data: null, error: "", loading: false });
  const epoch = useRef(0),
    alive = useRef(false),
    deniedCallback = useRef(onDenied);
  deniedCallback.current = onDenied;
  const refresh = useCallback(async () => {
    if (!key || !alive.current) return;
    const request = ++epoch.current;
    setSnapshot((s) => ({
      key,
      data: s.key === key ? s.data : null,
      error: "",
      loading: true,
    }));
    try {
      const data = await api(path, undefined, decode);
      if (alive.current && epoch.current === request)
        setSnapshot({ key, data, error: "", loading: false });
    } catch (e) {
      if (!alive.current || epoch.current !== request) return;
      setSnapshot((s) => ({
        key,
        data: denied(e) ? null : s.data,
        loading: false,
        error: errorMessage(e),
      }));
      if (denied(e)) deniedCallback.current();
    }
  }, [key, path, decode, refreshKey]);
  useEffect(() => {
    alive.current = true;
    if (!key) setSnapshot({ key: "", data: null, error: "", loading: false });
    void refresh();
    return () => {
      alive.current = false;
      ++epoch.current;
    };
  }, [refresh, key]);
  const clear = useCallback(
    (error: string) => {
      ++epoch.current;
      setSnapshot({ key, data: null, error, loading: false });
    },
    [key],
  );
  return {
    data: snapshot.key === key && key ? snapshot.data : null,
    error: snapshot.key === key ? snapshot.error : "",
    loading: snapshot.key !== key || snapshot.loading,
    refresh,
    clear,
  };
}
export function useAdminUsers(
  user: User | null,
  onDenied: () => void,
  refreshKey?: string,
) {
  return useAdminResource(user, "users", adminUsers, onDenied, refreshKey);
}
type Directory = ReturnType<typeof useAdminUsers>;
function ErrorNotice({ children }: { children: string }) {
  return children ? (
    <Alert variant="destructive" role="alert">
      <AlertDescription>{children}</AlertDescription>
    </Alert>
  ) : null;
}
export function AdminOverview({
  headerActions,
  user,
  inventory,
  loaded,
  stale,
  directory,
  onDenied,
  onInspect,
  onRefresh,
}: {
  headerActions?: HTMLElement | null;
  user: User;
  inventory: Inventory;
  loaded: boolean;
  stale: string;
  directory: Directory;
  onDenied: () => void;
  onInspect: (id: string) => void;
  onRefresh: () => void;
}) {
  const tokens = useAdminResource(user, "admin/tokens", adminTokens, onDenied);
  const users = directory.data;
  const problemMachines = inventory.machines.filter(attention);
  const problemHosts = inventory.hosts.filter((h) => hostIssue(h) !== null);
  const [showAllIssues, setShowAllIssues] = useState(false);
  const issueCount = problemMachines.length + problemHosts.length;
  const issueLimit = 4;
  const machineLimit = issueLimit - Number(problemHosts.length > 0);
  const visibleMachines = showAllIssues
    ? problemMachines
    : problemMachines.slice(0, machineLimit);
  const visibleHosts = showAllIssues
    ? problemHosts
    : problemHosts.slice(0, Math.max(0, issueLimit - visibleMachines.length));
  const activeTokens = tokens.data?.filter(
    (t) => tokenState(t) === "Active",
  ).length;
  return (
    <>
      <WorkspaceHeaderActions container={headerActions}>
        <Button
          variant="outline"
          disabled={directory.loading || tokens.loading}
          onClick={() => {
            onRefresh();
            void directory.refresh();
            void tokens.refresh();
          }}
        >
          <RefreshCw />
          Refresh overview
        </Button>
      </WorkspaceHeaderActions>
      <ErrorNotice>{stale}</ErrorNotice>
      <ErrorNotice>
        {directory.error
          ? `Users could not be refreshed. ${directory.error}`
          : ""}
      </ErrorNotice>
      <ErrorNotice>
        {tokens.error
          ? `API access could not be refreshed. ${tokens.error}`
          : ""}
      </ErrorNotice>
      {(directory.loading || tokens.loading) && (
        <p role="status" className="text-sm text-muted-foreground">
          Refreshing administration…
        </p>
      )}
      <section aria-labelledby="overview-attention" className="min-w-0">
        <div className="flex items-center gap-2 border-b pb-2">
          <h2 id="overview-attention" className="text-base font-semibold">
            Needs attention
          </h2>
          <Badge variant="secondary">{loaded ? issueCount : "—"}</Badge>
        </div>
        <div className="divide-y">
          {!loaded ? (
            <p className="py-3 text-sm text-muted-foreground">
              Inventory unavailable.
            </p>
          ) : (
            <>
              {!issueCount && (
                <p className="flex items-center gap-2 py-3 text-sm text-muted-foreground">
                  {!stale && (
                    <CircleCheck
                      className="size-4 shrink-0 text-[color:var(--state-ready)]"
                      aria-hidden="true"
                    />
                  )}
                  {stale
                    ? "No alerts in the last inventory snapshot."
                    : "No alerts in the current inventory."}
                </p>
              )}
              {visibleMachines.map((m) => (
                <div
                  key={m.id}
                  className="flex items-center justify-between gap-3 py-2.5"
                >
                  <div className="min-w-0">
                    <p className="break-words text-sm font-medium">{m.name}</p>
                    <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      <Badge variant="destructive">{machineStatus(m)}</Badge>
                      <span className="[overflow-wrap:anywhere]">
                        {ownerLabel(m, users ?? [])}
                      </span>
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => onInspect(m.id)}
                  >
                    Inspect<span className="sr-only"> {m.name}</span>
                  </Button>
                </div>
              ))}
              {visibleHosts.map((h) => (
                <div
                  key={h.id}
                  className="flex items-center justify-between gap-3 py-2.5"
                >
                  <div className="min-w-0">
                    <p className="break-words text-sm font-medium">{h.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {hostIssue(h)}
                    </p>
                  </div>
                  <Button asChild variant="outline" size="sm">
                    <a
                      href={`#${h.kind === "orchestrator" || h.provider === "kubevirt" ? "orchestrators" : "hosts"}/${encodeURIComponent(h.id)}/resources`}
                    >
                      Review<span className="sr-only"> {h.name}</span>
                    </a>
                  </Button>
                </div>
              ))}
              {issueCount > issueLimit && (
                <Button
                  variant="ghost"
                  size="sm"
                  aria-expanded={showAllIssues}
                  onClick={() => setShowAllIssues((expanded) => !expanded)}
                >
                  {showAllIssues
                    ? "Show fewer issues"
                    : `Show all ${issueCount} issues`}
                </Button>
              )}
            </>
          )}
        </div>
      </section>
      <FleetPulse
        inventory={inventory}
        loaded={loaded}
        stale={Boolean(stale)}
        showHosts
      />
      <section
        aria-labelledby="overview-access"
        className="@container space-y-3"
      >
        <header className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="overview-access" className="text-base font-semibold">
            Access management
          </h2>
          <div className="flex flex-wrap gap-2">
            <Button asChild variant="outline">
              <a href="#admin/users">Manage users</a>
            </Button>
            <Button asChild variant="ghost">
              <a href="#admin/tokens">Review API access</a>
            </Button>
          </div>
        </header>
        {(directory.error || tokens.error) && (
          <p className="text-xs text-destructive">
            Access counts show the last available snapshot.
          </p>
        )}
        <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-sm border bg-border text-xs @2xl:grid-cols-5">
          {[
            ["Users", users?.length ?? "—"],
            [
              "Active administrators",
              users?.filter((u) => u.role === "admin" && u.status === "active")
                .length ?? "—",
            ],
            ["Active API tokens", activeTokens ?? "—"],
            [
              "Pending invitations",
              users?.filter((u) => u.status === "pending").length ?? "—",
            ],
            [
              "Disabled accounts",
              users?.filter((u) => u.status === "disabled").length ?? "—",
            ],
          ].map(([label, value]) => (
            <div
              key={label}
              className="flex min-w-0 flex-col justify-between bg-card px-3 py-4 text-center last:col-span-2 @2xl:last:col-span-1"
            >
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="mt-1 text-xl font-medium tracking-tight tabular-nums">
                {value}
              </dd>
            </div>
          ))}
        </dl>
      </section>
    </>
  );
}

export function AdminTokensPage({
  user,
  directory,
  onDenied,
}: {
  user: User;
  directory: Directory;
  onDenied: () => void;
}) {
  const resource = useAdminResource(
    user,
    "admin/tokens",
    adminTokens,
    onDenied,
  );
  const [query, setQuery] = useState(""),
    [state, setState] = useState("all"),
    [target, setTarget] = useState<AdminToken | null>(null),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  const alive = useRef(false),
    locked = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const owner = (id: string) =>
    directory.data?.find((u) => u.id === id)?.username || id;
  async function revoke(t: AdminToken) {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setMessage("");
    let accessDenied = false;
    try {
      const receipt = await api(
        `admin/tokens/${encodeURIComponent(t.id)}/revoke`,
        {},
        adminToken,
      );
      if (!alive.current) return;
      if (
        receipt.id !== t.id ||
        receipt.userId !== t.userId ||
        receipt.revokedAt === null
      )
        throw new Error("Revocation receipt did not match the selected token.");
      setMessage(`Revoked ${t.name}.`);
    } catch (e) {
      if (!alive.current) return;
      if (denied(e)) {
        accessDenied = true;
        resource.clear(
          "Administrator access ended. Sign in again to continue.",
        );
        onDenied();
        return;
      }
      setMessage(
        `Revocation could not be confirmed for ${t.name}. Refresh API access and check its status before trying again.`,
      );
    } finally {
      locked.current = false;
      if (alive.current) {
        setBusy(false);
        setTarget(null);
        if (!accessDenied) void resource.refresh();
      }
    }
  }
  const rows =
    resource.data?.filter(
      (t) =>
        (state === "all" || tokenState(t).toLowerCase() === state) &&
        [t.name, t.prefix, t.userId, owner(t.userId), ...t.scopes]
          .join(" ")
          .toLowerCase()
          .includes(query.trim().toLowerCase()),
    ) ?? [];
  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          Review and revoke personal API tokens across all user accounts.
        </p>
        <Button
          variant="outline"
          disabled={busy || resource.loading}
          onClick={() => {
            void resource.refresh();
            void directory.refresh();
          }}
        >
          Refresh API access
        </Button>
      </div>
      <ErrorNotice>
        {resource.error
          ? `API access could not be refreshed. ${resource.error}`
          : ""}
      </ErrorNotice>
      <ErrorNotice>
        {directory.error
          ? `Owner names unavailable. User IDs are shown. ${directory.error}`
          : ""}
      </ErrorNotice>
      {message && (
        <Alert role="status">
          <AlertDescription>{message}</AlertDescription>
        </Alert>
      )}
      <div
        role="group"
        aria-label="Filter API tokens"
        className="flex flex-wrap items-end gap-2 border-y py-2"
      >
        <label className="grid w-full gap-1 text-[13px] font-medium sm:w-64">
          Search API tokens
          <Input
            aria-label="Search API tokens"
            className="h-10 md:h-8"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Name, owner or permission…"
          />
        </label>
        <label className="grid w-full gap-1 text-[13px] font-medium sm:w-40">
          Token status
          <NativeSelect
            aria-label="Token status"
            className="h-10 w-full md:h-8"
            value={state}
            onChange={(e) => setState(e.target.value)}
          >
            {["all", "active", "expired", "revoked"].map((s) => (
              <option key={s} value={s}>
                {s === "all"
                  ? "All statuses"
                  : s[0]?.toUpperCase() + s.slice(1)}
              </option>
            ))}
          </NativeSelect>
        </label>
        {(query || state !== "all") && (
          <Button
            className="ml-auto"
            variant="ghost"
            size="sm"
            onClick={() => {
              setQuery("");
              setState("all");
            }}
          >
            Clear filters
          </Button>
        )}
      </div>
      <div className="@container min-w-0 border-b">
        <Table className="block @3xl:table">
          <TableCaption className="sr-only">
            Personal API tokens across all users
          </TableCaption>
          <TableHeader className="sr-only @3xl:not-sr-only @3xl:table-header-group">
            <TableRow>
              {[
                "Token",
                "Owner",
                "Permissions",
                "Status",
                "Last used",
                "Expires",
                "",
              ].map((h) => (
                <TableHead key={h}>
                  {h || <span className="sr-only">Actions</span>}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody className="block @3xl:table-row-group">
            {rows.map((t) => (
              <TableRow
                key={t.id}
                className="grid gap-2 py-3 @3xl:table-row @3xl:py-0 [&>td]:h-auto [&>td]:px-1 [&>td]:py-0 @3xl:[&>td]:px-3 @3xl:[&>td]:py-2"
              >
                <TableCell className="max-w-64 !whitespace-normal break-words">
                  <span className="font-medium">{t.name}</span>
                  <span className="block font-mono text-xs text-muted-foreground">
                    {t.prefix}…
                  </span>
                  <span className="block text-xs tabular-nums text-muted-foreground">
                    Created {timestamp(t.createdAt)}
                  </span>
                </TableCell>
                <TableCell className="max-w-48 !whitespace-normal [overflow-wrap:anywhere]">
                  <span className="block text-xs text-muted-foreground @3xl:hidden">
                    Owner
                  </span>
                  {owner(t.userId)}
                </TableCell>
                <TableCell className="!whitespace-normal">
                  <span className="block text-xs text-muted-foreground @3xl:hidden">
                    Permissions
                  </span>
                  <div className="flex flex-wrap gap-1">
                    {t.scopes.map((s) => (
                      <Badge key={s}>{s}</Badge>
                    ))}
                  </div>
                </TableCell>
                <TableCell>
                  <span className="block text-xs text-muted-foreground @3xl:hidden">
                    Status
                  </span>
                  <StatusBadge state={tokenState(t)} />
                  {t.revokedAt !== null && (
                    <span className="block text-xs text-muted-foreground">
                      {timestamp(t.revokedAt)}
                    </span>
                  )}
                </TableCell>
                <TableCell>
                  <span className="block text-xs text-muted-foreground @3xl:hidden">
                    Last used
                  </span>
                  {timestamp(t.lastUsedAt)}
                </TableCell>
                <TableCell>
                  <span className="block text-xs text-muted-foreground @3xl:hidden">
                    Expires
                  </span>
                  {timestamp(t.expiresAt)}
                </TableCell>
                <TableCell>
                  {t.revokedAt === null && (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy || !!resource.error || resource.loading}
                      onClick={() => setTarget(t)}
                    >
                      Revoke<span className="sr-only"> {t.name}</span>
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
            {!rows.length && (
              <TableRow className="block @3xl:table-row">
                <TableCell
                  colSpan={7}
                  className="block h-auto py-3 !whitespace-normal text-left text-[13px] text-muted-foreground @3xl:table-cell"
                >
                  {resource.loading
                    ? "Loading API access…"
                    : !resource.data
                      ? "API access is unavailable. Refresh to try again."
                      : resource.data.length
                        ? "No tokens match your search and status filter."
                        : "No personal API tokens yet. Users create tokens from their account menu."}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      <p className="text-xs text-muted-foreground">
        Token secrets are shown only to their owner when created. Revocation
        blocks new requests and connected access; the record remains here. To
        create your own token, use API tokens in your account menu.
      </p>
      <AlertDialog
        open={!!target}
        onOpenChange={(open) => {
          if (!open && !busy) setTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke {target?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              This will stop automation and connected access using this token
              for {target ? owner(target.userId) : "this user"}. Revocation
              cannot be undone. The user can create a replacement token.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={busy}
              onClick={(e) => {
                e.preventDefault();
                if (target) void revoke(target);
              }}
            >
              {busy ? "Revoking…" : "Revoke token"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
