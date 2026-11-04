import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { cspNonce } from "@/lib/csp";
import { shellStatus } from "@/lib/workspace";
export function MachineTerminal({
  machine,
  session,
  active,
  onError,
}: {
  machine: string;
  session: string;
  active: boolean;
  onError: (message: string) => void;
}) {
  const element = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const terminalElement = element.current;
    if (!terminalElement) return;
    // Scope generated terminal styles to this response's CSP nonce.
    const terminalDocument = new Proxy(document, {
      get(target, key) {
        if (key === "createElement")
          return (name: string, options?: ElementCreationOptions) => {
            const element = target.createElement(name, options);
            if (name === "style") element.nonce = cspNonce() ?? "";
            return element;
          };
        const value: unknown = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const term = new Terminal({
      documentOverride: terminalDocument,
      cursorBlink: true,
      fontFamily: "monospace",
      fontSize: 13,
      scrollback: 2000,
      theme: { background: "#090909" },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    // xterm 6's viewport uses the global document despite documentOverride.
    // Apply the same nonce during its synchronous initialization, then restore it.
    const createElement = document.createElement;
    try {
      document.createElement = function (
        this: Document,
        name: string,
        options?: ElementCreationOptions,
      ) {
        const node = createElement.call(this, name, options);
        if (name === "style") node.nonce = cspNonce() ?? "";
        return node;
      } as Document["createElement"];
      term.open(terminalElement);
    } finally {
      document.createElement = createElement;
    }
    let disposed = false;
    const url = new URL(
      `/api/v1/machines/${machine}/shells/${session}/stream`,
      location.href,
    );
    url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(url);
    socket.binaryType = "arraybuffer";
    let connected = false;
    const send = (action: string, args: Record<string, unknown>) => {
      if (socket.readyState === WebSocket.OPEN)
        socket.send(JSON.stringify({ action, arguments: args }));
    };
    socket.onmessage = (event) => {
      if (disposed) return;
      if (event.data instanceof ArrayBuffer)
        term.write(new Uint8Array(event.data));
      else {
        let value;
        try {
          value = shellStatus(String(event.data));
        } catch {
          socket.close();
          onError(
            "Terminal status was not confirmed. Inspect the session before continuing.",
          );
          return;
        }
        if (value.truncated) term.writeln("\r\n[Earlier output was truncated]");
        if (value.exited)
          term.writeln(`\r\n[Shell exited: ${value.exitCode ?? "unknown"}]`);
        if (value.error) onError(value.error);
      }
    };
    socket.onopen = () => {
      connected = true;
      resize();
    };
    socket.onclose = () => {
      if (!disposed)
        onError(
          connected
            ? "Terminal disconnected. Input may have been delivered; open a new connection before continuing."
            : "Could not connect to the interactive terminal. Its runner must be attached to this dashboard.",
        );
    };
    const listener = term.onData((text) => {
      if (socket.readyState !== WebSocket.OPEN) {
        onError("Terminal is not connected; input was not sent.");
        return;
      }
      if (socket.bufferedAmount > 65536) {
        socket.close();
        onError(
          "Terminal input is blocked. Inspect the session before retrying.",
        );
        return;
      }
      send("shell-write", { text });
    });
    let dimensions = "";
    const resize = () => {
      if (!element.current?.clientWidth) return;
      fit.fit();
      const next = `${term.rows}:${term.cols}`;
      if (next !== dimensions && socket.readyState === WebSocket.OPEN) {
        dimensions = next;
        send("shell-resize", { rows: term.rows, cols: term.cols });
      }
    };
    const observer = new ResizeObserver(resize);
    observer.observe(terminalElement);
    resize();
    return () => {
      disposed = true;
      socket.close();
      observer.disconnect();
      listener.dispose();
      term.dispose();
    };
  }, [machine, session]);
  return (
    <div
      ref={element}
      className={
        active ? "h-full min-h-48 min-w-0 bg-neutral-950 p-3" : "hidden"
      }
      aria-label="Shell terminal"
    />
  );
}
