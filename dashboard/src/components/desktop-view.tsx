import { useEffect, useRef, useState } from "react";
import RFB from "@novnc/novnc";
import type { RFBChannel } from "@novnc/novnc";
import type { RefObject } from "react";
import { displayMessage } from "@/lib/workspace";
import type { DisplayActions } from "@/lib/workspace";
import { errorMessage } from "@/lib/api";
import { Button } from "@/components/ui/button";
import {
  Monitor,
  Maximize,
  MousePointer2,
  LockKeyhole,
  RefreshCw,
  Clipboard,
  Home,
  ArrowLeft,
} from "lucide-react";

export function DesktopView({
  machine,
  active = true,
  actionsRef,
}: {
  machine: { id: string; template: { mode: string; os?: string } };
  active?: boolean;
  actionsRef?: RefObject<DisplayActions | null>;
}) {
  const mobile = machine.template.mode === "device";
  const target = useRef<HTMLDivElement>(null),
    rfb = useRef<RFB | null>(null),
    socket = useRef<WebSocket | null>(null),
    panel = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState("connecting"),
    [error, setError] = useState(""),
    [control, setControl] = useState(false),
    [fit, setFit] = useState(true),
    [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const displayRoot = target.current;
    if (!active || !displayRoot) return;
    setStatus("connecting");
    setError("");
    setControl(false);
    const url = new URL(
      `/api/v1/machines/${machine.id}/desktop`,
      location.href,
    );
    url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
    let connection: RFB | undefined;
    const pending = new Map<
      string,
      {
        timer: ReturnType<typeof setTimeout>;
        resolve: (value: Record<string, unknown>) => void;
        reject: (error: Error) => void;
      }
    >();
    const rejectPending = () => {
      for (const [id, request] of pending) {
        clearTimeout(request.timer);
        request.reject(
          new Error(
            `Input connection ended before confirmation. Inspect receipt ${id} before retrying.`,
          ),
        );
      }
      pending.clear();
    };
    try {
      const transport = new WebSocket(url.href, ["binary"]);
      socket.current = transport;
      transport.addEventListener("message", (event) => {
        if (typeof event.data !== "string") return;
        event.stopImmediatePropagation();
        try {
          const value = displayMessage(event.data);
          if (!value || !connection) return;
          if (value.type === "action-result") {
            const request = pending.get(value.id);
            if (!request) return;
            pending.delete(value.id);
            clearTimeout(request.timer);
            if (value.state === "succeeded") request.resolve(value.result);
            else
              request.reject(
                new Error(
                  `${value.result?.detail || "Input completion was not confirmed"} Receipt ${value.id}; inspect before retrying.`,
                ),
              );
            return;
          }
          if (value.type !== "control") return;
          const owned = value.state === "owned";
          connection.viewOnly = !owned;
          setControl(owned);
          if (owned) connection.focus();
          setError(
            value.state === "busy"
              ? "Another connection has input control. Release it there before taking control here."
              : value.state === "reset-uncertain"
                ? "Input reset could not be confirmed. Machine recovery is required before taking control again."
                : "",
          );
        } catch {
          if (connection) {
            connection.viewOnly = true;
            connection.disconnect();
          }
          setControl(false);
          rejectPending();
        }
      });
      // Explicit properties also support instrumented/subclassed WebSockets;
      // noVNC validates only own and immediate-prototype channel properties.
      const channel: RFBChannel = {
        send: (data) => transport.send(data),
        close: () => transport.close(),
        get binaryType() {
          return transport.binaryType;
        },
        set binaryType(value) {
          transport.binaryType = value;
        },
        get readyState() {
          return transport.readyState;
        },
        get protocol() {
          return transport.protocol;
        },
        get onmessage() {
          return transport.onmessage;
        },
        set onmessage(value) {
          transport.onmessage = value;
        },
        get onopen() {
          return transport.onopen;
        },
        set onopen(value) {
          transport.onopen = value;
        },
        get onclose() {
          return transport.onclose;
        },
        set onclose(value) {
          transport.onclose = value;
        },
        get onerror() {
          return transport.onerror;
        },
        set onerror(value) {
          transport.onerror = value;
        },
      };
      connection = new RFB(displayRoot, channel, { shared: true });
      const ownedConnection = connection;
      rfb.current = connection;
      connection.viewOnly = true;
      connection.scaleViewport = true;
      connection.resizeSession = false;
      connection.background = "#090909";
      if (actionsRef)
        actionsRef.current = {
          owned: () =>
            !ownedConnection.viewOnly &&
            transport.readyState === WebSocket.OPEN,
          perform: (action, args) => {
            if (
              ownedConnection.viewOnly ||
              transport.readyState !== WebSocket.OPEN
            )
              return Promise.reject(
                new Error("Take input control before acting."),
              );
            const id = crypto.randomUUID();
            const body = JSON.stringify({
              type: "action",
              id,
              action,
              arguments: args,
            });
            if (new TextEncoder().encode(body).length > 16384)
              return Promise.reject(
                new Error(
                  "Input request exceeds the control message envelope.",
                ),
              );
            return new Promise<Record<string, unknown>>((resolve, reject) => {
              const timer = setTimeout(() => {
                ownedConnection.disconnect();
                rejectPending();
              }, 90000);
              pending.set(id, { resolve, reject, timer });
              try {
                transport.send(body);
              } catch {
                ownedConnection.disconnect();
                rejectPending();
              }
            });
          },
        };
      connection.addEventListener("connect", () => setStatus("connected"));
      connection.addEventListener("disconnect", (event) => {
        rejectPending();
        setStatus("disconnected");
        setControl(false);
        if (!event.detail.clean)
          setError(
            "Desktop connection ended. Check guest readiness, then reconnect.",
          );
      });
      connection.addEventListener("securityfailure", () =>
        setError("The guest refused the desktop connection."),
      );
      connection.addEventListener("credentialsrequired", () => {
        setError(
          "This guest requires a desktop authentication method that is not configured.",
        );
        ownedConnection.disconnect();
      });
    } catch (error) {
      socket.current?.close();
      socket.current = null;
      setStatus("disconnected");
      setError(errorMessage(error));
    }
    return () => {
      if (actionsRef) actionsRef.current = null;
      rejectPending();
      if (connection) {
        connection.disconnect();
        rfb.current = null;
        socket.current = null;
      }
    };
  }, [machine.id, attempt, active, actionsRef]);
  function toggleControl() {
    if (socket.current?.readyState !== WebSocket.OPEN) return;
    socket.current.send(
      JSON.stringify({
        type: "input-control",
        action: control ? "release" : "take",
      }),
    );
  }
  return (
    <div
      ref={panel}
      className="flex h-full min-h-80 min-w-0 flex-col bg-neutral-950"
    >
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b bg-background px-4 py-2">
        <div className="flex items-center gap-2 text-xs">
          <span
            className={`size-2 rounded-full ${status === "connected" ? "bg-emerald-500" : "bg-muted-foreground"}`}
          />
          {status === "connected"
            ? control
              ? "Mouse and keyboard connected"
              : "View only"
            : status === "connecting"
              ? "Connecting to desktop…"
              : "Disconnected"}
        </div>
        <div className="flex flex-wrap gap-1">
          <Button
            size="sm"
            variant={control ? "default" : "outline"}
            disabled={status !== "connected"}
            onClick={toggleControl}
          >
            {control ? <LockKeyhole /> : <MousePointer2 />}
            {control ? "Release control" : "Take control"}
          </Button>
          {mobile && (
            <>
              <Button
                size="sm"
                variant="ghost"
                disabled={!control}
                onClick={() => rfb.current?.sendKey(0x1008ff18, null)}
              >
                <Home />
                Home
              </Button>
              {machine.template.os === "android" && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={!control}
                  onClick={() => rfb.current?.sendKey(0xff1b, null)}
                >
                  <ArrowLeft />
                  Back
                </Button>
              )}
            </>
          )}
          <Button
            size="sm"
            variant="ghost"
            disabled={status !== "connected"}
            onClick={() => {
              setFit(!fit);
              if (rfb.current) rfb.current.scaleViewport = !fit;
            }}
          >
            {fit ? "Actual size" : "Fit to view"}
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Paste clipboard into guest"
            disabled={!control}
            onClick={async () => {
              try {
                const current = rfb.current;
                if (!current || current.viewOnly)
                  throw new Error("Input control is unavailable.");
                const text = await navigator.clipboard.readText();
                if (rfb.current !== current || current.viewOnly)
                  throw new Error("Input ownership changed.");
                current.clipboardPasteFrom(text);
              } catch {
                setError(
                  "Clipboard access was declined. Paste into a terminal instead.",
                );
              }
            }}
          >
            <Clipboard />
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Fullscreen desktop"
            onClick={() =>
              panel.current
                ?.requestFullscreen()
                .catch(() => setError("Fullscreen is unavailable."))
            }
          >
            <Maximize />
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Reconnect desktop"
            onClick={() => setAttempt(attempt + 1)}
          >
            <RefreshCw />
          </Button>
        </div>
      </div>
      {error && (
        <p
          role="alert"
          className="border-b bg-background px-4 py-2 text-sm text-destructive"
        >
          {error}
        </p>
      )}
      <div className="relative min-h-0 min-w-0 flex-1">
        <div ref={target} className="absolute inset-0 overflow-hidden" />
        {status !== "connected" && (
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center text-muted-foreground">
            <Monitor className="size-8" />
            <p className="text-sm">
              {status === "connecting"
                ? "Opening the display…"
                : "The desktop is disconnected."}
            </p>
            <p className="max-w-sm text-xs">
              The environment must finish preparing its display services before
              it can accept connections.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
