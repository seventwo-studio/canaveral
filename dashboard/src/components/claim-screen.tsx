import { useEffect, useState, type FormEvent } from "react";
import { api, errorMessage } from "@/lib/api";
import { record } from "@/lib/types";
import { loginReceipt } from "@/lib/inventory";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import {
  Field,
  FieldLabel,
  FieldGroup,
  FieldError,
  FieldSet,
} from "./ui/field";
import { Brand } from "./brand";

export function takeClaim(): string | null {
  if (!location.hash.startsWith("#claim=")) return null;
  const fragment = location.hash.slice(7);
  history.replaceState(history.state, "", location.pathname + location.search);
  try {
    return decodeURIComponent(fragment) || null;
  } catch {
    return null;
  }
}
export function ClaimScreen({
  token,
  onDone,
}: {
  token: string;
  onDone: () => void;
}) {
  const [info, setInfo] = useState<{ kind: string; username?: string } | null>(
    null,
  );
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [spent, setSpent] = useState(false);
  useEffect(() => {
    if (!window.isSecureContext) {
      setError("Open this link over HTTPS or loopback localhost.");
      return;
    }
    let active = true;
    api("auth/claim/info", { token })
      .then((value) => {
        const r = record(value);
        if (
          !["bootstrap", "invite", "reset"].includes(String(r.kind)) ||
          typeof r.expiresAt !== "number" ||
          (r.username != null && typeof r.username !== "string")
        )
          throw new Error();
        if (active)
          setInfo({
            kind: String(r.kind),
            username: typeof r.username === "string" ? r.username : undefined,
          });
      })
      .catch(() => {
        if (active)
          setError(
            "This link is unavailable, expired or already used. Sign in if you already chose a password, or ask your administrator to issue a new link. For first setup, ask the operator for a new setup link.",
          );
      });
    return () => {
      active = false;
    };
  }, [token]);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy || spent || !info) return;
    const form = e.currentTarget,
      data = new FormData(form);
    if (data.get("password") !== data.get("confirmation")) {
      setError("Passwords do not match.");
      return;
    }
    setBusy(true);
    setSpent(true);
    setError("");
    const body = {
      token,
      password: String(data.get("password")),
      ...(info.kind === "bootstrap"
        ? { username: String(data.get("username")).trim() }
        : {}),
    };
    form.reset();
    try {
      const result = await api("auth/claim", body, loginReceipt);
      if (result.user.status !== "active") throw new Error();
      onDone();
    } catch (error) {
      const status =
        error && typeof error === "object" && "status" in error
          ? error.status
          : undefined;
      if (status === 400 || status === 409 || status === 429) {
        setSpent(false);
        setError(errorMessage(error));
      } else {
        setError(
          "The account could not be confirmed. Sign in with the password you just chose. If that fails, ask your administrator or setup operator for a new link.",
        );
      }
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="mx-auto max-w-md space-y-6 p-8">
      <Brand />
      <h1 className="font-display text-3xl">Choose your Canaveral password</h1>
      <p>Use a new password for Canaveral only. Choose 12–1024 characters.</p>
      {info?.username && <p>Account: {info.username}</p>}
      <form onSubmit={submit}>
        <FieldSet disabled={!info || busy || spent}>
          <FieldGroup>
            {info?.kind === "bootstrap" && (
              <Field>
                <FieldLabel htmlFor="claim-name">Username</FieldLabel>
                <Input
                  id="claim-name"
                  name="username"
                  autoComplete="username"
                  required
                  minLength={3}
                  maxLength={100}
                />
              </Field>
            )}
            {["password", "confirmation"].map((name) => (
              <Field key={name}>
                <FieldLabel htmlFor={`claim-${name}`}>
                  {name === "password" ? "New password" : "Confirm password"}
                </FieldLabel>
                <Input
                  id={`claim-${name}`}
                  name={name}
                  type="password"
                  autoComplete="new-password"
                  required
                  minLength={12}
                  maxLength={1024}
                />
              </Field>
            ))}
            <Button type="submit">
              {busy ? "Saving…" : "Save password and sign in"}
            </Button>
          </FieldGroup>
        </FieldSet>
      </form>
      {error && <FieldError>{error}</FieldError>}
      <Button variant="outline" onClick={onDone}>
        Go to sign in
      </Button>
    </main>
  );
}
