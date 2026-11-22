import { useEffect, useRef, useState } from "react";
import type { User } from "@/lib/inventory";
import { api, errorMessage } from "@/lib/api";
import { apiActions, actionBody, actionPath } from "@/lib/api-workspace";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import {
  FieldSet,
  FieldGroup,
  Field,
  FieldLabel,
  FieldDescription,
} from "./ui/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
import { Card, CardHeader, CardTitle, CardContent } from "./ui/card";
import { Alert, AlertDescription } from "./ui/alert";
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

export function ApiWorkspace({
  user,
  onDenied,
}: {
  user: User;
  onDenied: () => void;
}) {
  if (user.role !== "admin" || user.status !== "active")
    return (
      <Alert>
        <AlertDescription>Administrator access required.</AlertDescription>
      </Alert>
    );
  return (
    <Workspace
      key={`${user.id}:${user.role}:${user.status}`}
      onDenied={onDenied}
    />
  );
}
function Workspace({ onDenied }: { onDenied: () => void }) {
  const [selected, setSelected] = useState(apiActions[0]!.id);
  const action = apiActions.find((item) => item.id === selected)!;
  const [identifier, setIdentifier] = useState("");
  const [session, setSession] = useState("");
  const [configuration, setConfiguration] = useState("");
  const [result, setResult] = useState<unknown>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmation, setConfirmation] = useState<{
    path: string;
    body: Record<string, unknown>;
  } | null>(null);
  const epoch = useRef(0);
  useEffect(
    () => () => {
      ++epoch.current;
    },
    [],
  );
  function choose(id: string) {
    ++epoch.current;
    const next = apiActions.find((item) => item.id === id)!;
    setSelected(id);
    setIdentifier("");
    setSession("");
    setResult(undefined);
    setError("");
    setBusy(false);
    setConfirmation(null);
    setConfiguration(
      next.example ? JSON.stringify(next.example(), null, 2) : "",
    );
  }
  async function execute(path: string, body?: Record<string, unknown>) {
    const request = ++epoch.current;
    setBusy(true);
    setError("");
    // Secrets from an earlier credential response are discarded before any new request.
    if (body !== undefined) setResult(undefined);
    try {
      const value = await api(path, body);
      if (epoch.current === request) setResult(value);
    } catch (e) {
      if (epoch.current !== request) return;
      const denied =
        typeof e === "object" &&
        e !== null &&
        "status" in e &&
        [401, 403].includes(Number(e.status));
      setError(errorMessage(e));
      if (denied) {
        setResult(undefined);
        onDenied();
      }
    } finally {
      if (epoch.current === request) setBusy(false);
    }
  }
  function submit() {
    try {
      const path = actionPath(action, identifier, session);
      if (action.method === "GET") void execute(path);
      else setConfirmation({ path, body: actionBody(configuration) });
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  const pageInfo =
    selected === "configuration-list" &&
    result &&
    typeof result === "object" &&
    "page" in result &&
    "nextPage" in result &&
    Number.isSafeInteger(result.page) &&
    Number(result.page) >= 0 &&
    Number(result.page) <= 1000000
      ? {
          page: Number(result.page),
          nextPage:
            Number.isSafeInteger(result.nextPage) &&
            Number(result.nextPage) <= 1000000 &&
            Number(result.nextPage) === Number(result.page) + 1
              ? Number(result.nextPage)
              : null,
        }
      : null;
  function loadPage(page: number) {
    if (
      !Number.isSafeInteger(page) ||
      page < 0 ||
      page > 1000000 ||
      selected !== "configuration-list"
    )
      return;
    void execute(
      page === 0 ? "admin/configuration" : `admin/configuration/pages/${page}`,
    );
  }
  const features = [...new Set(apiActions.map((item) => item.feature))];
  return (
    <div className="mx-auto w-full min-w-0 max-w-3xl space-y-6">
      <div className="space-y-1">
        <h1 className="text-xl font-semibold tracking-tight">API controls</h1>
        <p className="text-sm text-muted-foreground">
          Configure applications, execution permissions and managed updates.
          Runtime consumer and runner protocols retain their scoped credentials.
        </p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Configuration</CardTitle>
        </CardHeader>
        <CardContent>
          <FieldSet disabled={busy}>
            <FieldGroup className="gap-4">
              <div className="grid min-w-0 items-start gap-3 border-b pb-4 sm:grid-cols-2">
                <Field className="min-w-0">
                  <FieldLabel htmlFor="api-feature">Feature</FieldLabel>
                  <Select
                    value={action.feature}
                    onValueChange={(feature) =>
                      choose(
                        apiActions.find((item) => item.feature === feature)!.id,
                      )
                    }
                  >
                    <SelectTrigger id="api-feature" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {features.map((feature) => (
                        <SelectItem key={feature} value={feature}>
                          {feature}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <Field>
                  <FieldLabel htmlFor="api-action">Action</FieldLabel>
                  <Select value={selected} onValueChange={choose}>
                    <SelectTrigger id="api-action" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {apiActions
                        .filter((item) => item.feature === action.feature)
                        .map((item) => (
                          <SelectItem key={item.id} value={item.id}>
                            {item.label}
                          </SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                  <FieldDescription>{action.help}</FieldDescription>
                </Field>
              </div>
              {action.identifier && (
                <Field>
                  <FieldLabel htmlFor="api-identifier">
                    {action.secondIdentifier
                      ? "Machine UUID"
                      : action.identifier === "SHA-256"
                        ? "Artifact SHA-256"
                        : "Resource UUID"}
                  </FieldLabel>
                  <Input
                    id="api-identifier"
                    autoComplete="off"
                    value={identifier}
                    onChange={(event) => {
                      setIdentifier(event.target.value);
                      setResult(undefined);
                      setError("");
                    }}
                  />
                </Field>
              )}
              {action.secondIdentifier && (
                <Field>
                  <FieldLabel htmlFor="api-session">Session UUID</FieldLabel>
                  <Input
                    id="api-session"
                    autoComplete="off"
                    value={session}
                    onChange={(event) => {
                      setSession(event.target.value);
                      setResult(undefined);
                    }}
                  />
                </Field>
              )}
              {action.method === "POST" && (
                <Field>
                  <FieldLabel htmlFor="api-configuration">
                    Advanced configuration (JSON)
                  </FieldLabel>
                  <Textarea
                    id="api-configuration"
                    autoComplete="off"
                    spellCheck={false}
                    className="min-h-64 font-mono text-xs"
                    value={configuration}
                    onChange={(event) => {
                      setConfiguration(event.target.value);
                      setError("");
                      setResult(undefined);
                    }}
                  />
                  <FieldDescription>
                    Examples require your actual resource identities and
                    verified digests. Request IDs and configuration remain
                    unchanged until you edit or select another action.
                  </FieldDescription>
                </Field>
              )}
              <p className="break-all font-mono text-xs text-muted-foreground">
                {action.method} /v1/{action.path}
              </p>
              {action.recovery && (
                <p className="text-sm text-muted-foreground">
                  {action.recovery}
                </p>
              )}
              <div>
                <Button onClick={submit} disabled={busy}>
                  {busy
                    ? "Working…"
                    : action.method === "GET"
                      ? "Refresh"
                      : "Review action"}
                </Button>
              </div>
            </FieldGroup>
          </FieldSet>
        </CardContent>
      </Card>
      {error && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>
            {error}
            {result !== undefined && " The previous response is stale."}
          </AlertDescription>
        </Alert>
      )}
      {result !== undefined && (
        <Card>
          <CardHeader>
            <CardTitle>Response</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Save returned credentials securely before leaving. Responses are
              held only in this page and cleared when the action or account
              changes.
            </p>
            <pre
              aria-label="API response"
              className="max-h-[36rem] overflow-auto rounded-md border bg-muted/40 p-3 whitespace-pre-wrap break-all font-mono text-xs"
            >
              {JSON.stringify(result, null, 2)}
            </pre>
            {pageInfo && (
              <div
                className="flex flex-wrap items-center gap-3"
                aria-label="Configuration pages"
              >
                <Button
                  variant="outline"
                  disabled={busy || pageInfo.page === 0}
                  onClick={() => loadPage(pageInfo.page - 1)}
                >
                  Previous page
                </Button>
                <span className="text-sm text-muted-foreground">
                  Page {pageInfo.page + 1}
                </span>
                <Button
                  variant="outline"
                  disabled={busy || pageInfo.nextPage === null}
                  onClick={() => {
                    if (pageInfo.nextPage !== null) loadPage(pageInfo.nextPage);
                  }}
                >
                  Next page
                </Button>
              </div>
            )}
            <Button variant="outline" onClick={() => setResult(undefined)}>
              Clear response
            </Button>
          </CardContent>
        </Card>
      )}
      <AlertDialog
        open={confirmation !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmation(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{action.label}?</AlertDialogTitle>
            <AlertDialogDescription>
              {action.help} Review the target and exact configuration before
              applying.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <p className="break-all font-mono text-xs">
            /v1/{confirmation?.path}
          </p>
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all text-xs">
            {confirmation && JSON.stringify(confirmation.body, null, 2)}
          </pre>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const pending = confirmation;
                setConfirmation(null);
                if (pending) void execute(pending.path, pending.body);
              }}
            >
              Apply action
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
