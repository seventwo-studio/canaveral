import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { api, errorMessage } from "@/lib/api";
import { user as decodeUser, type Machine, type User } from "@/lib/inventory";
import { record } from "@/lib/types";
import {
  tokenList,
  tokenMetadata,
  tokenScopes,
  tokenState,
  timestamp,
  type PersonalToken,
} from "@/lib/accounts";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import {
  Field,
  FieldLabel,
  FieldGroup,
  FieldSet,
  FieldError,
} from "./ui/field";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "./ui/card";
import { Badge } from "./ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "./ui/table";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./ui/alert-dialog";
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription } from "./ui/empty";

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card className="max-w-3xl">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">{children}</CardContent>
    </Card>
  );
}
function TextField({
  name,
  label,
  password = false,
}: {
  name: string;
  label: string;
  password?: boolean;
}) {
  return (
    <Field>
      <FieldLabel htmlFor={name}>{label}</FieldLabel>
      <Input
        id={name}
        name={name}
        type={password ? "password" : "text"}
        autoComplete={
          password
            ? name === "currentPassword"
              ? "current-password"
              : "new-password"
            : "off"
        }
        required
        minLength={password ? (name === "currentPassword" ? 1 : 12) : 1}
        maxLength={password ? 1024 : 100}
      />
    </Field>
  );
}
export function Secret({
  value,
  label,
  onDismiss,
}: {
  value: string;
  label: string;
  onDismiss: () => void;
}) {
  const [error, setError] = useState("");
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setError("Copied.");
    } catch {
      setError("Copy unavailable. Select the value or download it.");
    }
  }
  function download() {
    const url = URL.createObjectURL(
      new Blob([value + "\n"], { type: "text/plain" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = "canaveral-credential.txt";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <section className="space-y-3 border p-4" aria-label={label}>
      <p>{label}. Save it now; it will not be shown again.</p>
      <Input aria-label={label} value={value} readOnly autoComplete="off" />
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" onClick={copy}>
          Copy
        </Button>
        <Button variant="outline" onClick={download}>
          Download
        </Button>
        <Button variant="outline" onClick={onDismiss}>
          Done
        </Button>
      </div>
      {error && <p role="status">{error}</p>}
    </section>
  );
}
export function AccountPage({
  user,
  onChanged,
}: {
  user: User;
  onChanged: () => void;
}) {
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [uncertain, setUncertain] = useState(false);
  const locked = useRef(false);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (locked.current || uncertain) return;
    const form = e.currentTarget,
      data = new FormData(form);
    if (data.get("password") !== data.get("confirmation")) {
      setError("Passwords do not match.");
      return;
    }
    locked.current = true;
    setBusy(true);
    setError("");
    const body = {
      currentPassword: String(data.get("currentPassword")),
      password: String(data.get("password")),
    };
    form.reset();
    try {
      await api("auth/password", body);
      onChanged();
    } catch (e) {
      const status =
        e && typeof e === "object" && "status" in e ? e.status : undefined;
      if (typeof status !== "number" || status >= 500) {
        setUncertain(true);
        setError(
          "The password change could not be confirmed. Sign out and try signing in with your new password. If it fails, use your previous password.",
        );
      } else setError(errorMessage(e));
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }
  return (
    <Panel title="Account">
      <p>
        {user.username} · {user.role === "admin" ? "Administrator" : "User"} ·{" "}
        {user.status}
      </p>
      <h2>Change password</h2>
      <p>
        Choose a password for Canaveral only. Changing it signs you out of all
        sessions and revokes your API tokens.
      </p>
      <form onSubmit={submit}>
        <FieldSet disabled={busy || uncertain}>
          <FieldGroup>
            <TextField
              name="currentPassword"
              label="Current password"
              password
            />
            <TextField name="password" label="New password" password />
            <TextField name="confirmation" label="Confirm password" password />
            <Button type="submit">
              {busy ? "Saving…" : "Change password"}
            </Button>
          </FieldGroup>
        </FieldSet>
      </form>
      {error && <FieldError>{error}</FieldError>}
    </Panel>
  );
}
export function TokensPage({ user }: { user: User }) {
  const [tokens, setTokens] = useState<PersonalToken[]>([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [secret, setSecret] = useState<string | null>(null);
  const [preset, setPreset] = useState("read"),
    [uncertain, setUncertain] = useState<{ id: string; name: string } | null>(
      null,
    );
  const locked = useRef(false),
    intent = useRef<{ id: string; name: string } | null>(null),
    mounted = useRef(true);
  async function load() {
    const list = await api("auth/tokens", undefined, tokenList);
    if (mounted.current) setTokens(list);
  }
  useEffect(() => {
    mounted.current = true;
    load().catch((e) => setError(errorMessage(e)));
    return () => {
      mounted.current = false;
    };
  }, []);
  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (locked.current || uncertain || secret) return;
    const form = e.currentTarget,
      data = new FormData(form),
      name = String(data.get("name")).trim();
    if (!name) return;
    intent.current = { id: crypto.randomUUID(), name };
    const current = intent.current;
    locked.current = true;
    setBusy(true);
    setError("");
    try {
      const response = record(
        await api("auth/tokens", {
          id: current.id,
          name,
          scopes: tokenScopes(preset, user.role === "admin"),
          expiresInSeconds: Number(data.get("days")) * 86400,
        }),
      );
      if (!mounted.current) return;
      const metadata = tokenMetadata(response);
      if (metadata.id !== current.id || metadata.name !== name)
        throw new Error("Token confirmation changed.");
      if (typeof response.token === "string" && response.token) {
        setSecret(response.token);
        intent.current = null;
        form.reset();
      } else {
        setUncertain(current);
        setError(
          "This token's secret is unavailable. Revoke it below, then create a replacement.",
        );
      }
      await load().catch(() => {
        if (mounted.current)
          setError(
            "Could not refresh tokens. Save the new secret, then refresh the list.",
          );
      });
    } catch {
      if (mounted.current) {
        setUncertain(current);
        setError(
          "Token creation could not be confirmed. Refresh the list, revoke this token if present, then create a replacement. The secret cannot be recovered.",
        );
      }
    } finally {
      locked.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  async function revoke(id: string) {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError("");
    try {
      await api(`auth/tokens/${encodeURIComponent(id)}/revoke`, {});
      await load();
      if (mounted.current) {
        if (uncertain?.id === id) {
          setUncertain(null);
          intent.current = null;
        }
        setSecret(null);
      }
    } catch (e) {
      const status =
        e && typeof e === "object" && "status" in e ? e.status : undefined;
      if (mounted.current) {
        if (status === 404 && uncertain?.id === id) {
          setUncertain(null);
          intent.current = null;
          setError(
            "This token is unavailable. Refresh your tokens, then create a replacement.",
          );
        } else
          setError(
            "Revocation could not be confirmed. Refresh the list or revoke again.",
          );
      }
    } finally {
      locked.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <Panel title="API tokens">
      <p>
        Tokens grant access to your account. Save each secret when you create
        it.
      </p>
      {secret && (
        <Secret
          value={secret}
          label="New API token"
          onDismiss={() => setSecret(null)}
        />
      )}
      <form onSubmit={create}>
        <FieldSet disabled={busy || !!uncertain || !!secret}>
          <FieldGroup>
            <TextField name="name" label="Token name" />
            <Field>
              <FieldLabel htmlFor="scopes">Permissions</FieldLabel>
              <select
                id="scopes"
                value={preset}
                onChange={(e) => setPreset(e.target.value)}
                className="border bg-background p-2"
              >
                <option value="read">Read my machines</option>
                <option value="manage">Manage my machines</option>
                {user.role === "admin" && (
                  <option value="admin">Administrator access</option>
                )}
              </select>
            </Field>
            <Field>
              <FieldLabel htmlFor="days">Expires in days</FieldLabel>
              <Input
                id="days"
                name="days"
                type="number"
                min={1}
                max={365}
                step={1}
                defaultValue={30}
                required
              />
            </Field>
            <Button type="submit">Create token</Button>
          </FieldGroup>
        </FieldSet>
      </form>
      {error && <FieldError>{error}</FieldError>}
      {uncertain && (
        <div className="space-y-2">
          <p>
            Token: {uncertain.name} · {uncertain.id}
          </p>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => revoke(uncertain.id)}
          >
            Revoke uncertain token
          </Button>
        </div>
      )}
      <Button
        variant="outline"
        disabled={busy}
        onClick={() => load().catch((e) => setError(errorMessage(e)))}
      >
        Refresh tokens
      </Button>
      {tokens.map((t) => (
        <section key={t.id} className="space-y-2 border-t pt-4">
          <h2>
            {t.name} · {tokenState(t)}
          </h2>
          <p className="break-all">
            {t.prefix} · {t.scopes.join(", ")}
          </p>
          <p className="text-sm">
            Created: {timestamp(t.createdAt)} · Expires:{" "}
            {timestamp(t.expiresAt)} · Last used: {timestamp(t.lastUsedAt)} ·
            Revoked: {timestamp(t.revokedAt)}
          </p>
          {t.revokedAt === null && (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => revoke(t.id)}
            >
              Revoke {t.name}
            </Button>
          )}
        </section>
      ))}
    </Panel>
  );
}
interface UserMutation {
  path: string;
  body: Record<string, unknown>;
  label: string;
  username: string;
  claim?: boolean;
}
interface UserConfirmation {
  mutation: UserMutation;
  title: string;
  description: string;
  button: string;
}
const responseStatus = (error: unknown) =>
  error && typeof error === "object" && "status" in error
    ? error.status
    : undefined;

export function UsersPage({
  user,
  machines,
  onDenied,
}: {
  user?: User;
  machines?: Machine[];
  onDenied?: () => void;
} = {}) {
  const [users, setUsers] = useState<User[]>([]),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true),
    [loaded, setLoaded] = useState(false),
    [loadedFor, setLoadedFor] = useState<string | null>(null),
    [uncertain, setUncertain] = useState(false),
    [denied, setDenied] = useState(false),
    [query, setQuery] = useState(""),
    [status, setStatus] = useState("all"),
    [link, setLink] = useState<{ value: string; username: string } | null>(
      null,
    ),
    [confirmation, setConfirmation] = useState<UserConfirmation | null>(null);
  const locked = useRef(false),
    mounted = useRef(false),
    epoch = useRef(0),
    confirmationFocus = useRef<HTMLElement | null>(null),
    deniedCallback = useRef(onDenied);
  deniedCallback.current = onDenied;
  const principal = `${user?.id ?? ""}:${user?.role ?? ""}`;
  const visible = loadedFor === principal && (!user || user.role === "admin");
  const current = (request: number) =>
    mounted.current && epoch.current === request;
  function handleDenied(error: unknown, request: number) {
    const code = responseStatus(error);
    if (!current(request) || (code !== 401 && code !== 403)) return false;
    setUsers([]);
    setLink(null);
    setConfirmation(null);
    setNotice("");
    setLoaded(false);
    setLoadedFor(null);
    setDenied(true);
    setError(
      code === 401
        ? "Your session has ended. Sign in again to manage users."
        : "Administrator access is required to manage users.",
    );
    deniedCallback.current?.();
    return true;
  }
  async function load(request: number) {
    const r = record(await api("users"));
    if (!Array.isArray(r.users)) throw new Error("Invalid users list.");
    const list = r.users.map(decodeUser);
    if (!current(request)) return false;
    setUsers(list);
    setLoaded(true);
    setLoadedFor(principal);
    setDenied(false);
    return true;
  }
  async function refresh() {
    if (locked.current) return;
    locked.current = true;
    const request = ++epoch.current;
    setLoading(true);
    setError("");
    setNotice("");
    try {
      if (await load(request)) setUncertain(false);
    } catch (e) {
      if (!current(request) || handleDenied(e, request)) return;
      setError(
        "Users could not be refreshed. Previous account data may be stale. Refresh users to try again.",
      );
    } finally {
      if (current(request)) {
        locked.current = false;
        setLoading(false);
      }
    }
  }
  useEffect(() => {
    mounted.current = true;
    ++epoch.current;
    locked.current = false;
    setUsers([]);
    setLink(null);
    setConfirmation(null);
    setLoaded(false);
    setLoadedFor(null);
    setUncertain(false);
    setBusy(false);
    setDenied(false);
    setNotice("");
    setQuery("");
    setStatus("all");
    if (user && user.role !== "admin") {
      setDenied(true);
      setLoading(false);
      setError("Administrator access is required to manage users.");
    } else void refresh();
    return () => {
      mounted.current = false;
      ++epoch.current;
      locked.current = false;
    };
  }, [user?.id, user?.role]);
  async function action(mutation: UserMutation) {
    if (locked.current || uncertain || denied || !visible) return;
    locked.current = true;
    const request = ++epoch.current;
    setBusy(true);
    setError("");
    setNotice("");
    setLink(null);
    setConfirmation(null);
    try {
      const response = await api(mutation.path, mutation.body);
      if (!current(request)) return;
      if (mutation.claim) {
        const r = record(response);
        if (typeof r.token !== "string" || !r.token)
          throw new Error("Account link missing.");
        setLink({
          value: `${location.origin}${location.pathname}#claim=${encodeURIComponent(r.token)}`,
          username: mutation.username,
        });
      }
      try {
        if (await load(request)) setNotice(`${mutation.label} completed.`);
      } catch (e) {
        if (!current(request) || handleDenied(e, request)) return;
        setUncertain(true);
        setError(
          "The change was submitted, but users could not be refreshed. Refresh users to check account status before making another change.",
        );
      }
    } catch (e) {
      if (!current(request) || handleDenied(e, request)) return;
      const code = responseStatus(e);
      if (typeof code !== "number" || code >= 500) {
        setUncertain(true);
        setError(
          `${mutation.label} could not be confirmed. Refresh users and check ${mutation.username}'s account before trying again. If a link was lost, issue a replacement after checking.`,
        );
      } else setError(errorMessage(e));
    } finally {
      if (current(request)) {
        locked.current = false;
        setBusy(false);
      }
    }
  }
  function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (locked.current || uncertain || denied || loading) return;
    const form = e.currentTarget,
      username = String(new FormData(form).get("username")).trim();
    if (!username) return;
    form.reset();
    void action({
      path: "users",
      body: { id: crypto.randomUUID(), username, role: "user" },
      label: `Creation of ${username}`,
      username,
    });
  }
  function confirm(target: User, kind: "disable" | "reset" | "role") {
    confirmationFocus.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const self = target.id === user?.id ? " This is your account." : "";
    const base = `users/${encodeURIComponent(target.id)}`;
    if (kind === "disable")
      setConfirmation({
        title: `Disable ${target.username}?`,
        description: `This signs ${target.username} out and revokes their API tokens. Their machines are retained. Re-enabling requires a fresh invitation and password.${self} Canaveral protects the last active administrator.`,
        button: "Disable account",
        mutation: {
          path: `${base}/update`,
          body: { status: "disabled" },
          label: `Disabling ${target.username}`,
          username: target.username,
        },
      });
    else if (kind === "reset")
      setConfirmation({
        title: `Reset password for ${target.username}?`,
        description: `This immediately blocks ${target.username}'s current password, signs them out and revokes their API tokens. Send them the new recovery link privately.${self} The last active administrator requires operator recovery.`,
        button: "Reset password",
        mutation: {
          path: `${base}/reset-password`,
          body: {},
          claim: true,
          label: `Password reset for ${target.username}`,
          username: target.username,
        },
      });
    else {
      const promote = target.role !== "admin";
      setConfirmation({
        title: `${promote ? "Make" : "Remove administrator access from"} ${target.username}${promote ? " an administrator" : ""}?`,
        description: promote
          ? `${target.username} will be able to manage all users, machines, API access and infrastructure. Existing account links are invalidated.${self}`
          : `${target.username} will be limited to their own machines and personal API tokens. Existing account links are invalidated.${self} Canaveral protects the last active administrator.`,
        button: promote
          ? "Grant administrator access"
          : "Remove administrator access",
        mutation: {
          path: `${base}/update`,
          body: { role: promote ? "admin" : "user" },
          label: `Role change for ${target.username}`,
          username: target.username,
        },
      });
    }
  }
  const filtered = (visible ? users : []).filter(
    (u) =>
      (status === "all" || u.status === status) &&
      `${u.username} ${u.id}`
        .toLowerCase()
        .includes(query.trim().toLowerCase()),
  );
  const unavailable = busy || loading || uncertain || denied || !visible;
  const activeAdmins = users.filter(
    (u) => u.role === "admin" && u.status === "active",
  ).length;
  return (
    <section
      className="@container min-w-0 space-y-6"
      aria-labelledby="users-heading"
    >
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-2">
          <h1
            id="users-heading"
            className="font-display text-2xl font-semibold"
          >
            Users
          </h1>
          <p className="max-w-2xl text-sm text-muted-foreground">
            Invite people and manage account access. Users can access only their
            own machines.
          </p>
        </div>
        <Button
          variant="outline"
          disabled={busy || loading}
          onClick={() => void refresh()}
        >
          Refresh users
        </Button>
      </header>
      {error && <FieldError>{error}</FieldError>}
      {notice && (
        <p role="status" className="text-sm">
          {notice}
        </p>
      )}
      {link && visible && (
        <div className="space-y-2">
          <Secret
            value={link.value}
            label="Account link"
            onDismiss={() => setLink(null)}
          />
          <p className="text-sm text-muted-foreground">
            Send this single-use link privately to {link.username}. It expires
            in 24 hours. Issuing a replacement invalidates the previous link.
          </p>
        </div>
      )}
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>New user</h2>
          </CardTitle>
          <CardDescription>
            New accounts start pending with the User role. Issue an invitation
            so the person can choose their password.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={create}>
            <FieldSet disabled={unavailable}>
              <FieldGroup className="gap-3 sm:flex-row sm:items-end">
                <TextField name="username" label="New username" />
                <Button type="submit" className="shrink-0">
                  Create user
                </Button>
              </FieldGroup>
            </FieldSet>
          </form>
        </CardContent>
      </Card>
      <FieldGroup className="gap-3 sm:flex-row sm:items-end">
        <Field>
          <FieldLabel htmlFor="users-search">Search users</FieldLabel>
          <Input
            id="users-search"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Username or user ID"
          />
        </Field>
        <Field className="sm:max-w-48">
          <FieldLabel htmlFor="users-status">User status</FieldLabel>
          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger id="users-status" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              <SelectItem value="active">Active</SelectItem>
              <SelectItem value="pending">Pending</SelectItem>
              <SelectItem value="disabled">Disabled</SelectItem>
            </SelectContent>
          </Select>
        </Field>
      </FieldGroup>
      {loading && (
        <p role="status" className="text-sm text-muted-foreground">
          Loading users…
        </p>
      )}
      {loaded && visible && filtered.length === 0 && (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>
              {users.length ? "No users match" : "No users available"}
            </EmptyTitle>
            <EmptyDescription>
              {users.length
                ? "Try another username or status."
                : "Create a user, then issue an invitation to get them started."}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
      {filtered.length > 0 && (
        <Table
          className="block table-fixed @2xl:table"
          aria-label="User accounts"
        >
          <TableHeader className="hidden @2xl:table-header-group">
            <TableRow>
              <TableHead className="w-1/4">User</TableHead>
              <TableHead className="w-1/5">Access</TableHead>
              {machines !== undefined && (
                <TableHead className="w-24">Machines</TableHead>
              )}
              <TableHead>Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody className="block @2xl:table-row-group">
            {filtered.map((u) => (
              <TableRow
                key={u.id}
                className="block py-3 @2xl:table-row @2xl:py-0"
                aria-label={`${u.username} account`}
              >
                <TableCell className="block whitespace-normal align-top @2xl:table-cell">
                  <span className="block break-all font-medium">
                    {u.username}
                    {u.id === user?.id && (
                      <span className="text-muted-foreground"> (you)</span>
                    )}
                  </span>
                  <span className="mt-1 block break-all text-xs text-muted-foreground">
                    {u.id}
                  </span>
                </TableCell>
                <TableCell className="block whitespace-normal align-top @2xl:table-cell">
                  <span className="mb-2 block text-sm">
                    {u.role === "admin" ? "Administrator" : "User"}
                  </span>
                  <Badge variant="outline" className="capitalize">
                    {u.status}
                  </Badge>
                  {u.role === "admin" &&
                    u.status === "active" &&
                    activeAdmins === 1 && (
                      <p className="mt-2 text-xs text-muted-foreground">
                        Last active administrator
                      </p>
                    )}
                </TableCell>
                {machines !== undefined && (
                  <TableCell className="block whitespace-normal align-top @2xl:table-cell">
                    <span className="@2xl:hidden">Machines: </span>
                    {
                      machines.filter(
                        (m) => "ownerId" in m && m.ownerId === u.id,
                      ).length
                    }
                  </TableCell>
                )}
                <TableCell className="block whitespace-normal align-top @2xl:table-cell">
                  <div className="flex flex-wrap gap-2">
                    {u.status === "pending" && (
                      <>
                        <Button
                          size="sm"
                          disabled={unavailable}
                          aria-label={`Issue invitation for ${u.username}`}
                          onClick={() =>
                            void action({
                              path: `users/${encodeURIComponent(u.id)}/invite`,
                              body: {},
                              claim: true,
                              label: `Invitation for ${u.username}`,
                              username: u.username,
                            })
                          }
                        >
                          Issue invitation
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={unavailable}
                          aria-label={`Revoke invitation for ${u.username}`}
                          onClick={() =>
                            void action({
                              path: `users/${encodeURIComponent(u.id)}/revoke-invite`,
                              body: {},
                              label: `Invitation revocation for ${u.username}`,
                              username: u.username,
                            })
                          }
                        >
                          Revoke invitation
                        </Button>
                      </>
                    )}
                    {u.status === "active" && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={unavailable}
                        aria-label={`Reset password for ${u.username}`}
                        onClick={() => confirm(u, "reset")}
                      >
                        Reset password
                      </Button>
                    )}
                    {u.status === "disabled" ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={unavailable}
                        aria-label={`Enable ${u.username}`}
                        onClick={() =>
                          void action({
                            path: `users/${encodeURIComponent(u.id)}/update`,
                            body: { status: "pending" },
                            label: `Enabling ${u.username}`,
                            username: u.username,
                          })
                        }
                      >
                        Enable
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={unavailable}
                        aria-label={`Disable ${u.username}`}
                        onClick={() => confirm(u, "disable")}
                      >
                        Disable
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={unavailable}
                      aria-label={`Make ${u.username} ${u.role === "admin" ? "user" : "admin"}`}
                      onClick={() => confirm(u, "role")}
                    >
                      {u.role === "admin" ? "Make user" : "Make admin"}
                    </Button>
                  </div>
                  {u.status === "disabled" && (
                    <p className="mt-2 text-xs text-muted-foreground">
                      Enabling requires a new invitation and password.
                    </p>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <AlertDialog
        open={!!confirmation && visible}
        onOpenChange={(open) => {
          if (!open) setConfirmation(null);
        }}
      >
        <AlertDialogContent
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (confirmationFocus.current?.isConnected)
              confirmationFocus.current.focus();
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>{confirmation?.title}</AlertDialogTitle>
            <AlertDialogDescription>
              {confirmation?.description}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (confirmation) void action(confirmation.mutation);
              }}
            >
              {confirmation?.button}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
