/** Stateless browser gateway. Credentials and native transports never live in assets. */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer, request as httpRequest, ServerResponse } from "node:http";
import type { IncomingMessage, Server } from "node:http";
import { request as httpsRequest } from "node:https";
import type { AddressInfo, Socket } from "node:net";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import { join, posix } from "node:path";

// Keep this optional gateway usable with Node's strip-only TypeScript loader;
// it deliberately has no runtime dependency on controller workers or storage.
export class DashboardError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;
  readonly outcome: "unknown" | undefined;
  constructor(message: string, status: number, options: { code?: string; retryable?: boolean; outcome?: "unknown" } = {}) {
    super(message); this.status = status;
    this.code = options.code ?? ({ 400: "invalid_request", 401: "unauthenticated", 403: "forbidden", 404: "not_found", 409: "conflict", 413: "payload_too_large", 429: "limit_exceeded", 503: "unavailable" } as Record<number, string>)[status] ?? "request_failed";
    this.retryable = options.retryable ?? false; this.outcome = options.outcome;
  }
}
function secret(value: unknown): string {
  if (typeof value !== "string" || /^[A-Za-z0-9_-]{43,128}$/.exec(value)?.[0] !== value) throw new DashboardError("Invalid credential or session response.", 400);
  return value;
}
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new DashboardError("Expected a JSON object.", 400);
  return value as Record<string, unknown>;
}

const shutdownStreams = new WeakMap<Server, () => void>();
const SESSION_SECONDS = 30 * 24 * 60 * 60;
const UUID = "[a-f0-9-]{36}";
type Awaitable<T> = T | Promise<T>;
export type Authorization = () => Promise<boolean>;
export interface DownloadSource {
  size: number;
  read(size: number): Awaitable<Uint8Array>;
  verify(): Awaitable<void>;
  close(): Awaitable<void>;
}
export interface UploadRequest {
  machineId: string; path: string; app: string | undefined; size: number;
  reader: AuthorizedReader; authorized: Authorization;
}
export interface ImageImportRequest {
  hostId: string; metadata: Record<string, unknown>; size: number;
  reader: AuthorizedReader; authorized: Authorization;
}
/** Native WebSocket adapters own protocol framing and must fence every read/write
 * with authorized(), including after blocking I/O. The gateway also cancels idle
 * transports on revocation. No native adapter is installed by default. */
export interface StreamAttachment {
  machineId: string; sessionId: string | undefined; request: IncomingMessage;
  socket: Duplex; head: Buffer; authorized: Authorization; signal: AbortSignal;
}
export interface DashboardConnectors {
  upload?: { check(machineId: string): Awaitable<boolean>; write(request: UploadRequest): Awaitable<unknown> };
  download?: { check(machineId: string): Awaitable<boolean>; open(machineId: string, path: string, app: string | undefined): Awaitable<DownloadSource> };
  accessibility?: (machineId: string) => Awaitable<unknown>;
  imageImport?: { check(hostId: string): Awaitable<boolean>; write(request: ImageImportRequest): Awaitable<unknown> };
  desktop?: { check(machineId: string): Awaitable<boolean>; attach(request: StreamAttachment): Awaitable<void> };
  shell?: { check(machineId: string): Awaitable<boolean>; attach(request: StreamAttachment): Awaitable<void> };
}
export interface DashboardConfig {
  orchestratorUrl: string;
  listen?: { host: string; port: number };
  allowHttp?: boolean;
  bootstrapToken?: string;
  bootstrapTokenFile?: string;
  caFile?: string;
  assetsDirectory?: string;
  reloadAssets?: boolean;
  connectors?: DashboardConnectors;
  /** At most one second; every transfer block also reauthorizes independently. */
  reauthorizeMs?: number;
}

function loopbackHost(host: string): boolean { return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(host); }
function loopbackPeer(host: string | undefined): boolean {
  return host === "::1" || /^(?:127\.|::ffff:127\.)/.test(host ?? "");
}
function upstreamOrigin(value: string, allowHttp: boolean): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new DashboardError("Use an orchestrator origin URL.", 400); }
  if (url.username || url.password || url.search || url.hash || !["", "/"].includes(url.pathname) ||
      value.includes("?") || value.includes("#")) throw new DashboardError("Use an orchestrator origin URL without credentials, query or path.", 400);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && (allowHttp || loopbackHost(url.hostname)))) {
    throw new DashboardError("Remote orchestrators require HTTPS; explicitly allow HTTP only on a trusted private network.", 400);
  }
  return url;
}
function headerValues(request: IncomingMessage, name: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < request.rawHeaders.length; i += 2) if (request.rawHeaders[i]!.toLowerCase() === name) values.push(request.rawHeaders[i + 1]!);
  return values;
}
function oneHeader(request: IncomingMessage, name: string): string | undefined {
  const values = headerValues(request, name);
  if (values.length > 1) throw new DashboardError(`Ambiguous ${name}.`, 400);
  return values[0];
}
function contentLength(request: IncomingMessage, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  const value = oneHeader(request, "content-length");
  if (request.headers["transfer-encoding"] !== undefined || value === undefined || !/^\d+$/.test(value)) {
    throw new DashboardError("A single valid Content-Length is required.", 400);
  }
  const size = Number(value);
  if (!Number.isSafeInteger(size) || size < minimum || size > maximum) throw new DashboardError("Request body exceeds the endpoint's size limit.", 413);
  return size;
}
function decodeJson(data: Uint8Array): Record<string, unknown> {
  try { return object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data))); }
  catch { throw new DashboardError("Expected a valid JSON object.", 400); }
}
function unknownOutcome(message: string): DashboardError {
  return new DashboardError(message, 503, { retryable: false, outcome: "unknown" });
}

/** Reader fences both sides of a blocking read, never releasing late private bytes. */
export class AuthorizedReader {
  readonly source: { read(size: number): Awaitable<Uint8Array> };
  readonly authorized: Authorization;
  constructor(source: { read(size: number): Awaitable<Uint8Array> }, authorized: Authorization) { this.source = source; this.authorized = authorized; }
  async read(size: number): Promise<Uint8Array> {
    if (!await this.authorized()) throw new DashboardError("Transfer authorization ended.", 401);
    const data = await this.source.read(size);
    if (!await this.authorized()) throw new DashboardError("Transfer authorization ended.", 401);
    return data;
  }
}
/** Socket-like fence available to attached display adapters. */
export class AuthorizedRemote {
  readonly remote: { recv(size: number): Awaitable<Uint8Array>; sendall(data: Uint8Array): Awaitable<void> };
  readonly authorized: Authorization;
  constructor(remote: AuthorizedRemote["remote"], authorized: Authorization) { this.remote = remote; this.authorized = authorized; }
  async recv(size: number): Promise<Uint8Array> {
    if (!await this.authorized()) throw new DashboardError("Connection authorization ended.", 401);
    const data = await this.remote.recv(size);
    if (!await this.authorized()) throw new DashboardError("Connection authorization ended.", 401);
    return data;
  }
  async sendall(data: Uint8Array): Promise<void> {
    if (!await this.authorized()) throw new DashboardError("Connection authorization ended.", 401);
    await this.remote.sendall(data);
  }
}
export class AuthorizedChannel {
  readonly channel: {
    sendBytes(data: Uint8Array): Awaitable<void>; sendControl(value: unknown): Awaitable<void>;
    receive(timeoutMs: number): Awaitable<unknown>;
  };
  readonly authorized: Authorization;
  constructor(channel: AuthorizedChannel["channel"], authorized: Authorization) { this.channel = channel; this.authorized = authorized; }
  private async check(): Promise<void> { if (!await this.authorized()) throw new DashboardError("Display authorization ended.", 401); }
  async sendBytes(data: Uint8Array): Promise<void> { await this.check(); await this.channel.sendBytes(data); }
  async sendControl(value: unknown): Promise<void> { await this.check(); await this.channel.sendControl(value); }
  async receive(timeoutMs = 250): Promise<unknown> {
    await this.check(); const value = await this.channel.receive(Math.min(timeoutMs, 250)); await this.check(); return value;
  }
}

/** Read exactly the declared body, with bounded buffering and no total file-size cap. */
class RequestReader {
  private iterator: AsyncIterator<Buffer>;
  private pending = Buffer.alloc(0);
  remaining: number;
  constructor(request: IncomingMessage, size: number) { this.iterator = request[Symbol.asyncIterator]() as AsyncIterator<Buffer>; this.remaining = size; }
  async read(size: number): Promise<Uint8Array> {
    if (!Number.isSafeInteger(size) || size < 1) throw new DashboardError("Invalid read size.", 400);
    if (this.remaining === 0) return Buffer.alloc(0);
    if (!this.pending.length) {
      const next = await this.iterator.next();
      if (next.done) throw new DashboardError("Incomplete request.", 400);
      this.pending = Buffer.from(next.value);
    }
    if (this.pending.length > this.remaining) throw new DashboardError("Body exceeds its declared length.", 400);
    const length = Math.min(size, this.pending.length, this.remaining);
    const data = this.pending.subarray(0, length);
    this.pending = this.pending.subarray(length); this.remaining -= length;
    return data;
  }
}

const staticFiles: Record<string, [string, string]> = {
  "/": ["index.html", "text/html; charset=utf-8"], "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/style.css": ["style.css", "text/css; charset=utf-8"], "/favicon.svg": ["favicon.svg", "image/svg+xml"],
  "/launch.jpg": ["launch.jpg", "image/jpeg"], "/geist-mono.woff2": ["geist-mono.woff2", "font/woff2"],
  "/licenses.txt": ["licenses.txt", "text/plain; charset=utf-8"],
};
function routeAllowed(method: string, route: string): boolean {
  if (method === "GET" && new RegExp(`^/api/v1/updates/(?:releases|rollouts)(?:/${UUID})?$`).test(route)) return true;
  if (method === "POST" && (route === "/api/v1/updates/releases" || route === "/api/v1/updates/rollouts" || new RegExp(`^/api/v1/updates/rollouts/${UUID}/cancel$`).test(route))) return true;
  if (method === "GET") return ["/api/v1/auth/status", "/api/v1/auth/session", "/api/v1/auth/tokens", "/api/v1/users", "/api/v1/admin/tokens",
    "/api/v1/hosts", "/api/v1/machines", "/api/v1/templates", "/api/v1/connection-setups", "/api/v1/images", "/api/v1/image-tasks", "/api/v1/image-registry"].includes(route) ||
    new RegExp(`^/api/v1/(?:image-tasks/${UUID}|hosts/${UUID}/resources|operations/${UUID}|machines/${UUID}(?:/(?:accessibility|desktop|files/download/[A-Za-z0-9_-]+|shells/${UUID}/stream))?)$`).test(route);
  if (method === "POST") return ["/api/v1/auth/login", "/api/v1/auth/setup", "/api/v1/auth/claim", "/api/v1/auth/claim/info", "/api/v1/auth/logout",
    "/api/v1/auth/password", "/api/v1/auth/tokens", "/api/v1/users", "/api/v1/machines", "/api/v1/connection-setups", "/api/v1/images/captures", "/api/v1/image-registry/imports"].includes(route) ||
    new RegExp(`^/api/v1/(?:(?:auth|admin)/tokens/${UUID}/revoke|users/${UUID}/(?:update|invite|reset-password|revoke-invite)|machines/${UUID}/(?:desired|operations|power-off|delete|authorize|files/upload)|hosts/${UUID}/(?:accepting|checks|limits|images/import)|connection-setups/${UUID}/revoke)$`).test(route);
  return false;
}

/** Creates an unbound gateway. Upstream and assets are fixed at startup. No live state is discovered. */
export function createDashboardServer(config: DashboardConfig): Server {
  const origin = upstreamOrigin(config.orchestratorUrl, config.allowHttp ?? false);
  if (config.bootstrapToken !== undefined && config.bootstrapTokenFile !== undefined) throw new DashboardError("Choose one bootstrap credential source.", 400);
  const bootstrapToken = config.bootstrapTokenFile === undefined ? config.bootstrapToken : readFileSync(config.bootstrapTokenFile, "utf8").replace(/\r?\n$/, "");
  if (bootstrapToken !== undefined) secret(bootstrapToken);
  if (config.caFile !== undefined && origin.protocol !== "https:") throw new DashboardError("A CA file requires an HTTPS origin.", 400);
  const ca = config.caFile === undefined ? undefined : readFileSync(config.caFile);
  const sourceAssets = fileURLToPath(new URL("../../canaveral/web/", import.meta.url));
  const assetDirectory = config.assetsDirectory ?? (existsSync(sourceAssets) ? sourceAssets : fileURLToPath(new URL("../../../canaveral/web/", import.meta.url)));
  const assets = new Map(Object.entries(staticFiles).map(([route, [name, kind]]) => [route, { name, kind, data: readFileSync(join(assetDirectory, name)) }]));
  const connectors = config.connectors ?? {};
  const intervalMs = config.reauthorizeMs ?? 1000;
  if (!Number.isInteger(intervalMs) || intervalMs < 1 || intervalMs > 1000) throw new DashboardError("Reauthorization interval must be 1–1000 ms.", 400);

  async function upstream(method: string, path: string, token: string, value?: Record<string, unknown>): Promise<{ body: Record<string, unknown>; status: number }> {
    const mutating = method !== "GET";
    const data = value === undefined ? undefined : Buffer.from(JSON.stringify(value));
    return await new Promise((resolve, reject) => {
      const request = (origin.protocol === "https:" ? httpsRequest : httpRequest)(new URL(path, origin), {
        method, ...(ca === undefined ? {} : { ca }),
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(data === undefined ? {} : { "Content-Length": data.length }) },
      }, response => {
        const chunks: Buffer[] = []; let bytes = 0;
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 8 * 1048576) { response.destroy(); reject(new DashboardError("Orchestrator response exceeds its control-message limit.", 502, { retryable: false, ...(mutating ? { outcome: "unknown" } : {}) })); }
          else chunks.push(chunk);
        });
        response.on("error", fail);
        response.on("end", () => {
          const status = response.statusCode ?? 502;
          if (status >= 300 && status < 400) { reject(new DashboardError("Orchestrator redirects are not followed.", 502, { retryable: false, ...(mutating ? { outcome: "unknown" } : {}) })); return; }
          let body: Record<string, unknown>;
          try { body = decodeJson(Buffer.concat(chunks)); }
          catch { reject(new DashboardError("Orchestrator returned an invalid JSON response. Inspect state before another mutation.", 502, { code: "response_invalid", retryable: false, ...(mutating ? { outcome: "unknown" } : {}) })); return; }
          if (status >= 400) { reject(new DashboardError(typeof body.error === "string" ? body.error : typeof body.message === "string" ? body.message : "Orchestrator request failed.", status, {
            ...(typeof body.code === "string" ? { code: body.code } : {}),
            retryable: typeof body.retryable === "boolean" ? body.retryable : !mutating && status === 503,
            ...(body.outcome === "unknown" ? { outcome: "unknown" } : {}),
          })); return; }
          resolve({ body, status });
        });
      });
      function fail(): void { reject(new DashboardError(mutating ? "Orchestrator response was not confirmed. Inspect the existing request before another mutation." : "Orchestrator response was not confirmed.", 503, { retryable: !mutating, ...(mutating ? { outcome: "unknown" } : {}) })); }
      request.setTimeout(20_000, () => { request.destroy(); fail(); });
      request.on("error", fail); request.end(data);
    });
  }

  let inFlight = 0;
  async function handle(request: IncomingMessage, response: ServerResponse, upgrade?: { socket: Duplex; head: Buffer; release(): void }): Promise<void> {
    let cookie: string | undefined;
    let host = "";
    let streamStarted = false;
    const method = request.method ?? "";
    const setCookie = (token: string, clear = false) => {
      cookie = `canaveral_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${clear ? 0 : SESSION_SECONDS}${loopbackHost(host) ? "" : "; Secure"}`;
    };
    const respond = (value: unknown, status = 200, kind = "application/json") => {
      if (response.destroyed) return;
      const nonce = randomBytes(24).toString("base64url");
      let data = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
      if (kind.startsWith("text/html")) data = Buffer.from(data.toString("utf8").replaceAll("CANAVERAL_CSP_NONCE", nonce));
      response.writeHead(status, {
        "Content-Type": kind, "Content-Length": data.length, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY", "Connection": "close",
        "Content-Security-Policy": `default-src 'none'; script-src 'self'; style-src 'self' 'nonce-${nonce}'; style-src-attr 'unsafe-inline'; font-src 'self'; img-src 'self' blob: data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`,
        ...(cookie === undefined ? {} : { "Set-Cookie": cookie }), ...(status === 429 ? { "Retry-After": "60" } : {}),
      });
      response.end(data);
    };
    try {
      const route = request.url ?? "";
      if (!route.startsWith("/") || route.startsWith("//") || /[?#\\]/.test(route)) throw new DashboardError("Use a dashboard path without a query.", 400);
      if (!upgrade && method === "GET") {
        const asset = assets.get(route);
        if (asset) { respond(config.reloadAssets ? readFileSync(join(assetDirectory, asset.name)) : asset.data, 200, asset.kind); return; }
        if (route === "/healthz") { respond({ ok: true }); return; }
      }
      if (!routeAllowed(method, route)) throw new DashboardError("Unknown dashboard endpoint.", 404);
      const hostHeader = oneHeader(request, "host"), browserOrigin = oneHeader(request, "origin");
      if (!hostHeader || !/^(?:\[[a-fA-F0-9:]+\]|[A-Za-z0-9.-]+)(?::\d{1,5})?$/.test(hostHeader)) throw new DashboardError("Ambiguous browser origin.", 400);
      const hostUrl = new URL(`http://${hostHeader}`); host = hostUrl.hostname;
      if ((browserOrigin !== undefined && ![`http://${hostHeader}`, `https://${hostHeader}`].includes(browserOrigin)) ||
          ["cross-site", "same-site"].includes(oneHeader(request, "sec-fetch-site") ?? "")) throw new DashboardError("Cross-origin requests are not supported.", 403);
      const localSetup = bootstrapToken !== undefined && loopbackPeer(request.socket.remoteAddress) && loopbackHost(host);
      const authorization = oneHeader(request, "authorization");
      const cookies = headerValues(request, "cookie").join(";").split(";").map(part => part.trim()).filter(part => part.startsWith("canaveral_session="));
      if (cookies.length > 1) throw new DashboardError("Ambiguous session cookie.", 400);
      const cookieToken = cookies[0]?.slice("canaveral_session=".length).replace(/^"(.*)"$/, "$1") ?? "";
      if (authorization !== undefined && cookieToken) throw new DashboardError("Mixed cookie and bearer credentials are forbidden.", 400);
      const publicLogin = route === "/api/v1/auth/login" || route === "/api/v1/auth/claim" || route === "/api/v1/auth/claim/info";
      const authStatus = route === "/api/v1/auth/status";
      const setup = route === "/api/v1/auth/setup";
      let token = "";
      if (setup) {
        if (!localSetup) throw new DashboardError("Create the first administrator from localhost with an operator credential file configured.", 403);
        token = bootstrapToken!;
      } else if (!publicLogin) {
        if (authorization !== undefined) {
          if (!authorization.startsWith("Bearer ")) throw new DashboardError("Administrator credential required.", 401);
          token = authorization.slice(7);
        } else {
          token = cookieToken;
          if (token && method === "POST" && browserOrigin === undefined) throw new DashboardError("Same-origin Origin is required for cookie requests.", 403);
        }
        if (token || !authStatus) {
          try { secret(token); } catch { throw new DashboardError("Administrator credential rejected.", 401); }
        }
      }
      async function authorizeMachine(machineId: string): Promise<void> {
        const { body } = await upstream("POST", `/v1/machines/${machineId}/authorize`, token, { action: "access" });
        if (body.authorized !== true || body.machineId !== machineId || body.action !== "access") throw new DashboardError("Machine authorization response did not match the request.", 403);
      }
      function authorizationCheck(machineId: string, check: () => Awaitable<boolean>): Authorization {
        return async () => {
          try {
            await authorizeMachine(machineId);
            if (await check() !== true) return false;
            // A native/provider availability check can itself block.
            await authorizeMachine(machineId);
            return true;
          } catch { return false; }
        };
      }
      /** Periodic revalidation also handles blocked/idle sources. Per-I/O fences
       * remain required because a revocation can race the periodic observation. */
      async function guarded<T>(authorized: Authorization, work: (signal: AbortSignal) => Promise<T>, cancel?: () => Awaitable<void>): Promise<T> {
        const abort = new AbortController(); let checking = false;
        let rejectLost: (error: Error) => void = () => {};
        const lost = new Promise<never>((_, reject) => { rejectLost = reject; });
        const timer = setInterval(() => {
          if (checking) return;
          checking = true;
          void authorized().then(ok => {
            if (!ok && !abort.signal.aborted) {
              abort.abort(); rejectLost(new DashboardError("Connection authorization ended.", 401));
              if (cancel) void Promise.resolve().then(cancel).catch(() => {});
            }
          }).finally(() => { checking = false; });
        }, intervalMs);
        timer.unref();
        try { return await Promise.race([work(abort.signal), lost]); }
        finally { clearInterval(timer); abort.abort(); }
      }
      const machineRoute = new RegExp(`^/api/v1/machines/(${UUID})/(accessibility|desktop|files/upload|files/download/([A-Za-z0-9_-]+)|shells/(${UUID})/stream)$`).exec(route);
      if (machineRoute) {
        const machineId = machineRoute[1]!, action = machineRoute[2]!;
        // Exact authority is established before any connector, even a check call.
        await authorizeMachine(machineId);
        if (action === "accessibility") {
          if (!connectors.accessibility) throw new DashboardError("Live inspection is not attached to this dashboard.", 409);
          const value = await connectors.accessibility(machineId); await authorizeMachine(machineId); respond(value); return;
        }
        if (action === "desktop" || action.startsWith("shells/")) {
          const connector = action === "desktop" ? connectors.desktop : connectors.shell;
          if (!connector) throw new DashboardError("No interactive transport is attached to this dashboard.", 409);
          if (!upgrade || !browserOrigin || oneHeader(request, "upgrade")?.toLowerCase() !== "websocket") throw new DashboardError("A same-origin WebSocket is required.", 403);
          const key = oneHeader(request, "sec-websocket-key");
          if (request.httpVersion !== "1.1" || oneHeader(request, "sec-websocket-version") !== "13" ||
              !key || !/^[A-Za-z0-9+/]{22}==$/.test(key) || Buffer.from(key, "base64").length !== 16 ||
              !oneHeader(request, "connection")?.split(",").some(value => value.trim().toLowerCase() === "upgrade") ||
              request.headers["content-length"] !== undefined || request.headers["transfer-encoding"] !== undefined || request.headers.expect !== undefined) {
            throw new DashboardError("Invalid WebSocket upgrade.", 400);
          }
          const authorized = authorizationCheck(machineId, () => connector.check(machineId));
          if (!await authorized()) throw new DashboardError("Connection authorization ended.", 401);
          // Attachments do not occupy the bounded short-request pool.
          streamStarted = true;
          upgrade.release();
          (upgrade.socket as Socket).setTimeout(0);
          await guarded(authorized, async signal => {
            let closed = () => {};
            const disconnected = new Promise<void>(resolve => { closed = resolve; upgrade.socket.once("close", closed); });
            try { await Promise.race([connector.attach({ machineId, sessionId: machineRoute[5], request, socket: upgrade.socket, head: upgrade.head, authorized, signal }), disconnected]); }
            finally { upgrade.socket.off("close", closed); }
          }, () => { upgrade.socket.destroy(); });
          upgrade.socket.end(); return;
        }
        if (action === "files/upload") {
          const connector = connectors.upload;
          if (!connector) throw new DashboardError("Streaming uploads are not attached to this dashboard.", 409);
          const size = contentLength(request);
          let target: string;
          try { target = decodeURIComponent(oneHeader(request, "x-canaveral-path") ?? ""); } catch { throw new DashboardError("Choose a guest destination path.", 400); }
          if (!target || target.length > 4096 || target.includes("\0")) throw new DashboardError("Choose a guest destination path.", 400);
          const app = oneHeader(request, "x-canaveral-app");
          const authorized = authorizationCheck(machineId, () => connector.check(machineId));
          if (!await authorized()) throw new DashboardError("Transfer authorization ended.", 401);
          const source = new RequestReader(request, size);
          let value: unknown;
          try {
            value = await guarded(authorized, async () => connector.write({ machineId, path: target, app, size, reader: new AuthorizedReader(source, authorized), authorized }));
          } catch (error) {
            if (error instanceof DashboardError && error.status === 401) throw unknownOutcome("Upload authorization ended. Publication may have occurred; inspect state before another upload.");
            throw error;
          }
          if (source.remaining !== 0 || !await authorized()) throw unknownOutcome("Upload completion was not confirmed. Inspect state before another upload.");
          respond(value); return;
        }
        const connector = connectors.download;
        if (!connector) throw new DashboardError("Streaming downloads are not attached to this dashboard.", 409);
        const encoded = machineRoute[3]!;
        if (encoded.length > 8192 || encoded.length % 4 === 1) throw new DashboardError("Invalid download path.", 400);
        const options = decodeJson(Buffer.from(encoded, "base64url"));
        if (typeof options.path !== "string" || !options.path || options.path.includes("\0") || (options.app !== undefined && typeof options.app !== "string")) throw new DashboardError("Invalid guest path.", 400);
        const authorized = authorizationCheck(machineId, () => connector.check(machineId));
        if (!await authorized()) throw new DashboardError("Download authorization ended.", 401);
        const source = await connector.open(machineId, options.path, options.app as string | undefined);
        let closing: Promise<void> | undefined;
        const closeSource = () => closing ??= Promise.resolve().then(() => source.close());
        try {
          await guarded(authorized, async () => {
            if (!Number.isSafeInteger(source.size) || source.size < 0) throw new DashboardError("Invalid download source size.", 409);
            await source.verify();
            if (!await authorized()) throw new DashboardError("Download authorization ended.", 401);
            response.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": source.size,
              "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(posix.basename(options.path as string)).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)}`,
              "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Connection": "close" });
            streamStarted = true;
            let remaining = source.size;
            while (remaining) {
              if (!await authorized()) throw new DashboardError("Download authorization ended.", 401);
              const limit = Math.min(1048576, remaining), data = await source.read(limit);
              if (!data.length || data.length > limit) throw new DashboardError("Download source did not match its declared size.", 409);
              if (data.length === remaining) await source.verify();
              if (!await authorized()) throw new DashboardError("Download authorization ended.", 401);
              if (response.destroyed) return;
              if (!response.write(data)) await new Promise<void>((resolve, reject) => {
                const done = () => { response.off("close", closed); resolve(); };
                const closed = () => { response.off("drain", done); reject(new DashboardError("Download disconnected.", 409)); };
                response.once("drain", done); response.once("close", closed);
              });
              remaining -= data.length;
            }
            response.end();
          }, async () => { if (streamStarted) response.destroy(); await closeSource(); });
        } finally { await closeSource(); }
        return;
      }
      const imageUpload = new RegExp(`^/api/v1/hosts/(${UUID})/images/import$`).exec(route);
      if (imageUpload) {
        // Host inventory is privileged; establish current admin scope first.
        await upstream("GET", "/v1/hosts", token);
        const connector = connectors.imageImport;
        if (!connector) throw new DashboardError("Image imports require an attached host.", 409);
        if (request.headers["content-type"]?.split(";", 1)[0]?.trim() !== "application/octet-stream") throw new DashboardError("Image imports require a raw file body.", 415);
        const size = contentLength(request, 512), metadataHeader = oneHeader(request, "x-canaveral-image");
        if (!metadataHeader || metadataHeader.length > 16384) throw new DashboardError("Supply bounded image metadata.", 400);
        let metadata: Record<string, unknown>;
        try { metadata = decodeJson(Buffer.from(decodeURIComponent(metadataHeader))); } catch { throw new DashboardError("Invalid image metadata.", 400); }
        const hostId = imageUpload[1]!;
        const authorized: Authorization = async () => {
          try {
            await upstream("GET", "/v1/hosts", token);
            if (await connector.check(hostId) !== true) return false;
            await upstream("GET", "/v1/hosts", token);
            return true;
          } catch { return false; }
        };
        if (!await authorized()) throw new DashboardError("Image import authorization ended.", 401);
        const source = new RequestReader(request, size);
        let value: unknown;
        try { value = await guarded(authorized, async () => connector.write({ hostId, metadata, size, reader: new AuthorizedReader(source, authorized), authorized })); }
        catch (error) { if (error instanceof DashboardError && error.status === 401) throw unknownOutcome("Image import authorization ended. Inspect the original import before another mutation."); throw error; }
        if (source.remaining !== 0 || !await authorized()) throw unknownOutcome("Image import completion was not confirmed. Inspect the original import.");
        respond(value); return;
      }
      if (upgrade) throw new DashboardError("Unknown dashboard WebSocket endpoint.", 404);
      let value: Record<string, unknown> | undefined;
      if (method === "POST") {
        if (request.headers["content-type"]?.split(";", 1)[0]?.trim() !== "application/json") throw new DashboardError("Expected application/json.", 415);
        const size = contentLength(request, 1, 1048576), source = new RequestReader(request, size), chunks: Uint8Array[] = [];
        while (source.remaining) chunks.push(await source.read(Math.min(65536, source.remaining)));
        value = decodeJson(Buffer.concat(chunks));
      }
      if (route === "/api/v1/auth/logout") setCookie("", true);
      const result = await upstream(method, route.slice(4), token, value);
      if (route === "/api/v1/connection-setups") result.body.controllerUrl = origin.origin;
      if (["/api/v1/auth/login", "/api/v1/auth/setup", "/api/v1/auth/claim"].includes(route)) {
        let sessionToken: string;
        try { sessionToken = secret(result.body.token); }
        catch { throw new DashboardError("Orchestrator returned an invalid session response. Inspect account state before another mutation.", 502, { code: "response_invalid", retryable: false, outcome: "unknown" }); }
        delete result.body.token; setCookie(sessionToken);
      }
      if (authStatus) {
        result.body.setupAllowed = localSetup;
        if (token) {
          try { Object.assign(result.body, (await upstream("GET", "/v1/auth/session", token)).body); }
          catch (error) { if (!(error instanceof DashboardError) || error.status !== 401) throw error; setCookie("", true); }
        }
      }
      respond(result.body, result.status);
    } catch (error) {
      if (streamStarted || response.headersSent) { if (upgrade) upgrade.socket.destroy(); else response.destroy(); return; }
      const failure = error instanceof DashboardError ? error : new DashboardError("Dashboard service or attached provider unavailable.", 503, { retryable: false, ...(method === "POST" ? { outcome: "unknown" } : {}) });
      if (failure.status === 401) setCookie("", true);
      respond({ error: failure.message, code: failure.code, retryable: failure.retryable, ...(failure.outcome ? { outcome: failure.outcome } : {}) }, failure.status);
    } finally { if (!upgrade) request.resume(); else upgrade.release(); }
  }
  const server = createServer((request, response) => {
    if (inFlight >= 32) { response.writeHead(503, { Connection: "close" }); response.end(); return; }
    inFlight++;
    let released = false;
    const release = () => { if (!released) { released = true; inFlight--; } };
    response.once("close", release); response.once("finish", release);
    void handle(request, response);
  });
  const upgrades = new Set<Duplex>();
  let pendingUpgrades = 0;
  server.on("upgrade", (request, socket, head) => {
    upgrades.add(socket); socket.once("close", () => upgrades.delete(socket));
    const response = new ServerResponse(request); response.assignSocket(socket as Socket);
    if (pendingUpgrades >= 32) { response.writeHead(503, { Connection: "close" }); response.end(); return; }
    pendingUpgrades++;
    let released = false;
    const release = () => { if (!released) { released = true; pendingUpgrades--; } };
    socket.once("close", release);
    void handle(request, response, { socket, head, release });
  });
  const closeStreams = () => { for (const socket of upgrades) socket.destroy(); };
  shutdownStreams.set(server, closeStreams);
  server.once("close", closeStreams);
  server.requestTimeout = 25_000; server.headersTimeout = 25_000;
  server.setTimeout(25_000, socket => socket.destroy());
  return server;
}

/** CLI entry: binds only the explicit listener, returning an awaitable shutdown. */
export async function startDashboard(config: DashboardConfig) {
  const server = createDashboardServer(config), listen = config.listen ?? { host: "127.0.0.1", port: 8766 };
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(listen.port, listen.host, resolve); });
  return {
    server, address: server.address() as AddressInfo,
    async close(): Promise<void> {
      // Upgraded sockets are intentionally outside Node's closeAllConnections.
      shutdownStreams.get(server)?.();
      await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); });
    },
  };
}
