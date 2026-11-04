import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { object, ServiceError } from "./errors.ts";
import type { IdentityClient } from "./identity-client.ts";
import type { IdentityCommand } from "./identity-protocol.ts";

function countHeader(request: IncomingMessage, name: string): number {
  let count = 0;
  for (let i = 0; i < request.rawHeaders.length; i += 2) if (request.rawHeaders[i]!.toLowerCase() === name) count++;
  return count;
}

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (request.headers["transfer-encoding"] !== undefined || countHeader(request, "content-length") !== 1) {
    throw new ServiceError("A single Content-Length is required.", 400);
  }
  const length = request.headers["content-length"]!;
  if (!/^[0-9]+$/.test(length)) throw new ServiceError("Invalid body length.", 400);
  const size = Number(length);
  if (!Number.isSafeInteger(size) || size < 1 || size > 1_048_576) throw new ServiceError("Request body exceeds the endpoint's size limit.", 413);
  const chunks: Buffer[] = []; let received = 0;
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

function respond(response: ServerResponse, value: unknown, status = 200): void {
  if (response.destroyed) return;
  const encoded = Buffer.from(JSON.stringify(value));
  response.writeHead(status, {
    "Content-Type": "application/json", "Content-Length": encoded.length,
    "Cache-Control": "no-store", "Connection": "close", ...(status === 429 ? { "Retry-After": "60" } : {}),
  });
  response.end(encoded);
}

/** Controller identity HTTP subset. Does not listen or select state.
 * Browser cookies/assets and the remaining controller routes are separate ports.
 */
export function createIdentityServer(identities: IdentityClient) {
  let inFlight = 0;
  const server = createServer((request, response) => {
    const requestId = randomUUID();
    if (inFlight >= 64) {
      respond(response, { error: "Identity service is busy.", code: "limit_exceeded", requestId, retryable: false }, 429);
      request.resume(); return;
    }
    inFlight++;
    let released = false;
    const release = () => { if (!released) { released = true; inFlight--; } };
    response.once("close", release); response.once("finish", release);
    void (async () => {
      if (request.headers.origin !== undefined) throw new ServiceError("Browser origins are not supported.", 403);
      if (countHeader(request, "authorization") > 1) throw new ServiceError("Ambiguous authorization.", 400);
      const authorization = request.headers.authorization ?? "";
      const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
      const path = "/" + (request.url ?? "").split(/[?#]/, 1)[0]!.replace(/^\/+|\/+$/g, "");
      if (request.method === "GET" && path === "/healthz") { respond(response, { ok: true }); return; }
      let command: IdentityCommand;
      if (request.method === "GET" && path === "/v1/auth/status") command = { type: "status" };
      else if (request.method === "GET" && path === "/v1/auth/session") command = { type: "session", token };
      else if (request.method === "GET" && path === "/v1/consumers") command = { type: "applications.list", token };
      else if (request.method === "GET" && /^\/v1\/runner-enrollments\/[^/]+$/.test(path)) command = { type: "runner.inspect", id: path.split("/")[3]!, token };
      else if (request.method === "POST") {
        if (!["/v1/auth/login", "/v1/runner-enrollments/consume", "/v1/runners/authenticate"].includes(path)) {
          await identities.request({ type: "authorize", token, setup: path === "/v1/auth/setup" });
        }
        const value = await body(request);
        const enrollmentRevoke = /^\/v1\/runner-enrollments\/([^/]+)\/revoke$/.exec(path);
        if (enrollmentRevoke) {
          if (Object.keys(value).length) throw new ServiceError("Expected an empty object.", 400);
          command = { type: "runner.revokeEnrollment", id: enrollmentRevoke[1]!, token };
        }
        else if (path === "/v1/runner-enrollments") command = { type: "runner.issue", token, body: value };
        else if (path === "/v1/runner-enrollments/consume") command = { type: "runner.consume", token, body: value };
        else if (path === "/v1/runners/authenticate") command = { type: "runner.authenticate", token, body: value };
        else if (path === "/v1/runners/credential") command = { type: "runner.rotate", token, body: value };
        else if (path === "/v1/runners/revoke") command = { type: "runner.revoke", token, body: value };
        else if (path === "/v1/auth/setup") command = { type: "setup", token, body: value };
        else if (path === "/v1/auth/login") command = { type: "login", body: value };
        else if (path === "/v1/auth/logout") command = { type: "logout", token };
        else if (path === "/v1/consumers") command = { type: "applications.create", token, body: value };
        else {
          const match = /^\/v1\/consumers\/([^/]+)\/(credential|revoke)$/.exec(path);
          if (!match) throw new ServiceError("Unknown endpoint.", 404);
          command = { type: match[2] === "credential" ? "applications.rotate" : "applications.revoke", id: match[1]!, token, body: value };
        }
      } else throw new ServiceError("Unknown endpoint.", 404);
      if (response.destroyed) return;
      respond(response, await identities.request(command));
    })().catch(error => {
      request.resume();
      const known = error instanceof ServiceError ? error : new ServiceError("Orchestrator storage or service unavailable.", 503, { retryable: false });
      respond(response, { error: known.message, message: known.message, code: known.code, requestId, retryable: known.retryable,
        ...(known.outcome ? { outcome: known.outcome } : {}) }, known.status);
    });
  });
  server.requestTimeout = 20_000;
  server.headersTimeout = 20_000;
  server.setTimeout(20_000, socket => socket.destroy());
  return server;
}
