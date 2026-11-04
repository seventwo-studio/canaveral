import { useEffect, useRef, useState } from "react";
import type { LucideIcon } from "lucide-react";
import type {
  DisplayActions,
  PerformAction,
  WorkspaceMachine,
} from "@/lib/workspace";
import { errorMessage } from "@/lib/api";
import {
  ArrowLeft,
  Monitor,
  Folder,
  TerminalSquare,
  ScanSearch,
  Plus,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { operate } from "@/lib/machine-operations";
import { MachineTerminal } from "./machine-terminal";
import { DesktopView } from "./desktop-view";
import { GuestFiles } from "./guest-files";
import { AccessibilityInspector } from "./accessibility-inspector";

type WorkspaceView = "desktop" | "files" | "shells";
export function MachineControl({
  machine,
  onClose,
}: {
  machine: WorkspaceMachine;
  onClose: () => void;
}) {
  const displayActions = useRef<DisplayActions | null>(null);
  const performInput: PerformAction = (action, args) =>
    displayActions.current?.owned()
      ? displayActions.current.perform(action, args)
      : operate(machine.id, action, args);
  const capabilities = machine.capabilities || {};
  const legacyGuest = Boolean(machine.template.guestAccess);
  const legacyDevice = machine.template.mode === "device";
  const displaySupported =
    machine.template.mode !== "headless" &&
    (capabilities.desktopStream ?? (legacyGuest || legacyDevice));
  const shellSupported =
    machine.template.os !== "ios" &&
    (capabilities.shell ?? (legacyGuest || machine.template.os === "android"));
  const filesSupported = capabilities.files ?? (legacyGuest || legacyDevice);
  const accessibilitySupported = capabilities.accessibility ?? displaySupported;
  const supported = displaySupported || shellSupported || filesSupported;
  const views: Array<[WorkspaceView, string, LucideIcon]> = [];
  if (displaySupported) views.push(["desktop", "Desktop", Monitor]);
  if (filesSupported) views.push(["files", "Files", Folder]);
  if (shellSupported) views.push(["shells", "Terminals", TerminalSquare]);
  const initialView: WorkspaceView = displaySupported
    ? "desktop"
    : filesSupported
      ? "files"
      : "shells";
  const [view, setView] = useState<WorkspaceView>(initialView),
    [inspect, setInspect] = useState(false),
    [sessions, setSessions] = useState<Array<{ id: string; name: string }>>([]),
    [selected, setSelected] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    if (
      (view === "desktop" && !displaySupported) ||
      (view === "files" && !filesSupported) ||
      (view === "shells" && !shellSupported)
    )
      setView(initialView);
  }, [view, displaySupported, filesSupported, shellSupported, initialView]);
  async function newShell() {
    if (busy) return;
    setBusy(true);
    setError("");
    const session = crypto.randomUUID();
    try {
      await operate(machine.id, "shell-open", { session });
      setSessions((old) => [
        ...old,
        { id: session, name: `Shell ${old.length + 1}` },
      ]);
      setSelected(session);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function closeShell(id: string) {
    setBusy(true);
    try {
      await operate(machine.id, "shell-close", { session: id });
      setSessions((old) => old.filter((s) => s.id !== id));
      if (selected === id)
        setSelected(sessions.find((s) => s.id !== id)?.id || null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function close() {
    if (busy) return;
    setBusy(true);
    await Promise.allSettled(
      sessions.map((s) =>
        operate(machine.id, "shell-close", { session: s.id }),
      ),
    );
    onClose();
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent
        showCloseButton={false}
        onEscapeKeyDown={(event) => event.preventDefault()}
        className="fixed inset-0 top-0 left-0 flex h-svh w-screen max-w-none translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden rounded-none border-0 p-0 sm:max-w-none"
      >
        <DialogHeader className="flex-row flex-wrap items-center justify-between gap-3 border-b px-4 py-3 text-left">
          <div className="flex min-w-0 items-center gap-3">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Close machine workspace"
              disabled={busy}
              onClick={close}
            >
              <ArrowLeft />
            </Button>
            <div className="min-w-0">
              <DialogTitle className="break-all text-sm">
                {machine.name}
              </DialogTitle>
              <DialogDescription className="mt-1 text-[10px]">
                {machine.template.os} · {machine.template.arch} ·{" "}
                {machine.ready ? "Ready" : machine.observed}
              </DialogDescription>
            </div>
          </div>
          <div
            className="flex flex-wrap items-center gap-1"
            aria-label="Workspace views"
          >
            {views.map(([key, label, Icon]) => (
              <Button
                size="sm"
                variant={view === key ? "secondary" : "ghost"}
                key={key}
                onClick={() => setView(key)}
                aria-pressed={view === key}
              >
                <Icon />
                {label}
                {key === "shells" && sessions.length
                  ? ` (${sessions.length})`
                  : ""}
              </Button>
            ))}
            {accessibilitySupported && (
              <Button
                size="sm"
                variant={inspect ? "secondary" : "ghost"}
                aria-pressed={inspect}
                onClick={() => setInspect(!inspect)}
              >
                <ScanSearch />
                Inspect
              </Button>
            )}
          </div>
        </DialogHeader>
        {error && (
          <div
            className="flex shrink-0 items-start justify-between gap-3 border-b px-4 py-2 text-sm text-destructive"
            role="alert"
          >
            <span className="break-all">{error}</span>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Dismiss workspace error"
              onClick={() => setError("")}
            >
              <X />
            </Button>
          </div>
        )}
        {!supported ? (
          <p className="p-6">
            This machine has no configured guest connection.
          </p>
        ) : (
          <div className="flex min-h-0 min-w-0 flex-1 flex-col lg:flex-row">
            <main className="relative min-h-0 min-w-0 flex-1">
              {displaySupported && (
                <div
                  className={view === "desktop" ? "absolute inset-0" : "hidden"}
                >
                  <DesktopView
                    machine={machine}
                    active={view === "desktop"}
                    actionsRef={displayActions}
                  />
                </div>
              )}
              {filesSupported && (
                <div
                  className={view === "files" ? "absolute inset-0" : "hidden"}
                >
                  <GuestFiles machine={machine} />
                </div>
              )}
              {shellSupported && (
                <div
                  className={
                    view === "shells"
                      ? "absolute inset-0 flex min-h-0 flex-col"
                      : "hidden"
                  }
                >
                  <div className="flex shrink-0 flex-wrap items-center gap-1 border-b px-3 py-2">
                    {sessions.map((s) => (
                      <div
                        key={s.id}
                        className={`flex items-center rounded-sm border ${selected === s.id ? "bg-muted" : ""}`}
                      >
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setSelected(s.id)}
                        >
                          {s.name}
                        </Button>
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          aria-label={`Close ${s.name}`}
                          disabled={busy}
                          onClick={() => closeShell(s.id)}
                        >
                          <X className="size-3" />
                        </Button>
                      </div>
                    ))}
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={newShell}
                    >
                      <Plus />
                      New shell
                    </Button>
                    <span className="ml-auto text-[10px] text-muted-foreground">
                      {sessions.length} sessions
                    </span>
                  </div>
                  <div className="relative min-h-0 flex-1">
                    {sessions.map((s) => (
                      <div
                        key={s.id}
                        className={
                          selected === s.id ? "absolute inset-0" : "hidden"
                        }
                      >
                        <MachineTerminal
                          machine={machine.id}
                          session={s.id}
                          active={selected === s.id && view === "shells"}
                          onError={setError}
                        />
                      </div>
                    ))}
                    {!sessions.length && (
                      <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 p-6 text-center">
                        <TerminalSquare className="size-9 text-muted-foreground" />
                        <div>
                          <h2 className="text-sm font-medium">
                            Open a terminal
                          </h2>
                          <p className="mt-2 max-w-sm text-xs text-muted-foreground">
                            Independent shell sessions with their own working
                            directory, environment and running processes.
                          </p>
                        </div>
                        <Button disabled={busy} onClick={newShell}>
                          <Plus />
                          New shell
                        </Button>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </main>
            {inspect && accessibilitySupported && (
              <div className="h-[45%] min-h-48 w-full shrink-0 border-t lg:h-auto lg:w-96 lg:border-t-0">
                <AccessibilityInspector
                  machine={machine}
                  performAction={performInput}
                />
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
