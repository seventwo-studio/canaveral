import { Brand } from "./brand";
import type { FormEventHandler, MouseEventHandler } from "react";
import type { AuthState } from "@/lib/types";
import { RocketArt } from "./rocket";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Alert, AlertDescription } from "./ui/alert";
import {
  Field,
  FieldLabel,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldSet,
} from "./ui/field";

export function LoginScreen({
  auth,
  busy,
  error,
  onSubmit,
  onRetry,
}: {
  auth: AuthState;
  busy: boolean;
  error: string;
  onSubmit: FormEventHandler<HTMLFormElement>;
  onRetry: MouseEventHandler<HTMLButtonElement>;
}) {
  const setup = auth === "setup";
  return (
    <div className="grid min-h-svh lg:grid-cols-2">
      <section className="flex flex-col gap-8 p-6 md:p-10">
        <Brand />
        <div className="m-auto w-full max-w-sm py-12">
          <h1 className="mb-8 font-display text-4xl font-medium tracking-tight">
            {setup || auth === "blocked" ? "Create admin account" : "Sign in"}
          </h1>
          {auth === "blocked" && (
            <Alert className="mb-6">
              <AlertDescription>
                Ask the Canaveral operator to issue a setup link with the admin
                setup-link command, using this dashboard’s HTTPS URL and their
                operator credential. Open the link here to choose your account
                password. The operator can also create the first account through
                localhost setup or admin create.
                <code className="block break-all">
                  canaveral --token-file /path/to/operator.token
                  admin setup-link --dashboard-url
                  https://your-dashboard.example
                </code>
              </AlertDescription>
            </Alert>
          )}
          <form onSubmit={onSubmit}>
            <FieldSet disabled={busy || !["setup", "login"].includes(auth)}>
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="username">Username</FieldLabel>
                  <Input
                    id="username"
                    name="username"
                    autoComplete="username"
                    placeholder="admin"
                    minLength={3}
                    maxLength={100}
                    required
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="password">Password</FieldLabel>
                  <Input
                    id="password"
                    name="password"
                    type="password"
                    autoComplete={setup ? "new-password" : "current-password"}
                    minLength={setup ? 12 : 1}
                    maxLength={1024}
                    aria-describedby={setup ? "password-help" : undefined}
                    required
                  />
                  {setup && (
                    <FieldDescription id="password-help">
                      Choose at least 12 characters.
                    </FieldDescription>
                  )}
                </Field>
                {setup && (
                  <Field>
                    <FieldLabel htmlFor="confirmation">
                      Confirm password
                    </FieldLabel>
                    <Input
                      id="confirmation"
                      name="confirmation"
                      type="password"
                      autoComplete="new-password"
                      minLength={12}
                      maxLength={1024}
                      required
                    />
                  </Field>
                )}
                {error && <FieldError>{error}</FieldError>}
                <Field>
                  <Button type="submit">
                    {busy
                      ? "Connecting…"
                      : auth === "checking"
                        ? "Checking connection…"
                        : setup
                          ? "Create admin account"
                          : "Sign in"}
                  </Button>
                </Field>
              </FieldGroup>
            </FieldSet>
            {["blocked", "unavailable"].includes(auth) && (
              <Button
                className="mt-4 w-full"
                type="button"
                variant="outline"
                onClick={onRetry}
              >
                Try again
              </Button>
            )}
          </form>
        </div>
      </section>
      <aside className="launch-poster relative m-3 hidden overflow-hidden rounded-sm border bg-background lg:block">
        <RocketArt />
      </aside>
    </div>
  );
}
