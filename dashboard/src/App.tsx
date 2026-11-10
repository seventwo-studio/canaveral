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
type View =
  | "machines"
  | "hosts"
  | "orchestrators"
  | "templates"
  | "account"
  | "tokens"
  | "users";
import { AccountPage, TokensPage, UsersPage } from "@/components/accounts";
import { ClaimScreen, takeClaim } from "@/components/claim-screen";
interface CreateConfig {
  templates: GroupedImage[];
  selected?: GroupedImage;
  returnFocus: Element | null;
}
interface CreateSpec {
  id: string;
  name: string;
  templateId: string;
  templateRevision: string;
  arch: string;
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
  Monitor,
  Server,
  Layers,
  ArrowUpRight,
  Plus,
  Search,
  RefreshCw,
  Orbit,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from "@/components/ui/card";
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
import { SharedBudgets } from "@/components/shared-budgets";
import { BaseImageRegistry } from "@/components/image-registry";
import { MachinePowerOff } from "@/components/machine-power";
import {
  ImageImport,
  ImageCapture,
  ImageActivity,
} from "@/components/image-actions";
import { MachineControl } from "@/components/machine-control";
import { LoginScreen } from "@/components/login-screen";
import { WorkspaceSidebar } from "@/components/workspace-sidebar";
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
    icon: Monitor,
    filters: ["all", "running", "stopped", "attention"],
  },
  hosts: {
    icon: Server,
    filters: ["all", "online", "offline", "draining"],
  },
  orchestrators: {
    icon: Orbit,
    filters: ["all", "online", "offline", "draining"],
  },
  templates: {
    icon: Layers,
    filters: ["all", "headless", "desktop", "device"],
  },
};
const currentView = (): View => {
  const name = location.hash.slice(1).split("/")[0] ?? "";
  return name === "images"
    ? "templates"
    : ["account", "tokens", "users"].includes(name) ||
        Object.hasOwn(views, name)
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
      <AlertDescription className="text-inherit">{children}</AlertDescription>
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
  const [controlId, setControlId] = useState<string | null>(null);
  const [connectionSetup, setConnectionSetup] = useState<
      "host" | "orchestrator" | null
    >(null),
    [infrastructureId, setInfrastructureId] = useState(currentInfrastructure);
  const [budgetOpen, setBudgetOpen] = useState(false);
  const [imageImport, setImageImport] = useState<boolean | RegistryEntry>(
      false,
    ),
    [captureId, setCaptureId] = useState<string | null>(null);
  const [registryOpen, setRegistryOpen] = useState(false);
  const [powerOffId, setPowerOffId] = useState<string | null>(null);
  const view: View =
    user?.role !== "admin" &&
    ["hosts", "orchestrators", "users"].includes(requestedView)
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
  const [create, setCreate] = useState<CreateConfig | null>(null),
    [detailId, setDetailId] = useState<string | null>(null),
    [stop, setStop] = useState<Machine | null>(null);
  const session = useRef({ active: false, generation: 0 }),
    refreshing = useRef<Promise<void> | null>(null),
    acting = useRef(false);
  const detailTrigger = useRef<Element | null>(null),
    stopTrigger = useRef<Element | null>(null);
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
    setBudgetOpen(false);
    setImageImport(false);
    setRegistryOpen(false);
    setPowerOffId(null);
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
    };
    window.addEventListener("hashchange", change);
    return () => window.removeEventListener("hashchange", change);
  }, []);
  useEffect(() => {
    document.title = `Canaveral · ${infrastructureId ? "Overview · " : ""}${title(view)}`;
  }, [view, infrastructureId]);
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
  function openCreate(t?: GroupedImage) {
    if (!busy) {
      setActionError("");
      setCreate({
        templates: templates.filter(eligible),
        selected: t,
        returnFocus: document.activeElement,
      });
    }
  }
  const detail = inventory.machines.find((m) => m.id === detailId);
  const resourcePage = isInfrastructure && infrastructureId;
  const resourceHost = infrastructureHosts.find(
    (host) => host.id === infrastructureId,
  );
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
      ]) &&
      (filter === "all" ||
        (filter === "attention" ? attention(m) : m.observed === filter)),
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
  return (
    <SidebarProvider>
      <WorkspaceSidebar
        views={
          user.role === "admin"
            ? views
            : { machines: views.machines, templates: views.templates }
        }
        view={view}
        counts={{
          machines: inventory.machines.length,
          hosts: inventory.hosts.filter((h) => infrastructureKind(h) === "host")
            .length,
          orchestrators: inventory.hosts.filter(
            (h) => infrastructureKind(h) === "orchestrator",
          ).length,
          templates: templates.length,
        }}
        user={user}
        onSignOut={() => signOut()}
      />
      <SidebarInset className="min-w-0 md:rounded-sm">
        <header
          className={`flex shrink-0 items-center gap-2 border-b px-4 lg:px-6 ${view === "hosts" && !resourcePage ? "min-h-14 flex-wrap py-2" : "h-14"}`}
        >
          <SidebarTrigger className="-ml-1" />
          <Separator
            orientation="vertical"
            className="mx-2 data-[orientation=vertical]:h-4"
          />
          <Breadcrumb>
            <BreadcrumbList>
              <BreadcrumbItem className="hidden sm:block">
                Workspace
              </BreadcrumbItem>
              <BreadcrumbSeparator className="hidden sm:block" />
              <BreadcrumbItem>
                {resourcePage ? (
                  <BreadcrumbLink href={`#${view}`}>
                    {title(view)}
                  </BreadcrumbLink>
                ) : (
                  <BreadcrumbPage>{title(view)}</BreadcrumbPage>
                )}
              </BreadcrumbItem>
              {resourcePage && (
                <>
                  <BreadcrumbSeparator />
                  <BreadcrumbItem>
                    <BreadcrumbPage>Overview</BreadcrumbPage>
                  </BreadcrumbItem>
                </>
              )}
            </BreadcrumbList>
          </Breadcrumb>
          <div className="ml-auto flex max-w-full flex-wrap items-center justify-end gap-2">
            {view === "hosts" && !resourcePage && (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setBudgetOpen(true)}
                >
                  Shared budgets
                </Button>
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
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={stale ? "Retry connection" : "Refresh"}
              onClick={refresh}
            >
              <RefreshCw />
            </Button>
          </div>
        </header>
        <div className="flex min-w-0 flex-1 flex-col gap-6 px-4 py-6 lg:px-6">
          {view === "account" ? (
            <AccountPage
              user={user}
              onChanged={() =>
                signOut("Password changed. Sign in with your new password.")
              }
            />
          ) : view === "tokens" ? (
            <TokensPage user={user} />
          ) : view === "users" && user.role === "admin" ? (
            <UsersPage />
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
                <div className="flex flex-wrap items-center justify-between gap-4">
                  <div className="space-y-1">
                    <h1 className="font-display text-3xl font-medium tracking-tight">
                      {title(view)}
                    </h1>
                    <p className="text-sm text-muted-foreground">
                      {view === "machines"
                        ? "Manage your machines and their lifecycle."
                        : isInfrastructure
                          ? "Connect infrastructure, verify capabilities and track resources."
                          : "Base images available on your hosts."}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {view === "templates" && user.role === "admin" && (
                      <Button
                        variant="outline"
                        onClick={() => setRegistryOpen(true)}
                      >
                        Base image registry
                      </Button>
                    )}
                    {view === "templates" && user.role === "admin" && (
                      <Button
                        variant="outline"
                        onClick={() => setImageImport(true)}
                      >
                        Import image
                      </Button>
                    )}
                    {isInfrastructure && (
                      <Button
                        variant="outline"
                        onClick={() => setBudgetOpen(true)}
                      >
                        Shared budgets
                      </Button>
                    )}
                    <Button
                      onClick={() =>
                        isInfrastructure
                          ? setConnectionSetup(
                              view === "orchestrators"
                                ? "orchestrator"
                                : "host",
                            )
                          : openCreate()
                      }
                      disabled={busy}
                    >
                      <Plus />
                      {isInfrastructure
                        ? view === "orchestrators"
                          ? "Add orchestrator"
                          : "Add host"
                        : "Create machine"}
                    </Button>
                  </div>
                </div>
              )}
              <Notice error>{stale}</Notice>
              <Notice>{message}</Notice>
              <Notice error>{actionError}</Notice>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <ToggleGroup
                  className="max-w-full flex-wrap rounded-sm border bg-muted p-1"
                  type="single"
                  value={filter}
                  onValueChange={(value) => {
                    if (value) setFilter(value);
                  }}
                  size="sm"
                  spacing={1}
                  aria-label="Filter inventory"
                >
                  {views[view as keyof typeof views].filters.map((f) => (
                    <ToggleGroupItem
                      className="rounded-md text-muted-foreground data-[state=on]:bg-background data-[state=on]:text-foreground data-[state=on]:shadow-sm"
                      key={f}
                      value={f}
                    >
                      {f === "all"
                        ? "All"
                        : f === "attention"
                          ? "Needs attention"
                          : title(f)}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
                <div className="flex w-full items-center gap-2 sm:ml-auto sm:w-auto">
                  <InputGroup className="w-full sm:w-64">
                    <InputGroupInput
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      aria-label={`Search ${view === "templates" ? "images" : view}`}
                      placeholder={`Search ${view === "templates" ? "images" : view}…`}
                    />
                    <InputGroupAddon>
                      <Search />
                    </InputGroupAddon>
                  </InputGroup>
                </div>
              </div>
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
                {!loaded ? (
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
                        {total
                          ? `No matching ${view === "templates" ? "images" : view}`
                          : `No ${view === "templates" ? "images" : view} yet`}
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
                  <div className="grid min-w-0 grid-cols-[repeat(auto-fit,minmax(min(100%,24rem),1fr))] gap-4">
                    {machineItems.map((m) => (
                      <Card
                        key={m.id}
                        data-machine-id={m.id}
                        className="min-w-0 rounded-md shadow-none"
                      >
                        <CardHeader className="min-w-0">
                          <div className="flex min-w-0 items-start gap-3">
                            <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                              <Monitor size={18} />
                            </span>
                            <div className="min-w-0 flex-1">
                              <CardTitle className="min-w-0 font-display text-xl font-medium tracking-tight">
                                <Button
                                  variant="link"
                                  className="h-auto max-w-full justify-start whitespace-normal p-0 text-left text-xl text-foreground [overflow-wrap:anywhere]"
                                  onClick={(event) => {
                                    detailTrigger.current = event.currentTarget;
                                    setDetailId(m.id);
                                  }}
                                >
                                  {m.name}
                                </Button>
                              </CardTitle>
                              <CardDescription className="[overflow-wrap:anywhere]">
                                {m.template.os} · {m.template.arch}
                              </CardDescription>
                            </div>
                          </div>
                          <div className="flex flex-wrap items-center gap-2">
                            <Status text={machineStatus(m)} />
                            {m.desired !== m.observed &&
                              !["error", "unknown"].includes(m.observed) && (
                                <span className="text-xs text-muted-foreground">
                                  {m.desired === "running" ? "Start" : "Stop"}{" "}
                                  requested
                                </span>
                              )}
                          </div>
                        </CardHeader>
                        <CardContent className="min-w-0">
                          <dl className="grid min-w-0 grid-cols-2 gap-4 text-sm">
                            <div className="min-w-0">
                              <dt className="mb-1 text-xs text-muted-foreground">
                                Image
                              </dt>
                              <dd className="[overflow-wrap:anywhere]">
                                {m.template.name || m.templateId}
                                <small className="block text-xs text-muted-foreground">
                                  {m.template.revision}
                                </small>
                              </dd>
                            </div>
                            <div className="min-w-0">
                              <dt className="mb-1 text-xs text-muted-foreground">
                                Host
                              </dt>
                              <dd className="[overflow-wrap:anywhere]">
                                {hostName(m.hostId)}
                                <small className="block text-xs text-muted-foreground">
                                  {provider(
                                    inventory.hosts.find(
                                      (h) => h.id === m.hostId,
                                    )?.provider,
                                  )}
                                </small>
                              </dd>
                            </div>
                            <div className="min-w-0">
                              <dt className="mb-1 text-xs text-muted-foreground">
                                Resources
                              </dt>
                              <dd className="[overflow-wrap:anywhere]">
                                {m.resources.cpu} vCPU ·{" "}
                                {memory(m.resources.memoryMiB)}
                                <small className="block text-xs text-muted-foreground">
                                  {number(m.resources.diskGiB)} GiB disk
                                </small>
                              </dd>
                            </div>
                            <div className="min-w-0">
                              <dt className="mb-1 text-xs text-muted-foreground">
                                Updated
                              </dt>
                              <dd className="[overflow-wrap:anywhere]">
                                {since(m.updatedAt)}
                              </dd>
                            </div>
                          </dl>
                        </CardContent>
                        <CardFooter className="flex flex-wrap gap-2">
                          {m.template.mode !== "device" &&
                            m.observed !== "stopped" &&
                            inventory.hosts.some(
                              (h) =>
                                h.id === m.hostId &&
                                h.online &&
                                ["macos", "apple"].includes(h.provider),
                            ) && (
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => setPowerOffId(m.id)}
                                aria-label={`Power off ${m.name}`}
                              >
                                Power off
                              </Button>
                            )}
                          {user.role === "admin" &&
                            m.template.mode !== "device" && (
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={
                                  m.desired !== "stopped" ||
                                  m.observed !== "stopped" ||
                                  !!m.powerOffRequest
                                }
                                onClick={() => setCaptureId(m.id)}
                                aria-label={`Capture ${m.name} as image`}
                              >
                                Capture image
                              </Button>
                            )}
                          {(m.template.mode === "device" ||
                            m.template.guestAccess) && (
                            <Button
                              size="sm"
                              disabled={!m.ready || m.observed !== "running"}
                              onClick={() => setControlId(m.id)}
                            >
                              Control
                            </Button>
                          )}
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={busy || !!m.powerOffRequest}
                            aria-label={`${m.desired === "running" ? "Stop" : "Start"} ${m.name}`}
                            onClick={() => lifecycle(m)}
                          >
                            {m.desired === "running" ? "Stop" : "Start"}
                          </Button>
                        </CardFooter>
                      </Card>
                    ))}
                  </div>
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
                ) : (
                  <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
                    {imageItems.map((t) => (
                      <Card
                        className="rounded-md shadow-none"
                        key={JSON.stringify([t.id, t.revision, t.arch])}
                      >
                        <CardHeader>
                          <div className="flex items-center justify-between gap-3">
                            <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                              <Layers size={20} />
                            </span>
                            <Badge variant="outline">{title(t.mode)}</Badge>
                          </div>
                          <CardTitle className="font-display text-xl font-medium tracking-tight">
                            {t.name || t.id}
                          </CardTitle>
                          <CardDescription>
                            {t.imageKind === "derived"
                              ? "Captured image"
                              : "Base image"}{" "}
                            ·{" "}
                            {t.mediaType === "installer"
                              ? "OS installer"
                              : "Boot disk"}{" "}
                            · Revision {t.revision}
                          </CardDescription>
                        </CardHeader>
                        <CardContent className="grid gap-4">
                          <div className="flex flex-wrap gap-2">
                            <Badge variant="secondary">{t.os}</Badge>
                            <Badge variant="secondary">{t.arch}</Badge>
                          </div>
                          <p className="text-sm">
                            {(t.defaults || t.minimum).cpu} vCPU ·{" "}
                            {memory((t.defaults || t.minimum).memoryMiB)} ·{" "}
                            {(t.defaults || t.minimum).diskGiB} GiB
                          </p>
                          <p className="break-all text-xs text-muted-foreground">
                            {t.device?.systemImage ||
                              t.device?.runtime ||
                              `${t.os} base image · ${t.arch}`}
                          </p>
                          <p className="text-sm text-muted-foreground">
                            {!t.preparationDriver ||
                            t.preparationDriver === "none"
                              ? "No preparation required"
                              : `Preparation: ${t.preparationDriver}`}
                          </p>
                        </CardContent>
                        <CardFooter className="flex-wrap justify-between gap-3 text-xs text-muted-foreground">
                          <span>
                            {
                              t.hosts.filter((h) => h.online && h.accepting)
                                .length
                            }{" "}
                            accepting hosts
                          </span>
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={busy || !eligible(t)}
                            onClick={() => openCreate(t)}
                          >
                            Use image
                            <ArrowUpRight size={13} />
                          </Button>
                        </CardFooter>
                      </Card>
                    ))}
                  </div>
                )}
              </section>
              {loaded && (
                <p className="text-xs text-muted-foreground" role="status">
                  {items.length} of {total}{" "}
                  {view === "templates" ? "images" : view}
                </p>
              )}
            </>
          )}
        </div>
      </SidebarInset>
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
          onClose={() => setPowerOffId(null)}
          onRefresh={refresh}
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
          onClose={() => setCaptureId(null)}
          onRefresh={refresh}
        />
      )}
      {budgetOpen && (
        <SharedBudgets
          hosts={inventory.hosts}
          onClose={() => setBudgetOpen(false)}
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
                `${m.name} assigned to ${hostName(m.hostId)}. Waiting for the host to report its state.`,
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
      templateId: template.id,
      templateRevision: template.revision,
      arch: template.arch,
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
          <DialogTitle>Create a machine</DialogTitle>
          <DialogDescription className="sr-only">
            Choose an image, resources and placement.
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
                  placeholder="e.g. development-workspace"
                  autoComplete="off"
                  required
                  autoFocus
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="machine-template">Base image</FieldLabel>
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
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {template && (
                  <FieldDescription id="template-summary">
                    {template.os} · {title(template.mode)} · Minimum{" "}
                    {template.minimum.cpu} vCPU,{" "}
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
                </>
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
              {busy ? "Creating…" : retry ? "Retry request" : "Create machine"}
              <ArrowUpRight />
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
