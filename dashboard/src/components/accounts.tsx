import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { api, errorMessage } from "@/lib/api";
import { user as decodeUser, type User } from "@/lib/inventory";
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
import { Card, CardHeader, CardTitle, CardContent } from "./ui/card";

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
export function UsersPage() {
  const [users, setUsers] = useState<User[]>([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [link, setLink] = useState<string | null>(null);
  const locked = useRef(false),
    mounted = useRef(true);
  async function load() {
    const r = record(await api("users"));
    if (!Array.isArray(r.users)) throw new Error("Invalid users list.");
    const list = r.users.map(decodeUser);
    if (mounted.current) setUsers(list);
  }
  useEffect(() => {
    mounted.current = true;
    load().catch((e) => setError(errorMessage(e)));
    return () => {
      mounted.current = false;
    };
  }, []);
  async function action(path: string, body: unknown, claim = false) {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError("");
    setLink(null);
    try {
      const response = await api(path, body);
      if (!mounted.current) return;
      if (claim) {
        const r = record(response);
        if (typeof r.token !== "string" || !r.token)
          throw new Error(
            "The link could not be confirmed. Issue a replacement link.",
          );
        setLink(
          `${location.origin}${location.pathname}#claim=${encodeURIComponent(r.token)}`,
        );
      }
      await load();
    } catch (e) {
      if (mounted.current)
        setError(
          errorMessage(e) +
            (claim
              ? " Sign in if the password was already chosen, or issue a new link."
              : " Refresh users before trying again."),
        );
    } finally {
      locked.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget,
      data = new FormData(form);
    const username = String(data.get("username")).trim();
    form.reset();
    void action("users", { id: crypto.randomUUID(), username, role: "user" });
  }
  return (
    <Panel title="Users">
      <form onSubmit={create}>
        <FieldSet disabled={busy}>
          <FieldGroup>
            <TextField name="username" label="New username" />
            <p>
              New accounts start pending with the User role. Pending accounts
              need an invitation so the person can choose their password.
            </p>
            <Button type="submit">Create user</Button>
          </FieldGroup>
        </FieldSet>
      </form>
      {error && <FieldError>{error}</FieldError>}
      {link && (
        <Secret
          value={link}
          label="Account link"
          onDismiss={() => setLink(null)}
        />
      )}
      <Button
        variant="outline"
        disabled={busy}
        onClick={() => load().catch((e) => setError(errorMessage(e)))}
      >
        Refresh users
      </Button>
      {users.map((u) => (
        <section key={u.id} className="space-y-3 border-t pt-4">
          <h2>
            {u.username} · {u.role} · {u.status}
          </h2>
          <div className="flex flex-wrap gap-2">
            {u.status === "pending" ? (
              <>
                <Button
                  disabled={busy}
                  onClick={() => action(`users/${u.id}/invite`, {}, true)}
                >
                  Issue invitation for {u.username}
                </Button>
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => action(`users/${u.id}/revoke-invite`, {})}
                >
                  Revoke invitation for {u.username}
                </Button>
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    action(`users/${u.id}/update`, { status: "disabled" })
                  }
                >
                  Disable {u.username}
                </Button>
              </>
            ) : (
              <>
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    action(`users/${u.id}/reset-password`, {}, true)
                  }
                >
                  Reset password for {u.username}
                </Button>
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    action(`users/${u.id}/update`, {
                      status: u.status === "active" ? "disabled" : "pending",
                    })
                  }
                >
                  {u.status === "active" ? "Disable" : "Enable"} {u.username}
                </Button>
              </>
            )}
            <Button
              variant="outline"
              disabled={busy}
              onClick={() =>
                action(`users/${u.id}/update`, {
                  role: u.role === "admin" ? "user" : "admin",
                })
              }
            >
              Make {u.username} {u.role === "admin" ? "user" : "admin"}
            </Button>
          </div>
          <p className="text-sm text-muted-foreground">
            Password reset signs this account out and revokes its API tokens.
            Enabling a disabled account requires a new invitation and password.
          </p>
        </section>
      ))}
    </Panel>
  );
}
