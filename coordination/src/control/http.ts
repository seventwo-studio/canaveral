import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { object, ServiceError } from "../errors.ts";
import { createIdentityHandler, limitServer } from "../http.ts";
import type { IdentityClient } from "../identity-client.ts";
import type { ControlClient, HttpCommand, RequestRead } from "./client.ts";
import { createEventStream } from "./event-stream.ts";
import type { StreamRequester } from "./event-stream.ts";

type Requester = Pick<ControlClient, "authorizeHost"> & Partial<Pick<ControlClient,"wakeRequests" | "readRequests">> & { request(command: HttpCommand): Promise<import("./contracts.ts").ControlResponse | undefined> };
/** `close` ends the event streams the handler holds open; plain requests need no teardown. */
export type ControllerHandler = ((request: IncomingMessage, response: ServerResponse) => void) & { close?(): void };
export type UpgradeHandler = (request: IncomingMessage, socket: Duplex, head: Buffer) => void | Promise<void>;
const MAX_BODY = 1_048_576;
const MAX_HEARTBEAT = 8 * MAX_BODY;
const CREDENTIAL_QUERY = new Set(["token", "authorization", "secret", "claim", "access_token", "credential", "password", "api_key"]);
/** Longest hold of `GET /v1/requests/{id}?wait=N`. */
export const MAX_REQUEST_WAIT_SECONDS = 15;
/** Reads held at once across the controller, and by one application credential. A held read costs a connection
 * and a share of one batched re-read a second. The per-credential bound keeps one application from taking every
 * slot. A read beyond either bound is refused with 429 `request_wait_limit` rather than answered early, so a
 * client that loops on held reads is told to pause instead of spinning. */
export const MAX_REQUEST_WAITERS = 32;
export const MAX_REQUEST_WAITERS_PER_CREDENTIAL = 4;
const REQUEST_WAIT_TICK_MS = 1000;
/** A held read returns when anything a waiting client acts on changes. */
function waitSignature(value: unknown): string {
  const view = object(value);
  return JSON.stringify([view.state, view.position ?? null, view.reason ?? null]);
}
interface Waiter {
  token: string; id: string; owner: string; signature: string;
  /** The newest view any re-read returned; answered when the wait ends without a change. */
  last: unknown;
  settle(outcome: { view: unknown } | { error: ServiceError }): void;
}
function refusal(reply: RequestRead | undefined): ServiceError | undefined {
  if (!reply) return new ServiceError("Controller storage or service unavailable.", 503, { retryable: false });
  return "error" in reply ? new ServiceError(reply.error.message, reply.error.status, { code: reply.error.code, retryable: reply.error.retryable }) : undefined;
}

export function countHeader(request: IncomingMessage, name: string): number {
  let count = 0;
  for (let i = 0; i < request.rawHeaders.length; i += 2) if (request.rawHeaders[i]!.toLowerCase() === name) count++;
  return count;
}

/** Validate the original target without URL normalization changing its route. */
export function requestTarget(request: IncomingMessage): { path: string; query: URLSearchParams; token: string } {
  if (request.headers.origin !== undefined) throw new ServiceError("Browser origins are not supported.", 403);
  if (request.headers.cookie !== undefined) throw new ServiceError("Controller accepts header credentials only.", 400);
  if (countHeader(request, "authorization") > 1) throw new ServiceError("Ambiguous authorization.", 400);
  if (countHeader(request, "host") !== 1) throw new ServiceError("A single Host is required.", 400);
  const raw = request.url ?? "";
  if (raw.length > 8192 || !raw.startsWith("/") || raw.startsWith("//") || /[#\\\u0000-\u0020\u007f]/.test(raw)) {
    throw new ServiceError("Invalid controller request target.", 400);
  }
  const split = raw.indexOf("?");
  const route = split === -1 ? raw : raw.slice(0, split);
  // Paths are protocol identifiers, not filesystem paths. Encoded separators and
  // dot segments must not become a different endpoint in a proxy or fallback.
  if (/%(?![0-9a-f]{2})/i.test(raw) || /%2f|%5c|%00/i.test(route) || route.includes("//")) {
    throw new ServiceError("Invalid controller request target.", 400);
  }
  let decoded: string;
  try { decoded = decodeURIComponent(route); } catch { throw new ServiceError("Invalid controller request target.", 400); }
  if (decoded.split("/").some(part => part === "." || part === "..") || /[\u0000-\u0020\u007f]/.test(decoded)) {
    throw new ServiceError("Invalid controller request target.", 400);
  }
  const query = new URLSearchParams(split === -1 ? "" : raw.slice(split + 1));
  for (const key of query.keys()) if (CREDENTIAL_QUERY.has(key.toLowerCase())) throw new ServiceError("Credentials in query strings are forbidden.", 400);
  const authorization = request.headers.authorization ?? "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  // Keep the legacy trailing-slash behavior without decoding its resource IDs.
  const path = "/" + route.replace(/^\/+|\/+$/g, "");
  return { path, query, token };
}

export async function readBody(request: IncomingMessage, path: string, maximumBody?: number): Promise<Record<string, unknown>> {
  if (request.headers["transfer-encoding"] !== undefined || countHeader(request, "content-length") !== 1) {
    throw new ServiceError("A single Content-Length is required.", 400);
  }
  if (request.headers.expect !== undefined || request.headers.trailer !== undefined || request.headers.upgrade !== undefined) {
    throw new ServiceError("Invalid request framing.", 400);
  }
  const length = request.headers["content-length"]!;
  if (!/^[0-9]+$/.test(length)) throw new ServiceError("Invalid body length.", 400);
  const size = Number(length);
  const maximum = maximumBody ?? (/^\/v1\/leases\/[^/]+\/transfers(?:\/|$)/.test(path) ? 131072 : /^\/v1\/hosts\/[^/]+\/heartbeat$/.test(path) ? MAX_HEARTBEAT : MAX_BODY);
  if (!Number.isSafeInteger(size) || size < 1 || size > maximum) throw new ServiceError("Request body exceeds the endpoint's size limit.", 413);
  const chunks: Buffer[] = [];
  let received = 0;
  for await (const chunk of request) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    received += data.length;
    if (received > maximum || received > size) throw new ServiceError("Request body exceeds its declared size.", 413);
    chunks.push(data);
  }
  if (received !== size || !request.complete) throw new ServiceError("Incomplete request.", 400);
  try { return object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, size)))); }
  catch { throw new ServiceError("Malformed request.", 400); }
}

export function respond(response: ServerResponse, value: unknown, status = 200, retryAfterSeconds = 60): void {
  if (response.destroyed) return;
  const encoded = Buffer.from(JSON.stringify(value));
  response.writeHead(status, {
    "Content-Type": "application/json", "Content-Length": encoded.length, "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff", "Connection": "close", ...(status === 429 ? { "Retry-After": String(retryAfterSeconds) } : {}),
  });
  response.end(encoded);
}

/** Text a module produced in a named media type, such as a CSV report. Never used for errors. */
function respondText(response: ServerResponse, text: string, contentType: string, status = 200): void {
  if (response.destroyed) return;
  const encoded = Buffer.from(text);
  response.writeHead(status, { "Content-Type": contentType, "Content-Length": encoded.length, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Connection": "close" });
  response.end(encoded);
}

export function envelope(error: unknown, requestId: string, mutation: boolean) {
  const known = error instanceof ServiceError ? error : new ServiceError("Controller storage or service unavailable.", 503, {
    retryable: false, ...(mutation ? { outcome: "unknown" as const } : {}),
  });
  return { status: known.status, body: {
    error: known.message, message: known.message, code: known.code, requestId, retryable: known.retryable,
    ...(known.outcome ? { outcome: known.outcome } : {}),
  } };
}

/** Control modules get first refusal. Only an unowned route reaches identity. */
export function createControllerHandler(control: Requester, identities: IdentityClient): ControllerHandler {
  const bodies = new WeakMap<IncomingMessage, Record<string, unknown>>();
  const identity = createIdentityHandler(identities, request => bodies.get(request));
  const streams = createEventStream(control as unknown as StreamRequester);
  let inFlight = 0;
  // Held reads of waiting requests. They sit outside the 64 in-flight requests they would otherwise exhaust.
  const waiters = new Set<Waiter>(), owners = new Map<string, number>(), read = control.readRequests?.bind(control);
  let ticker: NodeJS.Timeout | undefined, batch: Promise<void> | undefined;
  const leave = (waiter: Waiter) => {
    if (!waiters.delete(waiter)) return;
    const left = owners.get(waiter.owner)! - 1;
    if (left > 0) owners.set(waiter.owner, left); else owners.delete(waiter.owner);
    if (!waiters.size) { clearInterval(ticker); ticker = undefined; }
  };
  /** One read for every waiter, in one control command and one transaction, so the cost of looking does not grow
   * with the number of waiters. Callers share a batch that is still in flight: a slow worker is asked once.
   * Each read verifies its credential again, so revoking an application ends its holds with the ordinary refusal. */
  const refresh = (): Promise<void> => batch ??= (async () => {
    const current = [...waiters];
    if (!current.length || !read) return;
    try {
      const replies = await read(current.map(({ token, id }) => ({ token, id })));
      current.forEach((waiter, index) => {
        if (!waiters.has(waiter)) return;
        const reply = replies[index], error = refusal(reply);
        if (error) waiter.settle({ error });
        else if (waitSignature((reply as { view: unknown }).view) !== waiter.signature) waiter.settle({ view: (reply as { view: unknown }).view });
        else waiter.last = (reply as { view: unknown }).view;
      });
    } catch { /* A busy or failed batch changes nothing: every waiter keeps its last view until its own limit. */ }
  })().finally(() => { batch = undefined; });
  /** Holds one read until the request's state, position or reason changes, the limit passes or the client leaves. */
  const hold = (response: ServerResponse, token: string, id: string, owner: string, first: unknown, limit: number): Promise<unknown> => new Promise((resolve, reject) => {
    const waiter: Waiter = { token, id, owner, signature: waitSignature(first), last: first, settle(outcome) {
      clearTimeout(timer); response.off("close", gone); leave(waiter);
      if ("error" in outcome) reject(outcome.error); else resolve(outcome.view);
    } };
    // A client that left frees its slot at once; nothing is written to its closed response.
    const gone = () => waiter.settle({ view: waiter.last });
    // At the limit, look once more (sharing any batch already in flight) and answer with the newest view.
    const timer = setTimeout(() => { void refresh().then(() => { if (waiters.has(waiter)) waiter.settle({ view: waiter.last }); }); }, Math.max(0, limit - performance.now()));
    response.once("close", gone);
    waiters.add(waiter); owners.set(owner, (owners.get(owner) ?? 0) + 1);
    if (!ticker) { ticker = setInterval(() => { void refresh(); }, REQUEST_WAIT_TICK_MS); ticker.unref(); }
  });
  const handler: ControllerHandler = (request, response) => {
    const requestId = randomUUID(), arrived = performance.now();
    // A follower holds its connection for up to an hour, so it never occupies a request slot. The stream
    // bounds its own open streams and, separately, how many requests may be authenticating at once.
    if (request.method === "GET" && /^\/v1\/(?:admin\/)?events\/stream\/?(?:\?|$)/.test(request.url ?? "")) {
      void (async () => { await streams.handle(request, response, requestTarget(request)); })().catch((error: unknown) => {
        request.resume();
        const result = envelope(error, requestId, false);
        if (response.headersSent) response.destroy(); else respond(response, result.body, result.status);
      });
      return;
    }
    if (inFlight >= 64) {
      const result = envelope(new ServiceError("Controller service is busy.", 429, { retryable: false }), requestId, false);
      respond(response, result.body, result.status); request.resume(); return;
    }
    inFlight++;
    let released = false, dispatched = false;
    const release = () => { if (!released) { released = true; inFlight--; } };
    response.once("close", release); response.once("finish", release);
    void (async () => {
      const target = requestTarget(request);
      const previewRead = (request.method === "HEAD" || request.method === "GET") && /^\/v1\/leases\/[^/]+\/previews\//.test(target.path);
      if (request.method === "GET" || previewRead) {
        if (request.headers["transfer-encoding"] !== undefined || countHeader(request, "content-length") > 1 ||
            (request.headers["content-length"] !== undefined && request.headers["content-length"] !== "0") ||
            request.headers.upgrade !== undefined || request.headers.expect !== undefined || request.headers.trailer !== undefined) {
          throw new ServiceError("Invalid request framing.", 400);
        }
        if (previewRead) {
          identity(request, response);
          return;
        }
        if (target.path === "/healthz") { respond(response, { ok: true }); return; }
      }
      if (request.method !== "GET" && request.method !== "POST") throw new ServiceError("Unknown endpoint.", 404);
      if (request.method === "POST" && (/^\/v1\/hosts\/[^/]+\/heartbeat$/.test(target.path) || /^\/v1\/hosts\/[^/]+\/image-tasks\/[^/]+\/resolve$/.test(target.path))) {
        // A heartbeat can carry eight MiB. Authenticate its current host before
        // reading that envelope; the module rechecks again in its transaction.
        await control.authorizeHost(target.path.split("/")[3]!, target.token);
      }
      const body = request.method === "POST" ? await readBody(request, target.path) : {};
      if (response.destroyed) return;
      bodies.set(request, body);
      // `wait` belongs to this front end: the control worker answers within its own deadline and never holds a read.
      const held = request.method === "GET" && target.query.has("wait") && read ? /^\/v1\/requests\/([^/]+)$/.exec(target.path) : null;
      if (held && read) {
        const values = target.query.getAll("wait");
        if (target.query.size !== 1 || !/^[1-9][0-9]?$/.test(values[0]!) || Number(values[0]) > MAX_REQUEST_WAIT_SECONDS) {
          throw new ServiceError(`wait must be the only parameter: a whole number of seconds from 1 to ${MAX_REQUEST_WAIT_SECONDS}.`, 400);
        }
        const seconds = Number(values[0]), id = held[1]!;
        // The first look verifies the credential and ownership. Like every later one it runs no admission pass,
        // so clients that re-ask together after a change do not each drive passes on the single control worker.
        const reply = (await read([{ token: target.token, id }]))[0], refused = refusal(reply);
        if (response.destroyed) return;
        if (refused) throw refused;
        let view = (reply as { view: unknown }).view;
        if (object(view).state === "waiting") {
          const owner = createHash("sha256").update(target.token).digest("base64url");
          if (waiters.size >= MAX_REQUEST_WAITERS || (owners.get(owner) ?? 0) >= MAX_REQUEST_WAITERS_PER_CREDENTIAL) {
            const busy = envelope(new ServiceError("Too many held request reads. Read without wait, or ask again after Retry-After.", 429, { code: "request_wait_limit", retryable: true }), requestId, false);
            respond(response, busy.body, busy.status, seconds); return;
          }
          release();
          // The server's 20-second idle limit (limitServer) would destroy a connection that is only waiting. Give this
          // one the wait plus that same allowance, and count the wait from arrival so latency does not extend it.
          request.socket.setTimeout((seconds + 20) * 1000);
          view = await hold(response, target.token, id, owner, view, arrived + seconds * 1000);
          if (response.destroyed) return;
        }
        respond(response, view); return;
      }
      const command: HttpCommand = { type: "http", method: request.method, path: target.path, query: target.query.toString(), token: target.token, body };
      dispatched = true;
      const result = await control.request(command);
      if (response.destroyed) return;
      if (result === undefined) {
        if (/^\/v1\/(?:auth(?:\/|$)|users(?:\/|$)|admin\/tokens(?:\/|$))/.test(target.path)) throw new ServiceError("Unknown endpoint.", 404);
        // Identity-owned releases, runner receipts and policy changes wake the sole queue owner.
        response.once("finish", () => { if (request.method === "POST") void control.wakeRequests?.().catch(() => {}); });
        identity(request, response);
      } else if (result.contentType !== undefined && typeof result.body === "string") respondText(response, result.body, result.contentType, result.status);
      else respond(response, result.body, result.status);
    })().catch((error: unknown) => {
      request.resume();
      const result = envelope(error, requestId, dispatched && request.method === "POST");
      respond(response, result.body, result.status);
    });
  };
  handler.close = () => streams.close();
  return handler;
}

export function createControllerServer(control: Requester, identities: IdentityClient) {
  const handler = createControllerHandler(control, identities);
  const server = limitServer(createServer(handler));
  server.on("checkContinue", handler);
  server.on("checkExpectation", handler);
  return server;
}

/** Reject malformed upgrades before the session service records an attachment. */
export function createControllerUpgradeHandler(upgrade: UpgradeHandler): UpgradeHandler {
  let pending = 0;
  return (request, socket, head) => {
    const requestId = randomUUID();
    try {
      const target = requestTarget(request);
      if (pending >= 64) throw new ServiceError("Session admission is busy.", 429, { retryable: false });
      if (request.method !== "GET" || request.httpVersion !== "1.1" || !/^(?:\/v1\/(?:leases|hosts)\/[^/]+\/sessions\/[^/]+\/[^/]+|\/v1\/(?:machines|hosts)\/[^/]+\/(?:video|display)-sessions\/[^/]+\/[^/]+|\/v1\/leases\/[^/]+\/video-sessions\/[^/]+\/[^/]+|\/v1\/(?:machines|hosts|leases)\/[^/]+\/live-views\/[^/]+\/[^/]+|\/v1\/(?:leases|hosts)\/[^/]+\/tunnels\/[^/]+\/[^/]+)$/.test(target.path) ||
          target.query.size !== 0 || request.url?.includes("?") || request.headers["content-length"] !== undefined ||
          request.headers["transfer-encoding"] !== undefined || request.headers.expect !== undefined || request.headers.trailer !== undefined ||
          countHeader(request, "upgrade") !== 1 || request.headers.upgrade?.toLowerCase() !== "websocket" ||
          countHeader(request, "connection") !== 1 || !request.headers.connection?.split(",").some(value => value.trim().toLowerCase() === "upgrade") ||
          countHeader(request, "sec-websocket-version") !== 1 || request.headers["sec-websocket-version"] !== "13" ||
          countHeader(request, "sec-websocket-key") !== 1 || typeof request.headers["sec-websocket-key"] !== "string" ||
          !/^[A-Za-z0-9+/]{22}==$/.test(request.headers["sec-websocket-key"]) ||
          countHeader(request, "sec-websocket-protocol") !== 1 || typeof request.headers["sec-websocket-protocol"] !== "string" ||
          !request.headers["sec-websocket-protocol"].split(",").some(value => value.trim() === "canaveral-session-v1") ||
          request.headers["sec-websocket-extensions"] !== undefined) {
        throw new ServiceError("Invalid session WebSocket upgrade.", 400);
      }
      pending++;
      let released = false;
      const admissionDeadline = setTimeout(() => socket.destroy(), 20_000);
      admissionDeadline.unref();
      const release = () => { if (!released) { released = true; pending--; clearTimeout(admissionDeadline); } };
      socket.once("close", release);
      // The broker takes over framing after it writes 101. Admission must stay
      // bounded independently of established stream count.
      const write = socket.write;
      socket.write = function (this: Duplex, ...args: Parameters<Duplex["write"]>) {
        release(); socket.write = write;
        return Reflect.apply(write, this, args) as boolean;
      } as Duplex["write"];
      void Promise.resolve(upgrade(request, socket, head)).catch(() => socket.destroy());
    } catch (error) {
      const result = envelope(error, requestId, false), data = Buffer.from(JSON.stringify(result.body));
      socket.end(`HTTP/1.1 ${result.status} Rejected\r\nContent-Type: application/json\r\nContent-Length: ${data.length}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n${data.toString("utf8")}`);
    }
  };
}
