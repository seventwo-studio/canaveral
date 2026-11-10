import { createServer, type Server } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { ServiceError, fields, object, text } from "./common.ts";
import { WindowsGuestWorker } from "./worker.ts";
export interface WindowsGuestServerOptions {
  worker: WindowsGuestWorker;
  /** Assignment-scoped credential, delivered by trusted guest provisioning. */
  token: string;
  port?: number;
}
/** Explicit boot entrypoint for the assignment owner; binds loopback only. */
export async function startWindowsGuestServer(options: WindowsGuestServerOptions): Promise<{ server: Server; port: number; close(): Promise<boolean> }> {
  const token = text(options.token, 4096); if (Buffer.byteLength(token) < 32) throw new ServiceError("Windows guest requires an assignment-scoped secret.", 400);
  const expected = Buffer.from(`Bearer ${token}`);
  const server = createServer(async (req, res) => {
    const reply = (status: number, value: unknown): void => { const bytes = Buffer.from(JSON.stringify(value)); res.writeHead(status, { "Content-Type": "application/json", "Content-Length": bytes.length, "Cache-Control": "no-store" }); res.end(bytes); };
    const supplied = Buffer.from(req.headers.authorization ?? "");
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { reply(401, { error: "Credential rejected.", code: "unauthenticated" }); return; }
    try {
      if (req.headers["transfer-encoding"] || req.headers["content-encoding"]) throw new ServiceError("Use a bounded plain JSON request.", 400);
      let body: unknown = {};
      if (req.method === "POST") {
        const length = Number(req.headers["content-length"]); if (!Number.isSafeInteger(length) || length < 1 || length > 1000000) throw new ServiceError("Invalid Windows request size.", 400);
        const chunks: Buffer[] = []; let received = 0;
        for await (const part of req) { const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part as string); received += chunk.length; if (received > length) throw new ServiceError("Windows request exceeds its declared length.", 400); chunks.push(chunk); }
        if (received !== length) throw new ServiceError("Windows request was truncated.", 400);
        try { body = object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))) as unknown); } catch { throw new ServiceError("Invalid Windows JSON request.", 400); }
      }
      let path = req.url ?? "";
      if (path === "/control" && req.method === "POST") {
        const control = fields(body, ["action", "arguments"]); const args = object(control.arguments);
        const actions: Record<string, string> = { screenshot: "/v1/display/capture", accessibility: "/v1/accessibility/inspect", "accessibility-action": "/v1/accessibility/invoke", "shell-open": "/v1/shell/open", "shell-read": "/v1/shell/read", "shell-write": "/v1/shell/write", "shell-resize": "/v1/shell/resize", "shell-close": "/v1/shell/close" };
        if (typeof control.action !== "string" || !actions[control.action]) throw new ServiceError("Unsupported Windows control action.", 409, { code: "capability_unsupported" });
        path = actions[control.action]!; body = args;
        if (control.action === "shell-open") body = { cols: 80, rows: 24, ...args };
        if (control.action === "shell-read") body = { offset: 0, ...args };
      }
      reply(200, await options.worker.request(req.method ?? "", path, body));
    } catch (error) {
      const e = error instanceof ServiceError ? error : new ServiceError("Windows guest response is unconfirmed.", 503, { retryable: false });
      reply(e.status, { error: e.message, code: e.code, retryable: e.retryable, ...(e.outcome ? { outcome: e.outcome } : {}) });
    }
  });
  server.requestTimeout = 10000; server.headersTimeout = 10000;
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(options.port ?? 0, "127.0.0.1", () => { server.off("error", reject); resolve(); }); });
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Windows server has no TCP address");
  return { server, port: address.port, close: async () => { await new Promise<void>(resolve => { server.close(() => resolve()); server.closeIdleConnections(); }); return options.worker.close(); } };
}
