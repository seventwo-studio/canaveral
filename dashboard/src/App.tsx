import { matchesMachineState } from "./lib/fleet";
import {
  MobileInstall,
  mobileInstallEligible,
} from "./components/mobile-install";
import { MobileCapture } from "./components/mobile-capture";
import { MachineInventory } from "./components/machine-inventory";
import { FleetPulse } from "./components/fleet-pulse";
import type { FormEvent, ReactNode } from "react";
import {
  authStatus,
  loginReceipt,
  hostsResponse,
  machinesResponse,
  imagesResponse,
  createdMachine,
} from "@/lib/inventory";
import type {
  CreatedMachine,
  GroupedImage,
  Inventory,
  Machine,
  User,
} from "@/lib/inventory";
import { record } from "@/lib/types";
import type { AuthState } from "@/lib/types";
import type { Host } from "@/lib/infrastructure";
import type { RegistryEntry, Resources } from "@/lib/catalogue";
type View = keyof typeof destinations;
import { AccountPage, TokensPage, UsersPage } from "@/components/accounts";
import {
  AdminOverview,
  AdminTokensPage,
  useAdminUsers,
} from "@/components/admin-dashboard";
import { SystemControl } from "@/components/system-control";
import { ApiWorkspace } from "@/components/api-workspace";
import { ownerLabel } from "@/lib/admin";
import {
  ImageLibrary,
  MachineBlueprints,
  BlueprintEditor,
} from "@/components/machine-blueprints";
import { ClaimScreen, takeClaim } from "@/components/claim-screen";
interface CreateConfig {
  templates: GroupedImage[];
  selected?: GroupedImage;
  returnFocus: Element | null;
  /** Desktop launch asks only for a name, a desktop image and its size. */
  desktop?: boolean;
}
/** Images that boot an interactive Linux desktop the viewer can open: the host must
 * prepare owned guest access, which carries the display. */
const desktopImage = (t: { os: string; mode: string; guestAccess?: boolean }) =>
  t.os === "linux" && t.mode === "desktop" && t.guestAccess === true;
interface CreateSpec {
  id: string;
  name: string;
  templateId?: string;
  templateRevision?: string;
  arch?: string;
  blueprintId?: string;
  blueprintRevision?: string;
  resources: Resources;
  hostId?: string;
}
const focus = (element: Element | null) => {
  if (element instanceof HTMLElement || element instanceof SVGElement)
    element.focus();
};
const statusCode = (error: unknown) =>
  error !== null && typeof error === "object" && "status" in error
    ? error.status
    : undefined;
import { useEffect, useRef, useState } from "react";
import {
  Rocket,
  ArrowUpRight,
  Plus,
  Search,
  RefreshCw,
  Orbit,
  CircleAlert,
  Monitor,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from "@/components/ui/alert-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  ConnectionSetup,
  InfrastructureCard,
  InfrastructureDetails,
} from "@/components/infrastructure";
import { WorkspaceBuilds } from "@/components/workspace-builds";
import { WorkspacePreviews } from "@/components/workspace-previews";
import { ModelRuns } from "@/components/model-runs";
import { BaseImageRegistry } from "@/components/image-registry";
import { MachinePowerOff } from "@/components/machine-power";
import { MachineDelete } from "@/components/machine-delete";
import {
  ImageImport,
  ImageCapture,
  ImageActivity,
} from "@/components/image-actions";
import { MachineControl } from "@/components/machine-control";
import { LoginScreen } from "@/components/login-screen";
import { destinations, WorkspaceSidebar } from "@/components/workspace-sidebar";
import {
  SidebarProvider,
  SidebarInset,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { Separator } from "@/components/ui/separator";
import {
  Breadcrumb,
  BreadcrumbList,
  BreadcrumbLink,
  BreadcrumbItem,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import {
  Field,
  FieldLabel,
  FieldGroup,
  FieldSet,
  FieldDescription,
  FieldError,
} from "@/components/ui/field";
import {
  InputGroup,
  InputGroupInput,
  InputGroupAddon,
} from "@/components/ui/input-group";
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
  EmptyContent,
} from "@/components/ui/empty";
import {
  api,
  errorMessage,
  title,
  memory,
  number,
  provider,
  machineStatus,
  attention,
  templatesFor,
  since,
} from "@/lib/api";

const views = {
  machines: {
    filters: ["all", "ready", "preparing", "running", "stopped", "attention"],
  },
  hosts: {
    filters: ["all", "online", "offline", "draining"],
  },
  orchestrators: {
    filters: ["all", "online", "offline", "draining"],
  },
  builds: { filters: [] },
  previews: { filters: [] },
  models: { filters: [] },
  blueprints: { filters: [] },
  templates: {
    filters: ["all", "headless", "desktop", "device"],
  },
};
const currentView = (): View => {
  const parts = location.hash.slice(1).split("/");
  const name = parts[0] ?? "";
  if (name === "admin")
    return parts[1] === "users"
      ? "users"
      : parts[1] === "tokens"
        ? "api-access"
        : "admin";
  return name === "images"
    ? "templates"
    : [
          "account",
          "tokens",
          "users",
          "api-access",
          "system",
          "configuration",
        ].includes(name) || Object.hasOwn(views, name)
      ? (name as View)
      : "machines";
};
const currentInfrastructure = () => {
  const parts = location.hash.slice(1).split("/");
  if (
    !["hosts", "orchestrators"].includes(parts[0] ?? "") ||
    ![2, 3].includes(parts.length) ||
    (parts.length === 3 && parts[2] !== "resources")
  )
    return null;
  try {
    return decodeURIComponent(parts[1] ?? "");
  } catch {
    return null;
  }
};
const eligible = (t: GroupedImage) =>
  t.hosts.some((h) => h.online && h.accepting);
function filterLabel(value: string) {
  if (value === "attention") return "Needs attention";
  if (value === "running-unready") return "Running · not ready";
  return title(value).replaceAll("-", " ");
}

function Notice({
  children,
  error = false,
}: {
  children: ReactNode;
  error?: boolean;
}) {
  return children ? (
    <Alert
      className="shrink-0"
      variant={error ? "destructive" : "default"}
      role={error ? "alert" : "status"}
    >
      {error && <CircleAlert aria-hidden="true" />}
      <AlertDescription className="text-foreground">
        {children}
      </AlertDescription>
    </Alert>
  ) : null;
}
function Status({ text }: { text: string }) {
  return (
    <Badge
      variant="outline"
      className={`status status-${text.toLowerCase().replaceAll(" ", "-")}`}
    >
      <span className="status-dot" />
      {text}
    </Badge>
  );
}
export function App() {
  const [claim, setClaim] = useState(takeClaim);
  const identity = useRef<User | null>(null);
  const [auth, setAuth] = useState<AuthState>("checking"),
    [user, setUser] = useState<User | null>(null),
    [authError, setAuthError] = useState("");
  const [inventory, setInventory] = useState<Inventory>({
    hosts: [],
    machines: [],
    templates: [],
  });
  const [loaded, setLoaded] = useState(false),
    [stale, setStale] = useState(""),
    [message, setMessage] = useState(""),
    [actionError, setActionError] = useState("");
  const [busy, setBusy] = useState(false),
    [requestedView, setView] = useState(currentView),
    [filter, setFilter] = useState("all"),
    [query, setQuery] = useState("");
  const [owner, setOwner] = useState("all");
  const directory = useAdminUsers(
    user,
    () => {
      void signOut("Administrator access ended. Sign in again to continue.");
    },
    requestedView,
  );
  const [controlId, setControlId] = useState<string | null>(null);
  const [connectionSetup, setConnectionSetup] = useState<
      "host" | "orchestrator" | null
    >(null),
    [infrastructureId, setInfrastructureId] = useState(currentInfrastructure);
  const [imageImport, setImageImport] = useState<boolean | RegistryEntry>(
      false,
    ),
    [captureId, setCaptureId] = useState<string | null>(null);
  const [registryOpen, setRegistryOpen] = useState(false);
  const [blueprintSource, setBlueprintSource] = useState<GroupedImage | null>(
    null,
  );
  const [powerOffId, setPowerOffId] = useState<string | null>(null);
  const view: View =
    user?.role !== "admin" &&
    [
      "hosts",
      "orchestrators",
      "users",
      "admin",
      "api-access",
      "system",
      "configuration",
      "models",
    ].includes(requestedView)
      ? "machines"
      : requestedView;
  const isInfrastructure = view === "hosts" || view === "orchestrators";
  const infrastructureKind = (h: Host) =>
    h.kind || (h.provider === "kubevirt" ? "orchestrator" : "host");
  const infrastructureHosts = inventory.hosts.filter(
    (h) =>
      infrastructureKind(h) ===
      (view === "orchestrators" ? "orchestrator" : "host"),
  );
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const deleting = useRef(new Map<string, string>());
  // One deletion request UUID per machine, kept across dialog reopenings so an
  // unconfirmed request is always checked or retried under its original ID.
  const deleteIntents = useRef(new Map<string, string>());
  const [create, setCreate] = useState<CreateConfig | null>(null),
    [detailId, setDetailId] = useState<string | null>(null),
    [stop, setStop] = useState<Machine | null>(null);
  const session = useRef({ active: false, generation: 0 }),
    refreshing = useRef<Promise<void> | null>(null),
    acting = useRef(false);
  const detailTrigger = useRef<Element | null>(null),
    stopTrigger = useRef<Element | null>(null),
    operationTrigger = useRef<Element | null>(null);
  const hostName = (id: string) =>
    inventory.hosts.find((h) => h.id === id)?.name || "Unknown host";
  async function signOut(reason = "") {
    const old = session.current.active;
    const generation = session.current.generation + 1;
    session.current = { active: false, generation };
    refreshing.current = null;
    acting.current = false;
    setUser(null);
    identity.current = null;
    setBusy(old);
    setCreate(null);
    setDetailId(null);
    setControlId(null);
    setConnectionSetup(null);
    setImageImport(false);
    setRegistryOpen(false);
    setBlueprintSource(null);
    setPowerOffId(null);
    setDeleteId(null);
    deleting.current.clear();
    deleteIntents.current.clear();
    setCaptureId(null);
    setStop(null);
    setLoaded(false);
    setInventory({ hosts: [], machines: [], templates: [] });
    setStale("");
    setMessage("");
    setActionError("");
    setAuthError(reason);
    try {
      if (old) await api("auth/logout", {});
    } catch (error) {
      if (statusCode(error) !== 401)
        setAuthError("Could not sign out on the server. Retry when connected.");
    } finally {
      if (session.current.generation === generation) setBusy(false);
    }
  }
  async function loadAuth() {
    if (!window.isSecureContext) {
      setAuth("insecure");
      setAuthError(
        "Open this dashboard over HTTPS or loopback localhost before entering a password.",
      );
      return;
    }
    setAuth("checking");
    setAuthError("");
    try {
      const s = await api("auth/status", undefined, authStatus);
      if (s.user?.status === "active") {
        identity.current = s.user;
        session.current.active = true;
        setUser(s.user);
        await refresh();
      }
      setAuth(
        s.setupRequired ? (s.setupAllowed ? "setup" : "blocked") : "login",
      );
    } catch (e) {
      setAuth("unavailable");
      setAuthError(errorMessage(e));
    }
  }
  useEffect(() => {
    if (!claim) loadAuth();
  }, []);
  async function refresh() {
    if (refreshing.current) return refreshing.current;
    const { active, generation } = session.current;
    if (!active) return;
    const task = (async () => {
      try {
        const current = await api("auth/session", undefined, loginReceipt);
        if (generation !== session.current.generation) return;
        if (current.user.status !== "active") {
          await signOut(
            "This account is not active. Contact your administrator.",
          );
          return;
        }
        if (
          identity.current &&
          (identity.current.id !== current.user.id ||
            identity.current.role !== current.user.role)
        ) {
          await signOut(
            "Your account access changed. Sign in again to continue.",
          );
          return;
        }
        identity.current = current.user;
        setUser(current.user);
        const [h, m, t] = await Promise.all([
          identity.current?.role === "admin"
            ? api("hosts", undefined, hostsResponse)
            : Promise.resolve([]),
          api("machines", undefined, machinesResponse),
          api("templates", undefined, imagesResponse),
        ]);
        if (generation !== session.current.generation) return;
        setInventory({
          hosts: h,
          machines: m,
          templates: t,
        });
        setLoaded(true);
        setStale("");
      } catch (e) {
        if (generation !== session.current.generation) return;
        if (statusCode(e) === 401)
          signOut("Your session ended. Sign in again to continue.");
        else
          setStale(
            `Could not refresh inventory. ${errorMessage(e)} Displayed data may be out of date.`,
          );
      }
    })();
    refreshing.current = task;
    try {
      await task;
    } finally {
      if (refreshing.current === task) refreshing.current = null;
    }
  }
  useEffect(() => {
    if (!user) return;
    const visibleRefresh = () => {
      if (!document.hidden) refresh();
    };
    const timer = setInterval(visibleRefresh, 5000);
    document.addEventListener("visibilitychange", visibleRefresh);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", visibleRefresh);
    };
  }, [user]);
  useEffect(() => {
    const change = () => {
      setView(currentView());
      setInfrastructureId(currentInfrastructure());
      setFilter("all");
      setQuery("");
      setOwner("all");
    };
    window.addEventListener("hashchange", change);
    return () => window.removeEventListener("hashchange", change);
  }, []);
  // A requested deletion is reported only once the controller stops listing the
  // machine, which happens after the host's owned-removal receipt is complete.
  useEffect(() => {
    if (!loaded || stale) return;
    for (const [id, name] of deleting.current)
      if (!inventory.machines.some((m) => m.id === id)) {
        deleting.current.delete(id);
        deleteIntents.current.delete(id);
        setMessage(`${name} deleted. The host confirmed removal.`);
      }
  }, [inventory, loaded, stale]);
  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (acting.current || !["setup", "login"].includes(auth)) return;
    const form = event.currentTarget,
      data = new FormData(form);
    const credentials = {
      username: String(data.get("username") ?? "").trim(),
      password: data.get("password"),
    };
    if (auth === "setup" && credentials.password !== data.get("confirmation")) {
      setAuthError("Passwords do not match.");
      return;
    }
    form.reset();
    acting.current = true;
    setBusy(true);
    setAuthError("");
    const generation = ++session.current.generation;
    try {
      const result = await api(
        auth === "setup" ? "auth/setup" : "auth/login",
        credentials,
        loginReceipt,
      );
      if (generation !== session.current.generation) return;
      session.current.active = true;
      if (result.user.status !== "active")
        throw new Error("This account is not active.");
      identity.current = result.user;
      setUser(result.user);
      setAuth("login");
      await refresh();
    } catch (e) {
      if (generation === session.current.generation) {
        if (statusCode(e) === 409) setAuth("login");
        setAuthError(
          statusCode(e) === 401
            ? "Username or password rejected."
            : errorMessage(e),
        );
      }
    } finally {
      if (generation === session.current.generation) {
        acting.current = false;
        setBusy(false);
      }
    }
  }
  async function mutate(
    path: string,
    value: unknown,
    success: string | ((machine: CreatedMachine) => string),
    isCreate = false,
  ) {
    if (acting.current) return false;
    acting.current = true;
    setBusy(true);
    setMessage("");
    setActionError("");
    const { generation } = session.current;
    try {
      const result = await api(path, value);
      if (generation !== session.current.generation) return false;
      const confirmation =
        typeof success === "function"
          ? success(createdMachine(result, String(record(value).id)))
          : success;
      if (isCreate) {
        setCreate(null);
        location.hash = "machines";
        setView("machines");
      }
      setMessage(confirmation);
      await refresh();
      return true;
    } catch (e) {
      if (generation !== session.current.generation) return false;
      if (statusCode(e) === 401)
        signOut("Your session ended. Sign in again to continue.");
      else {
        setActionError(errorMessage(e));
        if (isCreate) throw e;
      }
      return false;
    } finally {
      if (generation === session.current.generation) {
        acting.current = false;
        setBusy(false);
      }
    }
  }
  function lifecycle(m: Machine) {
    if (m.desired === "running") {
      stopTrigger.current = document.activeElement;
      setStop(m);
    } else
      mutate(
        `machines/${m.id}/desired`,
        { state: "running" },
        `Start requested for ${m.name}. Waiting for the host to report its state.`,
      );
  }
  const templates = templatesFor(inventory.templates);
  function openCreate(t?: GroupedImage, desktop = false) {
    if (!busy) {
      setActionError("");
      setCreate({
        templates: t?.blueprintId
          ? [t]
          : templates.filter(
              (item) => eligible(item) && (!desktop || desktopImage(item)),
            ),
        selected: t,
        returnFocus: document.activeElement,
        desktop,
      });
    }
  }
  const detail = inventory.machines.find((m) => m.id === detailId);
  const resourcePage = isInfrastructure && infrastructureId;
  const resourceHost = infrastructureHosts.find(
    (host) => host.id === infrastructureId,
  );
  const locationLabel = resourcePage
    ? `${resourceHost?.name || "Overview"} · ${destinations[view].label}`
    : destinations[view].label;
  const routeKey = infrastructureId ? `${view}/${infrastructureId}` : view;
  const previousRoute = useRef(routeKey);
  useEffect(() => {
    document.title = `Canaveral · ${locationLabel}`;
  }, [locationLabel]);
  useEffect(() => {
    if (previousRoute.current === routeKey) return;
    previousRoute.current = routeKey;
    const content = document.getElementById("workspace-content");
    if (!content) return;
    document.documentElement.scrollTop = 0;
    content.focus({ preventScroll: true });
  }, [routeKey]);
  if (claim)
    return (
      <ClaimScreen
        token={claim}
        onDone={() => {
          setClaim(null);
          loadAuth();
        }}
      />
    );
  if (!user)
    return (
      <LoginScreen
        auth={auth}
        busy={busy}
        error={authError}
        onSubmit={login}
        onRetry={loadAuth}
      />
    );
  const matches = (values: Array<string | undefined>) =>
    values.join(" ").toLowerCase().includes(query.trim().toLowerCase());
  const machineItems = inventory.machines.filter(
    (m) =>
      matches([
        m.name,
        m.id,
        m.templateId,
        hostName(m.hostId),
        m.template.os,
        m.template.arch,
        m.template.mode,
        ownerLabel(m, directory.data ?? []),
      ]) &&
      (user.role !== "admin" ||
        owner === "all" ||
        (owner === "none" ? m.ownerId === null : m.ownerId === owner)) &&
      matchesMachineState(m, filter),
  );
  const hostItems = infrastructureHosts.filter(
    (h) =>
      matches([h.name, h.id, provider(h.provider)]) &&
      (filter === "all" ||
        (filter === "online"
          ? h.online
          : filter === "offline"
            ? !h.online
            : !h.enabled)),
  );
  const imageItems = templates.filter(
    (t) =>
      matches([t.id, t.name, t.revision, t.os, t.arch, t.mode]) &&
      (filter === "all" || t.mode === filter),
  );
  const items =
    view === "machines"
      ? machineItems
      : isInfrastructure
        ? hostItems
        : imageItems;
  const total =
    view === "templates"
      ? templates.length
      : isInfrastructure
        ? infrastructureHosts.length
        : inventory.machines.length;
  const viewFilters = Object.hasOwn(views, view)
    ? views[view as keyof typeof views].filters
    : [];
  const filters = viewFilters.map((value) => ({
    value,
    label: filterLabel(value),
  }));
  if (view === "machines" && !views.machines.filters.includes(filter)) {
    filters.push({ value: filter, label: filterLabel(filter) });
  }
  return (
    <SidebarProvider>
      <a
        href="#workspace-content"
        onClick={(e) => {
          e.preventDefault();
          document.getElementById("workspace-content")?.focus();
        }}
        className="sr-only z-50 rounded-sm bg-primary px-4 py-2 text-primary-foreground focus:not-sr-only focus:fixed focus:left-4 focus:top-4"
      >
        Skip to content
      </a>
      <WorkspaceSidebar
        view={view}
        counts={
          loaded && !stale
            ? {
                machines: inventory.machines.length,
                hosts: inventory.hosts.filter(
                  (h) => infrastructureKind(h) === "host",
                ).length,
                orchestrators: inventory.hosts.filter(
                  (h) => infrastructureKind(h) === "orchestrator",
                ).length,
              }
            : {}
        }
        user={user}
        onSignOut={() => signOut()}
      />
      <SidebarInset className="min-w-0 md:rounded-sm">
        <header
          className={`sticky top-0 z-10 flex shrink-0 items-center gap-2 border-b px-4 lg:px-6 ${view === "hosts" && !resourcePage ? "min-h-14 flex-wrap py-2" : "h-14"}`}
        >
          <SidebarTrigger className="-ml-1" />
          <Separator
            orientation="vertical"
            className="mx-2 data-[orientation=vertical]:h-4"
          />
          <Breadcrumb>
            <BreadcrumbList>
              <BreadcrumbItem className="hidden sm:block">
                {destinations[view].group}
              </BreadcrumbItem>
              <BreadcrumbSeparator className="hidden sm:block" />
              <BreadcrumbItem>
                {resourcePage ? (
                  <BreadcrumbLink href={destinations[view].href}>
                    {destinations[view].label}
                  </BreadcrumbLink>
                ) : (
                  <BreadcrumbPage>{destinations[view].label}</BreadcrumbPage>
                )}
              </BreadcrumbItem>
              {resourcePage && (
                <>
                  <BreadcrumbSeparator />
                  <BreadcrumbItem>
                    <BreadcrumbPage className="block max-w-[28vw] truncate">
                      {resourceHost?.name || "Overview"}
                    </BreadcrumbPage>
                  </BreadcrumbItem>
                </>
              )}
            </BreadcrumbList>
          </Breadcrumb>
          <div className="ml-auto flex max-w-full flex-wrap items-center justify-end gap-2">
            {view === "hosts" && !resourcePage && (
              <>
                <Button
                  size="sm"
                  onClick={() => setConnectionSetup("host")}
                  disabled={busy}
                >
                  <Plus />
                  Add host
                </Button>
              </>
            )}
            {view !== "admin" && (
              <Button
                variant="ghost"
                size="icon-sm"
                className="size-11 md:size-8"
                aria-label={stale ? "Retry connection" : "Refresh"}
                title={stale ? "Retry connection" : "Refresh"}
                onClick={() => {
                  void refresh();
                  void directory.refresh();
                }}
              >
                <RefreshCw />
              </Button>
            )}
          </div>
        </header>
        <div
          id="workspace-content"
          tabIndex={-1}
          className="flex min-w-0 flex-1 flex-col gap-3 px-4 py-4 outline-none md:gap-4 md:py-5 lg:gap-5 lg:px-6"
        >
          {view === "system" && user.role === "admin" ? (
            <SystemControl
              key={user.id}
              user={user}
              onDenied={() => {
                void signOut(
                  "Administrator access ended. Sign in again to continue.",
                );
              }}
            />
          ) : view === "configuration" && user.role === "admin" ? (
            <ApiWorkspace
              key={user.id}
              user={user}
              onDenied={() => {
                void signOut(
                  "Administrator access ended. Sign in again to continue.",
                );
              }}
            />
          ) : view === "admin" && user.role === "admin" ? (
            <AdminOverview
              key={user.id}
              user={user}
              inventory={inventory}
              loaded={loaded}
              stale={stale}
              directory={directory}
              onDenied={() => {
                void signOut(
                  "Administrator access ended. Sign in again to continue.",
                );
              }}
              onInspect={(id) => {
                detailTrigger.current = document.activeElement;
                setDetailId(id);
              }}
              onRefresh={() => {
                void refresh();
              }}
            />
          ) : view === "api-access" && user.role === "admin" ? (
            <AdminTokensPage
              key={user.id}
              user={user}
              directory={directory}
              onDenied={() => {
                void signOut(
                  "Administrator access ended. Sign in again to continue.",
                );
              }}
            />
          ) : view === "account" ? (
            <AccountPage
              user={user}
              onChanged={() =>
                signOut("Password changed. Sign in with your new password.")
              }
            />
          ) : view === "tokens" ? (
            <TokensPage user={user} />
          ) : view === "users" && user.role === "admin" ? (
            <UsersPage
              key={user.id}
              user={user}
              machines={loaded && !stale ? inventory.machines : undefined}
              onDenied={() => {
                void signOut(
                  "Administrator access ended. Sign in again to continue.",
                );
              }}
            />
          ) : view === "builds" ? (
            <WorkspaceBuilds key={user.id} />
          ) : view === "previews" ? (
            <WorkspacePreviews key={user.id} />
          ) : view === "models" && user.role === "admin" ? (
            <ModelRuns
              key={user.id}
              onDenied={() => {
                void signOut(
                  "Administrator access ended. Sign in again to continue.",
                );
              }}
            />
          ) : view === "blueprints" ? (
            <>
              <Notice error>{stale}</Notice>
              <MachineBlueprints
                key={user.id}
                sources={templates}
                admin={user.role === "admin"}
                inventoryAvailable={loaded && !stale}
                onCreate={openCreate}
              />
            </>
          ) : resourcePage ? (
            <>
              <div className="min-w-0 space-y-2">
                <a
                  href={`#${view}`}
                  className="text-xs text-muted-foreground underline-offset-4 hover:underline"
                >
                  Back to {view}
                </a>
                <h1 className="break-words font-display text-3xl font-medium tracking-tight">
                  {resourceHost?.name || "Resources"}
                </h1>
                <p className="text-sm text-muted-foreground">
                  {resourceHost
                    ? `${provider(resourceHost.platform || resourceHost.provider)} · ${(resourceHost.runtimes || []).map(provider).join(" · ") || (view === "hosts" ? "Direct host" : "Orchestrator pool")}`
                    : "Host overview"}
                </p>
              </div>
              <Notice error>{stale}</Notice>
              <Notice>{message}</Notice>
              <Notice error>{actionError}</Notice>
              {resourceHost ? (
                <InfrastructureDetails
                  key={resourceHost.id}
                  host={resourceHost}
                  machines={inventory.machines.filter(
                    (m) => m.hostId === resourceHost.id,
                  )}
                  onInspect={(id) => {
                    detailTrigger.current = document.activeElement;
                    setDetailId(id);
                  }}
                  onControl={setControlId}
                  onRefresh={refresh}
                />
              ) : (
                <Empty>
                  <EmptyHeader>
                    <EmptyTitle>
                      {loaded ? "Connection not found" : "Loading resources…"}
                    </EmptyTitle>
                    <EmptyDescription>
                      {loaded
                        ? "This connection is no longer in the inventory."
                        : "Fetching the current host inventory."}
                    </EmptyDescription>
                  </EmptyHeader>
                  <EmptyContent>
                    <Button asChild variant="outline">
                      <a href={`#${view}`}>Back to {view}</a>
                    </Button>
                  </EmptyContent>
                </Empty>
              )}
            </>
          ) : (
            <>
              {view === "hosts" ? (
                <h1 className="sr-only">Hosts</h1>
              ) : (
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="space-y-1">
                    <h1 className="font-display text-3xl font-medium tracking-tight">
                      {title(view)}
                    </h1>
                    <p className="sr-only">
                      {view === "machines"
                        ? user.role === "admin"
                          ? "Manage every user's machines and their lifecycle."
                          : "Manage your machines and their lifecycle."
                        : isInfrastructure
                          ? "Connect infrastructure, verify capabilities and track resources."
                          : "Downloaded OS originals, separate from prepared machine snapshots."}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {view === "machines" && (
                      <Button
                        variant="outline"
                        className="max-sm:size-8 max-sm:px-0"
                        onClick={() => openCreate(undefined, true)}
                        disabled={busy}
                      >
                        <Monitor />
                        <span className="max-sm:sr-only">Launch desktop</span>
                      </Button>
                    )}
                    {view === "templates" && user.role === "admin" && (
                      <Button
                        variant="outline"
                        onClick={() => setRegistryOpen(true)}
                      >
                        Base image registry
                      </Button>
                    )}
                    {view === "templates" && user.role === "admin" && (
                      <Button onClick={() => setImageImport(true)}>
                        Import image
                      </Button>
                    )}
                    <Button
                      variant={view === "templates" ? "ghost" : "default"}
                      className={
                        view === "machines"
                          ? "max-sm:px-2.5 max-sm:text-xs"
                          : undefined
                      }
                      onClick={() =>
                        isInfrastructure
                          ? setConnectionSetup(
                              view === "orchestrators"
                                ? "orchestrator"
                                : "host",
                            )
                          : view === "templates"
                            ? (location.hash = "blueprints")
                            : openCreate()
                      }
                      disabled={busy}
                    >
                      {view === "templates" ? <ArrowUpRight /> : <Plus />}
                      {isInfrastructure ? (
                        view === "orchestrators" ? (
                          "Add orchestrator"
                        ) : (
                          "Add host"
                        )
                      ) : view === "templates" ? (
                        "Machine blueprints"
                      ) : (
                        <>
                          Create
                          <span className="max-sm:sr-only"> machine</span>
                        </>
                      )}
                    </Button>
                  </div>
                </div>
              )}
              <Notice error>{stale}</Notice>
              <Notice>{message}</Notice>
              <Notice error>{actionError}</Notice>
              {view === "machines" &&
                user.role === "admin" &&
                directory.error && (
                  <Notice error>
                    {directory.data
                      ? "Showing the last available owner names. Refresh to try again."
                      : "Owner names unavailable. Refresh to try again."}
                  </Notice>
                )}
              {view === "machines" && (
                <FleetPulse
                  inventory={inventory}
                  loaded={loaded}
                  stale={Boolean(stale)}
                  showHosts={user.role === "admin"}
                  activeFilter={!query && owner === "all" ? filter : undefined}
                  onSelectState={(state) => {
                    setFilter(state);
                    setQuery("");
                    setOwner("all");
                  }}
                />
              )}
              {view !== "templates" && (
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="grid w-full min-w-0 grid-cols-2 gap-2 md:flex md:w-auto md:flex-wrap">
                    <InputGroup className="col-span-2 h-10 w-full bg-card md:h-9 md:w-56 xl:w-64">
                      <InputGroupInput
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        aria-label={`Search ${view}`}
                        placeholder={`Search ${view}…`}
                      />
                      <InputGroupAddon>
                        <Search />
                      </InputGroupAddon>
                    </InputGroup>
                    {view === "machines" && (
                      <select
                        aria-label="Machine state"
                        className="h-10 w-full min-w-0 rounded-md border border-input bg-card px-2 text-sm md:hidden"
                        value={filter}
                        onChange={(e) => setFilter(e.target.value)}
                      >
                        {filters.map(({ value, label }) => (
                          <option key={value} value={value}>
                            {value === "all" ? "All states" : label}
                          </option>
                        ))}
                      </select>
                    )}
                    {view === "machines" && user.role === "admin" && (
                      <select
                        aria-label="Machine owner"
                        className="h-10 min-w-0 rounded-md border border-input bg-card px-2 text-sm md:h-9 md:max-w-44"
                        value={owner}
                        onChange={(e) => setOwner(e.target.value)}
                      >
                        <option value="all">All owners</option>
                        <option value="none">No user owner</option>
                        {(directory.data ?? []).map((u) => (
                          <option key={u.id} value={u.id}>
                            {u.username}
                          </option>
                        ))}
                      </select>
                    )}
                  </div>
                  <ToggleGroup
                    className={`max-w-full flex-wrap rounded-md border bg-muted p-0.5 ${view === "machines" ? "hidden md:flex" : ""}`}
                    type="single"
                    value={filter}
                    onValueChange={(value) => {
                      if (value) setFilter(value);
                    }}
                    size="sm"
                    spacing={1}
                    aria-label="Filter inventory"
                  >
                    {filters.map(({ value, label }) => (
                      <ToggleGroupItem
                        className="rounded-md text-muted-foreground data-[state=on]:bg-card data-[state=on]:text-foreground data-[state=on]:shadow-xs"
                        key={value}
                        value={value}
                      >
                        {label}
                      </ToggleGroupItem>
                    ))}
                  </ToggleGroup>
                </div>
              )}
              {view !== "templates" &&
                items.length > 0 &&
                (query || filter !== "all" || owner !== "all") && (
                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                    <span className="text-muted-foreground" role="status">
                      {items.length} of {total} {view} ·{" "}
                      {filter === "all" ? "All states" : filterLabel(filter)}
                      {query ? ` · “${query}”` : ""}
                    </span>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setQuery("");
                        setFilter("all");
                        setOwner("all");
                      }}
                    >
                      Clear filters
                    </Button>
                  </div>
                )}
              {view === "templates" && user.role === "admin" && (
                <ImageActivity onRefresh={refresh} />
              )}
              <section
                className={
                  !items.length
                    ? "min-w-0 overflow-hidden rounded-md border bg-card"
                    : "min-w-0"
                }
                aria-label={`${title(view)} inventory`}
              >
                {view === "templates" ? (
                  <ImageLibrary
                    key={user.id}
                    sources={templates}
                    admin={user.role === "admin"}
                    onBlueprint={setBlueprintSource}
                  />
                ) : !loaded ? (
                  <Empty className="min-h-80">
                    <EmptyHeader>
                      <EmptyMedia variant="icon">
                        <Orbit />
                      </EmptyMedia>
                      <EmptyTitle
                        className="font-display text-xl font-medium"
                        role="heading"
                        aria-level={2}
                      >
                        {stale
                          ? "Awaiting connection"
                          : "Contacting your control plane…"}
                      </EmptyTitle>
                      <EmptyDescription>
                        {stale
                          ? "Retry the connection to load your inventory."
                          : "Fetching machines, hosts and images."}
                      </EmptyDescription>
                    </EmptyHeader>
                  </Empty>
                ) : !items.length ? (
                  <Empty className="min-h-80">
                    <EmptyHeader>
                      <EmptyMedia variant="icon">
                        <Rocket />
                      </EmptyMedia>
                      <EmptyTitle
                        className="font-display text-xl font-medium"
                        role="heading"
                        aria-level={2}
                      >
                        {total ? `No matching ${view}` : `No ${view} yet`}
                      </EmptyTitle>
                      <EmptyDescription>
                        {total
                          ? "Try a different filter or search term."
                          : view === "machines"
                            ? "Create a machine from an image available on one of your hosts."
                            : isInfrastructure
                              ? "Add a connection setup, run its environment checks, then connect the runner."
                              : "Install a base image on a host, then register it with Canaveral."}
                      </EmptyDescription>
                    </EmptyHeader>
                    {total > 0 && (
                      <EmptyContent>
                        <Button
                          variant="outline"
                          onClick={() => {
                            setQuery("");
                            setFilter("all");
                            setOwner("all");
                          }}
                        >
                          Clear filters
                        </Button>
                      </EmptyContent>
                    )}
                    {view === "machines" && !total && (
                      <EmptyContent>
                        <Button
                          variant="outline"
                          onClick={() => openCreate()}
                          disabled={busy}
                        >
                          <Plus />
                          Create your first machine
                        </Button>
                      </EmptyContent>
                    )}
                  </Empty>
                ) : view === "machines" ? (
                  <MachineInventory
                    machines={machineItems}
                    hosts={inventory.hosts}
                    users={directory.data ?? []}
                    admin={user.role === "admin"}
                    busy={busy}
                    onInspect={(id, trigger) => {
                      detailTrigger.current = trigger;
                      setDetailId(id);
                    }}
                    onControl={setControlId}
                    onLifecycle={lifecycle}
                    onCapture={(id, trigger) => {
                      operationTrigger.current = trigger;
                      setCaptureId(id);
                    }}
                    onPowerOff={(id, trigger) => {
                      operationTrigger.current = trigger;
                      setPowerOffId(id);
                    }}
                    onDelete={(id, trigger) => {
                      operationTrigger.current = trigger;
                      setDeleteId(id);
                    }}
                  />
                ) : isInfrastructure ? (
                  <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
                    {hostItems.map((h) => (
                      <InfrastructureCard
                        key={h.id}
                        host={h}
                        busy={busy}
                        mutate={(path, value, message) =>
                          mutate(path, value, message).then(() => {})
                        }
                        resourcesHref={`#${view}/${encodeURIComponent(h.id)}`}
                      />
                    ))}
                  </div>
                ) : null}
              </section>
              {loaded && view !== "templates" && (
                <p className="text-xs text-muted-foreground" role="status">
                  {items.length} of {total} {view}
                </p>
              )}
            </>
          )}
        </div>
      </SidebarInset>
      {blueprintSource && user.role === "admin" && (
        <BlueprintEditor
          sources={templates.filter((t) => t.mode !== "device")}
          previous={null}
          initialSource={blueprintSource}
          onClose={() => setBlueprintSource(null)}
          onSaved={() => {
            setBlueprintSource(null);
            location.hash = "blueprints";
          }}
        />
      )}
      {imageImport && (
        <ImageImport
          preset={typeof imageImport === "object" ? imageImport : null}
          hosts={inventory.hosts}
          onClose={() => setImageImport(false)}
          onRefresh={refresh}
        />
      )}
      {powerOffId && inventory.machines.some((m) => m.id === powerOffId) && (
        <MachinePowerOff
          machine={inventory.machines.find((m) => m.id === powerOffId)!}
          returnFocus={operationTrigger.current}
          onClose={() => setPowerOffId(null)}
          onRefresh={refresh}
        />
      )}
      {deleteId && inventory.machines.some((m) => m.id === deleteId) && (
        <MachineDelete
          machine={inventory.machines.find((m) => m.id === deleteId)!}
          requestId={(() => {
            const id = deleteId;
            if (!deleteIntents.current.has(id))
              deleteIntents.current.set(id, crypto.randomUUID());
            return deleteIntents.current.get(id)!;
          })()}
          returnFocus={operationTrigger.current}
          onClose={() => setDeleteId(null)}
          onRequested={async (receipt) => {
            const name =
              inventory.machines.find((m) => m.id === receipt.machineId)
                ?.name ?? "Machine";
            if (receipt.state === "complete")
              setMessage(`${name} deleted. The host confirmed removal.`);
            else deleting.current.set(receipt.machineId, name);
            await refresh();
          }}
        />
      )}
      {registryOpen && (
        <BaseImageRegistry
          hosts={inventory.hosts}
          onClose={() => setRegistryOpen(false)}
          onRefresh={refresh}
          onImportFile={(entry) => {
            setRegistryOpen(false);
            setImageImport(entry);
          }}
        />
      )}
      {captureId && inventory.machines.some((m) => m.id === captureId) && (
        <ImageCapture
          machine={inventory.machines.find((m) => m.id === captureId)!}
          returnFocus={operationTrigger.current}
          onClose={() => setCaptureId(null)}
          onRefresh={refresh}
        />
      )}
      {connectionSetup && (
        <ConnectionSetup
          initialKind={connectionSetup}
          hosts={inventory.hosts}
          onClose={() => setConnectionSetup(null)}
          onRefresh={refresh}
        />
      )}
      {create && (
        <CreateMachine
          config={create}
          busy={busy}
          hostName={hostName}
          onClose={() => setCreate(null)}
          onSubmit={(spec) =>
            mutate(
              "machines",
              spec,
              (m) =>
                create.desktop
                  ? `${m.name} is starting on ${hostName(m.hostId)}. Open its desktop with Control once it shows Ready.`
                  : `${m.name} assigned to ${hostName(m.hostId)}. Waiting for the host to report its state.`,
              true,
            )
          }
        />
      )}
      {controlId && inventory.machines.find((m) => m.id === controlId) && (
        <MachineControl
          machine={inventory.machines.find((m) => m.id === controlId)!}
          onClose={() => setControlId(null)}
        />
      )}
      <Dialog
        open={!!detail}
        onOpenChange={(open) => {
          if (!open) setDetailId(null);
        }}
      >
        <DialogContent
          className="max-h-[calc(100svh-2rem)] overflow-y-auto"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            focus(detailTrigger.current);
          }}
        >
          <DialogHeader>
            <DialogTitle>{detail?.name}</DialogTitle>
            <DialogDescription className="sr-only">
              Machine details
            </DialogDescription>
          </DialogHeader>
          {detail && (
            <>
              <dl className="grid divide-y">
                {(
                  [
                    ["State", <Status text={machineStatus(detail)} />],
                    ["Requested", title(detail.desired)],
                    ["Preparation", detail.preparation.state],
                    ["Host", hostName(detail.hostId)],
                    [
                      "Image",
                      `${detail.templateId} · ${detail.template.revision}`,
                    ],
                    [
                      "Computer",
                      `${detail.template.os} · ${detail.template.arch} · ${detail.template.mode}`,
                    ],
                    [
                      "Resources",
                      `${detail.resources.cpu} vCPU · ${memory(detail.resources.memoryMiB)} · ${detail.resources.diskGiB} GiB disk`,
                    ],
                    ["Updated", since(detail.updatedAt)],
                    ["Machine ID", detail.id],
                  ] satisfies Array<[string, ReactNode]>
                ).map(([k, v]) => (
                  <div
                    key={k}
                    className="grid grid-cols-[6rem_1fr] gap-4 py-3 text-sm"
                  >
                    <dt className="text-muted-foreground">{k}</dt>
                    <dd className="min-w-0 break-words">{v}</dd>
                  </div>
                ))}
              </dl>
              {user.role === "admin" && (
                <p className="text-sm text-muted-foreground">
                  Owner: {ownerLabel(detail, directory.data ?? [])}
                  {detail.ownerId === null &&
                    ". Admin-only inventory. This may be operator-created or managed by an application lease."}
                </p>
              )}
              {!stale && mobileInstallEligible(detail, user.id) && (
                <MobileInstall
                  key={JSON.stringify([
                    detail.id,
                    detail.hostId,
                    detail.ownerId,
                    detail.template.os,
                  ])}
                  machine={detail}
                />
              )}
              {/* A transient refresh failure must not cancel a running recording;
                  the controller and gateway still authorize every capture. */}
              {mobileInstallEligible(detail, user.id) && (
                <MobileCapture
                  key={JSON.stringify([
                    "capture",
                    detail.id,
                    detail.hostId,
                    detail.ownerId,
                    detail.template.os,
                  ])}
                  machine={detail}
                />
              )}
              {detail.detail && <p className="text-sm">{detail.detail}</p>}
              <Notice error>{actionError}</Notice>
              <DialogFooter>
                <Button variant="outline" onClick={() => setDetailId(null)}>
                  Close
                </Button>
                <Button
                  disabled={busy || !!detail.powerOffRequest}
                  onClick={() => lifecycle(detail)}
                >
                  {detail.desired === "running"
                    ? "Stop machine"
                    : "Start machine"}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
      <AlertDialog
        open={!!stop}
        onOpenChange={(open) => {
          if (!open) setStop(null);
        }}
      >
        <AlertDialogContent
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            focus(stopTrigger.current);
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>Stop {stop?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Request a graceful shutdown. Its disk and assigned host will be
              retained. The host must confirm that it has stopped.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={() => {
                const m = stop;
                if (!m) return;
                setStop(null);
                mutate(
                  `machines/${m.id}/desired`,
                  { state: "stopped" },
                  `Stop requested for ${m.name}. Its disk will be retained.`,
                );
              }}
            >
              Request stop
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SidebarProvider>
  );
}

function iosRuntime(template: GroupedImage) {
  return template.os === "ios" ? template.device?.runtime : undefined;
}

function CreateMachine({
  config,
  busy,
  hostName,
  onClose,
  onSubmit,
}: {
  config: CreateConfig;
  busy: boolean;
  hostName: (id: string) => string;
  onClose: () => void;
  onSubmit: (spec: CreateSpec) => Promise<boolean>;
}) {
  const initial = Math.max(
    0,
    config.templates.findIndex(
      (t) =>
        t.id === config.selected?.id &&
        t.revision === config.selected?.revision &&
        t.arch === config.selected?.arch,
    ),
  );
  const [index, setIndex] = useState(String(initial)),
    [error, setError] = useState(""),
    [retry, setRetry] = useState(false);
  const [placement, setPlacement] = useState("automatic");
  const intent = useRef<{ signature: string; id: string } | null>(null),
    template = config.templates[Number(index)];
  const defaults = template?.defaults || template?.minimum;
  function changed() {
    intent.current = null;
    setRetry(false);
  }
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!template || busy) return;
    const data = new FormData(e.currentTarget);
    const spec: Omit<CreateSpec, "id"> = {
      name: String(data.get("name") ?? "").trim(),
      ...(template.blueprintId
        ? {
            blueprintId: template.blueprintId,
            blueprintRevision: template.blueprintRevision,
          }
        : {
            templateId: template.id,
            templateRevision: template.revision,
            arch: template.arch,
          }),
      resources: {
        cpu: Number(data.get("cpu")),
        memoryMiB: Number(data.get("memory")),
        diskGiB: Number(data.get("disk")),
      },
    };
    if (!spec.name) {
      setError("Enter a machine name.");
      return;
    }
    if (placement !== "automatic") spec.hostId = placement;
    const signature = JSON.stringify(spec);
    if (!intent.current || intent.current.signature !== signature)
      intent.current = { signature, id: crypto.randomUUID() };
    setError("");
    try {
      await onSubmit({ id: intent.current.id, ...spec });
    } catch (err) {
      setError(errorMessage(err));
      setRetry(true);
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
        className="max-h-[calc(100svh-2rem)] overflow-y-auto"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          focus(config.returnFocus);
        }}
        onEscapeKeyDown={(event) => {
          if (busy) event.preventDefault();
        }}
        onPointerDownOutside={(event) => {
          if (busy) event.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>
            {config.desktop ? "Launch a Linux desktop" : "Create a machine"}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {config.desktop
              ? "Choose a desktop image and its size."
              : "Choose a source, resources and placement."}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} onChange={changed} className="space-y-6">
          <FieldSet disabled={busy}>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="machine-name">Machine name</FieldLabel>
                <Input
                  id="machine-name"
                  name="name"
                  maxLength={100}
                  placeholder={
                    config.desktop
                      ? "e.g. review-desktop"
                      : "e.g. development-workspace"
                  }
                  autoComplete="off"
                  required
                  autoFocus
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="machine-template">
                  {template?.blueprintId
                    ? "Machine blueprint"
                    : config.desktop
                      ? "Desktop image"
                      : template?.os === "ios"
                        ? "iOS simulator template"
                        : "Base image"}
                </FieldLabel>
                <Select
                  value={index}
                  onValueChange={(v) => {
                    setIndex(v);
                    setPlacement("automatic");
                    changed();
                  }}
                  disabled={!template || busy}
                >
                  <SelectTrigger
                    id="machine-template"
                    className="w-full"
                    aria-describedby={template ? "template-summary" : undefined}
                  >
                    <SelectValue placeholder="No eligible images" />
                  </SelectTrigger>
                  <SelectContent>
                    {config.templates.map((t, i) => (
                      <SelectItem key={i} value={String(i)}>
                        {t.name || t.id} · {t.revision} · {t.arch}
                        {iosRuntime(t) && ` · ${iosRuntime(t)}`}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {template && (
                  <FieldDescription id="template-summary">
                    {template.os} · {title(template.mode)}
                    {iosRuntime(template) && ` · ${iosRuntime(template)}`} ·
                    Minimum {template.minimum.cpu} vCPU,{" "}
                    {memory(template.minimum.memoryMiB)},{" "}
                    {template.minimum.diskGiB} GiB disk
                  </FieldDescription>
                )}
              </Field>
              {template ? (
                <>
                  <FieldGroup
                    className="grid grid-cols-1 gap-4 sm:grid-cols-3"
                    key={index}
                  >
                    {(
                      [
                        ["cpu", "vCPUs", "cpu"],
                        ["memory", "Memory · MiB", "memoryMiB"],
                        ["disk", "Disk · GiB", "diskGiB"],
                      ] as const
                    ).map(([name, label, key]) => (
                      <Field key={name}>
                        <FieldLabel htmlFor={`resource-${name}`}>
                          {label}
                        </FieldLabel>
                        <Input
                          id={`resource-${name}`}
                          name={name}
                          type="number"
                          required
                          min={
                            name === "memory"
                              ? Math.ceil(
                                  template.minimum[key] /
                                    (template.memoryStepMiB || 1),
                                ) * (template.memoryStepMiB || 1)
                              : template.minimum[key]
                          }
                          max={1048576}
                          step={
                            name === "memory" ? template.memoryStepMiB || 1 : 1
                          }
                          defaultValue={defaults?.[key]}
                        />
                      </Field>
                    ))}
                  </FieldGroup>
                  {!config.desktop && (
                    <Field>
                      <FieldLabel htmlFor="placement">Placement</FieldLabel>
                      <Select
                        value={placement}
                        onValueChange={(v) => {
                          setPlacement(v);
                          changed();
                        }}
                        disabled={busy}
                      >
                        <SelectTrigger id="placement" className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="automatic">
                            Automatic · any eligible host
                          </SelectItem>
                          {template.hosts
                            .filter((h) => h.online && h.accepting)
                            .map((h) => (
                              <SelectItem key={h.id} value={h.id}>
                                {hostName(h.id)}
                              </SelectItem>
                            ))}
                        </SelectContent>
                      </Select>
                    </Field>
                  )}
                </>
              ) : config.desktop ? (
                <Notice>
                  No online accepting host offers a Linux desktop image yet. Add
                  a desktop image to a host to launch one.
                </Notice>
              ) : (
                <Notice>
                  No online accepting host offers an image yet. Register or
                  enable a host to create a machine.
                </Notice>
              )}
              {error && <FieldError>{error}</FieldError>}
            </FieldGroup>
          </FieldSet>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={onClose}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!template || busy}>
              {busy
                ? config.desktop
                  ? "Launching…"
                  : "Creating…"
                : retry
                  ? "Retry request"
                  : config.desktop
                    ? "Launch desktop"
                    : "Create machine"}
              <ArrowUpRight />
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
