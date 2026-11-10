import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUpRight, KeyRound, Monitor, Server, Users } from "lucide-react";
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
import { Badge } from "./ui/badge";
import { Alert, AlertDescription } from "./ui/alert";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "./ui/card";
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
function hostIssue(host: Host) {
  if (!host.online) return "Offline";
  if (!host.enabled) return "Draining";
  if (host.overcommitted) return "Overcommitted";
  if (host.placementReady === false || host.health?.status === "failed") {
    if (host.health?.fresh === false) return "Environment checks are stale";
    if (host.health?.status === "checking")
      return "Environment checks in progress";
    if (host.health?.status === "failed") return "Environment checks failed";
    return "Placement not ready";
  }
  return null;
}
function ErrorNotice({ children }: { children: string }) {
  return children ? (
    <Alert variant="destructive" role="alert">
      <AlertDescription>{children}</AlertDescription>
    </Alert>
  ) : null;
}
function Heading({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="space-y-1">
      <h1 className="font-display text-3xl font-medium tracking-tight">
        {title}
      </h1>
      <p className="text-sm text-muted-foreground">{description}</p>
    </div>
  );
}
export function AdminOverview({
  user,
  inventory,
  loaded,
  stale,
  directory,
  onDenied,
  onInspect,
  onRefresh,
}: {
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
  const activeTokens = tokens.data?.filter(
    (t) => tokenState(t) === "Active",
  ).length;
  const metrics = [
    {
      label: "Machines",
      value: loaded ? inventory.machines.length : "—",
      detail: loaded
        ? `${inventory.machines.filter((m) => m.ready).length} ready`
        : "Inventory unavailable",
      href: "#machines",
      icon: Monitor,
    },
    {
      label: "Users",
      value: users?.length ?? "—",
      detail: users
        ? `${users.filter((u) => u.status === "pending").length} pending`
        : "User directory unavailable",
      href: "#admin/users",
      icon: Users,
    },
    {
      label: "Active API tokens",
      value: activeTokens ?? "—",
      detail: "Across all user accounts",
      href: "#admin/tokens",
      icon: KeyRound,
    },
    {
      label: "Infrastructure",
      value: loaded ? inventory.hosts.length : "—",
      detail: loaded
        ? `${inventory.hosts.filter((h) => h.online).length} online connections`
        : "Inventory unavailable",
      href: "#hosts",
      icon: Server,
    },
  ];
  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <Heading
          title="Administration"
          description="Manage access, review the fleet and keep infrastructure ready."
        />
        <Button
          variant="outline"
          onClick={() => {
            onRefresh();
            void directory.refresh();
            void tokens.refresh();
          }}
        >
          Refresh administration
        </Button>
      </div>
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
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {metrics.map(({ label, value, detail, href, icon: Icon }) => (
          <Card key={label} className="rounded-md shadow-none">
            <CardHeader className="pb-2">
              <CardDescription className="flex items-center justify-between">
                <span>{label}</span>
                <Icon className="size-4" />
              </CardDescription>
              <CardTitle className="font-display text-3xl font-medium">
                {value}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="mb-3 text-xs text-muted-foreground">{detail}</p>
              <a
                className="inline-flex items-center gap-1 text-sm underline-offset-4 hover:underline"
                href={href}
              >
                View {label.toLowerCase()}
                <ArrowUpRight className="size-3" />
              </a>
            </CardContent>
          </Card>
        ))}
      </div>
      <div className="grid min-w-0 gap-4 lg:grid-cols-2">
        <Card className="min-w-0 rounded-md shadow-none">
          <CardHeader>
            <CardTitle>Needs attention</CardTitle>
            <CardDescription>
              Current machine and infrastructure state.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {!loaded ? (
              <p className="text-sm text-muted-foreground">
                Load inventory to review machine and connection status.
              </p>
            ) : (
              <>
                {!problemMachines.length && !problemHosts.length && (
                  <p className="text-sm text-muted-foreground">
                    No machine or infrastructure alerts in the current
                    inventory.
                  </p>
                )}
                {problemMachines.map((m) => (
                  <div
                    key={m.id}
                    className="flex items-center justify-between gap-3 border-b pb-3 last:border-0"
                  >
                    <div className="min-w-0">
                      <p className="break-words text-sm font-medium">
                        {m.name}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {machineStatus(m)} · {ownerLabel(m, users ?? [])}
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
                {problemHosts.map((h) => (
                  <div
                    key={h.id}
                    className="flex items-center justify-between gap-3 border-b pb-3 last:border-0"
                  >
                    <div className="min-w-0">
                      <p className="break-words text-sm font-medium">
                        {h.name}
                      </p>
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
              </>
            )}
          </CardContent>
        </Card>
        <Card className="rounded-md shadow-none">
          <CardHeader>
            <CardTitle>Access management</CardTitle>
            <CardDescription>
              Users see their own machines. Administrators can manage the fleet.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              {users
                ? `${users.filter((u) => u.role === "admin" && u.status === "active").length} active administrators · ${users.filter((u) => u.status === "disabled").length} disabled accounts`
                : "Refresh the user directory to review account status."}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button asChild>
                <a href="#admin/users">Manage users</a>
              </Button>
              <Button asChild variant="outline">
                <a href="#admin/tokens">Review API access</a>
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Invitations and password resets are delivered manually. API tokens
              are created by their owners and can be revoked here.
            </p>
            <div className="flex flex-wrap gap-4 border-t pt-4 text-sm">
              <a href="#machines" className="underline underline-offset-4">
                All machines
              </a>
              <a href="#hosts" className="underline underline-offset-4">
                Hosts and limits
              </a>
              <a href="#orchestrators" className="underline underline-offset-4">
                Orchestrators
              </a>
              <a href="#images" className="underline underline-offset-4">
                Images and imports
              </a>
            </div>
          </CardContent>
        </Card>
      </div>
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
        <Heading
          title="API access"
          description="Review and revoke personal API tokens across all user accounts."
        />
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
      <div className="flex flex-wrap items-end gap-3">
        <label className="grid flex-1 gap-1 text-sm">
          Search API tokens
          <Input
            aria-label="Search API tokens"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Name, owner or permission…"
          />
        </label>
        <label className="grid gap-1 text-sm">
          Token status
          <select
            aria-label="Token status"
            className="h-9 rounded-md border bg-background px-3"
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
          </select>
        </label>
      </div>
      <div className="min-w-0 overflow-hidden rounded-md border">
        <Table>
          <TableCaption className="sr-only">
            Personal API tokens across all users
          </TableCaption>
          <TableHeader>
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
          <TableBody>
            {rows.map((t) => (
              <TableRow key={t.id}>
                <TableCell className="max-w-64 !whitespace-normal break-words">
                  <span className="font-medium">{t.name}</span>
                  <span className="block font-mono text-xs text-muted-foreground">
                    {t.prefix}…
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    Created {timestamp(t.createdAt)}
                  </span>
                </TableCell>
                <TableCell className="max-w-48 !whitespace-normal break-all">
                  {owner(t.userId)}
                </TableCell>
                <TableCell className="!whitespace-normal">
                  <div className="flex flex-wrap gap-1">
                    {t.scopes.map((s) => (
                      <Badge key={s} variant="outline">
                        {s}
                      </Badge>
                    ))}
                  </div>
                </TableCell>
                <TableCell>
                  <Badge variant="outline">{tokenState(t)}</Badge>
                  {t.revokedAt !== null && (
                    <span className="block text-xs text-muted-foreground">
                      {timestamp(t.revokedAt)}
                    </span>
                  )}
                </TableCell>
                <TableCell>{timestamp(t.lastUsedAt)}</TableCell>
                <TableCell>{timestamp(t.expiresAt)}</TableCell>
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
              <TableRow>
                <TableCell
                  colSpan={7}
                  className="h-32 !whitespace-normal text-center text-muted-foreground"
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
      <p className="text-xs text-muted-foreground sm:hidden">
        Swipe across the table to view dates and actions.
      </p>
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
