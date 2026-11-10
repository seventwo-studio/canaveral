/** Disposable real controller modules and production gateway; no runner or native I/O. */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, realpathSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { startDashboard } from "../../coordination/src/dashboard.ts";
import type { ControlRequest, Principal } from "../../coordination/src/control/contracts.ts";
/** Controller code is built once by the repository build. Keeping these imports
 * in JavaScript lets fixture entrypoints use Node 24's strip-only loader. */
function compiled(name: string): string {
  return process.env.CANAVERAL_TEST_COORDINATION_BUILD
    ? pathToFileURL(join(process.env.CANAVERAL_TEST_COORDINATION_BUILD, name + ".js")).href
    : new URL("../../coordination/dist/src/" + name + ".js", import.meta.url).href;
}
const { Accounts }: typeof import("../../coordination/src/accounts.ts") = await import(compiled("accounts"));
const { SqliteStore }: typeof import("../../coordination/src/sqlite.ts") = await import(compiled("sqlite"));
const { ServiceError, object }: typeof import("../../coordination/src/errors.ts") = await import(compiled("errors"));
const { requestTarget, respond }: typeof import("../../coordination/src/control/http.ts") = await import(compiled("control/http"));
const { createModule: accountModule }: typeof import("../../coordination/src/control/account-routes.ts") = await import(compiled("control/account-routes"));
const { createModule: machineModule }: typeof import("../../coordination/src/control/machines.ts") = await import(compiled("control/machines"));
const { createModule: lifecycleModule }: typeof import("../../coordination/src/control/lifecycle.ts") = await import(compiled("control/lifecycle"));
const { createModule: deviceModule }: typeof import("../../coordination/src/control/devices.ts") = await import(compiled("control/devices"));
const { createModule: imageModule }: typeof import("../../coordination/src/control/images.ts") = await import(compiled("control/images"));
const { createModule: infrastructureModule }: typeof import("../../coordination/src/control/infrastructure.ts") = await import(compiled("control/infrastructure"));
const { createModule: inferenceModule }: typeof import("../../coordination/src/control/inference.ts") = await import(compiled("control/inference"));
const { createModule: sessionModule }: typeof import("../../coordination/src/control/sessions.ts") = await import(compiled("control/sessions"));

const directory = process.env.CANAVERAL_ACCOUNT_FIXTURE_DIR;
if (!directory) throw new Error("CANAVERAL_ACCOUNT_FIXTURE_DIR must name a disposable fixture directory.");
const root = realpathSync(directory), database = join(root, "controller.sqlite3");
if (existsSync(database) || existsSync(join(root, "bootstrap.json"))) throw new Error("Choose a fresh disposable fixture directory.");
const adminToken = randomBytes(32).toString("base64url"), enrollmentToken = randomBytes(32).toString("base64url");
const operatorHash = createHash("sha256").update(adminToken).digest();
const store = new SqliteStore(database), options = { adminToken, enrollmentToken, controllerId: randomUUID() };
const accounts = new Accounts(store);
const modules = [accountModule, machineModule, lifecycleModule, deviceModule, imageModule, infrastructureModule, inferenceModule, sessionModule].map(create => create(store, options));
function principal(token: string): Principal {
  if (timingSafeEqual(operatorHash, createHash("sha256").update(token).digest())) return { kind: "operator", user: null, scopes: ["admin"] };
  return accounts.principal(token);
}
async function dispatch(method: string, path: string, token: string, body: Record<string, unknown> = {}) {
  const request: ControlRequest = { method, path, parts: path.split("/").filter(Boolean), query: new URLSearchParams(), token, body, principal: () => principal(token) };
  for (const module of modules) { const result = await module.handle(request); if (result !== undefined) return result; }
  throw new ServiceError("Unknown fixture endpoint.", 404);
}
const api = createServer((request, response) => {
  void (async () => {
    const target = requestTarget(request);
    if (request.method === "GET" && target.path === "/healthz") { respond(response, { ok: true }); return; }
    if (!["GET", "POST"].includes(request.method ?? "")) throw new ServiceError("Unknown endpoint.", 404);
    if (target.query.size) throw new ServiceError("Query parameters are not supported by this fixture.", 400);
    let body: Record<string, unknown> = {};
    if (request.method === "POST") {
      const length = request.headers["content-length"];
      if (request.headers["transfer-encoding"] !== undefined || !length || !/^\d+$/.test(length) || Number(length) < 1 || Number(length) > 1048576) throw new ServiceError("Invalid body length.", 400);
      const chunks: Buffer[] = []; let received = 0;
      for await (const chunk of request) { const data = Buffer.from(chunk); received += data.length; if (received > Number(length)) throw new ServiceError("Invalid body length.", 400); chunks.push(data); }
      if (received !== Number(length)) throw new ServiceError("Incomplete request.", 400);
      try { body = object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)))); }
      catch { throw new ServiceError("Expected a JSON object.", 400); }
    }
    const result = await dispatch(request.method!, target.path, target.token, body);
    respond(response, result.body, result.status);
  })().catch((error: unknown) => {
    request.resume();
    const known = error instanceof ServiceError ? error : new ServiceError("Disposable controller unavailable.", 503);
    respond(response, { error: known.message, code: known.code, retryable: known.retryable, ...(known.outcome ? { outcome: known.outcome } : {}) }, known.status);
  });
});
api.requestTimeout = 20_000; api.headersTimeout = 20_000;
await new Promise<void>((resolve, reject) => { api.once("error", reject); api.listen(18767, "127.0.0.1", resolve); });
let gateway: Awaited<ReturnType<typeof startDashboard>> | undefined;
try {
  const host = randomUUID();
  await dispatch("POST", "/v1/hosts/enroll", enrollmentToken, { id: host, credential: randomBytes(32).toString("base64url"), offer: {
    name: "Fixture host; no runner", provider: "libvirt", capacity: { cpu: 16, memoryMiB: 16384, diskGiB: 256 },
    templates: [{ id: "linux", revision: "1", os: "linux", arch: "amd64", mode: "headless", minimum: { cpu: 1, memoryMiB: 1024, diskGiB: 4 } }],
  } });
  const legacy = object((await dispatch("POST", "/v1/machines", adminToken, { id: randomUUID(), name: "Admin private machine", templateId: "linux", resources: {} })).body);
  const claim = object((await dispatch("POST", "/v1/auth/bootstrap", adminToken)).body);
  writeFileSync(join(root, "bootstrap.json"), JSON.stringify({ token: claim.token, legacyMachine: legacy.id }) + "\n", { flag: "wx", mode: 0o600 });
  gateway = await startDashboard({ orchestratorUrl: "http://127.0.0.1:18767", listen: { host: "127.0.0.1", port: 18768 },
    ...(process.env.CANAVERAL_TEST_ASSETS ? { assetsDirectory: process.env.CANAVERAL_TEST_ASSETS } : {}),
  });
} catch (error) {
  api.closeAllConnections(); await new Promise<void>(resolve => api.close(() => resolve())); throw error;
}
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => {
  void (async () => {
    await gateway?.close();
    await new Promise<void>(resolve => { api.close(() => resolve()); api.closeAllConnections(); });
  })().then(() => process.exit(0), () => process.exit(1));
});
