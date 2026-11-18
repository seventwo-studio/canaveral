import { request as httpsRequest } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";
import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { identifier } from "../consumers.ts";
import { secret, ServiceError } from "../errors.ts";
import { countHeader, readBody, requestTarget, respond } from "./http.ts";

const route = /^\/v1\/hosts\/([0-9a-f-]{36})\/browsers(?:\/([0-9a-f-]{36})(?:\/(stop|connect))?)?$/;
const browserHeaders = ["sec-websocket-key", "sec-websocket-version", "sec-websocket-protocol", "sec-websocket-extensions",
  "x-playwright-browser", "x-playwright-proxy"] as const;
const upgradeHeaders = ["sec-websocket-accept", "sec-websocket-protocol", "sec-websocket-extensions"] as const;

export interface BrowserGatewayConfig {
  origin: string;
  workers: Record<string, { origin: string; credentialFile: string }>;
}

function tlsOrigin(value: unknown): string {
  if (typeof value !== "string") throw new Error("Browser gateway requires HTTPS origins.");
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Browser gateway requires HTTPS origins without paths or credentials.");
  }
  return url.origin;
}

export function parseBrowserGateway(input: unknown): BrowserGatewayConfig {
  const value = input as BrowserGatewayConfig;
  if (!value || Object.keys(value).sort().join(",") !== "origin,workers" || !value.workers
    || typeof value.workers !== "object" || Array.isArray(value.workers)) throw new Error("Invalid browser gateway configuration.");
  const origin = tlsOrigin(value.origin);
  const workers = Object.entries(value.workers);
  if (!workers.length || workers.length > 32) throw new Error("Configure one to 32 browser workers.");
  const targets = new Set<string>();
  return { origin, workers: Object.fromEntries(workers.map(([id, worker]) => {
    if (!worker || Object.keys(worker).sort().join(",") !== "credentialFile,origin"
      || typeof worker.credentialFile !== "string" || !isAbsolute(worker.credentialFile)) throw new Error("Browser workers require an absolute credential file path.");
    const target = tlsOrigin(worker.origin);
    if (target === origin) throw new Error("Browser worker and gateway must have different origins.");
    if (targets.has(target)) throw new Error("Each browser worker belongs to one host.");
    targets.add(target);
    return [identifier(id), { origin: target, credentialFile: worker.credentialFile }];
  })) };
}

const digest = (value: string) => createHash("sha256").update(value).digest();

export function createBrowserGateway(config: BrowserGatewayConfig, otherCredentials: string[], canLaunch: (hostId: string) => Promise<boolean>) {
  const sockets = new Set<Duplex>();
  const credentials = new Set(otherCredentials);
  const workers = new Map(Object.entries(config.workers).map(([id, worker]) => {
    const credential = secret(readFileSync(worker.credentialFile, "utf8").trim());
    if (credentials.has(credential)) throw new Error("Browser application credentials must be dedicated to their worker.");
    credentials.add(credential);
    return [id, { ...worker, credential, digest: digest(credential) }];
  }));
  const attachments = new Map<string, { digest: Buffer; expiresAt: number }>();
  let pending = 0;
  function target(req: IncomingMessage) {
    const { path, query, token } = requestTarget(req);
    const match = route.exec(path);
    if (!match || [...query].length) throw new ServiceError("Unknown browser route.", 404);
    const [, host, browser, action] = match;
    const hostId = identifier(host);
    const worker = workers.get(hostId);
    if (!worker) throw new ServiceError("No browser worker is configured for this host.", 404);
    if (browser) identifier(browser);
    return { path, host: hostId, worker, browser, action, token: secret(token) };
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (pending >= 32) { req.resume(); respond(res, { error: "browser_gateway_busy" }, 429); return; }
    pending++;
    try {
      const { path, host, worker, browser, action, token } = target(req);
      if (!timingSafeEqual(worker.digest, digest(token))) throw new ServiceError("Browser application credential rejected.", 403);
      if (req.headers.expect !== undefined || req.headers.upgrade !== undefined || req.headers.trailer !== undefined) {
        throw new ServiceError("Invalid browser request framing.", 400);
      }
      const create = req.method === "POST" && !browser;
      const stop = req.method === "POST" && action === "stop";
      const inspect = req.method === "GET" && browser && !action;
      if (!create && !stop && !inspect) throw new ServiceError("Unknown browser route.", 404);
      if (inspect && (req.headers["transfer-encoding"] !== undefined || (req.headers["content-length"] ?? "0") !== "0")) {
        throw new ServiceError("Browser inspection takes no request body.", 400);
      }
      const body = create || stop ? await readBody(req, path, 4096) : undefined;
      const id = create ? identifier(body?.id) : browser!;
      if (create && body?.id !== id) throw new ServiceError("Use a canonical browser UUID.", 400);
      if (stop && Object.keys(body!).length) throw new ServiceError("Expected an empty object.", 400);
      if (create && !await canLaunch(host)) throw new ServiceError("Browser host is offline or draining.", 409);
      const endpoint = new URL(create ? "/v1/browsers" : `/v1/browsers/${id}`, worker.origin);
      const result = await fetch(endpoint, {
        method: create ? "POST" : stop ? "DELETE" : "GET", redirect: "error",
        headers: { authorization: `Bearer ${worker.credential}`, "content-type": "application/json" },
        ...(create ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15_000),
      });
      if (!result.ok) {
        await result.body?.cancel();
        respond(res, { error: "browser_worker_refused" }, [400, 403, 404, 409, 410, 413, 429].includes(result.status) ? result.status : 503);
        return;
      }
      const reader = result.body?.getReader();
      if (!reader) throw new Error("Empty browser response.");
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      for (;;) {
        const item = await reader.read();
        if (item.done) break;
        bytes += item.value.length;
        if (bytes > 8192) { await reader.cancel(); throw new Error("Browser receipt exceeds the response limit."); }
        chunks.push(item.value);
      }
      const receipt = JSON.parse(Buffer.concat(chunks).toString());
      if (receipt.id !== id) throw new Error("Browser receipt identity mismatch.");
      if (stop) {
        if (receipt.state !== "closed") throw new Error("Browser cleanup was not confirmed.");
        attachments.delete(`${host}/${id}`);
        respond(res, { id, state: "closed" });
        return;
      }
      const expectedWorker = new URL(`/v1/browsers/${id}/connect`, worker.origin);
      expectedWorker.protocol = "wss:";
      const browserEndpoint = new URL(`${create ? path + "/" + id : path}/connect`, config.origin);
      browserEndpoint.protocol = "wss:";
      const now = Date.now(), expiresAt = Date.parse(receipt.expiresAt), key = secret(receipt.key);
      if (receipt.endpoint !== expectedWorker.href || !["chromium", "firefox", "webkit"].includes(receipt.engine)
        || !Number.isFinite(expiresAt) || expiresAt <= now || expiresAt - now > 3_600_000) throw new Error("Invalid worker browser receipt.");
      for (const [id, attachment] of attachments) if (attachment.expiresAt <= now) attachments.delete(id);
      if (attachments.size >= 2048 && !attachments.has(`${host}/${id}`)) throw new Error("Browser attachment capacity reached.");
      attachments.set(`${host}/${id}`, { digest: digest(key), expiresAt });
      respond(res, { id, engine: receipt.engine, expiresAt: receipt.expiresAt, endpoint: browserEndpoint.href, key }, result.status);
    } catch (error) {
      req.resume();
      respond(res, { error: "browser_gateway_request_failed" }, error instanceof ServiceError ? error.status : 503);
    } finally { pending--; }
  }

  function upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    try {
      const { host, worker, browser, action, token } = target(req);
      if (action !== "connect" || !browser || sockets.size >= 128) throw new Error("Browser attachment refused.");
      const attachment = attachments.get(`${host}/${browser}`);
      if (!attachment || Date.now() >= attachment.expiresAt || !timingSafeEqual(attachment.digest, digest(token))) throw new Error("Browser attachment refused.");
      if (req.method !== "GET" || req.httpVersion !== "1.1" || req.headers["content-length"] !== undefined
        || req.headers["transfer-encoding"] !== undefined || req.headers.expect !== undefined || req.headers.trailer !== undefined
        || countHeader(req, "upgrade") !== 1 || req.headers.upgrade?.toLowerCase() !== "websocket"
        || countHeader(req, "connection") !== 1 || !req.headers.connection?.split(",").some(value => value.trim().toLowerCase() === "upgrade")
        || req.headers["sec-websocket-version"] !== "13" || countHeader(req, "sec-websocket-version") !== 1
        || countHeader(req, "sec-websocket-key") !== 1 || !/^[A-Za-z0-9+/]{22}==$/.test(req.headers["sec-websocket-key"] ?? "")
        || browserHeaders.some(name => countHeader(req, name) > 1)) throw new Error("Invalid browser WebSocket upgrade.");
      sockets.add(socket);
      const headers: Record<string, string> = { authorization: `Bearer ${token}`, upgrade: "websocket", connection: "Upgrade" };
      for (const name of browserHeaders) if (typeof req.headers[name] === "string") headers[name] = req.headers[name];
      const request = httpsRequest(new URL(`/v1/browsers/${browser}/connect`, worker.origin), { headers, timeout: 10_000 });
      const fail = () => { socket.destroy(); request.destroy(); };
      socket.on("error", fail);
      socket.once("close", () => { sockets.delete(socket); request.destroy(); });
      request.once("error", fail);
      request.once("timeout", fail);
      request.once("response", response => { response.resume(); socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); });
      request.once("upgrade", (response, peer, first) => {
        request.setTimeout(0);
        (socket as Socket).setTimeout(0);
        peer.setTimeout(0);
        peer.on("error", fail);
        peer.once("close", () => socket.destroy());
        socket.once("close", () => peer.destroy());
        const negotiated = upgradeHeaders.flatMap(name => typeof response.headers[name] === "string" ? [`${name}: ${response.headers[name]}`] : []);
        socket.write(["HTTP/1.1 101 Switching Protocols", "Upgrade: websocket", "Connection: Upgrade", ...negotiated, "", ""].join("\r\n"));
        if (head.length) peer.write(head);
        if (first.length) socket.write(first);
        socket.pipe(peer).pipe(socket);
      });
      request.end();
    } catch { socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); }
  }

  return {
    matches: (req: IncomingMessage) => route.test((req.url ?? "").split("?")[0]!),
    handle, upgrade, close: () => { for (const socket of sockets) socket.destroy(); },
  };
}
