import { readFileSync } from "node:fs";
import type { Server } from "node:https";
import { createSecureContext } from "node:tls";

type Files = { certFile: string; keyFile: string };

export function controllerTLS(files: Files) {
  return { cert: readFileSync(files.certFile), key: readFileSync(files.keyFile), minVersion: "TLSv1.2" as const };
}

/** Follow renewed mounted files, including Kubernetes atomic Secret updates. */
export function controllerTLSReloader(server: Server, files: Files, initial: ReturnType<typeof controllerTLS>,
  report: (message: string) => void = message => process.stderr.write(message + "\n")) {
  let active = initial, closed = false, warned = false;
  const refresh = () => {
    if (closed) return;
    try {
      const next = controllerTLS(files);
      if (next.cert.equals(active.cert) && next.key.equals(active.key)) return;
      // Validate the complete pair before replacing a working context. A partial
      // mount update retains the current certificate and is retried next time.
      createSecureContext(next);
      server.setSecureContext(next);
      active = next;
      warned = false;
    } catch {
      if (!warned) report("Controller TLS renewal could not be loaded; retaining the current certificate.");
      warned = true;
    }
  };
  const timer = setInterval(refresh, 10_000);
  timer.unref();
  return { refresh, close() { closed = true; clearInterval(timer); } };
}
