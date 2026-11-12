import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { object, ServiceError } from "../errors.ts";
import { createIdentityHandler, limitServer } from "../http.ts";
import type { IdentityClient } from "../identity-client.ts";
import type { ControlClient, HttpCommand } from "./client.ts";

type Requester = Pick<ControlClient, "authorizeHost"> & Partial<Pick<ControlClient,"wakeRequests">> & { request(command: HttpCommand): Promise<import("./contracts.ts").ControlResponse | undefined> };
export type ControllerHandler = (request: IncomingMessage, response: ServerResponse) => void;
export type UpgradeHandler = (request: IncomingMessage, socket: Duplex, head: Buffer) => void | Promise<void>;
const MAX_BODY = 1_048_576;
const MAX_HEARTBEAT = 8 * MAX_BODY;
const CREDENTIAL_QUERY = new Set(["token", "authorization", "secret", "claim", "access_token", "credential", "password", "api_key"]);

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

async function readBody(request: IncomingMessage, path: string): Promise<Record<string, unknown>> {
  if (request.headers["transfer-encoding"] !== undefined || countHeader(request, "content-length") !== 1) {
    throw new ServiceError("A single Content-Length is required.", 400);
  }
  if (request.headers.expect !== undefined || request.headers.trailer !== undefined || request.headers.upgrade !== undefined) {
    throw new ServiceError("Invalid request framing.", 400);
  }
  const length = request.headers["content-length"]!;
  if (!/^[0-9]+$/.test(length)) throw new ServiceError("Invalid body length.", 400);
  const size = Number(length);
  const maximum = /^\/v1\/hosts\/[^/]+\/heartbeat$/.test(path) ? MAX_HEARTBEAT : MAX_BODY;
  if (!Number.isSafeInteger(size) || size < 1 || size > maximum) throw new ServiceError("Request body exceeds the endpoint's size limit.", 413);
  const chunks: Buffer[] = [];
  let received = 0;
  for await (const chunk of request) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    received += data.length;
    if (received > size) throw new ServiceError("Request body exceeds its declared size.", 413);
    chunks.push(data);
  }
  if (received !== size || !request.complete) throw new ServiceError("Incomplete request.", 400);
  try { return object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, size)))); }
  catch { throw new ServiceError("Malformed request.", 400); }
}

export function respond(response: ServerResponse, value: unknown, status = 200): void {
  if (response.destroyed) return;
  const encoded = Buffer.from(JSON.stringify(value));
  response.writeHead(status, {
    "Content-Type": "application/json", "Content-Length": encoded.length, "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff", "Connection": "close", ...(status === 429 ? { "Retry-After": "60" } : {}),
  });
  response.end(encoded);
}

function envelope(error: unknown, requestId: string, mutation: boolean) {
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
  let inFlight = 0;
  return (request, response) => {
    const requestId = randomUUID();
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
      if (request.method !== "GET" && request.method !== "POST") throw new ServiceError("Unknown endpoint.", 404);
      if (request.method === "GET") {
        if (request.headers["transfer-encoding"] !== undefined || countHeader(request, "content-length") > 1 ||
            (request.headers["content-length"] !== undefined && request.headers["content-length"] !== "0") ||
            request.headers.upgrade !== undefined || request.headers.expect !== undefined || request.headers.trailer !== undefined) {
          throw new ServiceError("Invalid request framing.", 400);
        }
        if (target.path === "/healthz") { respond(response, { ok: true }); return; }
      }
      if (request.method === "POST" && (/^\/v1\/hosts\/[^/]+\/heartbeat$/.test(target.path) || /^\/v1\/hosts\/[^/]+\/image-tasks\/[^/]+\/resolve$/.test(target.path))) {
        // A heartbeat can carry eight MiB. Authenticate its current host before
        // reading that envelope; the module rechecks again in its transaction.
        await control.authorizeHost(target.path.split("/")[3]!, target.token);
      }
      const body = request.method === "POST" ? await readBody(request, target.path) : {};
      if (response.destroyed) return;
      bodies.set(request, body);
      const command: HttpCommand = { type: "http", method: request.method, path: target.path, query: target.query.toString(), token: target.token, body };
      dispatched = true;
      const result = await control.request(command);
      if (response.destroyed) return;
      if (result === undefined) {
        if (/^\/v1\/(?:auth(?:\/|$)|users(?:\/|$)|admin\/tokens(?:\/|$))/.test(target.path)) throw new ServiceError("Unknown endpoint.", 404);
        // Identity-owned releases, runner receipts and policy changes wake the sole queue owner.
        response.once("finish", () => { if (request.method === "POST") void control.wakeRequests?.().catch(() => {}); });
        identity(request, response);
      } else respond(response, result.body, result.status);
    })().catch((error: unknown) => {
      request.resume();
      const result = envelope(error, requestId, dispatched && request.method === "POST");
      respond(response, result.body, result.status);
    });
  };
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
      if (request.method !== "GET" || request.httpVersion !== "1.1" || !/^\/v1\/(?:leases|hosts)\/[^/]+\/sessions\/[^/]+\/[^/]+$/.test(target.path) ||
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
