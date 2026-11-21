import { createHash, timingSafeEqual } from "node:crypto";
import { parentPort, workerData } from "node:worker_threads";
import { Accounts } from "../accounts.ts";
import { identifier } from "../consumers.ts";
import { ServiceError, secret } from "../errors.ts";
import { SqliteStore } from "../sqlite.ts";
import { createModule as accountsModule } from "./account-routes.ts";
import { MachineStore } from "./machines.ts";
import { createModule as lifecycleModule } from "./lifecycle.ts";
import { createModule as devicesModule } from "./devices.ts";
import { createAppArtifactsModule } from './app-artifacts.ts';
import { createLeaseAppArtifactsModule } from './lease-app-artifacts.ts';
import { MobileVideoSessions } from './mobile-video-sessions.ts';
import { OwnerDisplaySessions } from './display-sessions.ts';
import { createModule as imagesModule } from "./images.ts";
import { createModule as blueprintsModule } from "./blueprints.ts";
import { createModule as infrastructureModule } from "./infrastructure.ts";
import { createModule as inferenceModule } from "./inference.ts";
import { createModule as sessionsModule } from "./sessions.ts";
import { AdminSystem } from "./admin-system.ts";
import { LegacyLeases } from "./leases.ts";
import { createModule as updatesModule } from "./updates.ts";
import { createModule as upkeepModule } from "./upkeep.ts";
import { requireHostAdmission, hostAdmissionClosed } from "./maintenance.ts";
import { Observability } from "./observability.ts";
import { installObservability, observabilitySettings } from "../observability.ts";
import { requireAdmin } from "./contracts.ts";
import type { ControlOptions, ControlRequest, Principal } from "./contracts.ts";
import { mutatesControlCommand } from "./client.ts";
import type { ControlCommand, ControlReply } from "./client.ts";

if (!parentPort) throw new Error("Controller persistence requires its owned worker channel.");
const port = parentPort;
const options: ControlOptions = {
  adminToken: secret(workerData.adminToken), controllerId: identifier(workerData.controllerId),
  ...(workerData.enrollmentToken === undefined ? {} : { enrollmentToken: secret(workerData.enrollmentToken) }),
  ...(workerData.updatePublicKeys === undefined ? {} : { updatePublicKeys: workerData.updatePublicKeys as Record<string, string> }),
  ...(Array.isArray(workerData.browserHosts) ? { browserHosts: workerData.browserHosts.map(identifier) } : {}),
  ...(workerData.observability === undefined ? {} : { observability: observabilitySettings(workerData.observability) }),
};
if (options.adminToken === options.enrollmentToken) throw new Error("Admin and enrollment credentials must be different.");
const operatorHash = createHash("sha256").update(options.adminToken, "ascii").digest();
const store = new SqliteStore(workerData.path as string);
// Before any module: triggers kept from an earlier run already fire during module construction.
installObservability(store);
const accounts = new Accounts(store);
// Imports are required. A missing or broken module prevents startup.
const sessions = sessionsModule(store, options);
const accountRoutes = accountsModule(store, options);
const machines = new MachineStore(store, options);
const authenticateHost = machines.authenticateHost.bind(machines);
const modules = [accountRoutes, machines, blueprintsModule(store), ...[lifecycleModule, devicesModule, imagesModule,
  infrastructureModule, inferenceModule].map(create => create(store, options))];
modules.push(createAppArtifactsModule(store, machines), createLeaseAppArtifactsModule(store, machines));
const principalHash = (db: Parameters<typeof accounts.principalHashDb>[0], hash: string): Principal => {
  if (hash === operatorHash.toString('hex')) return { kind: 'operator', user: null, scopes: ['admin'] };
  return accounts.principalHashDb(db, hash);
};
const videoSessions = new MobileVideoSessions(store, machines, principalHash);
const displaySessions = new OwnerDisplaySessions(store, machines, principalHash);
modules.push(videoSessions, displaySessions);
modules.push(sessions);
const leases = new LegacyLeases(store, options);
modules.push(leases);
modules.push(new AdminSystem(leases));
modules.push(updatesModule(store, options));
// Runtime, storage and idle upkeep; registers its heartbeat hooks before the first request.
modules.push(upkeepModule(store, options));
const observability = new Observability(store, options, leases.applications);
modules.unshift(observability);
// Every module above has created and migrated its tables; capture can now name their columns.
observability.installCapture();
observability.start();
if (options.browserHosts?.length) store.transaction(db => db.exec(`
  CREATE TABLE IF NOT EXISTS browser_launches (host TEXT NOT NULL,id TEXT NOT NULL,intent TEXT NOT NULL,state TEXT NOT NULL,PRIMARY KEY(host,id))`));

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
  if (command.type === "browsers.authorize") {
    requireAdmin({ principal: () => principal(command.token) });
    return true;
  }
  if (command.type === "browsers.launch") {
    return store.transaction(db => {
      if (command.adminToken !== undefined) requireAdmin({ principal: () => principal(command.adminToken!) });
      const hostId = identifier(command.hostId);
      if (!options.browserHosts?.includes(hostId)) return false;
      const { intent } = command, id = identifier(intent.id);
      const keys = Object.keys(intent).sort().join(",");
      const ports = intent.localPorts === undefined ? [] : intent.localPorts;
      if (!["engine,id,ttlSeconds", "engine,id,localPorts,ttlSeconds"].includes(keys) ||
          !["chromium", "firefox", "webkit"].includes(String(intent.engine)) || typeof intent.ttlSeconds !== "number" ||
          !Number.isInteger(intent.ttlSeconds) || intent.ttlSeconds < 30 || intent.ttlSeconds > 3600 ||
          !Array.isArray(ports) || ports.length > 32 || ports.some(p => !Number.isInteger(p) || p < 1 || p > 65535)) {
        throw new ServiceError("Invalid browser intent.", 400);
      }
      const spec = JSON.stringify([intent.engine, intent.ttlSeconds, [...new Set<number>(ports)].sort((a,b) => a-b)]);
      const previous = db.prepare("SELECT intent,state FROM browser_launches WHERE host=? AND id=?").get(hostId, id);
      if (previous && previous.intent !== spec) throw new ServiceError("Browser UUID belongs to a different intent.", 409);
      // A worker may forget its UUIDs on restart. A fenced retry can inspect the
      // committed launch, but forwarding another POST might start a new browser.
      if (previous && hostAdmissionClosed(db, hostId).closed) return "inspect";
      requireHostAdmission(db, hostId);
      const hosts = machines.hosts({ principal: () => ({ kind: "operator", user: null, scopes: ["admin"] }) });
      if (!hosts.some(host => host.id === hostId && host.platform === "macos" && host.placementReady)) return false;
      db.prepare(`INSERT INTO browser_launches VALUES (?,?,?,'launching')
        ON CONFLICT(host,id) DO UPDATE SET state='launching' WHERE state='closed'`).run(hostId, id, spec);
      return true;
    });
  }
  if (command.type === "browsers.receipt") return store.transaction(db => {
    db.prepare("UPDATE browser_launches SET state=? WHERE host=? AND id=? AND state!='closed'").run(command.state, command.hostId, command.id);
  });
  if (command.type === "requests.wake") return { ok: leases.requests.wake() };
  // The one-second timer above owns admission. Held reads only look, all of them in one transaction.
  if (command.type === "requests.read") return leases.requests.read(command.reads).map(item => "view" in item ? item : { error: described(item.error) });
  if (command.type === "events.latest") return observability.latestSequence();
  if (command.type === "hosts.authenticate") {
    authenticateHost(command.hostId, command.token);
    return { authenticated: true };
  }
  if (command.type === 'video-sessions.attach' || command.type === 'video-sessions.authorized' || command.type === 'video-sessions.disconnect') return videoSessions.command(command);
  if (command.type === 'display-sessions.attach' || command.type === 'display-sessions.authorized' || command.type === 'display-sessions.disconnect') return displaySessions.command(command);
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
/** Provider text and interpolated request values cannot enter errors or logs. */
function described(known: ServiceError) {
  return {
    message: ({ request_kind_unsupported: "Use kind lease, linux-lease or model-job.",
      request_waiting_limit: "Waiting request limit reached; cancel waiting requests or wait for admission before submitting more.",
      request_priority_invalid: "Priority must be an integer within the application maximum.",
      request_conflict: "Request UUID already has a different intent.",
      host_pressure: "Every host that could take this work is under memory or disk pressure; nothing running was stopped.",
      host_pressure_unknown: "Every host that could take this work has no current pressure sample.",
      license_acknowledgement_required: "Android installs need an explicit licence acknowledgement in this request.",
      runtime_in_use: "A template, device or lease on this host uses that runtime or system image.",
      host_operation_busy: "Another install, removal or purge is in progress for this host and platform.",
      host_inspection_required: "Inspect the host first: an earlier change ended unknown, or the purge names no recent successful inspection.",
      storage_owner_exists: "Named storage still has a live owner or was not proven removable by that inspection.",
      upkeep_unsupported: "This host has not advertised runtime and storage upkeep for that platform." } as Record<string,string>)[known.code] ?? messages[known.status] ?? "Controller request failed.", status: known.status,
    code: /^[a-z][a-z0-9_]{0,63}$/.test(known.code) ? known.code : "request_failed", retryable: known.retryable,
    ...(known.outcome ? { outcome: known.outcome } : {}),
  };
}
function reply(value: ControlReply): void { port.postMessage(value); }
port.on("message", (message: { id: number; command: ControlCommand }) => {
  reply({ kind: "accepted", id: message.id });
  void dispatch(message.command).then(value => reply({ kind: "result", id: message.id, value })).catch((error: unknown) => {
    const mutation = mutatesControlCommand(message.command);
    const known = error instanceof ServiceError ? error : new ServiceError("Controller storage or service unavailable.", 503, {
      retryable: false, ...(mutation ? { outcome: "unknown" as const } : {}),
    });
    reply({ kind: "error", id: message.id, error: described(known) });
  });
});
reply({ kind: "ready" });
