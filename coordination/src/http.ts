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

// POST routes whose proof is checked by the worker rather than the administrator pre-check.
const selfAuthenticated = [
  "/v1/runners/linux-leases/transfers/poll", "/v1/runners/linux-leases/transfers/report",
  "/v1/runners/linux-leases/operations/poll", "/v1/runners/linux-leases/operations/report",
  "/v1/auth/login", "/v1/runner-enrollments/consume", "/v1/runners/authenticate",
  "/v1/model-jobs", "/v1/runners/model-jobs/claim", "/v1/runners/model-jobs/assignments", "/v1/runners/model-jobs/report",
  "/v1/leases", "/v1/runners/linux-leases/claim", "/v1/runners/linux-leases/assignments", "/v1/runners/linux-leases/report",
];
const leaseAdministration: Record<string, IdentityCommand["type"]> = {
  "/v1/linux-lease-images": "leases.image", "/v1/linux-lease-grants": "leases.grant", "/v1/linux-lease-grants/revoke": "leases.grantRevoke",
  "/v1/linux-lease-runner-approvals": "leases.approve", "/v1/linux-lease-runner-approvals/revoke": "leases.approvalRevoke",
};
const leaseBody: Record<string, IdentityCommand["type"]> = {
  "/v1/runners/linux-leases/transfers/poll": "leases.pollTransfer", "/v1/runners/linux-leases/transfers/report": "leases.reportTransfer",
  "/v1/runners/linux-leases/operations/poll": "leases.pollOperation", "/v1/runners/linux-leases/operations/report": "leases.reportOperation",
  "/v1/leases": "leases.acquire", "/v1/runners/linux-leases/claim": "leases.claim",
  "/v1/runners/linux-leases/assignments": "leases.assignments", "/v1/runners/linux-leases/report": "leases.report",
};
const leaseMutation: Record<string, IdentityCommand["type"]> = { credential: "leases.credential", renew: "leases.renew", release: "leases.release" };
const LEASE_ID = "[0-9A-Fa-f-]{36}";
const modelAdministration: Record<string, IdentityCommand["type"]> = {
  "/v1/model-catalog": "models.catalog", "/v1/resource-domains": "models.domain",
  "/v1/model-grants": "models.grant", "/v1/model-grants/revoke": "models.grantRevoke",
  "/v1/model-runner-approvals": "models.approve", "/v1/model-runner-approvals/revoke": "models.approvalRevoke",
};
const modelRunner: Record<string, IdentityCommand["type"]> = {
  "/v1/model-jobs": "models.submit", "/v1/runners/model-jobs/claim": "models.claim",
  "/v1/runners/model-jobs/assignments": "models.assignments", "/v1/runners/model-jobs/report": "models.report",
};

/** Same bounded deadlines for plain loopback and TLS listeners. */
export function limitServer<T extends { requestTimeout: number; headersTimeout: number; setTimeout: (ms: number, callback: (socket: import("node:net").Socket) => void) => unknown }>(server: T): T {
  server.requestTimeout = 20_000;
  server.headersTimeout = 20_000;
  server.setTimeout(20_000, socket => socket.destroy());
  return server;
}

/** Controller identity HTTP subset. Does not listen or select state.
 * Browser cookies/assets and the remaining controller routes are separate ports.
 */
export function createIdentityServer(identities: IdentityClient) {
  return limitServer(createServer(createIdentityHandler(identities)));
}

/** Request handler shared by the plain loopback server and an explicitly configured TLS listener. */
export function createIdentityHandler(identities: IdentityClient, parsedBody?: (request: IncomingMessage) => Record<string, unknown> | undefined): (request: IncomingMessage, response: ServerResponse) => void {
  let inFlight = 0;
  return (request, response) => {
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
      const query = new URLSearchParams((request.url ?? "").split("#", 1)[0]!.split("?").slice(1).join("?"));
      if (request.method === "GET" && path === "/healthz") { respond(response, { ok: true }); return; }
      const transferRoute = /^\/v1\/leases\/([0-9a-f-]+)\/transfers(?:\/([0-9a-f-]+)(?:\/steps(?:\/([0-9]+))?)?)?$/.exec(path);
      let command: IdentityCommand;
      if (request.method === "GET" && path === "/v1/auth/status") command = { type: "status" };
      else if (request.method === "GET" && path === "/v1/auth/session") command = { type: "session", token };
      else if (request.method === "GET" && path === "/v1/consumers") command = { type: "applications.list", token };
      else if (request.method === "GET" && /^\/v1\/runner-enrollments\/[^/]+$/.test(path)) command = { type: "runner.inspect", id: path.split("/")[3]!, token };
      else if (request.method === "GET" && /^\/v1\/model-jobs\/[^/]+$/.test(path)) command = { type: "models.inspect", id: path.split("/")[3]!, token };
      else if (request.method === "GET" && /^\/v1\/resource-domains\/[^/]+$/.test(path)) command = { type: "models.domainInspect", id: path.split("/")[3]!, token };
      else if (request.method === "GET" && path === "/v1/environments/templates") command = { type: "leases.catalogue", token };
      else if (request.method === "GET" && path === "/v1/leases") {
        const keys = [...query.keys()];
        if (keys.some(k => k !== "after") || query.getAll("after").length > 1) throw new ServiceError("Only an after cursor is supported.", 400);
        const after = query.get("after");
        command = after === null ? { type: "leases.list", token } : { type: "leases.list", token, after };
      }
      else if (request.method === "GET" && transferRoute?.[2] && (!path.endsWith("/steps"))) command = {type:"leases.transfer",token,id:transferRoute[1]!,transferId:transferRoute[2],...(transferRoute[3] ? {step:Number(transferRoute[3])} : {})};
      else if (request.method === "GET" && new RegExp(`^/v1/leases/${LEASE_ID}/operations/${LEASE_ID}$`).test(path)) command = { type: "leases.operation", id: path.split("/")[3]!, operationId: path.split("/")[5]!, token };
      else if (request.method === "GET" && new RegExp(`^/v1/leases/${LEASE_ID}$`).test(path)) command = { type: "leases.inspect", id: path.split("/")[3]!, token };
      else if (request.method === "POST") {
        const operationCreate = new RegExp(`^/v1/leases/(${LEASE_ID})/operations$`).exec(path);
        const modelCancel = /^\/v1\/model-jobs\/([^/]+)\/cancel$/.exec(path);
        const leaseAction = new RegExp(`^/v1/leases/(${LEASE_ID})/(credential|renew|release)$`).exec(path);
        if (!selfAuthenticated.includes(path) && !modelCancel && !leaseAction && !operationCreate && !transferRoute) {
          await identities.request({ type: "authorize", token, setup: path === "/v1/auth/setup" });
        }
        const value = parsedBody?.(request) ?? await body(request);
        if (transferRoute && Buffer.byteLength(JSON.stringify(value)) > 131072) throw new ServiceError("Transfer body too large.",413,{code:"chunk_too_large"});
        const modelType = modelAdministration[path] ?? modelRunner[path] ?? leaseAdministration[path] ?? leaseBody[path];
        const enrollmentRevoke = /^\/v1\/runner-enrollments\/([^/]+)\/revoke$/.exec(path);
        if (transferRoute && !transferRoute[3] && (!transferRoute[2] || path.endsWith("/steps"))) command = {type:transferRoute[2] ? "leases.createTransferStep" : "leases.createTransfer",token,id:transferRoute[1]!,...(transferRoute[2] ? {transferId:transferRoute[2]} : {}),body:value};
        else if (operationCreate) command = { type: "leases.createOperation", id: operationCreate[1]!, token, body: value };
        else if (modelCancel) command = { type: "models.cancel", id: modelCancel[1]!, token, body: value };
        else if (leaseAction) command = { type: leaseMutation[leaseAction[2]!], id: leaseAction[1]!, token, body: value } as IdentityCommand;
        else if (modelType) command = { type: modelType, token, body: value } as IdentityCommand;
        else if (enrollmentRevoke) {
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
      const value = await identities.request(command);
      // A new durable model job or lease is 201; an exact replay of the same submission is 200.
      if (command.type === "leases.createTransfer") {
        const r=value as {created:boolean;transfer:unknown}; respond(response,r.transfer,r.created?201:200);return;
      }
      if (command.type === "leases.createTransferStep") {
        const r=value as {completed:boolean;step:unknown};respond(response,r.step,r.completed?200:202);return;
      }
      if (command.type === "leases.createOperation") {
        const result = value as { created: boolean; operation: unknown };
        respond(response, result.operation, result.created ? 201 : 200); return;
      }
      if (command.type === "leases.acquire") {
        const acquired = value as { created: boolean; lease: unknown };
        respond(response, acquired.lease, acquired.created ? 201 : 200); return;
      }
      respond(response, value, command.type === "models.submit" && (value as { created?: unknown }).created === true ? 201 : 200);
    })().catch(error => {
      request.resume();
      const known = error instanceof ServiceError ? error : new ServiceError("Orchestrator storage or service unavailable.", 503, { retryable: false });
      respond(response, { error: known.message, message: known.message, code: known.code, requestId, retryable: known.retryable,
        ...(known.outcome ? { outcome: known.outcome } : {}) }, known.status);
    });
  };
}
