import { createHash, timingSafeEqual } from "node:crypto";
import { parentPort, workerData } from "node:worker_threads";
import { Accounts } from "../accounts.ts";
import { identifier } from "../consumers.ts";
import { ServiceError, secret } from "../errors.ts";
import { SqliteStore } from "../sqlite.ts";
import { createModule as accountsModule } from "./account-routes.ts";
import { createModule as machinesModule, MachineStore } from "./machines.ts";
import { createModule as lifecycleModule } from "./lifecycle.ts";
import { createModule as devicesModule } from "./devices.ts";
import { createModule as imagesModule } from "./images.ts";
import { createModule as infrastructureModule } from "./infrastructure.ts";
import { createModule as inferenceModule } from "./inference.ts";
import { createModule as sessionsModule } from "./sessions.ts";
import { LegacyLeases } from "./leases.ts";
import { createModule as updatesModule } from "./updates.ts";
import type { ControlOptions, ControlRequest, Principal } from "./contracts.ts";
import { mutatesControlCommand } from "./client.ts";
import type { ControlCommand, ControlReply } from "./client.ts";

if (!parentPort) throw new Error("Controller persistence requires its owned worker channel.");
const port = parentPort;
const options: ControlOptions = {
  adminToken: secret(workerData.adminToken), controllerId: identifier(workerData.controllerId),
  ...(workerData.enrollmentToken === undefined ? {} : { enrollmentToken: secret(workerData.enrollmentToken) }),
  ...(workerData.updatePublicKeys === undefined ? {} : { updatePublicKeys: workerData.updatePublicKeys as Record<string, string> }),
};
if (options.adminToken === options.enrollmentToken) throw new Error("Admin and enrollment credentials must be different.");
const operatorHash = createHash("sha256").update(options.adminToken, "ascii").digest();
const store = new SqliteStore(workerData.path as string);
const accounts = new Accounts(store);
// Imports are required. A missing or broken module prevents startup.
const sessions = sessionsModule(store, options);
const accountRoutes = accountsModule(store, options);
const machines = machinesModule(store, options);
if (!(machines instanceof MachineStore)) throw new Error("Controller host authentication is unavailable.");
const authenticateHost = machines.authenticateHost.bind(machines);
const modules = [accountRoutes, machines, ...[lifecycleModule, devicesModule, imagesModule,
  infrastructureModule, inferenceModule].map(create => create(store, options))];
modules.push(sessions);
const leases = new LegacyLeases(store, options);
modules.push(leases);
modules.push(updatesModule(store, options));

function principal(token: string): Principal {
  try {
    secret(token);
    if (timingSafeEqual(operatorHash, createHash("sha256").update(token, "ascii").digest())) {
      return { kind: "operator", user: null, scopes: ["admin"] };
    }
  } catch { /* Account authentication supplies a fixed refusal below. */ }
  return accounts.principal(token);
}

// wake() contains failures: a busy database must not terminate this worker or its unrelated routes.
leases.requests.wake();
setInterval(() => { leases.requests.wake(); }, 1000).unref();

async function dispatch(command: ControlCommand): Promise<unknown> {
  if (command.type === "requests.wake") return { ok: leases.requests.wake() };
  if (command.type === "hosts.authenticate") {
    authenticateHost(command.hostId, command.token);
    return { authenticated: true };
  }
  if (command.type !== "http") return sessions.sessionCommand(command);
  const request: ControlRequest = {
    method: command.method, path: command.path, parts: command.path.split("/").filter(Boolean),
    query: new URLSearchParams(command.query), body: command.body, token: command.token,
    principal: () => principal(command.token),
  };
  for (const module of modules) {
    const result = await module.handle(request);
    if (result !== undefined) { leases.requests.wake(); return result; }
  }
  // Account URLs must never fall through to the legacy administrator-only router.
  if (/^\/v1\/(?:auth(?:\/|$)|users(?:\/|$)|admin\/tokens(?:\/|$))/.test(command.path)) {
    throw new ServiceError("Unknown endpoint.", 404);
  }
  return undefined;
}

const messages: Record<number, string> = {
  400: "Invalid controller request.", 401: "Credential rejected.", 403: "Credential scope does not permit this action.",
  404: "Unknown endpoint or resource.", 409: "Request conflicts with current state. Inspect state before another mutation.",
  410: "Authorization or resource lifetime ended.", 413: "Request exceeds its size limit.",
  429: "Controller service is busy.", 501: "This capability is unavailable.", 503: "Controller storage or service unavailable.",
};
function reply(value: ControlReply): void { port.postMessage(value); }
port.on("message", (message: { id: number; command: ControlCommand }) => {
  reply({ kind: "accepted", id: message.id });
  void dispatch(message.command).then(value => reply({ kind: "result", id: message.id, value })).catch((error: unknown) => {
    const mutation = mutatesControlCommand(message.command);
    const known = error instanceof ServiceError ? error : new ServiceError("Controller storage or service unavailable.", 503, {
      retryable: false, ...(mutation ? { outcome: "unknown" as const } : {}),
    });
    // Provider text and interpolated request values cannot enter errors or logs.
    reply({ kind: "error", id: message.id, error: {
      message: ({ request_kind_unsupported: "Use kind lease or linux-lease; model jobs use /v1/model-jobs.",
        request_waiting_limit: "Waiting request limit reached; cancel waiting requests or wait for admission before submitting more.",
        request_priority_invalid: "Priority must be an integer within the application maximum.",
        request_conflict: "Request UUID already has a different intent." } as Record<string,string>)[known.code] ?? messages[known.status] ?? "Controller request failed.", status: known.status,
      code: /^[a-z][a-z0-9_]{0,63}$/.test(known.code) ? known.code : "request_failed", retryable: known.retryable,
      ...(known.outcome ? { outcome: known.outcome } : {}),
    } });
  });
});
reply({ kind: "ready" });
